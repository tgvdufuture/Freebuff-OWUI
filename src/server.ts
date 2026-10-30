import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import { Bindings, normalizeProjectPath } from './bindings.ts'
import { config } from './config.ts'
import {
  conversationDir,
  hasAgentContent,
  isConversationRef,
  lastAgentOutput,
  latestAgentOutput,
  listConversations,
  renderAgentOutput,
  renderTranscript,
  type AgentOutput,
  type ConversationSummary,
} from './freebuff/history.ts'
import { browseProjects } from './projects.ts'
import {
  cliStatus,
  renderDiagnosticPage,
  type HealthSnapshot,
  type QuotaSnapshot,
  type RefusalRecord,
} from './diagnostic.ts'
import {
  SessionGone,
  SessionHost,
  SessionStuck,
  TooManySessions,
  sessionRef,
  type ModelChoice,
  type SessionRef,
} from './freebuff/host.ts'
import { FreebuffSession, SessionRefused } from './freebuff/session.ts'
import { REFUSAL_MESSAGES, type QuotaView } from './freebuff/screen.ts'
import { Journal } from './freebuff/journal.ts'
import { ModelSettings, SettingsUnreadable } from './freebuff/settings.ts'
import {
  ASK_TOOL,
  MORE_OPTIONS_LABEL,
  answerFromToolContent,
  toolArguments,
  type AskPanel,
} from './freebuff/ask.ts'
import { isNewProjectModel, listExposedModels, modelCost, resolveModelChoice } from './models.ts'
import {
  discoverProfiles,
  mergeProfileReport,
  parseProfileReport,
  profileKey,
  profilesFile,
  resolveFreebuffBin,
  type ProfileReading,
  type ProfileReport,
} from './freebuff/profiles.ts'
import { probeQuota } from './freebuff/quota.ts'
import {
  DEFAULT_ARCHIVE_MODEL,
  ImportScheduler,
  importHealth,
  profileList,
  runImport,
  type ImportHealth,
} from './freebuff/importer.ts'
import { createOwuiClient, resolveOwuiKey } from './freebuff/owui.ts'
import { compareThread, threadSignatures, waitsForInstruction } from './signature.ts'
import { signActionToken, verifyActionToken } from './freebuff/action-token.ts'
import {
  MAX_PROMPT_CHARS,
  parseTranscript,
  stepsMarkdown,
  turnComplete,
  turnSteps,
  type FollowupUrl,
} from './freebuff/transcript.ts'
import { promptWithContext } from './freebuff/replay.ts'
import { TurnLog, recordOf } from './freebuff/turns.ts'
import { Notifier, windowsToastSender, type Toast } from './freebuff/notify.ts'
import type { AgentSession, TurnFinish, TurnResult } from './freebuff/session.ts'

/**
 * Le pont entre OpenWebUI et UNE session Freebuff, gardée ouverte.
 *
 * Le mode stub (`BRIDGE_STUB=0` désactive) reste pour les tests et les
 * diagnostics : il répond un texte qui décrit la requête reçue, sans CLI.
 * En mode réel, chaque message d'OpenWebUI devient un tour de la MÊME
 * session — jamais un redémarrage de la CLI (cf. `src/freebuff/session.ts`).
 */

interface ChatMessage {
  role: string
  content: unknown
  /** Présent sur un message `tool` : la réponse à la carte de question. */
  tool_call_id?: string
}

interface ChatBody {
  model?: string
  messages?: ChatMessage[]
  stream?: boolean
  metadata?: unknown
  /** Outils annoncés par le client (OpenWebUI y met son `ask_user` natif). */
  tools?: Array<{ type?: string; function?: { name?: string } }>
}

function redactHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (key === 'authorization' || key === 'x-api-key') out[key] = '<masqué>'
    else out[key] = value
  }
  return out
}

/**
 * Capture une requête pour le spike. Le corps est borné : une capture qui
 * remplit le disque est un bug, pas une preuve.
 *
 * Désactivée en marche réelle (`config.capture`) : le corps contient le prompt
 * de l'utilisateur, et le journal ne le recopie déjà pas.
 */
function capture(payload: Record<string, unknown>): void {
  if (!config.capture) return
  fs.mkdirSync(config.captureDir, { recursive: true })
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}.json`
  const file = path.join(config.captureDir, name)
  const body = JSON.stringify(payload, null, 2)
  fs.writeFileSync(file, body.length > 200_000 ? `${body.slice(0, 200_000)}\n\n… (tronqué à 200 000 caractères)` : body, 'utf8')
}

/**
 * OpenWebUI annonce son outil `ask_user` dans chaque requête (mesuré :
 * `spike/s0/requests`, OWUI 0.12.3). S'il est là, la question part en *tool
 * call* et le client dessine SA carte (screenshot de référence) ; sinon le pont
 * garde le texte numéroté, qui marche partout.
 */
function hasAskTool(tools: ChatBody['tools']): boolean {
  return Array.isArray(tools) && tools.some(tool => tool.function?.name === ASK_TOOL)
}

/** Texte d'un message, qu'il soit une chaîne ou des blocs texte. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part =>
        typeof part === 'object' && part !== null && 'text' in part
          ? String((part as { text: unknown }).text)
          : '',
      )
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * Réponse de l'utilisateur à la carte, livrée par OpenWebUI en message `tool`.
 * Dernier message seulement : une réponse ancienne ne doit pas répondre à une
 * nouvelle question.
 */
function lastToolAnswer(messages: ChatMessage[]): string | null {
  const last = messages.at(-1)
  if (last?.role !== 'tool') return null
  return answerFromToolContent(textOf(last.content))
}

/** Arguments de la carte native, ou `null` si le panneau sort du contrat OWUI. */
function panelArguments(
  panel: AskPanel | null | undefined,
  stage = 0,
): Record<string, unknown> | null {
  return panel === null || panel === undefined ? null : toolArguments(panel, stage)
}

/** Carte de question renvoyée sans toucher à la CLI (page suivante). */
function cardReply(
  reply: FastifyReply,
  input: { model: string; stream: boolean; args: Record<string, unknown> },
): unknown {
  const id = `chatcmpl-${crypto.randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const toolCalls = [
    {
      id: `call_${crypto.randomUUID()}`,
      type: 'function',
      function: { name: ASK_TOOL, arguments: JSON.stringify(input.args) },
    },
  ]

  if (!input.stream) {
    return reply.send({
      id,
      object: 'chat.completion',
      created,
      model: input.model,
      choices: [
        { index: 0, message: { role: 'assistant', content: '', tool_calls: toolCalls }, finish_reason: 'tool_calls' },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })
  }

  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  })
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null): Record<string, unknown> => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model: input.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })

  reply.raw.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: '' }))}\n\n`)
  reply.raw.write(
    `data: ${JSON.stringify(
      chunk({ tool_calls: toolCalls.map((call, index) => ({ index, ...call })) }),
    )}\n\n`,
  )
  reply.raw.write(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\n`)
  reply.raw.write('data: [DONE]\n\n')
  reply.raw.end()
  return reply
}

function lastUserText(messages: ChatMessage[]): string {
  const last = [...messages].reverse().find(m => m.role === 'user')
  if (!last) return ''
  if (typeof last.content === 'string') return last.content
  if (Array.isArray(last.content)) {
    return last.content
      .map(part => (typeof part === 'object' && part !== null && 'text' in part ? String((part as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function diagnosticText(input: {
  chatId: string | null
  model: string
  messages: ChatMessage[]
  stream: boolean
  metadataPresent: boolean
}): string {
  const chatId = input.chatId
    ? `\`${input.chatId}\``
    : '**ABSENT** — active `ENABLE_FORWARD_USER_INFO_HEADERS=true`'
  return [
    '**S0 — requête reçue par le pont.**',
    '',
    `- chat id : ${chatId}`,
    `- modèle demandé : \`${input.model}\``,
    `- messages : ${input.messages.length} (dernier rôle : \`${input.messages.at(-1)?.role ?? 'aucun'}\`)`,
    `- stream : ${input.stream ? 'oui' : 'non'}`,
    `- metadata : ${input.metadataPresent ? 'présent' : 'absent (nettoyé par OpenWebUI)'}`,
    '',
    '<details><summary>Rendu repliable — clique pour ouvrir</summary>',
    '',
    'Si tu lis ce texte après avoir cliqué, `<details>` fonctionne dans OpenWebUI.',
    '',
    '</details>',
    '',
    'Réponds **ok** : le chat id ci-dessus doit rester identique.',
  ].join('\n')
}

/**
 * Mémoire des tours, par chat :
 *
 * - `inFlight` : le tour en vol, pour qu'un rechargement de page attende LE
 *   MÊME tour au lieu d'en lancer un second ;
 * - `answers` : la dernière réponse aboutie, pour que la même liste de messages
 *   rejouée reçoive cette réponse au lieu d'un refus.
 *
 * Sans ça, OpenWebUI relance la génération à chaque rafraîchissement (sa
 * réponse n'était pas marquée terminée), reçoit un refus et reste bloqué. Rien
 * n'est écrit sur disque : le texte ne vit que le temps du processus.
 */
interface CachedTurn {
  signatures: string[]
  text: string
  reasoning: string
}

interface PendingTurn {
  signatures: string[]
  result: Promise<TurnResult>
}

interface TurnCache {
  answers: Map<string, CachedTurn>
  inFlight: Map<string, PendingTurn>
  /** Panneau de la dernière question posée : sert à la carte paginée. */
  panels: Map<string, AskPanel>
  /** Page de carte déjà affichée (0 = première). */
  stages: Map<string, number>
  /**
   * Dernier tour terminé par chat : l'indicateur d'onglet d'OpenWebUI le lit
   * pour attirer l'attention quand un tour se finit ou qu'une question attend.
   */
  attention: Map<string, { at: number; outcome: TurnFinish }>
}

function sameSignatures(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((hash, i) => hash === b[i])
}

/** La réponse déjà produite pour cette liste, ou `null` si elle n'existe pas. */
async function replayTurn(
  turns: TurnCache,
  chatId: string,
  signatures: string[],
): Promise<{ text: string; reasoning: string } | null> {
  const pending = turns.inFlight.get(chatId)
  if (pending !== undefined && sameSignatures(pending.signatures, signatures)) {
    const result = await pending.result.catch(() => null)
    if (result !== null && result.text) return { text: result.text, reasoning: result.reasoning }
  }

  const answer = turns.answers.get(chatId)
  if (answer !== undefined && sameSignatures(answer.signatures, signatures) && answer.text) {
    return { text: answer.text, reasoning: answer.reasoning }
  }
  return null
}

/**
 * Lien cliquable d'une suggestion de suite, signé pour un chat.
 *
 * `now` est figé par l'appelant quand le même tour est rendu plusieurs fois
 * (flux puis rendu final) : deux horodatages différents produiraient deux URL
 * et le texte final ne prolongerait plus ce qui est déjà parti.
 */
function followupLink(chatId: string, now: number, prompt: string): string {
  const token = signActionToken(config.apiKey, chatId, now, prompt)
  return `http://127.0.0.1:${String(config.port)}/a/prompt?t=${encodeURIComponent(token)}`
}

/**
 * Dernière réponse de la CLI pour ce projet, relue dans son transcript.
 *
 * Sert à « Régénérer » quand le cache du pont est vide (il a redémarré) : la
 * CLI a toujours écrit son transcript, et le relire ne consomme aucun tour.
 * On ne rejoue que si la dernière consigne écrite est exactement celle du fil
 * — sinon on rendrait la réponse d'une autre conversation — et si le tour est
 * complet.
 */
function transcriptAnswer(input: {
  profileDir: string
  projectPath: string
  prompt: string
  followupUrl: FollowupUrl | null
}): string | null {
  const wanted = input.prompt.replace(/\s+/g, ' ').trim()
  if (wanted === '') return null

  for (const conversation of listConversations(input.profileDir, input.projectPath, 5)) {
    const dir = conversationDir(input.profileDir, input.projectPath, conversation.ref)
    if (dir === null) continue
    let raw: string
    try {
      raw = fs.readFileSync(path.join(dir, 'chat-messages.json'), 'utf8')
    } catch {
      continue
    }
    const entries = parseTranscript(raw)
    if (entries === null || !turnComplete(entries)) continue
    const said = entries.filter(entry => entry.variant === 'user').at(-1)
    const text = typeof said?.content === 'string' ? said.content.replace(/\s+/g, ' ').trim() : ''
    if (text !== wanted) continue
    const markdown = stepsMarkdown(turnSteps(entries), false, input.followupUrl)
    if (markdown.trim() === '') continue
    return markdown
  }
  return null
}

function refusalStatus(code: string | null): number {
  return code === 'quota_exhausted' || code === 'not_enough_hours' ? 429 : 503
}

/** `/import` ou `/import 2` : une commande du pont, jamais une consigne CLI. */
function isImportCommand(prompt: string): boolean {
  return /^\/import(?:\s|$)/i.test(prompt.trim())
}

function refLabel(ref: string): string {
  return ref.slice(0, 16).replace('T', ' ')
}

/**
 * `/import` dans un chat lié : lister les conversations du projet, puis
 * afficher celle qui est choisie. Aucun tour, aucun quota, aucune écriture
 * dans la CLI.
 */
function importInChat(input: {
  bindings: Bindings
  profileDir: string
  chatId: string
  projectPath: string
  prompt: string
}): { content: string; status: number } {
  const conversations = listConversations(input.profileDir, input.projectPath)
  const argument = input.prompt.trim().replace(/^\/import\b/i, '').trim()

  if (argument === '') {
    if (conversations.length === 0) {
      return {
        status: 200,
        content:
          `Aucune conversation Freebuff enregistrée pour \`${input.projectPath}\`.\n\n` +
          'Un premier message lancera une nouvelle conversation ; il n\'y a rien à importer.',
      }
    }

    const lines = conversations.map((conversation, index) => {
      const prompt = conversation.firstPrompt === '' ? '_(sans consigne)_' : `« ${conversation.firstPrompt} »`
      return `${String(index + 1)}. ${refLabel(conversation.ref)} — ${String(conversation.messageCount)} message(s) — ${prompt}`
    })
    return {
      status: 200,
      content: [
        `**Conversations Freebuff de \`${input.projectPath}\`** (${String(conversations.length)})`,
        '',
        ...lines,
        '',
        'Réponds `/import 2` pour afficher son historique (aucun tour consommé), ou `/import <ref>` ' +
          'pour une plus ancienne. Le prochain message REPREND la conversation choisie côté Freebuff.',
      ].join('\n'),
    }
  }

  let chosen: ConversationSummary | null = null
  if (/^\d+$/.test(argument)) {
    chosen = conversations[Number(argument) - 1] ?? null
  } else if (isConversationRef(argument)) {
    chosen = conversations.find(item => item.ref === argument) ?? {
      ref: argument,
      firstPrompt: '',
      messageCount: 0,
      updatedAt: null,
    }
  }

  if (chosen === null) {
    return {
      status: 200,
      content:
        `Conversation inconnue : « ${argument} ». Envoie \`/import\` seul pour revoir la liste ` +
        `(${String(conversations.length)} conversation(s) récente(s) pour ce projet).`,
    }
  }

  const dir = conversationDir(input.profileDir, input.projectPath, chosen.ref)
  const rendered = dir === null ? null : renderTranscript(dir)
  if (rendered === null) {
    return {
      status: 200,
      content:
        `La conversation \`${chosen.ref}\` existe mais son transcript est absent ou illisible : ` +
        'rien n\'a été affiché ni retenu.',
    }
  }

  try {
    input.bindings.setResumeRef(input.chatId, chosen.ref)
  } catch (error) {
    return {
      status: 200,
      content: `Conversation affichée, mais la reprise n'a pas pu être notée : ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }

  // Le fil est REPLIÉ : déversé en clair, il occupait tout l'écran dans un seul
  // message où les tours de l'utilisateur ne sont que des libellés — OWUI
  // échappe le HTML, donc aucune feuille ne peut les distinguer de ceux de
  // l'agent (mesuré). Replié, le chat garde ses vraies bulles et le fil reste
  // à un clic.
  return {
    status: 200,
    content: [
      `**Conversation \`${chosen.ref}\`** (${String(chosen.messageCount)} message(s)) — reprise activée.`,
      '',
      'Le prochain message REPREND ce fil côté CLI (`freebuff --continue`).',
      '',
      '<details>',
      `<summary>Voir les ${String(chosen.messageCount)} message(s)</summary>`,
      '',
      rendered.markdown,
      '',
      '</details>',
      '',
      '_Historique lu depuis Freebuff : aucun tour consommé._',
    ].join('\n'),
  }
}

/** `/recover` ou `/recover <ref>` : une commande du pont, jamais une consigne CLI. */
function isRecoverCommand(prompt: string): boolean {
  return /^\/recover(?:\s|$)/i.test(prompt.trim())
}

/** Borne l'affichage : un message OWUI de plusieurs mégaoctets n'aide personne. */
const RECOVER_MAX_CHARS = 30_000

/**
 * `/recover` dans un chat lié : relire la dernière sortie de l'agent pour la
 * conversation CLI du projet — quand le tour n'a pas livré sa réponse et que
 * la session est déjà fermée, le transcript sur disque est la seule source.
 * Aucune CLI lancée, aucun tour consommé, aucune écriture.
 */
function recoverInChat(input: {
  bindings: Bindings
  chatId: string
  profileDir: string
  projectPath: string
  prompt: string
}): { content: string } {
  const argument = input.prompt.trim().replace(/^\/recover\b/i, '').trim()

  /** mtime du transcript, pour dater ce qui est montré. */
  const messageMtime = (dir: string): number | null => {
    try {
      return fs.statSync(path.join(dir, 'chat-messages.json')).mtimeMs
    } catch {
      return null
    }
  }

  let picked: { ref: string; output: AgentOutput; updatedAt: number | null } | null = null

  if (argument === '') {
    // D'abord les conversations que CE chat a réellement utilisées : deux chats
    // peuvent partager un projet, et la plus récente peut être un dossier vide
    // (relance coupée) ou un simple marqueur d'interruption.
    for (const candidate of input.bindings.chatRefs(input.chatId)) {
      const dir = conversationDir(input.profileDir, input.projectPath, candidate)
      if (dir === null) continue
      const found = lastAgentOutput(dir)
      if (!hasAgentContent(found)) continue
      picked = { ref: candidate, output: found, updatedAt: messageMtime(dir) }
      break
    }
    if (picked === null) {
      const latest = latestAgentOutput(input.profileDir, input.projectPath)
      if (latest === null) {
        return {
          content:
            `Aucune conversation Freebuff enregistrée pour \`${input.projectPath}\` : ` +
            'il n\'y a rien à récupérer.',
        }
      }
      picked = {
        ref: latest.conversation.ref,
        output: latest.output,
        updatedAt: latest.conversation.updatedAt,
      }
    }
  } else {
    if (!isConversationRef(argument)) {
      return { content: `Référence de conversation invalide : « ${argument} ».` }
    }
    const dir = conversationDir(input.profileDir, input.projectPath, argument)
    const found = dir === null ? null : lastAgentOutput(dir)
    if (found === null || !hasAgentContent(found)) {
      const detail = found?.error == null ? '' : ` (tour coupé : ${found.error})`
      return {
        content: `Aucun texte d'agent dans la conversation \`${argument}\`${detail} : rien à récupérer.`,
      }
    }
    picked = { ref: argument, output: found, updatedAt: messageMtime(dir as string) }
  }

  const when =
    picked.updatedAt === null ? '' : ` — écrite le ${new Date(picked.updatedAt).toLocaleString('fr-FR')}`
  const cut = picked.output.error === null ? '' : `\n\n> ⚠️ Tour coupé : ${picked.output.error}`
  const rendered = renderAgentOutput(picked.output, RECOVER_MAX_CHARS)

  return {
    content: [
      `**Récupéré depuis Freebuff** — conversation \`${picked.ref}\`${when}.${cut}`,
      '',
      rendered.markdown,
      '',
      '---',
      '_Lu sur le disque par le pont : aucun tour consommé, aucune CLI lancée. ' +
        '`/recover <ref>` lit une autre conversation du projet._',
    ].join('\n'),
  }
}

function errorBody(message: string, code: string): Record<string, unknown> {
  return { error: { message, type: 'invalid_request_error', code } }
}

/**
 * Un tour réel. La session est préparée AVANT les en-têtes SSE : un refus de
 * quota doit arriver comme une erreur HTTP propre, pas comme un flux vide.
 */
/** Réponse de texte simple : confirmation de binding, sans toucher à la CLI. */
function textCompletion(
  reply: FastifyReply,
  input: { model: string; stream: boolean; content: string; reasoning?: string },
): unknown {
  const message = {
    role: 'assistant',
    content: input.content,
    ...(input.reasoning ? { reasoning_content: input.reasoning } : {}),
  }
  const id = `chatcmpl-${crypto.randomUUID()}`
  const created = Math.floor(Date.now() / 1000)

  if (!input.stream) {
    return reply.send({
      id,
      object: 'chat.completion',
      created,
      model: input.model,
      choices: [{ index: 0, message, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })
  }

  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  })

  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null): Record<string, unknown> => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model: input.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })

  reply.raw.write(`data: ${JSON.stringify(chunk(message))}\n\n`)
  reply.raw.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`)
  reply.raw.write('data: [DONE]\n\n')
  reply.raw.end()
  return reply
}

/**
 * Le premier message d'un chat décide de son projet.
 *
 * Modèle `freebuff-new` : le message EST un chemin. On le valide, on le range,
 * et on répond sans lancer la CLI — lier ne doit pas coûter un tour.
 * Tout autre modèle sur un chat non lié est refusé : deviner le projet serait
 * pire que demander.
 */
async function chatThroughBinding(
  host: SessionHost,
  bindings: Bindings,
  journal: Journal,
  turns: TurnCache,
  turnLog: TurnLog,
  notifier: Notifier,
  profileDir: string,
  input: {
    model: string
    stream: boolean
    prompt: string
    messages: ChatMessage[]
    chatId: string | null
    /** Le client sait dessiner la carte `ask_user` (OpenWebUI récent). */
    askTool: boolean
    /** Réponse à la carte précédente, livrée en message `tool`. */
    toolAnswer: string | null
  },
  reply: FastifyReply,
): Promise<unknown> {
  // Un `npm run import:owui` peut avoir lié ce chat depuis le démarrage.
  bindings.refresh()

  if (input.chatId === null) {
    return reply
      .code(400)
      .send(
        errorBody(
          "en-tête x-openwebui-chat-id absent : impossible de lier ce chat à un projet. " +
            'Active ENABLE_FORWARD_USER_INFO_HEADERS=true dans OpenWebUI.',
          'no_chat_id',
        ),
      )
  }

  let bound = bindings.get(input.chatId)
  if (bound === null) {
    // Conversation encore vide au moment du choix du dossier : OpenWebUI ne
    // crée l'id du chat qu'au premier message. Ce message consomme le dossier
    // retenu, pas un autre — la sélection ne s'applique qu'une fois.
    try {
      bound = bindings.takePending(input.chatId)
    } catch (error) {
      return reply
        .code(503)
        .send(errorBody(error instanceof Error ? error.message : String(error), 'bindings_unreadable'))
    }
    if (bound !== null) {
      console.log(`[binding] chat=${input.chatId} projet=${bound} (dossier retenu)`)
      journal.write('binding', { chatId: input.chatId, projectPath: bound, source: 'pending' })
    }
  }
  if (bound !== null) {
    // `/import` est une commande du pont : elle liste ou affiche une
    // conversation déjà faite, sans lancer la CLI et sans consommer de tour.
    if (isImportCommand(input.prompt)) {
      const answer = importInChat({
        bindings,
        profileDir,
        chatId: input.chatId,
        projectPath: bound,
        prompt: input.prompt,
      })
      journal.write('import_command', { chatId: input.chatId, projectPath: bound })
      return textCompletion(reply, {
        model: input.model,
        stream: input.stream,
        content: answer.content,
      })
    }

    // `/recover` relit la dernière sortie de l'agent sur le disque : utile
    // quand le tour n'a pas livré sa réponse et que la session est fermée.
    if (isRecoverCommand(input.prompt)) {
      const answer = recoverInChat({
        bindings,
        chatId: input.chatId,
        profileDir,
        projectPath: bound,
        prompt: input.prompt,
      })
      journal.write('recover_command', { chatId: input.chatId, projectPath: bound })
      return textCompletion(reply, {
        model: input.model,
        stream: input.stream,
        content: answer.content,
      })
    }

    // Réponse à une carte de question : ce n'est pas un nouveau tour, c'est la
    // suite du tour en attente. Aucune comparaison de signatures ici — la liste
    // est identique à celle du tour stoppé sur la question.
    if (input.toolAnswer !== null) {
      // « Autres options… » : on renvoie la carte suivante, sans rien presser
      // dans la TUI — le panneau attend toujours la vraie réponse.
      const panel = turns.panels.get(input.chatId) ?? null
      const stage = turns.stages.get(input.chatId) ?? 0
      if (input.toolAnswer === MORE_OPTIONS_LABEL && panel !== null) {
        const next = panelArguments(panel, stage + 1)
        if (next !== null) {
          turns.stages.set(input.chatId, stage + 1)
          return cardReply(reply, { model: input.model, stream: input.stream, args: next })
        }
      }

      turns.panels.delete(input.chatId)
      turns.stages.delete(input.chatId)

      return agentCompletion(
        host,
        bindings,
        journal,
        turns,
        turnLog,
        notifier,
        {
          model: input.model,
          stream: input.stream,
          prompt: input.toolAnswer,
          chatId: input.chatId,
          projectPath: bound,
          choice: resolveModelChoice(input.model, profileDir),
          signatures: threadSignatures(input.messages),
          askTool: input.askTool,
          // Une réponse à une question poursuit le tour en cours : elle ne
          // reprend pas une autre conversation par-dessus.
          resumeRef: null,
          messages: input.messages,
        },
        reply,
      )
    }

    // Une réponse de l'agent n'est pas une consigne : rien à lancer.
    if (waitsForInstruction(input.messages)) {
      return textCompletion(reply, {
        model: input.model,
        stream: input.stream,
        content:
          '**En attente de consigne.** Le dernier message de ce fil est une réponse de ' +
          "l'agent : écris un nouveau message pour lancer un tour. Aucun tour n'a été lancé.",
      })
    }

    const choice = resolveModelChoice(input.model, profileDir)
    if (choice === null && !isNewProjectModel(input.model)) {
      return reply
        .code(400)
        .send(
          errorBody(
            `modèle inconnu : « ${input.model} » n'est ni « freebuff-new » ni un modèle de ` +
              'data/models.json. Ajoute-le à ce fichier ou choisis un modèle existant.',
            'unknown_model',
          ),
        )
    }

    const signatures = threadSignatures(input.messages)

    // La MÊME liste renvoyée (rechargement de page, « Régénérer ») n'est pas
    // une nouvelle consigne : si ce tour est encore en vol, on attend CE tour ;
    // s'il est fini, on rend sa réponse. Sinon OpenWebUI relance à chaque
    // rafraîchissement et le fil reste bloqué sur une réponse inachevée.
    const replay = await replayTurn(turns, input.chatId, signatures)
    if (replay !== null) {
      return textCompletion(reply, {
        model: input.model,
        stream: input.stream,
        content: replay.text,
        reasoning: replay.reasoning,
      })
    }

    const verdict = compareThread(bindings.signatures(input.chatId), signatures)
    if (verdict === 'regeneration') {
      // Le cache du pont ne survit pas à un redémarrage : on relit alors la
      // réponse dans le transcript de la CLI, re-rendue par le code courant
      // (c'est ce qui fait apparaître les liens de suggestions sur un tour
      // d'avant la mise à jour). Aucun tour lancé, aucun quota consommé.
      const projectPath = input.chatId === null ? null : bindings.get(input.chatId)
      const chatId = input.chatId
      const replayed =
        projectPath === null || chatId === null
          ? null
          : transcriptAnswer({
              profileDir,
              projectPath,
              prompt: input.prompt,
              followupUrl: prompt => followupLink(chatId, Date.now(), prompt),
            })
      if (replayed !== null) {
        // Pas de mise en cache : relire le transcript à chaque régénération
        // remet des jetons frais aux liens de suggestions (ils durent 10 min).
        journal.write('turn_replayed', { chatId: input.chatId })
        return textCompletion(reply, {
          model: input.model,
          stream: input.stream,
          content: replayed,
        })
      }
      return reply.code(409).send(
        errorBody(
          'régénération refusée : la réponse vient d’une session Freebuff déjà lancée, que le pont ' +
            "ne rejoue pas. Aucun tour n'a été lancé ; écris un nouveau message. Un simple " +
            'changement de modèle prend effet au prochain lancement de la CLI (redémarre le pont).',
          'regeneration_refused',
        ),
      )
    }
    return agentCompletion(
      host,
      bindings,
      journal,
      turns,
      turnLog,
      notifier,
      {
        model: input.model,
        stream: input.stream,
        prompt: input.prompt,
        chatId: input.chatId,
        projectPath: bound,
        choice,
        signatures,
        askTool: input.askTool,
        resumeRef: bindings.resumeRef(input.chatId),
        messages: input.messages,
      },
      reply,
    )
  }

  if (isNewProjectModel(input.model)) {
    if (!input.prompt.trim()) {
      return reply.code(400).send(errorBody('envoie un chemin absolu vers un dossier.', 'empty_message'))
    }

    const verdict = normalizeProjectPath(input.prompt, config.projectsRoot)
    if (!verdict.ok) {
      return reply.code(400).send({
        ...errorBody(verdict.reason, 'invalid_project_path'),
        recent: bindings.recent(),
      })
    }

    try {
      bindings.set(input.chatId, verdict.path)
    } catch (error) {
      return reply
        .code(503)
        .send(errorBody(error instanceof Error ? error.message : String(error), 'bindings_unreadable'))
    }

    console.log(`[binding] chat=${input.chatId} projet=${verdict.path}`)
    journal.write('binding', { chatId: input.chatId, projectPath: verdict.path })
    return textCompletion(reply, {
      model: input.model,
      stream: input.stream,
      content:
        `Projet lié : \`${verdict.path}\`.\n\n` +
        "Envoie ton message : l'agent travaillera dans ce dossier, dans une session Freebuff " +
        'gardée ouverte pour ce chat. Chaque projet a la sienne, et plusieurs chats sur des ' +
        'projets différents peuvent tourner en parallèle. Lier un chat ne consomme aucun tour.\n\n' +
        '**`/import`** liste les conversations déjà faites sur ce projet ; `/import 2` en affiche ' +
        'une et le message suivant la reprend côté Freebuff (aucun tour pour l\'affichage).',
    })
  }

  return reply.code(400).send({
    ...errorBody(
      "ce chat n'est lié à aucun projet. Choisis le modèle « Freebuff · Nouveau projet » " +
        'puis envoie un chemin absolu, par exemple D:/code/mon-projet.',
      'chat_unbound',
    ),
    recent: bindings.recent(),
  })
}

async function agentCompletion(
  host: SessionHost,
  bindings: Bindings,
  journal: Journal,
  turns: TurnCache,
  turnLog: TurnLog,
  notifier: Notifier,
  input: {
    model: string
    stream: boolean
    prompt: string
    chatId: string
    projectPath: string
    /** Sélection à écrire avant le lancement, ou `null` pour ne rien changer. */
    choice: ModelChoice | null
    /** Signature du fil envoyé : enregistrée seulement si le tour aboutit. */
    signatures: string[]
    /** Répondre par la carte native plutôt que par du texte numéroté. */
    askTool: boolean
    /** Conversation à reprendre avant ce tour (`/import`), ou `null`. */
    resumeRef: string | null
    /** Fil OpenWebUI complet : sert à rejouer le contexte dans une CLI neuve. */
    messages: ChatMessage[]
  },
  reply: FastifyReply,
): Promise<unknown> {
  if (!input.prompt.trim()) {
    return reply.code(400).send(errorBody('message utilisateur vide', 'empty_message'))
  }

  const model = input.choice ?? undefined
  const continueRef = input.resumeRef ?? undefined
  /** La session de CETTE conversation : le dossier seul ne l'identifie plus. */
  const ref = sessionRef(input.chatId, input.projectPath)

  /**
   * Ce qui sera réellement écrit dans la CLI.
   *
   * Une CLI NEUVE n'a pas le fil : il vivait dans la précédente. On le rejoue
   * pour la première consigne d'une session fraîche (bascule de compte,
   * redémarrage du pont, session morte relancée), sauf si la session REPREND
   * une conversation de la CLI (`--continue`), qui porte déjà son contexte.
   */
  let prompt = input.prompt

  /**
   * Lien d'une suggestion de suite (`🔧 suggest_followups`) : cliquer envoie à
   * la CLI le prompt qu'elle a préparé, sans le recopier.
   *
   * L'horodatage du jeton est figé au PREMIER rendu du tour : le flux et le
   * rendu final doivent produire exactement la même URL, sinon le texte final
   * ne prolongerait plus ce qui est déjà parti. Il démarre donc quand les
   * liens apparaissent, pas au début d'un tour qui peut durer une heure.
   */
  let followupAt: number | null = null
  const followupUrl = (prompt: string): string => {
    followupAt ??= Date.now()
    return followupLink(input.chatId, followupAt, prompt)
  }

  /**
   * Lance le tour et le rend visible à `replayTurn` : un rechargement pendant le
   * tour attend CE tour au lieu d'en lancer un second (une TUI n'a qu'une zone
   * de saisie, et un second prompt consommerait un tour de plus).
   */
  const runTurn = (
    onDelta: (text: string) => void,
    onThought?: (text: string) => void,
  ): Promise<TurnResult> => {
    const run = host.use(
      ref,
      session => session.send(prompt, onDelta, onThought, { followupUrl }),
      model,
      continueRef,
    )
    turns.inFlight.set(input.chatId, { signatures: input.signatures, result: run })
    const clear = (): void => {
      if (turns.inFlight.get(input.chatId)?.result === run) turns.inFlight.delete(input.chatId)
    }
    run.then(clear, clear)
    return run
  }

  // Un refus ne doit pas enregistrer la signature : l'utilisateur doit pouvoir
  // réessayer la même consigne après avoir corrigé la cause.
  const record = (result: TurnResult): void => {
    // `question` compte : le message suivant répond à la question, il prolonge
    // donc bien le fil (sans quoi il serait refusé comme une régénération).
    if (result.finish !== 'ok' && result.finish !== 'timeout' && result.finish !== 'question') return
    if (result.text) {
      turns.answers.set(input.chatId, {
        signatures: input.signatures,
        text: result.text,
        reasoning: result.reasoning,
      })
    }
    try {
      bindings.recordTurn(input.chatId, input.signatures)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[signature] non enregistrée pour ${input.chatId} : ${message}`)
      journal.write('signature_error', { chatId: input.chatId, message })
    }
    // La conversation que ce chat vient d'utiliser : `/recover` doit lire la
    // sienne, pas celle d'un autre chat du même projet. Jamais bloquant.
    const usedChatRef =
      host.statuses().find(status => status.key === ref.key)?.chatRef ?? null
    if (usedChatRef !== null) {
      try {
        bindings.recordChatRef(input.chatId, usedChatRef)
      } catch (error) {
        journal.write('chat_ref_error', {
          chatId: input.chatId,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  /**
   * Fin commune aux deux modes (flux et non-flux) : lien Continuer pour une
   * session terminée, trace dans `turns.jsonl`, indicateur d'onglet.
   *
   * Le lien est ajouté AVANT `record` et avant le filet de fin de flux : le
   * texte streamé doit se prolonger exactement par ce qui est envoyé.
   */
  const finishTurn = (result: TurnResult): TurnResult => {
    if (result.finish === 'session_ended') {
      const token = signActionToken(config.apiKey, input.chatId)
      const url = `http://127.0.0.1:${String(config.port)}/a/continue?t=${encodeURIComponent(token)}`
      result.text = `${result.text}\n\n**[▶ Continuer](${url})** — ou écris \`continue\` dans le chat.`
    }
    const record = recordOf({
      chatId: input.chatId,
      projectPath: input.projectPath,
      outcome: result.finish,
      failure: result.failure ?? null,
    })
    turnLog.append(record)
    turns.attention.set(input.chatId, { at: Date.now(), outcome: result.finish })
    notifier.notify(record, result.failure?.message ?? null)
    return result
  }

  try {
    const status = await host.ready(ref, model, continueRef)
    // `chatRef` n'est posé qu'une fois un prompt ACCEPTÉ par la CLI : sans lui,
    // cette session n'a encore rien reçu, donc rien ne porte le fil.
    if (status.chatRef === null && continueRef === undefined) {
      prompt = promptWithContext(input.prompt, input.messages, MAX_PROMPT_CHARS) ?? input.prompt
      if (prompt !== input.prompt) {
        journal.write('context_replay', {
          chatId: input.chatId,
          messages: input.messages.length,
          chars: prompt.length,
        })
      }
    }
  } catch (error) {
    if (error instanceof SettingsUnreadable) {
      return reply.code(400).send(errorBody(error.message, 'settings_unreadable'))
    }
    if (error instanceof SessionStuck) {
      return reply.code(503).send(errorBody(error.message, 'session_stuck'))
    }
    if (error instanceof SessionRefused) {
      return reply
        .code(refusalStatus(error.code))
        .send(errorBody(error.message, error.code))
    }
    if (error instanceof SessionGone) {
      return reply.code(503).send(errorBody(error.message, 'session_gone'))
    }
    if (error instanceof TooManySessions) {
      return reply.code(429).send(errorBody(error.message, 'too_many_sessions'))
    }
    throw error
  }

  const id = `chatcmpl-${crypto.randomUUID()}`
  const created = Math.floor(Date.now() / 1000)

  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null): Record<string, unknown> => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model: input.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })

  if (!input.stream) {
    const result = finishTurn(await runTurn(() => {}))
    if (result.finish === 'stopped') {
      return reply
        .code(409)
        .send(errorBody('tour arrêté : la session Freebuff a été fermée.', 'stopped'))
    }
    if (!result.text && result.finish !== 'ok') {
      return reply
        .code(refusalStatus(result.refusal))
        .send(errorBody(`tour non abouti (${result.finish})`, result.finish))
    }
    record(result)

    if (result.finish === 'question' && result.panel !== null && result.panel !== undefined) {
      turns.panels.set(input.chatId, result.panel)
      turns.stages.set(input.chatId, 0)
    }

    const toolCall = input.askTool && result.finish === 'question' ? panelArguments(result.panel) : null
    if (toolCall !== null) {
      return reply.send({
        id,
        object: 'chat.completion',
        created,
        model: input.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              // Le texte écrit avant la question voyage avec la carte : elle ne
              // porte que la question, donc sans lui il était perdu.
              content: result.head ?? '',
              tool_calls: [
                {
                  id: `call_${crypto.randomUUID()}`,
                  type: 'function',
                  function: { name: ASK_TOOL, arguments: JSON.stringify(toolCall) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      })
    }

    return reply.send({
      id,
      object: 'chat.completion',
      created,
      model: input.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: result.text,
            ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })
  }

  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  })

  let closed = false
  let finished = false
  reply.raw.on('close', () => {
    closed = true
    // Page rechargée pendant le tour : on laisse le tour FINIR au lieu de
    // tuer la session. Il est déjà lancé (le quota est consommé) ; le tuer
    // perdait la réponse et laissait OpenWebUI relancer à chaque
    // rafraîchissement. La réponse est gardée et rejouée à la reconnexion.
    if (finished) return
    journal.write('turn_detached', { chatId: input.chatId })
  })

  const send = (payload: Record<string, unknown>): void => {
    if (!closed) reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`)
  }

  send(chunk({ role: 'assistant', content: '' }))

  // Pendant la réflexion, la TUI n'affiche encore aucun texte de réponse : sans
  // cet indicateur, OpenWebUI reste muet. Il part UNE fois, et seulement si
  // aucun texte n'est arrivé avant : sinon il s'insérerait au milieu de la
  // réponse, puisque le flux progressif commence en même temps.
  let contentSeen = false
  const activity = setTimeout(() => {
    if (closed || finished || contentSeen) return
    send(chunk({ content: '_⏳ Tour en cours — Freebuff travaille…_\n\n' }))
  }, config.activityAfterMs)
  activity.unref()

  let streamedText = ''
  let streamedReasoning = ''
  try {
    const result = finishTurn(
      await runTurn(
        delta => {
        if (!contentSeen) {
          contentSeen = true
          clearTimeout(activity)
        }
        streamedText += delta
        send(chunk({ content: delta }))
      },
      // La réflexion part dans `reasoning_content` : OpenWebUI l'affiche
      // repliée au-dessus de la réponse, au lieu de la mélanger au texte.
        thought => {
          streamedReasoning += thought
          send(chunk({ reasoning_content: thought }))
        },
      ),
    )
    record(result)

    if (result.finish === 'question' && result.panel !== null && result.panel !== undefined) {
      turns.panels.set(input.chatId, result.panel)
      turns.stages.set(input.chatId, 0)
    }

    // Filet : le tour peut rendre du texte sans l'avoir émis en delta (le
    // transcript est écrit d'un coup, S1). On envoie le reste — jamais en
    // double, et seulement si le texte prolonge exactement ce qui est parti.
    if (result.reasoning.length > streamedReasoning.length && result.reasoning.startsWith(streamedReasoning)) {
      send(chunk({ reasoning_content: result.reasoning.slice(streamedReasoning.length) }))
    }
    const toolCall = input.askTool && result.finish === 'question' ? panelArguments(result.panel) : null
    if (toolCall !== null) {
      // Le préambule (texte écrit avant la question) part comme contenu : la
      // carte ne porte que la question, donc sans lui il était perdu (vu en
      // réel le 23/10). Rien n'est renvoyé s'il est déjà parti en pas-à-pas.
      if (result.head !== undefined && result.head.startsWith(streamedText) && result.head.length > streamedText.length) {
        send(chunk({ content: result.head.slice(streamedText.length) }))
        streamedText = result.head
      }
      // La carte native d'OpenWebUI porte la question, les options et leurs
      // descriptions ; la réponse reviendra en message `tool`.
      send(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: `call_${crypto.randomUUID()}`,
              type: 'function',
              function: { name: ASK_TOOL, arguments: JSON.stringify(toolCall) },
            },
          ],
        }),
      )
    } else if (result.finish === 'question') {
      // La question est écrite par le pont, pas par l'agent : elle n'est jamais
      // dans le flux de l'écran. Le préambule, lui, est déjà parti en pas-à-pas
      // quand il était disponible : on n'ajoute que ce qui manque, jamais deux
      // fois le même texte.
      const missing = result.text.startsWith(streamedText)
        ? result.text.slice(streamedText.length)
        : `\n\n${result.text}`
      send(chunk({ content: missing }))
    } else if (result.text.length > streamedText.length && result.text.startsWith(streamedText)) {
      send(chunk({ content: result.text.slice(streamedText.length) }))
    }
    finished = true

    if (toolCall !== null) {
      send(chunk({}, 'tool_calls'))
    } else if (result.finish === 'stopped') {
      send(chunk({ content: '\n\n_(tour arrêté : la session Freebuff a été fermée)_' }))
      send(chunk({}, 'stop'))
    } else if (result.finish === 'refused' && result.refusal !== null) {
      // Le refus a un code précis (modèle trop cher, sessions, modèles) : son
      // message explique quoi faire. « tour non abouti (refused) » ne dit rien.
      send(errorBody(REFUSAL_MESSAGES[result.refusal], result.refusal))
    } else if (result.finish === 'refused' || result.finish === 'died' || result.finish === 'not_accepted') {
      send(errorBody(`tour non abouti (${result.finish})`, result.finish))
    } else {
      if (result.finish === 'timeout') {
        send(
          chunk({
            content:
              '\n\n_(plus rien reçu de Freebuff : le tour est peut-être bloqué dans la CLI — ' +
              "renvoie un message pour relancer)_",
          }),
        )
      }
      send(chunk({}, 'stop'))
    }
  } catch (error) {
    finished = true
    send(errorBody(error instanceof Error ? error.message : String(error), 'turn_failed'))
  } finally {
    clearTimeout(activity)
  }

  if (!closed) {
    reply.raw.write('data: [DONE]\n\n')
    reply.raw.end()
  }
  return reply
}

export interface BridgeOverrides {
  /** Ouvre la session : remplacé par une session factice dans les tests HTTP. */
  openSession?: (projectDir: string, continueRef?: string) => Promise<AgentSession>
  /** Sonde de quota : remplacée dans les tests, qui ne lancent aucune TUI. */
  quotaProbe?: (options: { bin: string; profileDir: string; cwd: string }) => Promise<{
    quota: { found: boolean; remainingHours: number | null; totalHours: number | null; exhausted: boolean }
    refusal: string | null
  } | null>
  bindingsFile?: string
  /** Binaire affiché par le diagnostic (les tests simulent un binaire absent). */
  freebuffBin?: string
  /** Profil affiché par le diagnostic (les tests simulent un profil absent). */
  profileDir?: string
  /** Limite de sessions vivantes (les tests veulent un refus sans ouvrir trois projets). */
  maxSessions?: number
  /** Toast de fin de tour : remplacé dans les tests, qui n'envoient rien au bureau. */
  notify?: (toast: Toast) => void
  /** Démarre l'import périodique (PRD US-05). Faux dans les tests HTTP. */
  autoImport?: boolean
  /** Planificateur injecté (tests) : ses cycles sont pilotés par le test. */
  importScheduler?: ImportScheduler
}

/** Code d'erreur lu dans un corps de refus, pour le diagnostic. */
function refusalCodeOf(payload: unknown): string {
  if (typeof payload !== 'string') return 'unknown'
  try {
    const parsed = JSON.parse(payload) as { error?: { code?: unknown } }
    return typeof parsed.error?.code === 'string' ? parsed.error.code : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Intervalle minimal entre deux relectures du quota dans une session.
 *
 * La barre d'OpenWebUI appelle `/api/quota` en boucle : sans ce plancher, le
 * pont taperait `/model` dans la TUI à chaque passage. Une heure de quota ne
 * bouge qu'à la fin d'un tour, donc relire plus souvent n'apprend rien.
 */
const QUOTA_REFRESH_MS = 5 * 60_000

/** Relit la dernière lecture de quota ; un fichier absent ou douteux ne bloque pas. */
function loadQuotaSnapshot(file: string): QuotaSnapshot | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<QuotaSnapshot>
    const hours = (value: unknown): boolean => value === null || typeof value === 'number'
    if (
      !hours(parsed.remainingHours) ||
      !hours(parsed.totalHours) ||
      typeof parsed.exhausted !== 'boolean' ||
      typeof parsed.at !== 'number' ||
      (parsed.source !== 'session' && parsed.source !== 'probe')
    ) {
      return null
    }
    return parsed as QuotaSnapshot
  } catch {
    return null
  }
}

export function buildServer(overrides: BridgeOverrides = {}): FastifyInstance {
  /**
   * Profil supervisé — MUTABLE depuis la bascule (`POST /api/profile`).
   *
   * Une seule valeur : la CLI ne change pas de compte à chaud, donc une
   * bascule ferme toutes les sessions et les suivantes s'ouvrent ailleurs.
   * Tout ce qui lit un fichier de profil (settings, quota, historique) passe
   * par ici, jamais par `config.profileDir` figé au démarrage.
   */
  let currentProfile = overrides.profileDir ?? config.profileDir
  const settingsFor = (): ModelSettings => new ModelSettings(path.join(currentProfile, 'settings.json'))
  const journal = new Journal({ dir: path.join(config.dataDir, 'logs') })
  const host = new SessionHost(
    overrides.openSession ??
      ((projectDir, continueRef) =>
        FreebuffSession.start({
          projectDir,
          profileDir: currentProfile,
          // Résolu à chaque ouverture : une bascule change de profil, donc de
          // binaire, sans redémarrer le pont.
          bin: resolveFreebuffBin(currentProfile),
          continueRef,
        })),
    // Écriture paresseuse : après une bascule, le prochain lancement écrit dans
    // le `settings.json` du NOUVEAU profil, pas dans celui du départ.
    { set: choice => settingsFor().set(choice) },
    {
      // Une bascule de modèle ferme puis relance la CLI : c'est une session de
      // quota qui s'arrête, ça doit rester lisible dans le journal.
      onModelSwitch: (from, to, pid) => journal.write('model_switch', { from, to, pid }),
      // Reprendre une conversation la relance aussi, avec `--continue`.
      onResume: (ref, pid) => journal.write('session_resume', { ref, pid }),
    },
    { limit: overrides.maxSessions ?? config.maxSessions },
  )
  const bindings = new Bindings(overrides.bindingsFile ?? path.join(config.dataDir, 'bindings.json'))
  const bin = (): string => overrides.freebuffBin ?? resolveFreebuffBin(currentProfile)

  /**
   * Import périodique : les nouvelles conversations du disque apparaissent
   * dans OWUI sans commande. Le client est recréé à chaque cycle pour qu'une
   * clé OWUI ajoutée après le démarrage soit prise en compte, et le `bindings`
   * est celui du pont : un chat importé est immédiatement reprenable.
   */
  const importFile = path.join(config.dataDir, 'imports.json')
  const runImportCycle = async (): Promise<void> => {
    const apiKey = resolveOwuiKey(config.dataDir)
    if (apiKey === null) {
      throw new Error('clé API OWUI absente (data/owui-key.txt) : import suspendu')
    }
    const outcome = await runImport({
      dataFile: importFile,
      profiles: profileList(process.env.BRIDGE_IMPORT_PROFILES, os.homedir(), currentProfile),
      client: createOwuiClient({ baseUrl: config.owuiBaseUrl, apiKey }),
      model: process.env.BRIDGE_IMPORT_MODEL?.trim() || DEFAULT_ARCHIVE_MODEL,
      projectsRoot: config.projectsRoot,
      currentProfile,
      bindings,
    })
    journal.write('import_cycle', {
      scanned: outcome.report.scanned,
      created: outcome.report.created,
      updated: outcome.report.updated,
      stale: outcome.report.stale,
      errors: outcome.report.errors.length,
    })
  }
  const importScheduler =
    overrides.importScheduler ??
    new ImportScheduler({
      intervalMs: overrides.autoImport === true ? config.importIntervalMs : 0,
      run: runImportCycle,
      onError: error => {
        journal.write('import_cycle_failed', {
          message: error instanceof Error ? error.message : String(error),
        })
      },
    })
  const importSnapshot = (): ImportHealth => {
    const base = importHealth(importFile)
    return {
      ...base,
      enabled: importScheduler.enabled,
      intervalMs: importScheduler.intervalMs,
      lastRunAt: importScheduler.lastRunAt ?? base.lastRunAt,
      lastError: importScheduler.lastError ?? base.lastError,
    }
  }
  /** Tours du processus : ni réponse rejouée, ni prompt relancé par erreur. */
  const turns: TurnCache = {
    answers: new Map(),
    inFlight: new Map(),
    panels: new Map(),
    stages: new Map(),
    attention: new Map(),
  }
  /** Journal append-only des tours, et jetons d'action déjà consommés. */
  const turnLog = new TurnLog(path.join(config.dataDir, 'turns.jsonl'))
  /** Toast de fin de tour : réel sur Windows, silencieux dans les tests. */
  const notifier = new Notifier(overrides.notify ?? null)
  const usedActionTokens = new Set<string>()

  // Dernier refus depuis le démarrage : assez pour diagnostiquer, sans écrire
  // de fichier supplémentaire.
  let lastRefusal: RefusalRecord | null = null

  /** Identité du modèle réellement lancé, clé prioritaire comme dans la CLI. */
  const activeModel = (): string | null => {
    const written = settingsFor().readChoice()
    return written === null ? null : written.key ?? written.id
  }

  /**
   * Dernier quota LU (jamais estimé) : bandeau d'une session ou sonde.
   *
   * `source` et `at` permettent de juger la fraîcheur : le pont ne relance pas
   * de TUI tout seul, il ne fait que conserver la dernière lecture.
   */
  /**
   * Dernière lecture connue, rechargée au démarrage.
   *
   * Sans ce fichier, la barre de quota d'OpenWebUI perdait son chiffre à chaque
   * relance du pont (la lecture ne vivait qu'en mémoire). `at` et `source`
   * restent dans la réponse : l'interface affiche l'âge de la lecture.
   */
  const quotaFile = path.join(config.dataDir, 'quota.json')
  let quotaReading: QuotaSnapshot | null = loadQuotaSnapshot(quotaFile)
  let quotaProbing = false
  const readQuota = overrides.quotaProbe ?? probeQuota
  const quotaSnapshot = (view: QuotaView, source: 'session' | 'probe'): QuotaSnapshot => ({
    remainingHours: view.remainingHours,
    totalHours: view.totalHours,
    exhausted: view.exhausted,
    at: Date.now(),
    source,
  })
  /** Enregistre la lecture : la barre la retrouve au prochain démarrage. */
  const rememberQuota = (view: QuotaView, source: 'session' | 'probe'): void => {
    quotaReading = quotaSnapshot(view, source)
    try {
      fs.writeFileSync(quotaFile, JSON.stringify(quotaReading), 'utf8')
    } catch {
      // Disque indisponible : la barre marche encore pour cette exécution.
    }
  }

  /**
   * Relit le quota du compte dans une session VIVANTE, en tapant `/model`.
   *
   * Le bandeau d'ouverture d'une session ne bouge plus : elle continuait donc
   * à annoncer les heures du démarrage après plusieurs tours. Le panneau
   * `/model` écrit le bilan courant ; on le lit puis on le referme. Aucun tour
   * consommé, aucun modèle changé, aucune TUI lancée (la session existe déjà),
   * une seule relecture à la fois et pas plus d'une par `QUOTA_REFRESH_MS` :
   * `/api/quota` est appelé en boucle par la barre.
   */
  let quotaRefreshAt = 0
  let quotaRefreshing = false
  const refreshQuotaInSession = (ref: SessionRef): void => {
    if (quotaRefreshing) return
    if (Date.now() - quotaRefreshAt < QUOTA_REFRESH_MS) return
    quotaRefreshAt = Date.now()
    quotaRefreshing = true
    void host
      .useExisting(ref, session => session.refreshQuota?.() ?? Promise.resolve(null))
      .then(view => {
        if (view !== null && view.found) rememberQuota(view, 'session')
      })
      .catch(error => {
        journal.write('quota_refresh_failed', {
          message: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => {
        quotaRefreshing = false
      })
  }

  const healthSnapshot = (): HealthSnapshot => {
    // Un import manuel peut avoir écrit `bindings.json` : le compte affiché
    // doit être celui du disque, pas celui chargé au démarrage.
    bindings.refresh()
    return {
      ok: true,
      stub: config.stub,
      import: importSnapshot(),
      cli: cliStatus(bin()),
      profileDir: { path: currentProfile, exists: fs.existsSync(currentProfile) },
      // La CLI lit `freebuffModelKey` avant `freebuffModel` : c'est la clé qui
      // nomme le modèle réellement lancé.
      model: activeModel(),
      modelCost: modelCost(activeModel()),
      quota: quotaReading,
      models: listExposedModels(currentProfile).length,
      captureDir: config.captureDir,
      capture: config.capture,
      projectsRoot: config.projectsRoot,
      bindings: bindings.count(),
      bindingsError: bindings.readError,
      session: host.status(),
      sessions: host.statuses(),
      lastRefusal,
    }
  }

  /** Mesures déposées par la sonde de lancement, ou `null`. */
  const readProfileReport = (): ProfileReport | null => {
    try {
      return parseProfileReport(fs.readFileSync(profilesFile(config.dataDir), 'utf8'))
    } catch {
      return null
    }
  }

  /**
   * Profils que la bascule peut proposer.
   *
   * La détection du LANCEMENT (`scripts/pick-profile.ts` → `profiles.json`)
   * donne les heures sans relancer de TUI. À défaut de rapport, les profils
   * voisins du profil courant sont proposés SANS heures : jamais une valeur
   * inventée. `credentials.json` n'est que testé en existence — son contenu
   * n'est jamais lu (PRD §3.2).
   */
  const knownProfiles = (): ProfileReading[] => {
    const root = path.dirname(currentProfile)
    const candidates: ProfileReading[] = discoverProfiles(root)
      .filter(dir => profileKey(dir) !== profileKey(currentProfile))
      .map(dir => ({ name: path.basename(dir), path: dir, remainingHours: null, totalHours: null }))
    const merged = mergeProfileReport(readProfileReport(), candidates)
    if (!merged.some(reading => profileKey(reading.path) === profileKey(currentProfile))) {
      merged.unshift({
        name: path.basename(currentProfile),
        path: currentProfile,
        remainingHours: null,
        totalHours: null,
      })
    }
    return merged
  }

  const app = Fastify({
    logger: false,
    // Un historique OpenWebUI peut être volumineux (messages + fichiers joints).
    bodyLimit: 20 * 1024 * 1024,
  })

  // Fermer le pont ferme TOUTES les sessions : un `freebuff.exe` orphelin
  // garderait un slot occupé et le prochain démarrage se heurterait à la limite.
  app.addHook('onClose', async () => {
    importScheduler.stop()
    for (const stopped of host.stop()) {
      if (stopped.ok) continue
      journal.write('stop_failed', { pid: stopped.pid })
      console.error(`[stop] le processus ${stopped.pid} survit à taskkill`)
    }
  })

  // Un seul point d'enregistrement des refus : les routes n'ont pas à savoir
  // que le diagnostic existe.
  app.addHook('onSend', async (_request, reply, payload) => {
    if (reply.statusCode >= 400) {
      lastRefusal = { at: Date.now(), status: reply.statusCode, code: refusalCodeOf(payload) }
      journal.write('refusal', { status: lastRefusal.status, code: lastRefusal.code })
    }
    return payload
  })

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/v1/')) return
    const header = request.headers.authorization
    const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null
    const apiKey = typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'] : null
    if (bearer !== config.apiKey && apiKey !== config.apiKey) {
      return reply.code(401).send({
        error: { message: 'clé API du pont invalide', type: 'invalid_request_error', code: 'invalid_api_key' },
      })
    }
  })

  app.get('/', async () => ({
    service: 'freebuff-owui',
    message: "Ce port est l'API du pont, pas l'interface. Ouvre OpenWebUI sur http://127.0.0.1:8080.",
    endpoints: {
      health: '/health',
      diagnostic: '/diagnostic',
      models: '/v1/models',
      chat: '/v1/chat/completions',
    },
  }))

  app.get('/health', async request => {
    // Une session ouverte porte déjà le bandeau : lecture gratuite, sans
    // relancer la CLI. Sinon `?quota=1` lance une TUI sans consigne (aucune
    // heure consommée) ; sans ce drapeau, `/health` ne lance jamais rien.
    const live = host.quota()
    if (live !== null) quotaReading = quotaSnapshot(live, 'session')

    const wanted = (request.query as { quota?: unknown }).quota
    if (wanted === '1' && live === null && !config.stub && !quotaProbing) {
      quotaProbing = true
      try {
        const probe = await readQuota({
          bin: bin(),
          profileDir: currentProfile,
          cwd: path.join(config.dataDir, 'quota-probe'),
        })
        if (probe?.quota.found === true) rememberQuota(probe.quota, 'probe')
      } finally {
        quotaProbing = false
      }
    }

    return healthSnapshot()
  })

  // Sélecteur de projet injecté dans OpenWebUI : même origine (8080) vers le
  // pont (7799), donc CORS explicite pour ces deux routes seulement.
  const owuiOrigins = new Set(['http://127.0.0.1:8080', 'http://localhost:8080'])
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return
    const origin = request.headers.origin
    if (typeof origin === 'string' && owuiOrigins.has(origin)) {
      reply.header('access-control-allow-origin', origin)
      reply.header('access-control-allow-methods', 'GET, POST, OPTIONS')
      reply.header('access-control-allow-headers', 'content-type')
      reply.header('vary', 'origin')
    }
    if (request.method === 'OPTIONS') return reply.code(204).send()
  })

  /** Dossiers proposés par le sélecteur, sous `projectsRoot` uniquement. */
  app.get('/api/projects', async (request, reply) => {
    const query = request.query as { path?: unknown }
    const verdict = browseProjects(
      typeof query.path === 'string' && query.path.trim() !== '' ? query.path : undefined,
      config.projectsRoot,
    )
    if (!verdict.ok) {
      return reply.code(400).send({ error: { message: verdict.reason, code: 'invalid_project_path' } })
    }
    return verdict.browse
  })

  /**
   * Quota affiché AU-DESSUS de la saisie dans OpenWebUI.
   *
   * Rien n'est lancé ici : la valeur vient du pied de la TUI de la session
   * vivante (`left`), et à défaut de la dernière lecture enregistrée (`quota`,
   * bandeau d'une session ou sonde demandée par `/health?quota=1`) — y compris
   * celle d'avant le redémarrage du pont. `chatId` limite la lecture à la
   * session du projet lié à ce chat. Une relecture par `/model` est déclenchée
   * dans la session vivante (au plus une par `QUOTA_REFRESH_MS`), sans
   * attendre : la réponse rend tout de suite la dernière valeur connue.
   */
  app.get('/api/quota', async request => {
    const query = request.query as { chatId?: unknown }
    const chatId = typeof query.chatId === 'string' && query.chatId.trim() !== '' ? query.chatId : null
    const projectPath = chatId === null ? null : bindings.get(chatId)
    // La barre suit LA conversation ouverte, pas le dossier : deux chats sur le
    // même dossier ont deux sessions, donc deux décomptes.
    const ref = chatId === null || projectPath === null ? null : sessionRef(chatId, projectPath)
    const live = host.quota(ref ?? undefined)
    if (live !== null) rememberQuota(live, 'session')
    if (ref !== null) refreshQuotaInSession(ref)

    const left = host.sessionLeft(ref ?? undefined)
    return {
      at: Date.now(),
      left:
        left === null
          ? null
          : { minutes: left.minutes, totalMinutes: left.totalMinutes, at: left.at },
      quota: quotaReading,
      attention: chatId === null ? null : (turns.attention.get(chatId) ?? null),
    }
  })

  /**
   * Profils Freebuff proposés à la bascule, avec les heures mesurées au
   * LANCEMENT. Rien n'est sondé ici : quatre TUI prendraient une minute.
   */
  app.get('/api/profiles', async () => {
    const report = readProfileReport()
    return {
      current: path.basename(currentProfile),
      currentPath: currentProfile,
      detectedAt: report === null ? null : report.at,
      profiles: knownProfiles().map(reading => ({
        ...reading,
        current: profileKey(reading.path) === profileKey(currentProfile),
      })),
    }
  })

  /**
   * Bascule de profil : ferme TOUTES les CLI (elles tournent sur l'ancien
   * compte) et fait ouvrir les suivantes sur le nouveau.
   *
   * Refus si un tour est en cours : couper une CLI en pleine réponse perdrait
   * le tour et le quota déjà consommé. Le choix ne survit PAS au redémarrage :
   * au prochain lancement, la sonde redécide (PRD §3.2).
   */
  app.post('/api/profile', async (request, reply) => {
    const body = (request.body ?? {}) as { path?: unknown }
    if (typeof body.path !== 'string' || body.path.trim() === '') {
      return reply.code(400).send(errorBody('profil manquant', 'profile_missing'))
    }
    const wantedPath = body.path.trim()
    const wanted = knownProfiles().find(reading => profileKey(reading.path) === profileKey(wantedPath))
    if (wanted === undefined) {
      return reply
        .code(404)
        .send(errorBody('profil inconnu : la bascule ne propose que les profils détectés', 'profile_unknown'))
    }
    if (profileKey(wanted.path) === profileKey(currentProfile)) {
      return { ok: true, changed: false, profile: { ...wanted, current: true }, stopped: 0 }
    }
    if (turns.inFlight.size > 0) {
      return reply
        .code(409)
        .send(errorBody('un tour est en cours : la bascule fermerait sa CLI', 'profile_switch_busy'))
    }

    const from = currentProfile
    const stopped = host.stop()
    const stuck = stopped.filter(entry => entry.remaining)
    if (stuck.length > 0) {
      const pids = stuck.map(entry => entry.pid).join(', ')
      journal.write('profile_switch_stuck', { from, to: wanted.path, pids })
      return reply
        .code(409)
        .send(
          errorBody(
            `la CLI ${pids} survit à taskkill : profil inchangé, ferme ce processus puis réessaie`,
            'profile_switch_stuck',
          ),
        )
    }

    currentProfile = wanted.path
    // Ce qui appartenait à l'ancien compte ne le suit pas : lecture de quota,
    // questions en attente et pagination des cartes.
    quotaReading = null
    quotaRefreshAt = 0
    turns.panels.clear()
    turns.stages.clear()
    try {
      fs.rmSync(quotaFile, { force: true })
    } catch {
      // Disque indisponible : la valeur n'est plus affichée, c'est tout.
    }
    journal.write('profile_switch', { from, to: currentProfile, stopped: stopped.length })
    return { ok: true, changed: true, profile: { ...wanted, current: true }, stopped: stopped.length }
  })

  /**
   * Bouton « Continuer » : lien signé, usage unique, 10 minutes.
   *
   * Il relance la session si elle est morte — c'est une action explicite, donc
   * ce n'est pas le redémarrage silencieux que le PRD interdit — puis envoie
   * `continue`. La réponse du tour n'entre pas dans le fil OpenWebUI (le miroir
   * est la phase 5) ; l'indicateur d'onglet signale qu'il s'est passé quelque
   * chose.
   */
  app.get('/a/continue', async (request, reply) => {
    const query = request.query as { t?: unknown }
    if (typeof query.t !== 'string' || query.t === '') {
      return reply.code(410).send(errorBody('lien sans jeton', 'token_invalid'))
    }
    if (usedActionTokens.has(query.t)) {
      return reply.code(410).send(errorBody('ce lien a déjà servi', 'token_used'))
    }
    const verified = verifyActionToken(config.apiKey, query.t)
    if (verified === null) {
      return reply.code(410).send(errorBody('lien expiré ou invalide', 'token_invalid'))
    }

    const projectPath = bindings.get(verified.chatId)
    if (projectPath === null) {
      return reply.code(404).send(errorBody("ce chat n'est lié à aucun projet", 'chat_unbound'))
    }
    // La session visée est celle de CETTE conversation, pas du dossier.
    const ref = sessionRef(verified.chatId, projectPath)
    if (turns.inFlight.has(verified.chatId)) {
      return reply.code(409).send(errorBody('un tour est déjà en cours dans ce chat', 'turn_running'))
    }

    usedActionTokens.add(query.t)
    if (usedActionTokens.size > 1_000) usedActionTokens.clear()

    try {
      await host.restart(ref)
    } catch (error) {
      if (error instanceof TooManySessions) {
        return reply.code(429).send(errorBody(error.message, 'too_many_sessions'))
      }
      if (error instanceof SessionStuck) {
        return reply.code(503).send(errorBody(error.message, 'session_stuck'))
      }
      if (error instanceof SessionRefused) {
        return reply.code(refusalStatus(error.code)).send(errorBody(error.message, error.code))
      }
      throw error
    }

    const run = host.use(ref, session => session.send('continue', () => {}))
    turns.inFlight.set(verified.chatId, { signatures: [], result: run })
    const clear = (): void => {
      if (turns.inFlight.get(verified.chatId)?.result === run) turns.inFlight.delete(verified.chatId)
    }
    run.then(clear, clear)
    void run
      .then(result => {
        const record = recordOf({
          chatId: verified.chatId,
          projectPath,
          outcome: result.finish,
          failure: result.failure ?? null,
        })
        turnLog.append(record)
        turns.attention.set(verified.chatId, { at: Date.now(), outcome: result.finish })
        notifier.notify(record, result.failure?.message ?? null)
      })
      .catch(error => {
        journal.write('continue_failed', {
          chatId: verified.chatId,
          message: error instanceof Error ? error.message : String(error),
        })
      })

    return reply.code(302).redirect(`${config.owuiBaseUrl}/c/${verified.chatId}`)
  })

  /**
   * Suggestion de suite : le `🔧 suggest_followups` d'un tour devient un lien
   * qui envoie à la CLI le prompt que l'agent avait préparé, sans recopie.
   *
   * Même preuve que le bouton Continuer (signée, 10 minutes, usage unique) :
   * sans elle, n'importe quel lien ferait taper n'importe quoi dans le terminal
   * de l'agent. Le prompt voyage DANS le jeton, donc le pont ne garde rien entre
   * deux clics. La réponse n'entre pas dans le fil OpenWebUI (miroir F5.5) ;
   * l'indicateur d'onglet signale qu'il s'est passé quelque chose.
   */
  app.get('/a/prompt', async (request, reply) => {
    const query = request.query as { t?: unknown }
    if (typeof query.t !== 'string' || query.t === '') {
      return reply.code(410).send(errorBody('lien sans jeton', 'token_invalid'))
    }
    if (usedActionTokens.has(query.t)) {
      return reply.code(410).send(errorBody('ce lien a déjà servi', 'token_used'))
    }
    const verified = verifyActionToken(config.apiKey, query.t)
    if (verified === null || verified.prompt === undefined) {
      return reply.code(410).send(errorBody('lien expiré ou invalide', 'token_invalid'))
    }
    const prompt = verified.prompt

    const projectPath = bindings.get(verified.chatId)
    if (projectPath === null) {
      return reply.code(404).send(errorBody("ce chat n'est lié à aucun projet", 'chat_unbound'))
    }
    // La session visée est celle de CETTE conversation, pas du dossier.
    const ref = sessionRef(verified.chatId, projectPath)
    if (turns.inFlight.has(verified.chatId)) {
      return reply.code(409).send(errorBody('un tour est déjà en cours dans ce chat', 'turn_running'))
    }

    usedActionTokens.add(query.t)
    if (usedActionTokens.size > 1_000) usedActionTokens.clear()

    try {
      // Sans effet si la session est vivante : la relance n'a lieu qu'après sa
      // mort, et le clic est une action explicite (même règle que Continuer).
      await host.restart(ref)
    } catch (error) {
      if (error instanceof TooManySessions) {
        return reply.code(429).send(errorBody(error.message, 'too_many_sessions'))
      }
      if (error instanceof SessionStuck) {
        return reply.code(503).send(errorBody(error.message, 'session_stuck'))
      }
      if (error instanceof SessionRefused) {
        return reply.code(refusalStatus(error.code)).send(errorBody(error.message, error.code))
      }
      throw error
    }

    const run = host.use(ref, session => session.send(prompt, () => {}))
    turns.inFlight.set(verified.chatId, { signatures: [], result: run })
    const clear = (): void => {
      if (turns.inFlight.get(verified.chatId)?.result === run) turns.inFlight.delete(verified.chatId)
    }
    run.then(clear, clear)
    journal.write('followup', { chatId: verified.chatId, chars: prompt.length })
    void run
      .then(result => {
        const record = recordOf({
          chatId: verified.chatId,
          projectPath,
          outcome: result.finish,
          failure: result.failure ?? null,
        })
        turnLog.append(record)
        turns.attention.set(verified.chatId, { at: Date.now(), outcome: result.finish })
        notifier.notify(record, result.failure?.message ?? null)
      })
      .catch(error => {
        journal.write('followup_failed', {
          chatId: verified.chatId,
          message: error instanceof Error ? error.message : String(error),
        })
      })

    return reply.code(302).redirect(`${config.owuiBaseUrl}/c/${verified.chatId}`)
  })

  /** Dossier déjà lié à un chat, pour que le sélecteur parte du bon endroit. */
  app.get('/api/bind', async (request, reply) => {
    const query = request.query as { chatId?: unknown }
    if (typeof query.chatId !== 'string' || query.chatId.trim() === '') {
      return reply.code(400).send({ error: { message: 'chatId manquant', code: 'no_chat_id' } })
    }
    const projectPath = bindings.get(query.chatId)
    if (projectPath === null) {
      return reply
        .code(404)
        .send({ error: { message: 'ce chat n’est lié à aucun projet', code: 'chat_unbound' } })
    }
    return { chatId: query.chatId, projectPath }
  })

  /**
   * Lie un chat créé par le sélecteur AVANT son premier message : le chat
   * apparaît déjà sur le bon projet, et `/import` marche tout de suite.
   * Sert aussi à MODIFIER le dossier d'un chat existant.
   */
  app.post('/api/bind', async (request, reply) => {
    const body = (request.body ?? {}) as { chatId?: unknown; projectPath?: unknown }
    if (typeof body.chatId !== 'string' || body.chatId.trim() === '') {
      return reply.code(400).send({ error: { message: 'chatId manquant', code: 'no_chat_id' } })
    }
    const verdict = normalizeProjectPath(body.projectPath, config.projectsRoot)
    if (!verdict.ok) {
      return reply
        .code(400)
        .send({ error: { message: verdict.reason, code: 'invalid_project_path' }, recent: bindings.recent() })
    }
    try {
      bindings.set(body.chatId, verdict.path)
    } catch (error) {
      return reply.code(503).send({
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: 'bindings_unreadable',
        },
      })
    }
    journal.write('binding', { chatId: body.chatId, projectPath: verdict.path, source: 'picker' })
    return { ok: true, chatId: body.chatId, projectPath: verdict.path }
  })

  /**
   * Retient le dossier d'une conversation qui n'a pas encore d'id (page
   * d'accueil d'OpenWebUI). Le premier message d'un chat non lié le consomme :
   * il n'y a pas d'id à lier avant.
   */
  app.post('/api/bind/pending', async (request, reply) => {
    const body = (request.body ?? {}) as { projectPath?: unknown }
    const verdict = normalizeProjectPath(body.projectPath, config.projectsRoot)
    if (!verdict.ok) {
      return reply
        .code(400)
        .send({ error: { message: verdict.reason, code: 'invalid_project_path' }, recent: bindings.recent() })
    }
    try {
      bindings.setPending(verdict.path)
    } catch (error) {
      return reply.code(503).send({
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: 'bindings_unreadable',
        },
      })
    }
    journal.write('binding_pending', { projectPath: verdict.path })
    return { ok: true, projectPath: verdict.path }
  })

  app.get('/diagnostic', async (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(renderDiagnosticPage(healthSnapshot())))

  /**
   * Scripts d'interface injectés dans OpenWebUI.
   *
   * Servis par le pont, PAS copiés dans `open_webui/static` : OWUI vide ce
   * dossier à chaque démarrage (`config.py`), ce qui faisait disparaître la
   * barre de quota et le sélecteur dont `index.html` gardait les balises.
   */
  for (const script of ['fb-picker.js', 'fb-quota.js', 'fb-bubbles.js']) {
    app.get(`/${script}`, async (_request, reply) => {
      try {
        const body = fs.readFileSync(path.join(config.projectRoot, 'scripts', 'owui', script), 'utf8')
        return reply.type('text/javascript; charset=utf-8').header('cache-control', 'no-cache').send(body)
      } catch {
        return reply.code(404).send(errorBody(`script introuvable : ${script}`, 'missing_ui_script'))
      }
    })
  }

  app.get('/v1/models', async () => ({
    object: 'list',
    data: listExposedModels(currentProfile).map(m => ({
      id: m.id,
      object: 'model',
      created: 0,
      owned_by: 'freebuff-owui',
      name: m.name,
    })),
  }))

  app.post('/v1/chat/completions', async (request, reply) => {
    const body = (request.body ?? {}) as ChatBody
    const messages = Array.isArray(body.messages) ? body.messages : []
    const model = typeof body.model === 'string' ? body.model : ''
    const stream = body.stream !== false
    const chatId = typeof request.headers['x-openwebui-chat-id'] === 'string'
      ? request.headers['x-openwebui-chat-id']
      : null

    capture({
      at: new Date().toISOString(),
      method: request.method,
      url: request.url,
      headers: redactHeaders(request.headers as Record<string, unknown>),
      body,
    })

    // Aucun prompt dans le journal : il sert à dater, pas à relire le travail.
    console.log(
      `[s0] chat=${chatId ?? 'ABSENT'} modèle=${model || '?'} messages=${messages.length} ` +
        `stream=${stream}`,
    )
    journal.write('request', { chatId, model, messages: messages.length, stream })

    if (!config.stub) {
      return chatThroughBinding(
        host,
        bindings,
        journal,
        turns,
        turnLog,
        notifier,
        // Lu à chaque requête : une bascule de profil doit valoir pour le
        // message suivant, pas seulement pour les sessions.
        currentProfile,
        {
          model,
          stream,
          prompt: lastUserText(messages),
          messages,
          chatId,
          askTool: hasAskTool(body.tools) && config.askCard,
          toolAnswer: lastToolAnswer(messages),
        },
        reply,
      )
    }

    const content = diagnosticText({
      chatId,
      model,
      messages,
      stream,
      metadataPresent: body.metadata !== undefined,
    })
    const id = `chatcmpl-${crypto.randomUUID()}`
    const created = Math.floor(Date.now() / 1000)

    if (!stream) {
      return reply.send({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      })
    }

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })

    let closed = false
    reply.raw.on('close', () => {
      closed = true
    })

    const send = (chunk: Record<string, unknown>): void => {
      if (!closed) reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }

    const chunk = (delta: Record<string, unknown>, finishReason: string | null = null): Record<string, unknown> => ({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })

    send(chunk({ role: 'assistant', content: '' }))

    // Découpage volontairement grossier : on teste le rendu, pas la vitesse.
    for (let i = 0; i < content.length && !closed; i += 80) {
      send(chunk({ content: content.slice(i, i + 80) }))
      await new Promise(resolve => setTimeout(resolve, 20))
    }

    send(chunk({}, 'stop'))
    if (!closed) {
      reply.raw.write('data: [DONE]\n\n')
      reply.raw.end()
    }
  })

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.code(404).send({ error: { message: 'route inconnue', type: 'invalid_request_error' } })
  })

  if (overrides.autoImport === true) importScheduler.start()

  return app
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const app = buildServer({
    notify: windowsToastSender() ?? undefined,
    autoImport: true,
  })
  await app.listen({ host: config.host, port: config.port })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().then(() => process.exit(0))
    })
  }

  console.log('')
  console.log(
    config.stub
      ? '  Freebuff OWUI — mode stub (aucune CLI pilotée)'
      : `  Freebuff OWUI — une session Freebuff par projet, ${String(config.maxSessions)} au plus`,
  )
  console.log(`  Sessions      : ${String(config.maxSessions)} max (BRIDGE_MAX_SESSIONS)`)
  console.log(`  URL OpenWebUI : http://${config.host}:${config.port}/v1`)
  console.log(`  Clé API       : ${config.apiKey}`)
  console.log(`  Racines       : ${config.projectsRoot.join(', ')}`)
  console.log(`  Profil        : ${config.profileDir}`)
  console.log(`  Modèles       : ${listExposedModels().length} (dont freebuff-new)`)
  console.log(
    config.importIntervalMs > 0
      ? `  Import OWUI   : toutes les ${String(Math.round(config.importIntervalMs / 60_000))} min`
      : '  Import OWUI   : désactivé (BRIDGE_IMPORT_INTERVAL_MS=0)',
  )
  console.log('')
}
