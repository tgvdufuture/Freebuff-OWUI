import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { renderQuestion, type AskPanel } from '../src/freebuff/ask.ts'
import type { AgentSession, StopResult, TurnResult } from '../src/freebuff/session.ts'

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'fb-binding-http-'))
const projectsRoot = mkdtempSync(path.join(os.tmpdir(), 'fb-projects-'))
const captureDir = path.join(dataDir, 'captures')
const profileDir = path.join(dataDir, 'profile')
const settingsFile = path.join(profileDir, 'settings.json')

mkdirSync(path.join(projectsRoot, 'alpha'))
mkdirSync(path.join(projectsRoot, 'beta'))
mkdirSync(path.join(projectsRoot, 'gamma'))
mkdirSync(profileDir, { recursive: true })
writeFileSync(
  path.join(dataDir, 'models.json'),
  JSON.stringify([
    { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
    { id: 'z-ai/glm-5.3', label: 'GLM 5.3' },
  ]),
  'utf8',
)

// Faux OWUI : le pont y lit le dossier d'un chat neuf pour en déduire le
// projet. Toute autre route rend 404, donc les chats non liés des autres
// tests restent refusés comme avant.
const FOLDER_CHAT = 'chat-dossier-alpha'
const FOREIGN_CHAT = 'chat-dossier-inconnu'
const fakeOwui = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://fake').pathname
  const json = (body: unknown): void => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }
  if (pathname === `/api/v1/chats/${FOLDER_CHAT}`) {
    return json({ id: FOLDER_CHAT, folder_id: 'folder-alpha' })
  }
  if (pathname === `/api/v1/chats/${FOREIGN_CHAT}`) {
    return json({ id: FOREIGN_CHAT, folder_id: 'folder-inconnu' })
  }
  if (pathname === '/api/v1/folders/folder-alpha') {
    return json({ id: 'folder-alpha', name: 'alpha' })
  }
  if (pathname === '/api/v1/folders/folder-inconnu') {
    return json({ id: 'folder-inconnu', name: 'beta' })
  }
  response.writeHead(404, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ detail: 'not found' }))
})
await new Promise<void>(resolve => fakeOwui.listen(0, '127.0.0.1', resolve))

writeFileSync(
  path.join(dataDir, 'imports.json'),
  JSON.stringify({
    version: 1,
    folders: {},
    projectFolders: { alpha: 'folder-alpha' },
    items: {},
    pending: null,
    lastRun: null,
  }),
  'utf8',
)

process.env.BRIDGE_STUB = '0'
process.env.BRIDGE_DATA_DIR = dataDir
process.env.BRIDGE_OWUI_URL = `http://127.0.0.1:${(fakeOwui.address() as AddressInfo).port}`
process.env.BRIDGE_OWUI_KEY = 'sk-test'
process.env.BRIDGE_API_KEY = 'test-key'
process.env.BRIDGE_CAPTURE_DIR = captureDir
process.env.BRIDGE_PROJECTS_ROOT = projectsRoot
process.env.BRIDGE_PROFILE_DIR = profileDir
// Les cartes `ask_user` sont OPTIONNELLES (OpenWebUI les affiche au-dessus du
// message, donc avant le texte qui précède la question — voir
// `ask-order-http.test.ts` pour le défaut). Ce fichier couvre ce chemin-là.
process.env.BRIDGE_ASK_CARD = '1'

const { buildServer } = await import('../src/server.ts')

after(async () => {
  await new Promise<void>(resolve => fakeOwui.close(() => resolve()))
})

const AUTH = { authorization: 'Bearer test-key' }
const ALPHA = path.join(projectsRoot, 'alpha').replace(/\\/g, '/')
const BETA = path.join(projectsRoot, 'beta').replace(/\\/g, '/')
const GAMMA = path.join(projectsRoot, 'gamma').replace(/\\/g, '/')

/** Session factice : elle note le projet avec lequel elle a été ouverte. */
class FakeSession implements AgentSession {
  readonly pid = 4242
  readonly chatRef = 'ref-test'
  readonly projectDir: string
  readonly alive = true
  static opened: string[] = []
  static sent: string[] = []
  /** `--continue` demandé à l'ouverture, ou `undefined`. */
  static resumed: Array<string | undefined> = []

  constructor(projectDir: string, continueRef?: string) {
    this.projectDir = projectDir
    FakeSession.opened.push(projectDir)
    FakeSession.resumed.push(continueRef)
  }

  async send(prompt: string): Promise<TurnResult> {
    FakeSession.sent.push(prompt)
    return { text: `tour dans ${this.projectDir} : ${prompt}`, reasoning: '', finish: 'ok', refusal: null }
  }

  stop(): StopResult {
    return { ok: true, remaining: false }
  }
}

/** Session dont l'arrêt n'arrive pas à tuer le processus : un `taskkill` raté. */
class StuckSession extends FakeSession {
  override stop(): StopResult {
    return { ok: false, remaining: true }
  }
}

function makeApp(
  bindingsFile = path.join(dataDir, 'bindings.json'),
  open: (dir: string, continueRef?: string) => FakeSession = (dir, continueRef) =>
    new FakeSession(dir, continueRef),
  maxSessions?: number,
) {
  return buildServer({
    openSession: async (dir, continueRef) => open(dir, continueRef),
    bindingsFile,
    maxSessions,
  })
}

async function postThread(
  app: ReturnType<typeof makeApp>,
  chatId: string | null,
  messages: Array<{ role: string; content: string; tool_call_id?: string }>,
  model = 'freebuff-deepseek-v4-flash',
) {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: {
      ...AUTH,
      ...(chatId === null ? {} : { 'x-openwebui-chat-id': chatId }),
    },
    payload: { model, stream: false, messages },
  })
}

async function post(
  app: ReturnType<typeof makeApp>,
  chatId: string | null,
  content: string,
  model = 'freebuff-deepseek-v4-flash',
) {
  return postThread(app, chatId, [{ role: 'user', content }], model)
}

const contentOf = (body: string): string =>
  (JSON.parse(body) as { choices: Array<{ message: { content: string } }> }).choices[0]?.message
    .content ?? ''

const codeOf = (body: string): string =>
  (JSON.parse(body) as { error: { code: string } }).error.code

const readSettings = (): Record<string, unknown> =>
  JSON.parse(readFileSync(settingsFile, 'utf8')) as Record<string, unknown>

/** Chaque test du modèle part d'un settings.json absent : aucun report d'état. */
const resetSettings = (): void => rmSync(settingsFile, { force: true })

test('lier un chat avec un chemin ne démarre aucune session', async () => {
  FakeSession.opened = []
  const app = makeApp()

  const response = await post(app, 'chat-bind', ALPHA, 'freebuff-new')
  assert.equal(response.statusCode, 200)
  assert.match(contentOf(response.body), /Projet lié/)
  assert.match(contentOf(response.body), /alpha/)
  assert.deepEqual(FakeSession.opened, [])

  await app.close()
})

test('le message suivant démarre la session dans le projet lié, une seule fois', async () => {
  FakeSession.opened = []
  const app = makeApp()

  await post(app, 'chat-bind-2', ALPHA, 'freebuff-new')
  const first = await post(app, 'chat-bind-2', 'bonjour')
  const second = await postThread(app, 'chat-bind-2', [
    { role: 'user', content: 'bonjour' },
    { role: 'assistant', content: 'réponse' },
    { role: 'user', content: 'encore' },
  ])

  assert.equal(first.statusCode, 200)
  assert.equal(second.statusCode, 200)
  assert.match(contentOf(first.body), /tour dans/)
  assert.deepEqual(FakeSession.opened, [ALPHA])
  assert.match(contentOf(second.body), /encore/)

  await app.close()
})

test('un chemin invalide renvoie 400 avec les projets récents et ne lie rien', async () => {
  const app = makeApp()

  await post(app, 'chat-ok', ALPHA, 'freebuff-new')
  const response = await post(app, 'chat-ko', 'pas/un/chemin', 'freebuff-new')

  assert.equal(response.statusCode, 400)
  const body = JSON.parse(response.body) as {
    error: { code: string }
    recent: string[]
  }
  assert.equal(body.error.code, 'invalid_project_path')
  assert.deepEqual(body.recent, [ALPHA])

  // Le chat fautif n'est pas lié : un message normal est refusé.
  const after = await post(app, 'chat-ko', 'bonjour')
  assert.equal(after.statusCode, 400)

  await app.close()
})

test('un chat non lié avec un autre modèle est refusé, sans session', async () => {
  FakeSession.opened = []
  const app = makeApp()

  const response = await post(app, 'chat-libre', 'bonjour')
  assert.equal(response.statusCode, 400)
  assert.equal(
    (JSON.parse(response.body) as { error: { code: string } }).error.code,
    'chat_unbound',
  )
  assert.deepEqual(FakeSession.opened, [])

  await app.close()
})

test('un second projet ouvre sa propre session, sans fermer la première', async () => {
  FakeSession.opened = []
  const app = makeApp()

  await post(app, 'chat-a', ALPHA, 'freebuff-new')
  await post(app, 'chat-a', 'travaille')
  await post(app, 'chat-b', BETA, 'freebuff-new')

  const response = await post(app, 'chat-b', 'travaille aussi')
  assert.equal(response.statusCode, 200)
  assert.match(contentOf(response.body), /travaille aussi/)
  assert.match(contentOf(response.body), /beta/, 'le second projet a sa propre session')
  // Mesuré en S12 : deux processus Freebuff coexistent sur le même profil.
  assert.deepEqual(FakeSession.opened, [ALPHA, BETA])

  await app.close()
})

test('deux chats sur deux projets répondent en même temps', async () => {
  const release: { resolve: () => void } = { resolve: () => {} }
  const gate = new Promise<void>(resolve => {
    release.resolve = resolve
  })

  /** La session du projet alpha ne finit son tour que quand le test le décide. */
  class GatedSession extends FakeSession {
    override async send(prompt: string): Promise<TurnResult> {
      FakeSession.sent.push(prompt)
      if (this.projectDir === ALPHA) await gate
      return {
        text: `tour dans ${this.projectDir} : ${prompt}`,
        reasoning: '',
        finish: 'ok',
        refusal: null,
      }
    }
  }

  FakeSession.sent = []
  const app = makeApp(path.join(dataDir, 'bindings-parallel.json'), dir => new GatedSession(dir))
  await post(app, 'chat-par-a', ALPHA, 'freebuff-new')
  await post(app, 'chat-par-b', BETA, 'freebuff-new')

  const slow = post(app, 'chat-par-a', 'long')
  await new Promise(resolve => setTimeout(resolve, 50))

  // beta doit répondre ALORS QUE alpha est encore bloquée dans son tour.
  let timer: ReturnType<typeof setTimeout> | undefined
  const tooLate = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('le chat beta a attendu le chat alpha')), 2_000)
    timer.unref()
  })
  const fast = await Promise.race([post(app, 'chat-par-b', 'court'), tooLate])
  clearTimeout(timer)

  assert.equal(fast.statusCode, 200)
  assert.match(contentOf(fast.body), /court/)

  release.resolve()
  const done = await slow
  assert.equal(done.statusCode, 200)
  assert.match(contentOf(done.body), /long/)
  assert.deepEqual(FakeSession.sent, ['long', 'court'])

  await app.close()
})

test('au-delà de la limite, un troisième projet reçoit 429 sans perdre les sessions ouvertes', async () => {
  FakeSession.opened = []
  const app = makeApp(path.join(dataDir, 'bindings-limit.json'), undefined, 2)

  await post(app, 'chat-lim-a', ALPHA, 'freebuff-new')
  await post(app, 'chat-lim-b', BETA, 'freebuff-new')
  await post(app, 'chat-lim-c', GAMMA, 'freebuff-new')

  const [a, b, c] = [
    await post(app, 'chat-lim-a', 'un'),
    await post(app, 'chat-lim-b', 'deux'),
    await post(app, 'chat-lim-c', 'trois'),
  ]

  assert.deepEqual([a.statusCode, b.statusCode], [200, 200])
  assert.equal(c.statusCode, 429)
  assert.equal(codeOf(c.body), 'too_many_sessions')
  // Les deux sessions vivantes continuent de répondre.
  const encore = await post(app, 'chat-lim-a', 'encore')
  assert.equal(encore.statusCode, 200)
  assert.deepEqual(FakeSession.opened, [ALPHA, BETA])

  await app.close()
})

/** Deux conversations CLI déjà faites, pour le projet alpha. */
function seedHistory(): void {
  const chats = path.join(profileDir, 'projects', 'alpha', 'chats')
  const older = path.join(chats, '2026-10-22T10-00-00.000Z')
  const newer = path.join(chats, '2026-10-22T11-00-00.000Z')
  mkdirSync(older, { recursive: true })
  mkdirSync(newer, { recursive: true })
  writeFileSync(
    path.join(older, 'chat-meta.json'),
    JSON.stringify({ firstPrompt: 'Consigne ancienne', messageCount: 2, messagesMtimeMs: 1_000 }),
    'utf8',
  )
  writeFileSync(
    path.join(older, 'chat-messages.json'),
    JSON.stringify([{ variant: 'user', content: 'Consigne ancienne', timestamp: '10:00' }]),
    'utf8',
  )
  writeFileSync(
    path.join(newer, 'chat-meta.json'),
    JSON.stringify({ firstPrompt: 'Consigne récente', messageCount: 4, messagesMtimeMs: 2_000 }),
    'utf8',
  )
  writeFileSync(
    path.join(newer, 'chat-messages.json'),
    JSON.stringify([
      { variant: 'user', content: 'Consigne récente', timestamp: '11:00' },
      {
        variant: 'ai',
        content: '',
        timestamp: '11:01',
        blocks: [
          { type: 'text', content: 'réflexion privée', textType: 'reasoning' },
          { type: 'text', content: 'Réponse récente', textType: 'text' },
        ],
      },
    ]),
    'utf8',
  )
  // Dates de fichier imposées : `/recover` choisit la conversation écrite en
  // dernier, pas l'ordre de création des dossiers.
  const olderFile = path.join(older, 'chat-messages.json')
  const newerFile = path.join(newer, 'chat-messages.json')
  const olderAt = new Date('2026-10-22T10:00:00Z')
  const newerAt = new Date('2026-10-22T11:00:00Z')
  utimesSync(olderFile, olderAt, olderAt)
  utimesSync(newerFile, newerAt, newerAt)
}

test('/import liste les conversations du projet sans lancer la CLI', async () => {
  seedHistory()
  FakeSession.opened = []
  FakeSession.resumed = []
  const app = makeApp(path.join(dataDir, 'bindings-import-list.json'))

  await post(app, 'chat-import-list', ALPHA, 'freebuff-new')
  const response = await post(app, 'chat-import-list', '/import')

  assert.equal(response.statusCode, 200)
  const content = contentOf(response.body)
  assert.match(content, /Conversations Freebuff de/)
  assert.match(content, /Consigne récente/)
  assert.match(content, /Consigne ancienne/)
  assert.ok(content.indexOf('Consigne récente') < content.indexOf('Consigne ancienne'))
  assert.deepEqual(FakeSession.opened, [], 'aucune session ouverte')

  await app.close()
})

test('/import <n> affiche le transcript sans réflexion et retient la reprise', async () => {
  seedHistory()
  FakeSession.opened = []
  FakeSession.resumed = []
  const bindingsFile = path.join(dataDir, 'bindings-import-show.json')
  const app = makeApp(bindingsFile)

  await post(app, 'chat-import-show', ALPHA, 'freebuff-new')
  const response = await post(app, 'chat-import-show', '/import 1')

  assert.equal(response.statusCode, 200)
  const content = contentOf(response.body)
  assert.match(content, /Consigne récente/)
  assert.match(content, /Réponse récente/)
  assert.doesNotMatch(content, /réflexion privée/)
  assert.match(content, /prochain message REPREND/)
  assert.match(content, /reprise activée/)
  // Le fil est replié : sinon il occupe tout le message, sans bulles pour moi.
  assert.match(content, /<details>[\s\S]*Consigne récente[\s\S]*<\/details>/)
  assert.doesNotMatch(content.slice(0, content.indexOf('<details>')), /Consigne récente/)
  assert.deepEqual(FakeSession.opened, [], 'afficher ne consomme aucun tour')

  const stored = JSON.parse(readFileSync(bindingsFile, 'utf8')) as Record<
    string,
    { resumeRef: string | null }
  >
  assert.equal(stored['chat-import-show']?.resumeRef, '2026-10-22T11-00-00.000Z')

  await app.close()
})

test('le message suivant reprend la conversation choisie (--continue)', async () => {
  seedHistory()
  FakeSession.opened = []
  FakeSession.resumed = []
  const bindingsFile = path.join(dataDir, 'bindings-import-resume.json')
  const app = makeApp(bindingsFile)

  await post(app, 'chat-import-resume', ALPHA, 'freebuff-new')
  await post(app, 'chat-import-resume', '/import 1')
  const turn = await postThread(app, 'chat-import-resume', [
    { role: 'user', content: '/import 1' },
    { role: 'assistant', content: '_(historique affiché)_' },
    { role: 'user', content: 'continue' },
  ])

  assert.equal(turn.statusCode, 200)
  assert.deepEqual(FakeSession.opened, [ALPHA])
  assert.deepEqual(FakeSession.resumed, ['2026-10-22T11-00-00.000Z']);

  const stored = JSON.parse(readFileSync(bindingsFile, 'utf8')) as Record<
    string,
    { resumeRef: string | null }
  >
  assert.equal(stored['chat-import-resume']?.resumeRef, null, 'la reprise est consommée')

  await app.close()
})

test('/import avec un numéro inconnu ne lance rien et le dit', async () => {
  seedHistory()
  FakeSession.opened = []
  FakeSession.resumed = []
  const app = makeApp(path.join(dataDir, 'bindings-import-unknown.json'))

  await post(app, 'chat-import-unknown', ALPHA, 'freebuff-new')
  const response = await post(app, 'chat-import-unknown', '/import 9')

  assert.equal(response.statusCode, 200)
  assert.match(contentOf(response.body), /Conversation inconnue/)
  assert.deepEqual(FakeSession.opened, [])

  await app.close()
})

test('/recover rend la dernière réponse du projet sans lancer la CLI', async () => {
  seedHistory()
  FakeSession.opened = []
  FakeSession.resumed = []
  FakeSession.sent = []
  const app = makeApp(path.join(dataDir, 'bindings-recover.json'))

  await post(app, 'chat-recover', ALPHA, 'freebuff-new')
  const response = await post(app, 'chat-recover', '/recover')

  assert.equal(response.statusCode, 200)
  const content = contentOf(response.body)
  assert.match(content, /Récupéré depuis Freebuff/)
  assert.match(content, /2026-10-22T11-00-00\.000Z/, 'la conversation choisie est nommée')
  // La réponse finale, pas le raisonnement qui la précède.
  assert.match(content, /### Réponse\n\nRéponse récente/)
  assert.doesNotMatch(content, /réflexion privée/)
  assert.match(content, /aucun tour consommé/)
  assert.deepEqual(FakeSession.opened, [], 'aucune CLI lancée')
  assert.deepEqual(FakeSession.sent, [], 'la commande ne part pas à la CLI')

  await app.close()
})

test('/recover d’un tour coupé rend le raisonnement et le motif', async () => {
  seedHistory()
  const newer = path.join(profileDir, 'projects', 'alpha', 'chats', '2026-10-22T11-00-00.000Z')
  writeFileSync(
    path.join(newer, 'chat-messages.json'),
    JSON.stringify([
      { variant: 'user', content: 'Consigne récente', timestamp: '11:00' },
      {
        variant: 'ai',
        content: '',
        timestamp: '11:01',
        blocks: [{ type: 'text', content: 'raisonnement final', textType: 'reasoning' }],
      },
    ]),
    'utf8',
  )
  writeFileSync(
    path.join(newer, 'run-state.json'),
    JSON.stringify({ output: { type: 'error', message: 'The session ended before this response completed.' } }),
    'utf8',
  )
  FakeSession.opened = []
  const app = makeApp(path.join(dataDir, 'bindings-recover-cut.json'))

  await post(app, 'chat-recover-cut', ALPHA, 'freebuff-new')
  const response = await post(app, 'chat-recover-cut', '/recover')

  assert.equal(response.statusCode, 200)
  const content = contentOf(response.body)
  assert.match(content, /Tour coupé : The session ended before this response completed\./)
  assert.match(content, /### Raisonnement\n\nraisonnement final/)
  assert.doesNotMatch(content, /### Réponse/, 'aucune réponse finale écrite')
  assert.deepEqual(FakeSession.opened, [])

  rmSync(path.join(newer, 'run-state.json'), { force: true })
  await app.close()
})

test('/recover <ref> lit la conversation demandée, et un projet vide le dit', async () => {
  seedHistory()
  const app = makeApp(path.join(dataDir, 'bindings-recover-ref.json'))

  await post(app, 'chat-recover-ref', ALPHA, 'freebuff-new')
  const chosen = await post(app, 'chat-recover-ref', '/recover 2026-10-22T10-00-00.000Z')
  assert.equal(chosen.statusCode, 200)
  assert.match(
    contentOf(chosen.body),
    /Aucun texte d'agent dans la conversation `2026-10-22T10-00-00\.000Z`/,
  )

  await post(app, 'chat-recover-vide', BETA, 'freebuff-new')
  const empty = await post(app, 'chat-recover-vide', '/recover')
  assert.equal(empty.statusCode, 200)
  assert.match(contentOf(empty.body), /Aucune conversation Freebuff enregistrée/)

  await app.close()
})

test('/recover saute une conversation vide et rend celle d’avant', async () => {
  seedHistory()
  const chats = path.join(profileDir, 'projects', 'alpha', 'chats')
  const older = path.join(chats, '2026-10-22T10-00-00.000Z')
  const newer = path.join(chats, '2026-10-22T11-00-00.000Z')
  writeFileSync(
    path.join(older, 'chat-messages.json'),
    JSON.stringify([
      { variant: 'user', content: 'Consigne ancienne', timestamp: '10:00' },
      {
        variant: 'ai',
        content: '',
        timestamp: '10:01',
        blocks: [{ type: 'text', content: 'Réponse ancienne', textType: 'text' }],
      },
    ]),
    'utf8',
  )
  // La plus récente : dossier d'une CLI relancée, aucun texte d'agent.
  writeFileSync(
    path.join(newer, 'chat-messages.json'),
    JSON.stringify([{ variant: 'user', content: 'relance', timestamp: '11:02' }]),
    'utf8',
  )
  utimesSync(path.join(older, 'chat-messages.json'), new Date('2026-10-22T10:00:00Z'), new Date('2026-10-22T10:00:00Z'))
  utimesSync(path.join(newer, 'chat-messages.json'), new Date('2026-10-22T12:00:00Z'), new Date('2026-10-22T12:00:00Z'))

  const app = makeApp(path.join(dataDir, 'bindings-recover-empty.json'))
  await post(app, 'chat-recover-vide-recente', ALPHA, 'freebuff-new')
  const response = await post(app, 'chat-recover-vide-recente', '/recover')

  assert.equal(response.statusCode, 200)
  const content = contentOf(response.body)
  assert.match(content, /conversation `2026-10-22T10-00-00\.000Z`/, 'la conversation d’avant')
  assert.match(content, /Réponse ancienne/)
  assert.doesNotMatch(content, /2026-10-22T11-00-00\.000Z/)

  // Un ref explicite reste respecté, même vide : on ne devine pas à sa place.
  const emptyExplicit = await post(app, 'chat-recover-vide-recente', '/recover 2026-10-22T11-00-00.000Z')
  assert.equal(emptyExplicit.statusCode, 200)
  assert.match(contentOf(emptyExplicit.body), /Aucun texte d'agent dans la conversation/)

  const chosen = await post(app, 'chat-recover-vide-recente', '/recover 2026-10-22T10-00-00.000Z')
  assert.equal(chosen.statusCode, 200)
  assert.match(contentOf(chosen.body), /Réponse ancienne/)

  await app.close()
})

test('/recover lit la conversation de CE chat, pas celle d’un autre chat du projet', async () => {
  seedHistory()
  const chats = path.join(profileDir, 'projects', 'alpha', 'chats')
  const write = (ref: string, answer: string, at: string): void => {
    const dir = path.join(chats, ref)
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'chat-messages.json')
    writeFileSync(
      file,
      JSON.stringify([
        {
          variant: 'ai',
          content: '',
          timestamp: '09:00',
          blocks: [{ type: 'text', content: answer, textType: 'text' }],
        },
      ]),
      'utf8',
    )
    utimesSync(file, new Date(at), new Date(at))
  }
  // La conversation de ce chat, plus ancienne que celle d'un autre chat.
  write('ref-test', 'Réponse de mon chat', '2026-10-22T09:00:00Z') // FakeSession.chatRef
  write('ref-autre', 'Réponse d’un autre chat', '2026-10-22T13:00:00Z')

  const bindingsFile = path.join(dataDir, 'bindings-recover-suivi.json')
  const app = makeApp(bindingsFile)
  await post(app, 'chat-recover-suivi', ALPHA, 'freebuff-new')
  const turn = await post(app, 'chat-recover-suivi', 'bonjour')
  assert.equal(turn.statusCode, 200)

  // Le tour a noté la conversation CLI utilisée par ce chat.
  const stored = JSON.parse(readFileSync(bindingsFile, 'utf8')) as Record<
    string,
    { chatRefs?: string[] }
  >
  assert.deepEqual(stored['chat-recover-suivi']?.chatRefs, ['ref-test'])

  const response = await post(app, 'chat-recover-suivi', '/recover')
  assert.equal(response.statusCode, 200)
  const content = contentOf(response.body)
  assert.match(content, /conversation `ref-test`/)
  assert.match(content, /Réponse de mon chat/)
  assert.doesNotMatch(content, /Réponse d’un autre chat/)

  await app.close()
  resetSettings()
})

test('le sélecteur peut lire le dossier d’un chat et le modifier', async () => {
  const app = makeApp(path.join(dataDir, 'bindings-picker.json'))

  const before = await app.inject({ method: 'GET', url: '/api/bind?chatId=chat-picker' })
  assert.equal(before.statusCode, 404)

  const bound = await app.inject({
    method: 'POST',
    url: '/api/bind',
    payload: { chatId: 'chat-picker', projectPath: ALPHA },
  })
  assert.equal(bound.statusCode, 200)

  const read = await app.inject({ method: 'GET', url: '/api/bind?chatId=chat-picker' })
  assert.equal(read.statusCode, 200)
  assert.deepEqual(JSON.parse(read.body), { chatId: 'chat-picker', projectPath: ALPHA })

  // Modifier le dossier d'un chat existant réutilise le même binding.
  const changed = await app.inject({
    method: 'POST',
    url: '/api/bind',
    payload: { chatId: 'chat-picker', projectPath: BETA },
  })
  assert.equal(changed.statusCode, 200)
  const after = await app.inject({ method: 'GET', url: '/api/bind?chatId=chat-picker' })
  assert.equal((JSON.parse(after.body) as { projectPath: string }).projectPath, BETA)

  await app.close()
})

test('sans en-tête de chat, le pont refuse de deviner le projet', async () => {
  const app = makeApp()

  const response = await post(app, null, ALPHA, 'freebuff-new')
  assert.equal(response.statusCode, 400)
  assert.equal((JSON.parse(response.body) as { error: { code: string } }).error.code, 'no_chat_id')

  await app.close()
})

test('un tour écrit le modèle choisi dans settings.json avant de lancer la session', async () => {
  resetSettings()
  FakeSession.opened = []
  const app = makeApp()

  await post(app, 'chat-modele', ALPHA, 'freebuff-new')
  const response = await post(app, 'chat-modele', 'travaille', 'freebuff-glm-5-3')

  assert.equal(response.statusCode, 200)
  assert.equal(readSettings().freebuffModel, 'z-ai/glm-5.3')
  assert.deepEqual(FakeSession.opened, [ALPHA])

  await app.close()
  resetSettings()
})

test('un settings.json illisible renvoie 400 sans session ni réécriture', async () => {
  const original = '{ pas du json'
  writeFileSync(settingsFile, original, 'utf8')
  FakeSession.opened = []
  const app = makeApp()

  await post(app, 'chat-settings-ko', ALPHA, 'freebuff-new')
  const response = await post(app, 'chat-settings-ko', 'travaille')

  assert.equal(response.statusCode, 400)
  assert.equal(codeOf(response.body), 'settings_unreadable')
  assert.equal(readFileSync(settingsFile, 'utf8'), original)
  assert.deepEqual(FakeSession.opened, [])

  await app.close()
  resetSettings()
})

test('un modèle inconnu sur un chat lié est refusé sans écrire settings.json', async () => {
  resetSettings()
  FakeSession.opened = []
  const app = makeApp()

  await post(app, 'chat-inconnu', ALPHA, 'freebuff-new')
  const response = await post(app, 'chat-inconnu', 'travaille', 'freebuff-pas-dans-la-liste')

  assert.equal(response.statusCode, 400)
  assert.equal(codeOf(response.body), 'unknown_model')
  assert.equal(existsSync(settingsFile), false)
  assert.deepEqual(FakeSession.opened, [])

  await app.close()
})

test('changer de modèle sur une session au repos la relance avec le nouveau modèle', async () => {
  resetSettings()
  FakeSession.opened = []
  FakeSession.sent = []
  const app = makeApp()

  await post(app, 'chat-bascule', ALPHA, 'freebuff-new')
  const first = await post(app, 'chat-bascule', 'travaille')
  const second = await postThread(
    app,
    'chat-bascule',
    [
      { role: 'user', content: 'travaille' },
      { role: 'assistant', content: 'réponse' },
      { role: 'user', content: 'autre modèle' },
    ],
    'freebuff-glm-5-3',
  )

  assert.equal(first.statusCode, 200)
  assert.equal(second.statusCode, 200)
  assert.match(contentOf(second.body), /autre modèle/)
  assert.equal(readSettings().freebuffModel, 'z-ai/glm-5.3')
  // Une seule session à la fois : l'ancienne a été fermée avant la nouvelle.
  assert.deepEqual(FakeSession.opened, [ALPHA, ALPHA])

  await app.close()
  resetSettings()
})

test('une bascule qui ne tue pas l’ancienne session renvoie 503 session_stuck', async () => {
  resetSettings()
  FakeSession.opened = []
  const app = makeApp(undefined, dir => new StuckSession(dir))

  await post(app, 'chat-stuck', ALPHA, 'freebuff-new')
  await post(app, 'chat-stuck', 'travaille')
  const second = await postThread(
    app,
    'chat-stuck',
    [
      { role: 'user', content: 'travaille' },
      { role: 'assistant', content: 'réponse' },
      { role: 'user', content: 'autre modèle' },
    ],
    'freebuff-glm-5-3',
  )

  assert.equal(second.statusCode, 503)
  assert.equal(codeOf(second.body), 'session_stuck')
  assert.equal(readSettings().freebuffModel, 'deepseek/deepseek-v4-flash')
  assert.deepEqual(FakeSession.opened, [ALPHA])

  await app.close()
  resetSettings()
})

test('le deuxième message accepte l’historique complet du fil', async () => {
  FakeSession.opened = []
  FakeSession.sent = []
  const app = makeApp()

  await post(app, 'chat-fil', ALPHA, 'freebuff-new')
  const first = await postThread(app, 'chat-fil', [{ role: 'user', content: 'bonjour' }])
  const second = await postThread(app, 'chat-fil', [
    { role: 'user', content: 'bonjour' },
    { role: 'assistant', content: 'salut' },
    { role: 'user', content: 'continue' },
  ])

  assert.equal(first.statusCode, 200)
  assert.equal(second.statusCode, 200)
  assert.deepEqual(FakeSession.sent, ['bonjour', 'continue'])

  await app.close()
  resetSettings()
})

test('rejouer la même liste rend la réponse déjà produite, sans second tour', async () => {
  FakeSession.sent = []
  const app = makeApp()
  const messages = [{ role: 'user', content: 'bonjour' }]

  await post(app, 'chat-regen', ALPHA, 'freebuff-new')
  const first = await postThread(app, 'chat-regen', messages)
  const second = await postThread(app, 'chat-regen', messages)

  assert.equal(first.statusCode, 200)
  assert.equal(second.statusCode, 200)
  assert.equal(contentOf(second.body), contentOf(first.body))
  assert.deepEqual(FakeSession.sent, ['bonjour'])

  await app.close()
  resetSettings()
})

test('une page rechargée pendant le tour attend ce tour au lieu d’en lancer un autre', async () => {
  const release: { resolve: () => void } = { resolve: () => {} }
  const gate = new Promise<void>(resolve => {
    release.resolve = resolve
  })

  /** Session dont le tour ne se termine que quand le test le décide. */
  class SlowSession extends FakeSession {
    override async send(prompt: string): Promise<TurnResult> {
      FakeSession.sent.push(prompt)
      await gate
      return { text: `réponse lente : ${prompt}`, reasoning: '', finish: 'ok', refusal: null }
    }
  }

  FakeSession.sent = []
  const app = makeApp(path.join(dataDir, 'bindings-reload.json'), dir => new SlowSession(dir))
  const messages = [{ role: 'user', content: 'travaille' }]

  await post(app, 'chat-reload', ALPHA, 'freebuff-new')
  // Le premier envoi est laissé en vol : c'est le rechargement de la page.
  const firstRun = postThread(app, 'chat-reload', messages)
  await new Promise(resolve => setTimeout(resolve, 50))

  const reload = postThread(app, 'chat-reload', messages)
  release.resolve()
  const [first, second] = await Promise.all([firstRun, reload])

  assert.equal(first.statusCode, 200)
  assert.equal(second.statusCode, 200)
  assert.equal(contentOf(second.body), contentOf(first.body))
  assert.deepEqual(FakeSession.sent, ['travaille'])

  await app.close()
  resetSettings()
})

test('l’agent pose une question : OpenWebUI reçoit les options, puis la réponse repart au fil', async () => {
  /** Session qui pose une question au premier tour, puis continue après réponse. */
  class QuestionSession extends FakeSession {
    override async send(prompt: string): Promise<TurnResult> {
      FakeSession.sent.push(prompt)
      if (FakeSession.sent.length === 1) {
        return {
          text: "**Question de l'agent** : Quel contenu ?\n\n1. **bonjour**\n2. **au revoir**",
          reasoning: '',
          finish: 'question',
          refusal: null,
        }
      }
      return { text: `suite du tour : ${prompt}`, reasoning: '', finish: 'ok', refusal: null }
    }
  }

  FakeSession.sent = []
  const app = makeApp(path.join(dataDir, 'bindings-question.json'), dir => new QuestionSession(dir))

  await post(app, 'chat-question', ALPHA, 'freebuff-new')
  const asked = await post(app, 'chat-question', 'travaille')

  assert.equal(asked.statusCode, 200)
  assert.match(contentOf(asked.body), /Quel contenu \?/)
  assert.match(contentOf(asked.body), /1\. \*\*bonjour\*\*/)

  // Réponse de l'utilisateur : elle prolonge le fil (pas de refus) et part à la
  // session, qui la transforme en touches dans la TUI.
  const answered = await postThread(app, 'chat-question', [
    { role: 'user', content: 'travaille' },
    { role: 'assistant', content: contentOf(asked.body) },
    { role: 'user', content: '2' },
  ])

  assert.equal(answered.statusCode, 200)
  assert.match(contentOf(answered.body), /suite du tour : 2/)
  assert.deepEqual(FakeSession.sent, ['travaille', '2'])

  await app.close()
  resetSettings()
})

test('une question avec options part en carte ask_user quand le client l’annonce', async () => {
  /** Session qui pose une question à choix multiple au premier tour. */
  class PanelSession extends FakeSession {
    override async send(prompt: string): Promise<TurnResult> {
      FakeSession.sent.push(prompt)
      if (FakeSession.sent.length === 1) {
        return {
          text: 'Question texte (repli)',
          reasoning: '',
          finish: 'question',
          refusal: null,
          panel: {
            question: 'Quel contenu ?',
            options: [
              { label: 'bonjour', description: 'Le fichier contiendra « bonjour »' },
              { label: 'au revoir', description: null },
            ],
            complex: false,
          },
        }
      }
      return { text: `suite du tour : ${prompt}`, reasoning: '', finish: 'ok', refusal: null }
    }
  }

  FakeSession.sent = []
  const app = makeApp(path.join(dataDir, 'bindings-panel.json'), dir => new PanelSession(dir))
  await post(app, 'chat-panel', ALPHA, 'freebuff-new')

  const asked = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': 'chat-panel' },
    payload: {
      model: 'freebuff-deepseek-v4-flash',
      stream: true,
      messages: [{ role: 'user', content: 'travaille' }],
      tools: [{ type: 'function', function: { name: 'ask_user' } }],
    },
  })

  assert.equal(asked.statusCode, 200)
  assert.match(asked.body, /"name":"ask_user"/)
  assert.match(asked.body, /"finish_reason":"tool_calls"/)
  assert.match(asked.body, /Quel contenu \?/)
  assert.match(asked.body, /Le fichier contiendra « bonjour »/)
  assert.doesNotMatch(asked.body, /Question texte \(repli\)/, 'la carte remplace le texte')

  await app.close()
  resetSettings()
})

test('le texte écrit avant la question accompagne la carte, une seule fois', async () => {
  /** Session qui écrit un constat puis pose une question (cas réel du 23/10). */
  class PreambleSession extends FakeSession {
    override async send(): Promise<TurnResult> {
      return {
        text: 'Je vérifie d’abord deux choses.\n\nQuestion texte (repli)',
        head: 'Je vérifie d’abord deux choses.',
        reasoning: '',
        finish: 'question',
        refusal: null,
        panel: {
          question: 'Quel contenu ?',
          options: [
            { label: 'bonjour', description: null },
            { label: 'au revoir', description: null },
          ],
          complex: false,
        },
      }
    }
  }

  const app = makeApp(path.join(dataDir, 'bindings-preamble.json'), dir => new PreambleSession(dir))
  await post(app, 'chat-preamble', ALPHA, 'freebuff-new')
  const payload = {
    model: 'freebuff-deepseek-v4-flash',
    messages: [{ role: 'user', content: 'travaille' }],
    tools: [{ type: 'function', function: { name: 'ask_user' } }],
  }

  const streamed = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': 'chat-preamble' },
    payload: { ...payload, stream: true },
  })

  assert.equal(streamed.statusCode, 200)
  assert.match(streamed.body, /Je vérifie d’abord deux choses\./)
  assert.match(streamed.body, /"name":"ask_user"/)
  // Le préambule ne part qu'une fois, même s'il était déjà dans le pas-à-pas.
  assert.equal(streamed.body.split('Je vérifie d’abord deux choses.').length - 1, 1)

  // Sans flux, il est dans le contenu du message porteur de la carte.
  await post(app, 'chat-preamble-plain', ALPHA, 'freebuff-new')
  const plain = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': 'chat-preamble-plain' },
    payload: { ...payload, stream: false },
  })
  const body = JSON.parse(plain.body) as {
    choices: Array<{ message: { content: string; tool_calls?: unknown[] } }>
  }
  assert.match(body.choices[0]?.message.content ?? '', /Je vérifie d’abord deux choses\./)
  assert.ok((body.choices[0]?.message.tool_calls ?? []).length > 0)

  await app.close()
  resetSettings()
})

test('cinq options : la carte se pagine et ne presse rien avant un vrai choix', async () => {
  const labels = ['Corriger un bug', 'Ajouter une fonctionnalité', 'Refactorer / nettoyer', 'Expliquer le code', 'Custom']

  class FiveSession extends FakeSession {
    override async send(prompt: string): Promise<TurnResult> {
      FakeSession.sent.push(prompt)
      if (FakeSession.sent.length === 1) {
        return {
          text: '',
          reasoning: '',
          finish: 'question',
          refusal: null,
          panel: {
            question: 'Sur quoi veux-tu travailler ?',
            options: labels.map(label => ({ label, description: null })),
            complex: false,
          },
        }
      }
      return { text: `suite du tour : ${prompt}`, reasoning: '', finish: 'ok', refusal: null }
    }
  }

  FakeSession.sent = []
  const app = makeApp(path.join(dataDir, 'bindings-five.json'), dir => new FiveSession(dir))
  await post(app, 'chat-five', ALPHA, 'freebuff-new')

  const ask = (messages: Array<Record<string, unknown>>) =>
    app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { ...AUTH, 'x-openwebui-chat-id': 'chat-five' },
      payload: {
        model: 'freebuff-deepseek-v4-flash',
        stream: true,
        messages,
        tools: [{ type: 'function', function: { name: 'ask_user' } }],
      },
    })

  const first = await ask([{ role: 'user', content: 'travaille' }])
  assert.match(first.body, /Corriger un bug/)
  assert.match(first.body, /Ajouter une fonctionnalité/)
  assert.match(first.body, /Autres options/)
  assert.doesNotMatch(first.body, /Refactorer/, 'la suite est sur la page suivante')
  assert.doesNotMatch(first.body, /"Custom"/, 'la saisie libre est celle d’OpenWebUI')

  const more = await ask([
    { role: 'user', content: 'travaille' },
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: JSON.stringify({
        status: 'answered',
        answers: { 'freebuff-q1-s0': { type: 'option', option_index: 2, label: '▸ Autres options…' } },
      }),
    },
  ])

  assert.match(more.body, /Refactorer \/ nettoyer/)
  assert.match(more.body, /Expliquer le code/)
  assert.doesNotMatch(more.body, /"Custom"/, 'Custom ne revient sur aucune page')
  assert.deepEqual(FakeSession.sent, ['travaille'], 'paginer ne relance aucun tour')

  const chosen = await ask([
    { role: 'user', content: 'travaille' },
    {
      role: 'tool',
      tool_call_id: 'call_2',
      content: JSON.stringify({
        status: 'answered',
        answers: { 'freebuff-q1-s1': { type: 'option', option_index: 2, label: 'Expliquer le code' } },
      }),
    },
  ])

  assert.match(chosen.body, /suite du tour : Expliquer le code/)
  assert.deepEqual(FakeSession.sent, ['travaille', 'Expliquer le code'])

  await app.close()
  resetSettings()
})

test('une question à cases cochées part en carte si elle tient en trois options', async () => {
  const panel: AskPanel = {
    question: 'Que souhaitez-vous traiter ?',
    options: [
      { label: 'tests', description: null },
      { label: 'documentation', description: null },
      { label: 'performance', description: null },
      { label: 'Custom', description: null },
    ],
    complex: false,
    multi: true,
  }

  class MultiSession extends FakeSession {
    override async send(prompt: string): Promise<TurnResult> {
      FakeSession.sent.push(prompt)
      if (FakeSession.sent.length === 1) {
        return {
          text: renderQuestion(panel),
          reasoning: '',
          finish: 'question',
          refusal: null,
          panel,
        }
      }
      return { text: `suite du tour : ${prompt}`, reasoning: '', finish: 'ok', refusal: null }
    }
  }

  FakeSession.sent = []
  const app = makeApp(path.join(dataDir, 'bindings-multi.json'), dir => new MultiSession(dir))
  await post(app, 'chat-multi', ALPHA, 'freebuff-new')

  const asked = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': 'chat-multi' },
    payload: {
      model: 'freebuff-deepseek-v4-flash',
      stream: false,
      messages: [{ role: 'user', content: 'travaille' }],
      tools: [{ type: 'function', function: { name: 'ask_user' } }],
    },
  })

  // La carte locale patchée coche plusieurs cases : la question part en tool call.
  assert.equal(asked.statusCode, 200)
  const card = JSON.parse(asked.body)
  const call = card.choices[0].message.tool_calls[0]
  assert.equal(call.function.name, 'ask_user')
  const args = JSON.parse(call.function.arguments)
  assert.equal(args.questions[0].multi_select, true)
  assert.equal(args.questions[0].allow_other, false)
  assert.deepEqual(
    args.questions[0].options.map((option: { label: string }) => option.label),
    ['tests', 'documentation', 'performance'],
  )
  assert.equal(args.questions[0].options.some((option: { label: string }) => option.label === 'Custom'), false)

  const answered = await postThread(app, 'chat-multi', [
    { role: 'user', content: 'travaille' },
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: JSON.stringify({
        status: 'answered',
        answers: {
          'freebuff-q1-multi': { type: 'options', option_indices: [0, 2], labels: ['tests', 'performance'] },
        },
      }),
    },
  ])

  assert.equal(answered.statusCode, 200)
  // Les libellés voyagent tels quels : la session les transforme en cases à cocher.
  assert.deepEqual(FakeSession.sent, ['travaille', '["tests","performance"]'])

  await app.close()
  resetSettings()
})

test('quatre cases à cocher tiennent dans une carte : le plafond de trois est levé', async () => {
  const panel: AskPanel = {
    question: 'Quels dossiers ?',
    options: [
      { label: 'src', description: null },
      { label: 'test', description: null },
      { label: 'scripts', description: null },
      { label: 'docs', description: null },
    ],
    complex: false,
    multi: true,
  }

  class FourSession extends FakeSession {
    override async send(prompt: string): Promise<TurnResult> {
      FakeSession.sent.push(prompt)
      if (FakeSession.sent.length === 1) {
        return { text: renderQuestion(panel), reasoning: '', finish: 'question', refusal: null, panel }
      }
      return { text: `suite du tour : ${prompt}`, reasoning: '', finish: 'ok', refusal: null }
    }
  }

  FakeSession.sent = []
  const app = makeApp(path.join(dataDir, 'bindings-multi-four.json'), dir => new FourSession(dir))
  await post(app, 'chat-multi-four', ALPHA, 'freebuff-new')

  const asked = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': 'chat-multi-four' },
    payload: {
      model: 'freebuff-deepseek-v4-flash',
      stream: false,
      messages: [{ role: 'user', content: 'travaille' }],
      tools: [{ type: 'function', function: { name: 'ask_user' } }],
    },
  })

  assert.equal(asked.statusCode, 200)
  const card = JSON.parse(asked.body)
  const call = card.choices[0].message.tool_calls[0]
  const args = JSON.parse(call.function.arguments)
  assert.equal(args.questions[0].multi_select, true)
  assert.deepEqual(
    args.questions[0].options.map((option: { label: string }) => option.label),
    ['src', 'test', 'scripts', 'docs'],
    'pas de pagination : les quatre cases dans la même carte',
  )

  const answered = await postThread(app, 'chat-multi-four', [
    { role: 'user', content: 'travaille' },
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: JSON.stringify({
        status: 'answered',
        answers: { 'freebuff-q1-multi': { type: 'options', labels: ['src', 'docs'] } },
      }),
    },
  ])

  assert.equal(answered.statusCode, 200)
  assert.deepEqual(FakeSession.sent, ['travaille', '["src","docs"]'])

  await app.close()
  resetSettings()
})

test('sans l’outil annoncé, la question reste en texte numéroté', async () => {
  class TextSession extends FakeSession {
    override async send(prompt: string): Promise<TurnResult> {
      FakeSession.sent.push(prompt)
      return {
        text: 'Question texte (repli)',
        reasoning: '',
        finish: 'question',
        refusal: null,
        panel: { question: 'Quel contenu ?', options: [{ label: 'a', description: null }, { label: 'b', description: null }], complex: false },
      }
    }
  }

  FakeSession.sent = []
  const app = makeApp(path.join(dataDir, 'bindings-panel-2.json'), dir => new TextSession(dir))
  await post(app, 'chat-panel-2', ALPHA, 'freebuff-new')

  const asked = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': 'chat-panel-2' },
    payload: {
      model: 'freebuff-deepseek-v4-flash',
      stream: false,
      messages: [{ role: 'user', content: 'travaille' }],
    },
  })

  assert.equal(asked.statusCode, 200)
  assert.match(contentOf(asked.body), /Question texte \(repli\)/)
  assert.doesNotMatch(asked.body, /ask_user/)

  await app.close()
  resetSettings()
})

test('la réponse d’une carte (message tool) repart à la session sans faux refus', async () => {
  class PanelSession extends FakeSession {
    override async send(prompt: string): Promise<TurnResult> {
      FakeSession.sent.push(prompt)
      return { text: `suite du tour : ${prompt}`, reasoning: '', finish: 'ok', refusal: null }
    }
  }

  FakeSession.sent = []
  const app = makeApp(path.join(dataDir, 'bindings-panel-3.json'), dir => new PanelSession(dir))
  await post(app, 'chat-panel-3', ALPHA, 'freebuff-new')
  await post(app, 'chat-panel-3', 'travaille')

  const answered = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': 'chat-panel-3' },
    payload: {
      model: 'freebuff-deepseek-v4-flash',
      stream: false,
      messages: [
        { role: 'user', content: 'travaille' },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: JSON.stringify({
            status: 'answered',
            answers: { 'freebuff-q1': { type: 'option', option_index: 1, label: 'au revoir' } },
          }),
        },
      ],
    },
  })

  assert.equal(answered.statusCode, 200)
  assert.match(contentOf(answered.body), /suite du tour : au revoir/)
  assert.deepEqual(FakeSession.sent, ['travaille', 'au revoir'])

  await app.close()
  resetSettings()
})

test('après une édition, un nouveau message continue le fil au lieu de le bloquer', async () => {
  FakeSession.sent = []
  const app = makeApp()

  await post(app, 'chat-edit', ALPHA, 'freebuff-new')
  await postThread(app, 'chat-edit', [{ role: 'user', content: 'bonjour' }])

  // L'utilisateur modifie un message déjà envoyé, puis écrit un nouveau message.
  // La CLI n'a jamais vu la modification : on continue avec le nouveau message.
  const suite = await postThread(app, 'chat-edit', [
    { role: 'user', content: 'bonjour modifié' },
    { role: 'assistant', content: 'réponse' },
    { role: 'user', content: 'la suite' },
  ])

  assert.equal(suite.statusCode, 200)
  assert.deepEqual(FakeSession.sent, ['bonjour', 'la suite'])

  await app.close()
  resetSettings()
})

test('une requête sans nouveau message utilisateur ne lance aucun tour', async () => {
  FakeSession.sent = []
  const app = makeApp()

  await post(app, 'chat-attente', ALPHA, 'freebuff-new')
  await postThread(app, 'chat-attente', [{ role: 'user', content: 'bonjour' }])
  const waiting = await postThread(app, 'chat-attente', [
    { role: 'user', content: 'bonjour' },
    { role: 'assistant', content: 'réponse' },
  ])

  assert.equal(waiting.statusCode, 200)
  assert.match(contentOf(waiting.body), /En attente de consigne/)
  assert.deepEqual(FakeSession.sent, ['bonjour'])

  await app.close()
  resetSettings()
})

test('la signature d’un tour est refusée après redémarrage du pont', async () => {
  const file = path.join(dataDir, 'bindings-signature.json')

  const first = makeApp(file)
  await post(first, 'chat-signature', ALPHA, 'freebuff-new')
  await post(first, 'chat-signature', 'bonjour')
  await first.close()

  const second = makeApp(file)
  const response = await post(second, 'chat-signature', 'bonjour')

  assert.equal(response.statusCode, 409)
  assert.equal(codeOf(response.body), 'regeneration_refused')

  await second.close()
  resetSettings()
})

test('un tour refusé n’enregistre pas de signature : le même message repasse', async () => {
  resetSettings()
  writeFileSync(settingsFile, '{ pas du json', 'utf8')
  FakeSession.sent = []
  const app = makeApp()

  await post(app, 'chat-retry', ALPHA, 'freebuff-new')
  const failed = await post(app, 'chat-retry', 'bonjour')
  resetSettings()
  const retried = await post(app, 'chat-retry', 'bonjour')

  assert.equal(failed.statusCode, 400)
  assert.equal(retried.statusCode, 200)
  assert.deepEqual(FakeSession.sent, ['bonjour'])

  await app.close()
})

test('un dossier retenu par l’accueil s’applique au premier message d’un chat non lié', async () => {
  resetSettings()
  FakeSession.opened = []
  const file = path.join(dataDir, 'bindings-pending.json')
  const app = makeApp(file)

  const saved = await app.inject({
    method: 'POST',
    url: '/api/bind/pending',
    headers: AUTH,
    payload: { projectPath: ALPHA },
  })
  const first = await post(app, 'chat-neuf', 'bonjour')

  assert.equal(saved.statusCode, 200)
  assert.equal(first.statusCode, 200)
  assert.deepEqual(FakeSession.opened, [ALPHA])
  assert.match(contentOf(first.body), /tour dans/)

  // Le dossier a été consommé : un autre chat non lié reste refusé.
  const second = await post(app, 'chat-neuf-2', 'bonjour')
  assert.equal(second.statusCode, 400)
  assert.equal(codeOf(second.body), 'chat_unbound')

  await app.close()
})

test('un dossier retenu ne change pas le projet d’un chat déjà lié', async () => {
  resetSettings()
  FakeSession.opened = []
  const file = path.join(dataDir, 'bindings-pending-bound.json')
  const app = makeApp(file)

  await post(app, 'chat-deja-lie', BETA, 'freebuff-new')
  await app.inject({
    method: 'POST',
    url: '/api/bind/pending',
    headers: AUTH,
    payload: { projectPath: ALPHA },
  })

  const response = await post(app, 'chat-deja-lie', 'bonjour')
  assert.equal(response.statusCode, 200)
  assert.deepEqual(FakeSession.opened, [BETA])

  // Le dossier retenu est toujours là pour la conversation suivante.
  const fresh = await post(app, 'chat-neuf-3', 'bonjour')
  assert.equal(fresh.statusCode, 200)
  assert.deepEqual(FakeSession.opened, [BETA, ALPHA])

  await app.close()
})

test('un chemin invalide ne retient aucun dossier', async () => {
  resetSettings()
  FakeSession.opened = []
  const file = path.join(dataDir, 'bindings-pending-invalid.json')
  const app = makeApp(file)

  const refused = await app.inject({
    method: 'POST',
    url: '/api/bind/pending',
    headers: AUTH,
    payload: { projectPath: path.join(projectsRoot, '..', 'ailleurs').replace(/\\/g, '/') },
  })
  const response = await post(app, 'chat-neuf-4', 'bonjour')

  assert.equal(refused.statusCode, 400)
  assert.equal(codeOf(refused.body), 'invalid_project_path')
  assert.equal(response.statusCode, 400)
  assert.equal(codeOf(response.body), 'chat_unbound')
  assert.deepEqual(FakeSession.opened, [])

  await app.close()
})

test('deux conversations sur le même dossier : deux CLI, chacune son fil', async () => {
  /** Session qui retient ce qu'elle a reçu, pour prouver qu'aucun tour ne fuit. */
  class ChatSession extends FakeSession {
    readonly seen: string[] = []
    override async send(prompt: string): Promise<TurnResult> {
      this.seen.push(prompt)
      FakeSession.sent.push(prompt)
      return { text: `réponse à ${prompt}`, reasoning: '', finish: 'ok', refusal: null }
    }
  }

  FakeSession.opened = []
  FakeSession.sent = []
  const created: ChatSession[] = []
  const app = makeApp(path.join(dataDir, 'bindings-twin.json'), dir => {
    const session = new ChatSession(dir)
    created.push(session)
    return session
  })

  // Les deux conversations sont liées au MÊME projet, sans session ouverte.
  await post(app, 'chat-twin-a', ALPHA, 'freebuff-new')
  await post(app, 'chat-twin-b', ALPHA, 'freebuff-new')
  assert.deepEqual(FakeSession.opened, [], 'lier un chat ne démarre rien')

  const a1 = await post(app, 'chat-twin-a', 'consigne A')
  const b1 = await post(app, 'chat-twin-b', 'consigne B')
  const a2 = await postThread(app, 'chat-twin-a', [
    { role: 'user', content: 'consigne A' },
    { role: 'assistant', content: contentOf(a1.body) },
    { role: 'user', content: 'suite A' },
  ])

  // Deux sessions distinctes, sur le même dossier, et chacune garde son fil.
  assert.equal(created.length, 2, 'une CLI par conversation')
  assert.deepEqual(created.map(session => session.projectDir), [ALPHA, ALPHA])
  assert.deepEqual(
    created.map(session => session.seen),
    [['consigne A', 'suite A'], ['consigne B']],
  )
  assert.equal(a1.statusCode, 200)
  assert.equal(b1.statusCode, 200)
  assert.equal(a2.statusCode, 200)
  assert.doesNotMatch(contentOf(a2.body), /consigne B/)

  // Le diagnostic montre bien deux sessions, indexées par conversation.
  const health = await app.inject({ method: 'GET', url: '/health', headers: AUTH })
  const sessions = (JSON.parse(health.body) as { sessions: Array<{ key: string }> }).sessions
  assert.deepEqual(sessions.map(item => item.key).sort(), ['chat:chat-twin-a', 'chat:chat-twin-b'])

  await app.close()
})

test('la même conversation ne démarre jamais une seconde CLI', async () => {
  FakeSession.opened = []
  FakeSession.sent = []
  const app = makeApp(path.join(dataDir, 'bindings-same-chat.json'))

  await post(app, 'chat-solo', ALPHA, 'freebuff-new')
  const first = await post(app, 'chat-solo', 'un')
  const second = await postThread(app, 'chat-solo', [
    { role: 'user', content: 'un' },
    { role: 'assistant', content: contentOf(first.body) },
    { role: 'user', content: 'deux' },
  ])

  assert.deepEqual(FakeSession.opened, [ALPHA], 'une seule session pour un chat')
  assert.equal(second.statusCode, 200)
  assert.match(contentOf(second.body), /deux/)

  await app.close()
})

test('un binding survit au redémarrage du pont', async () => {
  FakeSession.opened = []
  const file = path.join(dataDir, 'bindings-restart.json')

  const first = makeApp(file)
  await post(first, 'chat-persistant', ALPHA, 'freebuff-new')
  await first.close()

  const second = makeApp(file)
  const response = await post(second, 'chat-persistant', 'après redémarrage')

  assert.equal(response.statusCode, 200)
  assert.match(contentOf(response.body), /après redémarrage/)
  assert.deepEqual(FakeSession.opened, [ALPHA])

  await second.close()
})

test('un chat neuf créé dans un dossier OWUI importé est lié au projet du dossier', async () => {
  resetSettings()
  FakeSession.opened = []
  const app = makeApp(path.join(dataDir, 'bindings-owui-folder.json'))

  const response = await post(app, FOLDER_CHAT, 'bonjour')

  assert.equal(response.statusCode, 200)
  assert.deepEqual(FakeSession.opened, [ALPHA])
  assert.match(contentOf(response.body), /tour dans/)

  const binding = await app.inject({
    method: 'GET',
    url: `/api/bind?chatId=${FOLDER_CHAT}`,
    headers: AUTH,
  })
  assert.equal(binding.statusCode, 200)
  assert.equal((JSON.parse(binding.body) as { projectPath: string }).projectPath, ALPHA)

  await app.close()
})

test('un dossier OWUI créé hors import ne lie aucun projet', async () => {
  resetSettings()
  FakeSession.opened = []
  const app = makeApp(path.join(dataDir, 'bindings-owui-folder-foreign.json'))

  const response = await post(app, FOREIGN_CHAT, 'bonjour')

  assert.equal(response.statusCode, 400)
  assert.equal(codeOf(response.body), 'chat_unbound')
  assert.deepEqual(FakeSession.opened, [])

  await app.close()
})
