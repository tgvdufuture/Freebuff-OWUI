import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveFreebuffBin } from './freebuff/profiles.ts'

const projectRoot = process.cwd()
const dataDir = process.env.BRIDGE_DATA_DIR ?? path.join(projectRoot, 'data')

/** Profil utilisé au démarrage. Une bascule en cours d'exécution le remplace. */
const profileDir = process.env.BRIDGE_PROFILE_DIR ?? path.join(os.homedir(), '.config', 'freebuff')

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

/**
 * La clé que l'utilisateur colle dans OpenWebUI.
 *
 * Générée une fois et écrite dans `data/api-key.txt` : la régénérer à chaque
 * démarrage casserait la connexion OpenWebUI sans rien expliquer. Une variable
 * d'environnement reste prioritaire pour les tests et les lancements jetables.
 */
export function readApiKey(): string {
  const fromEnv = process.env.BRIDGE_API_KEY?.trim()
  if (fromEnv) return fromEnv

  const file = path.join(dataDir, 'api-key.txt')
  try {
    const stored = fs.readFileSync(file, 'utf8').trim()
    if (stored) return stored
  } catch {
    // Premier démarrage : on génère.
  }

  const key = `fb-${crypto.randomBytes(24).toString('hex')}`
  ensureDir(dataDir)
  fs.writeFileSync(file, `${key}\n`, 'utf8')
  return key
}

/**
 * Faut-il écrire les corps de requête sur disque ?
 *
 * Seulement pour le harnais S0 (ou sur demande explicite) : ces corps
 * contiennent les prompts, et un pont en marche réelle n'a aucune raison de
 * garder une copie du travail de l'utilisateur.
 */
export function captureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BRIDGE_CAPTURE === '1' || env.BRIDGE_STUB !== '0'
}

/**
 * Plafond d'attente d'un tour : 45 min (PRD §3.3). Il ne coupe pas la CLI, il
 * arrête seulement le flux SSE ; le tour continue côté Freebuff.
 */
const DEFAULT_TURN_TIMEOUT_MS = 45 * 60_000

/**
 * Sans AUCUNE écriture de la CLI pendant ce délai, le tour est tenu pour
 * bloqué. C'est ce qui borne un tour coupé par la CLI (elle n'écrit alors ni
 * `isComplete` ni « Main prompt finished »).
 */
const DEFAULT_TURN_IDLE_MS = 10 * 60_000

function positiveMs(raw: string | undefined, fallback: number): number {
  const parsed = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** Cycle de synchronisation OWUI : 15 min par défaut, `0` le désactive (PRD US-05). */
const DEFAULT_IMPORT_INTERVAL_MS = 15 * 60_000

export function importIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BRIDGE_IMPORT_INTERVAL_MS
  if (raw === undefined || raw.trim() === '') return DEFAULT_IMPORT_INTERVAL_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_IMPORT_INTERVAL_MS
}

/** Sessions vivantes simultanées par défaut (une par projet, mesuré en S12). */
const DEFAULT_SESSION_LIMIT = 3

/**
 * Combien de sessions vivantes le pont accepte d'ouvrir.
 *
 * Une valeur absente ou invalide retombe sur 3 : une limite à `NaN` ne
 * refuserait jamais rien, donc autant ne pas la laisser passer.
 */
export function sessionLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BRIDGE_MAX_SESSIONS
  const parsed = raw === undefined ? Number.NaN : Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_LIMIT
}

export const config = {
  projectRoot,
  dataDir,
  host: process.env.BRIDGE_HOST ?? '127.0.0.1',
  port: Number(process.env.BRIDGE_PORT ?? 7799),

  /**
   * `true` tant que le pont ne pilote pas encore la CLI : il répond un texte
   * de diagnostic. C'est le harnais du spike S0, pas une feature produit.
   */
  stub: process.env.BRIDGE_STUB !== '0',

  apiKey: readApiKey(),
  /** `false` en marche réelle : les prompts ne sont pas recopiés sur disque. */
  capture: captureEnabled(),
  captureDir: process.env.BRIDGE_CAPTURE_DIR ?? path.join(projectRoot, 'spike', 's0', 'requests'),

  /**
   * Sessions Freebuff vivantes simultanées (une par projet). Chaque session
   * ouverte coûte une heure de quota : la limite évite d'en ouvrir une de plus
   * sans que personne ne l'ait demandé.
   */
  maxSessions: sessionLimit(),

  /**
   * Délai avant d'afficher un indicateur d'activité dans le flux SSE.
   *
   * S1 a montré que `chat-messages.json` n'est écrit qu'à la fin du tour : le
   * compte rendu ne peut pas être streamé. Sans indicateur, OpenWebUI reste
   * muet jusqu'à la réponse finale.
   */
  activityAfterMs: Number(process.env.BRIDGE_ACTIVITY_AFTER_MS ?? 5_000),

  /**
   * Carte de question native d'OpenWebUI (`ask_user` en tool call).
   *
   * Désactivée par défaut : OpenWebUI rend ces cartes AU-DESSUS du corps du
   * message (les appels d'outil sortent de la sortie structurée, affichée avant
   * le contenu), donc le texte écrit avant la question passait après elle.
   * Sans la carte, la question est écrite en markdown à la fin du message, dans
   * l'ordre du fil ; la réponse tapée est convertie en touches comme avant.
   * `BRIDGE_ASK_CARD=1` la réactive (boutons cliquables, ordre inversé).
   */
  askCard: process.env.BRIDGE_ASK_CARD === '1',

  /** Attente MAXIMALE d'un tour, progression ou non. Voir `turnIdleMs`. */
  turnTimeoutMs: positiveMs(process.env.BRIDGE_TURN_TIMEOUT_MS, DEFAULT_TURN_TIMEOUT_MS),

  /**
   * Délai sans écriture de la CLI au-delà duquel le tour est rendu en
   * « timeout ». Ce n'est PAS un plafond de durée : chaque étape écrite
   * (transcript ou journal) repousse l'échéance, donc un agent qui travaille
   * 40 minutes n'est pas coupé ; un tour coupé par la CLI ne gèle pas 45 min.
   */
  turnIdleMs: positiveMs(process.env.BRIDGE_TURN_IDLE_MS, DEFAULT_TURN_IDLE_MS),

  /**
   * Import périodique des conversations Freebuff dans OpenWebUI. `0` le
   * désactive : le pont ne lit alors plus les transcripts tout seul.
   */
  importIntervalMs: importIntervalMs(),

  /**
   * Racines sous lesquelles un chat peut lier un projet. Une liste, parce que
   * les dépôts ne vivent pas forcément tous au même endroit. Par défaut
   * `D:/code`, l'emplacement documenté dans le PRD ; `BRIDGE_PROJECTS_ROOT`
   * (séparé par `;` sous Windows, `:` ailleurs) remplace la liste.
   */
  projectsRoot: (process.env.BRIDGE_PROJECTS_ROOT ?? 'D:/code')
    .split(path.delimiter)
    .map(value => value.trim())
    .filter(Boolean),

  /**
   * Un seul profil, jamais de rotation : `freebuff` est le compte du pont.
   *
   * Volontairement PAS `FREEBUFF_CONFIG_DIR` : cette variable traîne dans
   * l'environnement de la machine et désignait ici `freebuff-desktop`, un
   * autre compte. Le profil du pont se choisit explicitement.
   */
  profileDir,

  /**
   * Où rediriger après « Continuer ». Le pont est vu depuis le navigateur de
   * la machine (127.0.0.1), comme les liens du bouton.
   */
  owuiBaseUrl: process.env.BRIDGE_OWUI_URL ?? 'http://127.0.0.1:8080',

  freebuffBin: resolveFreebuffBin(profileDir),
} as const
