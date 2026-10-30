/**
 * Lecture du quota restant SANS écrire de prompt.
 *
 * La CLI n'écrit le quota dans aucun fichier : la seule source est son écran,
 * où le bandeau affiche « 3/12 hours remaining ». Une TUI lancée puis refermée
 * sans consigne ne consomme pas d'heure — c'est le seul moyen de savoir combien
 * il en reste avant d'ouvrir une session.
 *
 * La TUI vit dans un processus ENFANT (`quota-probe.ts`) : sous Windows, la
 * fermeture d'un ConPTY lève « AttachConsole failed » de façon asynchrone, et
 * une exception non capturée tuerait le pont.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { killTree } from './kill.ts'
import type { QuotaView, RefusalCode } from './screen.ts'

export interface QuotaProbe {
  quota: QuotaView
  /** Un refus affiché à la place du bandeau (sessions, modèles…), ou `null`. */
  refusal: RefusalCode | null
}

/** Doit couvrir l'attente de la sonde (45 s) : voir `quota-probe.ts`. */
const DEFAULT_WAIT_MS = 45_000
/** Marge au-delà de l'attente de la sonde avant de tuer l'enfant récalcitrant. */
const KILL_GRACE_MS = 5_000

/** Rend `null` si le binaire n'existe pas ou si la sonde n'a rien pu lire. */
export async function probeQuota(options: {
  bin: string
  profileDir: string
  /** Dossier de travail : la CLI y crée un dossier de chat fantôme, ignoré. */
  cwd: string
  waitMs?: number
}): Promise<QuotaProbe | null> {
  if (!fs.existsSync(options.bin)) return null
  fs.mkdirSync(options.cwd, { recursive: true })

  const child = spawn(
    process.execPath,
    [path.join(import.meta.dirname, 'quota-probe.ts'), options.profileDir, options.cwd],
    {
      env: { ...process.env, FREEBUFF_BIN: options.bin },
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  )

  let out = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8')
  })

  const closed = new Promise<boolean>(resolve => {
    child.once('close', () => resolve(true))
    child.once('error', () => resolve(false))
  })

  const timer = setTimeout(
    () => {
      // L'arbre entier : l'enfant a lancé la TUI dans un PTY, qui survivrait à
      // sa mort et garderait un slot de session.
      if (child.pid !== undefined) killTree(child.pid)
    },
    (options.waitMs ?? DEFAULT_WAIT_MS) + KILL_GRACE_MS,
  )
  const exited = await closed
  clearTimeout(timer)
  if (!exited) return null

  const last = out.trim().split('\n').at(-1) ?? ''
  if (last === '' || last === 'null') return null
  try {
    const parsed = JSON.parse(last) as Partial<QuotaProbe>
    if (typeof parsed.quota !== 'object' || parsed.quota === null) return null
    return {
      quota: parsed.quota,
      refusal: typeof parsed.refusal === 'string' ? (parsed.refusal as RefusalCode) : null,
    }
  } catch {
    return null
  }
}
