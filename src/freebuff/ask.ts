/**
 * Questions de l'agent (`ask-user`), lues SUR L'ÉCRAN.
 *
 * Mesure S2 (2026-10-22, capture `spike/s7`) : la CLI dessine un panneau
 * « Some questions for you » avec les options proposées, et n'écrit le bloc
 * `ask-user` dans le transcript qu'à la FIN du tour — donc jamais pendant que
 * l'agent attend une réponse. Le seul endroit où la question est lisible est
 * l'écran, comme pour le flux de la réponse.
 *
 * La même capture a établi la façon de répondre sans TUI : une option = une
 * ligne `○ libellé` (description en dessous), le curseur part SUR la première
 * option, `↓` descend, `Entrée` choisit — puis `Tab` + `Entrée` pressent
 * `Submit` (mesuré en S9 ; la lecture S2 « `↓` puis `Entrée` » comptait en fait
 * la validation par un second `Entrée`). Le transcript reçoit ensuite
 * `answers: [{ questionIndex: 0, selectedOption: "bonjour" }]` et le tour
 * reprend.
 *
 * Un panneau peut poser PLUSIEURS questions (`1.`, `2.`, `3.`) : la TUI les
 * plie et n'en déplie qu'une. Répondre déplie la suivante ; quand toutes sont
 * répondues, `Tab` + `Entrée` valide le panneau entier (mesuré en S9).
 *
 * Ce fichier est PUR : il ne touche ni au PTY ni au disque, donc testable sans
 * session ni quota.
 */

/** Une ligne de l'écran, telle que l'émulateur la rend. */
export interface ScreenRow {
  text: string
}

/** Une option proposée, avec sa description si la CLI en affiche une. */
export interface AskOption {
  label: string
  description: string | null
}

export interface AskPanel {
  question: string
  /** Titre court affiché à côté du marqueur (`header`). */
  options: AskOption[]
  /**
   * Cases à cocher (`(Select multiple options)`) : plusieurs choix possibles.
   * Mesuré en S8 : `Espace`/`Entrée` cochent la ligne surlignée, `↑↓` déplacent,
   * `Tab` puis `Entrée` valident.
   */
  multi?: boolean
  /**
   * Plusieurs questions dans le même panneau : la TUI n'en déplie qu'une à la
   * fois, donc le pont les traite une par une (`index` à partir de 0).
   */
  step?: { index: number; total: number }
  /** Forme que le pont ne sait pas piloter : il la montre sans y toucher. */
  complex: boolean
}

/** Nom de l'outil natif d'OpenWebUI qui dessine la carte de question. */
export const ASK_TOOL = 'ask_user'

/**
 * Plafond de cases à cocher dans une carte. Le normaliseur d'OpenWebUI est
 * patché pour accepter jusqu'à cette valeur quand `multi_select` est vrai ;
 * au-delà, le texte numéroté reste la seule voie (aucune pagination de cases).
 */
export const MAX_CHECKBOX_OPTIONS = 10

/**
 * Entrée de pagination quand la CLI propose plus de 3 options (le maximum d'une
 * carte OpenWebUI). Elle n'existe pas dans la TUI : la choisir ne presse AUCUNE
 * touche, elle renvoie la carte suivante.
 */
export const MORE_OPTIONS_LABEL = '▸ Autres options…'

/**
 * Entrée « Custom » de la CLI : ce n'est pas un choix, c'est l'ouverture de SA
 * propre champ de saisie. L'afficher dans la carte doublonnait le champ libre
 * natif d'OpenWebUI (`allow_other`) — et la choisir n'écrit rien dans la TUI,
 * donc l'utilisateur croyait pouvoir taper alors que non.
 */
const CUSTOM_OPTION = /^custom$/i

/**
 * Options réellement choisissables. « Custom » est toujours la dernière entrée
 * de la CLI ; la retirer laisse les indices des autres inchangés, donc les
 * touches (`↓`×n) visent toujours la bonne ligne du panneau.
 */
export function selectableOptions(panel: AskPanel): AskOption[] {
  const options = panel.options
  const last = options.at(-1)
  if (last !== undefined && CUSTOM_OPTION.test(last.label.trim())) return options.slice(0, -1)
  return options
}

/**
 * Rang de la ligne « Custom » dans le panneau BRUT, ou `null`.
 *
 * Ce n'est pas un choix : la sélectionner ouvre le champ libre de la TUI. On
 * garde donc son rang pour pouvoir y écrire une réponse libre — sans quoi une
 * réponse hors options ne correspondait à rien et le pont reposait la même
 * question, sans fin (vu en réel le 23/10).
 */
export function customOptionIndex(panel: AskPanel): number | null {
  const index = panel.options.findIndex(option => CUSTOM_OPTION.test(option.label.trim()))
  return index === -1 ? null : index
}

/** Titre du panneau : c'est lui qui sert de repère. */
const PANEL_TITLE = /Some questions for you/
/** Ligne d'option : puce ronde, libellé éventuellement suivi de sa description. */
const OPTION = /^[|│\s]*[○●]\s+(.*)$/
/** Question ouverte par un chevron (`▼` dépliée, `▶` repliée). */
const QUESTION = /^[|│\s]*[▼▲▶]\s+(.*)$/
/** Question NUMÉROTÉE : plusieurs questions dans un même panneau. */
const STEP = /^[|│\s]*([▼▲▶])\s*(\d+)\.\s+(.*)$/
/** Ligne de description : plus indentée que sa puce, sans marqueur. */
const DESCRIPTION = /^[|│\s]{4,}(.*)$/
/** Cases à cocher : plusieurs réponses possibles, non piloté par le pont. */
const CHECKBOX = /^[|│\s]*[☐☑]\s+(.*)$/

/** Nettoie une ligne de panneau : barres de cadre et espaces de bord. */
function strip(text: string): string {
  return text
    .replace(/^[|│\s]+/, '')
    .replace(/[|│\s]+$/, '')
}

/**
 * Le panneau de question visible, ou `null`.
 *
 * On repère le titre, puis on lit les lignes jusqu'au bouton `Submit` : la
 * question, ses options et leurs descriptions. Ce qui est sous le panneau (barre
 * d'état, pubs) est ignoré.
 */
export function askPanelFromScreen(rows: ScreenRow[]): AskPanel | null {
  const lines = rows.map(row => row.text)
  const start = lines.findIndex(line => PANEL_TITLE.test(line))
  if (start === -1) return null

  /** Une question du panneau : son numéro et ses options (si dépliée). */
  const groups: Array<{ index: number; open: boolean; question: string; options: AskOption[] }> = []
  let question = ''
  let sawQuestion = false
  let target: AskOption[] = []
  let complex = false
  let multi = false

  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    const text = strip(raw)
    if (/^\s*Submit\b/.test(text) || /↑↓ navigate/.test(text)) break
    if (/Select multiple options/i.test(raw)) multi = true

    const step = STEP.exec(raw)
    if (step) {
      const group = {
        index: Number(step[2]),
        open: (step[1] ?? '') !== '▶',
        question: strip(step[3] ?? ''),
        options: [] as AskOption[],
      }
      groups.push(group)
      target = group.options
      continue
    }

    const check = CHECKBOX.exec(raw)
    if (check) {
      multi = true
      target.push({ label: strip(check[1] ?? ''), description: null })
      continue
    }

    const option = OPTION.exec(raw)
    if (option) {
      target.push({ label: strip(option[1] ?? ''), description: null })
      continue
    }

    const asked = QUESTION.exec(raw)
    if (asked && !sawQuestion && groups.length === 0) {
      question = strip(asked[1] ?? '')
      sawQuestion = true
      target = []
      // Un second chevron NON numéroté : forme jamais rencontrée, on ne devine
      // pas comment la remplir.
      if (lines.slice(i + 1).some(line => QUESTION.test(line) && !STEP.test(line))) complex = true
      continue
    }

    const description = DESCRIPTION.exec(raw)
    const last = target.at(-1)
    if (description && last !== undefined && last.description === null && text) {
      last.description = text.trim()
    }
  }

  // Plusieurs questions : toutes ne sont connues que par leur titre ; seule la
  // dépliée montre ses options — c'est celle qu'on remplit.
  if (groups.length > 0) {
    const current = groups.find(group => group.open && group.options.length > 0)
    if (current === undefined) return null
    const total = groups.reduce((max, group) => Math.max(max, group.index), 0)
    const step = total > 1 ? { index: current.index - 1, total } : undefined
    // Cases à cocher ET plusieurs questions : mesuré en S10. `Espace` coche,
    // `↓` au-delà de la dernière ligne ouvre la question suivante, et `Tab` +
    // `Entrée` valide le panneau — même avec des questions laissées vides, d'où
    // l'obligation de toutes les remplir avant de valider.
    return { question: current.question, options: current.options, complex: false, multi, step }
  }

  if (target.length === 0) return null
  return { question, options: target, complex, multi }
}

/** Le panneau est-il à l'écran, même si aucune question n'est dépliée ? */
export function askPanelVisible(rows: ScreenRow[]): boolean {
  return rows.some(row => PANEL_TITLE.test(row.text))
}

/**
 * Rang de la première ligne du panneau dans l'image, ou `-1`.
 *
 * Sert à borner ce qui est AU-DESSUS de la question : le texte que l'agent a
 * écrit juste avant, et rien du panneau lui-même.
 */
export function panelTop(rows: ScreenRow[]): number {
  return rows.findIndex(row => PANEL_TITLE.test(row.text))
}

/** Forme comparable d'un panneau : deux lectures identiques = peinture finie. */
export function panelShape(panel: AskPanel): string {
  return JSON.stringify([panel.question, panel.multi === true, panel.step ?? null, panel.options])
}

/**
 * Le panneau relu est-il CELUI qu'on vient de répondre ?
 *
 * Mesuré en réel le 23/10 : après le choix d'une option, la TUI garde le
 * panneau affiché — elle attend `Tab` + `Entrée` pour valider. Le relire et le
 * prendre pour « la question suivante » reposait la même carte à l'infini.
 * Une vraie question suivante change de texte, ou de rang ; les options, elles,
 * peuvent changer sans que la question soit nouvelle (la puce du choix se
 * remplit, une réponse se replie).
 */
export function sameQuestion(answered: AskPanel, read: AskPanel): boolean {
  const before = answered.step?.index ?? 0
  const after = read.step?.index ?? 0
  return before === after && answered.question === read.question
}

/**
 * Attend une image STABLE du panneau avant de le rendre.
 *
 * Mesuré en réel le 2026-10-22 : la TUI peint le panneau en plusieurs frames.
 * Une lecture trop tôt a attrapé un panneau à UNE option (« Café ☕ … │○ »
 * collé au bord), et le pont, qui exige deux options pour une carte, a envoyé
 * le texte de repli au lieu de la carte. Un panneau à moins de deux options
 * n'est donc jamais accepté, et deux lectures identiques valent peinture finie.
 *
 * Renvoie la dernière lecture stable (la meilleure disponible) ou `null`.
 */
export async function settledPanel(
  read: () => Promise<AskPanel | null>,
  wait: (ms: number) => Promise<unknown>,
  attempts = 4,
  gapMs = 100,
): Promise<AskPanel | null> {
  let previous: string | null = null
  let last: AskPanel | null = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    const panel = await read()
    if (panel === null || panel.options.length < 2) {
      previous = null
    } else {
      const shape = panelShape(panel)
      if (shape === previous) return panel
      previous = shape
      last = panel
    }
    await wait(gapMs)
  }
  return last
}

/**
 * Ce qu'OpenWebUI affiche : la question puis les options NUMÉROTÉES, avec leur
 * description — la même information que la TUI, choisissable par un message.
 */
export function renderQuestion(panel: AskPanel): string {
  const progress = panel.step === undefined ? null : panel.step.index + 1
  if (panel.complex) {
    return (
      `**Question de l'agent** (plusieurs questions ou cases à cocher) : ` +
      `${panel.question}\n\n` +
      selectableOptions(panel)
        .map((option, i) => `${i + 1}. ${option.label}`)
        .join('\n') +
      '\n\n_Ce panneau ne peut être rempli que dans la CLI (une seule question à choix unique est pilotable ici)._'
    )
  }

  const lines = selectableOptions(panel).map((option, i) => {
    const detail = option.description === null ? '' : ` — ${option.description}`
    return `${i + 1}. **${option.label}**${detail}`
  })

  // Plusieurs questions : on les pose une par une, comme la CLI.
  if (progress !== null) {
    const advice =
      panel.multi === true
        ? `Coche ce que tu veux avec ses **numéros**, séparés par une virgule (ex. \`1, 3\`) : ` +
          `je coche ces cases, puis la question suivante s'ouvre, sans consommer de tour supplémentaire.`
        : `Réponds par le **numéro** de ton choix (ou son libellé) : je le transmets et la question suivante ` +
          `s'ouvre, sans consommer de tour supplémentaire.`
    return `**Question ${progress} sur ${panel.step?.total}** : ${panel.question}\n\n${lines.join('\n')}\n\n${advice}`
  }

  if (panel.multi === true) {
    return (
      `**Question de l'agent** : ${panel.question}\n\n${lines.join('\n')}\n\n` +
      `Coche ce que tu veux avec ses **numéros**, séparés par une virgule (ex. \`1, 3\`, ou \`tests, performance\`) : ` +
      `je coche ces cases et je valide, sans consommer de tour supplémentaire. ` +
      `Pour une demande en plus, écris-la dans le message suivant : le champ libre du panneau de la CLI ` +
      `ne peut pas être rempli sans le valider à vide.`
    )
  }

  return (
    `**Question de l'agent** : ${panel.question}\n\n${lines.join('\n')}\n\n` +
    `Réponds par le **numéro** de ton choix (ou son libellé) : je le transmets à l'agent ` +
    `et il continue son tour, sans consommer de tour supplémentaire.`
  )
}

/**
 * Option visée par le message de l'utilisateur : un numéro (`2`), ou le libellé
 * (`au revoir`, casse et espaces ignorés). `null` si rien ne correspond — on ne
 * devine jamais une réponse à la place de quelqu'un.
 */
export function optionIndexFor(answer: string, panel: AskPanel): number | null {
  const text = answer.replace(/\s+/g, ' ').trim()
  if (!text) return null

  // Mêmes indices que le panneau : « Custom » est la dernière ligne, donc la
  // retirer ne décale aucune touche.
  const options = selectableOptions(panel)

  const numbered = /^(\d{1,2})$/.exec(text)
  if (numbered) {
    const index = Number(numbered[1]) - 1
    return index >= 0 && index < options.length ? index : null
  }

  const flat = text.toLowerCase()
  const exact = options.findIndex(option => option.label.trim().toLowerCase() === flat)
  if (exact !== -1) return exact

  // Un libellé recopié avec sa description, ou l'inverse : on accepte le début.
  const starts = options.findIndex(option => flat.startsWith(option.label.trim().toLowerCase()))
  return starts === -1 ? null : starts
}

/**
 * Arguments du *tool call* `ask_user` d'OpenWebUI (0.12.x), lus dans
 * `utils/ask_user.py` : 1 à 3 questions, 2 à 3 options par question (jusqu'à 10
 * en cases à cocher, cf. le patch local), chaque option avec libellé ET
 * description, `ask_user` seul appel du tour.
 *
 * `null` quand le panneau sort de ce contrat (trop d'options, plusieurs
 * questions non mesurées) : dans ce cas le pont garde le texte numéroté, qui ne
 * ment pas sur ce qu'il sait transmettre.
 */
export function toolArguments(panel: AskPanel, stage = 0): Record<string, unknown> | null {
  const selectable = selectableOptions(panel)
  if (panel.complex || selectable.length < 2) return null

  // Cases à cocher : OpenWebUI stock ne sait pas les rendre, la carte locale est
  // patchée (`scripts/patch-owui-multiselect.py`) pour honorer `multi_select`,
  // accepter plus de trois options et renvoyer tous les libellés cochés. Toutes
  // les cases partent donc dans UNE carte — pas de pagination à accumuler.
  if (panel.multi === true) {
    if (selectable.length > MAX_CHECKBOX_OPTIONS) return null
    return {
      questions: [
        {
          id: `freebuff-q${String((panel.step?.index ?? 0) + 1)}-multi`,
          header: 'Freebuff',
          question: panel.question || 'Question de l’agent',
          options: selectable.map(option => ({
            label: option.label,
            description: option.description ?? option.label,
          })),
          multi_select: true,
          // Le champ libre d'OWUI écraserait la sélection : on le ferme.
          allow_other: false,
        },
      ],
      allow_other: false,
      timeout_ms: 120_000,
    }
  }

  // Une carte tient 3 options. Au-delà, on en montre 2 plus « Autres options… » :
  // la dernière place reste libre pour la pagination, sinon l'utilisateur ne
  // pourrait jamais atteindre les options suivantes.
  const start = stage * 2
  const rest = selectable.slice(start)
  if (rest.length < 2) return null
  const shown = rest.length > 3 ? rest.slice(0, 2) : rest
  const more = rest.length > 3

  const options = shown.map(option => ({
    label: option.label,
    // OWUI exige une description : à défaut, on ne fabrique rien de faux, on
    // répète le libellé tel quel.
    description: option.description ?? option.label,
  }))
  if (more) {
    options.push({ label: MORE_OPTIONS_LABEL, description: 'Afficher les options suivantes' })
  }

  return {
    questions: [
      {
        id: `freebuff-q${String((panel.step?.index ?? 0) + 1)}-s${stage}`,
        header: 'Freebuff',
        question: panel.question || 'Question de l’agent',
        options,
      },
    ],
    allow_other: true,
    timeout_ms: 120_000,
  }
}

/**
 * Réponse envoyée par OpenWebUI quand la carte est validée.
 *
 * Contenu mesuré côté client : `{"status":"answered","answers":{"<id>":
 * {"type":"option","option_index":0,"label":"…","description":"…"}}}` (ou
 * `{"type":"other","text":"…"}` pour une réponse libre). On rend le libellé,
 * ou le texte libre — jamais un choix deviné.
 */
export function answerFromToolContent(content: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const answers = (parsed as { answers?: unknown }).answers
  if (typeof answers !== 'object' || answers === null) return null

  for (const value of Object.values(answers as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const answer = value as { type?: unknown; label?: unknown; labels?: unknown; text?: unknown }
    if (answer.type === 'option' && typeof answer.label === 'string' && answer.label) {
      return answer.label
    }
    if (
      answer.type === 'options' &&
      Array.isArray(answer.labels) &&
      answer.labels.length > 0 &&
      answer.labels.every(label => typeof label === 'string' && label.trim() !== '')
    ) {
      // Cases cochées : les libellés voyagent tels quels (JSON), pour que
      // `selectionFor` les mappe exactement — sans découper sur les virgules.
      return JSON.stringify(answer.labels)
    }
    if (answer.type === 'other' && typeof answer.text === 'string' && answer.text.trim()) {
      return answer.text.trim()
    }
  }
  return null
}

/**
 * Touches de la TUI pour choisir une option, mesurées en S9 : le curseur part
 * SUR la première option, chaque `↓` descend d'un cran, `Entrée` choisit.
 *
 * La lecture S2 (« `↓` puis `Entrée` pour la première option ») était erronée :
 * `Entrée` seul l'avait déjà choisie, et le `↓` suivant ne faisait rien — le
 * second `Entrée` validait le panneau. Avec un `↓` de trop, l'option voisine
 * était cochée.
 */
export function optionKeys(index: number): string {
  return `${'\x1b[B'.repeat(Math.max(0, index))}\r`
}

/**
 * `Tab` puis `Entrée` pressent `Submit` : le panneau ne se ferme qu'à ce
 * moment-là, une fois toutes ses questions répondues (mesuré en S9).
 */
export const SUBMIT_KEYS = '\t\r'

/**
 * Découpe une suite de touches en gestes séparés (`↓` compte pour un).
 *
 * Mesuré en S9 : écrites d'un seul trait, `↓` puis `Entrée` choisissent la
 * MAUVAISE option — le `Entrée` arrive avant que la TUI ait déplacé le curseur.
 * Chaque geste doit partir seul (`Session.respond`).
 */
export function keyTokens(keys: string): string[] {
  const tokens: string[] = []
  for (let i = 0; i < keys.length; i++) {
    const arrow = /^\x1b\[[A-Z]/.exec(keys.slice(i))
    if (arrow) {
      tokens.push(arrow[0])
      i += arrow[0].length - 1
      continue
    }
    tokens.push(keys[i] ?? '')
  }
  return tokens
}

/**
 * Choix multiples demandés par l'utilisateur : `1, 3`, `tests et performance`,
 * ou un mélange des deux. `null` dès qu'un élément ne correspond à rien — on ne
 * coche jamais une case que personne n'a demandée.
 */
/** Libellés exacts envoyés par la carte à cases cochées, ou `null`. */
function labelList(text: string): string[] | null {
  if (!text.startsWith('[')) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    if (!parsed.every(label => typeof label === 'string' && label.trim() !== '')) return null
    return parsed as string[]
  } catch {
    return null
  }
}

export function selectionFor(answer: string, panel: AskPanel): number[] | null {
  const options = selectableOptions(panel)

  // Réponse de la carte : un libellé par case, aucun découpage. Un libellé
  // inconnu annule tout — on ne coche jamais une case que personne n'a cochée.
  const labels = labelList(answer.trim())
  if (labels !== null) {
    const picked: number[] = []
    for (const label of labels) {
      const index = optionIndexFor(label, panel)
      if (index === null || index >= options.length) return null
      if (!picked.includes(index)) picked.push(index)
    }
    return picked.sort((a, b) => a - b)
  }

  const parts = answer
    .split(/[,;+\n]|\bet\b|\band\b/gi)
    .map(part => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  if (parts.length === 0) return null

  const picked: number[] = []
  for (const part of parts) {
    const index = optionIndexFor(part, panel)
    if (index === null || index >= options.length) return null
    if (!picked.includes(index)) picked.push(index)
  }
  return picked.length === 0 ? null : picked.sort((a, b) => a - b)
}

/**
 * Touches pour cocher plusieurs cases puis valider, mesurées en S8 : la
 * surlignage part sur la première option, `Espace` coche la ligne courante,
 * `↓` descend d'un cran, et `Tab` puis `Entrée` pressent `Submit`.
 *
 * On coche dans l'ordre croissant : le curseur ne fait que descendre.
 */
function toggleKeys(indices: number[]): string {
  let keys = ''
  let cursor = 0
  for (const index of [...indices].sort((a, b) => a - b)) {
    keys += '\x1b[B'.repeat(index - cursor)
    keys += ' '
    cursor = index
  }
  return keys
}

export function keysForSelection(indices: number[]): string {
  return `${toggleKeys(indices)}\t\r`
}

/**
 * Cases cochées dans un panneau à PLUSIEURS questions (mesuré en S10).
 *
 * `Espace` coche, puis `↓` jusqu'à la question suivante, qui s'ouvre quand le
 * curseur dépasse la dernière ligne — « Custom » comprise, elle occupe une ligne.
 * On ne valide PAS ici : `Tab` + `Entrée` validerait le panneau entier, et la
 * CLI accepte alors des questions laissées vides (`{questionIndex: 1}` sans
 * `selectedOption`).
 */
export function keysForMultiNext(indices: number[], panel: AskPanel): string {
  const sorted = [...indices].sort((a, b) => a - b)
  const last = sorted.at(-1) ?? 0
  return toggleKeys(sorted) + '\x1b[B'.repeat(Math.max(1, panel.options.length - last))
}
