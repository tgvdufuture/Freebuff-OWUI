/**
 * Les conversations qu'un projet a déjà eues dans la CLI.
 *
 * La CLI range chaque conversation dans
 * `projects/<projet>/chats/<ref>/chat-messages.json` et résume sa taille et sa
 * première consigne dans `chat-meta.json` (149 octets). On lit ce résumé pour
 * LISTER — jamais le transcript complet pour une liste — et on ne paie le gros
 * fichier que pour la conversation choisie.
 *
 * Lecture seule absolue : le pont n'écrit jamais dans `chats/`.
 */
import fs from 'node:fs'
import path from 'node:path'

export interface ConversationSummary {
  /** Nom du dossier `chats/<ref>` : c'est aussi l'id de `--continue`. */
  ref: string
  firstPrompt: string
  messageCount: number
  /** mtime du transcript, ou celui du dossier quand la méta manque. */
  updatedAt: number | null
}

/** Dossier `chats/` d'un projet, comme le calcule `FreebuffSession`. */
export function chatsRoot(profileDir: string, projectPath: string): string {
  return path.join(profileDir, 'projects', path.basename(projectPath), 'chats')
}

/** Un `ref` valide est un nom de dossier simple : rien pour sortir de `chats/`. */
export function isConversationRef(value: string): boolean {
  return value.length > 0 && value.length < 200 && !/[\\/]/.test(value) && value !== '.' && value !== '..'
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/**
 * Conversations du projet, la plus récente d'abord.
 *
 * Une conversation sans `chat-meta.json` est ignorée : sans elle on ne connaît
 * ni sa première consigne ni son nombre de messages, et l'afficher la tête de
 * liste sans description tromperait sur ce qu'elle contient.
 */
export function listConversations(
  profileDir: string,
  projectPath: string,
  limit = 10,
): ConversationSummary[] {
  const root = chatsRoot(profileDir, projectPath)
  let names: string[]
  try {
    names = fs.readdirSync(root)
  } catch {
    return []
  }

  const out: ConversationSummary[] = []
  for (const ref of names) {
    if (!isConversationRef(ref)) continue
    const dir = path.join(root, ref)
    try {
      const meta: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'chat-meta.json'), 'utf8'))
      if (typeof meta !== 'object' || meta === null) continue
      const record = meta as Record<string, unknown>
      const firstPrompt = typeof record.firstPrompt === 'string' ? truncate(record.firstPrompt, 80) : ''
      const messageCount =
        typeof record.messageCount === 'number' && Number.isFinite(record.messageCount)
          ? Math.max(0, Math.floor(record.messageCount))
          : 0
      const mtime =
        typeof record.messagesMtimeMs === 'number' && Number.isFinite(record.messagesMtimeMs)
          ? Math.round(record.messagesMtimeMs)
          : null
      out.push({
        ref,
        firstPrompt,
        messageCount,
        updatedAt: mtime ?? fs.statSync(dir).mtimeMs,
      })
    } catch {
      continue
    }
  }

  out.sort((a, b) => b.ref.localeCompare(a.ref))
  return out.slice(0, limit)
}

export interface TranscriptPart {
  role: 'user' | 'assistant'
  at: string
  text: string
}

/**
 * Le fil lisible d'une conversation : consignes et réponses finales.
 *
 * La réflexion (`textType: "reasoning"`) et les blocs d'outils ne sont pas de
 * la conversation pour un humain ; les inclure noierait la réponse sous le
 * travail de l'agent.
 */
export function readTranscript(dir: string): TranscriptPart[] {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, 'chat-messages.json'), 'utf8'))
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []

  const parts: TranscriptPart[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const message = item as Record<string, unknown>
    const at = typeof message.timestamp === 'string' ? message.timestamp : ''

    if (message.variant === 'user') {
      const text = typeof message.content === 'string' ? message.content.trim() : ''
      if (text) parts.push({ role: 'user', at, text })
      continue
    }

    if (message.variant !== 'ai' || !Array.isArray(message.blocks)) continue
    const text = message.blocks
      .map(block => {
        if (typeof block !== 'object' || block === null) return ''
        const value = block as Record<string, unknown>
        if (value.type !== 'text') return ''
        if (value.textType !== undefined && value.textType !== 'text') return ''
        return typeof value.content === 'string' ? value.content : ''
      })
      .filter(Boolean)
      .join('\n\n')
      .trim()
    if (text) parts.push({ role: 'assistant', at, text })
  }
  return parts
}

const DEFAULT_MAX_CHARS = 30_000
const DEFAULT_MAX_PARTS = 60

/**
 * Le fil en markdown, borné : un chat CLI peut peser des mégaoctets, et un
 * message OWUI de 2 Mo n'aide personne. Ce qui est coupé est DIT.
 *
 * Aucune balise autour des tours : OWUI **échappe** le HTML des messages (mesuré
 * — un `<div class=…>` s'affiche en texte), donc un marqueur de rôle n'y
 * survivrait pas. C'est l'appelant qui décide de replier ce fil.
 */
export function renderTranscript(
  dir: string,
  options: { maxChars?: number; maxParts?: number } = {},
): { markdown: string; omitted: number } | null {
  const parts = readTranscript(dir)
  if (parts.length === 0) return null

  const maxParts = options.maxParts ?? DEFAULT_MAX_PARTS
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  const kept = parts.slice(-maxParts)
  const omitted = parts.length - kept.length

  let markdown = kept
    .map(part => (part.role === 'user' ? `**Vous${part.at ? ` · ${part.at}` : ''}**` : `**Agent${part.at ? ` · ${part.at}` : ''}**`))
    .map((header, index) => `${header}\n\n${kept[index]?.text ?? ''}`)
    .join('\n\n---\n\n')

  if (omitted > 0) markdown = `_… ${String(omitted)} message(s) plus ancien(s) omis._\n\n${markdown}`
  if (markdown.length > maxChars) {
    markdown = `${markdown.slice(0, maxChars)}\n\n_… historique tronqué à ${String(maxChars)} caractères._`
  }
  return { markdown, omitted }
}

/** Chemin d'une conversation, après validation du `ref`. */
export function conversationDir(profileDir: string, projectPath: string, ref: string): string | null {
  if (!isConversationRef(ref)) return null
  return path.join(chatsRoot(profileDir, projectPath), ref)
}

export interface LatestConversation {
  /** Nom du dossier `projects/<projet>` — la CLI ne garde que le basename. */
  project: string
  ref: string
  dir: string
  /** mtime du transcript : c'est ce qui départage deux conversations. */
  updatedAt: number
}

/**
 * Conversation la plus récemment écrite, tous projets confondus (ou un seul).
 *
 * Sert quand le pont n'a pas livré la réponse : il ne reste que le disque, et
 * la conversation du tour manqué est la dernière que la CLI a touchée.
 */
export function latestConversation(
  profileDir: string,
  projectPath?: string,
): LatestConversation | null {
  const projectsRoot = path.join(profileDir, 'projects')
  let names: string[]
  if (projectPath === undefined) {
    try {
      names = fs.readdirSync(projectsRoot)
    } catch {
      return null
    }
  } else {
    names = [path.basename(projectPath)]
  }

  let best: LatestConversation | null = null
  for (const project of names) {
    const chatsRootDir = path.join(projectsRoot, project, 'chats')
    let refs: string[]
    try {
      refs = fs.readdirSync(chatsRootDir)
    } catch {
      continue
    }
    for (const ref of refs) {
      if (!isConversationRef(ref)) continue
      const dir = path.join(chatsRootDir, ref)
      let updatedAt: number
      try {
        updatedAt = fs.statSync(path.join(dir, 'chat-messages.json')).mtimeMs
      } catch {
        continue
      }
      if (best === null || updatedAt > best.updatedAt) best = { project, ref, dir, updatedAt }
    }
  }
  return best
}

export interface AgentOutputBlock {
  kind: 'answer' | 'reasoning'
  text: string
}

/**
 * Marqueur écrit par la CLI quand un tour est interrompu. Ce n'est pas une
 * réponse : le prendre pour telle faisait « récupérer » un message vide
 * (constaté le 23/10), alors que le travail était dans le raisonnement.
 */
const INTERRUPTED = /^\[(?:response|request) interrupted[^\]]*\]$/i

/** Vrai si l'agent a écrit autre chose qu'un marqueur d'interruption. */
export function hasAgentContent(output: AgentOutput): boolean {
  return output.blocks.some(
    block => block.text.trim() !== '' && !INTERRUPTED.test(block.text.trim()),
  )
}

export interface AgentOutput {
  /** Textes et raisonnements du dernier message de l'agent, dans l'ordre. */
  blocks: AgentOutputBlock[]
  /** Dernier texte final ; `null` si le tour n'en a écrit aucun. */
  answer: string | null
  /** Dernier raisonnement ; c'est alors la seule trace du travail. */
  reasoning: string | null
  /** Erreur de `run-state.json` quand la CLI a coupé le tour, sinon `null`. */
  error: string | null
}

/**
 * Ce que l'agent a écrit en dernier dans une conversation, réponse comprise.
 *
 * `readTranscript` ne garde que les réponses finales : ici on veut aussi le
 * raisonnement, parce qu'un tour coupé n'a parfois laissé que lui. Les outils
 * sont ignorés (leur sortie n'est pas la réponse).
 */
export function lastAgentOutput(dir: string): AgentOutput {
  const error = runError(dir)
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, 'chat-messages.json'), 'utf8'))
  } catch {
    return { blocks: [], answer: null, reasoning: null, error }
  }
  if (!Array.isArray(raw)) return { blocks: [], answer: null, reasoning: null, error }

  const last = [...raw]
    .reverse()
    .find(item => typeof item === 'object' && item !== null && (item as Record<string, unknown>).variant === 'ai')
  if (last === undefined) return { blocks: [], answer: null, reasoning: null, error }

  const blocks: AgentOutputBlock[] = []
  const rawBlocks = (last as Record<string, unknown>).blocks
  if (Array.isArray(rawBlocks)) {
    for (const block of rawBlocks) {
      if (typeof block !== 'object' || block === null) continue
      const value = block as Record<string, unknown>
      if (value.type !== 'text') continue
      const kind = value.textType === 'reasoning' ? 'reasoning' : value.textType === undefined || value.textType === 'text' ? 'answer' : null
      if (kind === null) continue
      const text = typeof value.content === 'string' ? value.content.trim() : ''
      if (text !== '') blocks.push({ kind, text })
    }
  }

  return {
    blocks,
    answer:
      blocks
        .filter(block => block.kind === 'answer' && !INTERRUPTED.test(block.text.trim()))
        .at(-1)?.text ?? null,
    reasoning: blocks.filter(block => block.kind === 'reasoning').at(-1)?.text ?? null,
    error,
  }
}

/** Conversations d'un projet, de la plus récemment écrite à la plus ancienne. */
export function conversationsByRecency(
  profileDir: string,
  projectPath: string,
  limit = 10,
): LatestConversation[] {
  const chatsRootDir = chatsRoot(profileDir, projectPath)
  let refs: string[]
  try {
    refs = fs.readdirSync(chatsRootDir)
  } catch {
    return []
  }

  const found: LatestConversation[] = []
  for (const ref of refs) {
    if (!isConversationRef(ref)) continue
    const dir = path.join(chatsRootDir, ref)
    try {
      found.push({
        project: path.basename(projectPath),
        ref,
        dir,
        updatedAt: fs.statSync(path.join(dir, 'chat-messages.json')).mtimeMs,
      })
    } catch {
      continue
    }
  }
  found.sort((a, b) => b.updatedAt - a.updatedAt)
  return found.slice(0, limit)
}

/**
 * La conversation du projet qui contient vraiment du texte d'agent, avec ce
 * texte. Une CLI relancée crée un dossier vide, et un tour coupé peut ne
 * laisser qu'un marqueur : les prendre pour « la dernière réponse » ne rendrait
 * rien d'utile (cas réel du 23/10).
 */
export function latestAgentOutput(
  profileDir: string,
  projectPath: string,
  limit = 10,
): { conversation: LatestConversation; output: AgentOutput } | null {
  for (const conversation of conversationsByRecency(profileDir, projectPath, limit)) {
    const output = lastAgentOutput(conversation.dir)
    if (hasAgentContent(output)) return { conversation, output }
  }
  return null
}

/**
 * Tout ce que l'agent a répondu dans son dernier message — toutes ses réponses
 * finales, dans l'ordre, marqueurs d'interruption exclus. À défaut (tour coupé
 * avant la moindre réponse), son raisonnement, dit explicitement.
 *
 * Le raisonnement n'est PAS mélangé aux réponses : sur un long tour il pèse des
 * dizaines de milliers de caractères et noierait la réponse utile (vu en réel).
 */
export function renderAgentOutput(
  output: AgentOutput,
  maxChars = 30_000,
): { markdown: string; omitted: number } {
  const answers = output.blocks.filter(
    block => block.kind === 'answer' && !INTERRUPTED.test(block.text.trim()),
  )
  const keptBlocks = answers.length > 0 ? answers : output.blocks.filter(block => block.kind === 'reasoning')

  const markdown = keptBlocks
    .map(block => `${block.kind === 'answer' ? '### Réponse' : '### Raisonnement'}\n\n${block.text}`)
    .join('\n\n')
  if (markdown.length <= maxChars) return { markdown, omitted: 0 }

  // Ce qui dépasse est coupé par le DÉBUT : la dernière réponse est la plus
  // récente, c'est elle qu'on vient chercher.
  const kept = markdown.slice(-maxChars)
  const omitted = markdown.length - kept.length
  return {
    markdown: `_… ${String(omitted)} caractères plus anciens omis._\n\n${kept}`,
    omitted,
  }
}

/** Message de `run-state.json` quand le tour s'est terminé en erreur. */
function runError(dir: string): string | null {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, 'run-state.json'), 'utf8'))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const output = (raw as Record<string, unknown>).output
  if (typeof output !== 'object' || output === null) return null
  const record = output as Record<string, unknown>
  if (record.type !== 'error') return null
  return typeof record.message === 'string' && record.message !== '' ? record.message : 'erreur sans message'
}
