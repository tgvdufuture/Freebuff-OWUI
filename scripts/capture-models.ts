/**
 * Capture la liste des modèles proposés par la CLI.
 *
 * La liste vient du serveur Freebuff au démarrage : aucun fichier local ne
 * l'énumère. La seule source de vérité est le sélecteur de la TUI. Cette sonde
 * lance donc `freebuff.exe`, ouvre le sélecteur, lit l'écran, puis ferme —
 * sans jamais écrire de prompt : aucun tour n'est consommé.
 *
 * Usage :
 *   node scripts/capture-models.ts            # écran d'accueil seul
 *   node scripts/capture-models.ts <touches>  # touches, séparées par des virgules
 *
 * Les touches sont des échappements littéraux (`ctrl+p` → `\x10`).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as pty from 'node-pty'
import { ScreenBuffer, classifyRefusal, parseQuota } from '../src/freebuff/screen.ts'

process.on('uncaughtException', error => {
  if (error instanceof Error && /AttachConsole failed/.test(error.message)) return
  throw error
})
process.on('unhandledRejection', error => {
  if (error instanceof Error && /AttachConsole failed/.test(error.message)) return
  throw error
})

const BIN = process.env.FREEBUFF_BIN ?? path.join(os.homedir(), '.config', 'manicode', 'freebuff.exe')
const PROFILE =
  process.env.BRIDGE_PROFILE_DIR ??
  process.env.FREEBUFF_CONFIG_DIR ??
  path.join(os.homedir(), '.config', 'freebuff')
const CWD = path.resolve('sandbox/s1')

const CONTROLS: Record<string, string> = {
  'ctrl+a': '\x01',
  'ctrl+b': '\x02',
  'ctrl+k': '\x0b',
  'ctrl+m': '\x0d',
  'ctrl+n': '\x0e',
  'ctrl+p': '\x10',
  'ctrl+s': '\x13',
  'ctrl+x': '\x18',
  esc: '\x1b',
  tab: '\t',
  enter: '\r',
  down: '\x1b[B',
  up: '\x1b[A',
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * `ctrl+p` → séquence d'échappement ; `text=/model` → texte littéral, écrit
 * sans Entrée (envoyer une commande inconnue comme prompt consommerait un tour).
 */
function keysFrom(arg: string | undefined): string[] {
  if (!arg) return []
  return arg.split(',').map(raw => {
    const name = raw.trim()
    if (name.startsWith('text=')) return name.slice('text='.length)
    const key = CONTROLS[name]
    if (key === undefined) throw new Error(`touche inconnue : ${name}`)
    return key
  })
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function main(): Promise<void> {
  const keys = keysFrom(process.argv[2])
  const screen = new ScreenBuffer()
  let exited = false

  fs.mkdirSync(CWD, { recursive: true })
  const term = pty.spawn(BIN, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: CWD,
    env: { ...process.env, TERM: 'xterm-256color', FREEBUFF_CONFIG_DIR: PROFILE },
  })
  const pid = term.pid
  term.onData(chunk => screen.push(chunk))
  term.onExit(() => {
    exited = true
  })

  // Attendre le bandeau : au-delà, la TUI a fini de dessiner son accueil.
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && !exited && !parseQuota(screen.value).found) await sleep(500)
  await sleep(800)

  console.log('=== accueil ===')
  console.log(screen.value.slice(-2000))
  console.log(`=== refus=${classifyRefusal(screen.value) ?? 'aucun'} ===`)

  for (const key of keys) {
    term.write(key)
    await sleep(1200)
    if (process.env.CARD === '1') {
      // Carte focalisée seulement : le tampon garde tout l'historique, et un
      // voisin qui défile fausserait la lecture du coût.
      const from = screen.value.lastIndexOf('›')
      console.log(`=== ${JSON.stringify(key)} ===`)
      console.log(screen.value.slice(from < 0 ? -600 : from, (from < 0 ? -600 : from) + 400))
      continue
    }
    console.log(`=== après ${JSON.stringify(key)} ===`)
    console.log(screen.value.slice(-3000))
  }

  try {
    term.kill()
  } catch {
    // déjà mort
  }
  await sleep(1200)
  if (isAlive(pid)) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      // déjà mort
    }
  }
}

await main()
