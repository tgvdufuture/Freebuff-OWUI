import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ENTRY_CHARS,
  messageText,
  priorTurns,
  promptWithContext,
  type ThreadMessage,
} from '../src/freebuff/replay.ts'

/** Budget réel du pont : une ligne dans la TUI, dernier message compris. */
const MAX = 8000

test('le tour en cours est exclu du contexte', () => {
  const turns = priorTurns([
    { role: 'user', content: 'premier' },
    { role: 'assistant', content: 'réponse' },
    { role: 'user', content: 'deuxième' },
    { role: 'assistant', content: 'réponse deux' },
    { role: 'user', content: 'consigne en cours' },
  ])

  assert.deepEqual(turns, [
    { role: 'user', text: 'premier' },
    { role: 'assistant', text: 'réponse' },
    { role: 'user', text: 'deuxième' },
    { role: 'assistant', text: 'réponse deux' },
  ])
})

test('les messages non lisibles ou non conversationnels sont écartés', () => {
  assert.equal(messageText(undefined), '')
  assert.equal(messageText({ texte: 'pas une partie' }), '')
  assert.equal(
    messageText([
      { type: 'text', text: 'ligne A' },
      { type: 'image_url', image_url: { url: 'data:…' } },
      { type: 'text', text: 'ligne B' },
    ]),
    'ligne A\nligne B',
  )

  const turns = priorTurns([
    { role: 'system', content: 'consigne système' },
    { role: 'user', content: '  ' },
    { role: 'user', content: 'vraie consigne' },
    { role: 'user', content: 'maintenant' },
  ])
  assert.deepEqual(turns, [{ role: 'user', text: 'vraie consigne' }])
})

test('sans tour antérieur, aucun contexte n’est inventé', () => {
  assert.equal(promptWithContext('bonjour', [{ role: 'user', content: 'bonjour' }], MAX), null)
  assert.equal(promptWithContext('bonjour', [], MAX), null)
  assert.equal(promptWithContext('bonjour', [{ role: 'user', content: 'bonjour' }], 200), null)
})

test('le contexte reprend les échanges et finit par la consigne intacte', () => {
  const prompt = 'Continue le PRD et commit.'
  const replayed = promptWithContext(
    prompt,
    [
      { role: 'user', content: 'Écris le PRD du paiement Stripe.' },
      { role: 'assistant', content: 'PRD v1.2 écrit dans docs/PRD-paiement-stripe.md.' },
      { role: 'user', content: prompt },
    ],
    MAX,
  )

  assert.ok(replayed !== null)
  assert.match(replayed, /session Freebuff a été relancée/)
  assert.match(replayed, /Utilisateur : Écris le PRD du paiement Stripe\./)
  assert.match(replayed, /Agent : PRD v1\.2 écrit dans docs\/PRD-paiement-stripe\./)
  // La consigne du tour n'est pas noyée dans le contexte, et n'est pas tronquée.
  assert.ok(replayed.endsWith(`Consigne à traiter maintenant : ${prompt}`))
  assert.ok(replayed.length <= MAX)
})

test('budget serré : les plus récents sont gardés, les anciens sont comptés', () => {
  const messages: ThreadMessage[] = []
  for (let i = 0; i < 12; i++) {
    messages.push({ role: 'user', content: `consigne ${String(i)}` })
    messages.push({ role: 'assistant', content: `réponse ${String(i)}` })
  }
  const prompt = 'termine'
  // Le fil réel finit par la consigne en cours : elle est exclue du contexte.
  messages.push({ role: 'user', content: prompt })
  // Assez pour quelques échanges, pas pour les douze.
  const replayed = promptWithContext(prompt, messages, 520)

  assert.ok(replayed !== null)
  assert.ok(replayed.length <= 520)
  assert.ok(replayed.endsWith(`Consigne à traiter maintenant : ${prompt}`))
  assert.match(replayed, /réponse 11/, 'le plus récent est conservé')
  assert.doesNotMatch(replayed, /consigne 0/)
  assert.match(replayed, /\d+ message\(s\) plus ancien\(s\) omis\./)
})

test('un tour très long est borné, jamais recopié entier', () => {
  const long = 'x'.repeat(ENTRY_CHARS * 3)
  const replayed = promptWithContext('ok', [{ role: 'assistant', content: long }, { role: 'user', content: 'ok' }], MAX)

  assert.ok(replayed !== null)
  assert.ok(!replayed.includes(long), 'le tour est coupé')
  assert.match(replayed, /…/)
})
