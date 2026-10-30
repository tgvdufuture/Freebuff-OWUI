import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { renderQuestion } from '../src/freebuff/ask.ts'
import type { AgentSession, StopResult, TurnResult } from '../src/freebuff/session.ts'

/**
 * Ordre du message quand l'agent pose une question.
 *
 * OpenWebUI place TOUJOURS les cartes d'appel d'outil AVANT le corps du message,
 * quel que soit l'ordre d'envoi : avec la carte `ask_user`, le texte écrit par
 * l'agent avant sa question s'affichait APRÈS elle. Le pont écrit donc la
 * question en markdown, à la fin du message (23/10). La carte reste possible
 * avec `BRIDGE_ASK_CARD=1` (voir `binding-http.test.ts`).
 */

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'fb-ask-order-'))
const projectsRoot = mkdtempSync(path.join(os.tmpdir(), 'fb-ask-order-projects-'))
const profileDir = path.join(dataDir, 'profile')
const alpha = path.join(projectsRoot, 'alpha')

mkdirSync(alpha)
mkdirSync(profileDir, { recursive: true })
writeFileSync(
  path.join(dataDir, 'models.json'),
  JSON.stringify([{ id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' }]),
  'utf8',
)

process.env.BRIDGE_STUB = '0'
process.env.BRIDGE_DATA_DIR = dataDir
process.env.BRIDGE_API_KEY = 'test-key'
process.env.BRIDGE_PROJECTS_ROOT = projectsRoot
process.env.BRIDGE_PROFILE_DIR = profileDir
// Le défaut du pont : pas de carte. On force l'absence, même si le shell qui
// lance les tests porte la variable.
delete process.env.BRIDGE_ASK_CARD

const { buildServer } = await import('../src/server.ts')

const AUTH = { authorization: 'Bearer test-key' }
const ALPHA = alpha.replace(/\\/g, '/')
const PREAMBLE = 'Je vérifie d’abord deux choses.'
/** Début du pavé de question écrit par `renderQuestion`. */
const QUESTION = "**Question de l'agent**"

/** Session qui écrit un constat puis pose une question à deux options. */
class QuestionSession implements AgentSession {
  readonly pid = 4242
  readonly chatRef = 'ref-test'
  readonly projectDir: string
  readonly alive = true

  constructor(projectDir: string) {
    this.projectDir = projectDir
  }

  async send(): Promise<TurnResult> {
    const panel = {
      question: 'Quel contenu ?',
      options: [
        { label: 'bonjour', description: 'Le fichier contiendra « bonjour »' },
        { label: 'au revoir', description: null },
      ],
      complex: false,
    }
    return {
      // Ce que compose la session : le texte d'abord, la question ensuite.
      text: `${PREAMBLE}\n\n${renderQuestion(panel)}`,
      head: PREAMBLE,
      reasoning: '',
      finish: 'question',
      refusal: null,
      panel,
    }
  }

  stop(): StopResult {
    return { ok: true, remaining: false }
  }
}

const makeApp = (bindingsFile: string) =>
  buildServer({
    openSession: async dir => Promise.resolve(new QuestionSession(dir)),
    bindingsFile,
  })

/** Contenu reconstitué d'un flux SSE : les deltas `content`, dans l'ordre. */
function streamedContent(body: string): string {
  let content = ''
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const payload = line.slice('data: '.length).trim()
    if (payload === '[DONE]') continue
    const chunk = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> }
    content += chunk.choices?.[0]?.delta?.content ?? ''
  }
  return content
}

/** Le client annonce `ask_user`, comme OpenWebUI : le pont doit l'ignorer. */
const ASK_TOOL = [{ type: 'function', function: { name: 'ask_user' } }]

test('par défaut, le texte écrit avant la question vient avant elle, sans carte', async () => {
  const app = makeApp(path.join(dataDir, 'bindings.json'))
  const bind = await app.inject({
    method: 'POST',
    url: '/api/bind',
    headers: AUTH,
    payload: { chatId: 'chat-ordre', projectPath: ALPHA },
  })
  assert.equal(bind.statusCode, 200)

  const ask = (stream: boolean) =>
    app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { ...AUTH, 'x-openwebui-chat-id': 'chat-ordre' },
      payload: {
        model: 'freebuff-deepseek-v4-flash',
        stream,
        messages: [{ role: 'user', content: 'travaille' }],
        tools: ASK_TOOL,
      },
    })

  // Flux : le texte part en delta, la question ferme le message.
  const streamed = await ask(true)
  assert.equal(streamed.statusCode, 200)
  assert.doesNotMatch(streamed.body, /tool_calls/)
  assert.doesNotMatch(streamed.body, /ask_user/)
  const content = streamedContent(streamed.body)
  assert.match(content, new RegExp(PREAMBLE.replace('.', '\\.')))
  assert.ok(content.includes(QUESTION))
  assert.ok(
    content.indexOf(PREAMBLE) < content.indexOf(QUESTION),
    `le texte doit précéder la question : ${content}`,
  )
  // Une seule fois : le préambule ne doit pas être rejoué à la fin du tour.
  assert.equal(content.split(PREAMBLE).length - 1, 1, content)
  assert.ok(
    content.trimEnd().endsWith('sans consommer de tour supplémentaire.'),
    `la question doit fermer le message : ${content}`,
  )

  // Sans flux : même ordre dans le contenu du message.
  const plain = await ask(false)
  assert.equal(plain.statusCode, 200)
  const body = JSON.parse(plain.body) as {
    choices: Array<{ message: { content: string; tool_calls?: unknown[] } }>
  }
  const message = body.choices[0]?.message
  assert.equal(message?.tool_calls, undefined)
  const text = message?.content ?? ''
  assert.ok(text.indexOf(PREAMBLE) < text.indexOf(QUESTION), text)
  assert.ok(text.trimEnd().endsWith('sans consommer de tour supplémentaire.'), text)

  await app.close()
})
