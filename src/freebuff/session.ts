/**
 * Une session Freebuff, gardée OUVERTE.
 *
 * C'est la règle du produit, et elle vient du quota : une session ouverte
 * dure une heure de quota et accepte autant de messages qu'on veut dedans.
 * Fermer la TUI pour chaque message gaspille cet heure — et un redémarrage
 * peut tomber sur une limite de sessions. Donc on démarre la CLI UNE fois,
 * et chaque message d'OpenWebUI devient un tour de la même session.
 *
 * Conséquence assumée : la CLI garde son propre fil. Le pont n'envoie que le
 * dernier message de l'utilisateur, pas l'historique d'OpenWebUI, sinon le
 * contexte serait dupliqué à chaque tour.
 *
 * Ce que ce fichier ne fait pas :
 * - il ne change pas de modèle (le `/model` de la TUI n'est pas piloté ici ;
 *   `SessionHost` ferme et rouvre la session quand le modèle demandé change) ;
 * - il ne répond PAS tout seul aux questions de l'agent : il les remonte à
 *   OpenWebUI (`finish: 'question'`) et transmet la réponse suivante au
 *   clavier de la TUI (`ask.ts`) ;
 * - il ne tue jamais la session de lui-même : `stop()` est explicite (bouton ou
 *   déconnexion SSE) et tue l'arbre de processus, pas seulement la TUI.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as pty from 'node-pty'
import { config } from '../config.ts'
import { chatUsers, claimForPrompt, claimForSend, sentAnySince } from './chats.ts'
import { killTree } from './kill.ts'
import { resolveFreebuffBin } from './profiles.ts'
import { waitExpired } from './turn-wait.ts'
import {
  REFUSAL_MESSAGES,
  ScreenBuffer,
  classifyRefusal,
  parseQuota,
  parseSessionLeft,
  quotaMatchCount,
  type QuotaView,
  type RefusalCode,
} from './screen.ts'

import {
  SUBMIT_KEYS,
  askPanelFromScreen,
  askPanelVisible,
  customOptionIndex,
  keyTokens,
  keysForMultiNext,
  keysForSelection,
  panelTop,
  settledPanel,
  optionIndexFor,
  optionKeys,
  renderQuestion,
  sameQuestion,
  selectionFor,
  type AskPanel,
} from './ask.ts'
import {
  EMPTY_STREAM,
  advanceStream,
  answerFromScreen,
  panelPreamble,
  uncoveredScreenText,
  type StreamState,
} from './stream.ts'
import { ScreenView } from './vt.ts'
import {
  cliFailure,
  parseTranscript,
  promptFinishedSince,
  sanitizePrompt,
  stepsMarkdown,
  turnComplete,
  turnMarkdown,
  turnSteps,
  type CliFailure,
  type FollowupUrl,
  type TranscriptEntry,
} from './transcript.ts'

/** Options d'un tour qui ne concernent pas la CLI elle-même. */
export interface TurnOptions {
  /** Construit le lien d'une suggestion de suite ; absent = aucun lien. */
  followupUrl?: FollowupUrl | null
}

export interface SessionOptions {
  /** Dossier de travail de la CLI : le projet sur lequel l'agent travaille. */
  projectDir: string
  /** Profil Freebuff (`FREEBUFF_CONFIG_DIR`). Un seul profil, jamais de rotation. */
  profileDir?: string
  bin?: string
  /** Arguments du binaire — servent à lancer une fausse CLI dans les tests. */
  args?: string[]
  /** Attente du démarrage de la TUI avant de conclure à un refus. */
  bootMs?: number
  /**
   * Reprendre cette conversation (`--continue <ref>`) au lieu d'en ouvrir une
   * neuve. Mesuré en S13 : la CLI recharge bien l'historique visé, et crée un
   * nouveau dossier de chat au passage — l'ancien reste intact.
   */
  continueRef?: string
}

/** `question` : l'agent attend une réponse à un panneau `ask-user`. */
export type TurnFinish =
  | 'ok'
  | 'question'
  | 'timeout'
  | 'refused'
  | 'not_accepted'
  | 'died'
  | 'stopped'
  /** La session gratuite est terminée (`waiting_room_required`, HTTP 428). */
  | 'session_ended'

export interface TurnResult {
  text: string
  /**
   * Étapes écrites AVANT la question (`finish: 'question'`), sans la question
   * elle-même. La carte native ne porte que la question : ce préambule part
   * comme contenu du message, sinon il était perdu (vu en réel le 23/10).
   */
  head?: string
  /** Réflexion de l'agent, séparée de `text` pour OpenWebUI. */
  reasoning: string
  finish: TurnFinish
  refusal: RefusalCode | null
  /** Erreur terminale lue dans `run-state.json` pour ce tour, s'il y en a une. */
  failure?: CliFailure | null
  /**
   * Panneau `ask-user` quand `finish === 'question'` : le pont en fait la carte
   * native d'OpenWebUI (options, descriptions) au lieu d'un simple texte.
   */
  panel?: AskPanel | null
}

/**
 * Dernier compte à rebours lu sur le pied de la TUI.
 *
 * `at` date la LECTURE : entre deux écritures de la CLI, la valeur baisse
 * encore d'elle-même, et c'est à l'appelant de décider s'il l'extrapole.
 * `totalMinutes` est la première valeur vue : elle donne l'échelle de la barre
 * sans supposer une durée de session (aucune n'est annoncée par la CLI).
 */
export interface SessionLeftReading {
  minutes: number
  totalMinutes: number
  at: number
}

/** Résultat d'un arrêt : `remaining` nomme un processus qui a survécu. */
export interface StopResult {
  ok: boolean
  remaining: boolean
}

/** Ce que le pont a besoin de savoir d'une session — pour les tests sans PTY. */
export interface AgentSession {
  readonly pid: number
  readonly alive: boolean
  readonly chatRef: string | null
  /** Dossier sur lequel la CLI a été lancée — impossible à changer à chaud. */
  readonly projectDir: string
  /** Quota lu sur le bandeau de la TUI, quand la session en montre un. */
  readonly quota?: QuotaView
  /** Compte à rebours de la session, une fois que la TUI en a affiché un. */
  readonly sessionLeft?: SessionLeftReading | null
  /** Relit le quota du compte dans la TUI (`/model`) ; absent = pas de relance. */
  refreshQuota?(): Promise<QuotaView | null>
  send(
    prompt: string,
    onDelta: (text: string) => void,
    onReasoning?: (text: string) => void,
    options?: TurnOptions,
  ): Promise<TurnResult>
  stop(): StopResult
}

export class SessionRefused extends Error {
  readonly code: RefusalCode

  constructor(code: RefusalCode) {
    super(REFUSAL_MESSAGES[code])
    this.name = 'SessionRefused'
    this.code = code
  }
}

const POLL_MS = 200
const SUBMIT_GAP_MS = 900
/**
 * Entre deux gestes du panneau : écrites d'un trait, `↓` puis `Entrée`
 * répondent à l'option SURVOLÉE avant le déplacement (mesuré en S9).
 */
const KEY_GAP_MS = 250
/** Attente du bilan après `/model` : le panneau doit s'ouvrir et le lire. */
const QUOTA_PANEL_MS = 12_000
const ACCEPT_WINDOW_MS = 20_000
const MAX_WRITES = 2
/**
 * Silence exigé avant d'envoyer `Entrée`.
 *
 * Mesure du 2026-10-23 (20 h) : la TUI digère maintenant un long collage en
 * plusieurs secondes et un `\r` reçu pendant cette digestion est PERDU. Un
 * prompt de 7,5 Ko écrit puis soumis 900 ms plus tard n'a produit aucun
 * `[send-message]` (deux écritures, 42 s d'attente, tour rendu `not_accepted`) ;
 * le même prompt soumis après 6 s est parti.
 */
const QUIET_MS = 400
/** Attente maximale de ce silence : au-delà, on soumet quand même. */
const SETTLE_MAX_MS = 6_000
/**
 * Délai laissé au transcript après « Main prompt finished » : la CLI écrit son
 * état juste après ce repère. Au-delà, c'est que le fichier n'a pas pu être
 * réécrit (rename EPERM sous Windows) et l'écran reste la seule source.
 */
const TRANSCRIPT_GRACE_MS = 3_000

/** Ce qui s'affiche quand la fin du tour est prouvée mais pas sa réponse. */
const MISSING_TRANSCRIPT_NOTICE =
  '_(tour terminé, mais la réponse n’a pas pu être relue : Freebuff n’a pas écrit son transcript — renvoie la question)_'
/**
 * Taille du PTY.
 *
 * La hauteur n'est pas cosmétique : le flux progressif s'ancre sur l'écho de la
 * consigne, et cet écho sort du tampon dès que la réponse remplit l'écran. Une
 * fenêtre haute garde l'ancre visible pendant toute une réponse normale.
 */
const PTY_COLS = 120
const PTY_ROWS = 200

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Noms des dossiers de chat d'un projet, ou l'ensemble vide s'il n'existe pas. */
function dirsOf(root: string): Set<string> {
  try {
    return new Set(fs.readdirSync(root))
  } catch {
    return new Set()
  }
}

export class FreebuffSession implements AgentSession {
  private readonly term: pty.IPty
  private readonly screen = new ScreenBuffer()
  /** La MÊME image que la TUI, pour un flux progressif (voir `stream.ts`). */
  private readonly view = new ScreenView(PTY_COLS, PTY_ROWS)
  private readonly chatRoot: string
  /**
   * Dossier que la CLI a ouvert à SON démarrage, avant toute consigne.
   *
   * Il n'est pas exposé (`chatRef` reste `null` tant qu'aucun prompt n'est
   * accepté, c'est ce qui déclenche la reprise du fil). Il évite de balayer
   * les journaux de tous les autres chats à chaque vérification.
   */
  private chatBootDir: string | null = null
  private chatDir: string | null = null
  /** Dernière lecture du transcript, clé `mtime:taille` (voir `readDir`). */
  private lastRead: { dir: string; key: string; entries: TranscriptEntry[] } | null = null
  private exited = false
  private stopping = false
  /**
   * Panneau `ask-user` affiché et pas encore rempli : tant qu'il est là, un
   * message utilisateur est une RÉPONSE (des touches), jamais une consigne —
   * écrire du texte dans la zone de saisie d'un panneau ouvert le corromprait.
   */
  private pending: { panel: AskPanel; prompt: string } | null = null
  /**
   * Lien des suggestions de suite, fixé pour le tour en cours : il dépend du
   * chat et doit rendre la même URL à chaque relecture du transcript.
   */
  private followupUrl: FollowupUrl | null = null
  /** Dernier compte à rebours de session vu dans le pied de la TUI. */
  private left: SessionLeftReading | null = null
  /** Dernière sortie de la TUI : sert à attendre qu'elle digère la consigne. */
  private lastOutputAt = 0
  readonly projectDir: string

  private constructor(term: pty.IPty, chatRoot: string, projectDir: string) {
    this.term = term
    this.chatRoot = chatRoot
    this.projectDir = projectDir
    term.onData(chunk => {
      this.screen.push(chunk)
      this.view.write(chunk)
      this.trackSessionLeft(chunk)
      this.lastOutputAt = Date.now()
    })
    term.onExit(() => {
      this.exited = true
    })
  }

  /**
   * Démarre la TUI et REFUSE d'aller plus loin si elle affiche un refus.
   * Un refus coûte zéro tour : c'est le moment le moins cher pour s'arrêter.
   */
  static async start(options: SessionOptions): Promise<FreebuffSession> {
    const projectDir = path.resolve(options.projectDir)
    const profileDir =
      options.profileDir ?? process.env.FREEBUFF_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'freebuff')
    // Le binaire vit dans le dossier du profil : un profil nommé autrement
    // n'a plus besoin qu'on devine son nom (`FREEBUFF_BIN` reste prioritaire).
    const bin = options.bin ?? resolveFreebuffBin(profileDir)

    if (!fs.existsSync(bin)) throw new Error(`binaire Freebuff introuvable : ${bin}`)
    fs.mkdirSync(projectDir, { recursive: true })

    const args = [...(options.args ?? []), ...(options.continueRef ? ['--continue', options.continueRef] : [])]
    const chatRoot = path.join(profileDir, 'projects', path.basename(projectDir), 'chats')
    const known = dirsOf(chatRoot)

    const term = pty.spawn(bin, args, {
      name: 'xterm-256color',
      cols: PTY_COLS,
      rows: PTY_ROWS,
      cwd: projectDir,
      env: { ...process.env, TERM: 'xterm-256color', FREEBUFF_CONFIG_DIR: profileDir },
    })

    const session = new FreebuffSession(term, chatRoot, projectDir)

    await sleep(options.bootMs ?? 12_000)

    // Le dossier de chat de CETTE session est celui qui vient d'apparaître au
    // démarrage. S'il n'y en a qu'un, on le tient : l'acceptation n'a plus à
    // deviner, ni à parcourir les journaux des autres chats (une copie du
    // projet peut en avoir de très gros).
    const fresh = [...dirsOf(chatRoot)].filter(name => !known.has(name))
    if (fresh.length === 1 && fresh[0] !== undefined) session.chatBootDir = path.join(chatRoot, fresh[0])

    const refusal = classifyRefusal(session.screen.value)
    if (refusal) {
      session.stop()
      throw new SessionRefused(refusal)
    }

    return session
  }

  get pid(): number {
    return this.term.pid
  }

  get alive(): boolean {
    return !this.exited
  }

  get chatRef(): string | null {
    return this.chatDir === null ? null : path.basename(this.chatDir)
  }

  /** Bandeau de la TUI : « 3/12 hours remaining ». Aucun prompt n'est écrit. */
  get quota(): QuotaView {
    return parseQuota(this.screen.value)
  }

  /**
   * Relit le quota du compte en ouvrant `/model` dans la TUI, puis referme.
   *
   * Le bandeau d'ouverture ne bouge plus : il donne la valeur du démarrage, et
   * une session qui a consommé des heures continuait donc à afficher celle
   * d'il y a une heure. Le pied du panneau `/model` écrit le bilan courant
   * (`3/12 hours daily · resets in …`). Aucun tour n'est envoyé, aucun modèle
   * n'est choisi : on attend une ligne de quota NOUVELLE, puis `Esc` ferme le
   * panneau — sans panneau ouvert et sans tour en cours, il ne fait rien.
   */
  async refreshQuota(): Promise<QuotaView | null> {
    if (!this.alive || this.stopping || this.pending !== null) return null

    const before = quotaMatchCount(this.screen.value)
    this.term.write('/model')
    await sleep(SUBMIT_GAP_MS)
    this.term.write('\r')

    let view: QuotaView | null = null
    const deadline = Date.now() + QUOTA_PANEL_MS
    while (Date.now() < deadline) {
      await sleep(POLL_MS)
      if (!this.alive) return null
      if (quotaMatchCount(this.screen.value) > before) {
        view = parseQuota(this.screen.value)
        break
      }
    }

    // Deux `Esc` : le second ne sert que si le premier n'a fermé qu'un
    // sous-panneau (raisonnement). Sans panneau ouvert et sans tour en cours,
    // `Esc` ne fait rien — et ici aucun tour ne peut tourner : la file du
    // projet n'accorde `useExisting` qu'entre deux tours.
    this.term.write('\x1b')
    await sleep(KEY_GAP_MS)
    this.term.write('\x1b')
    await sleep(KEY_GAP_MS)
    return view?.found === true ? view : null
  }

  /**
   * Garde le DERNIER compte à rebours vu.
   *
   * Il ne faut pas le relire dans le tampon à la demande : pendant un long
   * tour, la TUI défile et le pied sort des 32 Ko gardés. On ne scanne donc que
   * les morceaux qui peuvent en contenir un, et on retient la dernière valeur.
   */
  private trackSessionLeft(chunk: string): void {
    if (!chunk.includes('left')) return
    const found = parseSessionLeft(this.screen.value.slice(-2_000))
    if (found.minutes === null) return
    this.left = {
      minutes: found.minutes,
      totalMinutes: this.left === null ? found.minutes : Math.max(this.left.totalMinutes, found.minutes),
      at: Date.now(),
    }
  }

  get sessionLeft(): SessionLeftReading | null {
    return this.left
  }

  /** La TUI est laissée vivante jusqu'à un arrêt explicite. */
  stop(): StopResult {
    this.stopping = true
    // L'arbre d'abord : une fois le parent mort, `taskkill /T` ne sait plus
    // quels enfants lui appartenaient.
    const killed = killTree(this.term.pid)
    try {
      this.term.kill()
    } catch {
      // ConPTY peut lever (« AttachConsole failed ») sur un processus déjà
      // terminé : l'arrêt a eu lieu, l'exception ne doit pas tuer le pont.
    }
    this.exited = true
    return { ok: killed.ok, remaining: killed.remaining }
  }

  async send(
    prompt: string,
    onDelta: (text: string) => void,
    onReasoning: (text: string) => void = () => {},
    options: TurnOptions = {},
  ): Promise<TurnResult> {
    // Le lien des suggestions ne dure que le temps d'un tour : il porte le chat
    // de CE tour et un horodatage figé (le flux et le rendu final doivent
    // produire exactement la même URL).
    this.followupUrl = options.followupUrl ?? null
    const text = sanitizePrompt(prompt)
    if (!this.alive) {
      return { text: '', reasoning: '', finish: this.stopping ? 'stopped' : 'died', refusal: null }
    }
    if (!text) return { text: '', reasoning: '', finish: 'not_accepted', refusal: null }

    // Un panneau ouvert AVANT tout : le message est la réponse à la question,
    // pas une nouvelle consigne.
    if (this.pending !== null) return this.answer(text, onDelta, onReasoning)

    const refusal = classifyRefusal(this.screen.value)
    if (refusal) return { text: '', reasoning: '', finish: 'refused', refusal }

    // Le dossier est reconnu par la CONSIGNE écrite, plus par « le plus
    // récent » : deux conversations liées au même dossier ont chacune leur CLI
    // et écrivent côte à côte dans `chats/`.
    const started = Date.now()
    const before = this.chatDir === null ? 0 : chatUsers(this.chatDir).users
    let accepted = false

    for (let attempt = 0; attempt < MAX_WRITES && !accepted; attempt++) {
      // La TUI redessine son écran : on écrit le prompt, on laisse la saisie se
      // stabiliser, puis on soumet. Écrire la consigne et `\r` d'un coup fait
      // perdre la fin du texte — et soumettre pendant que la TUI digère un long
      // collage perd le `\r` (voir QUIET_MS).
      if (attempt === 0) {
        this.term.write(text)
        await this.settle()
      } else {
        // La consigne est déjà dans la saisie : un second `\r` suffit, et la
        // réécrire enverrait la consigne en double (mesuré le 23/10).
        await sleep(SUBMIT_GAP_MS)
      }
      this.term.write('\r')

      const until = Date.now() + ACCEPT_WINDOW_MS
      while (Date.now() < until) {
        await sleep(POLL_MS)
        if (!this.alive) {
          return { text: '', reasoning: '', finish: this.stopping ? 'stopped' : 'died', refusal: null }
        }
        const dir = this.claimDir(text, started, before)
        if (dir !== null) {
          this.chatDir = dir
          accepted = true
          break
        }
        const shown = classifyRefusal(this.screen.value)
        if (shown) return { text: '', reasoning: '', finish: 'refused', refusal: shown }
      }
    }

    if (!accepted) return { text: '', reasoning: '', finish: 'not_accepted', refusal: null }

    return this.pollTurn(text, Date.now() + config.turnTimeoutMs, onDelta, onReasoning)
  }

  /**
   * Attend que la TUI ait fini de digérer la consigne écrite.
   *
   * On ne peut pas se fier à une durée fixe : 7,5 Ko de contexte demandent
   * quelques secondes de rendu, et le `\r` envoyé avant la fin est ignoré. On
   * attend donc que l'écran se taise (sans dépasser SETTLE_MAX_MS, pour qu'une
   * animation de la TUI ne bloque pas le tour).
   */
  private async settle(): Promise<void> {
    const started = Date.now()
    const earliest = started + SUBMIT_GAP_MS
    const deadline = started + SETTLE_MAX_MS
    for (;;) {
      await sleep(POLL_MS)
      const now = Date.now()
      if (now >= earliest && now - this.lastOutputAt >= QUIET_MS) return
      if (now >= deadline) return
    }
  }

  /**
   * Répond au panneau `ask-user` affiché, puis reprend le tour qui l'attendait.
   *
   * Mesuré en S9 : `↓`×n puis `Entrée` choisissent la n-ième option, et c'est
   * `Tab` + `Entrée` qui valident le panneau. Une réponse hors des options ne
   * déclenche RIEN : on repose la question au lieu d'inventer un choix.
   */
  private async answer(
    message: string,
    onDelta: (text: string) => void,
    onReasoning: (text: string) => void,
  ): Promise<TurnResult> {
    const pending = this.pending
    if (pending === null) return { text: '', reasoning: '', finish: 'not_accepted', refusal: null }

    // Plusieurs questions : le pont ne sait piloter qu'une question à la fois.
    // On le dit, et on ne touche PAS au panneau.
    if (pending.panel.complex) {
      return {
        text: renderQuestion(pending.panel),
        reasoning: '',
        finish: 'question',
        refusal: null,
        panel: pending.panel,
      }
    }

    // Liste à cases cochées : plusieurs choix dans un seul message, puis
    // `Tab` + `Entrée` pour valider. Un élément inconnu ne coche RIEN.
    if (pending.panel.multi === true) {
      const selection = selectionFor(message, pending.panel)
      if (selection === null) {
        return {
          text: renderQuestion(pending.panel),
          reasoning: '',
          finish: 'question',
          refusal: null,
          panel: pending.panel,
        }
      }
      // Panneau à plusieurs questions : valider tout de suite enverrait une
      // réponse incomplète (mesuré en S10 — la CLI accepte les questions
      // laissées vides). On ouvre donc la suivante et on attend sa carte ;
      // seule la dernière question se valide.
      const step = pending.panel.step
      if (step !== undefined && step.index + 1 < step.total) {
        return this.checkThenNext(pending, selection, onDelta, onReasoning)
      }
      return this.press(pending, keysForSelection(selection), onDelta, onReasoning)
    }

    const index = optionIndexFor(message, pending.panel)
    if (index === null) {
      // Réponse libre : la TUI a une ligne « Custom » qui ouvre son propre
      // champ. Sans elle, aucune option ne correspond et reposer la question
      // bouclait (vu en réel le 23/10, carte « Other » d'OpenWebUI).
      if (customOptionIndex(pending.panel) !== null) {
        return this.answerCustom(pending, message, onDelta, onReasoning)
      }
      return {
        text: renderQuestion(pending.panel),
        reasoning: '',
        finish: 'question',
        refusal: null,
        panel: pending.panel,
      }
    }

    return this.respond(pending, index, onDelta, onReasoning)
  }

  /**
   * Choisit une option, puis :
   * - si le panneau pose d'autres questions, la suivante s'ouvre et on la
   *   remonte à OpenWebUI (une carte par question, même tour CLI) ;
   * - sinon, `Tab` + `Entrée` valident et le tour reprend.
   */
  private async respond(
    pending: { panel: AskPanel; prompt: string },
    index: number,
    onDelta: (text: string) => void,
    onReasoning: (text: string) => void,
  ): Promise<TurnResult> {
    // Le panneau a pu être rempli directement dans la CLI entre-temps : les
    // touches partiraient alors dans la zone de saisie d'un tour déjà repris.
    await this.view.flush()
    if (askPanelFromScreen(this.view.lines()) === null) {
      this.pending = null
      return this.pollTurn(pending.prompt, Date.now() + config.turnTimeoutMs, onDelta, onReasoning)
    }

    this.pending = null
    await this.typeKeys(optionKeys(index))

    // La TUI redessine : la question répondue se plie, la suivante s'ouvre.
    // Seule une autre question à remplir mérite un aller-retour de plus.
    const step = pending.panel.step
    const carriesOn = step !== undefined && step.index + 1 < step.total
    const until = Date.now() + (carriesOn ? 3_000 : POLL_MS)
    let next: AskPanel | null = null
    let visible = true
    while (Date.now() < until) {
      await sleep(POLL_MS)
      await this.view.flush()
      const rows = this.view.lines()
      visible = askPanelVisible(rows)
      if (!visible) break
      if (askPanelFromScreen(rows) !== null) {
        const panel = await settledPanel(() => this.readPanel(), sleep)
        // Le panneau relu est le plus souvent CELUI qu'on vient de répondre :
        // la TUI le garde affiché jusqu'à `Submit`. Le prendre pour une
        // question suivante reposait la même carte sans fin (vu en réel le
        // 23/10). Seule une question VRAIMENT différente mérite un aller-retour.
        if (panel !== null && !sameQuestion(pending.panel, panel)) {
          next = panel
          break
        }
      }
    }

    if (next !== null) {
      this.pending = { panel: next, prompt: pending.prompt }
      return {
        text: renderQuestion(next),
        reasoning: '',
        finish: 'question',
        refusal: null,
        panel: next,
      }
    }

    // D'autres questions restent à remplir : `Tab` + `Entrée` les validerait
    // vides (mesuré en S10). On repose celle-ci, sans rien presser.
    if (carriesOn) {
      this.pending = pending
      return {
        text: renderQuestion(pending.panel),
        reasoning: '',
        finish: 'question',
        refusal: null,
        panel: pending.panel,
      }
    }

    // Tout est répondu : `Tab` + `Entrée` pressent `Submit`.
    if (visible) await this.typeKeys(SUBMIT_KEYS)
    const closed = Date.now() + 8_000
    while (Date.now() < closed) {
      await sleep(POLL_MS)
      await this.view.flush()
      if (!askPanelVisible(this.view.lines())) break
    }

    return this.pollTurn(pending.prompt, Date.now() + config.turnTimeoutMs, onDelta, onReasoning)
  }

  /**
   * Répond par une valeur LIBRE, via la ligne « Custom » du panneau.
   *
   * Mesuré : « Custom » n'est pas un choix, il ouvre le champ de saisie de la
   * CLI. On descend donc jusqu'à lui (`↓`×n + `Entrée`), on écrit la réponse
   * sur une seule ligne, puis on valide — `Entrée` d'abord, `Tab` + `Entrée`
   * si le panneau est encore là (c'est `Submit` qui le ferme).
   */
  private async answerCustom(
    pending: { panel: AskPanel; prompt: string },
    text: string,
    onDelta: (text: string) => void,
    onReasoning: (text: string) => void,
  ): Promise<TurnResult> {
    const custom = customOptionIndex(pending.panel)
    // Une ligne, jamais un `\r` au milieu : il soumettrait le champ trop tôt.
    const typed = text.replace(/\s+/g, ' ').trim()
    if (custom === null || typed === '') {
      return {
        text: renderQuestion(pending.panel),
        reasoning: '',
        finish: 'question',
        refusal: null,
        panel: pending.panel,
      }
    }

    // Le panneau a pu être rempli directement dans la CLI entre-temps.
    await this.view.flush()
    if (askPanelFromScreen(this.view.lines()) === null) {
      this.pending = null
      return this.pollTurn(pending.prompt, Date.now() + config.turnTimeoutMs, onDelta, onReasoning)
    }

    this.pending = null
    await this.typeKeys(optionKeys(custom))
    // Le champ libre s'ouvre après le choix : on lui laisse le temps d'être là
    // avant d'écrire, sinon le texte partirait dans la zone de saisie du chat.
    await sleep(SUBMIT_GAP_MS)
    this.term.write(typed)
    await sleep(SUBMIT_GAP_MS)
    this.term.write('\r')

    // Le champ fermé, la TUI ouvre la question suivante (panneau à plusieurs
    // questions) ou attend `Submit`.
    const step = pending.panel.step
    const carriesOn = step !== undefined && step.index + 1 < step.total
    let next: AskPanel | null = null
    const opened = Date.now() + (carriesOn ? 3_000 : 2_000)
    while (Date.now() < opened) {
      await sleep(POLL_MS)
      await this.view.flush()
      const rows = this.view.lines()
      if (!askPanelVisible(rows)) break
      if (askPanelFromScreen(rows) !== null) {
        const panel = await settledPanel(() => this.readPanel(), sleep)
        if (panel !== null && !sameQuestion(pending.panel, panel)) {
          next = panel
          break
        }
      }
    }

    if (next !== null) {
      this.pending = { panel: next, prompt: pending.prompt }
      return {
        text: renderQuestion(next),
        reasoning: '',
        finish: 'question',
        refusal: null,
        panel: next,
      }
    }

    // D'autres questions restent à remplir : `Tab` + `Entrée` les validerait
    // vides (mesuré en S10). On repose celle-ci, sans rien presser.
    if (carriesOn) {
      this.pending = pending
      return {
        text: renderQuestion(pending.panel),
        reasoning: '',
        finish: 'question',
        refusal: null,
        panel: pending.panel,
      }
    }

    await this.view.flush()
    if (askPanelVisible(this.view.lines())) await this.typeKeys(SUBMIT_KEYS)

    const closed = Date.now() + 8_000
    while (Date.now() < closed) {
      await sleep(POLL_MS)
      await this.view.flush()
      if (!askPanelVisible(this.view.lines())) break
    }

    return this.pollTurn(pending.prompt, Date.now() + config.turnTimeoutMs, onDelta, onReasoning)
  }

  /**
   * Envoie les touches qui remplissent le panneau, attend qu'il se referme,
   * puis reprend le tour qui l'attendait.
   */
  private async press(
    pending: { panel: AskPanel; prompt: string },
    keys: string,
    onDelta: (text: string) => void,
    onReasoning: (text: string) => void,
  ): Promise<TurnResult> {
    // Le panneau a pu être rempli directement dans la CLI entre-temps : les
    // touches partiraient alors dans la zone de saisie d'un tour déjà repris.
    await this.view.flush()
    if (askPanelFromScreen(this.view.lines()) === null) {
      this.pending = null
      return this.pollTurn(pending.prompt, Date.now() + config.turnTimeoutMs, onDelta, onReasoning)
    }

    this.pending = null
    await this.typeKeys(keys)

    // Le panneau se referme quand la CLI a pris la réponse : on attend qu'il
    // disparaisse avant de relire l'écran, sinon le tour reprendrait sur une
    // image encore occupée par la question.
    const closed = Date.now() + 8_000
    while (Date.now() < closed) {
      await sleep(POLL_MS)
      await this.view.flush()
      if (askPanelFromScreen(this.view.lines()) === null) break
    }

    return this.pollTurn(pending.prompt, Date.now() + config.turnTimeoutMs, onDelta, onReasoning)
  }

  /**
   * Remplit les cases d'une question intermédiaire, puis ouvre la suivante.
   *
   * Mesuré en S10 : `↓` au-delà de la dernière ligne déplie la question
   * suivante. On ne presse jamais `Tab` + `Entrée` ici : la CLI validerait le
   * panneau entier, questions vides comprises.
   */
  private async checkThenNext(
    pending: { panel: AskPanel; prompt: string },
    selection: number[],
    onDelta: (text: string) => void,
    onReasoning: (text: string) => void,
  ): Promise<TurnResult> {
    // Le panneau a pu être rempli directement dans la CLI entre-temps.
    await this.view.flush()
    if (askPanelFromScreen(this.view.lines()) === null) {
      this.pending = null
      return this.pollTurn(pending.prompt, Date.now() + config.turnTimeoutMs, onDelta, onReasoning)
    }

    this.pending = null
    await this.typeKeys(keysForMultiNext(selection, pending.panel))

    const until = Date.now() + 3_000
    let next: AskPanel | null = null
    while (Date.now() < until) {
      await sleep(POLL_MS)
      await this.view.flush()
      if (askPanelFromScreen(this.view.lines()) !== null) {
        next = await settledPanel(() => this.readPanel(), sleep)
        if (next !== null) break
      }
    }

    if (next !== null) {
      this.pending = { panel: next, prompt: pending.prompt }
      return {
        text: renderQuestion(next),
        reasoning: '',
        finish: 'question',
        refusal: null,
        panel: next,
      }
    }

    // La question suivante ne s'est pas ouverte : on repose la même, sans rien
    // valider. Valider ici enverrait à l'agent une réponse incomplète.
    this.pending = pending
    return {
      text: renderQuestion(pending.panel),
      reasoning: '',
      finish: 'question',
      refusal: null,
      panel: pending.panel,
    }
  }

  /** Lecture rafraîchie du panneau visible. */
  private async readPanel(): Promise<AskPanel | null> {
    await this.view.flush()
    return askPanelFromScreen(this.view.lines())
  }

  /**
   * Tape une suite de touches GESTE PAR GESTE : la TUI a besoin de redessiner
   * entre deux (`↓` puis `Entrée` d'un seul coup = mauvaise option).
   */
  private async typeKeys(keys: string): Promise<void> {
    for (const token of keyTokens(keys)) {
      if (!this.alive) return
      this.term.write(token)
      await sleep(KEY_GAP_MS)
    }
  }

  /**
   * Attend la fin du tour en livrant les ÉTAPES au fur et à mesure.
   *
   * La source du MESSAGE est le transcript : lui seul porte l'ordre réel
   * réflexion → outil → réflexion → réponse, et le regroupement « Travail ».
   * Il n'écrit malheureusement un bloc qu'une fois TERMINÉ (mesuré le 23/10),
   * d'où des silences de plusieurs secondes pendant qu'une longue réponse
   * s'écrit.
   *
   * D'où le second canal : l'écran de la TUI, lui, se remplit toutes les ~200 ms.
   * Son texte part en `reasoning_content` (zone « réflexion » d'OWUI, à part du
   * message), donc le message final garde son ordre et son markdown intacts.
   */
  private async pollTurn(
    text: string,
    deadline: number,
    onDelta: (text: string) => void,
    onReasoning: (text: string) => void,
  ): Promise<TurnResult> {
    const started = Date.now()
    /** Markdown déjà envoyé : tout delta doit le prolonger. */
    let emitted = ''
    /** Texte déjà poussé en direct depuis l'écran (canal « réflexion »). */
    let live: StreamState = EMPTY_STREAM
    /** Date à laquelle la CLI a dit avoir fini, si le transcript n'a pas suivi. */
    let finishedInLog: number | null = null
    /** Dernière écriture observée (transcript ou journal) : preuve de vie. */
    let lastProgress = Date.now()
    let lastMark = ''

    /**
     * Erreur terminale de CE tour seulement : `run-state.json` garde aussi
     * l'erreur du tour précédent, donc un fichier plus ancien que le départ du
     * tour est ignoré. Lecture mise en cache sur `mtime:taille` : le fichier
     * est consulté à chaque poll, pas rouvert quand il n'a pas bougé.
     */
    let failureMark = ''
    let failureRead: CliFailure | null = null
    const readFailureNow = (): CliFailure | null => {
      if (this.chatDir === null) return null
      try {
        const file = path.join(this.chatDir, 'run-state.json')
        const stat = fs.statSync(file)
        if (stat.mtimeMs < started) return null
        const mark = `${String(stat.mtimeMs)}:${String(stat.size)}`
        if (mark !== failureMark) {
          failureMark = mark
          failureRead = cliFailure(fs.readFileSync(file, 'utf8'))
        }
        return failureRead
      } catch {
        return null
      }
    }

    const emitSteps = (entries: TranscriptEntry[], streaming: boolean): void => {
      const markdown = stepsMarkdown(turnSteps(entries), streaming, this.followupUrl)
      if (markdown === '' || !markdown.startsWith(emitted)) return
      if (markdown.length === emitted.length) return
      onDelta(markdown.slice(emitted.length))
      emitted = markdown
    }

    /** Rendu final : étapes fermées, plus l'erreur terminale de la CLI s'il y en a une. */
    const render = (entries: TranscriptEntry[], finish: TurnFinish): TurnResult => {
      emitSteps(entries, false)
      const markdown = stepsMarkdown(turnSteps(entries), false, this.followupUrl)
      const failure = readFailureNow()
      // `waiting_room_required` n'est pas une erreur comme les autres : la
      // session gratuite est finie, et le pont proposera de continuer.
      const final: TurnFinish = failure?.code === 'waiting_room_required' ? 'session_ended' : finish
      if (failure === null) return { text: markdown, reasoning: '', finish: final, refusal: null, failure: null }
      const code = failure.code === null ? '' : ` (${failure.code}${failure.status === null ? '' : ` ${String(failure.status)}`})`
      const notice =
        final === 'session_ended'
          ? `> ⏳ **Session gratuite terminée.** ${failure.message}${code}`
          : `> ⚠️ ${failure.message}${code}`
      return {
        text: markdown === '' ? notice : `${markdown}\n\n${notice}`,
        reasoning: '',
        finish: final,
        refusal: null,
        failure,
      }
    }

    while (Date.now() < deadline) {
      await sleep(POLL_MS)
      if (!this.alive) return render(this.read(), this.stopping ? 'stopped' : 'died')

      // Débit fin : ce que la TUI affiche à l'instant. Une image encore instable
      // (texte que la TUI redessine) n'ajoute rien — `advanceStream` n'émet que
      // le préfixe stable, puisque le protocole OpenAI ne sait qu'ajouter.
      await this.view.flush()
      // La ligne en cours est incluse (`live`) : sinon le texte n'avance que
      // d'une ligne pleine à la fois, soit un morceau toutes les 0,5 à 1,5 s.
      const advance = advanceStream(live, answerFromScreen(this.view.lines(), text, false, true))
      live = advance.state
      if (advance.delta !== '') onReasoning(advance.delta)

      // Refus immédiat de la CLI (session gratuite terminée) : inutile
      // d'attendre le transcript ou l'inactivité pour le dire.
      if (readFailureNow()?.code === 'waiting_room_required') {
        return render(this.read(), 'session_ended')
      }

      // L'agent attend une réponse : on la remonte à OpenWebUI au lieu de
      // laisser le tour expirer. Le message suivant sera converti en touches.
      if (this.pending === null) {
        const quick = await this.readPanel()
        if (quick !== null) {
          // La TUI peint le panneau en plusieurs frames : une lecture trop tôt
          // ne voit qu'une option et ferait partir le texte au lieu de la carte.
          // Sans image stable (moins de deux options), on laisse le tour
          // continuer à interroger l'écran plutôt que d'envoyer du faux.
          const panel = await settledPanel(() => this.readPanel(), sleep)
          if (panel === null) continue
          this.pending = { panel, prompt: text }
          // La question arrive après le texte : on ferme les étapes ouvertes
          // pour qu'elle ne tombe pas dans la dernière réflexion.
          const entries = this.read()
          emitSteps(entries, false)
          const head = stepsMarkdown(turnSteps(entries), false, this.followupUrl)
          // Le texte écrit JUSTE AVANT la question n'est pas dans le transcript :
          // la CLI ne l'écrit qu'une fois le message terminé, donc après la
          // réponse (mesuré le 23/10 : 25 min après l'ouverture du panneau, il
          // manquait toujours). L'écran, lui, l'affiche déjà — c'est la seule
          // source à cet instant. On ne garde que ce qui n'est pas déjà parti.
          await this.view.flush()
          const rows = this.view.lines()
          const top = panelTop(rows)
          const shown = panelPreamble(top === -1 ? rows : rows.slice(0, top), text)
          const preamble = shown.trim() === '' ? '' : uncoveredScreenText(head, shown)
          const withHead = preamble === '' ? head : head === '' ? preamble : `${head}\n\n${preamble}`
          return {
            text: withHead === '' ? renderQuestion(panel) : `${withHead}\n\n${renderQuestion(panel)}`,
            head: withHead,
            reasoning: '',
            finish: 'question',
            refusal: null,
            panel,
          }
        }
      }

      const entries = this.read()
      emitSteps(entries, true)

      if (turnComplete(entries)) {
        // Le dernier bloc peut être écrit quelques dizaines de millisecondes
        // après `isComplete` : une courte attente évite de le couper.
        await sleep(POLL_MS)
        return render(this.read(), 'ok')
      }

      // Preuve de vie : chaque étape écrite repousse l'échéance d'inactivité.
      // Un agent qui travaille 40 minutes n'est donc jamais coupé, alors qu'un
      // tour coupé par la CLI est rendu après `turnIdleMs`, sans marqueur.
      const mark = `${String(entries.length)}:${String((entries.at(-1)?.blocks ?? []).length)}:${String(this.logSize())}`
      if (mark !== lastMark) {
        lastMark = mark
        lastProgress = Date.now()
      }

      // Filet : la CLI a fini son prompt mais le transcript n'a pas été réécrit
      // (rename `EPERM` sous Windows). Sans ça, le pont attendrait son délai et
      // OpenWebUI garderait « Freebuff travaille… » pour toujours.
      if (finishedInLog === null && this.logSaysFinished(started)) finishedInLog = Date.now()
      if (finishedInLog !== null && Date.now() - finishedInLog > TRANSCRIPT_GRACE_MS) {
        const done = render(this.read(), 'ok')
        return done.text === '' ? { ...done, text: MISSING_TRANSCRIPT_NOTICE } : done
      }

      if (
        waitExpired({
          now: Date.now(),
          deadline,
          lastProgress,
          idleMs: config.turnIdleMs,
        }) !== null
      ) {
        return render(this.read(), 'timeout')
      }
    }

    return render(this.read(), 'timeout')
  }

  private read(): TranscriptEntry[] {
    // Jamais de repli sur « le dossier le plus récent du projet » : avec deux
    // CLI dans le même dossier, ce serait lire la conversation de l'autre.
    return this.chatDir === null ? [] : this.readDir(this.chatDir)
  }

  /**
   * Lecture du transcript, avec cache sur `mtime:taille`.
   *
   * Sous Windows, la CLI réécrit `chat-messages.json` par `rename` et échoue
   * (`EPERM`) si un autre processus a le fichier ouvert à cet instant précis :
   * relire un fichier inchangé toutes les 200 ms multipliait les occasions de
   * la bloquer. Un `stat` suffit à savoir s'il a bougé.
   */
  private readDir(dir: string): TranscriptEntry[] {
    const file = path.join(dir, 'chat-messages.json')
    try {
      const stat = fs.statSync(file)
      const key = `${String(stat.mtimeMs)}:${String(stat.size)}`
      const cached = this.lastRead
      if (cached !== null && cached.dir === dir && cached.key === key) return cached.entries
      const entries = parseTranscript(fs.readFileSync(file, 'utf8')) ?? []
      this.lastRead = { dir, key, entries }
      return entries
    } catch {
      return []
    }
  }

  /** Taille du journal CLI : elle grossit à chaque étape, preuve de vie. */
  private logSize(): number {
    if (this.chatDir === null) return 0
    try {
      return fs.statSync(path.join(this.chatDir, 'log.jsonl')).size
    } catch {
      return 0
    }
  }

  /** Fin du journal CLI, ou `null` si le dossier ou le fichier manque. */
  private logTail(): string | null {
    if (this.chatDir === null) return null
    try {
      const file = path.join(this.chatDir, 'log.jsonl')
      const size = fs.statSync(file).size
      const from = Math.max(0, size - 128 * 1024)
      const buffer = Buffer.alloc(size - from)
      const handle = fs.openSync(file, 'r')
      try {
        fs.readSync(handle, buffer, 0, buffer.length, from)
      } finally {
        fs.closeSync(handle)
      }
      return buffer.toString('utf8')
    } catch {
      return null
    }
  }

  /** « Main prompt finished » postérieur au départ du tour, dans le journal CLI. */
  private logSaysFinished(started: number): boolean {
    const tail = this.logTail()
    return tail === null ? false : promptFinishedSince(tail, started)
  }

  /**
   * Le dossier que ce prompt vient d'ouvrir, ou `null`.
   *
   * Le dossier déjà tenu par la session est reconnu à son nombre de messages ;
   * sinon on cherche celui dont la dernière consigne est exactement celle qu'on
   * vient d'écrire. Le transcript n'écrit le message `user` qu'à la FIN du
   * tour : une consigne qui fait travailler l'agent plus de 20 s (mesuré le
   * 2026-10-23) n'y apparaît donc jamais à temps, et le pont renvoyait la
   * consigne une seconde fois. Le journal de la CLI, lui, dit `[send-message]`
   * dès qu'il prend le message : c'est la preuve d'acceptation immédiate.
   * `since` est reculé de deux secondes : sous Windows, la date de
   * modification d'un fichier n'est pas à la milliseconde près.
   */
  private claimDir(prompt: string, started: number, beforeUsers: number): string | null {
    const since = started - 2_000
    // Le dossier connu à l'avance se vérifie seul : une lecture de quelques
    // Ko, sans date de modification (figée tant que la CLI garde son journal
    // ouvert sous Windows).
    if (process.env.BRIDGE_DEBUG_ACCEPT) {
      try {
        fs.appendFileSync(
          '.tmp/accept.log',
          `${JSON.stringify({ at: Date.now(), kind: 'claim', len: prompt.length, started, since, boot: this.chatBootDir, chat: this.chatDir, root: this.chatRoot })}\n`,
          'utf8',
        )
      } catch {
        // trace optionnelle
      }
    }
    if (this.chatBootDir !== null && sentAnySince(this.chatBootDir, since)) return this.chatBootDir
    if (this.chatDir !== null) {
      const state = chatUsers(this.chatDir)
      if (state.users > beforeUsers && state.lastUser === prompt) return this.chatDir
      if (sentAnySince(this.chatDir, since)) return this.chatDir
    }
    return claimForPrompt(this.chatRoot, prompt, { since }) ?? claimForSend(this.chatRoot, prompt.length, { since })
  }
}
