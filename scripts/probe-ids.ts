/**
 * Vérifie quels identifiants Freebuff la CLI accepte réellement.
 *
 * On écrit `freebuffModel` (sans clé, sinon une clé périmée l'emporte), on
 * lance la CLI, et on lit le modèle affiché dans son bandeau. Ce que la CLI
 * affiche est la seule preuve qu'un identifiant est bon.
 *
 * Aucun prompt n'est écrit : aucun tour n'est consommé. `settings.json` est
 * sauvegardé puis restauré à la fin.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as pty from 'node-pty'
import { ScreenBuffer, parseQuota } from '../src/freebuff/screen.ts'

process.on('uncaughtException', error => {
  if (error instanceof Error && /AttachConsole failed/.test(error.message)) return
  throw error
})

const BIN = process.env.FREEBUFF_BIN ?? path.join(os.homedir(), '.config', 'manicode', 'freebuff.exe')
const PROFILE = path.join(os.homedir(), '.config', 'freebuff')
const SETTINGS = path.join(PROFILE, 'settings.json')
const CWD = path.resolve('sandbox/s1')
const WAIT_MS = 7000

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) as Record<string, unknown>
}

function writeModel(id: string): void {
  const current = readSettings()
  // `key:m-…` : la clé opaque que la CLI préfère à `freebuffModel`.
  if (id.startsWith('key:')) {
    current.freebuffModelKey = id.slice('key:'.length)
  } else {
    current.freebuffModel = id
    delete current.freebuffModelKey
  }
  fs.writeFileSync(SETTINGS, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
}

/** Le bandeau : « GLM 5.3 Flash • high · <dossier> · /model to change ». */
function headerModel(screen: string): string {
  // Le dossier du bac à sable suit toujours le nom : ce qui le précède est le
  // modèle. On retire l'effort (« • high », « · max ») qui s'intercale.
  const at = screen.lastIndexOf('D:\\code')
  if (at < 0) return '(non lu)'
  return screen
    .slice(Math.max(0, at - 70), at)
    .replace(/[│┌┐└┘─▀▄█]/g, ' ')
    .replace(/\s*[•·]\s*(?:high|medium|low|max)?\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(-45)
}

async function probe(id: string): Promise<string> {
  writeModel(id)
  const screen = new ScreenBuffer()
  const term = pty.spawn(BIN, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: CWD,
    env: { ...process.env, TERM: 'xterm-256color', FREEBUFF_CONFIG_DIR: PROFILE },
  })
  term.onData(chunk => screen.push(chunk))

  const deadline = Date.now() + WAIT_MS
  while (Date.now() < deadline && !parseQuota(screen.value).found) await sleep(400)
  await sleep(700)

  const header = headerModel(screen.value)
  if (header === '(non lu)') {
    console.log('[écran]', screen.value.slice(-400).replace(/\s+/g, ' ').trim())
  }

  try {
    term.kill()
  } catch {
    // déjà mort
  }
  await sleep(600)
  try {
    execFileSync('taskkill', ['/PID', String(term.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // déjà mort
  }
  return header
}

async function main(): Promise<void> {
  const backup = fs.readFileSync(SETTINGS, 'utf8')
  const ids = process.argv.slice(2)
  fs.mkdirSync(CWD, { recursive: true })
  try {
    for (const id of ids) console.log(`${id} -> ${await probe(id)}`)
  } finally {
    fs.writeFileSync(SETTINGS, backup, 'utf8')
  }
}

await main()
