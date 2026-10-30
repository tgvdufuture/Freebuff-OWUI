import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_PROMPT_CHARS,
  cliFailure,
  parseTranscript,
  promptFinishedSince,
  sanitizePrompt,
  stepsMarkdown,
  turnComplete,
  turnMarkdown,
  turnSteps,
  turnText,
  userCount,
} from '../src/freebuff/transcript.ts'

const user = { variant: 'user', content: 'fais quelque chose' }
const ai = (text: string, complete: boolean) => ({
  variant: 'ai',
  isComplete: complete,
  blocks: [{ type: 'text', content: text }],
})

test('un JSON incomplet (fichier en cours d’écriture) ne casse pas la lecture', () => {
  assert.equal(parseTranscript('{"variant":"ai"'), null)
  assert.equal(parseTranscript('{"pas":"un tableau"}'), null)
  assert.deepEqual(parseTranscript('[]'), [])
})

test('le texte du tour ne contient que les messages après le dernier utilisateur', () => {
  const entries = [
    user,
    ai('réponse précédente', true),
    user,
    ai('début', false),
    { variant: 'ai', blocks: [{ type: 'tool' }] },
    ai('fin', false),
  ]
  assert.equal(turnText(entries), 'début\n\nfin')
})

test('les blocs outils et raisonnement ne deviennent jamais du texte', () => {
  const entries = [
    user,
    { variant: 'ai', blocks: [{ type: 'tool' }, { type: 'reasoning', content: 'secret' }, { type: 'text', content: 'visible' }] },
  ]
  assert.equal(turnText(entries), 'visible')
})

test('la réflexion ne remonte jamais dans le texte de réponse', () => {
  const entries = [
    user,
    { variant: 'ai', blocks: [{ type: 'text', textType: 'reasoning', content: 'secret' }] },
  ]
  assert.equal(turnText(entries), '')
})

test('les étapes gardent l’ordre réel : réflexion, outil, réflexion, réponse', () => {
  const entries = [
    user,
    {
      variant: 'ai',
      blocks: [
        { type: 'text', textType: 'reasoning', content: 'je cherche' },
        { type: 'tool', toolName: 'list_directory', input: { path: 'src' } },
        { type: 'text', textType: 'reasoning', content: 'je lis' },
        { type: 'tool', toolName: 'read_files', input: { paths: ['a.ts', 'b.ts'] } },
        { type: 'text', textType: 'text', content: 'Voici la réponse.' },
      ],
    },
  ]

  assert.deepEqual(turnSteps(entries), [
    { kind: 'reasoning', text: 'je cherche' },
    { kind: 'tool', name: 'list_directory', detail: 'src' },
    { kind: 'reasoning', text: 'je lis' },
    { kind: 'tool', name: 'read_files', detail: 'a.ts, b.ts' },
    { kind: 'text', text: 'Voici la réponse.' },
  ])
})

test('l’appel ask_user n’est pas une étape : la question est rendue à part', () => {
  const entries = [
    user,
    {
      variant: 'ai',
      isComplete: true,
      blocks: [
        { type: 'text', textType: 'text', content: 'Je vérifie deux choses avant de demander.' },
        { type: 'tool', toolName: 'ask_user', input: { questions: [] } },
      ],
    },
  ]

  assert.deepEqual(turnSteps(entries), [
    { kind: 'text', text: 'Je vérifie deux choses avant de demander.' },
  ])
  const markdown = turnMarkdown(entries)
  assert.match(markdown, /Je vérifie deux choses avant de demander\./)
  assert.doesNotMatch(markdown, /ask_user/)
})

test('réflexion et outil qui se suivent forment UN bloc « Travail » replié', () => {
  const steps = [
    { kind: 'reasoning' as const, text: 'je cherche' },
    { kind: 'tool' as const, name: 'list_directory', detail: 'src' },
    { kind: 'text' as const, text: 'Voici la réponse.' },
  ]

  // UN bloc replié pour tout le travail : son titre annonce la première étape,
  // la réflexion s'y replie à son tour, et la réponse reste seule visible.
  assert.equal(
    stepsMarkdown(steps),
    '<details>\n<summary>🔧 Travail · 🧠 je cherche</summary>\n\n<details>\n<summary>🧠 je cherche</summary>\n\nje cherche\n\n</details>\n\n🔧 **list_directory** — `src`\n\n</details>\n\nVoici la réponse.',
  )
  // En flux, la réflexion en cours est RETENUE : son texte finirait dans un
  // titre, et un titre déjà parti ne peut plus s'allonger.
  assert.equal(stepsMarkdown(steps.slice(0, 1), true), '')
  // Dès qu'une étape la suit, elle est figée : elle part en entier, sans sa
  // balise fermante de bloc (le delta suivant n'a qu'à ajouter).
  assert.equal(
    stepsMarkdown(steps.slice(0, 2), true),
    '<details>\n<summary>🔧 Travail · 🧠 je cherche</summary>\n\n<details>\n<summary>🧠 je cherche</summary>\n\nje cherche\n\n</details>\n\n🔧 **list_directory** — `src`',
  )
  // La réponse referme le bloc ; le rendu final prolonge ce qui est déjà parti.
  assert.equal(stepsMarkdown(steps, true), stepsMarkdown(steps, false))
  assert.ok(stepsMarkdown(steps, false).startsWith(stepsMarkdown(steps.slice(0, 2), true)))
})

test('une étape isolée forme un bloc comme une suite : sa forme ne bouge pas si une autre arrive', () => {
  assert.equal(
    stepsMarkdown([{ kind: 'tool', name: 'read_files', detail: 'a.ts' }]),
    '<details>\n<summary>🔧 Travail · 🔧 read_files — a.ts</summary>\n\n🔧 **read_files** — `a.ts`\n\n</details>',
  )
  assert.equal(
    stepsMarkdown([{ kind: 'reasoning', text: 'je réfléchis' }]),
    '<details>\n<summary>🔧 Travail · 🧠 je réfléchis</summary>\n\n<details>\n<summary>🧠 je réfléchis</summary>\n\nje réfléchis\n\n</details>\n\n</details>',
  )
  // Un seul appel parti en flux, puis rejoint par un second : le premier delta
  // reste un préfixe exact du suivant (le contraire bloquait tout le flux).
  assert.ok(
    stepsMarkdown(
      [
        { kind: 'tool', name: 'read_files', detail: 'a.ts' },
        { kind: 'tool', name: 'read_files', detail: 'b.ts' },
      ],
      true,
    ).startsWith(stepsMarkdown([{ kind: 'tool', name: 'read_files', detail: 'a.ts' }], true)),
  )
})

test('une réponse coupe le travail en deux blocs, dans l’ordre', () => {
  const steps = [
    { kind: 'tool' as const, name: 'read_files', detail: 'a.ts' },
    { kind: 'tool' as const, name: 'read_files', detail: 'b.ts' },
    { kind: 'text' as const, text: 'Je corrige.' },
    { kind: 'tool' as const, name: 'str_replace', detail: 'a.ts' },
    { kind: 'tool' as const, name: 'run_terminal_command', detail: 'npm test' },
    { kind: 'text' as const, text: 'C’est corrigé.' },
  ]
  const markdown = stepsMarkdown(steps)

  assert.equal(markdown.match(/<summary>🔧 Travail · /g)?.length, 2)
  assert.ok(markdown.indexOf('b.ts') < markdown.indexOf('Je corrige.'))
  assert.ok(markdown.indexOf('Je corrige.') < markdown.indexOf('str_replace'))
  assert.ok(markdown.indexOf('str_replace') < markdown.indexOf('C’est corrigé.'))
})

test('la réponse reste en clair au milieu des appels d’outil', () => {
  const markdown = turnMarkdown([
    user,
    {
      variant: 'ai',
      isComplete: true,
      blocks: [
        { type: 'tool', toolName: 'read_files', input: { path: 'a.ts' } },
        { type: 'text', textType: 'text', content: 'Je corrige le tri.' },
        { type: 'tool', toolName: 'str_replace', input: { path: 'a.ts' } },
        { type: 'text', textType: 'text', content: 'C’est corrigé.' },
      ],
    },
  ])

  // Le texte sort du bloc : il n'est pas avalé par un « Travail » replié, même
  // entre deux appels d'outil.
  assert.ok(markdown.slice(0, markdown.indexOf('Je corrige le tri.')).trimEnd().endsWith('</details>'))
  assert.ok(markdown.slice(0, markdown.indexOf('C’est corrigé.')).trimEnd().endsWith('</details>'))
})

test('une réflexion repliée garde son début dans le titre et son texte entier dedans', () => {
  const long = 'a'.repeat(200)
  const markdown = stepsMarkdown([{ kind: 'reasoning', text: long }])

  assert.ok(markdown.includes(`<summary>🧠 ${'a'.repeat(59)}…</summary>`), 'le titre porte l’aperçu borné')
  assert.ok(markdown.includes(long), 'la réflexion complète reste dépliable')
})

test('le titre d’un bloc ne bouge pas quand une étape s’ajoute', () => {
  // C'est ce qui protège le flux : un titre déjà envoyé ne peut plus s'allonger.
  const first = { kind: 'tool' as const, name: 'read_files', detail: 'a.ts' }
  const streamed = stepsMarkdown([first], true)
  const withNext = stepsMarkdown([first, { kind: 'tool' as const, name: 'glob', detail: '*.ts' }], true)

  assert.ok(withNext.startsWith(streamed))
  assert.equal(withNext.indexOf('</summary>'), streamed.indexOf('</summary>'))
})

test('la sortie brute d’un outil n’est jamais rendue', () => {
  // Mesuré le 26/10 : les blocs `tool` du transcript portent `output`.
  const entries = [
    user,
    {
      variant: 'ai',
      isComplete: true,
      blocks: [
        {
          type: 'tool',
          toolName: 'run_terminal_command',
          input: { command: 'npm run test' },
          output: 'CACHE-CONTROL sk-live-abcdef0123456789',
        },
      ],
    },
  ]
  const markdown = turnMarkdown(entries)

  assert.match(markdown, /npm run test/)
  assert.ok(!markdown.includes('CACHE-CONTROL'), 'la sortie brute reste dehors')
  assert.ok(!markdown.includes('sk-live'), 'et ses secrets avec elle')
})

test('aucun secret connu n’apparaît dans le rendu', () => {
  const entries = [
    user,
    {
      variant: 'ai',
      isComplete: true,
      blocks: [
        { type: 'text', textType: 'reasoning', content: 'j’appelle l’API avec sk-live-abcdef0123456789' },
        {
          type: 'tool',
          toolName: 'run_terminal_command',
          input: { command: 'curl -H "Authorization: Bearer abc.def.ghi" https://x/y' },
        },
        { type: 'text', textType: 'text', content: 'La variable token: s3cr3t-value est posée.' },
      ],
    },
  ]
  const markdown = turnMarkdown(entries)

  assert.ok(!markdown.includes('sk-live'), 'préfixe `sk-` masqué')
  assert.ok(!markdown.includes('abc.def.ghi'), 'jeton `Bearer` masqué')
  assert.ok(!markdown.includes('s3cr3t-value'), 'valeur de `token:` masquée')
  assert.match(markdown, /sk-…/)
  assert.match(markdown, /Bearer …/)
  assert.match(markdown, /token: …/)
})

test('les deltas du flux reforment exactement le rendu final', () => {
  // Snapshots successifs du transcript pendant un tour : réflexion qui s'écrit,
  // puis outil, puis réponse qui s'écrit, puis un second travail et sa réponse.
  const snapshots = [
    [{ kind: 'reasoning' as const, text: 'je cherche' }],
    [{ kind: 'reasoning' as const, text: 'je cherche les fichiers' }],
    [
      { kind: 'reasoning' as const, text: 'je cherche les fichiers' },
      { kind: 'tool' as const, name: 'list_directory', detail: 'src' },
    ],
    [
      { kind: 'reasoning' as const, text: 'je cherche les fichiers' },
      { kind: 'tool' as const, name: 'list_directory', detail: 'src' },
      { kind: 'text' as const, text: 'Voici la' },
    ],
    [
      { kind: 'reasoning' as const, text: 'je cherche les fichiers' },
      { kind: 'tool' as const, name: 'list_directory', detail: 'src' },
      { kind: 'text' as const, text: 'Voici la réponse.' },
    ],
    [
      { kind: 'reasoning' as const, text: 'je cherche les fichiers' },
      { kind: 'tool' as const, name: 'list_directory', detail: 'src' },
      { kind: 'text' as const, text: 'Voici la réponse.' },
      { kind: 'tool' as const, name: 'str_replace', detail: 'a.ts' },
    ],
    [
      { kind: 'reasoning' as const, text: 'je cherche les fichiers' },
      { kind: 'tool' as const, name: 'list_directory', detail: 'src' },
      { kind: 'text' as const, text: 'Voici la réponse.' },
      { kind: 'tool' as const, name: 'str_replace', detail: 'a.ts' },
      { kind: 'text' as const, text: 'C’est fait.' },
    ],
  ]

  let emitted = ''
  for (const steps of snapshots) {
    const markdown = stepsMarkdown(steps, true)
    assert.ok(markdown.startsWith(emitted), 'un delta ne peut pas réécrire le passé')
    emitted = markdown
  }

  const final = stepsMarkdown(snapshots.at(-1) as (typeof snapshots)[number], false)
  assert.equal(emitted, final)
})

test('le tour garde le texte écrit AVANT un dernier appel d’outil', () => {
  // Cas réel : l'agent termine par `suggest_followups`. Ne garder que le texte
  // d'après le dernier outil rendait une réponse vide.
  const entries = [
    user,
    {
      variant: 'ai',
      isComplete: true,
      blocks: [
        { type: 'text', textType: 'reasoning', content: 'je rédige' },
        { type: 'text', textType: 'text', content: 'Voici la réponse.' },
        { type: 'tool', toolName: 'suggest_followups', input: { followups: [] } },
      ],
    },
  ]
  const markdown = turnMarkdown(entries)

  assert.match(markdown, /Voici la réponse\./)
  assert.match(markdown, /suggest_followups/)
  assert.ok(markdown.indexOf('Voici la réponse.') < markdown.indexOf('suggest_followups'))
})

test('chaque suite proposée devient un lien porteur du prompt du CLI', () => {
  const entries = [
    user,
    {
      variant: 'ai',
      isComplete: true,
      blocks: [
        { type: 'text', textType: 'text', content: 'Voici la réponse.' },
        {
          type: 'tool',
          toolName: 'suggest_followups',
          input: {
            followups: [
              { prompt: 'Mets à jour la doc', label: 'Corriger la doc' },
              // Sans libellé : le prompt fait office de texte.
              { prompt: 'Ajoute un test' },
            ],
          },
        },
      ],
    },
  ]

  const asked: string[] = []
  const markdown = turnMarkdown(entries, prompt => {
    asked.push(prompt)
    return `http://127.0.0.1:7799/a/prompt?t=${String(asked.length)}`
  })

  // Le PROMPT part, pas le libellé : c'est lui que la CLI rejouerait.
  assert.deepEqual(asked, ['Mets à jour la doc', 'Ajoute un test'])
  assert.match(markdown, /\[Corriger la doc\]\(http:\/\/127\.0\.0\.1:7799\/a\/prompt\?t=1\)/)
  assert.match(markdown, /\[Ajoute un test\]\(http:\/\/127\.0\.0\.1:7799\/a\/prompt\?t=2\)/)
  assert.ok(!markdown.includes('Mets à jour la doc]('), 'le prompt ne sert pas de libellé')
  assert.ok(markdown.indexOf('Voici la réponse.') < markdown.indexOf('🔧'), 'les liens suivent la réponse')
})

const FOLLOWUP_STEPS = [
  { kind: 'text' as const, text: 'Voici la réponse.' },
  {
    kind: 'followups' as const,
    items: [
      { label: 'Corriger la doc', prompt: 'Mets à jour la doc' },
      { label: 'Tester', prompt: 'Ajoute un test' },
    ],
  },
]

const stableLink = (prompt: string): string =>
  `http://127.0.0.1:7799/a/prompt?t=${encodeURIComponent(prompt)}`

test('les liens d’un tour sont identiques en flux et au rendu final', () => {
  // Même constructeur, mêmes URL : le rendu final prolonge ce qui est parti.
  const streamed = stepsMarkdown(FOLLOWUP_STEPS, true, stableLink)
  const final = stepsMarkdown(FOLLOWUP_STEPS, false, stableLink)
  assert.equal(streamed, final)
  assert.match(final, /\[Corriger la doc\]\(http:\/\/127\.0\.0\.1:7799\/a\/prompt\?t=Mets%20%C3%A0%20jour%20la%20doc\)/)
})

test('sans constructeur de lien, les suggestions restent lisibles et sans lien mort', () => {
  const plain = stepsMarkdown(FOLLOWUP_STEPS)
  assert.match(plain, /🔧 \*\*suggest_followups\*\* — Corriger la doc/)
  assert.match(plain, /— Tester/)
  assert.ok(!plain.includes(']('), 'aucun lien quand il n’y en a pas')
})

test('une suggestion sans prompt exploitable ne remplace pas la ligne d’outil', () => {
  const entries = [
    user,
    {
      variant: 'ai',
      isComplete: true,
      blocks: [{ type: 'tool', toolName: 'suggest_followups', input: { followups: [{ label: 'vide' }, {}] } }],
    },
  ]
  assert.deepEqual(turnSteps(entries), [
    { kind: 'tool', name: 'suggest_followups', detail: '' },
  ])
  assert.ok(!stepsMarkdown(turnSteps(entries)).includes(']('))
})

test('un libellé qui contient un crochet ne casse pas le lien', () => {
  const steps = [
    {
      kind: 'followups' as const,
      items: [{ label: 'Corriger [doc]', prompt: 'Mets à jour la doc' }],
    },
  ]
  const markdown = stepsMarkdown(steps, false, stableLink)
  assert.match(markdown, /\[Corriger doc\]\(http:/)
})

test('un tour sans aucun bloc rend un markdown vide', () => {
  assert.equal(turnMarkdown([user]), '')
})

test('l’erreur terminale de la CLI est lue dans run-state.json', () => {
  const runState = JSON.stringify({
    output: {
      type: 'error',
      message: 'The request instruction contract is unsupported. Update your Freebuff client.',
      statusCode: 403,
      error: 'free_mode_client_check_failed',
    },
  })

  assert.deepEqual(cliFailure(runState), {
    message: 'The request instruction contract is unsupported. Update your Freebuff client.',
    code: 'free_mode_client_check_failed',
    status: 403,
  })
  assert.equal(cliFailure('{ pas du json'), null)
  assert.equal(cliFailure(JSON.stringify({ output: { type: 'text', message: 'ok' } })), null)
  assert.equal(cliFailure(JSON.stringify({})), null)
})

test('le tour n’est fini que si le dernier message est complet', () => {
  assert.equal(turnComplete([user, ai('fini', true)]), true)
  assert.equal(turnComplete([user, ai('en cours', false)]), false)
  assert.equal(turnComplete([user]), false)
  assert.equal(turnComplete([]), false)
})

test('« Main prompt finished » date la fin d’un tour, même sans transcript', () => {
  const log = [
    '{"level":"DEBUG","timestamp":"2026-10-22T12:00:00.000Z","msg":"Main prompt started"}',
    '{"level":"DEBUG","timestamp":"2026-10-22T12:00:30.000Z","msg":"Main prompt finished"}',
  ].join('\n')
  const started = Date.parse('2026-10-22T12:00:01.000Z')
  assert.equal(promptFinishedSince(log, started), true)
  // Un repère antérieur au tour ne compte pas : le journal est cumulatif.
  assert.equal(promptFinishedSince(log, Date.parse('2026-10-22T12:00:31.000Z')), false)
})

test('les lignes illisibles du journal CLI ne cassent pas la détection', () => {
  const log = ['{"msg":"Main prompt fini', '', '{"msg":"Main prompt finished"}'].join('\n')
  assert.equal(promptFinishedSince(log, 0), false)
  assert.equal(promptFinishedSince('', 0), false)
})

test('le nombre de messages utilisateur compte les prompts déjà partis', () => {
  assert.equal(userCount([user, ai('a', true), user]), 2)
  assert.equal(userCount([{ variant: 'ai' }]), 0)
})

test('un prompt est aplati sur une ligne et borné', () => {
  assert.equal(sanitizePrompt('  ligne 1\nligne 2\r\n\tligne 3  '), 'ligne 1 ligne 2 ligne 3')
  assert.equal(sanitizePrompt('x'.repeat(MAX_PROMPT_CHARS + 50)).length, MAX_PROMPT_CHARS)
})
