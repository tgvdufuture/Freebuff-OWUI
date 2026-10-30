/**
 * Choix du profil Freebuff au démarrage, et bascule en cours d'exécution.
 *
 * La CLI n'écrit son quota dans aucun fichier : le seul moyen de savoir si un
 * compte a des heures est d'ouvrir sa TUI et de lire le bandeau, sans écrire de
 * consigne (aucun tour consommé). Le lanceur sonde donc chaque profil, décide
 * lequel ouvrir, et dépose ses MESURES ici (`profiles.json`) : la bascule du
 * pont les relit au lieu de relancer quatre TUI pour rien.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface ProfileQuota {
  /** Dossier du profil (chemin absolu). */
  profile: string
  /** Heures restantes affichées par la CLI, `null` si le bandeau n'a pas été lu. */
  remainingHours: number | null
  totalHours: number | null
}

export interface ProfileChoice {
  profile: string
  remainingHours: number
}

/**
 * Dossiers de profil connus, dans l'ordre de préférence du lanceur.
 *
 * Ce sont des VOISINS sous le même parent (`~/.config` en pratique). Servent
 * seulement à proposer la bascule : le pont n'en supervise toujours qu'un.
 */
export const PROFILE_NAMES = ['freebuff-session', 'freebuff', 'manicode', 'freebuff-desktop', 'freebuff2']

/**
 * Dossiers de profil qui existent réellement sous un parent donné.
 *
 * Un dossier est un profil s'il porte `credentials.json` — existence seule,
 * le contenu n'est jamais lu (PRD §3.2). Les noms connus viennent d'abord, dans
 * l'ordre de préférence du lanceur, puis les autres par ordre alphabétique :
 * un compte dont le dossier porte un autre nom n'est plus invisible.
 */
export function discoverProfiles(parent: string): string[] {
  let names: string[]
  try {
    names = fs
      .readdirSync(parent, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return []
  }

  const found = names.filter(name => fs.existsSync(path.join(parent, name, 'credentials.json')))
  const known = PROFILE_NAMES.filter(name => found.includes(name))
  const others = found.filter(name => !known.includes(name)).sort()
  return [...known, ...others].map(name => path.join(parent, name))
}

/**
 * Binaire de la CLI pour un profil donné.
 *
 * `FREEBUFF_BIN` reste prioritaire : une installation exotique doit pouvoir
 * l'imposer. Sinon le binaire est cherché DANS le dossier du profil, là où la
 * CLI s'installe — le nom du dossier n'a donc plus à être deviné. Le chemin
 * historique reste en dernier recours, pour ne pas casser une installation où
 * le binaire vit ailleurs.
 */
export function resolveFreebuffBin(profileDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const forced = env.FREEBUFF_BIN?.trim()
  if (forced) return forced

  for (const name of ['freebuff.exe', 'freebuff']) {
    const bin = path.join(profileDir, name)
    if (fs.existsSync(bin)) return bin
  }

  return path.join(os.homedir(), '.config', 'manicode', 'freebuff.exe')
}

/** Mesure d'un profil : ce que la sonde a lu, ou `null` si elle n'a rien vu. */
export interface ProfileReading {
  name: string
  path: string
  remainingHours: number | null
  totalHours: number | null
}

/** Mesures du lancement, avec leur date (l'interface peut dire leur âge). */
export interface ProfileReport {
  at: number
  profiles: ProfileReading[]
}

/** Fichier des mesures de lancement, à côté des autres données du pont. */
export function profilesFile(dataDir: string): string {
  return path.join(dataDir, 'profiles.json')
}

/** Identité d'un dossier de profil (même chemin = même profil sous Windows). */
export function profileKey(dir: string): string {
  const resolved = path.resolve(dir)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** Rapport écrit par le lanceur : ses mesures, recopiées telles quelles. */
export function profileReport(quotas: ProfileQuota[], at: number): ProfileReport {
  return {
    at,
    profiles: quotas.map(quota => ({
      name: path.basename(quota.profile),
      path: quota.profile,
      remainingHours: quota.remainingHours,
      totalHours: quota.totalHours,
    })),
  }
}

/**
 * `null` pour un fichier absent, illisible ou d'une autre forme.
 *
 * On ne complète JAMAIS une mesure manquante : une heure inventée vaudrait
 * mieux ne pas s'afficher du tout.
 */
export function parseProfileReport(raw: string): ProfileReport | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as { at?: unknown; profiles?: unknown }
  if (typeof record.at !== 'number' || !Array.isArray(record.profiles)) return null

  const hours = (value: unknown): value is number | null => value === null || typeof value === 'number'
  const profiles: ProfileReading[] = []
  for (const entry of record.profiles) {
    if (typeof entry !== 'object' || entry === null) continue
    const reading = entry as Record<string, unknown>
    if (typeof reading.name !== 'string' || typeof reading.path !== 'string') continue
    if (reading.name === '' || reading.path === '') continue
    if (!hours(reading.remainingHours) || !hours(reading.totalHours)) continue
    profiles.push({
      name: reading.name,
      path: reading.path,
      remainingHours: reading.remainingHours,
      totalHours: reading.totalHours,
    })
  }
  return { at: record.at, profiles }
}

/**
 * Liste proposée à la bascule : les mesures du lancement, puis les profils
 * voisins qui existent mais n'ont pas été sondés (heures inconnues).
 *
 * Un même dossier n'apparaît qu'une fois, dans l'ordre des mesures.
 */
export function mergeProfileReport(
  report: ProfileReport | null,
  candidates: ProfileReading[],
): ProfileReading[] {
  const out: ProfileReading[] = []
  const seen = new Set<string>()
  for (const reading of [...(report?.profiles ?? []), ...candidates]) {
    const key = profileKey(reading.path)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(reading)
  }
  return out
}

/**
 * Le profil qui a le plus d'heures restantes.
 *
 * - `0` heure est écarté : la CLI refuserait le premier tour ;
 * - un profil illisible (`null`, connexion en échec) est écarté : le pont ne
 *   peut pas promettre un tour qu'il ne peut pas lancer ;
 * - à égalité, l'ordre fourni tranche (le premier est le préféré). Un profil
 *   absent de l'ordre passe après tous les autres.
 */
export function selectProfile(
  results: ProfileQuota[],
  order: string[],
): ProfileChoice | null {
  let best: ProfileChoice | null = null
  let bestRank = Number.POSITIVE_INFINITY

  for (const result of results) {
    const remaining = result.remainingHours
    if (remaining === null || !Number.isFinite(remaining) || remaining <= 0) continue

    const index = order.indexOf(result.profile)
    const rank = index === -1 ? Number.MAX_SAFE_INTEGER : index
    const better =
      best === null ||
      remaining > best.remainingHours ||
      (remaining === best.remainingHours && rank < bestRank)
    if (better) {
      best = { profile: result.profile, remainingHours: remaining }
      bestRank = rank
    }
  }

  return best
}
