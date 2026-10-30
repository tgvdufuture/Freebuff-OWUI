import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Journal } from '../src/freebuff/journal.ts'

const tempDir = (): string => mkdtempSync(path.join(os.tmpdir(), 'fb-journal-'))

const linesOf = (file: string): Array<Record<string, unknown>> =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>)

test('un fichier par jour, une ligne JSON par événement', () => {
  const dir = tempDir()
  const journal = new Journal({ dir, now: () => new Date('2026-10-21T10:00:00Z') })

  journal.write('binding', { chatId: 'chat-1', projectPath: 'D:/code/alpha' })
  journal.write('refusal', { status: 409, code: 'regeneration_refused' })

  assert.deepEqual(readdirSync(dir), ['bridge-2026-10-21.log'])
  const lines = linesOf(path.join(dir, 'bridge-2026-10-21.log'))
  assert.equal(lines.length, 2)
  assert.equal(lines[0]?.event, 'binding')
  assert.equal(lines[0]?.chatId, 'chat-1')
  assert.equal(lines[1]?.code, 'regeneration_refused')
  assert.equal(typeof lines[0]?.at, 'string')
})

test('le jour suivant écrit un nouveau fichier', () => {
  const dir = tempDir()
  let now = new Date('2026-10-21T23:59:00Z')
  const journal = new Journal({ dir, now: () => now })

  journal.write('un')
  now = new Date('2026-10-22T00:01:00Z')
  journal.write('deux')

  assert.deepEqual(readdirSync(dir).sort(), ['bridge-2026-10-21.log', 'bridge-2026-10-22.log'])
  assert.equal(linesOf(path.join(dir, 'bridge-2026-10-22.log'))[0]?.event, 'deux')
})

test('dépasser la taille limite fait passer au fichier suivant', () => {
  const dir = tempDir()
  const journal = new Journal({
    dir,
    maxBytes: 200,
    now: () => new Date('2026-10-21T10:00:00Z'),
  })

  for (let i = 0; i < 8; i++) journal.write('event', { i, texte: 'x'.repeat(30) })

  const files = readdirSync(dir).sort()
  assert.ok(files.length >= 2, `un seul fichier : ${files.join(', ')}`)
  assert.ok(files.includes('bridge-2026-10-21.log'))
  assert.ok(files.includes('bridge-2026-10-21.1.log'))
  assert.equal(
    files.reduce((total, file) => total + linesOf(path.join(dir, file)).length, 0),
    8,
  )
})
