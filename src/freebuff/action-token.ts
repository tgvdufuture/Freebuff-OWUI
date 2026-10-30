/**
 * Jetons des liens d'action (« Continuer », et les suggestions de l'agent).
 *
 * Le lien part dans le message d'OpenWebUI : il doit donc porter lui-même sa
 * preuve. HMAC-SHA256 sur `{chatId, exp, prompt?}` avec la clé du pont, 10
 * minutes de validité, et rien de secret dans l'URL. L'usage unique est tenu
 * par le pont (un jeton rejoué est refusé) ; ce module ne fait que signer et
 * vérifier.
 */
import crypto from 'node:crypto'

/** Durée de vie du lien (PRD F4.2). */
export const ACTION_TTL_MS = 10 * 60_000

interface Payload {
  chatId: string
  exp: number
  /** Prompt à envoyer ; absent pour le bouton « Continuer » (`continue`). */
  prompt?: string
}

export function signActionToken(
  secret: string,
  chatId: string,
  now = Date.now(),
  prompt?: string,
): string {
  const payload = Buffer.from(
    JSON.stringify({
      chatId,
      exp: now + ACTION_TTL_MS,
      ...(prompt === undefined ? {} : { prompt }),
    } satisfies Payload),
    'utf8',
  ).toString('base64url')
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

/** `null` si la signature ne correspond pas, si le jeton est expiré ou illisible. */
export function verifyActionToken(
  secret: string,
  token: string,
  now = Date.now(),
): { chatId: string; prompt?: string } | null {
  const separator = token.indexOf('.')
  if (separator <= 0) return null
  const payload = token.slice(0, separator)
  const signature = token.slice(separator + 1)
  if (signature === '') return null

  const expected = crypto.createHmac('sha256', secret).update(payload).digest()
  let given: Buffer
  try {
    given = Buffer.from(signature, 'base64url')
  } catch {
    return null
  }
  // Longueurs d'abord : `timingSafeEqual` lève sur des tampons différents.
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<Payload>
    if (typeof parsed.chatId !== 'string' || parsed.chatId === '') return null
    if (typeof parsed.exp !== 'number' || parsed.exp <= now) return null
    if (parsed.prompt !== undefined) {
      if (typeof parsed.prompt !== 'string' || parsed.prompt.trim() === '') return null
      return { chatId: parsed.chatId, prompt: parsed.prompt }
    }
    return { chatId: parsed.chatId }
  } catch {
    return null
  }
}
