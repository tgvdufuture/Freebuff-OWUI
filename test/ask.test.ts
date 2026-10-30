import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MORE_OPTIONS_LABEL,
  SUBMIT_KEYS,
  answerFromToolContent,
  askPanelFromScreen,
  askPanelVisible,
  keyTokens,
  keysForMultiNext,
  keysForSelection,
  settledPanel,
  optionIndexFor,
  optionKeys,
  panelTop,
  customOptionIndex,
  renderQuestion,
  sameQuestion,
  selectableOptions,
  selectionFor,
  toolArguments,
  type AskPanel,
} from '../src/freebuff/ask.ts'

/** Lignes réellement capturées en S2 (`spike/s7/raw.jsonl`, écran émulé). */
const capturedPanel = [
  '╭─────────────────────────────────────────────── Some questions for you ───────────────────────────────────────────────╮',
  '│                                                                                                               Close ✕│',
  '│                                                                                                                      │',
  '│▼ Quel contenu veux-tu dans le fichier notes.txt ?                                                                    │',
  '│  ○ bonjour                                                                                                           │',
  '│    Le fichier contiendra « bonjour »                                                                                 │',
  '│  ○ au revoir                                                                                                         │',
  '│  ○ Custom                                                                                                            │',
  '│                                                                                                                      │',
  '│╭──────────╮                                                                                                          │',
  '││  Submit  │    ↑↓ navigate • Enter select                                                                            │',
  '│╰──────────╯                                                                                                          │',
  '╰───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯',
  ' MiMo v2.6 Flash Slow · D:\\code\\sandbox · /model to change · Chat: notes',
  ' ← for history · ? for help',
].map(text => ({ text }))

test('le panneau commence à sa ligne de titre, tout ce qui précède est du texte', () => {
  assert.equal(panelTop(capturedPanel), 0)
  assert.equal(panelTop([{ text: '  une ligne' }, { text: '  une autre' }]), -1)
})

const chromium = [
  '   ███████████   ▄████',
  '   ╭──────────────────────────────────────╮',
  '   │  ▍Enter a coding task or / for commands │',
  '   ╰──────────────────────────────────────╯',
  '   59m left · 12.6K (10%)',
].map(text => ({ text }))

test('une réponse libre passe par la ligne « Custom » de la TUI', () => {
  const panel = askPanelFromScreen(capturedPanel)
  assert.notEqual(panel, null)
  if (panel === null) return

  // « Custom » est la dernière ligne du panneau BRUT, et n'est pas un choix.
  assert.equal(customOptionIndex(panel), 2)
  assert.deepEqual(
    selectableOptions(panel).map(option => option.label),
    ['bonjour', 'au revoir'],
  )

  // Un panneau sans champ libre ne doit pas recevoir de texte inventé.
  assert.equal(customOptionIndex({ ...panel, options: panel.options.slice(0, 2) }), null)
})

test('le panneau relu après un choix n’est pas une question suivante', () => {
  const answered = askPanelFromScreen(capturedPanel)
  assert.notEqual(answered, null)
  if (answered === null) return

  // La TUI garde le panneau affiché, la puce du choix remplie : c'est la même
  // question, elle attend `Submit`.
  const reread = askPanelFromScreen(
    capturedPanel.map(line => ({ text: line.text.replace('○ bonjour', '● bonjour') })),
  )
  assert.notEqual(reread, null)
  if (reread === null) return
  assert.equal(sameQuestion(answered, reread), true)

  // Une vraie question suivante change de rang (et de texte).
  const next: AskPanel = {
    question: 'Quelle taille ?',
    options: [
      { label: 'petite', description: null },
      { label: 'grande', description: null },
    ],
    complex: false,
    step: { index: 1, total: 2 },
  }
  const first = { ...answered, step: { index: 0, total: 2 } }
  assert.equal(sameQuestion(first, next), false)

  // Même rang mais autre texte : c'est aussi une autre question.
  assert.equal(sameQuestion(first, { ...first, question: 'Autre question ?' }), false)
})

test('le panneau capturé donne la question et les options avec leur description', () => {
  const panel = askPanelFromScreen(capturedPanel)

  assert.notEqual(panel, null)
  assert.equal(panel?.question, 'Quel contenu veux-tu dans le fichier notes.txt ?')
  assert.deepEqual(panel?.options, [
    { label: 'bonjour', description: 'Le fichier contiendra « bonjour »' },
    { label: 'au revoir', description: null },
    { label: 'Custom', description: null },
  ])
  assert.equal(panel?.complex, false)
})

test('sans panneau, aucune détection : l’interface seule ne pose pas de question', () => {
  assert.equal(askPanelFromScreen(chromium), null)
  assert.equal(askPanelFromScreen([]), null)
})

test('un panneau à cases cochées est reconnu comme multi-sélection', () => {
  // Panneau réellement capturé en S8 (`spike/s8`), écran émulé.
  const rows = [
    '╭──── Some questions for you ────╮',
    '│▼ Que souhaitez-vous traiter ?',
    '│(Select multiple options)',
    '│  ☐ tests',
    '│  ☐ documentation',
    '│  ☐ performance',
    '│  ☐ Custom',
    '││  Submit  │  ↑↓ navigate • Enter select',
  ].map(text => ({ text }))

  const panel = askPanelFromScreen(rows)
  assert.equal(panel?.multi, true)
  assert.equal(panel?.complex, false)
  assert.deepEqual(
    panel?.options.map(option => option.label),
    ['tests', 'documentation', 'performance', 'Custom'],
  )

  // La carte locale patchée coche plusieurs cases : les trois options réelles
  // partent dans UNE question, et « Custom » reste dehors.
  const args = toolArguments(panel!) as {
    questions: Array<{ id: string; options: Array<{ label: string }>; multi_select: boolean; allow_other: boolean }>
    allow_other: boolean
  }
  assert.equal(args.questions.length, 1)
  assert.equal(args.questions[0]?.id, 'freebuff-q1-multi')
  assert.equal(args.questions[0]?.multi_select, true)
  assert.deepEqual(
    args.questions[0]?.options.map(option => option.label),
    ['tests', 'documentation', 'performance'],
  )
  // Le champ libre écraserait la sélection : on le ferme.
  assert.equal(args.questions[0]?.allow_other, false)
  assert.equal(args.allow_other, false)

  // Le texte numéroté reste le repli (plus de 3 options, client sans carte).
  assert.match(renderQuestion(panel!), /numéros/i)
})

test('toutes les cases tiennent dans UNE carte, sans pagination (plafond levé)', () => {
  const rows = [
    '╭──── Some questions for you ────╮',
    '│▼ Quels dossiers ?',
    '│(Select multiple options)',
    '│  ☐ src',
    '│  ☐ test',
    '│  ☐ scripts',
    '│  ☐ docs',
    '││  Submit  │  ↑↓ navigate • Enter select',
  ].map(text => ({ text }))

  const panel = askPanelFromScreen(rows)!
  assert.equal(panel.multi, true)
  const args = toolArguments(panel) as {
    questions: Array<{ multi_select: boolean; options: Array<{ label: string }> }>
  }
  assert.deepEqual(
    args.questions[0]?.options.map(option => option.label),
    ['src', 'test', 'scripts', 'docs'],
    'les quatre cases partent dans la même carte',
  )
  assert.equal(args.questions[0]?.multi_select, true)
  assert.equal(args.questions[0]?.options.some(o => o.label.includes('Autres options')), false)

  // Au-delà du plafond du patch (10), le texte numéroté reste la seule voie.
  const eleven: AskPanel = {
    ...panel,
    options: Array.from({ length: 11 }, (_, i) => ({ label: `opt${i + 1}`, description: null })),
  }
  assert.equal(toolArguments(eleven), null)
  assert.match(renderQuestion(eleven), /11\. \*\*opt11\*\*/)
})

test('une réponse cochée nomme exactement ses cases, sans découpage du libellé', () => {
  const panel = askPanelFromScreen(
    [
      '╭──── Some questions for you ────╮',
      '│▼ Que souhaitez-vous traiter ?',
      '│(Select multiple options)',
      '│  ☐ tests',
      '│  ☐ tests et performance',
      '│  ☐ doc, schémas',
      '│  ☐ Custom',
      '││  Submit  │  ↑↓ navigate • Enter select',
    ].map(text => ({ text })),
  )!

  const answer = (labels: string[]) =>
    JSON.stringify({ status: 'answered', answers: { 'freebuff-q1-multi': { type: 'options', option_indices: [0], labels } } })

  // La carte envoie les libellés exacts : virgule et « et » internes intacts.
  const text = answerFromToolContent(answer(['tests et performance', 'doc, schémas']))
  assert.equal(text, JSON.stringify(['tests et performance', 'doc, schémas']))
  assert.deepEqual(selectionFor(text!, panel), [1, 2])
  assert.deepEqual(selectionFor(answerFromToolContent(answer(['tests']))!, panel), [0])

  // Un libellé que la carte n'a pas proposé n'invente aucune case.
  assert.equal(selectionFor(answerFromToolContent(answer(['tests', 'inconnu']))!, panel), null)
  assert.equal(answerFromToolContent(answer([])), null, 'aucune case cochée')
})

test('une forme de panneau jamais rencontrée reste hors périmètre', () => {
  // Chevrons NON numérotés : la CLI ne les a jamais produits, on ne devine pas.
  const twoQuestions = [
    '╭──── Some questions for you ────╮',
    '│▼ Première question ?',
    '│  ○ oui',
    '│▼ Seconde question ?',
    '│  ○ non',
    '││  Submit  │  ↑↓ navigate • Enter select',
  ].map(text => ({ text }))

  assert.equal(askPanelFromScreen(twoQuestions)?.complex, true)
})

/** Panneau à trois questions réellement capturé en S9 (`spike/s9`). */
const capturedSteps = [
  '╭────────────────────── Some questions for you ──────────────────────╮',
  '│                                                              Close ✕│',
  '│                                                                     │',
  '│▶ 1. Quelle couleur ?                                                │',
  '│   ↳ "bleu"                                                          │',
  '│                                                                     │',
  '│▼ 2. Quelle taille ?                                                 │',
  '│     ○ petite                                                        │',
  '│       Petite taille                                                 │',
  '│     ○ grande                                                        │',
  '│     ○ Custom                                                        │',
  '│                                                                     │',
  '│▶ 3. Quelle forme ?                                                  │',
  '│   ↳ (click to answer)                                               │',
  '│╭──────────╮                                                         │',
  '││  Submit  │    ↑↓ navigate • Enter select                           │',
  '╰─────────────────────────────────────────────────────────────────────╯',
].map(text => ({ text }))

test('plusieurs questions : seule la dépliée est lue, avec son rang', () => {
  const panel = askPanelFromScreen(capturedSteps)

  assert.notEqual(panel, null)
  // La TUI ne montre les options que de la question ouverte.
  assert.equal(panel?.question, 'Quelle taille ?')
  assert.deepEqual(panel?.step, { index: 1, total: 3 })
  assert.deepEqual(
    panel?.options.map(option => option.label),
    ['petite', 'grande', 'Custom'],
  )
  assert.equal(panel?.complex, false)

  // Toutes répondues : plus rien à remplir (le pont valide alors le panneau).
  const answered = capturedSteps.map(line =>
    line.text.includes('▼ 2. Quelle taille ?') ? { text: line.text.replace('▼', '▶') } : line,
  )
  assert.equal(askPanelFromScreen(answered), null)
  // …mais le panneau est toujours là : il attend qu'on presse `Submit`.
  assert.equal(askPanelVisible(answered), true)
})

test('une question de plusieurs est posée seule, avec son rang', () => {
  const panel = askPanelFromScreen(capturedSteps)!
  const rendered = renderQuestion(panel)

  assert.match(rendered, /Question 2 sur 3/)
  assert.match(rendered, /1\. \*\*petite\*\* — Petite taille/)
  assert.match(rendered, /2\. \*\*grande\*\*/)
  assert.doesNotMatch(rendered, /Custom/)

  // La carte native porte la question courante : une carte par question.
  const args = toolArguments(panel) as { questions: Array<{ id: string; options: Array<{ label: string }> }> }
  assert.equal(args.questions.length, 1)
  assert.equal(args.questions[0]?.id, 'freebuff-q2-s0')
  assert.deepEqual(
    args.questions[0]?.options.map(option => option.label),
    ['petite', 'grande'],
  )
})

test('des cases à cocher dans un panneau à plusieurs questions sont pilotées (S10)', () => {
  // Panneau réellement capturé en S10 (`spike/s10`) : la question 1 est
  // cochable, la 2 est pliée.
  const rows = [
    '╭──── Some questions for you ────╮',
    '│▼ 1. Quels fichiers ?',
    '│(Select multiple options)',
    '│  ☐ a.ts',
    '│  ☐ b.ts',
    '│▶ 2. Quel format ?',
    '││  Submit  │  ↑↓ navigate • Enter select',
  ].map(text => ({ text }))

  const panel = askPanelFromScreen(rows)!
  assert.equal(panel.multi, true)
  assert.deepEqual(panel.step, { index: 0, total: 2 })
  assert.equal(panel.complex, false, 'la combinaison a été mesurée en S10')

  const args = toolArguments(panel) as {
    questions: Array<{ id: string; multi_select: boolean; options: Array<{ label: string }> }>
  }
  assert.equal(args.questions[0]?.id, 'freebuff-q1-multi')
  assert.equal(args.questions[0]?.multi_select, true)
  assert.deepEqual(args.questions[0]?.options.map(option => option.label), ['a.ts', 'b.ts'])

  const rendered = renderQuestion(panel)
  assert.match(rendered, /Question 1 sur 2/)
  assert.match(rendered, /Coche ce que tu veux/)
})

test('les cases cochées ouvrent la question suivante sans jamais valider (S10)', () => {
  const rows = [
    '╭──── Some questions for you ────╮',
    '│▼ 1. Quels dossiers ?',
    '│(Select multiple options)',
    '│  ☐ src',
    '│  ☐ test',
    '│  ☐ docs',
    '│  ☐ Custom',
    '│▶ 2. Quel format ?',
  ].map(text => ({ text }))
  const panel = askPanelFromScreen(rows)!

  // Mesuré : depuis « src », 4 `↓` dépassent la dernière ligne (« Custom »
  // comprise) et ouvrent la question 2.
  assert.equal(keysForMultiNext([0], panel), ' ' + '\x1b[B'.repeat(4))
  // Depuis « test » (indice 1), il reste trois lignes à descendre.
  assert.equal(keysForMultiNext([1], panel), '\x1b[B ' + '\x1b[B'.repeat(3))
  // Deux cases cochées : le curseur finit sur la seconde, plus que deux `↓`.
  assert.equal(keysForMultiNext([0, 2], panel), ' \x1b[B\x1b[B ' + '\x1b[B'.repeat(2))

  // Jamais de Tab/Entrée : la CLI validerait le panneau avec des questions vides.
  assert.doesNotMatch(keysForMultiNext([0], panel), /[\t\r]/)
  // La dernière question, elle, se valide bien.
  assert.match(keysForSelection([0]), /\t\r$/)
})

test('la question rendue pour OpenWebUI numérote les options avec leur description', () => {
  const panel = askPanelFromScreen(capturedPanel)
  assert.notEqual(panel, null)
  const rendered = renderQuestion(panel!)

  assert.match(rendered, /Quel contenu veux-tu dans le fichier notes\.txt \?/)
  assert.match(rendered, /1\. \*\*bonjour\*\* — Le fichier contiendra « bonjour »/)
  assert.match(rendered, /2\. \*\*au revoir\*\*/)
  assert.doesNotMatch(rendered, /Custom/, 'la saisie libre est celle d’OpenWebUI')
  assert.match(rendered, /numéro/i)
})

test('le numéro ou le libellé désignent la même option, le reste est refusé', () => {
  const panel = askPanelFromScreen(capturedPanel)!

  assert.equal(optionIndexFor('2', panel), 1)
  assert.equal(optionIndexFor('au revoir', panel), 1)
  assert.equal(optionIndexFor('  Au   Revoir ', panel), 1)
  assert.equal(optionIndexFor('1', panel), 0)

  // Aucune réponse n'est inventée : hors options, on ne choisit rien.
  assert.equal(optionIndexFor('4', panel), null)
  assert.equal(optionIndexFor('0', panel), null)
  assert.equal(optionIndexFor('', panel), null)
  assert.equal(optionIndexFor('fais comme tu veux', panel), null)
})

test('les arguments respectent le contrat OpenWebUI : 2-3 options, description obligatoire', () => {
  const panel = askPanelFromScreen(capturedPanel)!
  const args = toolArguments(panel) as {
    questions: Array<{ id: string; question: string; options: Array<{ label: string; description: string }> }>
    allow_other: boolean
  }

  assert.equal(args.questions.length, 1)
  assert.equal(args.questions[0]?.question, 'Quel contenu veux-tu dans le fichier notes.txt ?')
  // « Custom » est retiré : c'est le champ de saisie de la CLI, doublon du
  // champ libre natif d'OWUI (`allow_other`).
  assert.deepEqual(
    args.questions[0]?.options.map(option => option.label),
    ['bonjour', 'au revoir'],
  )
  // OWUI refuse une option sans description : on ne laisse jamais le champ vide.
  assert.deepEqual(args.questions[0]?.options[1], { label: 'au revoir', description: 'au revoir' })
  assert.equal(args.allow_other, true)

  // Plus de 3 options : carte paginée, 2 choix + « Autres options… ».
  const five = {
    question: 'Sur quoi travailler ?',
    options: ['un', 'deux', 'trois', 'quatre', 'cinq'].map(label => ({ label, description: null })),
    complex: false,
  }
  const first = toolArguments(five) as { questions: Array<{ options: Array<{ label: string }> }> }
  assert.deepEqual(
    first.questions[0]?.options.map(option => option.label),
    ['un', 'deux', MORE_OPTIONS_LABEL],
  )

  const second = toolArguments(five, 1) as { questions: Array<{ options: Array<{ label: string }> }> }
  assert.deepEqual(
    second.questions[0]?.options.map(option => option.label),
    ['trois', 'quatre', 'cinq'],
  )
  assert.equal(toolArguments(five, 2), null, 'au-delà de la dernière page, rien')

  // Hors contrat : plusieurs questions ou cases à cocher non mesurées.
  assert.equal(toolArguments({ ...panel, complex: true }), null)

  // Une question simple n'active jamais les cases à cocher.
  assert.equal((args.questions[0] as { multi_select?: boolean }).multi_select, undefined)
})

test('« Custom » n’est ni proposé ni choisissable : le texte libre passe par OWUI', () => {
  const panel = askPanelFromScreen(capturedPanel)!

  // Le panneau lu garde la ligne (les indices de la TUI ne bougent pas)…
  assert.equal(panel.options.at(-1)?.label, 'Custom')
  // …mais elle n'est ni dans la carte, ni dans le texte, ni sélectionnable.
  assert.equal(selectableOptions(panel).some(option => /custom/i.test(option.label)), false)
  assert.doesNotMatch(renderQuestion(panel), /Custom/)
  assert.equal(optionIndexFor('Custom', panel), null)
  assert.equal(optionIndexFor('3', panel), null, 'la 3e ligne du panneau est Custom')
})

test('« Autres options… » ne doit jamais coller à un vrai libellé', () => {
  assert.equal(MORE_OPTIONS_LABEL.trim().includes('option'), true)
  assert.doesNotMatch(MORE_OPTIONS_LABEL, /^[\w\d]/)
})

 test('la réponse de la carte donne le libellé choisi, sinon le texte libre', () => {
  const chosen = JSON.stringify({
    status: 'answered',
    answers: { 'freebuff-q1': { type: 'option', option_index: 1, label: 'au revoir', description: 'x' } },
  })
  const written = JSON.stringify({
    status: 'answered',
    answers: { 'freebuff-q1': { type: 'other', text: '  ni l’un ni l’autre ' } },
  })

  assert.equal(answerFromToolContent(chosen), 'au revoir')
  assert.equal(answerFromToolContent(written), 'ni l’un ni l’autre')

  // Rien de deviné : annulé, vide ou illisible ne produisent aucune réponse.
  assert.equal(answerFromToolContent(JSON.stringify({ status: 'cancelled', answers: {} })), null)
  assert.equal(answerFromToolContent('pas du json'), null)
  assert.equal(answerFromToolContent(JSON.stringify({ status: 'answered', answers: {} })), null)
})

test('plusieurs choix dans un message cochent les bonnes cases puis valident', () => {
  const panel = askPanelFromScreen(
    [
      '╭──── Some questions for you ────╮',
      '│▼ Que souhaitez-vous traiter ?',
      '│(Select multiple options)',
      '│  ☐ tests',
      '│  ☐ documentation',
      '│  ☐ performance',
      '│  ☐ Custom',
      '││  Submit  │  ↑↓ navigate • Enter select',
    ].map(text => ({ text })),
  )!

  assert.deepEqual(selectionFor('1, 3', panel), [0, 2])
  assert.deepEqual(selectionFor('tests et performance', panel), [0, 2])
  assert.deepEqual(selectionFor('Tests,  performance', panel), [0, 2])
  assert.deepEqual(selectionFor('3', panel), [2])

  // Rien d'inventé : « Custom » n'est plus proposé, et un inconnu annule tout.
  assert.equal(selectionFor('Custom', panel), null)
  assert.equal(selectionFor('1, inconnu', panel), null)
  assert.equal(selectionFor('', panel), null)

  // Mesuré en S8 : Espace coche, ↓ descend, Tab puis Entrée valident.
  assert.equal(keysForSelection([0, 2]), ' \x1b[B\x1b[B \t\r')
  assert.equal(keysForSelection([2, 0]), ' \x1b[B\x1b[B \t\r', 'toujours croissant')
  assert.equal(keysForSelection([1]), '\x1b[B \t\r')
})

test('un panneau lu pendant sa peinture n’est jamais rendu (une option = pas fini)', async () => {
  const partial: AskPanel = {
    question: 'Café ou thé pour coder ?',
    options: [{ label: 'Café ☕ — Espresso, filtre, latte…', description: null }],
    complex: false,
    step: { index: 0, total: 2 },
  }
  const complete: AskPanel = {
    ...partial,
    options: [
      { label: 'Café ☕ — Espresso, filtre, latte…', description: null },
      { label: 'Thé 🍵 — Vert, noir, matcha', description: null },
    ],
  }

  const scripted = (panels: Array<AskPanel | null>) => {
    let i = 0
    return async () => panels[Math.min(i++, panels.length - 1)] ?? null
  }

  // Première frame : une seule option. Le pont attend la suivante.
  assert.equal(
    await settledPanel(scripted([partial, complete]), async () => {}),
    complete,
  )

  // Une option répétée ne devient jamais un panneau valide.
  assert.equal(await settledPanel(scripted([partial]), async () => {}, 3, 0), null)

  // Rien à l'écran : rien à rendre.
  assert.equal(await settledPanel(scripted([null]), async () => {}), null)
})

test('les touches sont celles mesurées : ↓ par option, puis Entrée', () => {
  // S9 : le curseur part SUR la première option — un `↓` de trop cochait la
  // voisine. `Submit` se presse à part (`Tab` + `Entrée`).
  assert.equal(optionKeys(0), '\r')
  assert.equal(optionKeys(1), '\x1b[B\r')
  assert.equal(optionKeys(2), '\x1b[B\x1b[B\r')
  assert.equal(SUBMIT_KEYS, '\t\r')
})

test('les gestes partent séparément : ↓ puis Entrée, jamais collés', () => {
  // Mesuré en vrai : écrits d'un trait, `↓` puis `Entrée` répondent à l'option
  // survolée AVANT le déplacement (mauvaise réponse sur 2 questions sur 3).
  assert.deepEqual(keyTokens(optionKeys(2)), ['\x1b[B', '\x1b[B', '\r'])
  assert.deepEqual(keyTokens(SUBMIT_KEYS), ['\t', '\r'])
  assert.deepEqual(keyTokens(keysForSelection([0, 2])), [' ', '\x1b[B', '\x1b[B', ' ', '\t', '\r'])
})
