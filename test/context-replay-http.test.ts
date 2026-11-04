import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { AgentSession, StopResult, TurnResult } from '../src/freebuff/session.ts'
import { REPLAY_HEADER } from '../src/freebuff/replay.ts'

/**
 * Reprise du fil dans une CLI neuve, face aux appels internes d'OpenWebUI.
 *
 * Constaté en réel le 3/11 : dès qu'un fichier était joint, OWUI envoyait d'abord
 * ses tâches RAG (`metadata.task`), qui ouvraient la CLI et posaient `chatRef`.
 * La vraie consigne, elle, repartait sans contexte — le modèle avait « perdu la
 * mémoire » du fil.
 */

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'fb-replay-'))
const projectsRoot = mkdtempSync(path.join(os.tmpdir(), 'fb-replay-projects-'))
const profileDir = path.join(dataDir, 'freebuff')

mkdirSync(path.join(projectsRoot, 'alpha'))
mkdirSync(profileDir, { recursive: true })
writeFileSync(path.join(profileDir, 'credentials.json'), '{}', 'utf8')
writeFileSync(
  path.join(dataDir, 'models.json'),
  JSON.stringify([{ id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' }]),
  'utf8',
)

process.env.BRIDGE_STUB = '0'
process.env.BRIDGE_DATA_DIR = dataDir
process.env.BRIDGE_API_KEY = 'test-key-replay'
process.env.BRIDGE_PROJECTS_ROOT = projectsRoot
process.env.BRIDGE_PROFILE_DIR = profileDir

const { buildServer } = await import('../src/server.ts')

const AUTH = { authorization: 'Bearer test-key-replay' }
const ALPHA = path.join(projectsRoot, 'alpha').replace(/\\/g, '/')
const MODEL = 'freebuff-deepseek-v4-flash'

/** Tout ce que la CLI factice a réellement reçu, dans l'ordre. */
const sent: string[] = []

class FakeSession implements AgentSession {
  readonly pid = 8100
  /** Comme la vraie CLI : posé seulement quand un prompt a été accepté. */
  chatRef: string | null = null
  readonly alive = true
  readonly projectDir: string
  readonly quota = { found: true, remainingHours: 3, totalHours: 12, exhausted: false }
  readonly sessionLeft = null

  constructor(projectDir: string) {
    this.projectDir = projectDir
  }

  async send(prompt: string): Promise<TurnResult> {
    sent.push(prompt)
    this.chatRef = `ref-${String(sent.length)}`
    return { text: 'réponse factice', reasoning: '', finish: 'ok', refusal: null }
  }

  stop(): StopResult {
    return { ok: true, remaining: false }
  }
}

let bindingsCount = 0

const makeApp = () => {
  bindingsCount += 1
  return buildServer({
    bindingsFile: path.join(dataDir, `bindings-${String(bindingsCount)}.json`),
    openSession: async projectDir => new FakeSession(projectDir),
    quotaProbe: async () => {
      throw new Error('aucune sonde ne doit être lancée')
    },
  })
}

type App = ReturnType<typeof makeApp>

const bind = async (app: App, chatId: string): Promise<void> => {
  sent.length = 0
  const response = await app.inject({
    method: 'POST',
    url: '/api/bind',
    headers: AUTH,
    payload: { chatId, projectPath: ALPHA },
  })
  assert.equal(response.statusCode, 200)
}

/** Une tâche interne d'OpenWebUI : un seul échange technique + `metadata.task`. */
const taskCall = (app: App, chatId: string, task: string): Promise<{ statusCode: number }> =>
  app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': chatId },
    payload: {
      model: MODEL,
      stream: false,
      metadata: { task },
      messages: [
        { role: 'system', content: '### Task: Analyze the chat history…' },
        { role: 'user', content: 'History:\nUSER: ""\nQuery: analyse' },
      ],
    },
  })

/** Un message de l'utilisateur : le fil complet, puis la consigne finale. */
const userTurn = (
  app: App,
  chatId: string,
  history: Array<{ role: string; content: string }>,
  consigne: string,
): Promise<{ statusCode: number }> =>
  app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': chatId },
    payload: {
      model: MODEL,
      stream: false,
      metadata: { chat_id: chatId, message_id: consigne },
      messages: [...history, { role: 'user', content: consigne }],
    },
  })

const HELLO = [
  { role: 'user', content: 'Écris le PRD du paiement.' },
  { role: 'assistant', content: 'PRD v1 écrit dans docs/PRD-paiement.md.' },
]

test('un appel interne d’OpenWebUI ne consomme pas la reprise du fil', async () => {
  const app = makeApp()
  const chat = 'chat-task-first'
  await bind(app, chat)

  const task = await taskCall(app, chat, 'function_calling')
  assert.equal(task.statusCode, 200, 'l’appel interne est accepté')
  assert.ok(!sent[0]?.includes(REPLAY_HEADER), 'l’appel interne ne reçoit pas le fil')

  const turn = await userTurn(app, chat, HELLO, 'Et maintenant les tests ?')
  assert.equal(turn.statusCode, 200)

  const prompt = sent.at(-1) ?? ''
  assert.match(prompt, /Contexte de la conversation précédente/, 'le vrai message reçoit le fil')
  assert.match(prompt, /Utilisateur : Écris le PRD du paiement\./)
  assert.match(prompt, /Agent : PRD v1 écrit dans docs\/PRD-paiement\.md\./)
  assert.ok(prompt.endsWith('Consigne à traiter maintenant : Et maintenant les tests ?'))
})

test('une fois le fil donné à la CLI, le message suivant repart sans rejeu', async () => {
  const app = makeApp()
  const chat = 'chat-fed-once'
  await bind(app, chat)

  await taskCall(app, chat, 'query_generation')
  await userTurn(app, chat, HELLO, 'Deuxième question.')
  assert.match(sent.at(-1) ?? '', /Contexte de la conversation précédente/)

  await userTurn(
    app,
    chat,
    [...HELLO, { role: 'user', content: 'Deuxième question.' }, { role: 'assistant', content: 'Réponse 2.' }],
    'Troisième question.',
  )
  assert.equal(sent.at(-1), 'Troisième question.', 'le fil est déjà dans la CLI : consigne nue')
})

test('sans appel interne, la première consigne d’une CLI neuve rejoue toujours le fil', async () => {
  const app = makeApp()
  const chat = 'chat-plain'
  await bind(app, chat)

  await userTurn(app, chat, HELLO, 'Suite directe.')
  assert.match(sent.at(-1) ?? '', /Contexte de la conversation précédente/)
})
