import assert from 'node:assert/strict'
import test from 'node:test'
import { createOwuiClient, OwuiError, type OwuiChatPayload } from '../src/freebuff/owui.ts'

interface Reply {
  status?: number
  body?: unknown
}

function recorder(replies: Reply[]) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} })
    const reply = replies.shift()
    return new Response(reply?.body === undefined ? '' : JSON.stringify(reply.body), {
      status: reply?.status ?? 200,
    })
  }
  return { calls, fetchImpl }
}

const payload: OwuiChatPayload = {
  chat: { title: '[Alpha] Salut', models: ['m'], history: { messages: {}, currentId: null }, params: {}, files: [] },
  meta: { tags: ['freebuff'] },
  pinned: false,
  archived: false,
  folder_id: null,
  current_message_id: null,
  created_at: 1,
  updated_at: 2,
}

test('un dossier existant est réutilisé sans tenir compte de la casse', async () => {
  const { calls, fetchImpl } = recorder([{ body: [{ id: 'f0', name: 'System32' }] }])
  const client = createOwuiClient({ baseUrl: 'http://owui.test', apiKey: 'sk-test', fetchImpl })

  assert.equal(await client.ensureFolder('system32'), 'f0')
  assert.equal(calls.length, 1)
})

test('un dossier absent est créé', async () => {
  const { calls, fetchImpl } = recorder([
    { body: [{ id: 'f0', name: 'Autre' }] },
    { body: { id: 'f1' } },
  ])
  const client = createOwuiClient({ baseUrl: 'http://owui.test', apiKey: 'sk-test', fetchImpl })

  assert.equal(await client.ensureFolder('Freebuff · profil'), 'f1')
  assert.match(calls[1]?.url ?? '', /\/api\/v1\/folders\/$/)
  assert.equal(calls[1]?.init.method, 'POST')
  assert.equal(calls[1]?.init.body, JSON.stringify({ name: 'Freebuff · profil', data: {} }))
})

test('un import poste le chat dans /api/v1/chats/import et rend son updated_at', async () => {
  const { calls, fetchImpl } = recorder([{ body: [{ id: 'c1', updated_at: 42 }] }])
  const client = createOwuiClient({ baseUrl: 'http://owui.test/', apiKey: 'sk-test', fetchImpl })

  assert.deepEqual(await client.importChat(payload), { id: 'c1', updatedAt: 42 })
  assert.match(calls[0]?.url ?? '', /^http:\/\/owui\.test\/api\/v1\/chats\/import$/)
  assert.equal(calls[0]?.init.body, JSON.stringify({ chats: [payload] }))
  assert.equal((calls[0]?.init.headers as Record<string, string>).Authorization, 'Bearer sk-test')
})

test('la liste des chats rend titre et created_at, pour retrouver un import interrompu', async () => {
  const { calls, fetchImpl } = recorder([
    { body: [{ id: 'c1', title: '[Alpha] Salut', created_at: 10, updated_at: 20 }] },
  ])
  const client = createOwuiClient({ baseUrl: 'http://owui.test', apiKey: 'sk-test', fetchImpl })

  assert.deepEqual(await client.listChats(), [
    { id: 'c1', title: '[Alpha] Salut', createdAt: 10, updatedAt: 20 },
  ])
  // Sans `include_folders=true`, OWUI ne rend que les chats hors dossier :
  // la reprise après crash ne verrait jamais un chat importé (dans son dossier).
  assert.match(calls[0]?.url ?? '', /\/api\/v1\/chats\/\?include_folders=true&include_pinned=true$/)
})

test('la liste des dossiers porte leurs métadonnées', async () => {
  const { calls, fetchImpl } = recorder([
    { body: [{ id: 'f1', name: 'Alpha', meta: { icon: '📁', lastActivity: 42 } }] },
  ])
  const client = createOwuiClient({ baseUrl: 'http://owui.test', apiKey: 'sk-test', fetchImpl })

  assert.deepEqual(await client.listFolders(), [
    { id: 'f1', name: 'Alpha', meta: { icon: '📁', lastActivity: 42 } },
  ])
  assert.match(calls[0]?.url ?? '', /\/api\/v1\/folders\/$/)
})

test('la date d’activité d’un dossier est écrite dans ses métadonnées', async () => {
  const { calls, fetchImpl } = recorder([{ body: { id: 'f1', meta: { lastActivity: 42 } } }])
  const client = createOwuiClient({ baseUrl: 'http://owui.test', apiKey: 'sk-test', fetchImpl })

  await client.updateFolderMeta('f1', { lastActivity: 42 })

  assert.match(calls[0]?.url ?? '', /\/api\/v1\/folders\/f1\/update$/)
  assert.equal(calls[0]?.init.method, 'POST')
  assert.equal(calls[0]?.init.body, JSON.stringify({ meta: { lastActivity: 42 } }))
})

test('un chat existant peut être rangé dans un dossier', async () => {
  const { calls, fetchImpl } = recorder([{ body: { id: 'c1', folder_id: 'f1', updated_at: 7 } }])
  const client = createOwuiClient({ baseUrl: 'http://owui.test', apiKey: 'sk-test', fetchImpl })

  assert.deepEqual(await client.moveChat('c1', 'f1'), { id: 'c1', updatedAt: 7 })

  assert.match(calls[0]?.url ?? '', /\/api\/v1\/chats\/c1\/folder$/)
  assert.equal(calls[0]?.init.method, 'POST')
  assert.equal(calls[0]?.init.body, JSON.stringify({ folder_id: 'f1' }))
})

test('un refus d’authentification est une OwuiError typée', async () => {
  const { fetchImpl } = recorder([{ status: 401, body: { detail: 'Non autorisé' } }])
  const client = createOwuiClient({ baseUrl: 'http://owui.test', apiKey: 'sk-test', fetchImpl })

  await assert.rejects(
    () => client.getChat('c1'),
    (error: unknown) =>
      error instanceof OwuiError && error.status === 401 && error.body.includes('Non autorisé'),
  )
})
