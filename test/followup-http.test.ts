import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { AgentSession, StopResult, TurnResult } from '../src/freebuff/session.ts'
import type { FollowupUrl } from '../src/freebuff/transcript.ts'


const dataDir = mkdtempSync(path.join(os.tmpdir(), 'fb-followup-'))
const projectsRoot = mkdtempSync(path.join(os.tmpdir(), 'fb-followup-projects-'))
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
process.env.BRIDGE_API_KEY = 'test-key-followup'
process.env.BRIDGE_PROJECTS_ROOT = projectsRoot
process.env.BRIDGE_PROFILE_DIR = profileDir

const { buildServer } = await import('../src/server.ts')
const { ACTION_TTL_MS, signActionToken } = await import('../src/freebuff/action-token.ts')
const { stepsMarkdown, turnSteps } = await import('../src/freebuff/transcript.ts')

const AUTH = { authorization: 'Bearer test-key-followup' }
const ALPHA = path.join(projectsRoot, 'alpha').replace(/\\/g, '/')
const BETA = path.join(projectsRoot, 'beta').replace(/\\/g, '/')
const SECRET = 'test-key-followup'

/** Le tour que la CLI aurait écrit : réponse, puis trois suites proposées. */
const FOLLOWUPS = [
  {
    prompt: 'Mets à jour docs/analytics-dashboard.md avec ces constats',
    label: 'Corriger la doc analytics',
  },
  { prompt: 'Ajoute un indicateur de succès à led_emitted', label: 'Fiabiliser led_emitted' },
]
const ENTRIES = [
  { variant: 'user', content: 'analyse le dashboard' },
  {
    variant: 'ai',
    isComplete: true,
    blocks: [
      { type: 'text', textType: 'text', content: 'Voici la réponse.' },
      { type: 'tool', toolName: 'suggest_followups', input: { followups: FOLLOWUPS } },
    ],
  },
]

/** Session factice : rend le tour comme la vraie (étapes + liens), puis note le prompt reçu. */
class FakeSession implements AgentSession {
  readonly pid = 7_001
  readonly chatRef = 'ref-followup'
  readonly projectDir: string
  alive = true
  static opened = 0
  /** Dernière session ouverte : les tests la tuent à la demande. */
  static last: FakeSession | null = null
  static sent: string[] = []
  /** Lien reçu pour le tour : c'est celui que le pont a fabriqué. */
  static builder: FollowupUrl | null = null
  /** Retient le tour en cours, pour tester le refus d'un second envoi. */
  static hold: Promise<void> | null = null

  constructor(projectDir: string) {
    this.projectDir = projectDir
    FakeSession.opened += 1
    FakeSession.last = this
  }

  async send(
    prompt: string,
    _onDelta: (text: string) => void,
    _onReasoning?: (text: string) => void,
    options?: { followupUrl?: FollowupUrl | null },
  ): Promise<TurnResult> {
    FakeSession.sent.push(prompt)
    FakeSession.builder = options?.followupUrl ?? null
    if (FakeSession.hold !== null) await FakeSession.hold
    return {
      text: stepsMarkdown(turnSteps(ENTRIES), false, FakeSession.builder),
      reasoning: '',
      finish: 'ok',
      refusal: null,
    }
  }

  stop(): StopResult {
    this.alive = false
    return { ok: true, remaining: false }
  }
}

let counter = 0
function makeApp(bindingsFile = path.join(dataDir, `bindings-${String(++counter)}.json`)) {
  return buildServer({
    bindingsFile,
    openSession: async dir => new FakeSession(dir),
  })
}

/** Écrit un transcript CLI comme la vraie, pour la relecture après redémarrage. */
function writeTranscript(ref: string, entries: unknown[], project = 'alpha'): void {
  const dir = path.join(profileDir, 'projects', project, 'chats', ref)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'chat-meta.json'),
    JSON.stringify({ firstPrompt: 'analyse le dashboard', messageCount: entries.length }),
    'utf8',
  )
  writeFileSync(path.join(dir, 'chat-messages.json'), JSON.stringify(entries), 'utf8')
}

/** Envoie le fil tel quel et rend la réponse brute, sans exiger 200. */
async function post(
  app: ReturnType<typeof makeApp>,
  chatId: string,
): Promise<{ status: number; content: string; code: string | null }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': chatId },
    payload: {
      model: 'freebuff-deepseek-v4-flash',
      stream: false,
      messages: [{ role: 'user', content: 'analyse le dashboard' }],
    },
  })
  const body = JSON.parse(response.body) as {
    choices?: Array<{ message: { content: string } }>
    error?: { code: string }
  }
  return {
    status: response.statusCode,
    content: body.choices?.[0]?.message.content ?? '',
    code: body.error?.code ?? null,
  }
}

async function bind(
  app: ReturnType<typeof makeApp>,
  chatId: string,
  projectPath = ALPHA,
): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/bind',
    payload: { chatId, projectPath },
  })
  assert.equal(response.statusCode, 200)
}

async function turn(app: ReturnType<typeof makeApp>, chatId: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': chatId },
    payload: {
      model: 'freebuff-deepseek-v4-flash',
      stream: false,
      messages: [{ role: 'user', content: 'analyse le dashboard' }],
    },
  })
  assert.equal(response.statusCode, 200)
  return (JSON.parse(response.body) as { choices: Array<{ message: { content: string } }> }).choices[0]
    ?.message.content ?? ''
}

/** Les liens `/a/prompt` d'un message, dans l'ordre d'affichage. */
function linksOf(markdown: string): string[] {
  return [...markdown.matchAll(/\]\((http:\/\/127\.0\.0\.1:\d+\/a\/prompt\?t=[^)]+)\)/g)].map(
    match => match[1] ?? '',
  )
}

function reset(): void {
  FakeSession.sent = []
  FakeSession.builder = null
  FakeSession.hold = null
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition non atteinte')
}

/** Chemin local d'une URL absolue, pour `app.inject`. */
const local = (url: string): string => url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')

test('chaque suite proposée devient un lien, et le clic envoie le prompt du CLI', async () => {
  reset()
  const app = makeApp()
  await bind(app, 'chat-suites')

  const content = await turn(app, 'chat-suites')
  assert.match(content, /Voici la réponse\./)
  const links = linksOf(content)
  assert.equal(links.length, FOLLOWUPS.length)
  assert.equal(new Set(links).size, FOLLOWUPS.length, 'un lien par suite, jamais le même')

  const before = FakeSession.sent.length
  const first = await app.inject({ method: 'GET', url: local(links[0] ?? '') })
  assert.equal(first.statusCode, 302)
  assert.match(first.headers.location ?? '', /\/c\/chat-suites$/)
  await waitFor(() => FakeSession.sent.length === before + 1)
  // Le PROMPT préparé par le CLI, pas le libellé affiché.
  assert.deepEqual(FakeSession.sent.slice(before), [FOLLOWUPS[0]?.prompt])

  const second = await app.inject({ method: 'GET', url: local(links[1] ?? '') })
  assert.equal(second.statusCode, 302)
  await waitFor(() => FakeSession.sent.length === before + 2)
  assert.deepEqual(FakeSession.sent.slice(before + 1), [FOLLOWUPS[1]?.prompt])

  await app.close()
})

test('une régénération après redémarrage relit la réponse dans le transcript', async () => {
  reset()
  const bindings = path.join(dataDir, 'bindings-replay.json')
  writeTranscript('2026-10-23T09-48-00.000Z', ENTRIES)

  // Premier pont : le tour tourne et enregistre la signature du fil.
  const first = makeApp(bindings)
  await bind(first, 'chat-replay')
  await turn(first, 'chat-replay')
  await first.close()

  // Pont relancé : le cache mémoire est vide, le transcript est toujours là.
  const second = makeApp(bindings)
  const replayed = await post(second, 'chat-replay')
  assert.equal(replayed.status, 200)
  assert.match(replayed.content, /Voici la réponse\./)

  // Les suggestions du tour d'avant sont relues et re-rendues en liens.
  const links = linksOf(replayed.content)
  assert.equal(links.length, FOLLOWUPS.length)
  const before = FakeSession.sent.length
  const click = await second.inject({ method: 'GET', url: local(links[0] ?? '') })
  assert.equal(click.statusCode, 302)
  await waitFor(() => FakeSession.sent.length === before + 1)
  assert.equal(FakeSession.sent.at(-1), FOLLOWUPS[0]?.prompt)

  await second.close()
})

test('une régénération dont le transcript est une AUTRE consigne reste refusée', async () => {
  reset()
  const bindings = path.join(dataDir, 'bindings-mismatch.json')
  writeTranscript(
    '2026-10-23T09-00-00.000Z',
    [{ variant: 'user', content: 'un tout autre sujet' }, ENTRIES[1]],
    'beta',
  )

  const first = makeApp(bindings)
  await bind(first, 'chat-mismatch', BETA)
  await turn(first, 'chat-mismatch')
  await first.close()

  const second = makeApp(bindings)
  const refused = await post(second, 'chat-mismatch')
  assert.equal(refused.status, 409)
  assert.equal(refused.code, 'regeneration_refused')

  await second.close()
})

test('un même lien ne sert qu’une fois', async () => {
  reset()
  const app = makeApp()
  await bind(app, 'chat-unique')

  const links = linksOf(await turn(app, 'chat-unique'))
  const before = FakeSession.sent.length
  const click = await app.inject({ method: 'GET', url: local(links[0] ?? '') })
  assert.equal(click.statusCode, 302)
  await waitFor(() => FakeSession.sent.length === before + 1)

  const again = await app.inject({ method: 'GET', url: local(links[0] ?? '') })
  assert.equal(again.statusCode, 410)
  assert.equal((JSON.parse(again.body) as { error: { code: string } }).error.code, 'token_used')
  assert.equal(FakeSession.sent.length, before + 1, 'le second clic ne relance rien')

  await app.close()
})

test('un jeton expiré, forgé ou sans prompt est refusé', async () => {
  reset()
  const app = makeApp()
  await bind(app, 'chat-jetons')

  const expired = signActionToken(SECRET, 'chat-jetons', Date.now() - ACTION_TTL_MS - 1_000, 'agis')
  const expiredResponse = await app.inject({
    method: 'GET',
    url: `/a/prompt?t=${encodeURIComponent(expired)}`,
  })
  assert.equal(expiredResponse.statusCode, 410)
  assert.equal((JSON.parse(expiredResponse.body) as { error: { code: string } }).error.code, 'token_invalid')

  const forged = await app.inject({ method: 'GET', url: '/a/prompt?t=nimporte-quoi' })
  assert.equal(forged.statusCode, 410)

  // Jeton du bouton Continuer : pas de prompt à envoyer, donc pas de tour.
  const continuer = signActionToken(SECRET, 'chat-jetons')
  const noPrompt = await app.inject({
    method: 'GET',
    url: `/a/prompt?t=${encodeURIComponent(continuer)}`,
  })
  assert.equal(noPrompt.statusCode, 410)
  assert.deepEqual(FakeSession.sent, [])

  await app.close()
})

test('un chat non lié ou un tour en cours refuse le clic sans consommer le lien', async () => {
  reset()
  const app = makeApp()
  await bind(app, 'chat-occupe')

  const unbound = signActionToken(SECRET, 'chat-inconnu', Date.now(), 'agis')
  const notLinked = await app.inject({
    method: 'GET',
    url: `/a/prompt?t=${encodeURIComponent(unbound)}`,
  })
  assert.equal(notLinked.statusCode, 404)
  assert.equal((JSON.parse(notLinked.body) as { error: { code: string } }).error.code, 'chat_unbound')

  // Un tour est en cours : le clic est refusé, et le lien reste utilisable.
  let release = (): void => {}
  FakeSession.hold = new Promise<void>(resolve => {
    release = resolve
  })
  const running = turn(app, 'chat-occupe')
  await waitFor(() => FakeSession.sent.length === 1)
  const token = signActionToken(SECRET, 'chat-occupe', Date.now(), 'agis')
  const busy = await app.inject({ method: 'GET', url: `/a/prompt?t=${encodeURIComponent(token)}` })
  assert.equal(busy.statusCode, 409)
  assert.equal((JSON.parse(busy.body) as { error: { code: string } }).error.code, 'turn_running')

  FakeSession.hold = null
  release()
  await running
  const after = await app.inject({ method: 'GET', url: `/a/prompt?t=${encodeURIComponent(token)}` })
  assert.equal(after.statusCode, 302, 'le lien refusé par un tour en cours reste valable')

  await app.close()
})

test('le lien d’un tour est stable, et reste utilisable si la session est morte', async () => {
  reset()
  const app = makeApp()
  await bind(app, 'chat-mort')

  const content = await turn(app, 'chat-mort')
  const links = linksOf(content)
  const builder = FakeSession.builder
  assert.ok(builder !== null, 'le tour a reçu le constructeur de lien')
  // Le flux puis le rendu final relisent le transcript : même prompt, même URL.
  assert.equal(builder(FOLLOWUPS[0]?.prompt ?? ''), builder(FOLLOWUPS[0]?.prompt ?? ''))
  assert.equal(builder('autre prompt'), builder('autre prompt'))
  assert.notEqual(builder(FOLLOWUPS[0]?.prompt ?? ''), builder(FOLLOWUPS[1]?.prompt ?? ''))

  // La session est morte (CLI fermée) : un clic explicite la relance, une fois.
  if (FakeSession.last !== null) FakeSession.last.alive = false
  const opened = FakeSession.opened
  const click = await app.inject({ method: 'GET', url: local(links[0] ?? '') })
  assert.equal(click.statusCode, 302)
  await waitFor(() => FakeSession.sent.includes(FOLLOWUPS[0]?.prompt ?? ''))
  assert.equal(FakeSession.opened, opened + 1)

  await app.close()
})
