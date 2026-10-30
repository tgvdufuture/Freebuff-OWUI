import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { AgentSession, StopResult, TurnResult } from '../src/freebuff/session.ts'

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'fb-diagnostic-'))
const projectsRoot = mkdtempSync(path.join(os.tmpdir(), 'fb-diagnostic-projects-'))
const profileDir = path.join(dataDir, 'profile')
const binDir = path.join(dataDir, 'bin')
const captureDir = path.join(dataDir, 'captures')
const logsDir = path.join(dataDir, 'logs')
const bin = path.join(binDir, 'freebuff.exe')

mkdirSync(path.join(projectsRoot, 'alpha'))
mkdirSync(path.join(projectsRoot, 'beta'))
mkdirSync(profileDir, { recursive: true })
mkdirSync(binDir, { recursive: true })
writeFileSync(bin, '', 'utf8')
writeFileSync(
  path.join(binDir, 'freebuff-metadata.json'),
  JSON.stringify({ version: '0.2.29', target: 'win32-x64' }),
  'utf8',
)
writeFileSync(
  path.join(profileDir, 'settings.json'),
  JSON.stringify({ freebuffModel: 'z-ai/glm-5.3' }),
  'utf8',
)
writeFileSync(
  path.join(dataDir, 'models.json'),
  JSON.stringify([{ id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' }]),
  'utf8',
)

process.env.BRIDGE_STUB = '0'
process.env.BRIDGE_DATA_DIR = dataDir
process.env.BRIDGE_API_KEY = 'test-key-diagnostic'
process.env.BRIDGE_CAPTURE_DIR = captureDir
process.env.BRIDGE_PROJECTS_ROOT = projectsRoot
process.env.BRIDGE_PROFILE_DIR = profileDir
process.env.FREEBUFF_BIN = bin

const { buildServer } = await import('../src/server.ts')

const AUTH = { authorization: 'Bearer test-key-diagnostic' }
const ALPHA = path.join(projectsRoot, 'alpha').replace(/\\/g, '/')
const BETA = path.join(projectsRoot, 'beta').replace(/\\/g, '/')

class FakeSession implements AgentSession {
  readonly pid: number = 7777
  readonly chatRef: string = 'ref-diagnostic'
  readonly projectDir: string
  readonly alive = true

  constructor(projectDir: string) {
    this.projectDir = projectDir
  }

  async send(prompt: string): Promise<TurnResult> {
    return { text: `réponse à ${prompt}`, reasoning: '', finish: 'ok', refusal: null }
  }

  stop(): StopResult {
    return { ok: true, remaining: false }
  }
}

/** Session d'un second projet : PID et conversation distincts, comme en vrai. */
class SecondSession extends FakeSession {
  override readonly pid = 8888
  override readonly chatRef = 'ref-diagnostic-2'
}

const makeApp = (overrides: { freebuffBin?: string; profileDir?: string; bindingsFile?: string } = {}) =>
  buildServer({
    openSession: async dir => (dir === BETA ? new SecondSession(dir) : new FakeSession(dir)),
    ...overrides,
  })

const readJournal = (): string =>
  readdirSync(logsDir)
    .filter(file => file.endsWith('.log'))
    .map(file => readFileSync(path.join(logsDir, file), 'utf8'))
    .join('')

test('/health expose binaire, version, profil et modèle sans lancer de CLI', async () => {
  const app = makeApp()
  await app.inject({ method: 'GET', url: '/health' }) // échauffement : la 1re requête compile les routes

  const started = Date.now()
  const response = await app.inject({ method: 'GET', url: '/health' })
  const elapsed = Date.now() - started

  assert.equal(response.statusCode, 200)
  const body = response.json() as {
    cli: { found: boolean; path: string; version: string | null }
    profileDir: { path: string; exists: boolean }
    model: string | null
    session: unknown
    lastRefusal: unknown
  }
  assert.equal(body.cli.found, true)
  assert.equal(body.cli.path, bin)
  assert.equal(body.cli.version, '0.2.29')
  assert.equal(body.profileDir.path, profileDir)
  assert.equal(body.profileDir.exists, true)
  assert.equal(body.model, 'z-ai/glm-5.3')
  assert.equal(body.session, null)
  assert.equal(body.lastRefusal, null)
  assert.ok(elapsed < 100, `/health trop lent : ${elapsed} ms`)

  await app.close()
})

test('un binaire et un profil absents sont des champs, pas une erreur', async () => {
  const app = makeApp({
    freebuffBin: path.join(dataDir, 'absent', 'freebuff.exe'),
    profileDir: path.join(dataDir, 'absent-profile'),
  })
  const response = await app.inject({ method: 'GET', url: '/health' })

  assert.equal(response.statusCode, 200)
  const body = response.json() as {
    cli: { found: boolean; version: string | null }
    profileDir: { exists: boolean }
    model: string | null
  }
  assert.equal(body.cli.found, false)
  assert.equal(body.cli.version, null)
  assert.equal(body.profileDir.exists, false)
  assert.equal(body.model, null)

  await app.close()
})

test('la page de diagnostic ne contient aucun secret ni ressource externe', async () => {
  const app = makeApp()
  const response = await app.inject({ method: 'GET', url: '/diagnostic' })

  assert.equal(response.statusCode, 200)
  assert.match(response.headers['content-type'] as string, /text\/html/)
  assert.match(response.body, /z-ai\/glm-5\.3/)
  assert.match(response.body, /0\.2\.29/)
  assert.match(response.body, /aucune session ouverte/)
  assert.match(response.body, /aucun depuis le démarrage/)
  assert.doesNotMatch(response.body, /test-key-diagnostic/)
  assert.doesNotMatch(response.body, /credentials|tokenKey/)
  assert.doesNotMatch(response.body, /(?:src|href)="https?:/)

  await app.close()
})

test('la page montre la session vivante et le dernier refus', async () => {
  const app = makeApp()

  await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': 'chat-diag' },
    payload: {
      model: 'freebuff-new',
      stream: false,
      messages: [{ role: 'user', content: ALPHA }],
    },
  })

  // Un tour normal ouvre la session (pid 7777).
  await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': 'chat-diag' },
    payload: {
      model: 'freebuff-deepseek-v4-flash',
      stream: false,
      messages: [{ role: 'user', content: 'bonjour' }],
    },
  })

  // Un refus réel : la même liste n'en est plus un (elle rend la réponse déjà
  // produite), donc on déclenche un modèle inconnu.
  await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': 'chat-diag' },
    payload: {
      model: 'modele-inconnu',
      stream: false,
      messages: [{ role: 'user', content: 'bonjour' }],
    },
  })

  const response = await app.inject({ method: 'GET', url: '/diagnostic' })
  assert.match(response.body, /pid 7777/)
  assert.match(response.body, /unknown_model/)

  const health = (await app.inject({ method: 'GET', url: '/health' })).json() as {
    lastRefusal: { code: string; status: number }
    session: { pid: number }
  }
  assert.equal(health.lastRefusal.code, 'unknown_model')
  assert.equal(health.lastRefusal.status, 400)
  assert.equal(health.session.pid, 7777)

  await app.close()
})

test('deux projets ouverts en parallèle apparaissent tous les deux au diagnostic', async () => {
  const app = makeApp()

  for (const [chatId, project] of [
    ['chat-diag-a', ALPHA],
    ['chat-diag-b', BETA],
  ] as const) {
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { ...AUTH, 'x-openwebui-chat-id': chatId },
      payload: { model: 'freebuff-new', stream: false, messages: [{ role: 'user', content: project }] },
    })
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { ...AUTH, 'x-openwebui-chat-id': chatId },
      payload: { model: 'freebuff-deepseek-v4-flash', stream: false, messages: [{ role: 'user', content: 'bonjour' }] },
    })
  }

  const health = (await app.inject({ method: 'GET', url: '/health' })).json() as {
    sessions: Array<{ pid: number; projectDir: string }>
    session: { pid: number }
  }
  assert.deepEqual(health.sessions.map(s => s.pid), [7777, 8888])
  assert.deepEqual(health.sessions.map(s => s.projectDir), [ALPHA, BETA])
  assert.equal(health.session.pid, 7777, 'le champ historique reste la première session')

  const page = await app.inject({ method: 'GET', url: '/diagnostic' })
  assert.match(page.body, /pid 7777/)
  assert.match(page.body, /pid 8888/)

  await app.close()
})

test('le journal date les requêtes sans y écrire le prompt', async () => {
  const app = makeApp()

  await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': 'chat-journal' },
    payload: {
      model: 'freebuff-new',
      stream: false,
      messages: [{ role: 'user', content: ALPHA }],
    },
  })

  const secret = 'CONSIGNE-CONFIDENTIELLE-42'
  await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': 'chat-journal' },
    payload: {
      model: 'freebuff-deepseek-v4-flash',
      stream: false,
      messages: [{ role: 'user', content: secret }],
    },
  })

  const journal = readJournal()
  assert.match(journal, /"event":"request"/)
  assert.match(journal, /"event":"binding"/)
  assert.doesNotMatch(journal, new RegExp(secret))

  await app.close()
})
