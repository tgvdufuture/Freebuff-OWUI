import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { AgentSession, StopResult, TurnResult } from '../src/freebuff/session.ts'
import type { Toast } from '../src/freebuff/notify.ts'

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'fb-notify-'))
const projectsRoot = mkdtempSync(path.join(os.tmpdir(), 'fb-notify-projects-'))
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
process.env.BRIDGE_API_KEY = 'test-key-notify'
process.env.BRIDGE_PROJECTS_ROOT = projectsRoot
process.env.BRIDGE_PROFILE_DIR = profileDir

const { buildServer } = await import('../src/server.ts')
const { signActionToken } = await import('../src/freebuff/action-token.ts')

const AUTH = { authorization: 'Bearer test-key-notify' }
const ALPHA = path.join(projectsRoot, 'alpha').replace(/\\/g, '/')
const PROMPT_SECRET = 'PROMPT-SECRET-abc'
const OUTPUT_SECRET = 'SORTIE-OUTIL-secrete'

const OK: TurnResult = {
  text: `réponse terminée ${OUTPUT_SECRET}`,
  reasoning: '',
  finish: 'ok',
  refusal: null,
}
const QUESTION: TurnResult = {
  text: 'Choisis une option',
  reasoning: '',
  finish: 'question',
  refusal: null,
}
const ENDED: TurnResult = {
  text: 'Your free session has ended. Send your message again to start a new one.',
  reasoning: '',
  finish: 'session_ended',
  refusal: null,
  failure: { message: 'Your free session has ended.', code: 'waiting_room_required', status: 428 },
}

class FakeSession implements AgentSession {
  readonly pid = 7_001
  readonly chatRef = 'ref-notify'
  readonly projectDir: string
  alive = true
  static result: TurnResult = OK
  static diesAfterSend = false

  constructor(projectDir: string) {
    this.projectDir = projectDir
  }

  async send(): Promise<TurnResult> {
    if (FakeSession.diesAfterSend) this.alive = false
    return FakeSession.result
  }

  stop(): StopResult {
    return { ok: true, remaining: false }
  }
}

let counter = 0
function makeApp(toasts: Toast[]) {
  counter += 1
  return buildServer({
    bindingsFile: path.join(dataDir, `bindings-${String(counter)}.json`),
    openSession: async dir => new FakeSession(dir),
    notify: toast => toasts.push(toast),
  })
}

async function bind(app: ReturnType<typeof makeApp>, chatId: string): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/bind',
    payload: { chatId, projectPath: ALPHA },
  })
  assert.equal(response.statusCode, 200)
}

async function post(
  app: ReturnType<typeof makeApp>,
  chatId: string,
  content = PROMPT_SECRET,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': chatId },
    payload: {
      model: 'freebuff-deepseek-v4-flash',
      stream: false,
      messages: [{ role: 'user', content }],
    },
  })
  return response.body
}

function reset(): void {
  FakeSession.result = OK
  FakeSession.diesAfterSend = false
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition non atteinte')
}

test('un tour terminé envoie un toast, sans le prompt ni la sortie d’outil', async () => {
  reset()
  const toasts: Toast[] = []
  const app = makeApp(toasts)
  await bind(app, 'chat-toast-ok')

  await post(app, 'chat-toast-ok')

  assert.equal(toasts.length, 1)
  const text = `${toasts[0]?.title ?? ''} ${toasts[0]?.message ?? ''}`
  assert.doesNotMatch(text, new RegExp(PROMPT_SECRET))
  assert.doesNotMatch(text, new RegExp(OUTPUT_SECRET))

  await app.close()
})

test('une fin de session envoie un toast qui propose de continuer', async () => {
  reset()
  FakeSession.result = ENDED
  FakeSession.diesAfterSend = true
  const toasts: Toast[] = []
  const app = makeApp(toasts)
  await bind(app, 'chat-toast-end')

  await post(app, 'chat-toast-end')

  assert.equal(toasts.length, 1)
  assert.match(toasts[0]?.message ?? '', /Continuer/)

  await app.close()
})

test('une question de l’agent envoie un toast, sans le texte de la question', async () => {
  reset()
  FakeSession.result = QUESTION
  const toasts: Toast[] = []
  const app = makeApp(toasts)
  await bind(app, 'chat-toast-question')

  await post(app, 'chat-toast-question')

  assert.equal(toasts.length, 1)
  assert.doesNotMatch(`${toasts[0]?.title ?? ''} ${toasts[0]?.message ?? ''}`, /Choisis une option/)

  await app.close()
})

test('le clic Continuer envoie aussi son toast', async () => {
  reset()
  FakeSession.result = OK
  const toasts: Toast[] = []
  const app = makeApp(toasts)
  await bind(app, 'chat-toast-continue')

  const token = signActionToken('test-key-notify', 'chat-toast-continue')
  const click = await app.inject({ method: 'GET', url: `/a/continue?t=${encodeURIComponent(token)}` })
  assert.equal(click.statusCode, 302)

  await waitFor(() => toasts.length === 1)
  assert.match(toasts[0]?.message ?? '', /réponse|prête/)

  await app.close()
})
