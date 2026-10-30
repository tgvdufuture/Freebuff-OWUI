import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'fb-server-'))
const captureDir = path.join(dataDir, 'captures')
process.env.BRIDGE_DATA_DIR = dataDir
process.env.BRIDGE_API_KEY = 'test-key'
process.env.BRIDGE_CAPTURE_DIR = captureDir
// Profil vide : aucun `settings.json`, donc aucun modèle courant à ajouter.
process.env.BRIDGE_PROFILE_DIR = path.join(dataDir, 'profile')

writeFileSync(
  path.join(dataDir, 'models.json'),
  JSON.stringify([
    { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
    { id: 'z-ai/glm-5.3', label: 'GLM 5.3' },
  ]),
  'utf8',
)

const { buildServer } = await import('../src/server.ts')

const AUTH = { authorization: 'Bearer test-key' }

function latestCapture(): Record<string, unknown> {
  const files = readdirSync(captureDir).filter(f => f.endsWith('.json')).sort()
  const last = files.at(-1)
  assert.ok(last, 'aucune capture écrite')
  return JSON.parse(readFileSync(path.join(captureDir, last), 'utf8')) as Record<string, unknown>
}

test('sans clé, /v1/models répond 401', async () => {
  const app = buildServer()
  const response = await app.inject({ method: 'GET', url: '/v1/models' })
  assert.equal(response.statusCode, 401)
  await app.close()
})

test('/v1/models expose freebuff-new puis les modèles du fichier', async () => {
  const app = buildServer()
  const response = await app.inject({ method: 'GET', url: '/v1/models', headers: AUTH })
  assert.equal(response.statusCode, 200)
  const body = response.json() as { data: Array<{ id: string; name: string }> }
  assert.deepEqual(body.data.map(m => m.id), [
    'freebuff-new',
    'freebuff-deepseek-v4-flash',
    'freebuff-glm-5-3',
  ])
  assert.equal(body.data[0]?.name, 'Freebuff · Nouveau projet')
  await app.close()
})

test('la racine renvoie vers OpenWebUI au lieu d’un 404 muet', async () => {
  const app = buildServer()
  const response = await app.inject({ method: 'GET', url: '/' })
  assert.equal(response.statusCode, 200)
  assert.match(response.body, /8080/)
  await app.close()
})

test('/health répond sans clé', async () => {
  const app = buildServer()
  const response = await app.inject({ method: 'GET', url: '/health' })
  assert.equal(response.statusCode, 200)
  const body = response.json() as { ok: boolean; models: number }
  assert.equal(body.ok, true)
  assert.equal(body.models, 3)
  await app.close()
})

test('le mode non-stream renvoie un chat.completion et détecte le chat id absent', async () => {
  const app = buildServer()
  const response = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: AUTH,
    payload: {
      model: 'freebuff-new',
      stream: false,
      messages: [{ role: 'user', content: 'D:/code/demo' }],
    },
  })
  assert.equal(response.statusCode, 200)
  const body = response.json() as {
    object: string
    choices: Array<{ message: { content: string } }>
  }
  assert.equal(body.object, 'chat.completion')
  assert.match(body.choices[0]?.message.content ?? '', /ABSENT/)
  await app.close()
})

test('le SSE est valide, se termine par [DONE] et restitue le chat id', async () => {
  const app = buildServer()
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address() as AddressInfo

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json', 'x-openwebui-chat-id': 'chat-abc' },
    body: JSON.stringify({
      model: 'freebuff-deepseek-v4-flash',
      stream: true,
      messages: [{ role: 'user', content: 'test' }],
    }),
  })

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)

  const text = await response.text()
  const lines = text.split('\n').filter(line => line.startsWith('data: '))
  assert.ok(lines.length > 2, 'le flux doit contenir plusieurs deltas')
  assert.equal(lines.at(-1), 'data: [DONE]')

  const contents = lines
    .slice(1, -1)
    .map(line => {
      const chunk = JSON.parse(line.slice(6)) as { choices: Array<{ delta: { content?: string } }> }
      return chunk.choices[0]?.delta.content ?? ''
    })
    .join('')

  assert.match(contents, /chat-abc/)
  assert.match(contents, /<details>/)
  await app.close()
})

test('la capture masque la clé et conserve l’en-tête de chat', async () => {
  const app = buildServer()
  await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': 'chat-capture' },
    payload: {
      model: 'freebuff-deepseek-v4-flash',
      stream: false,
      messages: [{ role: 'user', content: 'bonjour' }],
    },
  })

  const captured = latestCapture()
  const headers = captured.headers as Record<string, unknown>
  const body = captured.body as Record<string, unknown>
  assert.equal(headers.authorization, '<masqué>')
  assert.equal(headers['x-openwebui-chat-id'], 'chat-capture')
  assert.equal(body.model, 'freebuff-deepseek-v4-flash')
  await app.close()
})

test('un corps de plus de 200 000 caractères est tronqué dans la capture', async () => {
  const app = buildServer()
  const content = 'x'.repeat(250_000)
  await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: AUTH,
    payload: {
      model: 'freebuff-deepseek-v4-flash',
      stream: false,
      messages: [{ role: 'user', content }],
    },
  })

  const files = readdirSync(captureDir).filter(f => f.endsWith('.json')).sort()
  const last = files.at(-1)
  assert.ok(last)
  const raw = readFileSync(path.join(captureDir, last), 'utf8')
  assert.match(raw, /tronqué à 200 000 caractères/)
  await app.close()
})
