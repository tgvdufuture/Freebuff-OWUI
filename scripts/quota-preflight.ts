/**
 * Pré-vol de quota — demande à la CLI elle-même, pas à l'API.
 *
 * Pour chaque profil Freebuff :
 *   1. lance `freebuff.exe` dans un PTY avec `FREEBUFF_CONFIG_DIR` ;
 *   2. attend que la TUI affiche son bandeau ;
 *   3. lit `0/12 hours remaining` (ou l'état de connexion) ;
 *   4. ferme, sans jamais écrire de prompt.
 *
 * Aucun `credentials.json` n'est ouvert, aucun token n'est envoyé.
 * Aucun tour n'est consommé : un prompt n'est jamais écrit.
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

const BIN =
  process.env.FREEBUFF_BIN ?? path.join(os.homedir(), '.config', 'manicode', 'freebuff.exe')
const CWD = path.resolve('sandbox/s1')
/** 45 s : un profil lent se reconnecte en ~40 s (mesuré le 23/10). */
const WAIT_MS = 45_000
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const DEFAULT_PROFILES = [
  path.join(os.homedir(), '.config', 'freebuff-session'),
  path.join(os.homedir(), '.config', 'freebuff'),
  path.join(os.homedir(), '.config', 'freebuff-desktop'),
  path.join(os.homedir(), '.config', 'manicode'),
  path.join(os.homedir(), '.config', 'freebuff2'),
]

const LOGIN_PATTERNS = [/log\s*in/i, /sign\s*in/i, /authenticate/i, /not logged in/i]

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

interface PreflightResult {
  profile: string
  connected: boolean
  quota: ReturnType<typeof parseQuota>
  refusal: ReturnType<typeof classifyRefusal>
  tail: string
}

async function preflight(profile: string): Promise<PreflightResult> {
  const screen = new ScreenBuffer()
  let exited = false

  const term = pty.spawn(BIN, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: CWD,
    env: { ...process.env, TERM: 'xterm-256color', FREEBUFF_CONFIG_DIR: profile },
  })
  const pid = term.pid

  term.onData(chunk => screen.push(chunk))
  term.onExit(() => {
    exited = true
  })

  const deadline = Date.now() + WAIT_MS
  let quota = parseQuota(screen.value)
  while (Date.now() < deadline && !exited) {
    await sleep(500)
    quota = parseQuota(screen.value)
    if (quota.found) break
  }

  const text = screen.value
  const connected = !LOGIN_PATTERNS.some(pattern => pattern.test(text))
  const refusal = classifyRefusal(text)
  const tail = text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/https?:\/\/\S+/g, '<url>')
    .split(/\s+/)
    .join(' ')
    .slice(-220)

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

  return { profile, connected, quota, refusal, tail }
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2)
  const profiles = (requested.length ? requested : DEFAULT_PROFILES).filter(dir =>
    fs.existsSync(path.join(dir, 'credentials.json')),
  )

  if (!profiles.length) {
    console.log('aucun profil avec credentials.json')
    return
  }

  const results: PreflightResult[] = []
  for (const profile of profiles) {
    console.log(`[pré-vol] ${path.basename(profile)}…`)
    const result = await preflight(profile)
    results.push(result)
    const quota = result.quota.found
      ? `${result.quota.remainingHours}/${result.quota.totalHours} h`
      : 'inconnu'
    console.log(
      `  → quota=${quota} refus=${result.refusal ?? 'aucun'} connecté=${result.connected ? 'oui' : 'non'}`,
    )
  }

  const file = path.resolve('spike/quota-preflight.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify(
      results.map(r => ({
        profile: r.profile,
        connected: r.connected,
        quota: r.quota,
        refusal: r.refusal,
        tail: r.tail,
      })),
      null,
      2,
    ),
    'utf8',
  )
  console.log(`résultat : ${file}`)
}

await main()
