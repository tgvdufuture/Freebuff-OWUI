import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ModelSettings, SettingsUnreadable } from '../src/freebuff/settings.ts'

const dir = mkdtempSync(path.join(os.tmpdir(), 'fb-settings-'))
const file = (name: string): string => path.join(dir, name)

const readJson = (target: string): Record<string, unknown> =>
  JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>

test('set écrit freebuffModel et crée le fichier quand il est absent', () => {
  const target = file('absent.json')
  const settings = new ModelSettings(target)

  settings.set({ id: 'z-ai/glm-5.3', key: null })

  assert.equal(readJson(target).freebuffModel, 'z-ai/glm-5.3')
  assert.equal(new ModelSettings(target).read(), 'z-ai/glm-5.3')
})

test('set conserve les autres clés de settings.json', () => {
  const target = file('complet.json')
  writeFileSync(
    target,
    JSON.stringify({ freebuffModel: 'ancien/modele', theme: 'dark', nested: { a: 1 } }),
    'utf8',
  )

  new ModelSettings(target).set({ id: 'nouveau/modele', key: null })

  assert.deepEqual(readJson(target), {
    freebuffModel: 'nouveau/modele',
    theme: 'dark',
    nested: { a: 1 },
  })
})

test('set refuse un settings.json non-JSON et laisse le fichier intact', () => {
  const target = file('casse.json')
  const original = '{ pas du json'
  writeFileSync(target, original, 'utf8')

  assert.throws(
    () => new ModelSettings(target).set({ id: 'z-ai/glm-5.3', key: null }),
    SettingsUnreadable,
  )
  assert.equal(readFileSync(target, 'utf8'), original)
})

test('set refuse un settings.json qui n’est pas un objet', () => {
  const target = file('tableau.json')
  writeFileSync(target, '[]', 'utf8')

  assert.throws(
    () => new ModelSettings(target).set({ id: 'z-ai/glm-5.3', key: null }),
    SettingsUnreadable,
  )
  assert.equal(readFileSync(target, 'utf8'), '[]')
})

test('écrire un identifiant efface la clé périmée, sinon elle reste prioritaire', () => {
  const target = file('cle-perimee.json')
  writeFileSync(
    target,
    JSON.stringify({ freebuffModel: 'openai/gpt-6-luna', freebuffModelKey: 'm-ancienne' }),
    'utf8',
  )

  new ModelSettings(target).set({ id: 'deepseek/deepseek-v4-flash', key: null })

  const written = readJson(target)
  assert.equal(written.freebuffModel, 'deepseek/deepseek-v4-flash')
  assert.equal('freebuffModelKey' in written, false)
})

test('écrire une clé seule laisse freebuffModel tel quel', () => {
  const target = file('cle-seule.json')
  writeFileSync(target, JSON.stringify({ freebuffModel: 'deepseek/deepseek-v4-flash' }), 'utf8')

  new ModelSettings(target).set({ id: null, key: 'm-61c26317cc' })

  assert.deepEqual(readJson(target), {
    freebuffModel: 'deepseek/deepseek-v4-flash',
    freebuffModelKey: 'm-61c26317cc',
  })
})

test('readChoice expose la clé en plus de l’identifiant', () => {
  // La CLI préfère `freebuffModelKey` : le diagnostic doit pouvoir le dire.
  const target = file('choix.json')
  writeFileSync(
    target,
    JSON.stringify({ freebuffModel: 'deepseek/deepseek-v4-flash', freebuffModelKey: 'm-b2a427415d' }),
    'utf8',
  )

  const settings = new ModelSettings(target)
  assert.deepEqual(settings.readChoice(), { id: 'deepseek/deepseek-v4-flash', key: 'm-b2a427415d' })
  assert.equal(settings.read(), 'deepseek/deepseek-v4-flash')
})

test('readChoice renvoie null quand aucun modèle n’est écrit', () => {
  const absent = file('sans-choix.json')
  assert.equal(new ModelSettings(absent).readChoice(), null)

  writeFileSync(absent, JSON.stringify({ freebuffModel: '   ' }), 'utf8')
  assert.equal(new ModelSettings(absent).readChoice(), null)
})

test('read renvoie null quand le fichier est absent ou sans modèle', () => {
  const missing = file('sans-fichier.json')
  assert.equal(new ModelSettings(missing).read(), null)
  assert.equal(existsSync(missing), false)

  const empty = file('sans-modele.json')
  writeFileSync(empty, JSON.stringify({ theme: 'dark' }), 'utf8')
  assert.equal(new ModelSettings(empty).read(), null)

  rmSync(empty)
})
