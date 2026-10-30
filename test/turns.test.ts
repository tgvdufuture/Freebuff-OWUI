import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { TurnLog, recordOf } from '../src/freebuff/turns.ts'

test('un tour est écrit sur une ligne avec son issue et son statut', () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'fb-turns-')), 'turns.jsonl')
  const log = new TurnLog(file)

  log.append(
    recordOf({
      at: 1_700_000_000_000,
      chatId: 'chat-1',
      projectPath: 'D:/code/alpha',
      outcome: 'session_ended',
      failure: { message: 'Your free session has ended.', code: 'waiting_room_required', status: 428 },
    }),
  )
  log.append(
    recordOf({
      at: 1_700_000_001_000,
      chatId: 'chat-1',
      projectPath: 'D:/code/alpha',
      outcome: 'ok',
    }),
  )

  const lines = readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  assert.deepEqual(JSON.parse(lines[0] ?? ''), {
    at: 1_700_000_000_000,
    chatId: 'chat-1',
    projectPath: 'D:/code/alpha',
    outcome: 'session_ended',
    status: 428,
  })
  assert.equal((JSON.parse(lines[1] ?? '') as { status: number | null }).status, null)
})

test('un fichier inaccessible ne fait pas échouer un tour', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fb-turns-blocked-'))
  const blocker = path.join(dir, 'un-fichier')
  writeFileSync(blocker, '', 'utf8')
  const log = new TurnLog(path.join(blocker, 'turns.jsonl'))

  assert.doesNotThrow(() =>
    log.append(recordOf({ chatId: 'c', projectPath: 'p', outcome: 'refused' })),
  )
})
