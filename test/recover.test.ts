import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/**
 * `npm run recover` : retrouver la sortie de l'agent quand le pont ne l'a pas
 * livrée. Tout vient du disque — aucune CLI, aucune session, aucun tour.
 */

const root = path.resolve(import.meta.dirname, '..')
const script = path.join(root, 'scripts', 'recover.ts')
const profileDir = mkdtempSync(path.join(os.tmpdir(), 'fb-recover-'))

interface Fixture {
  project: string
  ref: string
  at: string
  messages: unknown[]
  error?: string
}

const fixtures: Fixture[] = [
  {
    project: 'projet',
    ref: 'ref-ancienne',
    at: '2026-10-23T10:00:00Z',
    messages: [
      { variant: 'user', content: 'ancienne consigne', timestamp: '10:00' },
      {
        variant: 'ai',
        timestamp: '10:00',
        blocks: [{ type: 'text', textType: 'text', content: 'Ancienne réponse' }],
      },
    ],
  },
  {
    project: 'projet',
    ref: 'ref-coupee',
    at: '2026-10-23T11:00:00Z',
    messages: [
      { variant: 'user', content: 'consigne coupée', timestamp: '11:00' },
      {
        variant: 'ai',
        timestamp: '11:00',
        blocks: [
          { type: 'text', textType: 'reasoning', content: 'raisonnement final' },
          { type: 'text', textType: 'text', content: 'Réponse récupérée' },
          { type: 'tool', content: 'sortie d’outil' },
        ],
      },
    ],
    error: 'The session ended before this response completed.',
  },
  {
    project: 'autre',
    ref: 'ref-plus-recente',
    at: '2026-10-23T12:00:00Z',
    messages: [
      { variant: 'user', content: 'autre consigne', timestamp: '12:00' },
      {
        variant: 'ai',
        timestamp: '12:00',
        blocks: [{ type: 'text', textType: 'text', content: 'Réponse du projet le plus récent' }],
      },
    ],
  },
]

function seed(profile: string, entries: Fixture[]): void {
  for (const fixture of entries) {
    const dir = path.join(profile, 'projects', fixture.project, 'chats', fixture.ref)
    mkdirSync(dir, { recursive: true })
    const messagesFile = path.join(dir, 'chat-messages.json')
    writeFileSync(messagesFile, JSON.stringify(fixture.messages), 'utf8')
    writeFileSync(
      path.join(dir, 'chat-meta.json'),
      JSON.stringify({ firstPrompt: `consigne ${fixture.ref}`, messageCount: 1 }),
      'utf8',
    )
    const at = new Date(fixture.at)
    utimesSync(messagesFile, at, at)
    if (fixture.error !== undefined) {
      writeFileSync(
        path.join(dir, 'run-state.json'),
        JSON.stringify({ output: { type: 'error', message: fixture.error } }),
        'utf8',
      )
    }
  }
}

seed(profileDir, fixtures)

interface Run {
  status: number | null
  stdout: string
  stderr: string
}

function recover(args: string[], profile = profileDir): Run {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, BRIDGE_PROFILE_DIR: profile },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

test('sans argument : la conversation la plus récente, tous projets confondus', () => {
  const run = recover([])

  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /Conversation : autre\/ref-plus-recente/)
  assert.match(run.stdout, /Réponse du projet le plus récent/)
  assert.doesNotMatch(run.stdout, /Ancienne réponse/)
})

test('--project : les réponses du dernier message, tour coupé dit, sans les outils', () => {
  const run = recover(['--project', 'D:/code/projet'])

  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /Conversation : projet\/ref-coupee/)
  assert.match(run.stdout, /Tour\s+: coupé — The session ended before this response completed\./)
  assert.match(run.stdout, /### Réponse\n\nRéponse récupérée/)
  // Le raisonnement n'est pas mélangé aux réponses, et les outils restent dehors.
  assert.doesNotMatch(run.stdout, /### Raisonnement/)
  assert.doesNotMatch(run.stdout, /Ancienne réponse/)
  assert.doesNotMatch(run.stdout, /sortie d’outil/)
})

test('un ref inconnu ou un profil vide sort en 1 avec un message clair', () => {
  const missing = recover(['--project', 'D:/code/projet', '--ref', 'ref-inconnue'])
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /aucun texte d'agent/)

  const empty = recover([], mkdtempSync(path.join(os.tmpdir(), 'fb-recover-vide-')))
  assert.equal(empty.status, 1)
  assert.match(empty.stderr, /aucun texte d'agent dans les conversations/)
})

test('la plus récente vide est sautée : la précédente est rendue', () => {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'fb-recover-vide-recente-'))
  seed(profile, [
    {
      project: 'projet',
      ref: 'ref-remplie',
      at: '2026-10-23T10:00:00Z',
      messages: [
        {
          variant: 'ai',
          timestamp: '10:00',
          blocks: [{ type: 'text', textType: 'text', content: 'Ancienne réponse utile' }],
        },
      ],
    },
    {
      project: 'projet',
      ref: 'ref-vide',
      at: '2026-10-23T12:00:00Z',
      messages: [{ variant: 'user', content: 'relance', timestamp: '12:00' }],
    },
  ])

  const run = recover([], profile)
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /Conversation : projet\/ref-remplie/)
  assert.match(run.stdout, /Ancienne réponse utile/)
  assert.doesNotMatch(run.stdout, /ref-vide/)
})

test('une réponse « [response interrupted] » ne masque pas la conversation précédente', () => {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'fb-recover-interrompue-'))
  seed(profile, [
    {
      project: 'projet',
      ref: 'ref-utile',
      at: '2026-10-23T10:00:00Z',
      messages: [
        {
          variant: 'ai',
          timestamp: '10:00',
          blocks: [{ type: 'text', textType: 'text', content: 'Le vrai contenu' }],
        },
      ],
    },
    {
      project: 'projet',
      ref: 'ref-interrompue',
      at: '2026-10-23T12:00:00Z',
      // Un marqueur seul : rien d'utile à récupérer ici.
      messages: [
        {
          variant: 'ai',
          timestamp: '12:00',
          blocks: [{ type: 'text', textType: 'text', content: '[response interrupted]' }],
        },
      ],
    },
  ])

  const run = recover([], profile)
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /ref-utile/)
  assert.match(run.stdout, /Le vrai contenu/)
  assert.doesNotMatch(run.stdout, /\[response interrupted\]/)
})

test('--ref sans --project est refusé (le ref seul ne dit pas où chercher)', () => {
  const run = recover(['--ref', 'ref-coupee'])

  assert.equal(run.status, 2)
  assert.match(run.stderr, /--ref demande aussi --project/)
})
