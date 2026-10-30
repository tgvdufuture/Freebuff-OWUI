import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { AgentSession, StopResult, TurnResult } from '../src/freebuff/session.ts'

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'fb-reasoning-'))
const projectsRoot = mkdtempSync(path.join(os.tmpdir(), 'fb-reasoning-projects-'))
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
process.env.BRIDGE_API_KEY = 'test-key-reasoning'
process.env.BRIDGE_CAPTURE_DIR = path.join(dataDir, 'captures')
process.env.BRIDGE_PROJECTS_ROOT = projectsRoot
process.env.BRIDGE_PROFILE_DIR = profileDir

const { buildServer } = await import('../src/server.ts')

const AUTH = { authorization: 'Bearer test-key-reasoning' }
const ALPHA = path.join(projectsRoot, 'alpha').replace(/\\/g, '/')
const MODEL = 'freebuff-deepseek-v4-flash'

/** Réponse d'une session factice : réflexion, réponse, et émission en direct ou non. */
interface Reply {
  text: string
  reasoning: string
  live: boolean
}

class ThinkSession implements AgentSession {
  readonly pid = 7373
  readonly chatRef = 'ref-reasoning'
  readonly projectDir: string
  readonly alive = true
  private readonly reply: Reply

  constructor(projectDir: string, reply: Reply) {
    this.projectDir = projectDir
    this.reply = reply
  }

  async send(
    _prompt: string,
    onDelta: (text: string) => void,
    onReasoning: (text: string) => void = () => {},
  ): Promise<TurnResult> {
    if (this.reply.live) {
      // Deux deltas de réflexion : la concaténation doit rendre le texte entier.
      onReasoning(this.reply.reasoning.slice(0, 5))
      onReasoning(this.reply.reasoning.slice(5))
      onDelta(this.reply.text)
    }
    return {
      text: this.reply.text,
      reasoning: this.reply.reasoning,
      finish: 'ok',
      refusal: null,
    }
  }

  stop(): StopResult {
    return { ok: true, remaining: false }
  }
}

/** Lie le chat au projet puis lance un tour ; rend le corps SSE brut. */
async function streamTurn(reply: Reply, chatId: string): Promise<string> {
  const app = buildServer({ openSession: async dir => new ThinkSession(dir, reply) })

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

/** Tour en mode non-streaming, après liaison du chat. */
async function blockingTurn(
  reply: Reply,
  chatId: string,
): Promise<{ message: Record<string, unknown> }> {
  const app = buildServer({ openSession: async dir => new ThinkSession(dir, reply) })

  await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': chatId },
    payload: {
      model: 'freebuff-new',
      stream: false,
      messages: [{ role: 'user', content: ALPHA }],
    },
  })

  const turn = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': chatId },
    payload: { model: MODEL, stream: false, messages: [{ role: 'user', content: 'travaille' }] },
  })
  await app.close()

  assert.equal(turn.statusCode, 200)
  const body = turn.json() as { choices: Array<{ message: Record<string, unknown> }> }
  const message = body.choices[0]?.message
  assert.ok(message, 'aucun message dans la réponse')
  return { message }
}

type Delta = { content?: string; reasoning_content?: string }

function deltasOf(sse: string): Delta[] {
  return sse
    .split('\n')
    .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map(line => {
      const chunk = JSON.parse(line.slice(6)) as { choices: Array<{ delta: Delta }> }
      return chunk.choices[0]?.delta ?? {}
    })
}

const joined = (deltas: Delta[], key: keyof Delta): string =>
  deltas.map(delta => delta[key] ?? '').join('')

test('en streaming, la réflexion part en reasoning_content et la réponse en content', async () => {
  const sse = await streamTurn(
    { text: 'Voici la réponse.', reasoning: 'je réfléchis encore', live: true },
    'chat-reflexion-directe',
  )
  const deltas = deltasOf(sse)

  assert.equal(joined(deltas, 'reasoning_content'), 'je réfléchis encore')
  assert.equal(joined(deltas, 'content'), 'Voici la réponse.')
  assert.equal(sse.split('\n').filter(line => line.startsWith('data: ')).at(-1), 'data: [DONE]')
})

test('en streaming, une réflexion jamais émise en delta sort quand même en reasoning_content', async () => {
  const sse = await streamTurn(
    { text: 'Voici la réponse.', reasoning: 'réflexion tardive', live: false },
    'chat-reflexion-tardive',
  )
  const deltas = deltasOf(sse)
  const thoughts = deltas.filter(delta => delta.reasoning_content !== undefined)

  assert.equal(thoughts.length, 1, 'la réflexion doit partir en un seul bloc, pas en double')
  assert.equal(joined(deltas, 'reasoning_content'), 'réflexion tardive')
  assert.equal(joined(deltas, 'content'), 'Voici la réponse.')
})

test('en non-streaming, la réflexion est dans message.reasoning_content', async () => {
  const { message } = await blockingTurn(
    { text: 'Voici la réponse.', reasoning: 'je réfléchis', live: false },
    'chat-reflexion-bloc',
  )

  assert.equal(message.content, 'Voici la réponse.')
  assert.equal(message.reasoning_content, 'je réfléchis')
})

test('sans réflexion, aucun champ reasoning_content n’est inventé', async () => {
  const { message } = await blockingTurn(
    { text: 'Réponse directe.', reasoning: '', live: false },
    'chat-sans-reflexion',
  )

  assert.equal(message.content, 'Réponse directe.')
  assert.equal('reasoning_content' in message, false)
})
