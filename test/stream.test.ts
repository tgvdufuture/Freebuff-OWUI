import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EMPTY_STREAM,
  advanceStream,
  answerFromScreen,
  completeWith,
  extendEmitted,
  panelPreamble,
  plainText,
  uncoveredScreenText,
  type ScreenLine,
  type StreamState,
} from '../src/freebuff/stream.ts'
import { panelTop } from '../src/freebuff/ask.ts'
import { ScreenView } from '../src/freebuff/vt.ts'

const PROMPT =
  'Explique en quatre phrases simples la différence entre latence et débit. ' +
  'N’utilise aucun outil et ne modifie aucun fichier.'

const screen = (...rows: string[]): ScreenLine[] => rows.map(text => ({ text }))

/** Écran réel d'un tour terminé (forme mesurée en S6, largeur réduite). */
const finishedTurn = (...answer: string[]) =>
  screen(
    '   ███████████   ▄████',
    '   ╭──────────────────────────────────────╮',
    '   │ Session active                       │',
    '   │ 10/12 hours remaining                 │',
    '   ╰──────────────────────────────────────╯',
    '   [09:17]',
    '   Explique en quatre phrases simples la différence entre latence et',
    '   débit. N’utilise aucun outil. ⎘',
    '',
    ...answer,
    '                                                ⎘ • 4s • △▽   █',
    '   ╭──────────────────────────────────────╮',
    '   │  ▍Enter a coding task or / for commands │',
    '   ╰──────────────────────────────────────╯',
    '   59m left · 12.6K (10%)                    ✕ End session',
    '   MiMo v2.6 Flash Slow · /model to change · Chat: Explique en quatre',
    '   phrases simples la différence entre latence et débit',
    '   ← for history · ? for help',
  )

test('la réponse vient de l’écran, sans l’écho de la consigne ni l’interface', () => {
  const lines = finishedTurn(
    "   La latence, c'est le temps d'attente avant de recevoir le premier",
    "   bit d'une réponse, soit la rapidité d'un seul échange.",
  )
  assert.equal(
    answerFromScreen(lines, PROMPT, true),
    "La latence, c'est le temps d'attente avant de recevoir le premier bit d'une réponse, soit la rapidité d'un seul échange.",
  )
})

test('sans écho de la consigne, rien n’est émis', () => {
  const lines = screen('   ███████████   ▄████', '', '   Enter a coding task or / for commands')
  assert.equal(answerFromScreen(lines, PROMPT), '')
})

test('un tableau de la TUI arrête le flux au lieu d’afficher des barres', () => {
  const lines = finishedTurn(
    '   Voici les deux mesures :',
    '   ┌──────────┬──────────┐',
    '   │ Fichier  │ Latence  │',
    '   ├──────────┼──────────┤',
    '   │ a.txt    │ 12 ms    │',
    '   └──────────┴──────────┘',
    '',
    '   Le débit reste stable.',
  )

  assert.equal(answerFromScreen(lines, PROMPT, true), 'Voici les deux mesures :')
})

test('la fin de tour rend le tableau en markdown, sans répéter le texte déjà émis', () => {
  const answer =
    'Voici les deux mesures :\n\n' +
    '| Fichier | Latence |\n| --- | --- |\n| a.txt | 12 ms |\n\n' +
    'Le débit reste stable.'
  const lines = finishedTurn(
    '   Voici les deux mesures :',
    '   ┌──────────┬──────────┐',
    '   │ a.txt    │ 12 ms    │',
    '   └──────────┴──────────┘',
    '',
    '   Le débit reste stable.',
  )

  const streamed = completeWith(EMPTY_STREAM, [answerFromScreen(lines, PROMPT, true)])
  const fin = completeWith(streamed.state, [answer, plainText(answer)])

  assert.equal(fin.state.emitted, answer)
  assert.equal(streamed.state.emitted + fin.delta, answer, 'ce que reçoit le client doit être le texte final')
  assert.equal(fin.delta.match(/Le débit reste stable/g)?.length, 1, 'texte final dupliqué')
  assert.match(fin.delta, /\| --- \| --- \|/, 'le tableau doit revenir en markdown')
  assert.doesNotMatch(fin.delta, /[│┼│├┤┬┴]/, 'aucun cadre de tableau ne doit passer')
})

test('le texte écrit juste avant une question part sans répéter les étapes', () => {
  // Écran réel d'un tour qui pose une question : le préambule est affiché, la
  // question est dans le panneau du bas. Le pont, lui, a déjà livré les étapes.
  const rows = screen(
    '   [09:17]',
    '   Explique en quatre phrases simples la différence entre latence et',
    '   débit. N’utilise aucun outil. ⎘',
    '',
    '   Les deux mesures ne sont pas la même chose.',
    '',
    '   Voici ce qu’il me faut avant de coder :',
    '',
    '   Es-tu en micro-entreprise ?',
    '',
    '   ╭──────────── Some questions for you ────────────╮',
    '   │▼ Quel régime de TVA ?                          │',
    '   │  ○ franchise                                   │',
    '   │  ○ 20 %                                        │',
    '   │  ○ Custom                                      │',
    '   │╭──────────╮    ↑↓ navigate • Enter select      │',
    '   ││  Submit  │                                   │',
    '   │╰──────────╯                                   │',
    '   ╰────────────────────────────────────────────────╯',
    '   MiMo v2.6 Flash Slow · /model to change · Chat: Explique en quatre',
    '   ← for history · ? for help',
  )

  // Le cadre du panneau arrête déjà la lecture ; la coupure à `panelTop`
  // garantit la même chose même si la TUI le dessine sans bord.
  assert.doesNotMatch(answerFromScreen(rows, PROMPT, true), /Quel régime de TVA/)

  const top = panelTop(rows)
  assert.equal(top, 10)
  const shown = answerFromScreen(rows.slice(0, top), PROMPT, true)

  const head = '🔧 **read_files** — `a.ts`\n\nLes deux mesures ne sont pas la même chose.'
  assert.equal(
    uncoveredScreenText(head, shown),
    'Voici ce qu’il me faut avant de coder :\n\nEs-tu en micro-entreprise ?',
  )
  // Rien de livré : tout ce que l'écran montre est gardé.
  assert.equal(uncoveredScreenText('', shown), shown)
})

test('deux paragraphes restent deux paragraphes', () => {
  const lines = finishedTurn(
    '   La latence mesure le délai du premier bit.',
    '',
    '   Le débit mesure le volume par seconde.',
  )
  assert.equal(
    answerFromScreen(lines, PROMPT, true),
    'La latence mesure le délai du premier bit.\n\nLe débit mesure le volume par seconde.',
  )
})

test('un tour précédent n’est jamais repris : seule la dernière consigne compte', () => {
  const previous = 'Explique la différence entre une pile et une file.'
  const lines = screen(
    '   [09:01]',
    `   ${previous} ⎘`,
    '',
    '   Une pile est LIFO, une file est FIFO.',
    '',
    '   [09:17]',
    '   Explique en quatre phrases simples la différence entre latence et',
    '   débit. N’utilise aucun outil. ⎘',
    '',
    '   La latence est un délai, le débit un volume.',
    '   ╭──────────────────────────────────────╮',
    '   │  ▍Enter a coding task or / for commands │',
    '   ╰──────────────────────────────────────╯',
    '   MiMo v2.6 Flash Slow · /model to change · Chat: Explique en quatre',
  )
  assert.equal(answerFromScreen(lines, PROMPT, true), 'La latence est un délai, le débit un volume.')
})

test('réflexion et blocs d’outils n’entrent jamais dans la réponse', () => {
  const lines: ScreenLine[] = [
    { text: '   [09:17]' },
    { text: '   Explique en quatre phrases simples la différence entre latence et' },
    { text: '   débit. N’utilise aucun outil. ⎘' },
    { text: '' },
    { text: '   • Thinking' },
    { text: '   Let me explore the directory first.', italic: true, color: 11318207 },
    { text: '' },
    { text: '   • List .' },
    { text: '   • Read NOTES.md, README.md, main.ts' },
    { text: '' },
    { text: '   • Thinking' },
    { text: '   The capture file does not exist, let me check.', italic: true, color: 11318207 },
    { text: '' },
    { text: '   La latence est un délai, le débit un volume.' },
    { text: '   - Un point de la réponse' },
    { text: '   ╭──────────────────────────────────────╮' },
    { text: '   │  ▍Enter a coding task or / for commands │' },
    { text: '   MiMo v2.6 Flash Slow · /model to change · Chat: Explique en quatre' },
  ]
  assert.equal(
    answerFromScreen(lines, PROMPT, true),
    'La latence est un délai, le débit un volume.\n- Un point de la réponse',
  )
})

test('après une divergence, la fin est ajoutée au paragraphe près', () => {
  // Le flux a livré une fin que le rendu final ne reproduit pas (fence de code).
  const state = { emitted: 'Intro du sujet.\n\nDeuxième paragraphe.```', shown: '' }
  const final = 'Intro du sujet.\n\nDeuxième paragraphe.\n\nTroisième paragraphe, jamais livré.'

  const next = completeWith(state, [final])
  // La séparation de paragraphe part avec le delta : sinon la suite arrive
  // collée au texte déjà affiché.
  assert.equal(next.delta, '\n\nTroisième paragraphe, jamais livré.')
  assert.equal(next.state.emitted, 'Intro du sujet.\n\nDeuxième paragraphe.```\n\nTroisième paragraphe, jamais livré.')
})

test('le filet de fin de tour prolonge sans exiger d’image stable', () => {
  const state = { emitted: 'Description du dossier', shown: '' }

  const next = extendEmitted(state, 'Description du dossier\n\nCe dépôt contient 3 fichiers.')
  assert.equal(next.delta, '\n\nCe dépôt contient 3 fichiers.')
  assert.equal(next.state.emitted, 'Description du dossier\n\nCe dépôt contient 3 fichiers.')

  // Un texte qui ne prolonge pas exactement ce qui est parti n'ajoute rien.
  assert.equal(extendEmitted(next.state, 'Autre chose').delta, '')
})

test('en direct, la ligne en cours part sans ses marqueurs markdown', () => {
  const lines = screen(
    '   [09:17]',
    '   Explique en quatre phrases simples la différence entre latence et',
    '   débit. N’utilise aucun outil. ⎘',
    '',
    '   La latence est un délai.',
    '',
    '   **Vitesse moyenne : 80',
    '   MiMo v2.6 Flash Slow · /model to change · Chat: Explique en quatre',
  )

  // Tour en cours : la ligne brute reste retenue pour le rendu qui s'allonge.
  assert.equal(answerFromScreen(lines, PROMPT), 'La latence est un délai.')
  // Canal direct : elle part, et sans les `**` que la TUI enlèvera au style.
  assert.equal(
    answerFromScreen(lines, PROMPT, false, true),
    'La latence est un délai.\n\nVitesse moyenne : 80',
  )
})

test('le direct avance au mot, image par image', () => {
  const frame = (tail: string) =>
    screen(
      '   [09:17]',
      '   Explique en quatre phrases simples la différence entre latence et',
      '   débit. N’utilise aucun outil. ⎘',
      '',
      '   La latence est un délai,',
      `   ${tail}`,
      '   MiMo v2.6 Flash Slow · /model to change · Chat: Explique en quatre',
    )

  let state = EMPTY_STREAM
  const deltas: string[] = []
  // Deux images par étape : une image seule ne prouve pas la stabilité.
  const frames = ['le débit', 'le débit', 'le débit un volume', 'le débit un volume', 'le débit un volume.', 'le débit un volume.']
  for (const tail of frames) {
    const next = advanceStream(state, answerFromScreen(frame(tail), PROMPT, false, true))
    state = next.state
    if (next.delta !== '') deltas.push(next.delta)
  }

  // Plusieurs petits morceaux, pas un bloc à la fin de la ligne.
  assert.ok(deltas.length >= 3, `pas de flux au mot : ${JSON.stringify(deltas)}`)
  assert.equal(state.emitted, 'La latence est un délai, le débit un volume.')
})

test('une ligne en cours d’écriture n’est jamais émise (markdown brut)', () => {
  const lines = screen(
    '   [09:17]',
    '   Explique en quatre phrases simples la différence entre latence et',
    '   débit. N’utilise aucun outil. ⎘',
    '',
    '   La latence est un délai.',
    '',
    '   **Vitesse moyenne : 80',
    '   MiMo v2.6 Flash Slow · /model to change · Chat: Explique en quatre',
  )
  // Pendant le tour, la dernière ligne est encore du markdown brut.
  assert.equal(answerFromScreen(lines, PROMPT), 'La latence est un délai.')
  // Tour fini : elle ne bougera plus, on peut la prendre.
  assert.equal(
    answerFromScreen(lines, PROMPT, true),
    'La latence est un délai.\n\n**Vitesse moyenne : 80',
  )
})

test('le texte brut du transcript permet d’envoyer une réponse complète', () => {
  // L'écran ne contient jamais les marqueurs markdown : c'est le transcript,
  // brut, qui doit finir la réponse sans laisser de trou.
  const fromScreen = 'Vitesse moyenne : 80 km/h'
  const markdown = '**Vitesse moyenne : 80 km/h**\n\nExplication : 120 km ÷ 1,5 h.'
  const plain = plainText(markdown)

  assert.equal(plain, 'Vitesse moyenne : 80 km/h\n\nExplication : 120 km ÷ 1,5 h.')
  assert.equal(plain.startsWith(fromScreen), true)
})

test('le flux ne fait que s’allonger : aucun retrait, aucun doublon', () => {
  const step = (state: StreamState, current: string) => advanceStream(state, current)

  // Une seule image ne prouve rien : c'est la répétition qui rend le texte
  // stable. Le premier delta part donc au tour de scrutation suivant.
  const seen = step(EMPTY_STREAM, 'Bon')
  assert.equal(seen.delta, '')

  const first = step(seen.state, 'Bon')
  assert.equal(first.delta, 'Bon')

  // Chaque nouvelle image attend d'être confirmée par la suivante.
  const pending = step(first.state, 'Bonjour')
  assert.equal(pending.delta, '')
  const second = step(pending.state, 'Bonjour')
  assert.equal(second.delta, 'jour')
  assert.equal(second.state.emitted, 'Bonjour')

  // L'écran redessine et raccourcit : rien ne doit être retiré ni renvoyé.
  const shrink = step(second.state, 'Bon')
  assert.equal(shrink.delta, '')
  assert.equal(shrink.state.emitted, 'Bonjour')

  // Une image instable (le texte change au milieu) n'ajoute rien non plus.
  const unstable = step(shrink.state, 'BonXour à tous')
  assert.equal(unstable.delta, '')
  assert.equal(unstable.state.emitted, 'Bonjour')

  // Dès que l'écran réaffiche le texte entier, le flux reprend là où il s'est
  // arrêté — sans renvoyer ce qui est déjà parti.
  const back = step(unstable.state, 'Bonjour à tous')
  assert.equal(back.delta, '')
  const resume = step(back.state, 'Bonjour à tous')
  assert.equal(resume.delta, ' à tous')
  assert.equal(resume.state.emitted, 'Bonjour à tous')
})

test('la vue écran restitue ce que l’émulateur a rendu, après vidage', async () => {
  const view = new ScreenView(40, 10)
  view.write('[09:17]\r\n')
  view.write('Explique en quatre phrases simples sur la latence\r\n\r\n')
  view.write('La latence est le délai.\r\n')
  await view.flush()

  const lines = view.lines()
  assert.ok(lines.some(line => line.text.includes('La latence est le délai')))
  assert.equal(answerFromScreen(lines, 'Explique en quatre phrases sur la latence', true), 'La latence est le délai.')
})

test('une réécriture du terminal remplace la ligne au lieu de s’y ajouter', async () => {
  const view = new ScreenView(20, 5)
  view.write('abc')
  view.write('\rX')
  await view.flush()

  assert.equal(view.lines()[0]?.text, 'Xbc')
})

/**
 * Écran réel au moment où un panneau de question s'ouvre.
 *
 * Capturé le 23/10 sur un tour Freebuff (`data/screen-debug.json`) : la phrase
 * écrite avant la question est là, sous un bloc `• Thinking` — mais le tour
 * n'est pas fini, donc pas de ligne de raisonnement en italique.
 */
const QUESTION_PROMPT =
  "N'utilise aucun autre outil : ne lis aucun fichier, ne lance aucune commande. " +
  "Écris d'abord une phrase qui constate simplement que tu n'as pas encore regardé le dossier."

const questionScreen = screen(
  '   [13:19]',
  "   N'utilise aucun autre outil : ne lis aucun fichier, ne lance aucune commande. Écris d'abord une phrase qui",
  "   constate simplement que tu n'as pas encore regardé le dossier. ⎘",
  '',
  ' • Thinking',
  '   The user wants: no other tools, no file reads, no commands. First write a sentence stating I have not',
  '   looked at the folder yet, then call ask_user with two options.',
  '',
  " Je n'ai pas encore regardé le dossier sandbox.",
  '',
  '╭──────────────────── Some questions for you ────────────────────╮',
  '│▼ Veux-tu que j’analyse le dossier sandbox ?                     │',
  '│  ○ Oui, analyse le dossier                                      │',
  '│  ○ Non, laisse tomber                                           │',
  '╰─────────────────────────────────────────────────────────────────╯',
)

test('le texte écrit avant une question se lit au-dessus du panneau', () => {
  const top = panelTop(questionScreen)
  assert.notEqual(top, -1)
  const above = questionScreen.slice(0, top)

  assert.equal(panelPreamble(above, QUESTION_PROMPT), "Je n'ai pas encore regardé le dossier sandbox.")
  // Ce que faisait l'ancien chemin sur le MÊME écran : rien, faute d'italique.
  assert.equal(answerFromScreen(above, QUESTION_PROMPT, true), '')
})

test('sans écho de la consigne, aucun texte n’est inventé', () => {
  const top = panelTop(questionScreen)
  assert.equal(panelPreamble(questionScreen.slice(0, top), 'une autre consigne'), '')
})

test('le texte déjà livré n’est pas répété devant la question', () => {
  const top = panelTop(questionScreen)
  const shown = panelPreamble(questionScreen.slice(0, top), QUESTION_PROMPT)
  assert.equal(uncoveredScreenText(`🔧 **read_files** — \`src\`\n\n${shown}`, shown), '')
  assert.equal(uncoveredScreenText('', shown), shown)
})

test('un flux qui a déjà tout livré n’est pas renvoyé une seconde fois', () => {
  // Mesuré en vrai : la réponse « ok » partait du flux puis était réémise
  // entière à la fin du tour, donc affichée deux fois dans OpenWebUI.
  const done: StreamState = { emitted: 'ok', shown: 'ok' }
  assert.equal(completeWith(done, ['ok', 'ok']).delta, '')
  assert.equal(extendEmitted(done, 'ok').delta, '')

  // Une réponse plus longue déjà livrée mot pour mot : rien non plus.
  const long: StreamState = { emitted: 'La latence est le délai.', shown: 'La latence est le délai.' }
  assert.equal(completeWith(long, ['La latence est le délai.']).delta, '')

  // Mais une suite réelle est toujours ajoutée.
  assert.equal(completeWith({ emitted: 'La latence', shown: 'La latence' }, ['La latence est le délai.']).delta, ' est le délai.')
})
