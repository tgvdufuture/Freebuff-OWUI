/**
 * Lecture de l'écran de la TUI Freebuff.
 *
 * La TUI est le seul endroit où certains refus existent : quota épuisé
 * (`0/12 hours remaining`), limite de sessions concurrentes, modèles
 * indisponibles. Le transcript, lui, ne les contient pas toujours — et quand
 * le quota est épuisé, aucun tour ne démarre, donc aucun marqueur n'est écrit.
 *
 * Règle : on ne DEVINE pas un refus. On ne reconnaît que des motifs courts et
 * stables, et on rend un code que l'interface traduit. Le texte de l'écran
 * n'est jamais persisté : il contient la consigne et la réponse de l'agent.
 */

export type RefusalCode =
  | 'quota_exhausted'
  | 'not_enough_hours'
  | 'concurrent_sessions'
  | 'models_unavailable'

export interface QuotaView {
  /** Un motif de quota a été reconnu. */
  found: boolean
  /** Heures restantes, ou `null` si le motif est absent. */
  remainingHours: number | null
  /** Total affiché (`12` dans `0/12`). */
  totalHours: number | null
  /** `remainingHours === 0`. */
  exhausted: boolean
}

/** Taille du tampon d'écran : assez pour un bandeau, pas pour un flux. */
export const SCREEN_CAP = 32 * 1024

/**
 * Retire les séquences ANSI. On ne retire que ce qui est visuel : le texte
 * reste exactement ce que la CLI a écrit.
 */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
}

/**
 * Tampon roulant de l'écran.
 *
 * On garde une CHAÎNE, pas un tableau de morceaux : la TUI redessine son écran
 * avec des séquences de position, et un tableau plafonné peut jeter la ligne du
 * quota au moment où elle devient utile. Une chaîne tronquée à 32 Ko conserve
 * le bandeau assez longtemps pour être lue, sans croître indéfiniment.
 */
export class ScreenBuffer {
  private text = ''

  push(chunk: string): void {
    this.text = (this.text + stripAnsi(chunk)).slice(-SCREEN_CAP)
  }

  get value(): string {
    return this.text
  }
}

/**
 * Deux écritures pour la MÊME valeur : le bandeau d'ouverture
 * (`8/12 hours remaining`, figé au démarrage) et le pied du panneau `/model`
 * (`8/12 hours daily · resets in 3h 20m`, relu à la demande).
 */
const RE_QUOTA = /(\d+)\s*\/\s*(\d+)\s*hours?\s+(?:remaining|daily)/gi

/**
 * Le quota de l'écran, en prenant la DERNIÈRE valeur écrite.
 *
 * Le bandeau d'ouverture reste dans le tampon roulant : lire la première
 * occurrence rendait toujours la valeur du démarrage, même après un `/model`
 * qui venait d'en écrire une plus fraîche.
 */
export function parseQuota(screen: string): QuotaView {
  let match: RegExpMatchArray | null = null
  for (const found of screen.matchAll(RE_QUOTA)) match = found
  if (match === null) return { found: false, remainingHours: null, totalHours: null, exhausted: false }

  const remaining = Number(match[1])
  const total = Number(match[2])
  if (!Number.isFinite(remaining) || !Number.isFinite(total)) {
    return { found: false, remainingHours: null, totalHours: null, exhausted: false }
  }
  return { found: true, remainingHours: remaining, totalHours: total, exhausted: remaining === 0 }
}

/**
 * Nombre de lignes de quota présentes à l'écran.
 *
 * Sert à attendre une lecture NOUVELLE : après `/model`, la valeur n'est là que
 * lorsque ce compte a augmenté — sinon on relirait le bandeau du démarrage.
 */
export function quotaMatchCount(screen: string): number {
  let count = 0
  for (const _ of screen.matchAll(RE_QUOTA)) count++
  return count
}

/**
 * Compte à rebours de la SESSION, dans le pied de la TUI.
 *
 * Mesuré sur les captures réelles : `59m left` à côté de `8/12 hours remaining`,
 * et le format plus long `${h}h ${m}m left` dans le binaire de la CLI. C'est la
 * seule durée qui « s'épuise » pendant qu'on travaille : le quota, lui, ne
 * bouge que d'une heure à la fois.
 */
export interface SessionLeftView {
  found: boolean
  minutes: number | null
}

const RE_SESSION_LEFT = /(\d+)\s*h(?:\s*(\d+)\s*m)?\s+left|\b(\d+)\s*m\s+left/gi

/** La DERNIÈRE valeur de l'écran : c'est la plus récente que la CLI a écrite. */
export function parseSessionLeft(screen: string): SessionLeftView {
  let minutes: number | null = null
  for (const match of screen.matchAll(RE_SESSION_LEFT)) {
    minutes = match[1] !== undefined ? Number(match[1]) * 60 + Number(match[2] ?? 0) : Number(match[3])
  }
  return minutes === null ? { found: false, minutes: null } : { found: true, minutes }
}

/** Motifs volontairement peu nombreux : un faux positif met un mensonge en base. */
const CONCURRENT_PATTERNS = [
  /concurrent[- ]session limit/i,
  /take over to stop another session/i,
  /Your concurrent-session limit across CLI and Desktop is reached/i,
]

const MODELS_PATTERNS = [/models? (?:aren't|are not) available on this connection/i]

/**
 * Le modèle choisi coûte plus d'heures qu'il n'en reste. Mesuré le 22/10 : la
 * TUI ouvre « Not enough hours for DeepSeek V4.1 Flash 10/17: an hour on it
 * takes 3 hours. Choose another model… » et attend `Entrée`/`Esc`. Aucun tour
 * ne démarre, donc le pont rendait `not_accepted` sans explication.
 */
const NOT_ENOUGH_HOURS = /not enough hours for/i

/**
 * Le bandeau `Some models aren't available on this connection` est INFORMATIF :
 * il s'affiche à l'ouverture, même quand le modèle courant fonctionne. Le
 * traiter comme un refus bloquerait un profil qui a du quota. On le retire
 * avant de chercher un vrai refus.
 */
const SOME_MODELS_NOTICE = /some models? (?:aren't|are not) available on this connection/gi

export function classifyRefusal(screen: string): RefusalCode | null {
  if (parseQuota(screen).exhausted) return 'quota_exhausted'
  if (NOT_ENOUGH_HOURS.test(screen)) return 'not_enough_hours'
  if (CONCURRENT_PATTERNS.some(pattern => pattern.test(screen))) return 'concurrent_sessions'

  const withoutNotice = screen.replace(SOME_MODELS_NOTICE, '')
  if (MODELS_PATTERNS.some(pattern => pattern.test(withoutNotice))) return 'models_unavailable'
  return null
}

/** Message écrit en base et affiché : jamais un extrait d'écran. */
export const REFUSAL_MESSAGES: Record<RefusalCode, string> = {
  quota_exhausted:
    'quota gratuit épuisé : la TUI affiche 0 heure restante. Aucun tour ne peut démarrer. ' +
    'Attends le reset du quota ; le pont ne réessaie pas tout seul.',
  not_enough_hours:
    'ce modèle coûte plus d’heures qu’il n’en reste sur ce profil (la TUI affiche « Not enough ' +
    'hours for … »). Choisis un modèle moins cher dans le sélecteur d’OpenWebUI (MiMo v2.6 Flash ' +
    'Slow, Nemotron 3.5 Lightning ou MiniMax M3.1 Flash), ou attends le reset du quota.',
  concurrent_sessions:
    'limite de sessions Freebuff atteinte (CLI + Desktop). Ferme une session déjà ouverte, ' +
    'puis relance. Le pont ne tue aucune session tout seul.',
  models_unavailable:
    'aucun modèle disponible sur cette connexion pour ce profil. Change de modèle dans ' +
    'Freebuff, puis relance.',
}
