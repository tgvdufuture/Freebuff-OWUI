/**
 * Une conversation CLI → un chat OpenWebUI lisible.
 *
 * Aucun appel réseau, aucune écriture : on prend le transcript déjà sur le
 * disque et on rend les messages OWUI. Les règles viennent des mesures de la
 * Phase 0 (`spike/s14/RESULTS.md`) :
 *
 * - le préfixe de reprise (`replay.ts`) est replié : ~30 000 caractères de fil
 *   rejoué noieraient la vraie consigne ;
 * - les `<details>` déséquilibrés d'une consigne sont retirés (sinon ils avalent
 *   la fin du message dans OWUI) ; ceux d'un message agent sont refermés ;
 * - le titre vient de la consigne réelle, jamais de `chat-meta.firstPrompt`
 *   tronqué à 80 caractères ;
 * - la date de début vient du dossier `chats/<ref>`, la date de fin du `mtime`
 *   du transcript, et chaque heure du transcript est combinée à ce jour.
 *
 * Le travail complet est rendu par `turnSteps`/`stepsMarkdown` : réflexion et
 * outils dans des blocs « Travail » refermés, réponse en clair, aucune sortie
 * brute d'outil. Ce qui dépasse les plafonds est DIT, jamais silencieux.
 */
import { REPLAY_ASK, REPLAY_CLOSE, REPLAY_HEADER, REPLAY_OPEN } from './replay.ts'
import { stepsMarkdown, turnSteps, type TranscriptEntry } from './transcript.ts'

export interface TranscriptFileEntry extends TranscriptEntry {
  /** Heure locale seule (`14:39`), pas une date ISO. */
  timestamp?: string
}

export interface ArchiveMeta {
  firstPrompt?: unknown
  messagesMtimeMs?: unknown
}

export interface ArchiveMessage {
  role: 'user' | 'assistant'
  content: string
  /** Epoch secondes. */
  timestamp: number
  /** Seulement pour une réponse : le modèle qui reprendrait le fil. */
  model?: string
}

export interface ArchiveChat {
  title: string
  messages: ArchiveMessage[]
  createdAt: number
  updatedAt: number
  /** Messages retirés par les plafonds (D1). */
  omitted: number
  truncated: boolean
}

/** Plafond de rendu par conversation (D1 du PRD). */
export const ARCHIVE_MAX_MESSAGES = 200
export const ARCHIVE_MAX_CHARS = 200_000
const TITLE_CHARS = 60

/** Date du dossier `chats/<ref>` (`2026-10-23T12-39-20.183Z`). */
export function refStart(ref: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d{3})Z$/.exec(ref)
  if (match === null) return null
  const [, year, month, day, hour, minute, second, ms] = match
  return Math.floor(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(ms),
    ) / 1000,
  )
}

function refDay(ref: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(ref)
  if (match === null) return null
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
}

/**
 * L'horodatage du transcript est une HEURE locale seule : on la combine au jour
 * du dossier `ref`. Une conversation qui franchit minuit garde le jour du
 * premier message — limite mesurée et assumée.
 */
export function messageTime(
  entry: TranscriptFileEntry,
  ref: string,
  fallback: number,
): number {
  const day = refDay(ref)
  const match = typeof entry.timestamp === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(entry.timestamp) : null
  if (day !== null && match !== null) {
    const value = new Date(day.year, day.month - 1, day.day, Number(match[1]), Number(match[2]))
    const time = value.getTime()
    if (Number.isFinite(time)) return Math.floor(time / 1000)
  }
  return fallback
}

export interface FoldedReplay {
  /** La consigne réellement écrite après le contexte rejoué. */
  prompt: string
  /** Nombre d'échanges « Utilisateur : » / « Agent : » rejoués. */
  omitted: number
}

/**
 * Reconnaît le préfixe écrit par `replay.ts` et en extrait la consigne.
 *
 * `null` quand le texte n'a pas la forme d'un préfixe : on ne coupe jamais une
 * consigne qui parle de contexte par hasard.
 */
export function foldedReplay(text: string): FoldedReplay | null {
  if (!text.includes(REPLAY_HEADER) || !text.includes(REPLAY_OPEN) || !text.includes(REPLAY_CLOSE)) {
    return null
  }
  const ask = text.lastIndexOf(REPLAY_ASK)
  if (ask === -1) return null
  const prompt = text.slice(ask + REPLAY_ASK.length).trim()
  if (prompt === '') return null
  const from = text.indexOf(REPLAY_OPEN) + REPLAY_OPEN.length
  const to = text.indexOf(REPLAY_CLOSE)
  if (to <= from) return null
  const context = text.slice(from, to)
  const omitted = (context.match(/(?:^|\n)\s*(?:Utilisateur|Agent)\s*:/g) ?? []).length
  return { prompt, omitted }
}

/**
 * Aucun `<details>` non équilibré ne doit subsister (mesuré le 25/10).
 *
 * Dans un message UTILISATEUR, les balises sont retirées (le texte reste, la
 * fin du message n'est plus avalée) ; dans un message AGENT, les fermetures
 * manquantes sont ajoutées.
 */
export function balancedDetails(text: string, role: 'user' | 'assistant'): string {
  const open = (text.match(/<details\b/gi) ?? []).length
  const close = (text.match(/<\/details\s*>/gi) ?? []).length
  if (open <= close) return text
  if (role === 'user') return text.replace(/<\/?(?:details|summary)\b[^>]*>/gi, '')
  return `${text}${'\n</details>'.repeat(open - close)}`
}

function titleOf(projectName: string, prompt: string): string {
  const flat = prompt.replace(/\s+/g, ' ').trim()
  if (flat === '') return `[${projectName}] (sans consigne)`
  return `[${projectName}] ${flat.length > TITLE_CHARS ? `${flat.slice(0, TITLE_CHARS - 1)}…` : flat}`
}

/**
 * Rend une conversation complète, bornée.
 *
 * `entries` est le contenu brut de `chat-messages.json` (déjà parsé).
 */
export function renderArchive(input: {
  ref: string
  projectName: string
  entries: TranscriptFileEntry[]
  meta: ArchiveMeta
  model: string
  maxMessages?: number
  maxChars?: number
}): ArchiveChat {
  const mtime =
    typeof input.meta.messagesMtimeMs === 'number' && Number.isFinite(input.meta.messagesMtimeMs)
      ? Math.floor(input.meta.messagesMtimeMs / 1000)
      : null
  const fallback = mtime ?? refStart(input.ref) ?? 0

  // Un message `user` ouvre un tour ; tout ce qui suit (mode-divider excepté)
  // appartient à ce tour. Ce qui précède la première consigne est ignoré.
  const slices: TranscriptFileEntry[][] = []
  for (const entry of input.entries) {
    if (entry.variant === 'user') slices.push([entry])
    else if (slices.length > 0) slices.at(-1)?.push(entry)
  }

  const rendered: ArchiveMessage[] = []
  let firstPrompt = ''
  for (const slice of slices) {
    const user = slice[0]
    if (user === undefined) continue
    const raw = typeof user.content === 'string' ? user.content.trim() : ''
    if (raw === '') continue

    const folded = foldedReplay(raw)
    if (firstPrompt === '') firstPrompt = folded?.prompt ?? raw

    const content =
      folded !== null
        ? `_(contexte rejoué : ${String(folded.omitted)} message(s) omis)_\n\n${folded.prompt}`
        : balancedDetails(raw, 'user')
    rendered.push({
      role: 'user',
      content,
      timestamp: messageTime(user, input.ref, fallback),
    })

    const assistant = balancedDetails(stepsMarkdown(turnSteps(slice)).trim(), 'assistant')
    const lastAi = [...slice].reverse().find(entry => entry.variant === 'ai')
    if (assistant !== '' && lastAi !== undefined) {
      rendered.push({
        role: 'assistant',
        content: assistant,
        timestamp: messageTime(lastAi, input.ref, fallback),
        model: input.model,
      })
    }
  }

  if (rendered.length === 0) {
    return {
      title: titleOf(input.projectName, ''),
      messages: [],
      createdAt: refStart(input.ref) ?? fallback,
      updatedAt: fallback,
      omitted: 0,
      truncated: false,
    }
  }

  const maxMessages = input.maxMessages ?? ARCHIVE_MAX_MESSAGES
  const maxChars = input.maxChars ?? ARCHIVE_MAX_CHARS
  const kept = rendered.slice(-maxMessages)
  let omitted = rendered.length - kept.length
  let chars = kept.reduce((total, message) => total + message.content.length, 0)
  while (kept.length > 1 && chars > maxChars) {
    const dropped = kept.shift()
    if (dropped === undefined) break
    chars -= dropped.content.length
    omitted += 1
  }

  if (omitted > 0) {
    const first = kept[0]
    if (first !== undefined) {
      first.content = `_… ${String(omitted)} message(s) plus ancien(s) omis._\n\n${first.content}`
    }
  }

  const firstMessage = typeof input.meta.firstPrompt === 'string' ? input.meta.firstPrompt : ''
  return {
    title: titleOf(input.projectName, firstPrompt === '' ? firstMessage : firstPrompt),
    messages: kept,
    createdAt: refStart(input.ref) ?? (kept[0]?.timestamp ?? fallback),
    updatedAt: mtime ?? (kept.at(-1)?.timestamp ?? fallback),
    omitted,
    truncated: omitted > 0,
  }
}
