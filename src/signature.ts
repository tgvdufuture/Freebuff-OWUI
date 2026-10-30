/**
 * Signatures du fil : distinguer un nouveau message d'une régénération ou
 * d'une édition.
 *
 * OpenWebUI renvoie tout l'historique à chaque requête. Le pont ne stocke donc
 * pas les messages : il stocke un SHA-256 par message `user`/`assistant`, ce
 * qui suffit à comparer des préfixes sans garder les consignes sur disque.
 *
 * - aucun tour enregistré → nouveau ;
 * - liste identique → régénération ;
 * - historique enregistré est un préfixe → nouveau tour ;
 * - tout le reste → divergence, et on CONTINUE quand même.
 *
 * Pourquoi une divergence ne bloque pas : la CLI n'a jamais reçu l'édition,
 * elle garde son propre fil. Refuser condamnait le chat entier — chaque message
 * suivant était refusé à son tour (mesuré sur un vrai chat). On continue donc,
 * et l'historique enregistré redevient la référence au tour suivant.
 *
 * Les rôles `system` et `tool` sont ignorés : OpenWebUI y injecte des données
 * variables (date, contexte) qui feraient croire à une édition à chaque tour.
 */
import crypto from 'node:crypto'

export interface ThreadMessage {
  role: string
  content: unknown
}

export type ThreadVerdict = 'new' | 'extended' | 'regeneration' | 'diverged'

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part =>
        typeof part === 'object' && part !== null && 'text' in part
          ? String((part as { text: unknown }).text)
          : '',
      )
      .join('\n')
  }
  return ''
}

/** Un SHA-256 par message user/assistant, dans l'ordre du fil. */
export function threadSignatures(messages: ThreadMessage[]): string[] {
  return messages
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .map(message =>
      crypto
        .createHash('sha256')
        .update(`${message.role}\u0000${textOf(message.content)}`, 'utf8')
        .digest('hex'),
    )
}

export function compareThread(stored: string[] | null, incoming: string[]): ThreadVerdict {
  if (stored === null || stored.length === 0) return 'new'
  if (incoming.length === stored.length && incoming.every((hash, i) => hash === stored[i])) {
    return 'regeneration'
  }
  if (incoming.length > stored.length && stored.every((hash, i) => incoming[i] === hash)) {
    return 'extended'
  }
  return 'diverged'
}

/** Une consigne, c'est un dernier message `user` — pas une réponse de l'agent. */
export function waitsForInstruction(messages: ThreadMessage[]): boolean {
  return messages.at(-1)?.role !== 'user'
}
