/**
 * Choisit le profil Freebuff qui a des heures, pour le lanceur.
 *
 * Sortie : le chemin du profil choisi sur stdout (une seule ligne), le détail
 * des quotas sur stderr. Code 1 si aucun profil n'a d'heures ou si aucune sonde
 * n'a pu lire un bandeau.
 *
 * Les profils sont sondés UN PAR UN : deux TUI lancées en parallèle sur deux
 * comptes n'ont pas rendu leur bandeau en 15 s (mesuré le 23/10), et rien ne
 * garantit que la limite de sessions se compte par compte.
 *
 * Aucun prompt n'est écrit : ouvrir la TUI puis la refermer ne consomme aucune
 * heure. `BRIDGE_PROFILE_DIR` court-circuite la sonde (lancement ponctuel).
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { killTree } from '../src/freebuff/kill.ts'
import {
  discoverProfiles,
  profileReport,
  profilesFile,
  selectProfile,
  type ProfileQuota,
} from '../src/freebuff/profiles.ts'

const PROBE_SCRIPT = path.join(import.meta.dirname, '..', 'src', 'freebuff', 'quota-probe.ts')
const PROBE_CWD = path.resolve('data', 'quota-probe-cwd')
/** La sonde attend 45 s au plus (reconnexion mesurée ~40 s) : on lui laisse de l'air. */
const PROBE_TIMEOUT_MS = 60_000

function probe(profile: string): Promise<ProfileQuota> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [PROBE_SCRIPT, profile, PROBE_CWD], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    let out = ''
    let settled = false
    const finish = (result: ProfileQuota): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      // La TUI vit dans un PTY : tuer le seul processus Node laisserait un
      // `freebuff.exe` vivant, qui garderait un slot de session.
      if (child.pid !== undefined) killTree(child.pid)
      finish({ profile, remainingHours: null, totalHours: null })
    }, PROBE_TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
    })
    child.once('error', () => finish({ profile, remainingHours: null, totalHours: null }))
    child.once('close', () => {
      const last = out.trim().split('\n').at(-1) ?? ''
      try {
        const parsed = JSON.parse(last) as {
          quota?: { remainingHours?: number | null; totalHours?: number | null }
        }
        finish({
          profile,
          remainingHours: parsed.quota?.remainingHours ?? null,
          totalHours: parsed.quota?.totalHours ?? null,
        })
      } catch {
        finish({ profile, remainingHours: null, totalHours: null })
      }
    })
  })
}

const forced = process.env.BRIDGE_PROFILE_DIR?.trim()
if (forced) {
  // Sortie SANS `process.exit` : sur Windows, un `process.exit` pendant que
  // des poignées asynchrones se ferment fait avorter Node (`Assertion failed:
  // !(handle->flags & UV_HANDLE_CLOSING)`, vu le 23/10). Laisser le module se
  // terminer suffit — il n'y a rien après ce bloc dans ce cas.
  fs.writeSync(1, `${path.resolve(forced)}\n`)
} else {
  // Les profils qui portent un `credentials.json`, noms connus d'abord : le
  // compte du pont avant celui de l'application de bureau, qui partage ses
  // sessions (mesuré le 22/10 : un tour coupé par la CLI). Un dossier nommé
  // autrement est sondé comme les autres.
  const candidates = discoverProfiles(path.join(os.homedir(), '.config'))
  if (candidates.length === 0) {
    console.error('Aucun profil Freebuff avec credentials.json sous ~/.config.')
    process.exitCode = 1
  } else {
    fs.mkdirSync(PROBE_CWD, { recursive: true })

    const results: ProfileQuota[] = []
    for (const profile of candidates) {
      process.stderr.write(`[profil] ${path.basename(profile)} … `)
      const result = await probe(profile)
      results.push(result)
      const label =
        result.remainingHours === null
          ? 'illisible'
          : `${result.remainingHours}/${result.totalHours ?? '?'} h`
      process.stderr.write(`${label}\n`)
    }

    const choice = selectProfile(results, candidates)
    if (choice === null) {
      console.error(
        'Aucun profil Freebuff avec des heures : aucun tour ne peut démarrer. ' +
          'Attends le reset du quota ou reconnecte un profil.',
      )
      process.exitCode = 1
    } else {
      process.stderr.write(
        `[profil] retenu : ${path.basename(choice.profile)} (${choice.remainingHours} h)\n`,
      )
      // Le lanceur lit CE stdout : sans lui, le pont démarrait avec un profil
      // vide (mesuré le 26/10 : `Profil :` vide dans `/health`).
      fs.writeSync(1, `${path.resolve(choice.profile)}\n`)

      // Les mesures servent à la bascule du pont (`/api/profiles`) : elle les relit
      // au lieu de relancer quatre TUI (une quarantaine de secondes, mesuré). Un
      // échec d'écriture ne doit pas empêcher le démarrage : le pont retombe alors
      // sur les profils voisins, sans heures.
      const dataDir = process.env.BRIDGE_DATA_DIR ?? path.resolve('data')
      try {
        fs.mkdirSync(dataDir, { recursive: true })
        fs.writeFileSync(profilesFile(dataDir), JSON.stringify(profileReport(results, Date.now())), 'utf8')
      } catch (error) {
        console.error(
          `[profil] mesures non enregistrées : ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }
}
