import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { isAlive, killTree } from '../src/freebuff/kill.ts'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await sleep(30)
  }
  throw new Error(`condition non atteinte en ${timeoutMs} ms`)
}

/** Lance un node qui lance lui-même un enfant et affiche son pid. */
function spawnTree(): Promise<{ pid: number; childPid: number }> {
  const script = [
    "const { spawn } = require('node:child_process')",
    "const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })",
    'console.log(child.pid)',
    'setInterval(()=>{},1000)',
  ].join('\n')

  const parent = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] })
  assert.ok(parent.pid)

  return new Promise((resolve, reject) => {
    let out = ''
    parent.stdout.setEncoding('utf8')
    parent.stdout.on('data', chunk => {
      out += chunk
      const first = out.split('\n')[0]?.trim() ?? ''
      if (/^\d+$/.test(first)) resolve({ pid: parent.pid as number, childPid: Number(first) })
    })
    parent.on('error', reject)
  })
}

test('killTree tue le processus et son enfant en moins de 3 s', async () => {
  const tree = await spawnTree()
  assert.ok(isAlive(tree.pid))
  assert.ok(isAlive(tree.childPid))

  const started = Date.now()
  const result = killTree(tree.pid)
  const elapsed = Date.now() - started

  assert.equal(result.ok, true)
  assert.equal(result.remaining, false)
  assert.ok(elapsed < 3_000, `arrêt trop lent : ${elapsed} ms`)

  await waitFor(() => !isAlive(tree.pid) && !isAlive(tree.childPid), 2_000)
  assert.equal(isAlive(tree.childPid), false)
})

test('un processus déjà mort est un arrêt réussi, sans erreur', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  assert.ok(child.pid)
  await new Promise(resolve => child.on('exit', resolve))

  const result = killTree(child.pid as number)
  assert.equal(result.ok, true)
  assert.equal(result.remaining, false)
})

test('un taskkill en échec signale le PID restant', () => {
  const result = killTree(4242, { alive: () => true, taskkill: () => 1 })

  assert.equal(result.ok, false)
  assert.equal(result.pid, 4242)
  assert.equal(result.remaining, true)
})

test('après 20 arrêts, aucun processus enfant ne survit', async () => {
  for (let i = 0; i < 20; i++) {
    const tree = await spawnTree()
    killTree(tree.pid)
    await waitFor(() => !isAlive(tree.pid) && !isAlive(tree.childPid), 2_000)
  }
})
