import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { FreebuffSession } from '../src/freebuff/session.ts'

/**
 * Fausse CLI : elle prend la consigne comme la vraie (une ligne, puis Entrée)
 * et écrit son journal — mais elle n'écrit AUCUN message `user` dans le
 * transcript, exactement comme la vraie CLI pendant un tour (mesuré le
 * 2026-10-23 : le message `user` n'arrive qu'à la fin du tour).
 */
const FAKE_CLI = String.raw`
const fs = require('node:fs')
const path = require('node:path')
const profile = process.env.FREEBUFF_CONFIG_DIR
const chatRoot = path.join(profile, 'projects', path.basename(process.cwd()), 'chats')
const line = (entry) => JSON.stringify(entry) + '\n'

// Le dossier de chat est créé AU DEMARRAGE, comme la vraie CLI.
const dir = path.join(chatRoot, new Date().toISOString().replace(/[:.]/g, '-'))
fs.mkdirSync(dir, { recursive: true })
const log = path.join(dir, 'log.jsonl')
fs.writeFileSync(log, line({ level: 'INFO', timestamp: new Date().toISOString(), msg: '[chat-runtime] started' }))
// Handle gardé OUVERT comme la vraie CLI : sous Windows, la date de
// modification du fichier reste figée jusqu'au fsync/close.
const handle = fs.openSync(log, 'a')

let buffer = ''
let done = false

function take(prompt) {
  if (done) return
  done = true
  const send = line({
    level: 'INFO',
    timestamp: new Date().toISOString(),
    msg: '[send-message] Sending message with sdk run config',
    // La CLI a reçu une consigne un peu PLUS COURTE que celle écrite (mesuré
    // le 2026-10-23 sur une reprise de fil) : la longueur ne doit pas servir
    // de preuve d'acceptation.
    data: { runConfig: { agent: 'base3-free-catalog', promptLength: Math.max(1, prompt.length - 30) } },
  })
  fs.writeSync(handle, Buffer.from(send))
  // Le transcript n'a que la réponse : pas de message user, donc aucune
  // acceptation possible par le transcript.
  fs.writeFileSync(
    path.join(dir, 'chat-messages.json'),
    JSON.stringify([{ variant: 'ai', isComplete: true, blocks: [{ type: 'text', textType: 'text', content: 'fait' }] }]),
  )
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  for (const char of chunk) {
    if (char === '\r') {
      take(buffer.replace(/\s+/g, ' ').trim())
      buffer = ''
    } else {
      buffer += char
    }
  }
})
process.stdin.resume()
setInterval(() => {}, 1_000)
`

/**
 * Fausse CLI qui PEINT son écran au fur et à mesure, comme la vraie TUI :
 * la réponse s'écrit ligne à ligne toutes les 500 ms, alors que le transcript
 * n'arrive qu'à la fin. C'est ce décalage que le canal « réflexion » exploite.
 */
const PAINTING_CLI = String.raw`
const fs = require('node:fs')
const path = require('node:path')
const profile = process.env.FREEBUFF_CONFIG_DIR
const chatRoot = path.join(profile, 'projects', path.basename(process.cwd()), 'chats')
const dir = path.join(chatRoot, new Date().toISOString().replace(/[:.]/g, '-'))
fs.mkdirSync(dir, { recursive: true })
const log = path.join(dir, 'log.jsonl')
const line = (entry) => JSON.stringify(entry) + '\n'
fs.writeFileSync(log, line({ level: 'INFO', timestamp: new Date().toISOString(), msg: '[chat-runtime] started' }))
const handle = fs.openSync(log, 'a')

const paint = (text) => process.stdout.write('\r\n' + text)
let buffer = ''
let done = false

function run(prompt) {
  if (done) return
  done = true
  fs.writeSync(handle, Buffer.from(line({
    level: 'INFO', timestamp: new Date().toISOString(),
    msg: '[send-message] Sending message with sdk run config',
    data: { runConfig: { promptLength: prompt.length } },
  })))

  paint('[09:17]')
  paint('   ' + prompt)
  paint('')
  const stages = [
    '   Premiere ligne de la reponse,',
    '   deuxieme ligne qui la prolonge,',
    '   troisieme ligne pour la fin.',
  ]
  stages.forEach((text, index) => {
    setTimeout(() => {
      paint(text)
      if (index < stages.length - 1) return
      // Le transcript n'arrive qu'APRÈS l'écran, comme la vraie CLI.
      setTimeout(() => {
        fs.writeFileSync(
          path.join(dir, 'chat-messages.json'),
          JSON.stringify([{ variant: 'ai', isComplete: true, blocks: [{ type: 'text', textType: 'text', content: stages.map(s => s.trim()).join(' ') }] }]),
        )
        fs.writeSync(handle, Buffer.from(line({ level: 'INFO', timestamp: new Date().toISOString(), msg: '[send-message] Main prompt finished' })))
      }, 800)
    }, 500 * (index + 1))
  })
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  for (const char of chunk) {
    if (char === '\r') {
      run(buffer.replace(/\s+/g, ' ').trim())
      buffer = ''
    } else {
      buffer += char
    }
  }
})
process.stdin.resume()
setInterval(() => {}, 1_000)
`

/**
 * Fausse CLI qui digère un long collage comme la vraie TUI depuis le 23/10 :
 * elle redessine son écran pendant 3 s et PERD tout `Entrée` reçu avant la fin.
 * C'est exactement ce qui rendait un prompt de 7,5 Ko `not_accepted` : écrit,
 * soumis 900 ms plus tard, jamais envoyé — même en réécrivant la consigne.
 */
const INGESTING_CLI = String.raw`
const fs = require('node:fs')
const path = require('node:path')
const profile = process.env.FREEBUFF_CONFIG_DIR
const chatRoot = path.join(profile, 'projects', path.basename(process.cwd()), 'chats')
const line = (entry) => JSON.stringify(entry) + '\n'
const dir = path.join(chatRoot, new Date().toISOString().replace(/[:.]/g, '-'))
fs.mkdirSync(dir, { recursive: true })
const log = path.join(dir, 'log.jsonl')
fs.writeFileSync(log, line({ level: 'INFO', timestamp: new Date().toISOString(), msg: '[chat-runtime] started' }))
const handle = fs.openSync(log, 'a')

// Comme la vraie TUI : chaque octet arrive tel quel, Entrée comprise.
process.stdin.setRawMode(true)

let buffer = ''
let ingestUntil = 0
let pump = null
let done = false

function touch() {
  ingestUntil = Date.now() + 3000
  if (pump !== null) return
  pump = setInterval(() => {
    if (Date.now() > ingestUntil) { clearInterval(pump); pump = null; return }
    process.stdout.write('digestion ' + buffer.slice(-8) + '\r\n')
  }, 150)
}

function send(prompt) {
  if (done) return
  done = true
  fs.writeSync(handle, Buffer.from(line({
    level: 'INFO', timestamp: new Date().toISOString(),
    msg: '[send-message] Sending message with sdk run config',
    data: { runConfig: { promptLength: prompt.length } },
  })))
  fs.writeFileSync(
    path.join(dir, 'chat-messages.json'),
    JSON.stringify([{ variant: 'ai', isComplete: true, blocks: [{ type: 'text', textType: 'text', content: 'fait' }] }]),
  )
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  if (chunk.replace(/\r/g, '') !== '') touch()
  for (const char of chunk) {
    if (char === '\r') {
      // Entrée perdue : la TUI n'a pas fini de digérer la consigne.
      if (Date.now() < ingestUntil) continue
      send(buffer.replace(/\s+/g, ' ').trim())
      buffer = ''
    } else {
      buffer += char
    }
  }
})
process.stdin.resume()
setInterval(() => {}, 1_000)
`

const root = mkdtempSync(path.join(os.tmpdir(), 'fb-session-'))
const bin = path.join(root, 'fausse-cli.cjs')
writeFileSync(bin, FAKE_CLI, 'utf8')
const ingestingBin = path.join(root, 'fausse-cli-digestion.cjs')
writeFileSync(ingestingBin, INGESTING_CLI, 'utf8')
const paintingBin = path.join(root, 'fausse-cli-peinture.cjs')
writeFileSync(paintingBin, PAINTING_CLI, 'utf8')

test('l’écran alimente un flux fin, avant que le transcript ne reçoive quoi que ce soit', async () => {
  const projectDir = path.join(root, 'projet-peinture')
  const session = await FreebuffSession.start({
    projectDir,
    profileDir: path.join(root, 'profil-peinture'),
    bin: process.execPath,
    args: [paintingBin],
    bootMs: 1_500,
  })

  const live: string[] = []
  try {
    const result = await session.send(
      'ecris trois lignes de reponse',
      () => {},
      text => live.push(text),
    )

    assert.equal(result.finish, 'ok')
    // La réponse arrive en PLUSIEURS morceaux : une image d'écran ne suffit pas.
    assert.ok(live.length >= 3, `trop peu de morceaux (${String(live.length)}) : pas de flux fin`)
    // La dernière ligne est INCLUSE : le texte avance pendant qu'elle s'écrit,
    // au lieu d'attendre la ligne suivante.
    assert.equal(
      live.join(''),
      'Premiere ligne de la reponse, deuxieme ligne qui la prolonge, troisieme ligne pour la fin.',
    )
  } finally {
    session.stop()
  }
})

test('un long prompt est soumis après que la TUI a fini de le digérer', async () => {
  const projectDir = path.join(root, 'projet-digestion')
  const session = await FreebuffSession.start({
    projectDir,
    profileDir: path.join(root, 'profil-digestion'),
    bin: process.execPath,
    args: [ingestingBin],
    bootMs: 1_500,
  })

  try {
    // 7,5 Ko : la taille d'une reprise de fil, celle des tours perdus du 23/10.
    const prompt = `Contexte de la conversation précédente. ${'mot '.repeat(1_500)}`
    const result = await session.send(prompt, () => {})

    // Un `Entrée` envoyé pendant la digestion est perdu ; l'ancien envoi (900 ms
    // puis réécriture à 20 s) n'était donc jamais accepté.
    assert.equal(result.finish, 'ok')
  } finally {
    session.stop()
  }
})

test('un prompt est accepté sur le journal de la CLI, sans message `user`', async () => {
  const projectDir = path.join(root, 'projet')
  const session = await FreebuffSession.start({
    projectDir,
    profileDir: path.join(root, 'profil'),
    bin: process.execPath,
    args: [bin],
    bootMs: 1_500,
  })

  try {
    const prompt = `une consigne de test ${'x'.repeat(400)}`
    const result = await session.send(prompt, () => {})

    // L'ancien critère (message `user` dans le transcript) n'aurait jamais vu
    // l'acceptation et aurait rendu `not_accepted` après deux écritures.
    assert.equal(result.finish, 'ok')
    assert.notEqual(session.chatRef, null)
  } finally {
    session.stop()
  }
})
