/**
 * Où la CLI écrit son chat, et comment savoir qu'elle a pris la consigne.
 *
 * Ces deux décisions vivaient dans `FreebuffSession`, mêlées au PTY et donc
 * intestables. Mesure du 2026-10-21 : le pont redémarre, la CLI ouvre un
 * nouveau chat, mais le dossier du chat PRÉCÉDENT restait en cache — le compte
 * de messages `user` ne bougeait donc plus et le tour était rendu
 * `not_accepted` alors que la CLI avait accepté la consigne et lancé un tour.
 * Extraites ici, ces règles se testent avec de simples dossiers.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { TranscriptEntry } from './transcript.ts'

/** Dossier de chat le plus récent qui possède un transcript, ou `null`. */
export function newestChatDir(root: string): string | null {
  let names: string[]
  try {
    names = fs.readdirSync(root)
  } catch {
    return null
  }

  let best: { dir: string; mtime: number } | null = null
  for (const name of names) {
    const dir = path.join(root, name)
    try {
      const mtime = fs.statSync(path.join(dir, 'chat-messages.json')).mtimeMs
      if (best === null || mtime > best.mtime) best = { dir, mtime }
    } catch {
      continue
    }
  }
  return best === null ? null : best.dir
}

/** Le chat visible (le plus récent) et son nombre de messages `user`. */
export interface ChatSnapshot {
  dir: string | null
  users: number
}

/** Ce qu'un dossier de chat dit de son dernier tour. */
export interface ChatUsers {
  users: number
  /** Dernière consigne écrite, espaces aplatis — la même forme que le prompt envoyé. */
  lastUser: string | null
}

const EMPTY_USERS: ChatUsers = { users: 0, lastUser: null }

/**
 * Nombre de messages `user` et dernière consigne d'un dossier de chat.
 *
 * Mis en cache sur `mtime:taille` : l'acceptation d'un prompt est vérifiée
 * toutes les 200 ms, et relire un transcript de plusieurs centaines de Ko à
 * chaque passage coûterait cher pour rien.
 */
export function chatUsers(dir: string): ChatUsers {
  let mark: string
  try {
    const stat = fs.statSync(path.join(dir, 'chat-messages.json'))
    mark = `${String(stat.mtimeMs)}:${String(stat.size)}`
  } catch {
    return EMPTY_USERS
  }

  const cached = usersCache.get(dir)
  if (cached !== undefined && cached.mark === mark) return cached.value

  let entries: TranscriptEntry[] = []
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'chat-messages.json'), 'utf8'))
    if (Array.isArray(parsed)) entries = parsed as TranscriptEntry[]
  } catch {
    // Fichier en cours de réécriture : on garde la dernière lecture connue.
    return cached?.value ?? EMPTY_USERS
  }

  let users = 0
  let lastUser: string | null = null
  for (const entry of entries) {
    if (entry?.variant !== 'user') continue
    users += 1
    if (typeof entry.content === 'string') {
      const flat = entry.content.replace(/\s+/g, ' ').trim()
      if (flat !== '') lastUser = flat
    }
  }
  const value: ChatUsers = { users, lastUser }
  usersCache.set(dir, { mark, value })
  if (usersCache.size > 128) usersCache.clear()
  return value
}

const usersCache = new Map<string, { mark: string; value: ChatUsers }>()

/**
 * Le dossier de chat que CE prompt vient d'ouvrir, ou `null`.
 *
 * Deux conversations liées au même dossier ont chacune leur CLI, donc chacune
 * écrit dans `chats/` : « le plus récent » ne désigne plus rien. On reconnaît
 * le bon dossier par la consigne qu'on vient d'écrire, et seulement s'il a été
 * touché APRÈS le départ du tour (sinon on relirait un tour d'avant).
 */
export function claimForPrompt(
  root: string,
  prompt: string,
  options: { since: number },
): string | null {
  const wanted = prompt.replace(/\s+/g, ' ').trim()
  if (wanted === '') return null

  let names: string[]
  try {
    names = fs.readdirSync(root)
  } catch {
    return null
  }

  let best: { dir: string; mtime: number } | null = null
  for (const name of names) {
    const dir = path.join(root, name)
    let mtime: number
    try {
      mtime = fs.statSync(path.join(dir, 'chat-messages.json')).mtimeMs
    } catch {
      continue
    }
    if (mtime < options.since) continue
    if (chatUsers(dir).lastUser !== wanted) continue
    if (best === null || mtime > best.mtime) best = { dir, mtime }
  }
  return best?.dir ?? null
}

/** Une consigne prise par la CLI, telle que son journal la raconte. */
interface SendRecord {
  at: number
  length: number
}

/** Une ligne de `log.jsonl` qui annonce un envoi, ou `null`. */
function parseSend(line: string): SendRecord | null {
  if (!line.includes('[send-message]')) return null
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof entry !== 'object' || entry === null) return null
  const record = entry as { msg?: unknown; timestamp?: unknown; data?: unknown }
  if (typeof record.msg !== 'string' || !record.msg.startsWith('[send-message]')) return null
  if (typeof record.timestamp !== 'string') return null
  const at = Date.parse(record.timestamp)
  if (!Number.isFinite(at)) return null
  const runConfig = (record.data as { runConfig?: { promptLength?: unknown } } | undefined)?.runConfig
  if (typeof runConfig?.promptLength !== 'number') return null
  return { at, length: runConfig.promptLength }
}

/**
 * `log.jsonl` de la CLI dit-il qu'une consigne de cette longueur a été PRISE ?
 *
 * Mesure du 2026-10-23 : le transcript n'écrit le message `user` qu'à la FIN
 * du tour. Une consigne qui fait travailler l'agent plus de 20 s (le délai
 * d'acceptation) était donc réécrite une seconde fois, et le tour rendu
 * `not_accepted` alors qu'il tournait. Le journal, lui, écrit
 * `[send-message] … promptLength` au moment où la CLI prend le message —
 * c'est la seule preuve d'acceptation disponible tout de suite.
 */
export function sentInLog(raw: string, promptLength: number, since: number): boolean {
  for (const line of raw.split('\n')) {
    const send = parseSend(line)
    if (send !== null && send.length === promptLength && send.at >= since) return true
  }
  return false
}

/**
 * Envois déjà relevés, par dossier de chat.
 *
 * Le journal grossit de plusieurs centaines de Ko par tour et la ligne
 * `[send-message]` est en TÊTE de tour, pas en queue : on garde donc un
 * curseur d'octets par dossier et on ne relit que ce qui a été ajouté. Le
 * pont interroge l'acceptation toutes les 200 ms — relire le fichier entier à
 * chaque passage coûterait cher pour rien.
 */
const sendsCache = new Map<string, { scanned: number; sends: SendRecord[] }>()

/** Trace temporaire de l'acceptation (`BRIDGE_DEBUG_ACCEPT=1`), à retirer. */
function trace(event: Record<string, unknown>): void {
  if (!process.env.BRIDGE_DEBUG_ACCEPT) return
  try {
    fs.appendFileSync('.tmp/accept.log', `${JSON.stringify({ at: Date.now(), ...event })}\n`, 'utf8')
  } catch {
    // pas de trace, tant pis
  }
}

function sendsOf(dir: string): SendRecord[] {
  const file = path.join(dir, 'log.jsonl')
  let size: number
  try {
    size = fs.statSync(file).size
  } catch {
    return []
  }

  const cached = sendsCache.get(dir)
  // Un journal réécrit (plus court qu'avant) repart de zéro.
  const state = cached !== undefined && size >= cached.scanned ? cached : { scanned: 0, sends: [] }
  if (size === state.scanned) {
    sendsCache.set(dir, state)
    return state.sends
  }

  let text: string
  try {
    const buffer = Buffer.alloc(size - state.scanned)
    const handle = fs.openSync(file, 'r')
    try {
      fs.readSync(handle, buffer, 0, buffer.length, state.scanned)
    } finally {
      fs.closeSync(handle)
    }
    text = buffer.toString('utf8')
  } catch {
    return state.sends
  }

  // Seulement les lignes TERMINÉES : la dernière peut être en cours d'écriture
  // et sera relue au passage suivant.
  const cut = text.lastIndexOf('\n')
  if (cut !== -1) {
    const complete = text.slice(0, cut + 1)
    for (const line of complete.split('\n')) {
      const send = parseSend(line)
      if (send !== null) state.sends.push(send)
    }
    state.scanned += Buffer.byteLength(complete, 'utf8')
  }
  // Un tour suffit largement : on ne garde que les derniers envois.
  const next = { scanned: state.scanned, sends: state.sends.slice(-64) }
  sendsCache.set(dir, next)
  if (sendsCache.size > 64) sendsCache.clear()
  return next.sends
}

/**
 * Un envoi a-t-il eu lieu dans CE dossier depuis `since` ?
 *
 * Réservé aux dossiers dont on sait qu'ils appartiennent à la session : le
 * dossier ouvert au démarrage de SA CLI, ou celui qu'elle tient déjà. Aucune
 * autre conversation n'y écrit, et le pont ne lance qu'un tour à la fois par
 * conversation — la longueur du prompt n'a donc rien à prouver.
 *
 * C'est nécessaire : la CLI peut recevoir un texte de longueur différente de
 * celui qu'on a écrit (mesuré le 2026-10-23 : 7 395 caractères écrits, 7 365
 * reçus sur une reprise de fil), et comparer les longueurs rendait alors
 * l'acceptation invisible pendant tout le tour.
 */
export function sentAnySince(dir: string, since: number): boolean {
  const sends = sendsOf(dir)
  const ok = sends.some(send => send.at >= since)
  trace({ kind: 'any', dir, since, sends, ok })
  return ok
}

/** Un dossier de chat précis a-t-il pris une consigne de cette longueur ? */
export function sentInChatDir(dir: string, promptLength: number, since: number): boolean {
  const sends = sendsOf(dir)
  const ok = sends.some(send => send.length === promptLength && send.at >= since)
  trace({ kind: 'dir', dir, promptLength, since, sends, ok })
  return ok
}

/**
 * Le dossier de chat dans lequel CE prompt vient d'être pris, ou `null`.
 *
 * Complément de `claimForPrompt` quand le transcript n'a pas encore écrit la
 * consigne : on reconnaît le dossier au journal de la CLI, qui porte la
 * longueur du prompt envoyé. Aucun autre dossier ne peut avoir la même
 * consigne au même instant : le pont sérialise les tours d'un projet.
 */
export function claimForSend(
  root: string,
  promptLength: number,
  options: { since: number },
): string | null {
  let names: string[]
  try {
    names = fs.readdirSync(root)
  } catch {
    return null
  }

  let best: { dir: string; mtime: number } | null = null
  for (const name of names) {
    const dir = path.join(root, name)
    let mtime: number
    try {
      // PAS de filtre par date : sous Windows, un fichier écrit par un handle
      // resté ouvert garde sa `mtime` de création jusqu'au `fsync`/`close`.
      // Le journal de la CLI reste ouvert pendant tout le tour (mesuré le
      // 2026-10-23 : écrit à 13:20:48, `mtime` toujours à 13:20:36), donc un
      // filtre sur ce champ sautait le dossier même quand l'envoi y était.
      mtime = fs.statSync(path.join(dir, 'log.jsonl')).mtimeMs
    } catch {
      continue
    }
    const hit = sentInChatDir(dir, promptLength, options.since)
    trace({ kind: 'scan', dir, promptLength, hit, mtime })
    if (!hit) continue
    if (best === null || mtime > best.mtime) best = { dir, mtime }
  }
  return best?.dir ?? null
}

/**
 * Le prompt a-t-il été pris ? Deux cas, et deux seulement :
 * - un AUTRE dossier de chat apparaît avec au moins un message `user` : la CLI
 *   a ouvert un nouveau fil (cas d'un redémarrage du pont) ;
 * - le dossier d'avant gagne un message `user`.
 *
 * Un nouveau dossier encore vide ne prouve rien : la CLI le crée au démarrage,
 * avant même de lire la saisie.
 */
export function promptAccepted(after: ChatSnapshot, before: ChatSnapshot): boolean {
  if (after.dir === null) return false
  if (after.dir !== before.dir) return after.users > 0
  return after.users > before.users
}
