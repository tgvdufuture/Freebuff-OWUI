import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { AgentSession, StopResult, TurnResult } from '../src/freebuff/session.ts'

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'fb-stop-'))
const projectsRoot = mkdtempSync(path.join(os.tmpdir(), 'fb-stop-projects-'))
const profileDir = path.join(dataDir, 'profile')

mkdirSync(path.join(projectsRoot, 'alpha'))
mkdirSync(profileDir, { recursive: true })
writeFileSync(
  path.join(dataDir, 'models.json'),
  JSON.stringify([{ id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' }]),
  'utf8',
)

process.env.BRIDGE_STUB = '0'
process.env.BRIDGE_DATA_DIR = dataDir
process.env.BRIDGE_API_KEY = 'test-key-stop'
process.env.BRIDGE_CAPTURE_DIR = path.join(dataDir, 'captures')
process.env.BRIDGE_PROJECTS_ROOT = projectsRoot
process.env.BRIDGE_PROFILE_DIR = profileDir

const { buildServer } = await import('../src/server.ts')

const AUTH = { authorization: 'Bearer test-key-stop' }
const ALPHA = path.join(projectsRoot, 'alpha').replace(/\\/g, '/')
const MODEL = 'freebuff-deepseek-v4-flash'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await sleep(20)
  }
  throw new Error(`condition non atteinte en ${timeoutMs} ms`)
}

/** Session dont le tour dure : la déconnexion arrive pendant le tour. */
class SlowSession implements AgentSession {
  readonly pid = 3333
  readonly chatRef = 'ref-chat'
  readonly projectDir: string
  alive = true
  stopCalls = 0

  constructor(projectDir: string) {
    this.projectDir = projectDir
  }

  async send(): Promise<TurnResult> {
    await sleep(200)
    return { text: 'réponse lente', reasoning: '', finish: 'ok', refusal: null }
  }

  stop(): StopResult {
    this.stopCalls += 1
    this.alive = false
    return { ok: true, remaining: false }
  }
}

/** Session qui meurt après son premier tour : la CLI s'est arrêtée. */
class DyingSession implements AgentSession {
  readonly pid = 6666
  readonly chatRef = 'ref-chat'
  readonly projectDir: string
  alive = true

  constructor(projectDir: string) {
    this.projectDir = projectDir
  }

  async send(prompt: string): Promise<TurnResult> {
    this.alive = false
    return { text: `réponse à ${prompt}`, reasoning: '', finish: 'ok', refusal: null }
  }

  stop(): StopResult {
    return { ok: true, remaining: false }
  }
}

/** Session dont les tours aboutissent normalement. */
class OkSession implements AgentSession {
  readonly pid = 5555
  readonly chatRef = 'ref-chat'
  readonly projectDir: string
  alive = true
  stopCalls = 0

  constructor(projectDir: string) {
    this.projectDir = projectDir
  }

  async send(prompt: string): Promise<TurnResult> {
    return { text: `réponse à ${prompt}`, reasoning: '', finish: 'ok', refusal: null }
  }

  stop(): StopResult {
    this.stopCalls += 1
    this.alive = false
    return { ok: true, remaining: false }
  }
}

/** Session dont le tour est déjà marqué `stopped` au moment du rendu. */
class StoppedSession implements AgentSession {
  readonly pid = 4444
  readonly chatRef = 'ref-chat'
  readonly alive = true
  readonly projectDir: string

  constructor(projectDir: string) {
    this.projectDir = projectDir
  }

  async send(): Promise<TurnResult> {
    return { text: '', reasoning: '', finish: 'stopped', refusal: null }
  }

  stop(): StopResult {
    return { ok: true, remaining: false }
  }
}

function makeApp(create: (dir: string) => AgentSession) {
  return buildServer({ openSession: async dir => create(dir) })
}

async function bind(app: ReturnType<typeof makeApp>, chatId: string): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': chatId },
    payload: {
      model: 'freebuff-new',
      stream: false,
      messages: [{ role: 'user', content: ALPHA }],
    },
  })
  assert.equal(response.statusCode, 200)
}

async function startStream(
  app: ReturnType<typeof makeApp>,
  chatId: string,
): Promise<{ controller: AbortController; reader: ReadableStreamDefaultReader<Uint8Array> }> {
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address() as AddressInfo
  const controller = new AbortController()
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json', 'x-openwebui-chat-id': chatId },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      messages: [{ role: 'user', content: 'travaille longtemps' }],
    }),
    signal: controller.signal,
  })
  assert.equal(response.status, 200)
  assert.ok(response.body)
  return { controller, reader: response.body.getReader() }
}

test('une fin de flux normale n’arrête pas la session', async () => {
  const sessions: OkSession[] = []
  const app = makeApp(dir => {
    const session = new OkSession(dir)
    sessions.push(session)
    return session
  })

  await bind(app, 'chat-fin-normale')
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address() as AddressInfo
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json', 'x-openwebui-chat-id': 'chat-fin-normale' },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      messages: [{ role: 'user', content: 'bonjour' }],
    }),
  })
  const text = await response.text()
  assert.match(text, /\[DONE\]/)

  const second = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': 'chat-fin-normale' },
    payload: {
      model: MODEL,
      stream: false,
      messages: [
        { role: 'user', content: 'bonjour' },
        { role: 'assistant', content: 'réponse à bonjour' },
        { role: 'user', content: 'encore' },
      ],
    },
  })

  assert.equal(second.statusCode, 200)
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0]?.stopCalls, 0)

  await app.close()
})

test('une déconnexion SSE pendant le tour ne tue pas la session', async () => {
  const sessions: SlowSession[] = []
  const app = makeApp(dir => {
    const session = new SlowSession(dir)
    sessions.push(session)
    return session
  })

  await bind(app, 'chat-abandon')
  const { controller, reader } = await startStream(app, 'chat-abandon')
  await reader.read()

  controller.abort()
  void reader.cancel().catch(() => {})
  await sleep(120)

  // Le tour est déjà lancé (le quota est consommé) : on le laisse finir, sinon
  // la réponse est perdue et OpenWebUI relance à chaque rafraîchissement.
  assert.equal(sessions[0]?.stopCalls, 0)
  assert.equal(sessions[0]?.alive, true)

  await app.close()
})

test('un tour arrêté est rendu comme une fin normale, jamais comme une erreur', async () => {
  const app = makeApp(dir => new StoppedSession(dir))
  await bind(app, 'chat-stopped')

  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address() as AddressInfo
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json', 'x-openwebui-chat-id': 'chat-stopped' },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      messages: [{ role: 'user', content: 'travaille' }],
    }),
  })

  const text = await response.text()
  assert.match(text, /tour arrêté/)
  assert.match(text, /"finish_reason":"stop"/)
  assert.doesNotMatch(text, /"error"/)

  await app.close()
})

test('un tour arrêté en non-stream est un 409 distinct d’une erreur de tour', async () => {
  const app = makeApp(dir => new StoppedSession(dir))
  await bind(app, 'chat-stopped-2')

  const response = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': 'chat-stopped-2' },
    payload: {
      model: MODEL,
      stream: false,
      messages: [{ role: 'user', content: 'travaille' }],
    },
  })

  assert.equal(response.statusCode, 409)
  assert.equal((response.json() as { error: { code: string } }).error.code, 'stopped')

  await app.close()
})

test('après la mort de la session, le message suivant reçoit 503 sans relancer', async () => {
  const sessions: DyingSession[] = []
  const app = makeApp(dir => {
    const session = new DyingSession(dir)
    sessions.push(session)
    return session
  })

  await bind(app, 'chat-abandon-2')
  const first = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': 'chat-abandon-2' },
    payload: {
      model: MODEL,
      stream: false,
      messages: [{ role: 'user', content: 'premier' }],
    },
  })
  assert.equal(first.statusCode, 200)

  const after = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': 'chat-abandon-2' },
    payload: {
      model: MODEL,
      stream: false,
      messages: [{ role: 'user', content: 'on reprend ?' }],
    },
  })

  assert.equal(after.statusCode, 503)
  assert.equal((after.json() as { error: { code: string } }).error.code, 'session_gone')
  assert.equal(sessions.length, 1)

  await app.close()
})
