/**
 * Binding chat OpenWebUI ↔ projet sur disque.
 *
 * Un chat OpenWebUI n'a pas de « dossier de travail » : l'API OpenAI ne
 * transporte que des messages. Le modèle `freebuff-new` sert donc à ça — son
 * premier message est un CHEMIN, pas une consigne. Le pont le valide, le
 * persiste, et à partir de là chaque message de ce chat travaille dans ce
 * dossier.
 *
 * Deux règles de sûreté :
 * - un chemin n'est accepté que s'il est absolu, sans `..`, existant, et sous
 *   l'une des racines autorisées (`projectsRoot`) ;
 * - un `bindings.json` illisible n'est JAMAIS réécrit : le pont démarre, mais
 *   refuse les chats non liés. Écraser un fichier corrompu effacerait tous les
 *   bindings d'un coup.
 */
import fs from 'node:fs'
import path from 'node:path'

export interface BindingRecord {
  projectPath: string
  createdAt: number
  /** SHA-256 des messages user/assistant du dernier tour accepté. */
  signatures: string[]
  /** ms epoch du dernier tour accepté ; 0 quand aucun tour n'a encore eu lieu. */
  lastTurnAt: number
  /**
   * Conversation CLI choisie par `/import`, à reprendre au prochain tour
   * (`--continue <ref>`). Effacée dès qu'un tour aboutit : elle n'est plus à
   * reprendre, la session l'a chargée.
   */
  resumeRef: string | null
  /**
   * Conversations CLI déjà utilisées par ce chat, la plus récente d'abord.
   * Après une relance la plus récente peut être vide : celle d'avant porte
   * alors la réponse à récupérer (`/recover`).
   */
  chatRefs: string[]
  /** Profil Freebuff d'origine, quand le chat vient d'un import d'archive. */
  profileDir?: string
  /** ms epoch de l'import OWUI d'origine. */
  importedAt?: number
}

export type PathVerdict =
  | { ok: true; path: string }
  | { ok: false; reason: string }

const isAbs = (value: string): boolean => path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value)

/** Comparaison de chemins : Windows ne distingue pas la casse. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '')
  return process.platform === 'win32'
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b)
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), candidate)
  if (rel === '') return true
  if (path.isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${path.sep}`)
}

/**
 * Valide et normalise un chemin de projet.
 *
 * `isDirectory` est injectable pour tester sans créer de dossiers ; le défaut
 * interroge le disque. Le chemin rendu utilise des `/` : c'est la forme écrite
 * dans `bindings.json`, lisible et stable entre Windows et un terminal bash.
 */
export function normalizeProjectPath(
  input: unknown,
  roots: string[],
  isDirectory: (dir: string) => boolean = defaultIsDirectory,
): PathVerdict {
  if (typeof input !== 'string' || !input.trim()) {
    return { ok: false, reason: 'chemin vide — envoie un chemin absolu vers un dossier existant.' }
  }

  const raw = input.trim().replace(/^["'`]|["'`]$/g, '')
  if (!isAbs(raw)) {
    return {
      ok: false,
      reason: `« ${raw} » n'est pas un chemin absolu. Exemple : D:/code/mon-projet`,
    }
  }

  if (raw.split(/[\\/]/).includes('..')) {
    return { ok: false, reason: 'le chemin contient « .. » : refuse.' }
  }

  const resolved = path.resolve(raw)
  if (!roots.some(root => isInside(root, resolved))) {
    return {
      ok: false,
      reason: `« ${resolved} » est hors des racines autorisées : ${roots.join(', ')}`,
    }
  }

  if (!isDirectory(resolved)) {
    return { ok: false, reason: `le dossier n'existe pas : ${resolved}` }
  }

  return { ok: true, path: resolved.replace(/\\/g, '/') }
}

function defaultIsDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/**
 * Le fichier des bindings. Tient en mémoire ; écrit à chaque nouveau chat.
 *
 * Pas de base de données : quelques dizaines d'entrées, un fichier lisible à
 * la main quand il faut diagnostiquer.
 */
/** Clé réservée du fichier : jamais un id de chat (les ids sont des UUID). */
const PENDING_KEY = '__pending__'

/** Un dossier retenu avant que le chat n'existe cesse d'être utile passé ce délai. */
export const PENDING_TTL_MS = 30 * 60 * 1000

export class Bindings {
  private readonly file: string
  private data: Record<string, BindingRecord> = {}
  /**
   * Dossier choisi dans une conversation encore vide : OpenWebUI ne crée l'id
   * du chat qu'au premier message, donc il n'y a rien à lier tout de suite.
   * Le premier message de n'importe quel chat non lié consomme ce dossier.
   */
  private pending: { projectPath: string; at: number } | null = null

  /** Message d'erreur non nul quand le fichier existe mais est illisible. */
  readError: string | null = null
  /** Empreinte du fichier lu : permet de reprendre un import manuel à chaud. */
  private loadedStamp: string | null = null

  constructor(file: string) {
    this.file = file
    this.load()
  }

  /**
   * Relit `bindings.json` s'il a changé sur le disque.
   *
   * Un import lancé par `npm run import:owui` écrit le fichier hors du pont :
   * sans cette relecture, ses chats resteraient `chat_unbound` jusqu'au
   * redémarrage. Chaque mutation est déjà écrite immédiatement, donc le disque
   * est la source de vérité — aucun changement en attente à perdre.
   */
  refresh(): void {
    let stamp: string
    try {
      const stat = fs.statSync(this.file)
      stamp = `${String(stat.mtimeMs)}:${String(stat.size)}`
    } catch {
      return
    }
    if (stamp === this.loadedStamp) return
    this.load()
  }

  private load(): void {
    let raw: string
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch {
      return // premier démarrage : fichier absent, ce n'est pas une erreur
    }
    let stamp: string | null = null
    try {
      const stat = fs.statSync(this.file)
      stamp = `${String(stat.mtimeMs)}:${String(stat.size)}`
    } catch {
      // Le fichier a disparu entre la lecture et le stat : la prochaine
      // relecture le verra absent, sans effacer ce qui est en mémoire.
    }

    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('objet attendu')
      }
      let pending: { projectPath: string; at: number } | null = null
      const pendingRaw = (parsed as Record<string, unknown>)[PENDING_KEY]
      if (typeof pendingRaw === 'object' && pendingRaw !== null) {
        const entry = pendingRaw as Record<string, unknown>
        if (typeof entry.projectPath === 'string' && typeof entry.at === 'number') {
          pending = { projectPath: entry.projectPath, at: entry.at }
        }
      }

      const data: Record<string, BindingRecord> = {}
      for (const [chatId, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (chatId === PENDING_KEY) continue
        if (typeof value !== 'object' || value === null) continue
        const entry = value as Record<string, unknown>
        if (typeof entry.projectPath !== 'string') continue
        data[chatId] = {
          projectPath: entry.projectPath,
          createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
          signatures: Array.isArray(entry.signatures)
            ? entry.signatures.filter((hash): hash is string => typeof hash === 'string')
            : [],
          lastTurnAt: typeof entry.lastTurnAt === 'number' ? entry.lastTurnAt : 0,
          resumeRef:
            typeof entry.resumeRef === 'string' && entry.resumeRef !== '' ? entry.resumeRef : null,
          chatRefs: Array.isArray(entry.chatRefs)
            ? entry.chatRefs.filter(
                (ref): ref is string => typeof ref === 'string' && ref !== '',
              )
            : [],
          ...(typeof entry.profileDir === 'string' && entry.profileDir !== ''
            ? { profileDir: entry.profileDir }
            : {}),
          ...(typeof entry.importedAt === 'number' && Number.isFinite(entry.importedAt)
            ? { importedAt: entry.importedAt }
            : {}),
        }
      }
      this.data = data
      this.pending = pending
      this.readError = null
      this.loadedStamp = stamp
    } catch (error) {
      this.readError = `bindings.json illisible (${error instanceof Error ? error.message : String(error)}) : réécriture refusée.`
      this.loadedStamp = stamp
    }
  }

  get(chatId: string): string | null {
    return this.data[chatId]?.projectPath ?? null
  }

  count(): number {
    return Object.keys(this.data).length
  }

  /** Écrit APRÈS avoir validé le chemin. Lève si le fichier est corrompu. */
  set(chatId: string, projectPath: string): void {
    if (this.readError !== null) throw new Error(this.readError)
    this.data[chatId] = {
      projectPath,
      createdAt: Date.now(),
      signatures: [],
      lastTurnAt: 0,
      resumeRef: null,
      chatRefs: [],
    }
    this.flush()
  }

  /**
   * Lie un chat importé à sa conversation CLI.
   *
   * N'écrase jamais un binding existant : un chat déjà utilisé dans OWUI garde
   * son fil. Le `lastTurnAt` vient de l'import (mtime du transcript) ; il sera
   * remplacé au premier tour abouti.
   */
  bindImported(
    chatId: string,
    input: {
      projectPath: string
      ref: string
      profileDir: string
      importedAt: number
      lastTurnAt: number
    },
  ): boolean {
    if (this.readError !== null) throw new Error(this.readError)
    if (this.data[chatId] !== undefined) return false
    this.data[chatId] = {
      projectPath: input.projectPath,
      createdAt: Date.now(),
      signatures: [],
      lastTurnAt: input.lastTurnAt,
      resumeRef: input.ref,
      chatRefs: [input.ref],
      profileDir: input.profileDir,
      importedAt: input.importedAt,
    }
    this.flush()
    return true
  }

  /** Signatures du dernier tour accepté, ou `null` si aucun tour n'a eu lieu. */
  signatures(chatId: string): string[] | null {
    const entry = this.data[chatId]
    if (entry === undefined || entry.signatures.length === 0) return null
    return entry.signatures
  }

  /** Enregistre la signature d'un tour accepté. Lève si le fichier est corrompu. */
  recordTurn(chatId: string, signatures: string[]): void {
    if (this.readError !== null) throw new Error(this.readError)
    const entry = this.data[chatId]
    if (entry === undefined) throw new Error(`binding inconnu : ${chatId}`)
    entry.signatures = signatures
    entry.lastTurnAt = Date.now()
    // Le tour a abouti : la conversation choisie est chargée, il n'y a plus
    // rien à reprendre. Un tour refusé, lui, laisse la reprise en place.
    entry.resumeRef = null
    this.flush()
  }

  /** Conversation à reprendre au prochain tour, ou `null`. */
  resumeRef(chatId: string): string | null {
    return this.data[chatId]?.resumeRef ?? null
  }

  /** Retient la conversation choisie par `/import` ; aucun tour n'est lancé. */
  setResumeRef(chatId: string, ref: string): void {
    if (this.readError !== null) throw new Error(this.readError)
    const entry = this.data[chatId]
    if (entry === undefined) throw new Error(`binding inconnu : ${chatId}`)
    entry.resumeRef = ref
    this.flush()
  }

  /** Conversations CLI déjà utilisées par ce chat, la plus récente d'abord. */
  chatRefs(chatId: string): string[] {
    return this.data[chatId]?.chatRefs ?? []
  }

  /**
   * Note la conversation que la session de ce chat vient d'utiliser.
   *
   * Trois au plus : de quoi retrouver la réponse quand la dernière relance
   * n'a rien écrit. Écrire à chaque tour est inutile — on s'arrête si la liste
   * ne change pas.
   */
  recordChatRef(chatId: string, ref: string): void {
    if (this.readError !== null) throw new Error(this.readError)
    const entry = this.data[chatId]
    if (entry === undefined) throw new Error(`binding inconnu : ${chatId}`)
    const next = [ref, ...entry.chatRefs.filter(known => known !== ref)].slice(0, 3)
    if (next.length === entry.chatRefs.length && next.every((value, i) => value === entry.chatRefs[i])) {
      return
    }
    entry.chatRefs = next
    this.flush()
  }

  /** Dossier retenu pour la prochaine conversation créée, s'il est encore frais. */
  pendingPath(now = Date.now()): string | null {
    if (this.pending === null) return null
    if (now - this.pending.at > PENDING_TTL_MS) return null
    return this.pending.projectPath
  }

  /** Retient le dossier d'une conversation qui n'a pas encore d'id. */
  setPending(projectPath: string): void {
    if (this.readError !== null) throw new Error(this.readError)
    this.pending = { projectPath, at: Date.now() }
    this.flush()
  }

  /**
   * Lie `chatId` au dossier retenu, puis l'oublie : un dossier choisi ne doit
   * jamais s'appliquer deux fois. Rend le chemin retenu, ou `null`.
   */
  takePending(chatId: string, now = Date.now()): string | null {
    const path = this.pendingPath(now)
    if (path === null) {
      if (this.pending !== null) this.clearPending()
      return null
    }
    this.set(chatId, path)
    this.clearPending()
    return path
  }

  /** Oublie le dossier retenu (annulation, ou après consommation). */
  clearPending(): void {
    if (this.pending === null) return
    this.pending = null
    if (this.readError !== null) return
    this.flush()
  }

  /** Les projets distincts les plus récents — proposés quand un chemin échoue. */
  recent(limit = 5): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const entry of Object.values(this.data).sort((a, b) => b.createdAt - a.createdAt)) {
      if (seen.has(entry.projectPath)) continue
      seen.add(entry.projectPath)
      out.push(entry.projectPath)
      if (out.length === limit) break
    }
    return out
  }

  private flush(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    const payload = this.pending === null ? this.data : { ...this.data, [PENDING_KEY]: this.pending }
    fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    fs.renameSync(temp, this.file)
    try {
      const stat = fs.statSync(this.file)
      this.loadedStamp = `${String(stat.mtimeMs)}:${String(stat.size)}`
    } catch {
      // L'écriture a réussi ; la prochaine relecture posera l'empreinte.
    }
  }
}
