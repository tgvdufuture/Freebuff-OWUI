import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  conversationDir,
  conversationsByRecency,
  hasAgentContent,
  isConversationRef,
  lastAgentOutput,
  latestAgentOutput,
  latestConversation,
  listConversations,
  readTranscript,
  renderAgentOutput,
  renderTranscript,
} from '../src/freebuff/history.ts'

const profileDir = mkdtempSync(path.join(os.tmpdir(), 'fb-history-'))
const projectPath = 'D:/code/projet'

function chat(ref: string, meta: Record<string, unknown> | null, messages?: unknown[]): void {
  const dir = path.join(profileDir, 'projects', 'projet', 'chats', ref)
  mkdirSync(dir, { recursive: true })
  if (meta !== null) writeFileSync(path.join(dir, 'chat-meta.json'), JSON.stringify(meta), 'utf8')
  if (messages !== undefined) {
    writeFileSync(path.join(dir, 'chat-messages.json'), JSON.stringify(messages), 'utf8')
  }
}

const message = (variant: string, content: string, blocks?: unknown[]): Record<string, unknown> => ({
  variant,
  content,
  blocks,
  timestamp: '10:00',
})

chat(
  '2026-10-22T10-00-00.000Z',
  { firstPrompt: 'Première consigne', messageCount: 3, messagesMtimeMs: 1_000 },
  [
    message('user', 'Première consigne'),
    message('ai', '', [
      { type: 'text', content: 'réflexion secrète', textType: 'reasoning' },
      { type: 'text', content: 'Réponse A', textType: 'text' },
      { type: 'tool', content: 'non affiché' },
    ]),
  ],
)
chat(
  '2026-10-22T11-00-00.000Z',
  { firstPrompt: 'Deuxième consigne', messageCount: 5, messagesMtimeMs: 2_000 },
  [message('user', 'Deuxième consigne')],
)
// Dossier sans méta (créé au démarrage de la TUI, avant tout prompt) : ignoré.
chat('2026-10-22T12-00-00.000Z', null)
// Fichier parasite : ignoré aussi.
writeFileSync(path.join(profileDir, 'projects', 'projet', 'chats', 'notes.txt'), 'x', 'utf8')

test('la liste rend les conversations les plus récentes d’abord, sans les dossiers vides', () => {
  const conversations = listConversations(profileDir, projectPath)

  assert.deepEqual(
    conversations.map(item => item.ref),
    ['2026-10-22T11-00-00.000Z', '2026-10-22T10-00-00.000Z'],
  )
  assert.deepEqual(conversations[0], {
    ref: '2026-10-22T11-00-00.000Z',
    firstPrompt: 'Deuxième consigne',
    messageCount: 5,
    updatedAt: 2_000,
  })
})

test('la première consigne est bornée pour rester lisible dans la liste', () => {
  chat(
    '2026-10-22T13-00-00.000Z',
    { firstPrompt: 'x'.repeat(200), messageCount: 1, messagesMtimeMs: 3_000 },
    [message('user', 'x'.repeat(200))],
  )
  const conversation = listConversations(profileDir, projectPath)[0]
  assert.equal(conversation?.firstPrompt.length, 80)
  assert.ok(conversation?.firstPrompt.endsWith('…'))
})

test('un projet sans dossier de chats rend une liste vide', () => {
  assert.deepEqual(listConversations(profileDir, 'D:/code/autre'), [])
})

test('un ref ne peut pas sortir du dossier des chats', () => {
  assert.equal(isConversationRef('2026-10-22T10-00-00.000Z'), true)
  assert.equal(isConversationRef('..'), false)
  assert.equal(isConversationRef('a/b'), false)
  assert.equal(isConversationRef('a\\b'), false)
  assert.equal(isConversationRef(''), false)
  assert.equal(conversationDir(profileDir, projectPath, '..'), null)
})

test('le transcript ne garde que les consignes et les réponses finales', () => {
  const dir = conversationDir(profileDir, projectPath, '2026-10-22T10-00-00.000Z')
  assert.notEqual(dir, null)

  const parts = readTranscript(dir as string)
  assert.deepEqual(
    parts.map(part => [part.role, part.text]),
    [
      ['user', 'Première consigne'],
      ['assistant', 'Réponse A'],
    ],
  )
  const rendered = renderTranscript(dir as string)
  assert.match(rendered?.markdown ?? '', /Première consigne/)
  assert.match(rendered?.markdown ?? '', /Réponse A/)
  assert.doesNotMatch(rendered?.markdown ?? '', /réflexion secrète/)
  assert.doesNotMatch(rendered?.markdown ?? '', /non affiché/)
})

test('un transcript illisible ou vide ne rend rien', () => {
  const dir = conversationDir(profileDir, projectPath, '2026-10-22T12-00-00.000Z')
  assert.equal(renderTranscript(dir as string), null)
})

test('le fil est borné, et ce qui est omis est dit', () => {
  const ref = '2026-10-22T14-00-00.000Z'
  const messages = Array.from({ length: 12 }, (_, index) =>
    message(index % 2 === 0 ? 'user' : 'ai', `message ${String(index)}`, [
      { type: 'text', content: `message ${String(index)}`, textType: 'text' },
    ]),
  )
  chat(ref, { firstPrompt: 'long', messageCount: 12, messagesMtimeMs: 4_000 }, messages)
  const dir = conversationDir(profileDir, projectPath, ref)
  const rendered = renderTranscript(dir as string, { maxParts: 4, maxChars: 10_000 })

  assert.notEqual(rendered, null)
  assert.equal(rendered?.omitted, 8)
  assert.match(rendered?.markdown ?? '', /8 message\(s\) plus ancien\(s\) omis/)
  assert.doesNotMatch(rendered?.markdown ?? '', /message 0/)
  assert.match(rendered?.markdown ?? '', /message 11/)
})

test('la dernière sortie de l’agent : la réponse finale, jamais les outils', () => {
  const dir = conversationDir(profileDir, projectPath, '2026-10-22T10-00-00.000Z')
  const output = lastAgentOutput(dir as string)

  assert.equal(output.answer, 'Réponse A')
  assert.equal(output.reasoning, 'réflexion secrète')
  assert.deepEqual(
    output.blocks.map(block => [block.kind, block.text]),
    [
      ['reasoning', 'réflexion secrète'],
      ['answer', 'Réponse A'],
    ],
  )
  assert.equal(output.error, null)
})

test('un tour coupé n’a que son raisonnement : il est rendu avec l’erreur de la CLI', () => {
  const ref = '2026-10-22T15-00-00.000Z'
  chat(ref, { firstPrompt: 'tour coupé', messageCount: 3, messagesMtimeMs: 5_000 }, [
    message('user', 'tour coupé'),
    message('ai', '', [
      { type: 'text', content: 'ancienne réponse', textType: 'text' },
      { type: 'text', content: 'raisonnement final', textType: 'reasoning' },
      { type: 'tool', content: 'sortie d’outil' },
    ]),
  ])
  writeFileSync(
    path.join(conversationDir(profileDir, projectPath, ref) as string, 'run-state.json'),
    JSON.stringify({
      output: { type: 'error', message: 'The session ended before this response completed.' },
    }),
    'utf8',
  )

  const output = lastAgentOutput(conversationDir(profileDir, projectPath, ref) as string)
  assert.equal(output.answer, 'ancienne réponse')
  assert.equal(output.reasoning, 'raisonnement final')
  assert.equal(output.error, 'The session ended before this response completed.')
  assert.deepEqual(output.blocks.at(-1), { kind: 'reasoning', text: 'raisonnement final' })
})

test('dossier absent ou transcript illisible : rien n’est inventé', () => {
  const output = lastAgentOutput(path.join(profileDir, 'projects', 'projet', 'chats', 'inconnu'))
  assert.deepEqual(output, { blocks: [], answer: null, reasoning: null, error: null })
})

test('la conversation la plus récente se choisit au fichier écrit en dernier', () => {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'fb-history-latest-'))
  const write = (project: string, ref: string, mtime: Date): void => {
    const dir = path.join(profile, 'projects', project, 'chats', ref)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'chat-messages.json'), '[]', 'utf8')
    utimesSync(path.join(dir, 'chat-messages.json'), mtime, mtime)
  }
  write('projet-a', 'ref-ancienne', new Date('2026-10-23T10:00:00Z'))
  write('projet-b', 'ref-recente', new Date('2026-10-23T12:00:00Z'))
  write('projet-a', 'ref-recente-a', new Date('2026-10-23T11:00:00Z'))

  const latest = latestConversation(profile)
  assert.equal(latest?.project, 'projet-b')
  assert.equal(latest?.ref, 'ref-recente')

  const inA = latestConversation(profile, 'D:/code/projet-a')
  assert.equal(inA?.ref, 'ref-recente-a')

  assert.equal(latestConversation(profile, 'D:/code/projet-absent'), null)
})

test('un marqueur d’interruption n’est pas une réponse', () => {
  const ref = '2026-10-23T09-00-00.000Z'
  chat(ref, { firstPrompt: 'coupé', messageCount: 3, messagesMtimeMs: 6_000 }, [
    message('user', 'coupé'),
    message('ai', '', [
      { type: 'text', content: 'le travail utile', textType: 'reasoning' },
      { type: 'text', content: '[response interrupted]', textType: 'text' },
    ]),
  ])
  const output = lastAgentOutput(conversationDir(profileDir, projectPath, ref) as string)
  assert.equal(output.answer, null)
  assert.equal(output.reasoning, 'le travail utile')
  assert.equal(hasAgentContent(output), true, 'le raisonnement compte comme du contenu')

  const onlyMarker = lastAgentOutput(conversationDir(profileDir, projectPath, '2026-10-22T16-00-00.000Z') as string)
  assert.equal(onlyMarker.blocks.length, 0, 'dossier absent')
  assert.equal(hasAgentContent(onlyMarker), false)
})

test('la dernière conversation utile saute les dossiers vides et les marqueurs', () => {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'fb-history-utile-'))
  const write = (ref: string, mtime: string, messages: unknown[]): void => {
    const dir = path.join(profile, 'projects', 'projet', 'chats', ref)
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'chat-messages.json')
    writeFileSync(file, JSON.stringify(messages), 'utf8')
    const at = new Date(mtime)
    utimesSync(file, at, at)
  }
  write('ref-vide', '2026-10-23T12:00:00Z', [{ variant: 'user', content: 'relance' }])
  write('ref-marqueur', '2026-10-23T11:00:00Z', [
    { variant: 'ai', blocks: [{ type: 'text', content: '[response interrupted]' }] },
  ])
  write('ref-utile', '2026-10-23T10:00:00Z', [
    {
      variant: 'ai',
      blocks: [
        { type: 'text', content: 'raisonnement', textType: 'reasoning' },
        { type: 'text', content: 'La réponse', textType: 'text' },
      ],
    },
  ])

  assert.deepEqual(
    conversationsByRecency(profile, 'D:/code/projet').map(conversation => conversation.ref),
    ['ref-vide', 'ref-marqueur', 'ref-utile'],
  )
  const found = latestAgentOutput(profile, 'D:/code/projet')
  assert.equal(found?.conversation.ref, 'ref-utile')
  assert.equal(found?.output.answer, 'La réponse')
  assert.equal(latestAgentOutput(profile, 'D:/code/absent'), null)
})

test('le rendu donne toutes les réponses, dans l’ordre, sans le raisonnement', () => {
  const output = {
    blocks: [
      { kind: 'reasoning' as const, text: 'R1' },
      { kind: 'answer' as const, text: 'A1' },
      { kind: 'reasoning' as const, text: 'R2' },
      { kind: 'answer' as const, text: '[response interrupted]' },
      { kind: 'answer' as const, text: 'A2' },
    ],
    answer: 'A2',
    reasoning: 'R2',
    error: null,
  }

  const full = renderAgentOutput(output)
  assert.equal(full.omitted, 0)
  assert.equal(full.markdown, '### Réponse\n\nA1\n\n### Réponse\n\nA2')

  const truncated = renderAgentOutput(output, 20)
  assert.ok(truncated.omitted > 0)
  assert.match(truncated.markdown, /caractères plus anciens omis/)
  assert.match(truncated.markdown, /A2$/, 'la fin (la réponse) est gardée')
})

test('sans aucune réponse, le rendu donne le raisonnement', () => {
  const output = {
    blocks: [{ kind: 'reasoning' as const, text: 'le travail' }],
    answer: null,
    reasoning: 'le travail',
    error: 'coupé',
  }
  assert.equal(renderAgentOutput(output).markdown, '### Raisonnement\n\nle travail')
})
