/**
 * Flux progressif : ce que la TUI affiche pendant un tour.
 *
 * Mesure S6 : le transcript n'est écrit qu'en fin de tour, mais la TUI écrit la
 * réponse au fur et à mesure dans le PTY. C'est donc l'écran — et lui seul — qui
 * permet un flux progressif.
 *
 * Deux pièges mesurés sur la capture réelle :
 * - `isWrapped` ne vaut pas dire « paragraphe » : la TUI écrit des lignes de
 *   largeur pleine, donc presque toutes les lignes sont marquées `wrapped`,
 *   y compris après une ligne vide. On s'appuie donc sur la STRUCTURE visible
 *   (ligne vide = paragraphe), pas sur ce drapeau de l'émulateur.
 * - la barre d'état du bas répète la consigne : elle contient donc l'ancre.
 *   On la borne en excluant tout ce qui est sous la ligne du modèle.
 *
 * Règle de prudence : on n'émet qu'un préfixe STABLE — ce qui ne bouge plus
 * entre deux images. Le protocole OpenAI ne sait qu'ajouter du texte, jamais en
 * retirer : émettre un caractère encore en cours d'écriture le figerait à vie.
 */

/**
 * Une ligne physique de l'écran.
 *
 * `italic` et `color` ne sont pas décoratifs : la TUI écrit la réflexion en
 * italique et rend tout ce qui n'est pas la réponse (raisonnement, sortie des
 * outils, publicités) dans une couleur atténuée. Mesuré sur une capture réelle :
 * sans ce signal, `git status` et les pubs se retrouvent dans la réponse.
 */
export interface ScreenLine {
  text: string
  italic?: boolean
  color?: number
}

/** Marqueurs d'interface : jamais du contenu de réponse. */
const CHROME = [
  /hours? remaining/i,
  /End session/i,
  /Enter a coding task/i,
  /for history · \? for help/i,
  /\/model to change/i,
  /Pick your model/i,
  /See plans/i,
  /Session active/i,
  /^\s*\d+[mh] left/,
  /thinking\.\.\./,
  /working\.\.\./,
  /Esc: back to draft/,
  /^\s*show \d+ more lines/i,
]

/** Encadrements, barres de défilement et pastilles de la TUI. */
const FRAME_CHARS = /^[\s]*[│┃╭╮╰╯┌┐└┘├┤┬┴]/
/**
 * Filet horizontal de la TUI. Il sépare AUSSI les sections de la réponse :
 * le traiter comme un bord d'interface coupait la réponse au premier séparateur
 * (mesuré : 145 caractères livrés sur 2990). C'est un élément à sauter.
 */
const SEPARATOR = /^\s*[─═][\s─═]*$/

/**
 * Tableau dessiné par la TUI. Ses lignes ne sont pas le markdown de la réponse :
 * - les prendre pour des bords d'interface coupait le flux ;
 * - les émettre affichait « juste des barres » dans OpenWebUI ;
 * - les sauter sans s'arrêter perd le tableau (le texte d'après part, et la fin
 *   n'est plus recollable puisqu'on n'insère jamais au milieu).
 * On s'arrête donc AU tableau : la fin de tour apporte le reste en markdown.
 */
const TABLE_FRAME = /[│┼├┤┬┴]/
/** Ligne de tableau déjà en markdown (`| a | b |`), même incomplète. */
const TABLE_ROW = /^\s*\|.*\|\s*$/
const BLOCK_ART = /[█▀▄]{2,}/
const COPY_MARK = /^\s*⎘/
/**
 * Ligne de commande d'un outil (`$ git status…`) : ce n'est pas la réponse,
 * mais ce n'est pas non plus un bord d'interface — on la saute sans couper.
 */
const TOOL_COMMAND = /^\s*\$\s/

/**
 * Clôture de bloc de code. La TUI l'affiche pendant l'écriture puis la remplace
 * par un rendu encadré ; mesuré : le ``` est collé à la fin d'une ligne
 * (`…mise en forme :```). On le retire au lieu de jeter le début de la ligne.
 */
const FENCE = /```[a-zA-Z]*\s*$/

/** Pied de l'interface : la réponse est toujours au-dessus. */
const FOOTER = /\/model to change/

/**
 * Marqueurs des blocs qui précèdent la réponse : `• Thinking` pour la
 * réflexion, `• List .` / `• Read …` pour les outils. Mesuré sur un tour réel
 * avec outils : ils s'intercalent, et le dernier marque la fin du travail.
 * Les listes de la RÉPONSE sont rendues en markdown (`-`), pas en `•`.
 */
const BLOCK_MARKER = /^\s*[•·]\s/

function isChrome(text: string): boolean {
  if (FRAME_CHARS.test(text)) return true
  if (BLOCK_ART.test(text)) return true
  if (COPY_MARK.test(text)) return true
  return CHROME.some(pattern => pattern.test(text))
}

/** Recollage : le retour à la ligne de l'écran vaut une espace, sauf ponctuation. */
function needsSpace(before: string, after: string): boolean {
  if (!before || !after) return false
  if (/\s$/.test(before)) return false
  return !/^[.,;:!?)\]}»’]/.test(after)
}

/** Une ligne qui commence un nouveau bloc : liste, titre, code indenté. */
const BLOCK_START = /^\s*([-*+>#|]|\d+\.)\s/
const BLOCK_END = /[{};]$/

/** Lignes d'écran → texte : paragraphes recollés, indentation relative gardée. */
function render(rows: string[]): string {
  const kept = rows.map(row => row.replace(/\s*█+\s*$/, '').trimEnd())
  while (kept.length && !(kept[0] ?? '').trim()) kept.shift()
  while (kept.length && !(kept[kept.length - 1] ?? '').trim()) kept.pop()
  if (!kept.length) return ''

  const indents = kept.filter(row => row.trim()).map(row => row.length - row.trimStart().length)
  const indent = indents.length ? Math.min(...indents) : 0
  const lines = kept.map(row => row.slice(indent))

  let out = ''
  let newBlock = true
  let previous = ''
  for (const line of lines) {
    if (!line.trim()) {
      // Une ligne vide à l'écran = un paragraphe : on garde la même marque
      // que le transcript (`\n\n`) pour qu'OpenWebUI rende comme la CLI.
      if (out !== '' && !out.endsWith('\n\n')) out += out.endsWith('\n') ? '\n' : '\n\n'
      newBlock = true
      continue
    }
    // Un décalage d'UN espace est le bord de l'écran, pas une indentation :
    // seul un vrai retrait (2+) signale du code ou une sous-liste.
    const extra = line.length - line.trimStart().length
    const startsBlock =
      extra >= 2 || BLOCK_START.test(line) || BLOCK_END.test(previous.trimEnd())
    const text = line.trim()
    if (newBlock || startsBlock) {
      out += (out !== '' && !out.endsWith('\n') ? '\n' : '') + text
    } else {
      out += (needsSpace(out, text) ? ' ' : '') + text
    }
    newBlock = false
    previous = line
  }
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Texte de la réponse visible sur l'écran.
 *
 * L'ancre est l'écho de la consigne : la TUI affiche `[hh:mm] <consigne>` juste
 * avant la réponse. On prend la DERNIÈRE occurrence au-dessus du pied de page
 * (celle du tour en cours). Ce qui suit l'ancre jusqu'à la ligne vide est la fin
 * de la consigne recopiée : on l'écarte avant de lire la réponse.
 *
 * Rend `''` tant que l'ancre n'est pas visible : mieux vaut ne rien émettre que
 * d'émettre le bandeau d'accueil ou la réponse du tour précédent.
 */
export function answerFromScreen(
  lines: ScreenLine[],
  prompt: string,
  /** Le tour est fini : la dernière ligne ne bougera plus. */
  complete = false,
  /**
   * Lecture en direct (canal « réflexion ») : la dernière ligne est INCLUSE,
   * sans ses marqueurs markdown. Sans ça, le texte n'avance que d'une ligne
   * complète à la fois — plusieurs secondes entre deux morceaux.
   */
  live = false,
): string {
  const snippet = prompt.replace(/\s+/g, ' ').trim().slice(0, 24)
  if (!snippet) return ''

  const texts = lines.map(line => line.text)

  let footer = texts.length
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i] ?? ''
    if (FOOTER.test(text)) footer = i
  }

  let anchor = -1
  for (let i = 0; i < footer; i++) {
    const raw = texts[i] ?? ''
    if (isChrome(raw)) continue
    if (!raw.replace(/\s+/g, ' ').includes(snippet)) continue
    anchor = i
  }
  if (anchor === -1) return ''

  // Couleur atténuée = tout sauf la réponse. On la lit sur la réflexion, qui
  // est toujours en italique, plutôt que de coder une valeur de thème en dur.
  let muted: number | null = null
  for (let i = anchor + 1; i < footer; i++) {
    if (lines[i]?.italic === true && lines[i]?.color !== undefined) {
      muted = lines[i]?.color ?? null
      break
    }
  }

  // Fin de la consigne recopiée : la réponse commence après la ligne vide.
  let start = anchor + 1
  while (start < footer && (texts[start] ?? '').trim()) start++
  while (start < footer && !(texts[start] ?? '').trim()) start++

  // Réflexion et outils : jamais dans la réponse. Ils s'intercalent entre les
  // paragraphes, donc on repart après le DERNIER marqueur `• `. Son bloc finit
  // à la première ligne vide, et la réponse commence après.
  let lastMarker = -1
  for (let i = start; i < footer; i++) {
    if (BLOCK_MARKER.test(texts[i] ?? '')) lastMarker = i
  }
  if (lastMarker >= start) {
    start = lastMarker + 1
    while (start < footer && (texts[start] ?? '').trim()) start++
    while (start < footer && !(texts[start] ?? '').trim()) start++

    // Sans réflexion pour nous donner la couleur atténuée, on ne sait pas
    // distinguer une sortie d'outil d'une réponse : on préfère ne rien émettre
    // et livrer d'un bloc en fin de tour.
    if (muted === null) return ''
  }

  const body: string[] = []
  for (let i = start; i < footer; i++) {
    const raw = texts[i] ?? ''
    const text = raw.replace(FENCE, '')

    // Sortie d'outil ou publicité : jamais du contenu, même au milieu. Une
    // ligne VIDE garde son rôle de séparation, quelle que soit sa couleur.
    // Ce test passe AVANT les cadres : les encarts publicitaires ont les même
    // barres verticales qu'un tableau, et s'y arrêter coupait la réponse.
    if (text.trim() && muted !== null && lines[i]?.color === muted) continue

    // Tableau de la réponse : on s'arrête ici, la fin de tour l'apporte en
    // markdown. Continuer après lui perdrait le tableau ou l'afficherait en
    // barres ; l'insérer au milieu est impossible (le flux ne fait qu'allonger).
    // La TUI écrit d'abord le tableau en markdown puis le redessine encadré :
    // dans les deux formes, on s'arrête avant lui.
    if (TABLE_FRAME.test(raw) || TABLE_ROW.test(text)) break
    if (TOOL_COMMAND.test(raw) || SEPARATOR.test(raw)) continue

    if (isChrome(text)) {
      if (body.some(line => line.trim())) break
      continue
    }
    body.push(text)
  }

  // Un tableau à moitié sorti en markdown (`| a | b |` sans sa suite) ne doit
  // pas partir : la fin de tour le livre entier, et le morceau déjà émis
  // serait alors répété. On retire les lignes de tableau restées en fin de corps.
  while (body.length && TABLE_ROW.test(body[body.length - 1] ?? '')) body.pop()

  if (!complete && !live) {
    // La dernière ligne est celle que la TUI est en train d'écrire : elle
    // contient encore le markdown BRUT (`**Vitesse…`) et sera restylée quand
    // elle sera finie. L'émettre figerait les astérisques à vie.
    let last = body.length - 1
    while (last >= 0 && !(body[last] ?? '').trim()) last--
    if (last >= 0) body.splice(last, 1)
  }

  return live ? plainLive(render(body)) : render(body)
}

/**
 * Le texte d'une ligne encore en cours d'écriture, sans son markdown.
 *
 * La TUI peint d'abord les marqueurs bruts (`**Vitesse…`, ```…```) puis applique
 * le style une fois la ligne finie : le texte visible, lui, ne change pas. On
 * retire donc les marqueurs avant de livrer, sinon le style les effacerait après
 * coup et le flux ne pourrait plus que s'allonger (le protocole OpenAI ne sait
 * rien retirer). Les étoiles perdues d'une réponse qui en contient vraiment sont
 * un moindre mal : ce canal n'est qu'un aperçu, le message final vient du
 * transcript, markdown intact.
 */
function plainLive(text: string): string {
  return text.replace(/\*\*|`{1,3}|~~/g, '')
}

/**
 * Texte écrit par l'agent AU-DESSUS d'un panneau de question.
 *
 * Différent de `answerFromScreen` : ici le tour n'est pas fini, la TUI affiche
 * encore le bloc `• Thinking` (ou le marqueur d'un outil), et la question n'a
 * pas été écrite dans le transcript. Mesuré sur un tour réel le 23/10 :
 * `answerFromScreen` rendait `''` faute d'une ligne de réflexion en italique,
 * et la phrase constatant l'état du dossier était perdue.
 *
 * On garde donc tout ce qui suit l'écho de la consigne, en sautant l'interface
 * et les blocs de travail (`• …` et leurs lignes), sans rien exiger de la
 * couleur : c'est du texte, pas un flux à prolonger.
 */
export function panelPreamble(lines: ScreenLine[], prompt: string): string {
  const snippet = prompt.replace(/\s+/g, ' ').trim().slice(0, 24)
  if (!snippet) return ''

  const texts = lines.map(line => line.text)
  let anchor = -1
  for (let i = 0; i < texts.length; i++) {
    const raw = texts[i] ?? ''
    if (isChrome(raw)) continue
    if (!raw.replace(/\s+/g, ' ').includes(snippet)) continue
    anchor = i
  }
  if (anchor === -1) return ''

  // Fin de la consigne recopiée : ce qui suit commence après la ligne vide.
  let start = anchor + 1
  while (start < texts.length && (texts[start] ?? '').trim()) start++

  const body: string[] = []
  let inBlock = false
  for (let i = start; i < texts.length; i++) {
    const raw = texts[i] ?? ''
    const text = raw.replace(FENCE, '')
    if (!text.trim()) {
      inBlock = false
      if (body.length) body.push('')
      continue
    }
    // `• Thinking` et ses lignes : de la réflexion, pas du texte d'agent.
    if (BLOCK_MARKER.test(raw)) {
      inBlock = true
      continue
    }
    if (inBlock) continue
    if (TABLE_FRAME.test(raw) || TABLE_ROW.test(text)) break
    if (TOOL_COMMAND.test(raw) || SEPARATOR.test(raw)) continue
    if (isChrome(text)) continue
    body.push(text)
  }

  return render(body)
}

/**
 * Texte brut d'un markdown : la TUI rend le gras et les titres avec des styles,
 * pas avec des marqueurs, donc l'écran ne les contient jamais. Comparer les deux
 * mondes demande de retirer ces marqueurs de la source.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/^\s*([-*_])\1{2,}\s*$/gm, '') // filet horizontal markdown
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|\n)#{1,6}\s+/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(?!\s)([^*\n]+?)\*/g, '$1')
}

/**
 * Partie du texte affiché qui n'a PAS déjà été livrée.
 *
 * L'écran reprend tout le tour ; le transcript en a déjà livré une partie (les
 * étapes, et les messages déjà terminés). On écarte les paragraphes déjà émis et
 * on ne garde que la suite — le texte que l'agent vient d'écrire avant de poser
 * sa question. Un paragraphe est reconnu par son début : la TUI et le transcript
 * ne découpent pas les lignes de la même façon.
 */
export function uncoveredScreenText(emitted: string, screenText: string): string {
  const delivered = norm(plainText(emitted))
  const paragraphs = screenText.split(/\n{2,}/)
  let first = paragraphs.length
  for (let i = 0; i < paragraphs.length; i++) {
    const flat = norm(paragraphs[i] ?? '')
    if (flat === '') continue
    if (!delivered.includes(flat.slice(0, Math.min(60, flat.length)))) {
      first = i
      break
    }
  }
  return paragraphs.slice(first).join('\n\n').trim()
}

/** Plus long préfixe commun : ce qui est déjà écrit et ne bougera plus. */
export function commonPrefix(a: string, b: string): string {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a[i] === b[i]) i++
  return a.slice(0, i)
}

/** Ce qui a déjà été émis, et la dernière image connue de l'écran. */
export interface StreamState {
  emitted: string
  shown: string
}

export const EMPTY_STREAM: StreamState = { emitted: '', shown: '' }

/** Texte comparable : espaces écrasés (la TUI en ajoute autour du code inline). */
function norm(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Prolongement par une source AUTORITAIRE (le transcript en fin de tour).
 *
 * Pas de règle de stabilité ici : le texte est définitif, on l'ajoute s'il
 * prolonge exactement ce qui est déjà parti. C'est aussi le filet quand l'écran
 * ne donne plus rien — réponse plus longue que l'écran, ancre sortie du tampon.
 */
export function extendEmitted(
  state: StreamState,
  current: string,
): { state: StreamState; delta: string } {
  if (!current.startsWith(state.emitted) || current.length <= state.emitted.length) {
    return { state, delta: '' }
  }
  return {
    state: { emitted: current, shown: current },
    delta: current.slice(state.emitted.length),
  }
}

/**
 * Jusqu'où le flux a réellement livré `candidate`, mesuré au PARAGRAPHE.
 *
 * Comparer caractère par caractère échoue : la TUI ajoute des espaces autour du
 * code inline, remplace les filets markdown et redessine les tableaux. Un
 * paragraphe entier retrouvé dans le flux est une preuve suffisante ; on reprend
 * à la fin du dernier paragraphe prouvé, jamais au milieu d'une phrase.
 */
function coveredParagraphs(emitted: string, candidate: string): number {
  const delivered = norm(emitted)
  let consumed = 0
  let start = 0

  while (start < candidate.length) {
    const sep = candidate.indexOf('\n\n', start)
    const end = sep === -1 ? candidate.length : sep
    const flat = norm(candidate.slice(start, end))
    const proved = flat.length === 0 || delivered.includes(flat.slice(0, Math.min(80, flat.length)))
    if (proved) consumed = end
    start = end + 2
  }
  return consumed
}

/**
 * Fin de tour : livrer la suite même quand l'écran a déjà livré du texte que
 * le rendu final ne reproduit pas (fence de code, style appliqué après coup).
 *
 * On recolle au plus long ancrage commun entre ce qui est affiché et la source
 * autoritaire ; sans ancrage, on n'ajoute rien plutôt que d'inventer.
 */
export function completeWith(
  state: StreamState,
  candidates: string[],
): { state: StreamState; delta: string } {
  for (const candidate of candidates) {
    const direct = extendEmitted(state, candidate)
    if (direct.delta) return direct
  }

  // Rien à ajouter : le flux a DÉJÀ livré tout ce candidat (souvent à la
  // dernière image). Sans cette sortie, la réparation ci-dessous le renvoie
  // entier et la réponse s'affiche deux fois en fin de tour.
  if (candidates.some(candidate => norm(state.emitted).includes(norm(candidate)))) {
    return { state, delta: '' }
  }

  // Le flux a déjà livré une fin que le rendu final ne reproduit pas (fence,
  // style appliqué après coup). On reprend au plus long préfixe commun : la fin
  // arrive, quitte à juxtaposer un petit artefact déjà affiché.
  let best: { prefix: number; candidate: string } | null = null
  for (const candidate of candidates) {
    const prefix = coveredParagraphs(state.emitted, candidate)
    if (best === null || prefix > best.prefix) best = { prefix, candidate }
  }
  if (best === null) return { state, delta: '' }

  // Divergence très tôt : le flux n'a livré qu'un début inutilisable, on peut
  // renvoyer la réponse entière sans grand dommage.
  if (best.prefix < 20) {
    if (state.emitted.length >= 200) return { state, delta: '' }
    const whole = best.candidate
    return { state: { emitted: whole, shown: whole }, delta: whole }
  }

  const delta = best.candidate.slice(best.prefix).replace(/^\n+/, '')
  if (!delta) return { state, delta: '' }

  // Le raccord se fait entre deux paragraphes : la séparation part avec le
  // delta. Sans elle, la suite se collerait au texte déjà affiché (un tableau
  // précédé de « Synthèse » ne serait plus rendu comme un tableau).
  const spacing = state.emitted.endsWith('\n\n') ? '' : state.emitted.endsWith('\n') ? '\n' : '\n\n'
  const appended = `${spacing}${delta}`
  const emitted = `${state.emitted}${appended}`
  return { state: { emitted, shown: emitted }, delta: appended }
}

/**
 * Le delta à envoyer pour une nouvelle image, et l'état qui en découle.
 *
 * Deux garanties, et c'est tout l'intérêt du module :
 * - le texte émis ne fait que s'allonger (jamais de retrait, jamais de doublon) ;
 * - une image encore instable (la TUI redessine) n'ajoute rien.
 */
export function advanceStream(
  state: StreamState,
  current: string,
): { state: StreamState; delta: string } {
  const stable = commonPrefix(state.shown, current)
  const grows = stable.length > state.emitted.length && stable.startsWith(state.emitted)
  if (!grows) return { state: { emitted: state.emitted, shown: current }, delta: '' }
  return {
    state: { emitted: stable, shown: current },
    delta: stable.slice(state.emitted.length),
  }
}
