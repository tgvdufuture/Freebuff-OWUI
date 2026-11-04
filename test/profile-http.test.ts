import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { beforeEach } from 'node:test'
import type { AgentSession, StopResult, TurnResult } from '../src/freebuff/session.ts'

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'fb-profile-'))
const projectsRoot = mkdtempSync(path.join(os.tmpdir(), 'fb-profile-projects-'))
/** Deux profils VOISINS : c'est ce que la bascule a le droit de proposer. */
const profileA = path.join(dataDir, 'freebuff-session')
const profileB = path.join(dataDir, 'freebuff')

mkdirSync(path.join(projectsRoot, 'alpha'))
for (const profile of [profileA, profileB]) {
  mkdirSync(profile, { recursive: true })
  // Seule son EXISTENCE est lue : le contenu d'un credentials n'est jamais lu.
  writeFileSync(path.join(profile, 'credentials.json'), '{}', 'utf8')
}
writeFileSync(
  path.join(dataDir, 'models.json'),
  JSON.stringify([{ id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' }]),
  'utf8',
)

process.env.BRIDGE_STUB = '0'
process.env.BRIDGE_DATA_DIR = dataDir
process.env.BRIDGE_API_KEY = 'test-key-profile'
process.env.BRIDGE_PROJECTS_ROOT = projectsRoot
process.env.BRIDGE_PROFILE_DIR = profileA

const { buildServer } = await import('../src/server.ts')

const AUTH = { authorization: 'Bearer test-key-profile' }
const ALPHA = path.join(projectsRoot, 'alpha').replace(/\\/g, '/')

/** Les mesures du lancement, telles que `scripts/pick-profile.ts` les écrit. */
const launchReport = {
  at: 1_792_000_000_000,
  profiles: [
    { name: 'freebuff-session', path: profileA, remainingHours: 2, totalHours: 12 },
    { name: 'freebuff', path: profileB, remainingHours: 9, totalHours: 12 },
  ],
}

beforeEach(() => {
  rmSync(path.join(dataDir, 'profiles.json'), { force: true })
  rmSync(path.join(dataDir, 'quota.json'), { force: true })
  sent.length = 0
  opened.length = 0
  openedProfiles.length = 0
})

/** Tout ce que les sessions factices ont réellement reçu, dans l'ordre. */
const sent: string[] = []

/** Session factice : aucune TUI, un arrêt réussi, et un tour immédiat. */
class FakeSession implements AgentSession {
  static stops = 0
  readonly pid: number
  /** Comme la vraie CLI : posé seulement quand un prompt a été accepté. */
  chatRef: string | null = null
  readonly alive = true
  readonly projectDir: string
  readonly quota = { found: true, remainingHours: 2, totalHours: 12, exhausted: false }
  readonly sessionLeft = null

  constructor(projectDir: string) {
    this.projectDir = projectDir
    this.pid = 7000 + FakeSession.stops
  }

  async send(prompt: string): Promise<TurnResult> {
    sent.push(prompt)
    this.chatRef = 'ref-profile'
    return { text: 'tour factice', reasoning: '', finish: 'ok', refusal: null }
  }

  stop(): StopResult {
    FakeSession.stops += 1
    return { ok: true, remaining: false }
  }
}

const opened: string[] = []
/** Le profil de chaque CLI ouverte, dans le même ordre que `opened`. */
const openedProfiles: string[] = []

const makeApp = (
  options: { session?: (projectDir: string) => AgentSession; bindings?: string; maxSessions?: number } = {},
) =>
  buildServer({
    bindingsFile: options.bindings ?? path.join(dataDir, `bindings-${String(Date.now())}.json`),
    openSession: async (projectDir, _continueRef, profileDir) => {
      opened.push(projectDir)
      openedProfiles.push(profileDir)
      return options.session === undefined ? new FakeSession(projectDir) : options.session(projectDir)
    },
    maxSessions: options.maxSessions,
    quotaProbe: async () => {
      throw new Error('la bascule ne doit pas sonder la CLI')
    },
  })

type App = ReturnType<typeof makeApp>

const bind = async (app: App, chatId: string): Promise<void> => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/bind',
    headers: AUTH,
    payload: { chatId, projectPath: ALPHA },
  })
  assert.equal(response.statusCode, 200)
}

/**
 * Un tour ordinaire : c'est lui qui ouvre la session (et écrit le modèle).
 *
 * La consigne change d'un appel à l'autre : la même consigne serait vue comme
 * une régénération et rejouée depuis le cache, sans ouvrir de session.
 */
const turnWith = (
  app: App,
  chatId: string,
  messages: Array<{ role: string; content: string }>,
): Promise<{ statusCode: number; json: () => unknown }> =>
  app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...AUTH, 'x-openwebui-chat-id': chatId },
    payload: { model: 'freebuff-deepseek-v4-flash', stream: false, messages },
  })

const turn = (
  app: App,
  chatId: string,
  prompt = 'travaille',
): Promise<{ statusCode: number; json: () => unknown }> =>
  turnWith(app, chatId, [{ role: 'user', content: prompt }])

const switchTo = (app: App, dir: string) =>
  app.inject({ method: 'POST', url: '/api/profile', payload: { path: dir } })

const health = async (app: App) =>
  (await app.inject({ method: 'GET', url: '/health' })).json() as {
    profileDir: { path: string }
    sessions: Array<{ account?: string }>
  }

test('la liste reprend les mesures du lancement et marque le profil courant', async () => {
  writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify(launchReport), 'utf8')
  const app = makeApp()

  const response = await app.inject({ method: 'GET', url: '/api/profiles' })

  assert.equal(response.statusCode, 200)
  const body = response.json() as {
    current: string
    currentPath: string
    detectedAt: number | null
    profiles: Array<{ name: string; remainingHours: number | null; current?: boolean }>
  }
  assert.equal(body.current, 'freebuff-session')
  assert.equal(body.currentPath, profileA)
  assert.equal(body.detectedAt, launchReport.at, 'les heures portent la date de la sonde')
  assert.equal(body.profiles.length, 2)
  assert.deepEqual(
    body.profiles.map(profile => [profile.name, profile.remainingHours, profile.current === true]),
    [
      ['freebuff-session', 2, true],
      ['freebuff', 9, false],
    ],
  )

  await app.close()
})

test('un profil voisin freebuff2 est proposé pour la bascule', async () => {
  const other = path.join(dataDir, 'freebuff2')
  mkdirSync(other, { recursive: true })
  writeFileSync(path.join(other, 'credentials.json'), '{}', 'utf8')
  try {
    const body = (await makeApp().inject({ method: 'GET', url: '/api/profiles' })).json() as {
      profiles: Array<{ name: string }>
    }
    assert.ok(body.profiles.some(profile => profile.name === 'freebuff2'))
  } finally {
    rmSync(other, { recursive: true, force: true })
  }
})

test('un profil voisin dont le dossier porte un AUTRE nom est proposé aussi', async () => {
  const other = path.join(dataDir, 'moncompte')
  mkdirSync(other, { recursive: true })
  writeFileSync(path.join(other, 'credentials.json'), '{}', 'utf8')
  try {
    const body = (await makeApp().inject({ method: 'GET', url: '/api/profiles' })).json() as {
      profiles: Array<{ name: string; remainingHours: number | null }>
    }
    const found = body.profiles.find(profile => profile.name === 'moncompte')
    assert.ok(found, 'un nom de dossier inconnu ne rend plus un profil invisible')
    assert.equal(found.remainingHours, null, 'aucune heure inventée pour un profil non sondé')
  } finally {
    rmSync(other, { recursive: true, force: true })
  }
})

test('sans mesures de lancement, les profils voisins sont proposés sans heures', async () => {
  const app = makeApp()

  const body = (await app.inject({ method: 'GET', url: '/api/profiles' })).json() as {
    detectedAt: number | null
    profiles: Array<{ name: string; remainingHours: number | null; current?: boolean }>
  }

  assert.equal(body.detectedAt, null)
  assert.deepEqual(
    body.profiles.map(profile => [profile.name, profile.remainingHours, profile.current === true]),
    [
      ['freebuff-session', null, true],
      ['freebuff', null, false],
    ],
  )

  await app.close()
})

test('la bascule laisse vivre la CLI de l’ancien compte et ouvre les suivantes sur le nouveau', async () => {
  const app = makeApp()
  await bind(app, 'chat-switch')
  await bind(app, 'chat-neuf')
  assert.equal((await turn(app, 'chat-switch')).statusCode, 200)
  const before = await health(app)
  assert.equal(before.sessions.length, 1)
  assert.equal(before.sessions[0]?.account, profileA)
  assert.ok(existsSync(path.join(profileA, 'settings.json')), 'le modèle a été écrit chez A')

  const response = await switchTo(app, profileB)

  assert.equal(response.statusCode, 200)
  const body = response.json() as { ok: boolean; changed: boolean; stopped: number }
  assert.equal(body.ok, true)
  assert.equal(body.changed, true)
  assert.equal(body.stopped, 0, 'aucune CLI n’a été fermée')

  const after = await health(app)
  assert.equal(after.profileDir.path, profileB)
  assert.deepEqual(
    after.sessions.map(session => session.account),
    [profileA],
    'la CLI du tour garde son compte',
  )

  // Le chat déjà ouvert continue DANS sa session : aucune CLI de plus.
  assert.equal((await turn(app, 'chat-switch', 'continue')).statusCode, 200)
  assert.equal(opened.length, 1)

  // Un chat neuf ouvre une session sur le NOUVEAU compte, et écrit chez lui.
  assert.equal((await turn(app, 'chat-neuf')).statusCode, 200)
  assert.equal(opened.length, 2)
  assert.equal(openedProfiles[1], profileB)
  const written = JSON.parse(readFileSync(path.join(profileB, 'settings.json'), 'utf8')) as {
    freebuffModel?: string
  }
  assert.equal(written.freebuffModel, 'deepseek/deepseek-v4-flash')
  assert.deepEqual(
    (await health(app)).sessions.map(session => session.account),
    [profileA, profileB],
  )

  await app.close()
})

test('après une bascule, une CLI neuve rejoue le fil de la conversation', async () => {
  const app = makeApp()
  await bind(app, 'chat-thread')
  assert.equal((await turn(app, 'chat-thread', 'Écris le PRD.')).statusCode, 200)
  assert.equal((await switchTo(app, profileB)).statusCode, 200)

  // Une conversation NEUVE pour le pont : c'est elle qui ouvre une CLI ailleurs.
  await bind(app, 'chat-thread-b')
  const response = await turnWith(app, 'chat-thread-b', [
    { role: 'user', content: 'Écris le PRD.' },
    { role: 'assistant', content: 'PRD v1.2 écrit.' },
    { role: 'user', content: 'Continue et commit.' },
  ])

  assert.equal(response.statusCode, 200)
  const prompt = sent.at(-1) ?? ''
  assert.match(prompt, /session Freebuff a été relancée/)
  assert.match(prompt, /Utilisateur : Écris le PRD\./)
  assert.match(prompt, /Agent : PRD v1\.2 écrit\./)
  assert.ok(prompt.endsWith('Consigne à traiter maintenant : Continue et commit.'))
  assert.ok(prompt.length <= 8000, 'le plafond du prompt reste respecté')

  await app.close()
})

test('sans bascule, la session en cours ne reçoit que la nouvelle consigne', async () => {
  const app = makeApp()
  await bind(app, 'chat-suivi')
  assert.equal((await turn(app, 'chat-suivi', 'Écris le PRD.')).statusCode, 200)
  assert.equal((await turn(app, 'chat-suivi', 'Continue et commit.')).statusCode, 200)

  assert.equal(sent.at(-1), 'Continue et commit.', 'aucun contexte rejoué dans une session vivante')

  await app.close()
})

test('un tour en cours n’empêche plus la bascule et finit sur son compte', async () => {
  /** `release` n'est posé QUE quand le tour est réellement en vol. */
  let release: (() => void) | null = null
  class HeldSession extends FakeSession {
    async send(): Promise<TurnResult> {
      await new Promise<void>(resolve => {
        release = resolve
      })
      return { text: 'tour factice', reasoning: '', finish: 'ok', refusal: null }
    }
  }

  const app = makeApp({ session: projectDir => new HeldSession(projectDir) })
  await bind(app, 'chat-busy')

  const pending = turn(app, 'chat-busy')
  const deadline = Date.now() + 2_000
  while (release === null) {
    if (Date.now() > deadline) throw new Error('le tour n’a pas démarré')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  const finish: () => void = release

  const response = await switchTo(app, profileB)

  assert.equal(response.statusCode, 200)
  assert.equal((await health(app)).profileDir.path, profileB, 'le compte courant a changé')
  const sessions = (await health(app)).sessions
  assert.equal(sessions.length, 1, 'la CLI du tour reste ouverte')
  assert.equal(sessions[0]?.account, profileA)

  finish()
  assert.equal((await pending).statusCode, 200, 'le tour va au bout')

  await app.close()
})

test('un profil non proposé est refusé, un chemin vide aussi', async () => {
  const app = makeApp()

  const unknown = await switchTo(app, path.join(dataDir, 'ailleurs'))
  assert.equal(unknown.statusCode, 404)
  assert.equal((unknown.json() as { error: { code: string } }).error.code, 'profile_unknown')

  const empty = await app.inject({ method: 'POST', url: '/api/profile', payload: {} })
  assert.equal(empty.statusCode, 400)
  assert.equal((empty.json() as { error: { code: string } }).error.code, 'profile_missing')

  await app.close()
})

test('redemander le profil courant ne ferme aucune CLI', async () => {
  const app = makeApp()
  await bind(app, 'chat-same')
  assert.equal((await turn(app, 'chat-same')).statusCode, 200)

  const response = await switchTo(app, profileA)

  assert.equal(response.statusCode, 200)
  const body = response.json() as { changed: boolean; stopped: number }
  assert.equal(body.changed, false)
  assert.equal(body.stopped, 0)
  assert.equal((await health(app)).sessions.length, 1, 'la session n’a pas été touchée')

  await app.close()
})

test('la lecture de quota de l’ancien compte ne survit pas à la bascule', async () => {
  const app = makeApp()
  await bind(app, 'chat-quota')
  assert.equal((await turn(app, 'chat-quota')).statusCode, 200)
  const before = (await app.inject({ method: 'GET', url: '/api/quota?chatId=chat-quota' })).json() as {
    quota: { remainingHours: number } | null
  }
  assert.equal(before.quota?.remainingHours, 2, 'la session a rempli la barre')
  assert.ok(existsSync(path.join(dataDir, 'quota.json')))

  assert.equal((await switchTo(app, profileB)).statusCode, 200)

  const after = (await app.inject({ method: 'GET', url: '/api/quota?chatId=chat-quota' })).json() as {
    quota: unknown
  }
  assert.equal(after.quota, null, 'les heures de l’ancien compte ne sont plus affichées')
  assert.equal(existsSync(path.join(dataDir, 'quota.json')), false, 'ni conservées sur disque')

  await app.close()
})

test('la limite de sessions est PAR COMPTE : chaque compte a ses propres slots', async () => {
  const app = makeApp({ maxSessions: 1 })
  await bind(app, 'chat-lim-a')
  await bind(app, 'chat-lim-a2')
  await bind(app, 'chat-lim-b')
  await bind(app, 'chat-lim-b2')

  assert.equal((await turn(app, 'chat-lim-a')).statusCode, 200)
  // Compte A plein : une session de plus sur A est refusée.
  assert.equal((await turn(app, 'chat-lim-a2')).statusCode, 429)

  assert.equal((await switchTo(app, profileB)).statusCode, 200)
  // Le compte B n'hérite pas de la session de A : il a son propre slot.
  assert.equal((await turn(app, 'chat-lim-b')).statusCode, 200)
  assert.deepEqual(openedProfiles, [profileA, profileB])

  // Puis B est plein à son tour.
  const full = await turn(app, 'chat-lim-b2')
  assert.equal(full.statusCode, 429)
  assert.equal((full.json() as { error: { code: string } }).error.code, 'too_many_sessions')
  // La session de A répond toujours.
  assert.equal((await turn(app, 'chat-lim-a', 'encore')).statusCode, 200)

  await app.close()
})
