import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ACTION_TTL_MS,
  signActionToken,
  verifyActionToken,
} from '../src/freebuff/action-token.ts'

const SECRET = 'secret-de-test'

test('un jeton signé rend le chat pour lequel il a été créé', () => {
  const now = 1_700_000_000_000
  const token = signActionToken(SECRET, 'chat-42', now)

  assert.deepEqual(verifyActionToken(SECRET, token, now), { chatId: 'chat-42' })
})

test('un jeton expiré est refusé', () => {
  const now = 1_700_000_000_000
  const token = signActionToken(SECRET, 'chat-42', now)

  assert.equal(verifyActionToken(SECRET, token, now + ACTION_TTL_MS + 1), null)
})

test('un jeton signé avec un autre secret est refusé', () => {
  const token = signActionToken('autre-secret', 'chat-42')

  assert.equal(verifyActionToken(SECRET, token), null)
})

test('un jeton altéré est refusé', () => {
  const token = signActionToken(SECRET, 'chat-42')

  assert.equal(verifyActionToken(SECRET, `x${token}`), null)

  const [payload, signature] = token.split('.')
  // Le DERNIER caractère base64 ne porte pas toujours des bits utiles : le
  // changer pouvait décoder les mêmes octets, donc la même signature (test
  // instable). On altère le PREMIER, qui décale les octets à coup sûr.
  const first = signature?.[0] ?? 'A'
  const replacement = first === 'A' ? 'B' : 'A'
  assert.equal(
    verifyActionToken(SECRET, `${payload}.${replacement}${String(signature).slice(1)}`),
    null,
  )
})

test('un jeton de suggestion porte le prompt, intact, avec son chat', () => {
  const now = 1_700_000_000_000
  const prompt = 'Mets à jour docs/analytics-dashboard.md avec ces constats'
  const token = signActionToken(SECRET, 'chat-42', now, prompt)

  assert.deepEqual(verifyActionToken(SECRET, token, now), { chatId: 'chat-42', prompt })
  // Un jeton sans prompt n'en invente pas : le bouton Continuer envoie `continue`.
  assert.deepEqual(verifyActionToken(SECRET, signActionToken(SECRET, 'chat-42', now), now), {
    chatId: 'chat-42',
  })
})

test('un prompt substitué dans le jeton casse la signature', () => {
  const now = 1_700_000_000_000
  const token = signActionToken(SECRET, 'chat-42', now, 'lis le README')
  const [payload] = token.split('.')
  const decoded = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as {
    chatId: string
    exp: number
    prompt: string
  }
  const forged = Buffer.from(
    JSON.stringify({ ...decoded, prompt: 'rm -rf le projet' }),
    'utf8',
  ).toString('base64url')

  assert.equal(verifyActionToken(SECRET, `${forged}.${token.split('.')[1] ?? ''}`, now), null)
})

test('un jeton vide ou sans point est refusé', () => {
  assert.equal(verifyActionToken(SECRET, ''), null)
  assert.equal(verifyActionToken(SECRET, 'sans-point'), null)
  assert.equal(verifyActionToken(SECRET, '.'), null)
})
