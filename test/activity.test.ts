import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { AgentSession, StopResult, TurnResult } from '../src/freebuff/session.ts'

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'fb-activity-'))
const projectsRoot = mkdtempSync(path.join(os.tmpdir(), 'fb-activity-projects-'))
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
process.env.BRIDGE_API_KEY = 'test-key-activity'
process.env.BRIDGE_CAPTURE_DIR = path.join(dataDir, 'captures')
process.env.BRIDGE_PROJECTS_ROOT = projectsRoot
process.env.BRIDGE_PROFILE_DIR = profileDir
process.env.BRIDGE_ACTIVITY_AFTER_MS = '200'

const { buildServer } = await import('../src/server.ts')

const AUTH = { authorization: 'Bearer test-key-activity' }
const ALPHA = path.join(projectsRoot, 'alpha').replace(/\\/g, '/')
const MODEL = 'freebuff-deepseek-v4-flash'

/** Session dont le tour dure `delayMs` avant de rendre son texte. */
class SlowSession implements AgentSession {
  readonly pid = 6161
  readonly chatRef = 'ref-activity'
  readonly projectDir: string
  readonly alive = true
  private readonly delayMs: number

  constructor(projectDir: string, delayMs: number) {
    this.projectDir = projectDir
    this.delayMs = delayMs
  }

  async send(prompt: string): Promise<TurnResult> {
    await new Promise(resolve => setTimeout(resolve, this.delayMs))
    return { text: `réponse finale : ${prompt}`, reasoning: '', finish: 'ok', refusal: null }
  }

  stop(): StopResult {
    return { ok: true, remaining: false }
  }
}

/** Session qui streame un premier morceau tout de suite, puis finit plus tard. */
class StreamingSession implements AgentSession {
  readonly pid = 6162
  readonly chatRef = 'ref-stream'
  readonly projectDir: string
  readonly alive = true

  constructor(projectDir: string) {
    this.projectDir = projectDir
  }

  async send(_prompt: string, onDelta: (text: string) => void): Promise<TurnResult> {
    onDelta('morceau ')
    await new Promise(resolve => setTimeout(resolve, 600))
    return { text: 'morceau final', reasoning: '', finish: 'ok', refusal: null }
  }

  stop(): StopResult {
    return { ok: true, remaining: false }
  }
}

async function bindAndStream(
  delayMs: number,
  chatId: string,
  openSession: (dir: string) => AgentSession = dir => new SlowSession(dir, delayMs),
): Promise<string> {
  const app = buildServer({ openSession: async dir => openSession(dir) })

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
      model: MODEL,
      stream: true,
      messages: [{ role: 'user', content: 'travaille' }],
    }),
  })
  assert.equal(response.status, 200)

  const text = await response.text()
  await app.close()
  return text
}

test('un tour qui streame déjà n’affiche pas l’indicateur au milieu de la réponse', async () => {
  const text = await bindAndStream(0, 'chat-stream', dir => new StreamingSession(dir))

  const content = text
    .split('\n')
    .filter(line => line.startsWith('data: {'))
    .map(line => {
      const parsed = JSON.parse(line.slice(6)) as {
        choices?: { delta?: { content?: string } }[]
      }
      return parsed.choices?.[0]?.delta?.content ?? ''
    })
    .join('')

  assert.doesNotMatch(text, /⏳/)
  assert.equal(content, 'morceau final')
})

test('un tour long affiche un indicateur d’activité puis la réponse, sans doublon', async () => {
  const text = await bindAndStream(600, 'chat-lent')

  assert.match(text, /⏳ Tour en cours/)
  assert.doesNotMatch(text, /un bloc/, 'l’indicateur ne doit plus promettre une réponse en bloc')
  assert.match(text, /réponse finale : travaille/)
  assert.equal(text.match(/réponse finale : travaille/g)?.length, 1, 'texte de réponse dupliqué')
  assert.equal(text.split('\n').filter(line => line.startsWith('data: ')).at(-1), 'data: [DONE]')
  assert.match(text, /"finish_reason":"stop"/)
})

test('un rechargement pendant le tour ne tue pas la session et rejoue la réponse', async () => {
  const sent: string[] = []
  let stops = 0

  /** Tour qui dure assez pour qu'on coupe la connexion au milieu. */
  class DetachSession implements AgentSession {
    readonly pid = 6262
    readonly chatRef = 'ref-detach'
    readonly projectDir: string
    readonly alive = true

    constructor(dir: string) {
      this.projectDir = dir
    }

    async send(prompt: string): Promise<TurnResult> {
      sent.push(prompt)
      await new Promise(resolve => setTimeout(resolve, 300))
      return { text: 'réponse longue', reasoning: '', finish: 'ok', refusal: null }
    }

    stop(): StopResult {
      stops++
      return { ok: true, remaining: false }
    }
  }

  const app = buildServer({ openSession: async dir => new DetachSession(dir) })
  const bound = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': 'chat-detach' },
    payload: {
      model: 'freebuff-new',
      stream: false,
      messages: [{ role: 'user', content: ALPHA }],
    },
  })
  assert.equal(bound.statusCode, 200)

  await app.listen({ host: '127.0.0.1', port: 0 })
  const port = (app.server.address() as AddressInfo).port
  const url = `http://127.0.0.1:${port}/v1/chat/completions`
  const messages = [{ role: 'user', content: 'travaille' }]

  // Le navigateur charge le tour puis recharge la page : la connexion tombe.
  const controller = new AbortController()
  const running = fetch(url, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json', 'x-openwebui-chat-id': 'chat-detach' },
    body: JSON.stringify({ model: MODEL, stream: true, messages }),
    signal: controller.signal,
  })
  await new Promise(resolve => setTimeout(resolve, 120))
  controller.abort()
  await running.catch(() => null)
  await new Promise(resolve => setTimeout(resolve, 60))

  const reload = await fetch(url, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json', 'x-openwebui-chat-id': 'chat-detach' },
    body: JSON.stringify({ model: MODEL, stream: false, messages }),
  })
  const body = (await reload.json()) as { choices: Array<{ message: { content: string } }> }

  assert.equal(reload.status, 200)
  assert.match(body.choices[0]?.message.content ?? '', /réponse longue/)
  assert.deepEqual(sent, ['travaille'], 'le rechargement ne doit pas relancer de tour')
  assert.equal(stops, 0, 'la session ne doit pas être tuée par une déconnexion')

  await app.close()
})

test('un tour rapide n’affiche aucun indicateur', async () => {
  const text = await bindAndStream(0, 'chat-rapide')

  assert.doesNotMatch(text, /⏳/)
  assert.match(text, /réponse finale : travaille/)
  assert.equal(text.split('\n').filter(line => line.startsWith('data: ')).at(-1), 'data: [DONE]')
})
