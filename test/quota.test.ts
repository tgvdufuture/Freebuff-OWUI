import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { beforeEach } from 'node:test'
import type { AgentSession, StopResult, TurnResult } from '../src/freebuff/session.ts'

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'fb-quota-'))
const projectsRoot = mkdtempSync(path.join(os.tmpdir(), 'fb-quota-projects-'))
const profileDir = path.join(dataDir, 'profile')
const bin = path.join(dataDir, 'bin', 'freebuff.exe')

mkdirSync(path.join(projectsRoot, 'alpha'))
mkdirSync(profileDir, { recursive: true })
mkdirSync(path.dirname(bin), { recursive: true })
writeFileSync(bin, '', 'utf8')
writeFileSync(
  path.join(profileDir, 'settings.json'),
  JSON.stringify({ freebuffModel: 'deepseek/deepseek-v4-flash' }),
  'utf8',
)
writeFileSync(
  path.join(dataDir, 'models.json'),
  JSON.stringify([
    { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4.1 Flash', cost: '3x' },
    { key: 'm-61c26317cc', label: 'MiMo v2.6 Flash Slow', cost: 'le moins cher' },
  ]),
  'utf8',
)

process.env.BRIDGE_STUB = '0'
process.env.BRIDGE_DATA_DIR = dataDir
process.env.BRIDGE_API_KEY = 'test-key-quota'
process.env.BRIDGE_PROJECTS_ROOT = projectsRoot
process.env.BRIDGE_PROFILE_DIR = profileDir
process.env.FREEBUFF_BIN = bin

const { buildServer } = await import('../src/server.ts')

// La dernière lecture de quota est persistée : chaque test part d'un état vierge.
beforeEach(() => rmSync(path.join(dataDir, 'quota.json'), { force: true }))

const AUTH = { authorization: 'Bearer test-key-quota' }
const ALPHA = path.join(projectsRoot, 'alpha').replace(/\\/g, '/')

class QuotaSession implements AgentSession {
  readonly pid = 1234
  readonly chatRef = 'ref-quota'
  readonly projectDir: string
  readonly alive = true
  /** Bandeau réel : 2 heures restantes sur 12. */
  readonly quota = { found: true, remainingHours: 2, totalHours: 12, exhausted: false }

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

/** Sonde factice : compte ses appels, ne lance aucune TUI. */
const fakeProbe = (found = true) => {
  let calls = 0
  const probe = async (): Promise<{
    quota: { found: boolean; remainingHours: number | null; totalHours: number | null; exhausted: boolean }
    refusal: string | null
  }> => {
    calls += 1
    return {
      quota: { found, remainingHours: found ? 6 : null, totalHours: found ? 15 : null, exhausted: false },
      refusal: null,
    }
  }
  return { probe, calls: () => calls }
}

type Health = {
  modelCost: string | null
  quota: { remainingHours: number | null; totalHours: number | null; source: string } | null
}

test('/health ne lance aucune TUI tout seul et affiche le coût du modèle', async () => {
  const fake = fakeProbe()
  const app = buildServer({ openSession: async dir => new QuotaSession(dir), quotaProbe: fake.probe })

  const response = await app.inject({ method: 'GET', url: '/health' })
  assert.equal(response.statusCode, 200)
  const body = response.json() as Health

  assert.equal(body.modelCost, '3x', 'le coût du modèle actif vient de models.json')
  assert.equal(body.quota, null, 'sans lecture, le quota est inconnu — pas deviné')
  assert.equal(fake.calls(), 0, '/health sans ?quota=1 ne doit rien lancer')

  await app.close()
})

test('/health?quota=1 lit le quota avec la sonde et le garde', async () => {
  const fake = fakeProbe()
  const app = buildServer({ openSession: async dir => new QuotaSession(dir), quotaProbe: fake.probe })

  const probed = await app.inject({ method: 'GET', url: '/health?quota=1' })
  const body = probed.json() as Health
  assert.equal(body.quota?.remainingHours, 6)
  assert.equal(body.quota?.totalHours, 15)
  assert.equal(body.quota?.source, 'probe')
  assert.equal(fake.calls(), 1)

  const again = await app.inject({ method: 'GET', url: '/health' })
  assert.equal((again.json() as Health).quota?.remainingHours, 6, 'la lecture reste visible')
  assert.equal(fake.calls(), 1, 'une lecture suffit : pas de sonde à chaque /health')

  await app.close()
})

test('la dernière lecture survit au redémarrage du pont', async () => {
  writeFileSync(
    path.join(dataDir, 'quota.json'),
    JSON.stringify({
      remainingHours: 3,
      totalHours: 12,
      exhausted: false,
      at: 1_700_000_000_000,
      source: 'session',
    }),
    'utf8',
  )
  const app = buildServer({ openSession: async dir => new QuotaSession(dir) })

  const body = (await app.inject({ method: 'GET', url: '/health' })).json() as Health
  assert.equal(body.quota?.remainingHours, 3)
  assert.equal(body.quota?.source, 'session')

  await app.close()
})

test('une sonde muette laisse le quota inconnu au lieu d’inventer zéro', async () => {
  const fake = fakeProbe(false)
  const app = buildServer({ openSession: async dir => new QuotaSession(dir), quotaProbe: fake.probe })

  const response = await app.inject({ method: 'GET', url: '/health?quota=1' })
  const body = response.json() as Health
  assert.equal(body.quota, null)
  assert.equal(fake.calls(), 1)

  await app.close()
})

test('une session ouverte donne son quota sans sonde', async () => {
  const fake = fakeProbe()
  const app = buildServer({ openSession: async dir => new QuotaSession(dir), quotaProbe: fake.probe })
  const chatId = 'chat-quota'

  await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': chatId },
    payload: { model: 'freebuff-new', stream: false, messages: [{ role: 'user', content: ALPHA }] },
  })

  await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': chatId },
    payload: {
      model: 'freebuff-deepseek-v4-flash',
      stream: false,
      messages: [{ role: 'user', content: 'travaille' }],
    },
  })

  const response = await app.inject({ method: 'GET', url: '/health' })
  const body = response.json() as Health
  assert.equal(body.quota?.remainingHours, 2)
  assert.equal(body.quota?.totalHours, 12)
  assert.equal(body.quota?.source, 'session', 'le bandeau d’une session vivante suffit')
  assert.equal(fake.calls(), 0)

  await app.close()
})
