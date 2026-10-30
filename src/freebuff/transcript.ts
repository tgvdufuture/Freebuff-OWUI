/**
 * Lecture du transcript que la CLI écrit elle-même.
 *
 * `chat-messages.json` est le seul endroit qui contient la réponse complète de
 * l'agent, y compris pendant qu'elle s'écrit. On le lit, on ne l'écrit jamais :
 * deux écrivains sur le même fichier, c'est la CLI qui gagne et le pont qui
 * corrompt.
 *
 * Les fonctions de ce fichier sont PURES : elles prennent le texte brut du
 * fichier et rendent une vue. C'est testable sans PTY, sans quota, sans tour.
 */

export interface TranscriptBlock {
  type: string
  content?: string
  /** `reasoning` pour la réflexion de l'agent, `text` pour sa réponse. */
  textType?: string
  /** Seulement pour les blocs `tool`. */
  toolName?: string
  input?: unknown
}

export interface TranscriptEntry {
  variant: string
  /** Seulement pour un message `user` : la consigne écrite. */
  content?: string
  blocks?: TranscriptBlock[]
  isComplete?: boolean
}

/** `null` quand le fichier est en cours d'écriture (JSON incomplet). */
export function parseTranscript(raw: string): TranscriptEntry[] | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as TranscriptEntry[]) : null
  } catch {
    return null
  }
}

/** Index du dernier message utilisateur, ou fin du tableau s'il n'y en a aucun. */
function afterLastUser(entries: TranscriptEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.variant === 'user') return i + 1
  }
  return entries.length
}

/**
 * Texte de réponse du tour en cours (sans la réflexion).
 *
 * On concatène TOUS les messages de l'agent, pas seulement le dernier : un
 * tour avec des outils produit un message par aller-retour.
 */
export function turnText(entries: TranscriptEntry[]): string {
  const parts: string[] = []
  for (let i = afterLastUser(entries); i < entries.length; i++) {
    const entry = entries[i]
    if (entry?.variant !== 'ai') continue
    for (const block of entry.blocks ?? []) {
      if (block.type !== 'text' || block.textType === 'reasoning') continue
      if (typeof block.content !== 'string' || !block.content) continue
      parts.push(block.content)
    }
  }
  return parts.join('\n\n')
}

/** Une étape du tour, dans l'ordre où la CLI les a produites. */
export type TurnStep =
  | { kind: 'reasoning'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail: string }
  | { kind: 'followups'; items: Followup[] }

/**
 * Une suite proposée par l'agent : `label` pour l'affichage, `prompt` pour ce
 * qui partirait vraiment dans la CLI si on la choisissait.
 */
export interface Followup {
  label: string
  prompt: string
}

/** L'outil par lequel l'agent propose des suites. */
export const FOLLOWUP_TOOL = 'suggest_followups'

/**
 * Suggestions lues dans l'entrée d'un appel `suggest_followups`.
 *
 * Forme réelle (mesurée le 23/10) : `{ followups: [{ prompt, label }] }`. Une
 * entrée sans `prompt` utilisable est ignorée : un lien qui n'enverrait rien
 * n'a pas à apparaître.
 */
export function followupsOf(input: unknown): Followup[] {
  if (typeof input !== 'object' || input === null) return []
  const raw = (input as { followups?: unknown }).followups
  if (!Array.isArray(raw)) return []
  const items: Followup[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const { prompt, label } = entry as { prompt?: unknown; label?: unknown }
    if (typeof prompt !== 'string' || prompt.trim() === '') continue
    const text = prompt.trim()
    const shown = typeof label === 'string' && label.trim() !== '' ? label.trim() : text
    items.push({ label: shown, prompt: text })
  }
  return items
}

/** Détail lisible d'un appel d'outil : premier paramètre utile, borné. */
function toolDetail(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  for (const value of Object.values(input as Record<string, unknown>)) {
    const raw = Array.isArray(value)
      ? value.filter(item => typeof item === 'string').slice(0, 2).join(', ')
      : typeof value === 'string'
        ? value
        : null
    if (raw === null || raw.trim() === '') continue
    return maskSecrets(flatten(raw, DETAIL_CHARS))
  }
  return ''
}

/**
 * Retire les secrets du rendu (F2.2) : `sk-…`, `Bearer …`, `token: …`.
 *
 * Chaque motif se termine par ZÉRO caractère utile après son préfixe : un
 * secret encore en cours d'écriture dans un flux est donc déjà remplacé, et un
 * secret plus long reçoit le MÊME remplacement. Le texte streamé reste ainsi un
 * préfixe exact du rendu final — sans quoi le flux perdrait la suite (invariant
 * vérifié par le test « les deltas du flux reforment exactement le rendu »).
 *
 * Le mot est exigé entier (`(?<![A-Za-z0-9])`) : « risk-averse » n'est pas un
 * secret, et `token` seul (sans `:` ni `=`) ne l'est pas non plus.
 */
export function maskSecrets(text: string): string {
  return text
    .replace(/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]*/g, 'sk-…')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]*/gi, 'Bearer …')
    .replace(
      /(?<![A-Za-z0-9])(token|api[_-]?key|secret|password)(\s*[:=]\s*)[^\s"',;&]*/gi,
      '$1$2…',
    )
}

const DETAIL_CHARS = 80
const PREVIEW_CHARS = 60

function flatten(raw: string, max: number): string {
  const flat = raw.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * Le tour, étape par étape : réflexion, outil, réflexion, réponse…
 *
 * C'est l'ordre RÉEL du transcript. Le regrouper par nature (toute la réflexion
 * d'un côté, la réponse de l'autre) perd l'enchaînement et fait disparaître le
 * texte écrit avant un dernier appel d'outil — ce qui laissait des réponses
 * vides quand l'agent terminait par `suggest_followups`.
 */
export function turnSteps(entries: TranscriptEntry[]): TurnStep[] {
  const steps: TurnStep[] = []
  for (let i = afterLastUser(entries); i < entries.length; i++) {
    const entry = entries[i]
    if (entry?.variant !== 'ai') continue
    for (const block of entry.blocks ?? []) {
      if (block.type === 'tool') {
        const name = typeof block.toolName === 'string' && block.toolName ? block.toolName : 'outil'
        // L'appel `ask_user` n'est pas une étape : le pont rend la question
        // elle-même (carte ou texte numéroté). L'afficher en `🔧 ask_user`
        // ajoutait une ligne technique devant la question.
        if (name === 'ask_user') continue
        // Une suggestion de suite n'est pas un outil comme les autres : ce sont
        // ses prompts qui intéressent, pas son nom.
        const items = name === FOLLOWUP_TOOL ? followupsOf(block.input) : []
        if (items.length > 0) {
          steps.push({ kind: 'followups', items })
          continue
        }
        steps.push({ kind: 'tool', name, detail: toolDetail(block.input) })
        continue
      }
      if (block.type !== 'text' || typeof block.content !== 'string' || block.content.trim() === '') continue
      steps.push({ kind: block.textType === 'reasoning' ? 'reasoning' : 'text', text: block.content })
    }
  }
  return steps
}

const escapeTick = (text: string): string => text.replace(/`/g, '´')

/** Libellé du bloc replié qui regroupe une séquence de travail. */
export const WORK_SUMMARY = '🔧 Travail'

/** Une étape de TRAVAIL (réflexion ou outil), par opposition à une réponse. */
function isWork(step: TurnStep): boolean {
  return step.kind === 'reasoning' || step.kind === 'tool'
}

/** Une étape hors bloc « Travail » : une réponse, ou les suites proposées. */
function plainMarkdown(step: TurnStep, followupUrl: FollowupUrl | null): string {
  if (step.kind === 'reasoning' || step.kind === 'text') return maskSecrets(step.text)
  if (step.kind === 'followups') return followupsMarkdown(step.items, followupUrl)
  return ''
}

/**
 * Aperçu d'une étape, pour le titre d'un bloc replié : le début de son texte.
 *
 * Un titre est du texte inline : on l'aplatit, on le borne, on y masque les
 * secrets, et on neutralise les caractères qui ouvriraient un `code` ou un
 * *gras* sans refermeture — un titre cassé emporterait le bloc entier.
 */
function preview(text: string): string {
  return escapeTick(flatten(maskSecrets(text), PREVIEW_CHARS))
    .replace(/[][*_]/g, ' ')
    .trim()
}

/** L'aperçu d'une étape, icône comprise. */
function stepPreview(step: TurnStep): string {
  if (step.kind === 'reasoning') return `🧠 ${preview(step.text)}`
  if (step.kind === 'tool') {
    const detail = preview(step.detail)
    return detail === '' ? `🔧 ${step.name}` : `🔧 ${step.name} — ${detail}`
  }
  return ''
}

/**
 * Une réflexion : repliée, son début dans le titre, son texte entier dedans.
 *
 * Le bloc est FERMÉ (`<details>`, sans `open`) : rien du travail ne s'impose à
 * la lecture, et un clic ouvre le raisonnement en entier.
 */
function reasoningMarkdown(text: string): string {
  const shown = maskSecrets(text)
  return `<details>\n<summary>🧠 ${preview(shown)}</summary>\n\n${shown}\n\n</details>`
}

/** Une étape DANS le bloc « Travail » : réflexion repliée, outil en une ligne. */
function innerMarkdown(step: TurnStep, followupUrl: FollowupUrl | null): string {
  if (step.kind === 'reasoning') return reasoningMarkdown(step.text)
  if (step.kind === 'tool') return toolMarkdown(step)
  return plainMarkdown(step, followupUrl)
}

function toolMarkdown(step: TurnStep & { kind: 'tool' }): string {
  const detail = step.detail === '' ? '' : ` — \`${escapeTick(step.detail)}\``
  return `🔧 **${step.name}**${detail}`
}

/**
 * Une suite de réflexions et d'outils devient UN bloc « Travail » replié, dont
 * le titre annonce sa première étape : c'est la seule trace du travail qui
 * reste visible, et un clic ouvre l'enchaînement complet.
 *
 * Une étape isolée forme un bloc comme une suite : la forme d'un groupe ne
 * change pas en cours de flux, et le rendu final prolonge exactement ce qui est
 * déjà parti.
 */
function workMarkdown(
  entries: TurnStep[],
  followupUrl: FollowupUrl | null,
  close: boolean,
): string {
  const body = entries.map(step => innerMarkdown(step, followupUrl)).join('\n\n')
  const first = entries[0]
  const head = first === undefined ? '' : stepPreview(first)
  const summary = head === '' ? WORK_SUMMARY : `${WORK_SUMMARY} · ${head}`
  const open = `<details>\n<summary>${summary}</summary>\n\n${body}`
  return close ? `${open}\n\n</details>` : open
}

/**
 * Rendu markdown des étapes, dans l'ordre.
 *
 * Les réflexions et les outils qui se SUIVENT sont regroupés dans un seul bloc
 * « Travail » replié ; une réponse (ou des suites proposées) referme le bloc et
 * s'affiche en clair — même au milieu d'un enchaînement d'outils, où elle reste
 * ce que l'agent raconte à ce moment-là.
 *
 * `streaming` retient la dernière réflexion (voir `holdGrowingReasoning`) et
 * laisse le DERNIER bloc de travail sans sa balise fermante : le delta suivant
 * n'a qu'à ajouter. Rien n'est jamais réécrit, sinon le flux perdrait la suite.
 *
 * `followupUrl` doit rendre la MÊME URL à chaque appel du même tour : le rendu
 * final compare son texte à ce qui est déjà parti, et un jeton qui changerait
 * d'horodatage romprait la comparaison.
 */
export function stepsMarkdown(
  steps: TurnStep[],
  streaming = false,
  followupUrl: FollowupUrl | null = null,
): string {
  const shown = streaming ? holdGrowingReasoning(steps) : steps
  const blocks: TurnStep[][] = []
  for (const step of shown) {
    const last = blocks.at(-1)
    if (isWork(step) && last !== undefined && isWork(last[0] as TurnStep)) last.push(step)
    else blocks.push([step])
  }

  return blocks
    .map((block, index) => {
      const first = block[0] as TurnStep
      if (!isWork(first)) return plainMarkdown(first, followupUrl)
      const growing = streaming && index === blocks.length - 1
      return workMarkdown(block, followupUrl, !growing)
    })
    .join('\n\n')
}

/**
 * En flux, la dernière réflexion est RETENUE : rien n'en est rendu tant qu'une
 * étape ne l'a pas suivie.
 *
 * La CLI réécrit `chat-messages.json` à chaque fragment de réflexion (mesuré le
 * 26/10 : le bloc de l'entrée en cours grandit pendant tout le tour). Or ce texte
 * sert d'aperçu dans le titre de son bloc, et le protocole ne sait qu'AJOUTER du
 * texte : un titre déjà parti ne peut plus s'allonger. On attend donc que la
 * réflexion soit figée — suivie d'une autre étape, ou le tour terminé — pour la
 * rendre d'un coup. Pendant ce temps, OpenWebUI montre le raisonnement vivant
 * dans son propre bloc, alimenté par `reasoning_content`.
 *
 * Seules les réflexions le sont : un appel d'outil est enregistré en entier dès
 * qu'il part, et un texte de réponse grandit à la FIN du rendu, donc le suivre
 * reste toujours un simple ajout.
 */
function holdGrowingReasoning(steps: TurnStep[]): TurnStep[] {
  return steps.at(-1)?.kind === 'reasoning' ? steps.slice(0, -1) : steps
}

/** Construit le lien d'une suggestion ; `null` = pas de lien, on affiche le texte. */
export type FollowupUrl = (prompt: string) => string | null

/** Un `]` dans un libellé casserait le lien markdown. */
const escapeLabel = (text: string): string => text.replace(/[[\]]/g, '')

/**
 * Une ligne cliquable par suite proposée.
 *
 * Sans constructeur de lien (tests, diagnostic), les libellés restent lisibles
 * en clair — jamais un lien mort.
 */
function followupsMarkdown(items: Followup[], followupUrl: FollowupUrl | null): string {
  const lines: string[] = []
  for (const item of items) {
    const url = followupUrl === null ? null : followupUrl(item.prompt)
    const label = escapeLabel(item.label)
    lines.push(url === null ? `🔧 **${FOLLOWUP_TOOL}** — ${label}` : `🔧 **[${label}](${url})**`)
  }
  return lines.join('\n')
}

/** Le tour rendu en markdown, étapes fermées — ce que reçoit OpenWebUI. */
export function turnMarkdown(entries: TranscriptEntry[], followupUrl: FollowupUrl | null = null): string {
  return stepsMarkdown(turnSteps(entries), false, followupUrl)
}

/** Ce que la CLI a écrit comme erreur finale, s'il y en a une. */
export interface CliFailure {
  message: string
  code: string | null
  status: number | null
}

/**
 * Erreur terminale lue dans `run-state.json`.
 *
 * La CLI y écrit son dernier résultat : quand un tour finit sur un refus du
 * serveur (`403 free_mode_client_check_failed`…), le message n'apparaît ni
 * dans le transcript ni dans l'écran. Sans cette lecture, le pont rendait un
 * tour « ok » vide et OpenWebUI restait muet.
 */
export function cliFailure(raw: string): CliFailure | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const output = (parsed as { output?: unknown }).output
  if (typeof output !== 'object' || output === null) return null
  const record = output as { type?: unknown; message?: unknown; error?: unknown; statusCode?: unknown }
  if (record.type !== 'error') return null
  const message = typeof record.message === 'string' && record.message ? record.message : 'erreur inconnue'
  return {
    message,
    code: typeof record.error === 'string' && record.error ? record.error : null,
    status: typeof record.statusCode === 'number' ? record.statusCode : null,
  }
}

/** La CLI a-t-elle fini son prompt depuis `since` ?
 *
 * `log.jsonl` (à côté du transcript) porte une ligne « Main prompt finished »
 * par tour. Elle sert de filet quand `chat-messages.json` n'a pas pu être
 * réécrit : Windows refuse le `rename` de la CLI (`EPERM`) si un autre
 * processus regarde le fichier au même instant, et le pont resterait alors
 * bloqué jusqu'à son délai.
 *
 * Les lignes illisibles sont ignorées : `log.jsonl` est écrit en concurrence.
 */
export function promptFinishedSince(raw: string, since: number): boolean {
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as { msg?: unknown; timestamp?: unknown }
    if (record.msg !== 'Main prompt finished' || typeof record.timestamp !== 'string') continue
    const at = Date.parse(record.timestamp)
    if (Number.isFinite(at) && at >= since) return true
  }
  return false
}

/**
 * Le tour est fini quand le DERNIER message est celui de l'agent et qu'il est
 * marqué complet. `isComplete` est absent pendant l'écriture, donc son absence
 * vaut « pas fini » — jamais l'inverse.
 */
export function turnComplete(entries: TranscriptEntry[]): boolean {
  const last = entries.at(-1)
  return last?.variant === 'ai' && last.isComplete === true
}

/** Nombre de messages utilisateur : sert à reconnaître qu'un prompt est parti. */
export function userCount(entries: TranscriptEntry[]): number {
  let n = 0
  for (const entry of entries) if (entry.variant === 'user') n++
  return n
}

/**
 * Un prompt est écrit dans une TUI, pas dans une API : un retour à la ligne
 * soumettrait le message au milieu. On aplatit, et on borne la taille pour ne
 * pas noyer la zone de saisie.
 */
export const MAX_PROMPT_CHARS = 8000

export function sanitizePrompt(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT_CHARS)
}
