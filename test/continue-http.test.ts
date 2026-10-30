import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { AgentSession, StopResult, TurnResult } from '../src/freebuff/session.ts'

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'fb-continue-'))
const projectsRoot = mkdtempSync(path.join(os.tmpdir(), 'fb-continue-projects-'))
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
process.env.BRIDGE_API_KEY = 'test-key-continue'
process.env.BRIDGE_PROJECTS_ROOT = projectsRoot
process.env.BRIDGE_PROFILE_DIR = profileDir

const { buildServer } = await import('../src/server.ts')
const { signActionToken } = await import('../src/freebuff/action-token.ts')

const AUTH = { authorization: 'Bearer test-key-continue' }
const ALPHA = path.join(projectsRoot, 'alpha').replace(/\\/g, '/')
const SECRET = 'test-key-continue'

const OK: TurnResult = { text: 'réponse', reasoning: '', finish: 'ok', refusal: null }
const ENDED: TurnResult = {
  text: 'Your free session has ended. Send your message again to start a new one.',
  reasoning: '',
  finish: 'session_ended',
  refusal: null,
  failure: { message: 'Your free session has ended.', code: 'waiting_room_required', status: 428 },
}

/** Session factice : le tour « continue » est envoyé comme n'importe quel message. */
class FakeSession implements AgentSession {
  readonly pid = 6_001
  readonly chatRef = 'ref-continue'
  readonly projectDir: string
  alive = true
  static opened: string[] = []
  static sent: string[] = []
  static result: TurnResult = OK
  /** La session meurt après le tour : c'est le cas du bouton Continuer. */
  static diesAfterSend = false

  constructor(projectDir: string) {
    this.projectDir = projectDir
    FakeSession.opened.push(projectDir)
  }

  async send(prompt: string): Promise<TurnResult> {
    FakeSession.sent.push(prompt)
    if (FakeSession.diesAfterSend) this.alive = false
    return FakeSession.result
  }

  stop(): StopResult {
    return { ok: true, remaining: false }
  }
}

let counter = 0
function makeApp() {
  counter += 1
  return buildServer({
    bindingsFile: path.join(dataDir, `bindings-${String(counter)}.json`),
    openSession: async dir => new FakeSession(dir),
  })
}

async function bind(app: ReturnType<typeof makeApp>, chatId: string): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/bind',
    payload: { chatId, projectPath: ALPHA },
  })
  assert.equal(response.statusCode, 200)
}

async function post(app: ReturnType<typeof makeApp>, chatId: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': chatId },
    payload: {
      model: 'freebuff-deepseek-v4-flash',
      stream: false,
      messages: [{ role: 'user', content: 'travaille' }],
    },
  })
  assert.equal(response.statusCode, 200)
  return (JSON.parse(response.body) as { choices: Array<{ message: { content: string } }> }).choices[0]
    ?.message.content ?? ''
}

function reset(): void {
  FakeSession.opened = []
  FakeSession.sent = []
  FakeSession.result = OK
  FakeSession.diesAfterSend = false
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition non atteinte')
}

test('les scripts d’interface sont servis par le pont, pas par le static d’OWUI', async () => {
  const app = makeApp()

  const quota = await app.inject({ method: 'GET', url: '/fb-quota.js' })
  assert.equal(quota.statusCode, 200)
  assert.match(quota.headers['content-type'] ?? '', /javascript/)
  assert.match(quota.body, /__fbQuotaInstalled/)

  const picker = await app.inject({ method: 'GET', url: '/fb-picker.js' })
  assert.equal(picker.statusCode, 200)

  const bubbles = await app.inject({ method: 'GET', url: '/fb-bubbles.js' })
  assert.equal(bubbles.statusCode, 200)
  assert.match(bubbles.headers['content-type'] ?? '', /javascript/)
  assert.match(bubbles.body, /__fbBubblesInstalled/)

  await app.close()
})

test('un lien Continuer valide envoie continue, puis refuse un second clic', async () => {
  reset()
  const app = makeApp()
  await bind(app, 'chat-continue')

  const token = signActionToken(SECRET, 'chat-continue')
  const first = await app.inject({ method: 'GET', url: `/a/continue?t=${encodeURIComponent(token)}` })

  assert.equal(first.statusCode, 302)
  assert.match(first.headers.location ?? '', /\/c\/chat-continue/)
  await waitFor(() => FakeSession.sent.includes('continue'))
  assert.deepEqual(FakeSession.sent, ['continue'])

  const second = await app.inject({ method: 'GET', url: `/a/continue?t=${encodeURIComponent(token)}` })
  assert.equal(second.statusCode, 410)
  assert.equal((JSON.parse(second.body) as { error: { code: string } }).error.code, 'token_used')
  assert.deepEqual(FakeSession.sent, ['continue'], 'le second clic ne relance rien')

  await app.close()
})

test('un jeton expiré ou inconnu est refusé', async () => {
  const app = makeApp()

  const expired = signActionToken(SECRET, 'chat-expire', Date.now() - 11 * 60_000)
  const response = await app.inject({ method: 'GET', url: `/a/continue?t=${expired}` })
  assert.equal(response.statusCode, 410)

  const forged = await app.inject({ method: 'GET', url: '/a/continue?t=nimporte-quoi' })
  assert.equal(forged.statusCode, 410)

  await app.close()
})

test('une fin de session affiche le lien Continuer, journalise le 428 et attire l’attention', async () => {
  reset()
  FakeSession.result = ENDED
  FakeSession.diesAfterSend = true
  const app = makeApp()
  await bind(app, 'chat-end')

  const content = await post(app, 'chat-end')
  assert.match(content, /Continuer/)
  const link = /\((http:\/\/127\.0\.0\.1:\d+\/a\/continue\?t=[^)]+)\)/.exec(content)
  assert.ok(link, 'le lien signé est présent')

  const records = readFileSync(path.join(dataDir, 'turns.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { outcome: string; status: number | null; chatId: string })
  const record = records.filter(item => item.chatId === 'chat-end').at(-1)
  assert.ok(record, 'le tour est journalisé')
  assert.deepEqual(
    { outcome: record.outcome, status: record.status, chatId: record.chatId },
    { outcome: 'session_ended', status: 428, chatId: 'chat-end' },
  )

  const quota = await app.inject({ method: 'GET', url: '/api/quota?chatId=chat-end' })
  const attention = (quota.json() as { attention: { outcome: string } | null }).attention
  assert.equal(attention?.outcome, 'session_ended')

  // La session est morte : le clic la relance (action explicite), puis envoie.
  const opened = FakeSession.opened.length
  const click = await app.inject({ method: 'GET', url: (link?.[1] ?? '').replace('http://127.0.0.1:7799', '') })
  assert.equal(click.statusCode, 302)
  await waitFor(() => FakeSession.sent.includes('continue'))
  assert.equal(FakeSession.opened.length, opened + 1)

  await app.close()
})
