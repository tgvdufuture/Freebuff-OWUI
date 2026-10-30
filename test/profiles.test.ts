import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  discoverProfiles,
  mergeProfileReport,
  parseProfileReport,
  profileReport,
  resolveFreebuffBin,
  selectProfile,
  type ProfileQuota,
} from '../src/freebuff/profiles.ts'

const SESSION = 'C:/Users/dev/.config/freebuff-session'
const FREEBUFF = 'C:/Users/dev/.config/freebuff'
const MANICODE = 'C:/Users/dev/.config/manicode'
const ORDER = [SESSION, FREEBUFF, MANICODE]

function probe(profile: string, remainingHours: number | null): ProfileQuota {
  return { profile, remainingHours, totalHours: remainingHours === null ? null : 12 }
}

test('le profil avec le plus d’heures est retenu', () => {
  const choice = selectProfile(
    [probe(SESSION, 2), probe(FREEBUFF, 12), probe(MANICODE, 9)],
    ORDER,
  )

  assert.deepEqual(choice, { profile: FREEBUFF, remainingHours: 12 })
})

test('un profil illisible n’est jamais choisi', () => {
  const choice = selectProfile([probe(SESSION, null), probe(FREEBUFF, 3)], ORDER)

  assert.deepEqual(choice, { profile: FREEBUFF, remainingHours: 3 })
})

test('un profil à zéro heure n’est jamais choisi', () => {
  const choice = selectProfile([probe(SESSION, 0), probe(FREEBUFF, 1)], ORDER)

  assert.deepEqual(choice, { profile: FREEBUFF, remainingHours: 1 })
})

test('à égalité, l’ordre de préférence tranche', () => {
  const choice = selectProfile(
    [probe(MANICODE, 12), probe(FREEBUFF, 12), probe(SESSION, 12)],
    ORDER,
  )

  assert.deepEqual(choice, { profile: SESSION, remainingHours: 12 })
})

test('à égalité, un profil absent de l’ordre passe en dernier', () => {
  const choice = selectProfile([probe(MANICODE, 12), probe(FREEBUFF, 12)], [FREEBUFF])

  assert.deepEqual(choice, { profile: FREEBUFF, remainingHours: 12 })
})

test('aucun profil avec des heures ne rend aucun choix', () => {
  assert.equal(selectProfile([probe(SESSION, 0), probe(FREEBUFF, null)], ORDER), null)
})

test('un seul profil avec des heures suffit', () => {
  const choice = selectProfile([probe(SESSION, 4)], ORDER)

  assert.deepEqual(choice, { profile: SESSION, remainingHours: 4 })
})

test('le rapport de sonde garde les mesures, leur date et les profils muets', () => {
  const report = profileReport(
    [probe(SESSION, 12), { profile: FREEBUFF, remainingHours: null, totalHours: null }],
    1_792_000_000_000,
  )

  assert.deepEqual(report, {
    at: 1_792_000_000_000,
    profiles: [
      { name: 'freebuff-session', path: SESSION, remainingHours: 12, totalHours: 12 },
      { name: 'freebuff', path: FREEBUFF, remainingHours: null, totalHours: null },
    ],
  })
  assert.deepEqual(parseProfileReport(JSON.stringify(report)), report)
})

test('un rapport de sonde douteux ne rend aucune mesure inventée', () => {
  assert.equal(parseProfileReport('pas du json'), null)
  assert.equal(parseProfileReport('{"profiles":[]}'), null)

  // Une heure d'un autre type fait écarter l'entrée, pas la convertir.
  const parsed = parseProfileReport(
    JSON.stringify({
      at: 1,
      profiles: [
        { name: 'a', path: 'A', remainingHours: '12', totalHours: 12 },
        { name: 'b', path: 'B', remainingHours: 3, totalHours: 12 },
      ],
    }),
  )
  assert.deepEqual(parsed, {
    at: 1,
    profiles: [{ name: 'b', path: 'B', remainingHours: 3, totalHours: 12 }],
  })
})

test('la liste fusionne mesures et voisins sans doublon, la mesure gagne', () => {
  const report = {
    at: 1,
    profiles: [{ name: 'freebuff-session', path: SESSION, remainingHours: 12, totalHours: 12 }],
  }
  const merged = mergeProfileReport(report, [
    // Même dossier écrit autrement : ce n'est pas un second profil.
    {
      name: 'freebuff-session',
      path: `${SESSION}/./`,
      remainingHours: null,
      totalHours: null,
    },
    { name: 'freebuff', path: FREEBUFF, remainingHours: null, totalHours: null },
  ])

  assert.deepEqual(
    merged.map(reading => reading.name),
    ['freebuff-session', 'freebuff'],
  )
  assert.equal(merged[0]?.remainingHours, 12, 'les heures mesurées ne sont pas écrasées')
  assert.equal(merged[1]?.remainingHours, null, 'un profil non sondé reste inconnu')
})

test('BRIDGE_PROFILE_DIR court-circuite la sonde', () => {
  const forced = path.join('D:/code', 'profil-impose')
  const output = execFileSync(process.execPath, ['scripts/pick-profile.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, BRIDGE_PROFILE_DIR: forced },
    encoding: 'utf8',
    timeout: 10_000,
  })

  assert.equal(output.trim(), path.resolve(forced))
})

test('les profils sont découverts par credentials.json, les noms connus d’abord', () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'fb-profiles-'))
  for (const name of ['freebuff2', 'manicode', 'freebuff', 'moncompte', 'zzz-dernier']) {
    mkdirSync(path.join(parent, name))
    writeFileSync(path.join(parent, name, 'credentials.json'), '{}', 'utf8')
  }
  // Un dossier sans credentials.json n'est pas un profil.
  mkdirSync(path.join(parent, 'pas-un-profil'))

  assert.deepEqual(
    discoverProfiles(parent).map(dir => path.basename(dir)),
    ['freebuff', 'manicode', 'freebuff2', 'moncompte', 'zzz-dernier'],
  )
  assert.deepEqual(discoverProfiles(path.join(parent, 'absent')), [])
})

test('le binaire de la CLI est cherché dans le profil, avant le chemin historique', () => {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'fb-bin-'))

  // Rien dans le profil : le chemin historique reste le dernier recours.
  assert.equal(
    resolveFreebuffBin(profile, {}),
    path.join(os.homedir(), '.config', 'manicode', 'freebuff.exe'),
  )

  // Le binaire du profil gagne, sous son nom Windows ou sous son nom nu.
  writeFileSync(path.join(profile, 'freebuff'), '', 'utf8')
  assert.equal(resolveFreebuffBin(profile, {}), path.join(profile, 'freebuff'))

  writeFileSync(path.join(profile, 'freebuff.exe'), '', 'utf8')
  assert.equal(resolveFreebuffBin(profile, {}), path.join(profile, 'freebuff.exe'))

  // `FREEBUFF_BIN` gagne sur tout le reste.
  assert.equal(
    resolveFreebuffBin(profile, { FREEBUFF_BIN: 'D:/ailleurs/freebuff.exe' }),
    'D:/ailleurs/freebuff.exe',
  )
})

test('le lanceur examine un profil dont le dossier porte un autre nom', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'fb-launch-'))
  const profile = path.join(home, '.config', 'moncompte')
  mkdirSync(profile, { recursive: true })
  writeFileSync(path.join(profile, 'credentials.json'), '{}', 'utf8')

  let stderr = ''
  try {
    execFileSync(process.execPath, ['scripts/pick-profile.ts'], {
      cwd: process.cwd(),
      // Un `home` à nous : le seul profil visible est celui-ci. Le binaire est
      // absent, donc la sonde ne lit aucune heure et le lanceur sort en 1.
      env: { ...process.env, USERPROFILE: home, HOME: home, BRIDGE_PROFILE_DIR: '' },
      encoding: 'utf8',
      timeout: 30_000,
    })
  } catch (error) {
    stderr = String((error as { stderr?: unknown }).stderr ?? '')
  }

  assert.match(stderr, /moncompte/, 'le profil est examiné au lieu d’être invisible')
  assert.doesNotMatch(
    stderr,
    /avec credentials\.json sous/,
    'le lanceur ne peut plus annoncer qu’il n’a vu aucun profil',
  )
})
