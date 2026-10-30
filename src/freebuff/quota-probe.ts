/**
 * Sonde de quota exécutée dans SON processus (voir `quota.ts`).
 *
 * Pourquoi un processus séparé : sous Windows, fermer un PTY ConPTY fait lever
 * « AttachConsole failed » dans un agent de `node-pty`, de façon asynchrone.
 * Dans un script jetable c'est sans conséquence ; dans le pont, l'exception non
 * capturée tuerait le serveur. Le parent ne lit donc que du JSON sur stdout.
 *
 * Usage : `node src/freebuff/quota-probe.ts <profileDir> <cwd>`
 * Aucun prompt n'est écrit : une TUI lancée puis refermée ne consomme rien.
 */
import fs from 'node:fs'
import * as pty from 'node-pty'
import { killTree } from './kill.ts'
import { resolveFreebuffBin } from './profiles.ts'
import { ScreenBuffer, classifyRefusal, parseQuota } from './screen.ts'

// L'erreur de ConPTY arrive à la fermeture : elle ne doit pas transformer une
// lecture réussie en échec.
process.on('uncaughtException', error => {
  if (error instanceof Error && /AttachConsole failed/.test(error.message)) return
  throw error
})
process.on('unhandledRejection', error => {
  if (error instanceof Error && /AttachConsole failed/.test(error.message)) return
  throw error
})

const [profileDir, cwd] = process.argv.slice(2)
/** Le premier argument est le profil : c'est lui qui porte le binaire de la CLI. */
const BIN = resolveFreebuffBin(profileDir ?? '')
/**
 * 45 s, pas 15 : un profil déjà connecté affiche son bandeau en ~10 s, mais un
 * profil lent peut afficher « Can't reach Freebuff's servers. Retrying… »
 * pendant ~40 s avant « Reconnected » (mesuré le 23/10 sur freebuff-session).
 * Couper à 15 s faisait passer un compte sain pour illisible.
 */
const WAIT_MS = 45_000
const POLL_MS = 400

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

if (profileDir === undefined || cwd === undefined || !fs.existsSync(BIN)) {
  console.log('null')
  process.exit(0)
}

fs.mkdirSync(cwd, { recursive: true })

const screen = new ScreenBuffer()
let exited = false
const term = pty.spawn(BIN, [], {
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
  cwd,
  env: { ...process.env, TERM: 'xterm-256color', FREEBUFF_CONFIG_DIR: profileDir },
})
term.onData(chunk => screen.push(chunk))
term.onExit(() => {
  exited = true
})

const deadline = Date.now() + WAIT_MS
let quota = parseQuota(screen.value)
while (!quota.found && !exited && Date.now() < deadline) {
  await sleep(POLL_MS)
  quota = parseQuota(screen.value)
}

const refusal = classifyRefusal(screen.value)
// L'arbre d'abord : une fois le parent mort, taskkill ne retrouve plus ses
// enfants (même règle que l'arrêt d'une session).
killTree(term.pid)
try {
  term.kill()
} catch {
  // Déjà morte : ce n'est pas un échec de lecture.
}

console.log(JSON.stringify({ quota, refusal }))
await sleep(600)
