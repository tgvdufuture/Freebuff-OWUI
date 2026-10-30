/**
 * Le portier des sessions Freebuff : une session par CONVERSATION.
 *
 * Deux conversations d'OpenWebUI liées au MÊME dossier ont chacune leur CLI :
 * un `cwd` n'est pas une identité de session, et partager une session forçait
 * deux chats à attendre l'un l'autre (et à se disputer le fil). Sans identifiant
 * de chat (curl, scripts), la session reste celle du projet — c'est le repli.
 *
 * Mesuré en S12 : plusieurs `freebuff` coexistent sur le même profil. Ce
 * fichier garantit quatre choses :
 *
 * 1. **Sérialisation par session.** Une TUI a une seule zone de saisie : deux
 *    prompts écrits dans la MÊME session se mélangent. Les requêtes d'une
 *    conversation passent donc une par une, dans l'ordre d'arrivée ; deux
 *    conversations ne s'attendent pas, même sur le même dossier.
 * 2. **Aucun redémarrage silencieux.** Si une session meurt, on le dit : la
 *    relancer consommerait une nouvelle session de quota sans que personne ne
 *    l'ait demandé.
 * 3. **Une limite.** Chaque session ouverte coûte une heure de quota : au-delà
 *    de `limit` sessions vivantes, on refuse explicitement plutôt que d'en
 *    ouvrir une de plus dans le dos de l'utilisateur.
 * 4. **Un `settings.json` partagé.** Le modèle est global au profil : son
 *    écriture est protégée par une section critique et n'a lieu qu'à
 *    l'OUVERTURE d'une session. Une session déjà lancée garde son modèle ; un
 *    changement de modèle ferme et relance la session de la conversation
 *    concernée, et seulement elle.
 */
import path from 'node:path'
import type { AgentSession, SessionLeftReading } from './session.ts'
import type { QuotaView } from './screen.ts'

/** Ce qu'il faut écrire dans `settings.json` pour sélectionner un modèle. */
export interface ModelChoice {
  id: string | null
  key: string | null
}

/** L'écriture de `freebuffModel`/`freebuffModelKey`, injectée pour tester sans profil. */
export interface ModelWriter {
  set(choice: ModelChoice): void
}

/** Étiquette unique d'un modèle : la clé l'emporte, comme dans `settings.json`. */
export function choiceIdentity(choice: ModelChoice): string {
  return choice.key ?? choice.id ?? ''
}

export class SessionGone extends Error {
  constructor() {
    super(
      'la session Freebuff est terminée. Le pont ne relance pas la CLI tout seul : ' +
        'redémarre le pont (npm start) pour ouvrir une nouvelle session.',
    )
    this.name = 'SessionGone'
  }
}

/**
 * L'ancien processus a survécu au changement de modèle : on refuse d'en ouvrir
 * un second pour ce projet, qui consommerait une session de plus.
 */
export class SessionStuck extends Error {
  constructor(pid: number) {
    super(
      `le changement de modèle n'a pas pu fermer l'ancienne session Freebuff (processus ${pid} encore ` +
        `vivant). Ferme-le, puis relance la demande : le pont n'ouvre jamais deux sessions pour ce projet.`,
    )
    this.name = 'SessionStuck'
  }
}

/** Trop de sessions vivantes : le quota est une ressource, pas un détail. */
export class TooManySessions extends Error {
  readonly limit: number

  constructor(limit: number, projectDir: string) {
    super(
      `le pont tient déjà ${String(limit)} sessions Freebuff vivantes (la limite). Termine un projet ` +
        `(ou redémarre le pont) avant d'en ouvrir une pour ${projectDir}.`,
    )
    this.name = 'TooManySessions'
    this.limit = limit
  }
}

/**
 * Cible d'une session : une conversation (`chat:<id>`) ou, à défaut d'
 * identifiant de chat, un projet (`project:<chemin normalisé>`).
 */
export interface SessionRef {
  key: string
  /** Dossier de travail de la CLI — un projet peut porter plusieurs sessions. */
  projectDir: string
}

/** Clé normalisée d'un projet (même chemin = même clé sous Windows). */
export function projectKey(projectDir: string): string {
  const resolved = path.resolve(projectDir)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * La session d'une conversation, ou celle du projet quand il n'y a pas de chat.
 *
 * `chatId` vient d'OpenWebUI (`x-openwebui-chat-id`) : c'est lui qui distingue
 * deux conversations sur le même dossier.
 */
export function sessionRef(chatId: string | null | undefined, projectDir: string): SessionRef {
  const id = typeof chatId === 'string' ? chatId.trim() : ''
  return {
    key: id === '' ? `project:${projectKey(projectDir)}` : `chat:${id}`,
    projectDir,
  }
}

/** Un chemin reste accepté : c'est la session du projet (API sans chatId). */
type SessionTarget = string | SessionRef

function targetOf(target: SessionTarget): SessionRef {
  return typeof target === 'string' ? sessionRef(null, target) : target
}

export interface SessionStatus {
  key: string
  pid: number
  alive: boolean
  chatRef: string | null
  projectDir: string
}

/** Ce que l'arrêt a réellement fait, pour ne pas mentir sur un PID survivant. */
export interface SessionStop {
  pid: number
  ok: boolean
  remaining: boolean
}

/** Ce que le pont veut tracer à chaque relance (modèle ou conversation). */
export interface SessionHooks {
  onModelSwitch?: (from: string, to: string, pid: number) => void
  onResume?: (ref: string, pid: number) => void
}

export interface SessionHostOptions {
  /** Sessions vivantes simultanées (projets différents). Défaut : 3. */
  limit?: number
}

interface Entry {
  session: AgentSession
  model: ModelChoice | null
  /** Conversation reprise à l'ouverture (`--continue`), ou `null`. */
  continueRef: string | null
}

export class SessionHost {
  private readonly open: (projectDir: string, continueRef?: string) => Promise<AgentSession>
  private readonly settings: ModelWriter
  private readonly hooks: SessionHooks
  private readonly limit: number
  private readonly entries = new Map<string, Entry>()
  /**
   * Chaînes de sérialisation PAR PROJET — tenues à part des entrées pour qu'une
   * première requête sur un projet neuf soit déjà dans la file avant que la
   * session n'existe.
   */
  private readonly chains = new Map<string, Promise<unknown>>()
  /** Section critique globale : `settings.json` est partagé par tout le profil. */
  private boot: Promise<unknown> = Promise.resolve()

  constructor(
    open: (projectDir: string, continueRef?: string) => Promise<AgentSession>,
    settings: ModelWriter,
    hooks: SessionHooks = {},
    options: SessionHostOptions = {},
  ) {
    this.open = open
    this.settings = settings
    this.hooks = hooks
    this.limit = options.limit ?? 3
  }

  /** Nombre de sessions vivantes (la limite ne compte que celles-là). */
  aliveCount(): number {
    let count = 0
    for (const { session } of this.entries.values()) if (session.alive) count += 1
    return count
  }

  /**
   * Quota lu sur le bandeau d'une session VIVANTE, ou `null`.
   *
   * Instantané et gratuit : l'écran est déjà en mémoire. Sans session ouverte,
   * il faut une sonde (`probeQuota`), qui lance une TUI sans consigne.
   */
  quota(target?: SessionTarget): QuotaView | null {
    for (const { session } of this.matching(target)) {
      if (session.quota?.found === true) return session.quota
    }
    return null
  }

  /**
   * Sessions visibles pour une cible : la sienne, ou celles du projet quand la
   * cible est un simple chemin, ou toutes quand il n'y en a pas.
   */
  private matching(target?: SessionTarget): Array<{ session: AgentSession }> {
    const out: Array<{ session: AgentSession }> = []
    const ref = target === undefined ? null : targetOf(target)
    for (const [key, entry] of this.entries) {
      if (!entry.session.alive) continue
      if (ref === null) {
        out.push(entry)
        continue
      }
      if (ref.key.startsWith('chat:')) {
        if (key === ref.key) out.push(entry)
        continue
      }
      if (projectKey(entry.session.projectDir) === projectKey(ref.projectDir)) out.push(entry)
    }
    return out
  }

  /**
   * Compte à rebours de la session, ou `null` si la TUI n'en a pas encore
   * affiché. `projectDir` limite la lecture à la session d'un projet.
   */
  sessionLeft(target?: SessionTarget): SessionLeftReading | null {
    for (const { session } of this.matching(target)) {
      if (session.sessionLeft !== null && session.sessionLeft !== undefined) return session.sessionLeft
    }
    return null
  }

  /** Toutes les sessions connues, vivantes ou non (ordre d'ouverture). */
  statuses(): SessionStatus[] {
    return [...this.entries].map(([key, { session }]) => {
      const { pid, alive, chatRef, projectDir } = session
      return { key, pid, alive, chatRef, projectDir }
    })
  }

  /** Première session ouverte — conservé pour `/health` et les tests simples. */
  status(): SessionStatus | null {
    return this.statuses()[0] ?? null
  }

  /**
   * Arrête toutes les sessions et leur arbre de processus. Appelé à l'arrêt du
   * pont (un `freebuff.exe` orphelin consommerait un slot).
   */
  stop(): SessionStop[] {
    const results: SessionStop[] = []
    for (const { session } of this.entries.values()) {
      const result = session.stop()
      results.push({ pid: session.pid, ok: result.ok, remaining: result.remaining })
    }
    this.entries.clear()
    this.chains.clear()
    return results
  }

  /**
   * Démarre la session du projet si besoin, sans écrire de prompt. Permet de
   * rendre un refus de quota en erreur HTTP avant d'ouvrir un flux SSE.
   */
  ready(target: SessionTarget, model?: ModelChoice, continueRef?: string): Promise<SessionStatus> {
    const ref = targetOf(target)
    return this.queue(ref.key, async () => {
      await this.ensure(target, model, continueRef)
      const entry = this.entries.get(ref.key)
      if (entry === undefined) throw new SessionGone()
      const { pid, alive, chatRef } = entry.session
      return { key: ref.key, pid, alive, chatRef, projectDir: entry.session.projectDir }
    })
  }

  /**
   * Relance EXPLICITEMENT la session d'un projet après sa mort.
   *
   * C'est l'exception au « aucun redémarrage silencieux » : le bouton
   * Continuer est une action de l'utilisateur. Une session vivante n'est pas
   * touchée, et la limite de sessions reste appliquée.
   */
  restart(target: SessionTarget): Promise<SessionStatus> {
    const { key, projectDir } = targetOf(target)
    return this.queue(key, async () => {
      const current = this.entries.get(key)
      if (current !== undefined && current.session.alive) {
        const { pid, alive, chatRef } = current.session
        return { key, pid, alive, chatRef, projectDir: current.session.projectDir }
      }

      if (current !== undefined) this.entries.delete(key)
      if (this.aliveCount() >= this.limit) throw new TooManySessions(this.limit, projectDir)

      const session = await this.withBoot(async () => this.open(projectDir))
      this.entries.set(key, { session, model: current?.model ?? null, continueRef: null })
      const { pid, alive, chatRef } = session
      return { key, pid, alive, chatRef, projectDir: session.projectDir }
    })
  }

  /** Exécute `fn` avec la session du projet, une requête à la fois pour lui. */
  use<T>(
    target: SessionTarget,
    fn: (session: AgentSession) => Promise<T>,
    model?: ModelChoice,
    continueRef?: string,
  ): Promise<T> {
    const ref = targetOf(target)
    return this.queue(ref.key, async () => fn(await this.ensure(target, model, continueRef)))
  }

  /**
   * Exécute `fn` sur la session DÉJÀ ouverte du projet, ou rend `null`.
   *
   * Contrairement à `use`, aucune CLI n'est lancée : la barre de quota ne doit
   * jamais ouvrir de session pour se rafraîchir.
   */
  useExisting<T>(target: SessionTarget, fn: (session: AgentSession) => Promise<T>): Promise<T | null> {
    const ref = targetOf(target)
    return this.queue(ref.key, async () => {
      const entry = this.entries.get(ref.key)
      if (entry === undefined || !entry.session.alive) return null
      return fn(entry.session)
    })
  }

  /** Met `run` à la suite de la file de la SESSION, sans jamais la laisser rejetée. */
  private queue<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve()
    const next = previous.then(run)
    this.chains.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  private async ensure(target: SessionTarget, model?: ModelChoice, continueRef?: string): Promise<AgentSession> {
    const { key, projectDir } = targetOf(target)
    const current = this.entries.get(key)

    if (current !== undefined) {
      if (!current.session.alive) throw new SessionGone()
      // Le modèle d'abord : sa bascule relance déjà la CLI, et reprendre la
      // conversation après évite de perdre le fil deux fois.
      if (model !== undefined && current.model !== null && choiceIdentity(model) !== choiceIdentity(current.model)) {
        await this.switchModel(key, projectDir, model)
      }
      let entry = this.entries.get(key)
      if (entry === undefined) throw new SessionGone()
      if (continueRef !== undefined && entry.continueRef !== continueRef) {
        await this.switchConversation(key, projectDir, continueRef)
        entry = this.entries.get(key)
        if (entry === undefined) throw new SessionGone()
      }
      return entry.session
    }

    if (this.aliveCount() >= this.limit) throw new TooManySessions(this.limit, projectDir)

    // Ouverture sérialisée GLOBALEMENT : le modèle s'écrit dans un fichier
    // partagé, puis la CLI démarre avec cette valeur.
    return this.withBoot(async () => {
      const again = this.entries.get(key)
      if (again !== undefined) {
        if (!again.session.alive) throw new SessionGone()
        return again.session
      }
      if (this.aliveCount() >= this.limit) throw new TooManySessions(this.limit, projectDir)
      if (model !== undefined) this.settings.set(model)
      const session = await this.open(projectDir, continueRef)
      if (continueRef !== undefined) this.hooks.onResume?.(continueRef, session.pid)
      this.entries.set(key, { session, model: model ?? null, continueRef: continueRef ?? null })
      return session
    })
  }

  /**
   * Change le modèle d'UNE session en la fermant (la CLI ne change pas de
   * modèle à chaud). Les autres sessions ne sont pas touchées : le fichier
   * `settings.json` n'est lu qu'au lancement.
   */
  private async switchModel(key: string, projectDir: string, model: ModelChoice): Promise<void> {
    const previous = this.entries.get(key)
    if (previous === undefined) return
    const from = previous.model === null ? '' : choiceIdentity(previous.model)
    const stopped = previous.session.stop()
    if (stopped.remaining) throw new SessionStuck(previous.session.pid)

    this.entries.delete(key)
    this.hooks.onModelSwitch?.(from, choiceIdentity(model), previous.session.pid)

    const session = await this.withBoot(async () => {
      this.settings.set(model)
      return this.open(projectDir)
    })
    this.entries.set(key, { session, model, continueRef: null })
  }

  /**
   * Reprend une AUTRE conversation du projet dans CETTE session : la CLI ne
   * change pas de fil à chaud, il faut donc la relancer avec `--continue <ref>`
   * (mesuré en S13). La conversation remplacée n'est pas perdue : son dossier
   * `chats/` reste.
   */
  private async switchConversation(key: string, projectDir: string, continueRef: string): Promise<void> {
    const previous = this.entries.get(key)
    if (previous === undefined) return
    const stopped = previous.session.stop()
    if (stopped.remaining) throw new SessionStuck(previous.session.pid)

    this.entries.delete(key)

    const session = await this.withBoot(async () => this.open(projectDir, continueRef))
    this.hooks.onResume?.(continueRef, session.pid)
    this.entries.set(key, { session, model: previous.model, continueRef })
  }

  /** Une seule écriture de `settings.json` + lancement à la fois, tous projets. */
  private withBoot<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.boot.then(fn)
    this.boot = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
