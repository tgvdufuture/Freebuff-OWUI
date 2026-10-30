import assert from 'node:assert/strict'
import test from 'node:test'
import {
  balancedDetails,
  foldedReplay,
  messageTime,
  refStart,
  renderArchive,
  type TranscriptFileEntry,
} from '../src/freebuff/archive.ts'
import { REPLAY_ASK, REPLAY_CLOSE, REPLAY_HEADER, REPLAY_OPEN } from '../src/freebuff/replay.ts'

const REF = '2026-08-14T11-13-23.570Z'
const MTIME = 1_786_700_000_123

function user(content: string, timestamp = '11:13'): TranscriptFileEntry {
  return { variant: 'user', content, timestamp }
}

function ai(text: string, timestamp = '11:14'): TranscriptFileEntry {
  return {
    variant: 'ai',
    content: '',
    timestamp,
    blocks: [{ type: 'text', textType: 'text', content: text }],
  }
}

function render(entries: TranscriptFileEntry[], extra: { maxMessages?: number; maxChars?: number } = {}) {
  return renderArchive({
    ref: REF,
    projectName: 'Alpha',
    entries,
    meta: { messagesMtimeMs: MTIME },
    model: 'modele-test',
    ...extra,
  })
}

test('le titre vient de la vraie consigne, pas de la carte tronquée à 80 caractères', () => {
  const replay = [
    REPLAY_HEADER,
    REPLAY_OPEN,
    'Utilisateur : ancienne consigne',
    'Agent : ancienne réponse',
    REPLAY_CLOSE,
    `${REPLAY_ASK} Vraie consigne du tour`,
  ].join('\n')

  const chat = render([user(replay), ai('Réponse')])

  assert.equal(chat.title, '[Alpha] Vraie consigne du tour')
  assert.equal(chat.messages.length, 2)
  assert.match(chat.messages[0]?.content ?? '', /contexte rejoué : 2 message\(s\) omis/)
  assert.ok((chat.messages[0]?.content ?? '').endsWith('Vraie consigne du tour'))
})

test('un préfixe de reprise n’est reconnu que s’il a toutes ses marques', () => {
  assert.equal(foldedReplay('Contexte de la conversation précédente, sans marques'), null)
  assert.equal(foldedReplay(`${REPLAY_HEADER}\n${REPLAY_OPEN}\n${REPLAY_CLOSE}`), null)
  assert.deepEqual(
    foldedReplay(`${REPLAY_HEADER}\n${REPLAY_OPEN}\nUtilisateur : a\n${REPLAY_CLOSE}\n${REPLAY_ASK} b`),
    { prompt: 'b', omitted: 1 },
  )
})

test('les dates viennent du dossier et du transcript, pas de l’heure d’import', () => {
  const chat = render([user('Bonjour'), ai('Salut')])

  assert.equal(chat.createdAt, Math.floor(Date.UTC(2026, 7, 14, 11, 13, 23, 570) / 1000))
  assert.equal(chat.updatedAt, Math.floor(MTIME / 1000))
  assert.equal(refStart('pas-un-ref'), null)
})

test('une heure seule est combinée au jour du dossier', () => {
  const at = messageTime({ variant: 'user', content: 'x', timestamp: '09:07' }, REF, 0)
  const date = new Date(at * 1000)

  assert.equal(date.getFullYear(), 2026)
  assert.equal(date.getMonth(), 7)
  assert.equal(date.getDate(), 14)
  assert.equal(date.getHours(), 9)
  assert.equal(date.getMinutes(), 7)
})

test('le plafond de messages annonce ce qui est omis', () => {
  const chat = render(
    [user('un'), ai('réponse un'), user('deux'), ai('réponse deux'), user('trois'), ai('réponse trois')],
    { maxMessages: 2 },
  )

  assert.equal(chat.messages.length, 2)
  assert.equal(chat.omitted, 4)
  assert.equal(chat.truncated, true)
  assert.match(chat.messages[0]?.content ?? '', /^_… 4 message\(s\) plus ancien\(s\) omis\._/)
  assert.equal(chat.messages[0]?.content.includes('trois'), true)
})

test('le plafond de caractères garde au moins un message et le dit', () => {
  const chat = render(
    [user('a'.repeat(80)), ai('b'.repeat(80)), user('c'.repeat(80)), ai('d'.repeat(80))],
    { maxChars: 100 },
  )

  assert.equal(chat.messages.length, 1)
  assert.equal(chat.omitted, 3)
  assert.match(chat.messages[0]?.content ?? '', /^_… 3 message\(s\) plus ancien\(s\) omis\._/)
})

test('les <details> sont équilibrés : retirés côté utilisateur, refermés côté agent', () => {
  assert.equal(
    balancedDetails('<details><summary>x</summary>fin', 'user'),
    'xfin',
  )
  assert.equal(
    balancedDetails('<details><summary>x</summary>fin', 'assistant'),
    '<details><summary>x</summary>fin\n</details>',
  )
  assert.equal(balancedDetails('déjà <details>fermé</details>', 'assistant'), 'déjà <details>fermé</details>')
})

test('une conversation sans consigne ne fabrique pas de message', () => {
  const chat = render([ai('réponse orpheline')])

  assert.deepEqual(chat.messages, [])
  assert.equal(chat.title, '[Alpha] (sans consigne)')
})
