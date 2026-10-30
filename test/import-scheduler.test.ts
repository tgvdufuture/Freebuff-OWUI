import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importIntervalMs } from '../src/config.ts'
import {
  ImportBusyError,
  ImportScheduler,
  acquireImportLock,
  importHealth,
  readStore,
  runImport,
  writeStore,
  type ImportOptions,
} from '../src/freebuff/importer.ts'
import { OwuiError, type OwuiChatPayload, type OwuiClient } from '../src/freebuff/owui.ts'
import type { TranscriptFileEntry } from '../src/freebuff/archive.ts'
import { buildServer } from '../src/server.ts'

const REF1 = '2026-10-01T10-00-00.000Z'
const REF2 = '2026-10-02T11-30-00.000Z'
const MTIME1 = 1_790_851_200_000
const MTIME2 = 1_790_956_200_000

function user(content: string): TranscriptFileEntry {
  return { variant: 'user', content, timestamp: '10:00' }
}

function ai(text: string): TranscriptFileEntry {
  return {
    variant: 'ai',
    content: '',
    timestamp: '10:01',
    blocks: [{ type: 'text', textType: 'text', content: text }],
  }
}

function writeChat(profile: string, project: string, ref: string, mtimeMs = MTIME1): void {
  const dir = path.join(profile, 'projects', project, 'chats', ref)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'chat-meta.json'),
    JSON.stringify({ messageCount: 2, firstPrompt: 'consigne', messagesMtimeMs: mtimeMs }),
    'utf8',
  )
  writeFileSync(
    path.join(dir, 'chat-messages.json'),
    JSON.stringify([user('Bonjour'), ai('Salut')]),
    'utf8',
  )
}

let fakeSeq = 0
function fakeId(prefix: string): string {
  fakeSeq += 1
  return `${prefix}-${String(fakeSeq)}`
}

class FakeOwui implements OwuiClient {
  readonly chats = new Map<string, { updatedAt: number; payload?: OwuiChatPayload }>()
  readonly folders: Array<{ id: string; name: string; meta: Record<string, unknown> | null }> = []
  /** Fait échouer le N-ième import (1-indexé) comme un réseau coupé. */
  failOnImport: number | null = null
  importCalls = 0

  async ensureFolder(name: string): Promise<string> {
    const found = this.folders.find(folder => folder.name === name)
    if (found !== undefined) return found.id
    const id = fakeId('folder')
    this.folders.push({ id, name, meta: null })
    return id
  }

  async listFolders() {
    return this.folders.map(folder => ({ ...folder }))
  }

  async chatFolder() {
    return null
  }

  async updateFolderMeta(id: string, meta: Record<string, unknown>): Promise<void> {
    const folder = this.folders.find(item => item.id === id)
    if (folder === undefined) throw new Error(`dossier inconnu : ${id}`)
    folder.meta = { ...(folder.meta ?? {}), ...meta }
  }

  async importChat(payload: OwuiChatPayload) {
    this.importCalls += 1
    if (this.importCalls === this.failOnImport) throw new TypeError('fetch failed')
    const id = fakeId('chat')
    this.chats.set(id, { updatedAt: payload.updated_at, payload })
    return { id, updatedAt: payload.updated_at }
  }

  async listChats() {
    return [...this.chats.entries()].map(([id, chat]) => ({
      id,
      title: chat.payload?.chat.title ?? '',
      createdAt: chat.payload?.created_at ?? 0,
      updatedAt: chat.updatedAt,
    }))
  }

  async getChat(id: string) {
    const chat = this.chats.get(id)
    if (chat === undefined) throw new Error(`chat inconnu : ${id}`)
    return { id, updatedAt: chat.updatedAt }
  }

  async updateChat(id: string, chat: OwuiChatPayload['chat']) {
    const current = this.chats.get(id)
    if (current === undefined) throw new Error(`chat inconnu : ${id}`)
    current.updatedAt += 1
    current.payload = { ...current.payload, chat } as OwuiChatPayload
    return { id, updatedAt: current.updatedAt }
  }

  async moveChat(id: string) {
    // Aucun chat n'est déplacé dans ces tests (dossier identique dès l'import).
    const chat = this.chats.get(id)
    if (chat === undefined) throw new Error(`chat inconnu : ${id}`)
    chat.updatedAt += 1
    return { id, updatedAt: chat.updatedAt }
  }
}

function options(profile: string, client: OwuiClient, dataFile: string): ImportOptions {
  return { dataFile, profiles: [{ name: 'profil', dir: profile }], client, model: 'modele-test' }
}

test('l’intervalle par défaut est 15 min et 0 désactive le cycle', () => {
  assert.equal(importIntervalMs({}), 900_000)
  assert.equal(importIntervalMs({ BRIDGE_IMPORT_INTERVAL_MS: '0' }), 0)
  assert.equal(importIntervalMs({ BRIDGE_IMPORT_INTERVAL_MS: '60000' }), 60_000)
  assert.equal(importIntervalMs({ BRIDGE_IMPORT_INTERVAL_MS: '-1' }), 900_000)

  const scheduler = new ImportScheduler({ intervalMs: 0, run: async () => undefined })
  assert.equal(scheduler.enabled, false)
  assert.equal(scheduler.start(), false)
})

test('deux déclenchements ne se chevauchent pas et stop annule le minuteur', async () => {
  let calls = 0
  let release!: () => void
  let interval = 0
  let cancelled = false
  let fire!: () => void
  const scheduler = new ImportScheduler({
    intervalMs: 1_000,
    run: () => {
      calls += 1
      return new Promise<void>(resolve => {
        release = resolve
      })
    },
    schedule: (run, ms) => {
      interval = ms
      fire = run
      return () => {
        cancelled = true
      }
    },
  })

  assert.equal(scheduler.start(), true)
  assert.equal(scheduler.start(), false)
  assert.equal(interval, 1_000)

  fire()
  await Promise.resolve()
  await scheduler.runNow()
  assert.equal(calls, 1)

  release()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(scheduler.running, false)

  scheduler.stop()
  assert.equal(cancelled, true)
})

test('un échec est retenu dans lastError puis effacé au cycle suivant', async () => {
  let fail = true
  const scheduler = new ImportScheduler({
    intervalMs: 1_000,
    run: async () => {
      if (fail) throw new Error('OWUI absent')
    },
  })

  await scheduler.runNow()
  assert.equal(scheduler.lastError, 'OWUI absent')
  assert.equal(scheduler.lastRunAt, null)

  fail = false
  await scheduler.runNow()
  assert.equal(scheduler.lastError, null)
  assert.equal(typeof scheduler.lastRunAt, 'number')
})

test('un verrou vivant refuse le second import, un verrou mort est repris', () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'fb-lock-')), 'imports.json.lock')
  const now = () => 1_800_000_000_000
  const release = acquireImportLock(file, now)
  assert.throws(() => acquireImportLock(file, now), ImportBusyError)
  release()
  assert.equal(existsSync(file), false)

  // Processus mort : le verrou est repris immédiatement.
  writeFileSync(file, JSON.stringify({ pid: 999_999, at: now(), token: 'mort' }), 'utf8')
  const taken = acquireImportLock(file, now)
  taken()

  // Verrou trop vieux, même si son PID existe encore (PID recyclé).
  writeFileSync(file, JSON.stringify({ pid: process.pid, at: now() - 16 * 60_000, token: 'vieux' }), 'utf8')
  const stale = acquireImportLock(file, now)
  stale()
})

test('une nouvelle conversation apparaît au cycle suivant', async () => {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'fb-cycle-'))
  writeChat(profile, 'Alpha', REF1)
  const client = new FakeOwui()
  const dataFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'fb-store-')), 'imports.json')
  const scheduler = new ImportScheduler({
    intervalMs: 1_000,
    run: () => runImport(options(profile, client, dataFile)),
  })

  await scheduler.runNow()
  assert.equal(client.chats.size, 1)
  assert.equal(Object.keys(readStore(dataFile).items).length, 1)

  writeChat(profile, 'Alpha', REF2, MTIME2)
  await scheduler.runNow()

  assert.equal(client.chats.size, 2)
  assert.equal(Object.keys(readStore(dataFile).items).length, 2)
  assert.equal(scheduler.lastError, null)
})

test('une panne OWUI arrête le cycle, rien n’est marqué importé, lastError est visible', async () => {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'fb-cycle-'))
  writeChat(profile, 'Alpha', REF1)
  const dataFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'fb-store-')), 'imports.json')
  class UnauthorizedOwui extends FakeOwui {
    override async ensureFolder(): Promise<string> {
      throw new OwuiError('GET /api/v1/folders/ → 401', 401, 'Non autorisé')
    }
  }
  const client = new UnauthorizedOwui()
  const scheduler = new ImportScheduler({
    intervalMs: 1_000,
    run: () => runImport(options(profile, client, dataFile)),
  })

  await scheduler.runNow()

  assert.match(scheduler.lastError ?? '', /401/)
  assert.equal(Object.keys(readStore(dataFile).items).length, 0)
  assert.match(importHealth(dataFile).lastError ?? '', /401/)
})

test('un arrêt au milieu d’un import ne crée aucun doublon', async () => {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'fb-crash-'))
  writeChat(profile, 'Alpha', REF1)
  writeChat(profile, 'Alpha', REF2, MTIME2)
  const dataFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'fb-store-')), 'imports.json')

  const broken = new FakeOwui()
  broken.failOnImport = 2
  await assert.rejects(() => runImport(options(profile, broken, dataFile)), /fetch failed/)

  const first = readStore(dataFile).items
  assert.equal(Object.keys(first).length, 1)
  const keptKey = Object.keys(first)[0] ?? ''
  const keptId = first[keptKey]?.owuiChatId
  assert.equal(broken.chats.size, 1)

  // Même OWUI, réseau réparé : la reprise ne recrée pas le chat déjà importé.
  broken.failOnImport = null
  const second = await runImport(options(profile, broken, dataFile))

  assert.equal(second.report.created, 1)
  assert.equal(second.report.errors.length, 0)
  assert.equal(Object.keys(readStore(dataFile).items).length, 2)
  assert.equal(broken.chats.size, 2)
  assert.equal(readStore(dataFile).items[keptKey]?.owuiChatId, keptId)
})

test('un chat créé juste avant un crash est retrouvé, pas recréé', async () => {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'fb-crash-window-'))
  writeChat(profile, 'Alpha', REF1)
  const client = new FakeOwui()
  const dataFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'fb-store-')), 'imports.json')
  const importRun = options(profile, client, dataFile)

  const first = await runImport(importRun)
  const key = Object.keys(first.store.items)[0] ?? ''
  const item = first.store.items[key]
  assert.ok(item !== undefined)
  const payload = client.chats.get(item.owuiChatId)?.payload
  assert.ok(payload !== undefined)

  // Simule la mort du pont entre la réponse d'OWUI et l'écriture de `items`.
  writeStore(dataFile, {
    ...first.store,
    items: {},
    pending: {
      key,
      title: payload.chat.title,
      createdAt: payload.created_at,
      mtimeMs: item.mtimeMs,
      size: item.size,
      profileDir: item.profileDir,
      projectDir: item.projectDir,
      ref: item.ref,
      folder: item.folder ?? 'Alpha',
      folderId: item.folderId ?? '',
      truncated: false,
    },
  })

  const second = await runImport(importRun)

  assert.equal(second.report.created, 0)
  assert.equal(client.chats.size, 1)
  assert.equal(Object.keys(second.store.items).length, 1)
  assert.equal(second.store.items[key]?.owuiChatId, item.owuiChatId)
  assert.equal(second.store.pending, null)
})

test('/health expose l’état du planificateur et sa dernière erreur', async () => {
  const scheduler = new ImportScheduler({
    intervalMs: 60_000,
    run: async () => {
      throw new Error('OWUI absent')
    },
  })
  await scheduler.runNow()

  const app = buildServer({
    importScheduler: scheduler,
    bindingsFile: path.join(mkdtempSync(path.join(os.tmpdir(), 'fb-bindings-')), 'bindings.json'),
  })
  try {
    const response = await app.inject({ method: 'GET', url: '/health' })
    const body = response.json() as {
      import: { enabled: boolean; intervalMs: number; lastError: string | null }
    }
    assert.equal(body.import.enabled, true)
    assert.equal(body.import.intervalMs, 60_000)
    assert.equal(body.import.lastError, 'OWUI absent')
  } finally {
    await app.close()
  }
})
