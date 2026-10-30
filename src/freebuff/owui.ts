/**
 * Le seul client OpenWebUI de l'import : API HTTP publique, rien d'autre.
 *
 * On n'écrit jamais dans la base SQLite d'OWUI et on ne modifie aucun de ses
 * fichiers. Quatre routes suffisent, celles qu'un admin utilise dans
 * l'interface :
 * - `GET/POST /api/v1/folders/` : le dossier du projet, partagé par tous les
 *   profils ;
 * - `POST /api/v1/chats/import` : créer un chat ;
 * - `GET /api/v1/chats/{id}` : savoir s'il a bougé depuis l'import ;
 * - `POST /api/v1/chats/{id}` : mettre à jour un chat non utilisé.
 *
 * Auth : une clé API OWUI (`sk-…`), jamais le JWT de session — il expire et la
 * synchronisation s'arrêterait sans raison visible.
 */
import fs from 'node:fs'
import path from 'node:path'

export interface OwuiMessage {
  id: string
  parentId: string | null
  childrenIds: string[]
  role: 'user' | 'assistant'
  content: string
  model?: string
  timestamp: number
  done: true
}

export interface OwuiChatPayload {
  chat: {
    title: string
    models: string[]
    history: { messages: Record<string, OwuiMessage>; currentId: string | null }
    params: Record<string, never>
    files: never[]
  }
  meta: { tags: string[] }
  pinned: boolean
  archived: boolean
  folder_id: string | null
  current_message_id: string | null
  created_at: number
  updated_at: number
}

export interface OwuiChatRef {
  id: string
  /** `updated_at` côté OWUI (epoch secondes) : empreinte de « non touché ». */
  updatedAt: number
}

export class OwuiError extends Error {
  readonly status: number
  readonly body: string

  constructor(message: string, status: number, body: string) {
    super(message)
    this.name = 'OwuiError'
    this.status = status
    this.body = body
  }
}

export interface OwuiFolderInfo {
  id: string
  name: string
  /** Métadonnées du dossier (`icon`, `lastActivity` une fois le patch appliqué). */
  meta: Record<string, unknown> | null
}

export interface OwuiChatSummary {
  id: string
  title: string
  /** `created_at` OWUI (epoch secondes), tel qu'envoyé à l'import. */
  createdAt: number
  updatedAt: number
}

export interface OwuiClient {
  ensureFolder(name: string): Promise<string>
  /** Tous les dossiers de l'utilisateur, métadonnées comprises. */
  listFolders(): Promise<OwuiFolderInfo[]>
  /**
   * Écrit `lastActivity` (epoch secondes) dans `meta` du dossier ; OWUI fusionne
   * les clés, donc l'icône et le reste sont conservés.
   */
  updateFolderMeta(id: string, meta: Record<string, unknown>): Promise<void>
  importChat(payload: OwuiChatPayload): Promise<OwuiChatRef>
  /** Tous les chats de l'utilisateur : sert à retrouver un import interrompu. */
  listChats(): Promise<OwuiChatSummary[]>
  getChat(id: string): Promise<OwuiChatRef>
  updateChat(id: string, chat: OwuiChatPayload['chat']): Promise<OwuiChatRef>
  /**
   * Range un chat existant dans un dossier (`POST /chats/{id}/folder`).
   * OWUI réécrit `updated_at` au passage : la valeur rendue doit remplacer
   * l'empreinte stockée, sinon le chat passerait pour « touché dans OWUI ».
   */
  moveChat(id: string, folderId: string): Promise<OwuiChatRef>
}

/** Clé API OWUI : variable d'environnement prioritaire, puis `data/owui-key.txt`. */
export function resolveOwuiKey(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const fromEnv = env.BRIDGE_OWUI_KEY?.trim()
  if (fromEnv) return fromEnv
  try {
    const stored = fs.readFileSync(path.join(dataDir, 'owui-key.txt'), 'utf8').trim()
    return stored === '' ? null : stored
  } catch {
    return null
  }
}

export function createOwuiClient(options: {
  baseUrl: string
  apiKey: string
  fetchImpl?: typeof fetch
}): OwuiClient {
  const base = options.baseUrl.replace(/\/+$/, '')
  const doFetch = options.fetchImpl ?? fetch

  const request = async <T>(route: string, init: RequestInit = {}): Promise<T> => {
    const response = await doFetch(`${base}${route}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(init.headers ?? {}),
      },
    })
    const text = await response.text()
    if (!response.ok) {
      throw new OwuiError(
        `${init.method ?? 'GET'} ${route} → ${String(response.status)}`,
        response.status,
        text.slice(0, 300),
      )
    }
    return (text === '' ? null : JSON.parse(text)) as T
  }

  const folders = async (): Promise<OwuiFolderInfo[]> =>
    request<OwuiFolderInfo[]>('/api/v1/folders/')

  /** OWUI compare les noms de dossier sans tenir compte de la casse. */
  const sameName = (a: string, b: string) =>
    a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase()

  return {
    async listFolders() {
      return folders()
    },

    async updateFolderMeta(id, meta) {
      await request<unknown>(`/api/v1/folders/${encodeURIComponent(id)}/update`, {
        method: 'POST',
        body: JSON.stringify({ meta }),
      })
    },

    async ensureFolder(name) {
      const existing = (await folders()).find(folder => sameName(folder.name, name))
      if (existing !== undefined) return existing.id
      try {
        const created = await request<{ id: string }>('/api/v1/folders/', {
          method: 'POST',
          body: JSON.stringify({ name, data: {} }),
        })
        return created.id
      } catch (error) {
        // Course entre deux exécutions : le dossier existe déjà, on le relit
        // plutôt que d'importer hors dossier.
        if (error instanceof OwuiError && error.status === 400) {
          const raced = (await folders()).find(folder => sameName(folder.name, name))
          if (raced !== undefined) return raced.id
        }
        throw error
      }
    },

    async importChat(payload) {
      const created = await request<Array<{ id: string; updated_at: number }>>(
        '/api/v1/chats/import',
        { method: 'POST', body: JSON.stringify({ chats: [payload] }) },
      )
      const chat = created[0]
      if (chat === undefined) throw new OwuiError('import OWUI sans chat rendu', 502, '')
      return { id: chat.id, updatedAt: chat.updated_at }
    },

    async listChats() {
      // `include_folders=true` est indispensable : sans lui, OWUI ne rend que
      // les chats SANS dossier — or tous les imports vivent dans un dossier de
      // projet. La reprise après crash ne verrait donc jamais le chat orphelin
      // et en créerait un doublon (mesuré sur OWUI réel).
      const list = await request<
        Array<{ id: string; title: string; created_at: number; updated_at: number }>
      >('/api/v1/chats/?include_folders=true&include_pinned=true')
      return list.map(chat => ({
        id: chat.id,
        title: chat.title,
        createdAt: chat.created_at,
        updatedAt: chat.updated_at,
      }))
    },

    async getChat(id) {
      const chat = await request<{ id: string; updated_at: number }>(
        `/api/v1/chats/${encodeURIComponent(id)}`,
      )
      return { id: chat.id, updatedAt: chat.updated_at }
    },

    async updateChat(id, chat) {
      const updated = await request<{ id: string; updated_at: number }>(
        `/api/v1/chats/${encodeURIComponent(id)}`,
        { method: 'POST', body: JSON.stringify({ chat }) },
      )
      return { id: updated.id, updatedAt: updated.updated_at }
    },

    async moveChat(id, folderId) {
      const moved = await request<{ id: string; updated_at: number }>(
        `/api/v1/chats/${encodeURIComponent(id)}/folder`,
        { method: 'POST', body: JSON.stringify({ folder_id: folderId }) },
      )
      return { id: moved.id, updatedAt: moved.updated_at }
    },
  }
}
