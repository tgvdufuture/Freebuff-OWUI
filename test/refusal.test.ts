import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { AgentSession, StopResult, TurnResult } from '../src/freebuff/session.ts'
import { REFUSAL_MESSAGES } from '../src/freebuff/screen.ts'

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'fb-refusal-'))
const projectsRoot = mkdtempSync(path.join(os.tmpdir(), 'fb-refusal-projects-'))
const profileDir = path.join(dataDir, 'profile')

mkdirSync(path.join(projectsRoot, 'alpha'))
mkdirSync(profileDir, { recursive: true })
writeFileSync(
  path.join(dataDir, 'models.json'),
  JSON.stringify([{ id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4.1 Flash', cost: '3x' }]),
  'utf8',
)

process.env.BRIDGE_STUB = '0'
process.env.BRIDGE_DATA_DIR = dataDir
process.env.BRIDGE_API_KEY = 'test-key-refusal'
process.env.BRIDGE_PROJECTS_ROOT = projectsRoot
process.env.BRIDGE_PROFILE_DIR = profileDir

const { buildServer } = await import('../src/server.ts')

const AUTH = { authorization: 'Bearer test-key-refusal' }
const ALPHA = path.join(projectsRoot, 'alpha').replace(/\\/g, '/')

/** Session factice : la TUI a refusé le tour (panneau « Not enough hours »). */
class RefusedSession implements AgentSession {
  readonly pid = 4242
  readonly chatRef = 'ref-refusal'
  readonly projectDir: string
  readonly alive = true

  constructor(projectDir: string) {
    this.projectDir = projectDir
  }

  async send(): Promise<TurnResult> {
    return { text: '', reasoning: '', finish: 'refused', refusal: 'not_enough_hours' }
  }

  stop(): StopResult {
    return { ok: true, remaining: false }
  }
}

test('un refus en cours de tour arrive avec son explication, pas « refused »', async () => {
  const app = buildServer({ openSession: async dir => new RefusedSession(dir) })
  const chatId = 'chat-refusal'

  const bound = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': chatId },
    payload: {
      model: 'freebuff-new',
      stream: false,
      messages: [{ role: 'user', content: ALPHA }],
    },
  })
  assert.equal(bound.statusCode, 200)

  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address() as AddressInfo
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json', 'x-openwebui-chat-id': chatId },
    body: JSON.stringify({
      model: 'freebuff-deepseek-v4-flash',
      stream: true,
      messages: [{ role: 'user', content: 'travaille' }],
    }),
  })
  assert.equal(response.status, 200, 'le flux a déjà commencé : le refus passe par le SSE')

  const body = await response.text()
  await app.close()

  assert.match(body, /not_enough_hours/, 'le code du refus doit être transmis')
  assert.ok(
    body.includes(REFUSAL_MESSAGES.not_enough_hours),
    'le message doit expliquer le coût du modèle et quoi faire',
  )
  assert.doesNotMatch(body, /tour non abouti \(refused\)/, 'un refus connu ne doit pas rester muet')
})
