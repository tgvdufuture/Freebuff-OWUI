import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SessionGone,
  SessionHost,
  SessionStuck,
  TooManySessions,
  sessionRef,
  type ModelChoice,
  type ModelWriter,
} from '../src/freebuff/host.ts'
import { SettingsUnreadable } from '../src/freebuff/settings.ts'
import type { AgentSession, StopResult, TurnResult } from '../src/freebuff/session.ts'

/** Session factice : aucun PTY, aucun quota. */
class FakeSession implements AgentSession {
  static opens = 0
  readonly pid: number
  readonly chatRef: string
  readonly projectDir: string
  alive = true
  private readonly answer: (prompt: string) => string
  readonly seen: string[] = []

  constructor(projectDir: string, answer: (prompt: string) => string) {
    FakeSession.opens++
    this.pid = 1000 + FakeSession.opens
    this.chatRef = `ref-${String(this.pid)}`
    this.projectDir = projectDir
    this.answer = answer
  }

  async send(prompt: string): Promise<TurnResult> {
    this.seen.push(prompt)
    await new Promise(resolve => setTimeout(resolve, 10))
    return { text: this.answer(prompt), reasoning: '', finish: 'ok', refusal: null }
  }

  stop(): StopResult {
    this.alive = false
    return { ok: true, remaining: false }
  }
}

/** Écriture de modèle factice : elle note ce qui a été écrit et quand. */
function fakeSettings(events?: string[]): ModelWriter & { writes: string[] } {
  const writes: string[] = []
  return {
    writes,
    set(choice: ModelChoice): void {
      // Même étiquette que `settings.json` : la clé l'emporte sur l'identifiant.
      const label = choice.key ?? choice.id ?? ''
      writes.push(label)
      events?.push(`écrit:${label}`)
    },
  }
}

/** Sélection par identifiant seul, pour garder les tests lisibles. */
const m = (id: string): ModelChoice => ({ id, key: null })

const PROJECT = 'D:/code/alpha'
const OTHER = 'D:/code/beta'
const THIRD = 'D:/code/gamma'

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

test('deux projets tournent en parallèle : le second n’attend pas le premier', async () => {
  FakeSession.opens = 0
  const release: { resolve: () => void } = { resolve: () => {} }
  const gate = new Promise<void>(resolve => {
    release.resolve = resolve
  })
  const order: string[] = []
  const created: FakeSession[] = []

  const host = new SessionHost(async dir => {
    const s = new FakeSession(dir, p => p)
    created.push(s)
    return s
  }, fakeSettings())

  const slow = host.use(PROJECT, async session => {
    order.push('alpha débute')
    await gate
    order.push('alpha finit')
    return session.send('long', () => {})
  })
  // Laisse alpha entrer dans son tour avant de lancer beta.
  await delay(20)
  const fast = host.use(OTHER, session => session.send('court', () => {}))
  const result = await fast

  // beta a rendu son tour alors que alpha est encore bloqué dans le sien.
  assert.equal(result.text, 'court')
  assert.deepEqual(order, ['alpha débute'])

  release.resolve()
  await slow
  assert.deepEqual(order, ['alpha débute', 'alpha finit'])
  assert.equal(FakeSession.opens, 2)
  assert.deepEqual(created.map(s => s.projectDir), [PROJECT, OTHER])
  assert.deepEqual(created.map(s => s.seen.join('|')), ['long', 'court'])
})

test('deux requêtes sur le même projet ne démarrent qu’une session et passent l’une après l’autre', async () => {
  FakeSession.opens = 0
  const created: FakeSession[] = []
  const order: string[] = []
  const host = new SessionHost(async dir => {
    const s = new FakeSession(dir, p => `réponse à ${p}`)
    created.push(s)
    return s
  }, fakeSettings())

  const first = host.use(PROJECT, async session => {
    order.push('un débute')
    const result = await session.send('un', () => {})
    order.push('un finit')
    return result
  })
  const second = host.use(PROJECT, async session => {
    order.push('deux débute')
    const result = await session.send('deux', () => {})
    order.push('deux finit')
    return result
  })
  const [a, b] = await Promise.all([first, second])

  assert.equal(FakeSession.opens, 1)
  assert.equal(created[0]?.projectDir, PROJECT)
  assert.deepEqual(created[0]?.seen, ['un', 'deux'])
  assert.deepEqual(order, ['un débute', 'un finit', 'deux débute', 'deux finit'])
  assert.deepEqual([a.text, b.text], ['réponse à un', 'réponse à deux'])
  assert.equal(host.status()?.pid, created[0]?.pid)
})

test('le même projet écrit avec un séparateur de plus ne démarre pas une seconde session', async () => {
  FakeSession.opens = 0
  const opened: FakeSession[] = []
  const host = new SessionHost(async dir => {
    const session = new FakeSession(dir, p => p)
    opened.push(session)
    return session
  }, fakeSettings())

  await host.use(PROJECT, s => s.send('un', () => {}))
  // Cas réel : un chemin collé depuis l'explorateur garde son séparateur final.
  // Une seconde TUI pour le même dossier doublerait le quota et les prompts.
  const again = await host.use(`${PROJECT}/`, s => s.send('deux', () => {}))

  assert.equal(again.text, 'deux')
  assert.equal(FakeSession.opens, 1)
  assert.deepEqual(opened[0]?.seen, ['un', 'deux'])
})

test('au-delà de la limite, le projet suivant est refusé sans tuer les sessions ouvertes', async () => {
  FakeSession.opens = 0
  const host = new SessionHost(async dir => new FakeSession(dir, p => p), fakeSettings(), {}, { limit: 2 })

  await host.use(PROJECT, s => s.send('un', () => {}))
  await host.use(OTHER, s => s.send('deux', () => {}))

  await assert.rejects(
    host.use(THIRD, s => s.send('trois', () => {})),
    (error: unknown) => error instanceof TooManySessions && error.limit === 2,
  )
  assert.equal(FakeSession.opens, 2)
  assert.equal(host.aliveCount(), 2)

  // Les deux sessions déjà ouvertes continuent de répondre.
  const encore = await host.use(PROJECT, s => s.send('encore', () => {}))
  assert.equal(encore.text, 'encore')
})

test('une erreur de tour ne bloque ni le projet ni les autres', async () => {
  FakeSession.opens = 0
  const host = new SessionHost(async dir => new FakeSession(dir, p => p), fakeSettings())

  await assert.rejects(
    host.use(PROJECT, async () => {
      throw new Error('tour cassé')
    }),
    /tour cassé/,
  )

  const result = await host.use(PROJECT, s => s.send('après', () => {}))
  const other = await host.use(OTHER, s => s.send('ailleurs', () => {}))
  assert.deepEqual([result.text, other.text], ['après', 'ailleurs'])
})

test('une session morte n’est pas relancée en silence, son voisin continue', async () => {
  FakeSession.opens = 0
  const opened: FakeSession[] = []
  const host = new SessionHost(async dir => {
    const s = new FakeSession(dir, p => p)
    opened.push(s)
    return s
  }, fakeSettings())

  await host.use(PROJECT, s => s.send('un', () => {}))
  await host.use(OTHER, s => s.send('deux', () => {}))
  opened[0]!.alive = false

  await assert.rejects(host.use(PROJECT, s => s.send('trois', () => {})), SessionGone)
  assert.equal(FakeSession.opens, 2, 'aucune relance silencieuse')

  const voisin = await host.use(OTHER, s => s.send('quatre', () => {}))
  assert.equal(voisin.text, 'quatre')
})

test('ready() prépare la session du projet sans écrire de prompt', async () => {
  FakeSession.opens = 0
  const opened: FakeSession[] = []
  const host = new SessionHost(async dir => {
    const s = new FakeSession(dir, p => p)
    opened.push(s)
    return s
  }, fakeSettings())

  const status = await host.ready(PROJECT)
  assert.equal(status.pid, opened[0]?.pid)
  assert.equal(status.projectDir, PROJECT)
  assert.deepEqual(opened[0]?.seen, [])
  assert.equal(host.aliveCount(), 1)
})

test('statuses() rend toutes les sessions, status() la première', async () => {
  FakeSession.opens = 0
  const host = new SessionHost(async dir => new FakeSession(dir, p => p), fakeSettings())

  await host.ready(PROJECT)
  await host.ready(OTHER)

  const statuses = host.statuses()
  assert.deepEqual(statuses.map(s => s.projectDir), [PROJECT, OTHER])
  assert.equal(statuses[0]?.chatRef, 'ref-1001')
  assert.notEqual(statuses[0]?.pid, statuses[1]?.pid, 'deux chats, deux conversations')
  assert.equal(host.status()?.pid, statuses[0]?.pid)
})

test('le modèle est écrit avant l’ouverture de la session, et une fois par projet', async () => {
  FakeSession.opens = 0
  const events: string[] = []
  const settings = fakeSettings(events)
  const host = new SessionHost(async dir => {
    events.push(`ouvert:${dir}`)
    return new FakeSession(dir, p => p)
  }, settings)

  await host.ready(PROJECT, m('modele-a'))
  await host.use(OTHER, s => s.send('un', () => {}), m('modele-a'))
  await host.use(PROJECT, s => s.send('un', () => {}), m('modele-a'))

  assert.deepEqual(events, [
    'écrit:modele-a',
    `ouvert:${PROJECT}`,
    'écrit:modele-a',
    `ouvert:${OTHER}`,
  ])
  assert.deepEqual(settings.writes, ['modele-a', 'modele-a'])
})

/** Session dont l'arrêt échoue : un processus survit, comme un vrai `taskkill` raté. */
class StuckSession extends FakeSession {
  override stop(): StopResult {
    return { ok: false, remaining: true }
  }
}

test('un autre modèle ne ferme que la session du projet concerné', async () => {
  FakeSession.opens = 0
  const switches: string[] = []
  const opened: FakeSession[] = []
  const settings = fakeSettings()
  const host = new SessionHost(
    async dir => {
      const session = new FakeSession(dir, p => p)
      opened.push(session)
      return session
    },
    settings,
    { onModelSwitch: (from, to, pid) => switches.push(`${from}>${to}@${pid}`) },
  )

  await host.use(PROJECT, s => s.send('un', () => {}), m('modele-a'))
  await host.use(OTHER, s => s.send('un', () => {}), m('modele-a'))
  const beta = host.statuses()[1]

  const result = await host.use(PROJECT, s => s.send('deux', () => {}), m('modele-b'))

  assert.equal(result.text, 'deux')
  assert.equal(FakeSession.opens, 3)
  assert.deepEqual(settings.writes, ['modele-a', 'modele-a', 'modele-b'])
  assert.equal(opened[0]?.alive, false, 'alpha fermée')
  assert.equal(opened[1]?.alive, true, 'beta intacte')
  // La session beta garde son PID : seule alpha a été fermée puis relancée.
  assert.equal(host.statuses().find(s => s.projectDir === OTHER)?.pid, beta?.pid)
  assert.deepEqual(switches, [`modele-a>modele-b@${opened[0]?.pid}`])
})

test('une bascule dont l’ancien processus survit ne lance pas de seconde session pour ce projet', async () => {
  FakeSession.opens = 0
  const settings = fakeSettings()
  const host = new SessionHost(async dir => new StuckSession(dir, p => p), settings)

  await host.use(PROJECT, s => s.send('un', () => {}), m('modele-a'))
  await assert.rejects(
    host.use(PROJECT, s => s.send('deux', () => {}), m('modele-b')),
    (error: unknown) => error instanceof SessionStuck,
  )

  assert.equal(FakeSession.opens, 1)
  assert.deepEqual(settings.writes, ['modele-a'])
})

test('deux demandes simultanées avec des modèles différents sur le même projet restent sérialisées', async () => {
  FakeSession.opens = 0
  const settings = fakeSettings()
  const opened: FakeSession[] = []
  const host = new SessionHost(async dir => {
    const session = new FakeSession(dir, p => p)
    opened.push(session)
    return session
  }, settings)

  const [a, b] = await Promise.all([
    host.use(PROJECT, s => s.send('un', () => {}), m('modele-a')),
    host.use(PROJECT, s => s.send('deux', () => {}), m('modele-b')),
  ])

  assert.deepEqual([a.text, b.text], ['un', 'deux'])
  assert.deepEqual(settings.writes, ['modele-a', 'modele-b'])
  assert.equal(FakeSession.opens, 2)
  // Une seule session vivante pour ce projet : la première est arrêtée avant la seconde.
  assert.deepEqual(opened.map(session => session.alive), [false, true])
})

test('un settings illisible empêche le lancement de la session', async () => {
  FakeSession.opens = 0
  const host = new SessionHost(async dir => new FakeSession(dir, p => p), {
    set(): void {
      throw new SettingsUnreadable('settings.json', 'JSON invalide')
    },
  })

  await assert.rejects(
    host.use(PROJECT, s => s.send('un', () => {}), m('modele-a')),
    SettingsUnreadable,
  )
  assert.equal(FakeSession.opens, 0)
})

test('une conversation choisie est reprise à l’ouverture, et une seule fois', async () => {
  FakeSession.opens = 0
  const refs: Array<string | undefined> = []
  const opened: FakeSession[] = []
  const resumes: string[] = []
  const host = new SessionHost(
    async (dir, continueRef) => {
      refs.push(continueRef)
      const session = new FakeSession(dir, p => p)
      opened.push(session)
      return session
    },
    fakeSettings(),
    { onResume: (ref, pid) => resumes.push(`${ref}@${String(pid)}`) },
  )

  await host.use(PROJECT, s => s.send('un', () => {}), undefined, 'ref-a')
  // Même conversation : la session ouverte est réutilisée, aucun redémarrage.
  await host.use(PROJECT, s => s.send('deux', () => {}), undefined, 'ref-a')
  // Autre conversation : la CLI ne change pas de fil à chaud, on la relance.
  const third = await host.use(PROJECT, s => s.send('trois', () => {}), undefined, 'ref-b')

  assert.equal(third.text, 'trois')
  assert.deepEqual(refs, ['ref-a', 'ref-b'])
  assert.equal(FakeSession.opens, 2)
  assert.equal(opened[0]?.alive, false, 'l’ancienne session est fermée')
  assert.equal(opened[1]?.alive, true)
  assert.deepEqual(resumes, [`ref-a@${String(opened[0]?.pid)}`, `ref-b@${String(opened[1]?.pid)}`])
})

test('un autre projet qui reprend sa conversation ne touche pas la session voisine', async () => {
  FakeSession.opens = 0
  const refs = new Map<string, string | undefined>()
  const opened: FakeSession[] = []
  const host = new SessionHost(
    async (dir, continueRef) => {
      refs.set(dir, continueRef)
      const session = new FakeSession(dir, p => p)
      opened.push(session)
      return session
    },
    fakeSettings(),
  )

  await host.use(PROJECT, s => s.send('un', () => {}), undefined, 'ref-a')
  await host.use(OTHER, s => s.send('un', () => {}), undefined, 'ref-b')
  const beta = host.statuses().find(status => status.projectDir === OTHER)

  await host.use(PROJECT, s => s.send('deux', () => {}), undefined, 'ref-c')

  assert.equal(FakeSession.opens, 3)
  assert.equal(opened[0]?.alive, false, 'alpha relancée')
  assert.equal(opened[1]?.alive, true, 'beta intacte')
  assert.equal(host.statuses().find(status => status.projectDir === OTHER)?.pid, beta?.pid)
  assert.equal(refs.get(OTHER), 'ref-b')
})

test('deux conversations sur le MÊME dossier ouvrent deux sessions, en parallèle', async () => {
  FakeSession.opens = 0
  const release: { resolve: () => void } = { resolve: () => {} }
  const gate = new Promise<void>(resolve => {
    release.resolve = resolve
  })
  const order: string[] = []
  const created: FakeSession[] = []
  const host = new SessionHost(async dir => {
    const s = new FakeSession(dir, p => p)
    created.push(s)
    return s
  }, fakeSettings())

  const first = host.use(sessionRef('chat-a', PROJECT), async session => {
    order.push('a débute')
    await gate
    order.push('a finit')
    return session.send('a', () => {})
  })
  // Laisse la première entrer dans son tour avant de lancer la seconde.
  await delay(20)
  const second = await host.use(sessionRef('chat-b', PROJECT), session =>
    session.send('b', () => {}),
  )

  // La seconde n'a pas attendu la première, et les deux sont sur le même cwd.
  assert.equal(second.text, 'b')
  assert.deepEqual(order, ['a débute'])
  assert.equal(FakeSession.opens, 2)
  assert.deepEqual(created.map(s => s.projectDir), [PROJECT, PROJECT])
  assert.deepEqual(host.statuses().map(status => status.key), [
    sessionRef('chat-a', PROJECT).key,
    sessionRef('chat-b', PROJECT).key,
  ])

  release.resolve()
  await first
  assert.deepEqual(order, ['a débute', 'a finit'])
})

test('deux fois la MÊME conversation : une session, l’une après l’autre', async () => {
  FakeSession.opens = 0
  const order: string[] = []
  const host = new SessionHost(async dir => new FakeSession(dir, p => p), fakeSettings())
  const chat = sessionRef('chat-a', PROJECT)

  const first = host.use(chat, async session => {
    order.push('un débute')
    const result = await session.send('un', () => {})
    order.push('un finit')
    return result
  })
  const second = host.use(chat, async session => {
    order.push('deux débute')
    const result = await session.send('deux', () => {})
    order.push('deux finit')
    return result
  })
  await Promise.all([first, second])

  assert.equal(FakeSession.opens, 1, 'une seule CLI pour une conversation')
  assert.deepEqual(order, ['un débute', 'un finit', 'deux débute', 'deux finit'])
})

test('sans identifiant de chat, la session du projet reste à part', async () => {
  FakeSession.opens = 0
  const host = new SessionHost(async dir => new FakeSession(dir, p => p), fakeSettings())

  await host.use(sessionRef('chat-a', PROJECT), session => session.send('chat', () => {}))
  await host.use(PROJECT, session => session.send('script', () => {}))

  assert.equal(FakeSession.opens, 2, 'le repli projet ne partage pas la session du chat')
  assert.deepEqual(host.statuses().map(status => status.key), [
    sessionRef('chat-a', PROJECT).key,
    sessionRef(null, PROJECT).key,
  ])
})

test('stop() ferme toutes les sessions et rend un compte rendu par session', async () => {
  FakeSession.opens = 0
  const opened: FakeSession[] = []
  const host = new SessionHost(async dir => {
    const s = new FakeSession(dir, p => p)
    opened.push(s)
    return s
  }, fakeSettings())

  await host.ready(PROJECT)
  await host.ready(OTHER)
  const stopped = host.stop()

  assert.deepEqual(stopped.map(s => s.pid), opened.map(s => s.pid))
  assert.deepEqual(stopped.map(s => s.ok), [true, true])
  assert.deepEqual(opened.map(s => s.alive), [false, false])
  assert.deepEqual(host.statuses(), [])
  assert.equal(host.aliveCount(), 0)
})
