/**
 * Reprise du fil dans une CLI NEUVE.
 *
 * Une CLI Freebuff garde son fil tant qu'elle vit : les tours suivants ne
 * renvoient que la dernière consigne. Une session NEUVE (bascule de compte,
 * redémarrage du pont, session morte relancée) repart donc sans contexte, et
 * la conversation perd son fil. On lui rejoue les derniers échanges lus dans
 * OpenWebUI.
 *
 * La contrainte est celle de la TUI : UNE ligne, bornée par `MAX_PROMPT_CHARS`.
 * Le dernier message doit y tenir INTACT — d'où le budget calculé sur le prompt
 * complet assemblé, jamais sur une estimation. Les tours les plus récents sont
 * gardés en priorité, et ce qui est coupé est annoncé.
 */

/** Ce qu'on garde d'un message : assez pour le fil, pas pour noyer le prompt. */
export const ENTRY_CHARS = 600

/** Marqueurs du préfixe : `archive.ts` les relit pour replier ce contexte. */
export const REPLAY_HEADER =
  'Contexte de la conversation précédente (la session Freebuff a été relancée). ' +
  'Ne répète pas ce qui est déjà fait ; traite uniquement la consigne finale.'
export const REPLAY_OPEN = '=== CONTEXTE ==='
export const REPLAY_CLOSE = '=== FIN DU CONTEXTE ==='
export const REPLAY_ASK = 'Consigne à traiter maintenant :'

export interface ThreadMessage {
  role: string
  content: unknown
}

export interface ThreadTurn {
  role: 'user' | 'assistant'
  text: string
}

/** Texte d'un message OWUI : chaîne, ou parties textuelles d'un contenu riche. */
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue
    const record = part as { type?: unknown; text?: unknown }
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n')
}

/**
 * Les messages exploitables, SANS le tour en cours.
 *
 * Le tour en cours commence au dernier message `user` : ce qui suit (réponse de
 * l'agent, message `tool` d'une carte) appartient à la consigne qu'on s'apprête
 * à écrire, pas au contexte.
 */
export function priorTurns(messages: ThreadMessage[]): ThreadTurn[] {
  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      lastUser = i
      break
    }
  }
  if (lastUser === -1) return []

  const turns: ThreadTurn[] = []
  for (let i = 0; i < lastUser; i++) {
    const message = messages[i]
    if (message === undefined) continue
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = messageText(message.content).replace(/\s+/g, ' ').trim()
    if (text === '') continue
    turns.push({ role: message.role, text })
  }
  return turns
}

/** Un tour, borné : une réponse de 10 000 caractères ne doit pas manger tout le budget. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/**
 * Prompt complet pour une CLI neuve, ou `null` s'il n'y a rien à reprendre.
 *
 * Rien à reprendre = aucun tour antérieur (premier message) ou budget
 * insuffisant : dans les deux cas l'appelant garde le prompt d'origine, jamais
 * un contexte tronqué au milieu de la consigne.
 */
export function promptWithContext(
  prompt: string,
  messages: ThreadMessage[],
  maxChars: number,
): string | null {
  const turns = priorTurns(messages)
  if (turns.length === 0) return null

  const assemble = (lines: string[], omitted: number): string => {
    const note = omitted > 0 ? `${String(omitted)} message(s) plus ancien(s) omis. ` : ''
    return [REPLAY_HEADER, note + REPLAY_OPEN, lines.join('\n'), REPLAY_CLOSE, `${REPLAY_ASK} ${prompt}`].join('\n')
  }

  // Les plus récents d'abord ; chaque ajout est vérifié sur le prompt COMPLET,
  // pour que la consigne finale ne soit jamais coupée par le plafond.
  const lines: string[] = []
  let omitted = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i] as ThreadTurn
    const label = turn.role === 'user' ? 'Utilisateur' : 'Agent'
    const line = `${label} : ${clip(turn.text, ENTRY_CHARS)}`
    if (assemble([line, ...lines], i + 1).length > maxChars) {
      omitted = i + 1
      break
    }
    lines.unshift(line)
  }
  if (lines.length === 0) return null
  return assemble(lines, omitted)
}
