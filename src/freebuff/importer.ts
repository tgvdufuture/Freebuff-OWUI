/**
 * Scanner les conversations de tous les profils et les importer dans OWUI.
 *
 * Trois garanties, mesurées par les critères de la Phase 1 :
 * - lecture seule : `chats/` de la CLI n'est jamais écrit ;
 * - idempotence : `data/imports.json` retient l'empreinte (taille + mtime) de
 *   chaque conversation déjà importée, et le chat OWUI rendu ;
 * - pas d'écrasement : un chat touché dans OWUI depuis l'import (`updated_at`
 *   différent) n'est jamais réécrit — il est marqué `stale`.
 *
 * L'import n'ouvre aucune CLI et ne consomme aucun quota : il ne lit que des
 * fichiers et appelle l'API HTTP d'OWUI.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalizeProjectPath, samePath, type Bindings } from '../bindings.ts'
import { isConversationRef } from './history.ts'
import {
  ARCHIVE_MAX_CHARS,
  ARCHIVE_MAX_MESSAGES,
  renderArchive,
  type ArchiveChat,
  type ArchiveMeta,
  type TranscriptFileEntry,
} from './archive.ts'
import { OwuiError, type OwuiChatPayload, type OwuiClient, type OwuiMessage } from './owui.ts'
import { discoverProfiles } from './profiles.ts'

/** Modèle réel affiché par les chats importés (S16 : le moins cher). */
export const DEFAULT_ARCHIVE_MODEL = 'freebuff-m-61c26317cc'

/**
 * Ancienne disposition : `projects/chats/<ref>`, sans dossier de projet.
 * Mesurée sur `manicode` (une conversation du 14/08) : elle compte dans les 376.
 */
export const LEGACY_PROJECT = 'sans projet'

export interface ProfileRef {
  name: string
  dir: string
}

/**
 * Profils à scanner.
 *
 * `raw` vient de `BRIDGE_IMPORT_PROFILES` (séparé par `;` sous Windows) : un
 * nom (`freebuff`) est cherché sous `~/.config`, un chemin absolu est pris tel
 * quel. Sans `raw`, TOUS les profils présents sous `~/.config` sont scannés —
 * un dossier nommé autrement compte donc aussi. `extra` est le profil du pont
 * (`BRIDGE_PROFILE_DIR`), même s'il n'est pas un voisin : sans lui, ses
 * conversations seraient oubliées.
 */
export function profileList(
  raw: string | undefined,
  home: string = os.homedir(),
  extra?: string,
): ProfileRef[] {
  const dirs =
    raw === undefined || raw.trim() === ''
      ? discoverProfiles(path.join(home, '.config'))
      : raw
          .split(path.delimiter)
          .map(value => value.trim())
          .filter(Boolean)
          .map(name =>
            path.isAbsolute(name) ? path.resolve(name) : path.join(home, '.config', name),
          )
  if (extra !== undefined && extra.trim() !== '') dirs.push(path.resolve(extra))

  const seen = new Set<string>()
  const out: ProfileRef[] = []
  for (const dir of dirs) {
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name: path.basename(dir), dir })
  }
  return out
}

export interface Candidate {
  profile: string
  profileDir: string
  projectDir: string
  /** Chemin brut lu dans `run-state.json` : sert au NOM, même hors racines. */
  projectRoot: string | null
  /** Chemin validé sous `projectsRoot`, ou `null` (archive seule). */
  projectPath: string | null
  ref: string
  /** Dossier `chats/<ref>` complet. */
  dir: string
  mtimeMs: number
  size: number
  /** Aperçu pour `--dry-run` uniquement (tronqué par la CLI à 80 caractères). */
  firstPrompt: string
  messageCount: number
}

export interface ScanResult {
  candidates: Candidate[]
  /** Dossiers `chats/*` ignorés (transcript ou méta absents). */
  skipped: number
  errors: string[]
  profiles: string[]
}

function readDirs(parent: string): string[] | null {
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return null
  }
}

function readMeta(dir: string): { firstPrompt: string; messageCount: number; mtimeMs: number | null } | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'chat-meta.json'), 'utf8'))
    if (typeof raw !== 'object' || raw === null) return null
    const record = raw as Record<string, unknown>
    return {
      firstPrompt: typeof record.firstPrompt === 'string' ? record.firstPrompt : '',
      messageCount:
        typeof record.messageCount === 'number' && Number.isFinite(record.messageCount)
          ? Math.max(0, Math.floor(record.messageCount))
          : 0,
      mtimeMs:
        typeof record.messagesMtimeMs === 'number' && Number.isFinite(record.messagesMtimeMs)
          ? Math.round(record.messagesMtimeMs)
          : null,
    }
  } catch {
    return null
  }
}

/**
 * Taille lue en tête de `run-state.json` pour trouver `projectRoot`.
 *
 * Le fichier embarque l'arbre de fichiers complet : jusqu'à 116 Mo mesurés. Le
 * lire en entier pour un seul champ coûtait 5,3 s sur 376 conversations. Le
 * champ est en tête (`sessionState.fileContext.projectRoot`) ; au-delà, on
 * retombe sur une lecture complète.
 */
const RUN_STATE_PREFIX_BYTES = 64 * 1024

/** Chemin du projet tel que la CLI l'a réellement vu, ou `null`. */
function readProjectRoot(dir: string): string | null {
  const file = path.join(dir, 'run-state.json')
  const decode = (value: string): string | null => {
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed.replace(/\\/g, '/')
  }
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(RUN_STATE_PREFIX_BYTES)
      const read = fs.readSync(fd, buffer, 0, buffer.length, 0)
      const head = buffer.subarray(0, read).toString('utf8')
      const match = /"projectRoot"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(head)
      if (match?.[1] !== undefined) {
        try {
          const value: unknown = JSON.parse(match[1])
          if (typeof value === 'string') {
            const root = decode(value)
            if (root !== null) return root
          }
        } catch {
          // Chaîne coupée par la fenêtre de lecture : lecture complète dessous.
        }
      }
    } finally {
      fs.closeSync(fd)
    }

    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof raw !== 'object' || raw === null) return null
    const state = (raw as { sessionState?: unknown }).sessionState
    if (typeof state !== 'object' || state === null) return null
    const context = (state as { fileContext?: unknown }).fileContext
    if (typeof context !== 'object' || context === null) return null
    const root = (context as { projectRoot?: unknown }).projectRoot
    return typeof root === 'string' ? decode(root) : null
  } catch {
    return null
  }
}

/**
 * Énumère les conversations de tous les profils.
 *
 * Une conversation sans `chat-meta.json` ou sans `chat-messages.json` est
 * ignorée ET comptée : un dossier vide de relance ne doit pas devenir un chat
 * vide dans OWUI. Le scan ne lit que les petites métas ; le transcript est lu
 * plus tard, seulement pour ce qui a changé.
 */
export function scanConversations(profiles: ProfileRef[], projectsRoot: string[] = []): ScanResult {
  const candidates: Candidate[] = []
  let skipped = 0
  const errors: string[] = []

  for (const profile of profiles) {
    const projectsDir = path.join(profile.dir, 'projects')
    const projects = readDirs(projectsDir)
    if (projects === null) {
      // Un profil qui n'a jamais servi n'a pas de `projects/` : ce n'est pas une
      // erreur, c'est un compte vide. Un profil qui n'est pas un dossier, ou un
      // `projects/` présent mais illisible, doit être nommé.
      let isDir = false
      try {
        isDir = fs.statSync(profile.dir).isDirectory()
      } catch {
        // Profil absent : compte jamais créé, rien à signaler.
      }
      if (!isDir) errors.push(`profil illisible : ${profile.dir}`)
      else if (fs.existsSync(projectsDir)) errors.push(`projets illisibles : ${projectsDir}`)
      continue
    }

    const roots = projects.map(projectDir => ({
      projectDir,
      chatsDir: path.join(projectsDir, projectDir, 'chats'),
    }))
    roots.push({ projectDir: LEGACY_PROJECT, chatsDir: path.join(projectsDir, 'chats') })

    for (const root of roots) {
      const refs = readDirs(root.chatsDir)
      if (refs === null) continue

      for (const ref of refs) {
        const dir = path.join(root.chatsDir, ref)
        if (!isConversationRef(ref)) {
          skipped += 1
          continue
        }
        let size: number
        let mtimeMs: number
        try {
          const stat = fs.statSync(path.join(dir, 'chat-messages.json'))
          size = stat.size
          mtimeMs = stat.mtimeMs
        } catch {
          skipped += 1
          continue
        }
        const meta = readMeta(dir)
        if (meta === null) {
          skipped += 1
          continue
        }

        const projectRoot = readProjectRoot(dir)
        const verdict =
          projectRoot === null || projectsRoot.length === 0
            ? null
            : normalizeProjectPath(projectRoot, projectsRoot)
        candidates.push({
          profile: profile.name,
          profileDir: profile.dir,
          projectDir: root.projectDir,
          projectRoot,
          projectPath: verdict !== null && verdict.ok ? verdict.path : null,
          ref,
          dir,
          mtimeMs,
          size,
          firstPrompt: meta.firstPrompt,
          messageCount: meta.messageCount,
        })
      }
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return { candidates, skipped, errors, profiles: profiles.map(profile => profile.name) }
}

export const IMPORTS_VERSION = 1

export interface ImportedChat {
  owuiChatId: string
  /** Empreinte du transcript au moment de l'import. */
  mtimeMs: number
  size: number
  importedAt: number
  /** `updated_at` rendu par OWUI à l'import ; un écart = chat touché. */
  owuiUpdatedAt: number
  profileDir: string
  projectDir: string
  ref: string
  /** Phase 2 : `true` quand `bindings.json` porte le chat. */
  bound: boolean
  truncated: boolean
  stale: boolean
  /** Dossier OWUI par PROJET (nom affiché), depuis le 25/10. */
  folder?: string
  /** Id du dossier : un dossier supprimé dans OWUI est recréé et les chats suivent. */
  folderId?: string
}

export interface ImportRun {
  at: number
  dryRun: boolean
  profiles: string[]
  scanned: number
  created: number
  updated: number
  unchanged: number
  skipped: number
  stale: number
  errors: string[]
}

/**
 * Création en vol, écrite AVANT l'appel à OWUI.
 *
 * Si le pont meurt entre la réponse d'OWUI et l'écriture de `items`, ce
 * marqueur permet de retrouver le chat déjà créé (titre + `created_at`) au
 * prochain passage, au lieu d'en créer un second.
 */
export interface PendingCreation {
  key: string
  title: string
  /** `created_at` envoyé à OWUI (epoch secondes). */
  createdAt: number
  mtimeMs: number
  size: number
  profileDir: string
  projectDir: string
  ref: string
  folder: string
  folderId: string
  truncated: boolean
}

export interface ImportStore {
  version: number
  /** Ancien classement par profil (`Freebuff · <profil>`), conservé pour mémoire. */
  folders: Record<string, string>
  /** Nouveau classement : nom de projet → id du dossier OWUI. */
  projectFolders: Record<string, string>
  items: Record<string, ImportedChat>
  pending: PendingCreation | null
  lastRun: ImportRun | null
}

export interface ImportHealth {
  enabled: boolean
  intervalMs: number
  profiles: string[]
  scanned: number
  created: number
  updated: number
  unchanged: number
  skipped: number
  stale: number
  lastRunAt: number | null
  lastError: string | null
}

export function emptyStore(): ImportStore {
  return {
    version: IMPORTS_VERSION,
    folders: {},
    projectFolders: {},
    items: {},
    pending: null,
    lastRun: null,
  }
}

/**
 * Lit `data/imports.json`.
 *
 * Un fichier illisible n'est JAMAIS écrasé : il porte l'empreinte de ce qui est
 * déjà dans OWUI, et repartir de zéro créerait 376 doublons. L'appelant doit
 * s'arrêter et le dire.
 */
export function readStore(file: string): ImportStore {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return emptyStore()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `imports.json illisible (${error instanceof Error ? error.message : String(error)}) : réécriture refusée.`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('imports.json illisible (objet attendu) : réécriture refusée.')
  }
  const record = parsed as Record<string, unknown>
  if (record.version !== IMPORTS_VERSION) {
    throw new Error(
      `imports.json version ${String(record.version)} inconnue : réécriture refusée.`,
    )
  }
  const folders = record.folders
  const items = record.items
  if (
    typeof folders !== 'object' ||
    folders === null ||
    Array.isArray(folders) ||
    typeof items !== 'object' ||
    items === null ||
    Array.isArray(items)
  ) {
    throw new Error('imports.json illisible (folders/items attendus) : réécriture refusée.')
  }

  const parsedItems: Record<string, ImportedChat> = {}
  for (const [key, value] of Object.entries(items as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const item = value as Record<string, unknown>
    if (
      typeof item.owuiChatId !== 'string' ||
      typeof item.mtimeMs !== 'number' ||
      typeof item.size !== 'number' ||
      typeof item.ref !== 'string'
    ) {
      continue
    }
    parsedItems[key] = {
      owuiChatId: item.owuiChatId,
      mtimeMs: item.mtimeMs,
      size: item.size,
      importedAt: typeof item.importedAt === 'number' ? item.importedAt : 0,
      owuiUpdatedAt: typeof item.owuiUpdatedAt === 'number' ? item.owuiUpdatedAt : 0,
      profileDir: typeof item.profileDir === 'string' ? item.profileDir : '',
      projectDir: typeof item.projectDir === 'string' ? item.projectDir : '',
      ref: item.ref,
      bound: item.bound === true,
      truncated: item.truncated === true,
      stale: item.stale === true,
      ...(typeof item.folder === 'string' && item.folder !== '' ? { folder: item.folder } : {}),
      ...(typeof item.folderId === 'string' && item.folderId !== '' ? { folderId: item.folderId } : {}),
    }
  }

  const pendingRaw = record.pending
  const pending =
    typeof pendingRaw === 'object' &&
    pendingRaw !== null &&
    !Array.isArray(pendingRaw) &&
    typeof (pendingRaw as Record<string, unknown>).key === 'string' &&
    typeof (pendingRaw as Record<string, unknown>).title === 'string' &&
    typeof (pendingRaw as Record<string, unknown>).createdAt === 'number' &&
    typeof (pendingRaw as Record<string, unknown>).mtimeMs === 'number' &&
    typeof (pendingRaw as Record<string, unknown>).size === 'number' &&
    typeof (pendingRaw as Record<string, unknown>).profileDir === 'string' &&
    typeof (pendingRaw as Record<string, unknown>).projectDir === 'string' &&
    typeof (pendingRaw as Record<string, unknown>).ref === 'string' &&
    typeof (pendingRaw as Record<string, unknown>).folder === 'string' &&
    typeof (pendingRaw as Record<string, unknown>).folderId === 'string'
      ? (pendingRaw as unknown as PendingCreation)
      : null

  const projectFolders = record.projectFolders
  return {
    version: IMPORTS_VERSION,
    folders: Object.fromEntries(
      Object.entries(folders as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
    projectFolders:
      typeof projectFolders === 'object' && projectFolders !== null && !Array.isArray(projectFolders)
        ? Object.fromEntries(
            Object.entries(projectFolders as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          )
        : {},
    items: parsedItems,
    pending,
    lastRun:
      typeof record.lastRun === 'object' && record.lastRun !== null
        ? (record.lastRun as ImportRun)
        : null,
  }
}

/** Écriture atomique : un arrêt au milieu ne laisse pas un JSON tronqué. */
export function writeStore(file: string, store: ImportStore): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, file)
}

/** Un import est déjà en cours (pont ou commande manuelle). */
export class ImportBusyError extends Error {
  constructor(file: string) {
    super(`un import est déjà en cours (verrou ${file}) — réessaie au prochain cycle.`)
    this.name = 'ImportBusyError'
  }
}

/**
 * Un verrou plus vieux que ce délai est périmé, même si son PID existe encore
 * (PID recyclé). Un import réel dure 79 s sur 374 conversations ; 15 min
 * couvrent largement un passage lent sans bloquer un pont relancé après crash.
 */
const IMPORT_LOCK_STALE_MS = 15 * 60_000

interface ImportLock {
  pid: number
  at: number
  token: string
}

/** Le processus qui a posé le verrou tourne-t-il encore ? */
function lockHolderAlive(lock: Partial<ImportLock>, now: number): boolean {
  if (typeof lock.at !== 'number' || now - lock.at > IMPORT_LOCK_STALE_MS) return false
  if (typeof lock.pid !== 'number' || !Number.isInteger(lock.pid) || lock.pid <= 0) return false
  try {
    process.kill(lock.pid, 0)
    return true
  } catch (error) {
    // EPERM : le processus existe mais ne nous appartient pas.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Verrou inter-processus : le pont et `npm run import:owui` ne doivent jamais
 * écrire `imports.json` en même temps (deux créations du même chat).
 *
 * Un verrou laissé par un processus mort est repris immédiatement ; un fichier
 * illisible (écriture interrompue) n'est repris qu'après 1 min.
 */
export function acquireImportLock(file: string, now: () => number = Date.now): () => void {
  const token = crypto.randomUUID()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let created = false
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: now(), token }), {
        encoding: 'utf8',
        flag: 'wx',
      })
      created = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if (created) {
      return () => {
        try {
          const current = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ImportLock>
          if (current.token === token) fs.rmSync(file, { force: true })
        } catch {
          // Déjà supprimé ou remplacé : rien à libérer.
        }
      }
    }

    let stale: boolean
    try {
      stale = !lockHolderAlive(
        JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ImportLock>,
        now(),
      )
    } catch {
      try {
        stale = now() - fs.statSync(file).mtimeMs > 60_000
      } catch {
        stale = true // supprimé entre-temps : on retente
      }
    }
    if (!stale) throw new ImportBusyError(file)
    fs.rmSync(file, { force: true })
  }
  throw new ImportBusyError(file)
}

/**
 * Planificateur de synchronisation (US-05).
 *
 * Un seul cycle à la fois : un `setInterval` peut se déclencher pendant un
 * passage lent, il est alors ignoré. `intervalMs = 0` désactive tout, et
 * `stop()` (fermeture du pont) annule le minuteur.
 */
export type ImportSchedule = (run: () => void, intervalMs: number) => () => void

const defaultSchedule: ImportSchedule = (run, intervalMs) => {
  const timer = setInterval(run, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}

export interface ImportSchedulerOptions {
  intervalMs: number
  run: () => Promise<unknown>
  schedule?: ImportSchedule
  onError?: (error: unknown) => void
  now?: () => number
}

export class ImportScheduler {
  readonly intervalMs: number
  private readonly options: ImportSchedulerOptions
  private cancel: (() => void) | null = null
  private inFlight = false
  private lastRun: number | null = null
  private error: string | null = null

  constructor(options: ImportSchedulerOptions) {
    this.options = options
    this.intervalMs = Math.max(0, Math.floor(options.intervalMs))
  }

  get enabled(): boolean {
    return this.intervalMs > 0
  }

  get running(): boolean {
    return this.inFlight
  }

  get lastRunAt(): number | null {
    return this.lastRun
  }

  get lastError(): string | null {
    return this.error
  }

  /** Démarre le minuteur ; rend `false` si déjà lancé ou désactivé. */
  start(): boolean {
    if (!this.enabled || this.cancel !== null) return false
    this.cancel = (this.options.schedule ?? defaultSchedule)(() => {
      void this.runNow()
    }, this.intervalMs)
    return true
  }

  stop(): void {
    this.cancel?.()
    this.cancel = null
  }

  /** Un cycle immédiat (démarrage, commande, test), sans chevauchement. */
  async runNow(): Promise<void> {
    if (!this.enabled || this.inFlight) return
    this.inFlight = true
    try {
      await this.options.run()
      this.lastRun = (this.options.now ?? Date.now)()
      this.error = null
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      this.options.onError?.(error)
    } finally {
      this.inFlight = false
    }
  }
}

/** Une panne d'OWUI arrête le cycle ; une erreur locale ne l'arrête pas. */
function stopsCycle(error: unknown): boolean {
  if (error instanceof OwuiError) return error.status === 401 || error.status === 403
  return true
}

/** `/health` : le dernier passage, ou `null`. Ne lève jamais. */
export function importHealth(file: string): ImportHealth {
  const base: ImportHealth = {
    enabled: false,
    intervalMs: 0,
    profiles: [],
    scanned: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    stale: 0,
    lastRunAt: null,
    lastError: null,
  }
  try {
    const store = readStore(file)
    const run = store.lastRun
    if (run === null) return base
    return {
      ...base,
      profiles: run.profiles,
      scanned: run.scanned,
      created: run.created,
      updated: run.updated,
      unchanged: run.unchanged,
      skipped: run.skipped,
      stale: run.stale,
      lastRunAt: run.at,
      lastError: run.errors.at(-1) ?? null,
    }
  } catch {
    return base
  }
}

function isTranscript(raw: unknown): raw is TranscriptFileEntry[] {
  return Array.isArray(raw)
}

function projectName(candidate: Candidate): string {
  const root = candidate.projectRoot === null ? '' : path.basename(candidate.projectRoot)
  return root === '' ? candidate.projectDir : root
}

/** Construit le corps OWUI, ids et filiation compris. */
export function chatPayload(input: {
  chat: ArchiveChat
  folderId: string | null
  model: string
  tags: string[]
}): OwuiChatPayload {
  const messages: OwuiMessage[] = []
  let parentId: string | null = null
  for (const message of input.chat.messages) {
    const id = crypto.randomUUID()
    const entry: OwuiMessage = {
      id,
      parentId,
      childrenIds: [],
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      done: true,
    }
    if (message.model !== undefined) entry.model = message.model
    messages.push(entry)
    const previous = messages.at(-2)
    if (previous !== undefined) previous.childrenIds.push(id)
    parentId = id
  }
  const currentId = messages.at(-1)?.id ?? null

  return {
    chat: {
      title: input.chat.title,
      models: [input.model],
      history: {
        messages: Object.fromEntries(messages.map(message => [message.id, message])),
        currentId,
      },
      params: {},
      files: [],
    },
    meta: { tags: [...new Set(input.tags.filter(tag => tag !== ''))] },
    pinned: false,
    archived: false,
    folder_id: input.folderId,
    current_message_id: currentId,
    created_at: input.chat.createdAt,
    updated_at: input.chat.updatedAt,
  }
}

/**
 * Activité la plus récente (epoch secondes) de chaque dossier OWUI.
 *
 * Le patch de tri lit `meta.lastActivity` : il ne peut pas se servir de
 * `folder.updated_at`, qu'OWUI remet à `now` à chaque écriture (et qui ne bouge
 * pas quand un chat du dossier reçoit un message).
 */
export function folderActivity(items: Record<string, ImportedChat>): Map<string, number> {
  const out = new Map<string, number>()
  for (const item of Object.values(items)) {
    const folderId = item.folderId
    if (folderId === undefined || folderId === '') continue
    const at = Number.isFinite(item.owuiUpdatedAt)
      ? item.owuiUpdatedAt
      : Math.round(item.mtimeMs / 1000)
    out.set(folderId, Math.max(out.get(folderId) ?? 0, at))
  }
  return out
}

export interface ImportOptions {
  dataFile: string
  profiles: ProfileRef[]
  client: OwuiClient
  /** Id réellement exposé par `/v1/models` (défaut : le moins cher). */
  model: string
  dryRun?: boolean
  limit?: number
  /** Filtre par nom de profil ou chemin. */
  profile?: string
  maxChars?: number
  maxMessages?: number
  /** Racines autorisées pour valider `run-state.json` → `projectPath`. */
  projectsRoot?: string[]
  /** Profil actif du pont : lui seul est lié. */
  currentProfile?: string
  /** Bindings à alimenter ; absent en simulation ou si le fichier est illisible. */
  bindings?: Bindings
  now?: () => number
  log?: (line: string) => void
}

export interface ImportOutcome {
  report: ImportRun
  store: ImportStore
  /** Aperçu des conversations que le passage traiterait (20 au plus). */
  preview: string[]
}

function matchesProfile(profile: ProfileRef, wanted: string | undefined): boolean {
  if (wanted === undefined || wanted.trim() === '') return true
  const value = wanted.trim()
  const same = process.platform === 'win32' ? (a: string) => a.toLowerCase() === value.toLowerCase() : (a: string) => a === value
  return same(profile.name) || same(profile.dir)
}

/**
 * Un passage d'import.
 *
 * L'état est écrit APRÈS CHAQUE chat créé ou mis à jour : un arrêt au milieu
 * laisse `imports.json` exact, donc un second passage reprend sans doublon.
 */
export async function runImport(options: ImportOptions): Promise<ImportOutcome> {
  // Une simulation n'écrit rien : ni état, ni verrou.
  if (options.dryRun === true) return runImportUnlocked(options)
  const release = acquireImportLock(`${options.dataFile}.lock`)
  try {
    return await runImportUnlocked(options)
  } finally {
    release()
  }
}

async function runImportUnlocked(options: ImportOptions): Promise<ImportOutcome> {
  const store = readStore(options.dataFile)
  const now = options.now ?? Date.now
  const dryRun = options.dryRun === true
  const log = options.log ?? (() => undefined)
  const profiles = options.profiles.filter(profile => matchesProfile(profile, options.profile))
  if (profiles.length === 0) {
    throw new Error(`aucun profil ne correspond à « ${options.profile ?? ''} »`)
  }

  const scan = scanConversations(profiles, options.projectsRoot ?? [])
  const candidates =
    options.limit !== undefined && options.limit >= 0
      ? scan.candidates.slice(0, options.limit)
      : scan.candidates

  const report: ImportRun = {
    at: now(),
    dryRun,
    profiles: scan.profiles,
    scanned: candidates.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: scan.skipped,
    stale: 0,
    errors: [...scan.errors],
  }
  const preview: string[] = []
  const save = (): void => {
    if (dryRun) return
    store.lastRun = report
    writeStore(options.dataFile, store)
  }

  /**
   * Retrouve un chat créé juste avant un arrêt brutal.
   *
   * Le marqueur `pending` est écrit avant l'appel à OWUI. Au passage suivant,
   * un chat du même titre et du même `created_at` est adopté, pas recréé. Une
   * liste OWUI indisponible laisse le marqueur en place pour le cycle d'après.
   */
  const recoverPending = async (): Promise<void> => {
    const pending = store.pending
    if (pending === null) return
    if (store.items[pending.key] === undefined) {
      let list
      try {
        list = await options.client.listChats()
      } catch (error) {
        report.errors.push(
          `reprise ${pending.key} : ${error instanceof Error ? error.message : String(error)}`,
        )
        save()
        throw error
      }
      const match = list.find(
        chat => chat.title === pending.title && chat.createdAt === pending.createdAt,
      )
      if (match !== undefined) {
        store.items[pending.key] = {
          owuiChatId: match.id,
          mtimeMs: pending.mtimeMs,
          size: pending.size,
          importedAt: now(),
          owuiUpdatedAt: match.updatedAt,
          profileDir: pending.profileDir,
          projectDir: pending.projectDir,
          ref: pending.ref,
          bound: false,
          truncated: pending.truncated === true,
          stale: false,
          folder: pending.folder,
          folderId: pending.folderId,
        }
        log(`reprise : ${pending.key} déjà créé dans OWUI (${match.id}) — aucun doublon`)
      }
    }
    store.pending = null
    save()
  }
  if (!dryRun) await recoverPending()

  const folderIds = new Map<string, string>()
  const bindingFileError = options.bindings?.readError ?? null
  const bindings = bindingFileError === null ? options.bindings : undefined
  if (bindingFileError !== null) report.errors.push(bindingFileError)
  const currentProfile = options.currentProfile ?? null

  /** Lie le chat importé au projet de sa conversation, si le profil est le bon. */
  const bindChat = (
    chatId: string,
    candidate: Candidate,
    previous: ImportedChat | undefined,
  ): boolean => {
    if (dryRun || bindings === undefined || currentProfile === null) return false
    if (candidate.projectPath === null) return false
    if (!samePath(candidate.profileDir, currentProfile)) return false
    try {
      const created = bindings.bindImported(chatId, {
        projectPath: candidate.projectPath,
        ref: candidate.ref,
        profileDir: candidate.profileDir,
        importedAt: previous?.importedAt ?? now(),
        lastTurnAt: Math.round(candidate.mtimeMs),
      })
      if (created) {
        log(`binding : ${candidate.profile}/${candidate.projectDir}/${candidate.ref} → ${candidate.projectPath}`)
      }
      return created
    } catch (error) {
      report.errors.push(
        `binding ${candidate.profile}/${candidate.projectDir}/${candidate.ref} : ${error instanceof Error ? error.message : String(error)}`,
      )
      return false
    }
  }

  const adopt = (item: ImportedChat, candidate: Candidate, previous: ImportedChat | undefined): void => {
    if (item.bound) return
    if (bindings?.get(item.owuiChatId) !== null) {
      item.bound = true
      return
    }
    if (bindChat(item.owuiChatId, candidate, previous)) item.bound = true
  }

  /** Dossier du PROJET (et non du profil), créé ou recréé une fois par passage. */
  const folderFor = async (name: string): Promise<string> => {
    const cached = folderIds.get(name)
    if (cached !== undefined) return cached
    const id = await options.client.ensureFolder(name)
    folderIds.set(name, id)
    if (store.projectFolders[name] !== id) {
      store.projectFolders[name] = id
      save()
    }
    return id
  }

  /** Range un chat déjà importé dans le dossier de son projet (migration incluse). */
  const adoptFolder = async (item: ImportedChat, name: string, ref: string): Promise<void> => {
    if (dryRun) return
    try {
      const folderId = await folderFor(name)
      if (item.folderId === folderId) {
        if (item.folder !== name) {
          item.folder = name
          save()
        }
        return
      }
      const moved = await options.client.moveChat(item.owuiChatId, folderId)
      item.folder = name
      item.folderId = folderId
      item.owuiUpdatedAt = moved.updatedAt
      save()
    } catch (error) {
      report.errors.push(
        `dossier ${name} (${ref}) : ${error instanceof Error ? error.message : String(error)}`,
      )
      if (stopsCycle(error)) {
        save()
        throw error
      }
    }
  }

  for (const candidate of candidates) {
    const key = `${candidate.profile}/${candidate.projectDir}/${candidate.ref}`
    const previous = store.items[key]
    const name = projectName(candidate)
    if (previous !== undefined) {
      if (!previous.bound) {
        adopt(previous, candidate, previous)
        if (previous.bound) save()
      }
      await adoptFolder(previous, name, candidate.ref)
    }
    const same = previous !== undefined && previous.mtimeMs === candidate.mtimeMs && previous.size === candidate.size
    if (same) {
      report.unchanged += 1
      continue
    }

    if (preview.length < 20) {
      preview.push(
        `${previous === undefined ? 'créer' : 'mettre à jour'} ${candidate.profile}/${candidate.projectDir}/${candidate.ref} — ${candidate.firstPrompt}`,
      )
    }

    if (dryRun) {
      if (previous === undefined) report.created += 1
      else report.updated += 1
      continue
    }

    let rendered: ArchiveChat
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(candidate.dir, 'chat-messages.json'), 'utf8'))
      if (!isTranscript(raw)) throw new Error('transcript inattendu (tableau attendu)')
      const meta = readMeta(candidate.dir) ?? { firstPrompt: '', messageCount: 0, mtimeMs: null }
      const archiveMeta: ArchiveMeta = { messagesMtimeMs: meta.mtimeMs }
      rendered = renderArchive({
        ref: candidate.ref,
        projectName: name,
        entries: raw,
        meta: archiveMeta,
        model: options.model,
        maxChars: options.maxChars ?? ARCHIVE_MAX_CHARS,
        maxMessages: options.maxMessages ?? ARCHIVE_MAX_MESSAGES,
      })
    } catch (error) {
      report.errors.push(
        `${key} : ${error instanceof Error ? error.message : String(error)}`,
      )
      continue
    }

    if (rendered.messages.length === 0) {
      report.skipped += 1
      continue
    }

    let folderId: string
    try {
      folderId = await folderFor(name)
    } catch (error) {
      report.errors.push(`dossier ${name} : ${error instanceof Error ? error.message : String(error)}`)
      save()
      if (stopsCycle(error)) throw error
      continue
    }

    const payload = chatPayload({
      chat: rendered,
      folderId,
      model: options.model,
      tags: ['freebuff', candidate.profile, name],
    })

    try {
      if (previous !== undefined) {
        const current = await options.client.getChat(previous.owuiChatId)
        if (current.updatedAt !== previous.owuiUpdatedAt) {
          previous.stale = true
          report.stale += 1
          save()
          continue
        }
        const updated = await options.client.updateChat(previous.owuiChatId, payload.chat)
        store.items[key] = {
          owuiChatId: updated.id,
          mtimeMs: candidate.mtimeMs,
          size: candidate.size,
          importedAt: now(),
          owuiUpdatedAt: updated.updatedAt,
          profileDir: candidate.profileDir,
          projectDir: candidate.projectDir,
          ref: candidate.ref,
          bound: previous.bound,
          truncated: rendered.truncated,
          stale: false,
          folder: name,
          folderId,
        }
        report.updated += 1
      } else {
        // Marqueur AVANT l'appel : si le processus meurt maintenant, la
        // création est retrouvée au prochain passage au lieu d'être rejouée.
        store.pending = {
          key,
          title: payload.chat.title,
          createdAt: payload.created_at,
          mtimeMs: candidate.mtimeMs,
          size: candidate.size,
          profileDir: candidate.profileDir,
          projectDir: candidate.projectDir,
          ref: candidate.ref,
          folder: name,
          folderId,
          truncated: rendered.truncated,
        }
        save()
        const created = await options.client.importChat(payload)
        store.pending = null
        store.items[key] = {
          owuiChatId: created.id,
          mtimeMs: candidate.mtimeMs,
          size: candidate.size,
          importedAt: now(),
          owuiUpdatedAt: created.updatedAt,
          profileDir: candidate.profileDir,
          projectDir: candidate.projectDir,
          ref: candidate.ref,
          bound: false,
          truncated: rendered.truncated,
          stale: false,
          folder: name,
          folderId,
        }
        report.created += 1
      }
      const stored = store.items[key]
      if (stored !== undefined) adopt(stored, candidate, previous)
      save()
    } catch (error) {
      report.errors.push(
        `${key} : ${error instanceof Error ? error.message : String(error)}`,
      )
      save()
      if (stopsCycle(error)) throw error
      continue
    }

    if ((report.created + report.updated) % 25 === 0) {
      log(`import : ${String(report.created + report.updated)} conversation(s) traitée(s)…`)
    }
  }

  /**
   * Reporte l'activité réelle dans `meta.lastActivity` de chaque dossier.
   *
   * Le frontend patché trie les dossiers du plus récent au plus ancien. Une
   * erreur ici est cosmétique : elle est comptée, mais n'empêche pas l'import.
   */
  const refreshFolderActivity = async (): Promise<void> => {
    if (dryRun) return
    const activity = folderActivity(store.items)
    if (activity.size === 0) return

    let folders: Awaited<ReturnType<OwuiClient['listFolders']>>
    try {
      folders = await options.client.listFolders()
    } catch (error) {
      report.errors.push(
        `dossiers : ${error instanceof Error ? error.message : String(error)}`,
      )
      save()
      if (stopsCycle(error)) throw error
      return
    }
    const metaById = new Map(folders.map(folder => [folder.id, folder.meta]))

    for (const [folderId, at] of activity) {
      const meta = metaById.get(folderId)
      // Dossier supprimé dans OWUI : rien à dater, le prochain import en recrée un.
      if (meta === undefined) continue
      const previous = typeof meta?.lastActivity === 'number' ? meta.lastActivity : 0
      if (previous >= at) continue
      try {
        await options.client.updateFolderMeta(folderId, { lastActivity: at })
      } catch (error) {
        report.errors.push(
          `dossier ${folderId} : ${error instanceof Error ? error.message : String(error)}`,
        )
        save()
        if (stopsCycle(error)) throw error
      }
    }
  }
  await refreshFolderActivity()

  store.lastRun = report
  save()
  return { report, store, preview }
}
