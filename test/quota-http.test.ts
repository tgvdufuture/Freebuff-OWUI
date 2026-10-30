import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { beforeEach } from 'node:test'
import type {
  AgentSession,
  SessionLeftReading,
  StopResult,
  TurnResult,
} from '../src/freebuff/session.ts'

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'fb-quota-'))
const projectsRoot = mkdtempSync(path.join(os.tmpdir(), 'fb-quota-projects-'))
const profileDir = path.join(dataDir, 'profile')

mkdirSync(path.join(projectsRoot, 'alpha'))
mkdirSync(path.join(projectsRoot, 'beta'))
mkdirSync(profileDir, { recursive: true })
writeFileSync(
  path.join(dataDir, 'models.json'),
  JSON.stringify([{ id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' }]),
  'utf8',
)

process.env.BRIDGE_STUB = '0'
process.env.BRIDGE_DATA_DIR = dataDir
process.env.BRIDGE_API_KEY = 'test-key-quota'
process.env.BRIDGE_PROJECTS_ROOT = projectsRoot
process.env.BRIDGE_PROFILE_DIR = profileDir

const { buildServer } = await import('../src/server.ts')

// Une lecture de quota est persistée : chaque test part d'un état vierge.
beforeEach(() => rmSync(path.join(dataDir, 'quota.json'), { force: true }))

const AUTH = { authorization: 'Bearer test-key-quota' }
const ALPHA = path.join(projectsRoot, 'alpha').replace(/\\/g, '/')
const BETA = path.join(projectsRoot, 'beta').replace(/\\/g, '/')

/** Session factice qui porte le décompte lu sur son écran (aucune TUI). */
class TimedSession implements AgentSession {
  readonly pid = 5151
  readonly chatRef = 'ref-quota'
  readonly alive = true
  readonly projectDir: string
  readonly quota = { found: true, remainingHours: 2, totalHours: 12, exhausted: false }
  sessionLeft: SessionLeftReading | null

  constructor(projectDir: string, left: SessionLeftReading | null) {
    this.projectDir = projectDir
    this.sessionLeft = left
  }

  async send(): Promise<TurnResult> {
    return { text: 'tour factice', reasoning: '', finish: 'ok', refusal: null }
  }

  stop(): StopResult {
    return { ok: true, remaining: false }
  }
}

const opened: string[] = []

const makeApp = (left: SessionLeftReading | null) => {
  const app = buildServer({
    bindingsFile: path.join(dataDir, `bindings-${String(opened.length)}-${String(Date.now())}.json`),
    openSession: async projectDir => {
      opened.push(projectDir)
      return new TimedSession(projectDir, left)
    },
    // La barre ne doit JAMAIS lancer de TUI : une sonde ici ferait échouer le test.
    quotaProbe: async () => {
      throw new Error('la barre de quota ne doit pas sonder la CLI')
    },
  })
  return app
}

const bind = async (app: ReturnType<typeof makeApp>, chatId: string, projectPath: string) => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/bind',
    headers: AUTH,
    payload: { chatId, projectPath },
  })
  assert.equal(response.statusCode, 200)
}

/** Un tour ordinaire : c'est lui qui ouvre la session du projet lié. */
const turn = async (app: ReturnType<typeof makeApp>, chatId: string) => {
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
}

test('la barre lit le décompte de la session du chat, sans lancer de CLI', async () => {
  const app = makeApp({ minutes: 42, totalMinutes: 59, at: 1_700_000_000_000 })
  await bind(app, 'chat-quota', ALPHA)
  await turn(app, 'chat-quota')
  const launches = opened.length

  const response = await app.inject({ method: 'GET', url: '/api/quota?chatId=chat-quota' })

  assert.equal(response.statusCode, 200)
  const body = response.json() as {
    at: number
    left: { minutes: number; totalMinutes: number; at: number } | null
    quota: { remainingHours: number; totalHours: number; source: string } | null
  }
  assert.deepEqual(body.left, { minutes: 42, totalMinutes: 59, at: 1_700_000_000_000 })
  assert.equal(body.quota?.remainingHours, 2)
  assert.equal(body.quota?.totalHours, 12)
  assert.equal(body.quota?.source, 'session')
  assert.equal(opened.length, launches, 'aucune session ouverte par la barre')
  assert.ok(Math.abs(body.at - Date.now()) < 5_000)

  await app.close()
})

/**
 * Session qui sait relire son quota dans la TUI (`/model`) : cas réel.
 *
 * Son écran porte d'abord le bandeau du démarrage (`2/12`), puis la ligne du
 * panneau (`7/12`) : `quota` suit ce que l'écran rend, comme la vraie session.
 */
class RefreshableSession implements AgentSession {
  static refreshes = 0
  readonly pid = 5252
  readonly chatRef = 'ref-refresh'
  readonly alive = true
  readonly projectDir: string
  readonly sessionLeft = { minutes: 42, totalMinutes: 59, at: 1_700_000_000_000 }
  quota: { found: boolean; remainingHours: number | null; totalHours: number | null; exhausted: boolean } = {
    found: true,
    remainingHours: 2,
    totalHours: 12,
    exhausted: false,
  }

  constructor(projectDir: string) {
    this.projectDir = projectDir
  }

  async send(): Promise<TurnResult> {
    return { text: 'tour factice', reasoning: '', finish: 'ok', refusal: null }
  }

  stop(): StopResult {
    return { ok: true, remaining: false }
  }

  async refreshQuota() {
    RefreshableSession.refreshes += 1
    this.quota = { found: true, remainingHours: 7, totalHours: 12, exhausted: false }
    return this.quota
  }
}

const makeRefreshableApp = () =>
  buildServer({
    bindingsFile: path.join(dataDir, `bindings-refresh-${String(Date.now())}.json`),
    openSession: async projectDir => {
      opened.push(projectDir)
      return new RefreshableSession(projectDir)
    },
    quotaProbe: async () => {
      throw new Error('la barre de quota ne doit pas sonder la CLI')
    },
  })

/** Attend que la barre rende la valeur relue (la relecture est asynchrone). */
async function quotaWithin(
  app: ReturnType<typeof makeRefreshableApp>,
  chatId: string,
  hours: number,
): Promise<{ remainingHours: number | null; source: string } | null> {
  const deadline = Date.now() + 2_000
  let quota: { remainingHours: number | null; source: string } | null = null
  while (Date.now() < deadline) {
    const response = await app.inject({ method: 'GET', url: `/api/quota?chatId=${chatId}` })
    quota = (response.json() as { quota: { remainingHours: number | null; source: string } | null }).quota
    if (quota?.remainingHours === hours) return quota
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return quota
}

test('la barre relit le quota du compte dans la session, via /model', async () => {
  RefreshableSession.refreshes = 0
  const app = makeRefreshableApp()
  await bind(app, 'chat-refresh', ALPHA)
  await turn(app, 'chat-refresh')

  // Première lecture : le bandeau du démarrage, encore figé.
  const first = await app.inject({ method: 'GET', url: '/api/quota?chatId=chat-refresh' })
  const firstQuota = (first.json() as { quota: { remainingHours: number } }).quota
  assert.equal(firstQuota.remainingHours, 2)

  // La relecture part en fond, puis la barre rend la valeur du panneau.
  const fresh = await quotaWithin(app, 'chat-refresh', 7)
  assert.equal(fresh?.remainingHours, 7)
  assert.equal(fresh?.source, 'session')
  assert.equal(RefreshableSession.refreshes, 1)

  // `/api/quota` est appelé en boucle : pas de nouvelle relecture tout de suite.
  await quotaWithin(app, 'chat-refresh', 7)
  assert.equal(RefreshableSession.refreshes, 1)

  await app.close()
})

test('sans session vivante, la barre ne relit rien et n’ouvre rien', async () => {
  RefreshableSession.refreshes = 0
  const app = makeRefreshableApp()
  const launches = opened.length

  const response = await app.inject({ method: 'GET', url: '/api/quota?chatId=chat-inconnu' })

  assert.equal(response.statusCode, 200)
  assert.equal(RefreshableSession.refreshes, 0)
  assert.equal(opened.length, launches, 'aucune session ouverte par la barre')

  await app.close()
})

test('sans session ouverte, la barre ne reçoit aucun décompte', async () => {
  const app = makeApp({ minutes: 42, totalMinutes: 59, at: Date.now() })

  const launches = opened.length
  const response = await app.inject({ method: 'GET', url: '/api/quota?chatId=inconnu' })
  const body = response.json() as { left: unknown; quota: unknown }

  assert.equal(response.statusCode, 200)
  assert.equal(body.left, null)
  assert.equal(body.quota, null)
  assert.equal(opened.length, launches)

  await app.close()
})

test('deux chats du même dossier : chaque barre lit SA session', async () => {
  /** Chaque CLI reçoit un décompte différent, pour distinguer les barres. */
  const countdowns = [42, 7]
  class OwnSession extends TimedSession {
    constructor(projectDir: string) {
      super(projectDir, { minutes: countdowns.shift() ?? 0, totalMinutes: 59, at: 1_700_000_000_000 })
    }
  }

  const app = buildServer({
    bindingsFile: path.join(dataDir, `bindings-same-dir-${String(Date.now())}.json`),
    openSession: async projectDir => new OwnSession(projectDir),
    quotaProbe: async () => {
      throw new Error('la barre de quota ne doit pas sonder la CLI')
    },
  })

  await bind(app, 'chat-jumeau-a', ALPHA)
  await bind(app, 'chat-jumeau-b', ALPHA)
  await turn(app, 'chat-jumeau-a')
  await turn(app, 'chat-jumeau-b')

  const a = await app.inject({ method: 'GET', url: '/api/quota?chatId=chat-jumeau-a' })
  const b = await app.inject({ method: 'GET', url: '/api/quota?chatId=chat-jumeau-b' })

  // Deux sessions sur le MÊME dossier : aucune ne remplit la barre de l'autre.
  assert.equal((a.json() as { left: { minutes: number } | null }).left?.minutes, 42)
  assert.equal((b.json() as { left: { minutes: number } | null }).left?.minutes, 7)

  await app.close()
})

test('la session d’un autre projet ne remplit pas la barre de ce chat', async () => {
  const app = makeApp({ minutes: 7, totalMinutes: 59, at: Date.now() })
  await bind(app, 'chat-alpha', ALPHA)
  await bind(app, 'chat-beta', BETA)
  await turn(app, 'chat-alpha')

  const same = await app.inject({ method: 'GET', url: '/api/quota?chatId=chat-alpha' })
  assert.deepEqual((same.json() as { left: { minutes: number } | null }).left?.minutes, 7)

  const other = await app.inject({ method: 'GET', url: '/api/quota?chatId=chat-beta' })
  assert.equal((other.json() as { left: unknown }).left, null)

  await app.close()
})
