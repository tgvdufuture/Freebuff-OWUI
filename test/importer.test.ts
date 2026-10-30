import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Bindings } from '../src/bindings.ts'
import {
  LEGACY_PROJECT,
  importHealth,
  profileList,
  readStore,
  runImport,
  scanConversations,
  type ImportOptions,
} from '../src/freebuff/importer.ts'
import type { OwuiChatPayload, OwuiClient } from '../src/freebuff/owui.ts'
import type { TranscriptFileEntry } from '../src/freebuff/archive.ts'

const REF1 = '2026-10-01T10-00-00.000Z'
const REF2 = '2026-10-02T11-30-00.000Z'
const MTIME1 = 1_790_851_200_000
const MTIME2 = 1_790_956_200_000
const NOW = 1_800_000_000_000

function profileDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'fb-import-'))
}

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

interface ChatOptions {
  entries?: TranscriptFileEntry[]
  meta?: Record<string, unknown>
  runState?: Record<string, unknown> | null
  messages?: boolean
  mtimeMs?: number
}

function writeChatAt(dir: string, options: ChatOptions = {}): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'chat-meta.json'),
    JSON.stringify({
      messageCount: 2,
      firstPrompt: 'META TRONQUÉE',
      messagesMtimeMs: options.mtimeMs ?? MTIME1,
      ...options.meta,
    }),
    'utf8',
  )
  if (options.messages !== false) {
    writeFileSync(
      path.join(dir, 'chat-messages.json'),
      JSON.stringify(options.entries ?? [user('Bonjour'), ai('Salut')]),
      'utf8',
    )
  }
  if (options.runState !== null) {
    writeFileSync(
      path.join(dir, 'run-state.json'),
      JSON.stringify(
        options.runState ?? { sessionState: { fileContext: { projectRoot: `D:\\code\\${path.basename(path.dirname(path.dirname(dir)))}` } } },
      ),
      'utf8',
    )
  }
  return dir
}

function writeChat(profile: string, project: string, ref: string, options: ChatOptions = {}): string {
  return writeChatAt(path.join(profile, 'projects', project, 'chats', ref), options)
}

function writeLegacyChat(profile: string, ref: string, options: ChatOptions = {}): string {
  return writeChatAt(path.join(profile, 'projects', 'chats', ref), options)
}

class FakeOwui implements OwuiClient {
  readonly chats = new Map<string, { updatedAt: number; payload?: OwuiChatPayload }>()
  readonly folders: Array<{ id: string; name: string; meta: Record<string, unknown> | null }> = []
  readonly folderByChat = new Map<string, string>()
  folderUpdates = 0
  private seq = 0

  async ensureFolder(name: string): Promise<string> {
    const found = this.folders.find(folder => folder.name === name)
    if (found !== undefined) return found.id
    const id = `folder-${String(++this.seq)}`
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
    this.folderUpdates += 1
    folder.meta = { ...(folder.meta ?? {}), ...meta }
  }

  async importChat(payload: OwuiChatPayload) {
    const id = `chat-${String(++this.seq)}`
    this.chats.set(id, { updatedAt: payload.updated_at, payload })
    if (payload.folder_id !== null) this.folderByChat.set(id, payload.folder_id)
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

  async moveChat(id: string, folderId: string) {
    if (!this.chats.has(id)) throw new Error(`chat inconnu : ${id}`)
    this.folderByChat.set(id, folderId)
    const chat = this.chats.get(id)
    if (chat === undefined) throw new Error(`chat inconnu : ${id}`)
    chat.updatedAt += 1
    if (chat.payload !== undefined) chat.payload = { ...chat.payload, folder_id: folderId }
    return { id, updatedAt: chat.updatedAt }
  }

  /** Simule un chat touché dans l'interface OWUI. */
  touch(id: string): void {
    const chat = this.chats.get(id)
    if (chat === undefined) throw new Error(`chat inconnu : ${id}`)
    chat.updatedAt += 1000
  }
}

function importOptions(
  profiles: Array<{ name: string; dir: string }>,
  client: OwuiClient,
  dataFile: string,
  extra: Partial<ImportOptions> = {},
): ImportOptions {
  return {
    dataFile,
    profiles,
    client,
    model: 'modele-test',
    now: () => NOW,
    ...extra,
  }
}

function workspace(): { root: string; project: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fb-workspace-'))
  const project = path.join(root, 'NomReel')
  mkdirSync(project, { recursive: true })
  return { root, project }
}

test('tous les profils de ~/.config sont scannés, connus d’abord, une seule fois chacun', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'fb-home-'))
  const config = path.join(home, '.config')
  for (const name of ['freebuff2', 'manicode', 'freebuff', 'freebuff-session', 'freebuff-desktop', 'moncompte']) {
    mkdirSync(path.join(config, name), { recursive: true })
    writeFileSync(path.join(config, name, 'credentials.json'), '{}', 'utf8')
  }
  // Un dossier sans credentials.json n'est pas un profil.
  mkdirSync(path.join(config, 'pas-un-profil'), { recursive: true })

  const extra = path.join(config, 'freebuff-session')
  const list = profileList(undefined, home, extra)

  assert.deepEqual(
    list.map(profile => profile.name),
    ['freebuff-session', 'freebuff', 'manicode', 'freebuff-desktop', 'freebuff2', 'moncompte'],
  )
  assert.equal(profileList('freebuff-session', home, extra).length, 1)
  assert.match(profileList(path.join(home, 'ailleurs'), home).at(0)?.dir ?? '', /ailleurs$/)
})

test('le scan trouve les conversations valides, compte les dossiers vides et n’échoue pas sur un profil illisible', () => {
  const good = profileDir()
  writeChat(good, 'Alpha', REF1)
  writeChat(good, 'Alpha', REF2, { runState: { sessionState: { fileContext: { projectRoot: 'D:\\code\\Beta' } } } })
  writeChat(good, 'Alpha', '2026-10-03T10-00-00.000Z', { messages: false })
  writeLegacyChat(good, '2026-08-14T11-13-23.570Z')
  mkdirSync(path.join(good, 'projects', 'Alpha', 'chats', 'dossier-fantome'))

  const empty = path.join(profileDir(), 'vide')
  mkdirSync(empty)
  const bad = path.join(profileDir(), 'fichier-profil')
  writeFileSync(bad, '', 'utf8')

  const scan = scanConversations([
    { name: 'profil', dir: good },
    { name: 'vide', dir: empty },
    { name: 'illisible', dir: bad },
  ])

  assert.equal(scan.candidates.length, 3)
  assert.deepEqual(
    scan.candidates.map(candidate => candidate.ref).sort(),
    [REF1, REF2, '2026-08-14T11-13-23.570Z'].sort(),
  )
  assert.equal(scan.candidates.find(candidate => candidate.ref.startsWith('2026-08-14'))?.projectDir, LEGACY_PROJECT)
  assert.equal(scan.candidates.find(candidate => candidate.ref === REF2)?.projectDir, 'Alpha')
  assert.ok(scan.skipped >= 2)
  assert.equal(scan.errors.length, 1)
  assert.match(scan.errors[0] ?? '', /profil illisible/)
})

test('un premier passage crée un chat par conversation, dans un dossier par profil', async () => {
  const profile = profileDir()
  writeChat(profile, 'Alpha', REF1, {
    entries: [user('Première consigne réelle'), ai('Réponse')],
  })
  writeChat(profile, 'Alpha', REF2, {
    entries: [user('Deuxième consigne réelle'), ai('Réponse')],
    mtimeMs: MTIME2,
  })
  const client = new FakeOwui()
  const dataFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'fb-store-')), 'imports.json')

  const { report, store } = await runImport(
    importOptions([{ name: 'profil', dir: profile }], client, dataFile),
  )

  assert.equal(report.scanned, 2)
  assert.equal(report.created, 2)
  assert.equal(report.errors.length, 0)
  assert.equal(client.folders.length, 1)
  assert.equal(client.folders[0]?.name, 'Alpha')
  assert.equal(client.chats.size, 2)
  assert.equal(Object.keys(store.items).length, 2)

  const payloads = [...client.chats.values()].map(chat => chat.payload)
  const first = payloads.find(payload => payload?.chat.title === '[Alpha] Première consigne réelle')
  const second = payloads.find(payload => payload?.chat.title === '[Alpha] Deuxième consigne réelle')
  assert.equal(first?.created_at, Math.floor(Date.UTC(2026, 9, 1, 10, 0, 0) / 1000))
  assert.equal(first?.updated_at, Math.floor(MTIME1 / 1000))
  assert.equal(second?.created_at, Math.floor(Date.UTC(2026, 9, 2, 11, 30, 0) / 1000))
  assert.equal(second?.updated_at, Math.floor(MTIME2 / 1000))
  for (const payload of payloads) {
    assert.ok(payload !== undefined)
    assert.equal(payload.folder_id, client.folders[0]?.id)
    assert.deepEqual(payload.meta.tags, ['freebuff', 'profil', 'Alpha'])
    assert.equal(payload.chat.history.messages[payload.chat.history.currentId ?? '']?.done, true)
  }

  const health = importHealth(dataFile)
  assert.equal(health.scanned, 2)
  assert.equal(health.created, 2)
  assert.equal(health.lastRunAt, NOW)
  assert.equal(health.lastError, null)
})

test('le dossier porte l’activité du chat le plus récent, sans réécriture inutile', async () => {
  const profile = profileDir()
  writeChat(profile, 'Alpha', REF1, { mtimeMs: MTIME1 })
  writeChat(profile, 'Alpha', REF2, { mtimeMs: MTIME2 })
  const client = new FakeOwui()
  const dataFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'fb-store-')), 'imports.json')
  const options = importOptions([{ name: 'profil', dir: profile }], client, dataFile)

  await runImport(options)

  assert.equal(client.folders.length, 1)
  assert.equal(
    client.folders[0]?.meta?.lastActivity,
    Math.floor(MTIME2 / 1000),
    'activité = updated_at du chat le plus récent',
  )
  assert.equal(client.folderUpdates, 1)

  // Second passage : rien n'a bougé, aucun POST de dossier inutile.
  const second = await runImport(options)
  assert.equal(second.report.created, 0)
  assert.equal(client.folderUpdates, 1)
})

test('chaque projet a son dossier, quel que soit le profil', async () => {
  const profileA = profileDir()
  const profileB = profileDir()
  const { root, project } = workspace()
  const beta = path.join(root, 'Beta')
  mkdirSync(beta, { recursive: true })
  writeChat(profileA, 'Alpha', REF1, {
    runState: { sessionState: { fileContext: { projectRoot: project } } },
  })
  writeChat(profileB, 'Beta', REF2, {
    runState: { sessionState: { fileContext: { projectRoot: beta } } },
    mtimeMs: MTIME2,
  })
  const client = new FakeOwui()
  const dataFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'fb-store-')), 'imports.json')

  const { store } = await runImport(
    importOptions(
      [
        { name: 'profilA', dir: profileA },
        { name: 'profilB', dir: profileB },
      ],
      client,
      dataFile,
      { projectsRoot: [root], currentProfile: profileA },
    ),
  )

  assert.deepEqual(client.folders.map(folder => folder.name).sort(), ['Beta', 'NomReel'])
  assert.deepEqual(Object.keys(store.projectFolders).sort(), ['Beta', 'NomReel'])
  const payloads = [...client.chats.values()].map(chat => chat.payload)
  const byTitle = new Map(payloads.map(payload => [payload?.chat.title.split(']')[0], payload]))
  assert.equal(byTitle.get('[NomReel')?.folder_id, client.folders.find(f => f.name === 'NomReel')?.id)
  assert.equal(byTitle.get('[Beta')?.folder_id, client.folders.find(f => f.name === 'Beta')?.id)
})

test('un ancien chat de dossier de profil migre vers le dossier du projet', async () => {
  const profile = profileDir()
  const { root, project } = workspace()
  const dir = writeChat(profile, 'Alpha', REF1, {
    runState: { sessionState: { fileContext: { projectRoot: project } } },
  })
  const stat = statSync(path.join(dir, 'chat-messages.json'))
  const dataFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'fb-store-')), 'imports.json')
  writeFileSync(
    dataFile,
    JSON.stringify({
      version: 1,
      folders: { profil: 'old-folder' },
      items: {
        [`profil/Alpha/${REF1}`]: {
          owuiChatId: 'chat-old',
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          importedAt: NOW,
          owuiUpdatedAt: 123,
          profileDir: profile,
          projectDir: 'Alpha',
          ref: REF1,
          bound: false,
          truncated: false,
          stale: false,
        },
      },
      lastRun: null,
    }),
    'utf8',
  )
  const client = new FakeOwui()
  client.chats.set('chat-old', { updatedAt: 123 })
  const options = importOptions([{ name: 'profil', dir: profile }], client, dataFile, {
    projectsRoot: [root],
    currentProfile: profile,
  })

  const first = await runImport(options)
  const item = Object.values(first.store.items)[0]
  const folder = client.folders.find(entry => entry.name === 'NomReel')
  assert.equal(first.report.unchanged, 1)
  assert.equal(item?.folder, 'NomReel')
  assert.equal(item?.folderId, folder?.id)
  assert.equal(client.folderByChat.get('chat-old'), folder?.id)
  // Le déplacement réécrit `updated_at` : l'empreinte doit suivre, sinon le
  // chat passerait pour « touché dans OWUI » et ne serait plus synchronisé.
  assert.equal(item?.owuiUpdatedAt, 124)

  // Dossier supprimé dans OWUI : il est recréé et le chat le suit.
  client.folders.splice(0)
  const second = await runImport(options)
  const recreated = client.folders.find(entry => entry.name === 'NomReel')
  assert.notEqual(recreated?.id, folder?.id)
  assert.equal(Object.values(second.store.items)[0]?.folderId, recreated?.id)
  assert.equal(client.folderByChat.get('chat-old'), recreated?.id)
  assert.equal(Object.values(second.store.items)[0]?.owuiUpdatedAt, 125)
})

test('un second passage ne crée aucun doublon et ne réécrit rien', async () => {
  const profile = profileDir()
  writeChat(profile, 'Alpha', REF1)
  writeChat(profile, 'Alpha', REF2, { mtimeMs: MTIME2 })
  const client = new FakeOwui()
  const dataFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'fb-store-')), 'imports.json')
  const options = importOptions([{ name: 'profil', dir: profile }], client, dataFile)

  await runImport(options)
  const second = await runImport(options)

  assert.equal(second.report.created, 0)
  assert.equal(second.report.updated, 0)
  assert.equal(second.report.unchanged, 2)
  assert.equal(client.chats.size, 2)
  assert.equal(Object.keys(readStore(dataFile).items).length, 2)
})

test('le scan ne modifie aucun fichier de chats/', async () => {
  const profile = profileDir()
  const dir = writeChat(profile, 'Alpha', REF1, { runState: null })
  const files = readdirSync(dir).sort()
  const before = files.map(file => [
    file,
    readFileSync(path.join(dir, file), 'utf8'),
    statSync(path.join(dir, file)).mtimeMs,
  ])

  await runImport(
    importOptions([{ name: 'profil', dir: profile }], new FakeOwui(), path.join(profile, 'imports.json')),
  )

  assert.ok(files.length > 0)
  for (const [file, content, mtime] of before) {
    assert.equal(readFileSync(path.join(dir, String(file)), 'utf8'), content)
    assert.equal(statSync(path.join(dir, String(file))).mtimeMs, mtime)
  }
})

test('un transcript modifié met à jour un chat intact, mais jamais un chat touché dans OWUI', async () => {
  const profile = profileDir()
  const dir = writeChat(profile, 'Alpha', REF1)
  const client = new FakeOwui()
  const dataFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'fb-store-')), 'imports.json')
  const options = importOptions([{ name: 'profil', dir: profile }], client, dataFile)

  await runImport(options)
  const key = Object.keys(readStore(dataFile).items)[0] ?? ''
  const chatId = readStore(dataFile).items[key]?.owuiChatId ?? ''

  writeChatAt(dir, {
    entries: [user('Bonjour'), ai('Salut'), user('Suite'), ai('Réponse suite')],
  })
  const untouched = await runImport(options)
  assert.equal(untouched.report.updated, 1)
  assert.equal(client.chats.get(chatId)?.payload?.chat.history.messages !== undefined, true)
  assert.equal(Object.keys(client.chats.get(chatId)?.payload?.chat.history.messages ?? {}).length, 4)

  client.touch(chatId)
  writeChatAt(dir, {
    entries: [user('Bonjour'), ai('Salut'), user('Suite'), ai('Réponse suite'), user('Encore'), ai('Final')],
  })
  const touched = await runImport(options)

  assert.equal(touched.report.updated, 0)
  assert.equal(touched.report.stale, 1)
  assert.equal(readStore(dataFile).items[key]?.stale, true)
  assert.equal(Object.keys(client.chats.get(chatId)?.payload?.chat.history.messages ?? {}).length, 4)
})

test('une conversation sans dossier de projet est importée sous « sans projet »', async () => {
  const profile = profileDir()
  writeLegacyChat(profile, '2026-08-14T11-13-23.570Z', {
    entries: [user('Salut'), ai('Bonjour')],
    runState: { sessionState: { fileContext: { projectRoot: 'D:\\' } } },
  })
  const client = new FakeOwui()
  const dataFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'fb-store-')), 'imports.json')

  const { report, store } = await runImport(
    importOptions([{ name: 'profil', dir: profile }], client, dataFile),
  )

  assert.equal(report.created, 1)
  assert.equal(Object.keys(store.items)[0], `profil/${LEGACY_PROJECT}/2026-08-14T11-13-23.570Z`)
  const payload = [...client.chats.values()][0]?.payload
  assert.equal(payload?.chat.title, '[sans projet] Salut')
  assert.deepEqual(payload?.meta.tags, ['freebuff', 'profil', LEGACY_PROJECT])
})

test('le nom du projet vient de run-state.json, pas du dossier', async () => {
  const profile = profileDir()
  const { root, project } = workspace()
  writeChat(profile, 'dossier', REF1, {
    entries: [user('Salut'), ai('Bonjour')],
    runState: { sessionState: { fileContext: { projectRoot: project } } },
  })
  const client = new FakeOwui()
  const dataFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'fb-store-')), 'imports.json')

  await runImport(
    importOptions([{ name: 'profil', dir: profile }], client, dataFile, { projectsRoot: [root] }),
  )

  const payload = [...client.chats.values()][0]?.payload
  assert.equal(payload?.chat.title, '[NomReel] Salut')
  assert.deepEqual(payload?.meta.tags, ['freebuff', 'profil', 'NomReel'])
})

test('un chat importé du profil courant est lié à sa conversation CLI', async () => {
  const profile = profileDir()
  const { root, project } = workspace()
  writeChat(profile, 'Alpha', REF1, {
    entries: [user('Bonjour'), ai('Salut')],
    runState: { sessionState: { fileContext: { projectRoot: project } } },
  })
  const client = new FakeOwui()
  const dataFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'fb-store-')), 'imports.json')
  const bindingsFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'fb-bindings-')), 'bindings.json')
  const bindings = new Bindings(bindingsFile)

  const { store } = await runImport(
    importOptions([{ name: 'profil', dir: profile }], client, dataFile, {
      projectsRoot: [root],
      currentProfile: profile,
      bindings,
    }),
  )

  const item = Object.values(store.items)[0]
  assert.equal(item?.bound, true)
  assert.equal(bindings.count(), 1)
  const stored = JSON.parse(readFileSync(bindingsFile, 'utf8')) as Record<
    string,
    Record<string, unknown>
  >
  const record = stored[item?.owuiChatId ?? '']
  assert.ok(record !== undefined)
  assert.equal(record.projectPath, project.replace(/\\/g, '/'))
  assert.equal(record.resumeRef, REF1)
  assert.deepEqual(record.chatRefs, [REF1])
  assert.deepEqual(record.signatures, [])
  assert.equal(record.profileDir, profile)
  assert.equal(record.importedAt, NOW)
  assert.equal(record.lastTurnAt, Math.round(item?.mtimeMs ?? 0))

  // Un second passage ne remplace pas le binding et ne compte aucun nouveau lié.
  const second = await runImport(
    importOptions([{ name: 'profil', dir: profile }], client, dataFile, {
      projectsRoot: [root],
      currentProfile: profile,
      bindings,
    }),
  )
  assert.equal(second.report.unchanged, 1)
  assert.equal(bindings.count(), 1)
  assert.equal(Object.values(second.store.items)[0]?.bound, true)
})

test('un chat importé d’un autre profil n’est jamais lié', async () => {
  const profile = profileDir()
  const otherProfile = profileDir()
  const { root, project } = workspace()
  writeChat(profile, 'Alpha', REF1, {
    runState: { sessionState: { fileContext: { projectRoot: project } } },
  })
  const bindings = new Bindings(
    path.join(mkdtempSync(path.join(os.tmpdir(), 'fb-bindings-')), 'bindings.json'),
  )
  const client = new FakeOwui()
  const dataFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'fb-store-')), 'imports.json')

  const { store } = await runImport(
    importOptions([{ name: 'profil', dir: profile }], client, dataFile, {
      projectsRoot: [root],
      currentProfile: otherProfile,
      bindings,
    }),
  )

  assert.equal(Object.values(store.items)[0]?.bound, false)
  assert.equal(bindings.count(), 0)
})

test('sans run-state ou hors des racines, le chat reste une archive', async () => {
  const profile = profileDir()
  const { root } = workspace()
  writeChat(profile, 'Alpha', REF1, { runState: null })
  writeChat(profile, 'Alpha', REF2, {
    runState: { sessionState: { fileContext: { projectRoot: path.join(root, '..', 'Ailleurs') } } },
    mtimeMs: MTIME2,
  })
  const bindings = new Bindings(
    path.join(mkdtempSync(path.join(os.tmpdir(), 'fb-bindings-')), 'bindings.json'),
  )
  const client = new FakeOwui()
  const dataFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'fb-store-')), 'imports.json')

  const { store } = await runImport(
    importOptions([{ name: 'profil', dir: profile }], client, dataFile, {
      projectsRoot: [root],
      currentProfile: profile,
      bindings,
    }),
  )

  assert.equal(Object.values(store.items).every(item => !item.bound), true)
  assert.equal(bindings.count(), 0)
})

test('le scan valide le projectRoot, y compris au-delà de l’en-tête lu', () => {
  const profile = profileDir()
  const { root, project } = workspace()
  writeChat(profile, 'Alpha', REF1, {
    runState: { sessionState: { fileContext: { projectRoot: project } } },
  })
  writeChat(profile, 'Alpha', REF2, { runState: null, mtimeMs: MTIME2 })
  writeChat(profile, 'Alpha', '2026-10-03T10-00-00.000Z', {
    runState: {
      sessionState: {
        padding: 'x'.repeat(70_000),
        fileContext: { projectRoot: project },
      },
    },
  })

  const scan = scanConversations([{ name: 'profil', dir: profile }], [root])
  const byRef = new Map(scan.candidates.map(candidate => [candidate.ref, candidate]))

  assert.equal(byRef.get(REF1)?.projectPath, project.replace(/\\/g, '/'))
  assert.equal(byRef.get(REF2)?.projectPath, null)
  assert.equal(byRef.get('2026-10-03T10-00-00.000Z')?.projectPath, project.replace(/\\/g, '/'))
})

test('le filtre de profil ne scanne que le profil demandé', async () => {
  const alpha = profileDir()
  const beta = profileDir()
  writeChat(alpha, 'Alpha', REF1)
  writeChat(beta, 'Beta', REF2)
  const client = new FakeOwui()
  const dataFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'fb-store-')), 'imports.json')

  const { report } = await runImport(
    importOptions(
      [
        { name: 'alpha', dir: alpha },
        { name: 'beta', dir: beta },
      ],
      client,
      dataFile,
      { profile: 'beta' },
    ),
  )

  assert.equal(report.scanned, 1)
  assert.equal(report.created, 1)
  assert.match([...client.chats.values()][0]?.payload?.chat.title ?? '', /^\[Beta\] /)
})

test('un transcript inchangé n’est pas relu : seule sa stat est comparée', async () => {
  const profile = profileDir()
  const dir = writeChat(profile, 'Alpha', REF1)
  const file = path.join(dir, 'chat-messages.json')
  // Date entière : `utimesSync` arrondit au milliseconde, donc l'empreinte
  // enregistrée à l'import est exactement celle restaurée ensuite.
  const stamp = new Date(1_700_000_000_000)
  utimesSync(file, stamp, stamp)
  const before = statSync(file)
  const client = new FakeOwui()
  const dataFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'fb-store-')), 'imports.json')
  const importRun = importOptions([{ name: 'profil', dir: profile }], client, dataFile)

  const first = await runImport(importRun)
  assert.equal(first.report.created, 1)

  // Même taille, même mtime, contenu illisible : s'il était relu, le passage
  // échouerait au lieu de compter « inchangé ».
  writeFileSync(file, 'x'.repeat(before.size), 'utf8')
  utimesSync(file, stamp, stamp)
  assert.equal(statSync(file).size, before.size)
  assert.equal(statSync(file).mtimeMs, before.mtimeMs)

  const second = await runImport(importRun)
  assert.equal(second.report.unchanged, 1)
  assert.equal(second.report.errors.length, 0)
  assert.equal(second.report.created, 0)
  assert.equal(client.chats.size, 1)
})

test('les plafonds de rendu sont appliqués et signalés dans imports.json', async () => {
  const profile = profileDir()
  writeChat(profile, 'Alpha', REF1, {
    entries: [
      user('un'),
      ai('réponse un'),
      user('deux'),
      ai('réponse deux'),
      user('trois'),
      ai('réponse trois'),
    ],
  })
  const client = new FakeOwui()
  const dataFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'fb-store-')), 'imports.json')

  const { store } = await runImport(
    importOptions([{ name: 'profil', dir: profile }], client, dataFile, { maxMessages: 2 }),
  )

  assert.equal(store.items[Object.keys(store.items)[0] ?? '']?.truncated, true)
  assert.equal(Object.keys([...client.chats.values()][0]?.payload?.chat.history.messages ?? {}).length, 2)
})
