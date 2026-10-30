import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  chatUsers,
  claimForPrompt,
  claimForSend,
  newestChatDir,
  promptAccepted,
  sentAnySince,
  sentInChatDir,
  sentInLog,
} from '../src/freebuff/chats.ts'

const root = mkdtempSync(path.join(os.tmpdir(), 'fb-chats-'))
/** Racine dédiée aux dossiers de chat complets (les tests plus bas listent `root`). */
const ownRoot = mkdtempSync(path.join(os.tmpdir(), 'fb-chats-own-'))

/** Un dossier de chat comme la CLI en écrit : tableau de messages. */
function chat(name: string, users: number, mtimeSeconds: number): string {
  const dir = path.join(root, name)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'chat-messages.json')
  const entries = Array.from({ length: users }, (_, index) => ({
    variant: index % 2 === 0 ? 'user' : 'ai',
    blocks: [{ type: 'text', content: `message ${index}` }],
  }))
  writeFileSync(file, JSON.stringify(entries), 'utf8')
  utimesSync(file, mtimeSeconds, mtimeSeconds)
  return dir
}

/**
 * Un dossier de chat comme la CLI l'écrit vraiment : consignes dans `content`,
 * réponses dans des blocs texte.
 */
function conversation(name: string, prompts: string[], mtimeSeconds: number): string {
  const dir = path.join(ownRoot, name)
  mkdirSync(dir, { recursive: true })
  const entries = prompts.flatMap((prompt, index) => [
    { variant: 'user', content: prompt },
    {
      variant: 'ai',
      isComplete: index === prompts.length - 1,
      blocks: [{ type: 'text', textType: 'text', content: `réponse ${String(index)}` }],
    },
  ])
  const file = path.join(dir, 'chat-messages.json')
  writeFileSync(file, JSON.stringify(entries), 'utf8')
  utimesSync(file, mtimeSeconds, mtimeSeconds)
  return dir
}

test('un dossier de chat donne son nombre de consignes et la dernière', () => {
  const dir = conversation('deux-consignes', ['première   consigne', 'deuxième'], 4_000)

  assert.deepEqual(chatUsers(dir), { users: 2, lastUser: 'deuxième' })
  // Un fichier absent ne casse pas la lecture.
  assert.deepEqual(chatUsers(path.join(ownRoot, 'absent')), { users: 0, lastUser: null })
})

test('la lecture d’un dossier suit ses réécritures', () => {
  const dir = conversation('reecrit', ['un'], 4_500)
  assert.equal(chatUsers(dir).users, 1)

  conversation('reecrit', ['un', 'deux'], 4_800)
  assert.deepEqual(chatUsers(dir), { users: 2, lastUser: 'deux' })
})

test('deux CLI dans le même dossier : chaque consigne retrouve SON chat', () => {
  // Cas réel : deux conversations OpenWebUI liées au même dossier, chacune sa
  // CLI, donc deux dossiers `chats/` écrits côte à côte.
  // `since` est en millisecondes, comme Date.now().
  const first = conversation('2026-10-23T10-00-00.000Z', ['fais A'], 1_700_000_000)
  const second = conversation('2026-10-23T10-00-05.000Z', ['fais B'], 1_700_000_005)
  const start = 1_699_999_990_000

  assert.equal(claimForPrompt(ownRoot, 'fais A', { since: start }), first)
  assert.equal(claimForPrompt(ownRoot, 'fais B', { since: start }), second)
  // Un tour d'avant n'est jamais revendiqué : `since` est le départ du tour.
  assert.equal(claimForPrompt(ownRoot, 'fais A', { since: 1_700_000_004_000 }), null)
  // Une consigne inconnue ne prend aucun dossier au hasard.
  assert.equal(claimForPrompt(ownRoot, 'fais C', { since: start }), null)
})

/** Une ligne de journal comme la CLI en écrit quand elle prend un message. */
function sendLine(at: string, promptLength: number): string {
  return `${JSON.stringify({
    level: 'INFO',
    timestamp: at,
    msg: '[send-message] Sending message with sdk run config',
    data: { runConfig: { agent: 'base3-free-catalog', promptLength } },
  })}\n`
}

/** Bruit de journal : plusieurs centaines de Ko APRÈS la ligne d'envoi. */
function logNoise(lines = 400): string {
  return Array.from({ length: lines }, (_, index) =>
    JSON.stringify({ level: 'DEBUG', timestamp: '2026-10-23T12:39:40.000Z', msg: `Start agent base3 step ${String(index)}`, data: { x: 'y'.repeat(500) } }),
  ).join('\n') + '\n'
}

/** Un dossier de chat avec son journal, comme après une consigne prise. */
function sentChat(name: string, length: number, at: string, noise = true): string {
  const dir = path.join(ownRoot, name)
  mkdirSync(dir, { recursive: true })
  const log = sendLine(at, length) + (noise ? logNoise() : '')
  const file = path.join(dir, 'log.jsonl')
  writeFileSync(file, log, 'utf8')
  const seconds = Date.parse(at) / 1000
  utimesSync(file, seconds, seconds)
  return dir
}

test('le journal dit qu’une consigne de cette longueur a été prise', () => {
  const since = Date.parse('2026-10-23T12:39:27.000Z')
  const raw = sendLine('2026-10-23T12:39:33.543Z', 7770)

  assert.equal(sentInLog(raw, 7770, since), true)
  // Une autre longueur, ou un send d'AVANT le tour, ne valent pas acceptation.
  assert.equal(sentInLog(raw, 7771, since), false)
  assert.equal(sentInLog(raw, 7770, Date.parse('2026-10-23T12:39:34.000Z')), false)
  // Lignes illisibles ou sans `[send-message]` : ignorées, jamais une preuve.
  assert.equal(sentInLog('{pas du json}\n' + raw, 7770, since), true)
  assert.equal(sentInLog('{"msg":"[message-queue] Processing next message from queue"}', 7770, 0), false)
})

test('un prompt accepté se reconnaît à son journal, sans transcript', () => {
  // Cas réel du 2026-10-23 : le transcript n'écrit le message `user` qu'à la fin
  // du tour, donc une consigne de 7770 caractères (reprise du fil) n'y était
  // pas 20 s après l'envoi. Le journal, lui, l'avait déjà notée — en TÊTE d'un
  // fichier de 264 Ko, donc invisible depuis la fin du fichier.
  const dir = sentChat('2026-10-23T12-39-20.183Z', 7770, '2026-10-23T12:39:33.543Z')
  const since = Date.parse('2026-10-23T12:39:27.000Z')

  assert.equal(sentInChatDir(dir, 7770, since), true)
  assert.equal(claimForSend(ownRoot, 7770, { since }), dir)
  assert.equal(claimForSend(ownRoot, 12, { since }), null)
  assert.equal(claimForSend(ownRoot, 7770, { since: Date.parse('2026-10-23T12:39:34.000Z') }), null)
  assert.equal(claimForSend(path.join(ownRoot, 'inexistant'), 7770, { since }), null)
})

test('une date de modification figée ne cache pas un envoi récent', () => {
  // Mesure du 2026-10-23 : Windows ne rafraîchit pas la `mtime` d'un fichier
  // écrit via un handle resté ouvert. Le journal de la CLI est ouvert pendant
  // tout le tour : sa date reste celle du démarrage, alors que
  // `[send-message]` vient d'y être écrit.
  const dir = sentChat('2026-10-23T13-20-36.019Z', 7836, '2026-10-23T13:20:48.500Z', false)
  const file = path.join(dir, 'log.jsonl')
  utimesSync(file, 1_700_000_000, 1_700_000_000)

  const since = Date.parse('2026-10-23T13:20:44.900Z')
  assert.equal(sentInChatDir(dir, 7836, since), true)
  assert.equal(claimForSend(ownRoot, 7836, { since }), dir)
})

test('un envoi dans le dossier de la session ne dépend pas de sa longueur', () => {
  // La CLI peut recevoir un texte plus court que celui écrit (reprise de fil) :
  // dans le dossier de la session, la seule présence d'un envoi suffit.
  const dir = sentChat('2026-10-23T13-30-22.477Z', 7365, '2026-10-23T13:30:35.000Z', false)
  const since = Date.parse('2026-10-23T13:30:31.400Z')

  assert.equal(sentAnySince(dir, since), true)
  assert.equal(sentAnySince(dir, Date.parse('2026-10-23T13:30:36.000Z')), false)
  // La recherche par longueur reste le critère du balayage de projet.
  assert.equal(sentInChatDir(dir, 7395, since), false)
})

test('le journal n’est relu que pour ce qui a été ajouté', () => {
  // Le pont interroge l'acceptation toutes les 200 ms : le curseur par dossier
  // doit voir un envoi ajouté depuis le dernier passage, sans relire le début.
  const dir = sentChat('2026-10-23T12-50-00.000Z', 900, '2026-10-23T12:50:04.000Z')
  const since = Date.parse('2026-10-23T12:50:00.000Z')
  assert.equal(sentInChatDir(dir, 900, since), true)
  assert.equal(sentInChatDir(dir, 901, since), false)

  const file = path.join(dir, 'log.jsonl')
  writeFileSync(file, sendLine('2026-10-23T12:50:09.000Z', 901), { flag: 'a' })
  assert.equal(sentInChatDir(dir, 901, since), true)
  assert.equal(sentInChatDir(dir, 901, Date.parse('2026-10-23T12:50:10.000Z')), false)
})

test('le dossier actif est le plus récent qui a un transcript', () => {
  const old = chat('2026-10-21T18-00-00.000Z', 2, 1_000)
  const recent = chat('2026-10-21T20-00-00.000Z', 1, 3_000)

  assert.equal(newestChatDir(root), recent)
  assert.notEqual(newestChatDir(root), old)
})

test('un dossier sans transcript est ignoré, même plus récent', () => {
  const base = chat('avec-transcript', 1, 5_000)
  mkdirSync(path.join(root, 'fantome'), { recursive: true })

  assert.equal(newestChatDir(root), base)
})

test('un dossier de chats absent ne fait pas échouer la lecture', () => {
  assert.equal(newestChatDir(path.join(root, 'inexistant')), null)
})

test('un nouveau dossier de chat contenant la consigne vaut acceptation', () => {
  // Cas réel du 2026-10-21 : le pont redémarre, la CLI ouvre un autre chat.
  const before = { dir: '/chats/ancien', users: 2 }
  const after = { dir: '/chats/nouveau', users: 1 }

  assert.equal(promptAccepted(after, before), true)
})

test('un nouveau dossier de chat encore vide ne prouve pas l’acceptation', () => {
  // La CLI crée le dossier au démarrage, avant de lire la saisie.
  assert.equal(promptAccepted({ dir: '/chats/nouveau', users: 0 }, { dir: '/chats/ancien', users: 2 }), false)
})

test('le même dossier vaut acceptation seulement si un message user apparaît', () => {
  const before = { dir: '/chats/actif', users: 2 }

  assert.equal(promptAccepted({ dir: '/chats/actif', users: 3 }, before), true)
  assert.equal(promptAccepted({ dir: '/chats/actif', users: 2 }, before), false)
})

test('aucun chat visible ne vaut jamais acceptation', () => {
  assert.equal(promptAccepted({ dir: null, users: 0 }, { dir: null, users: 0 }), false)
  assert.equal(promptAccepted({ dir: null, users: 0 }, { dir: '/chats/ancien', users: 0 }), false)
})
