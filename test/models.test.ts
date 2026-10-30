import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'fb-models-'))
const profileDir = path.join(dataDir, 'profile')
process.env.BRIDGE_DATA_DIR = dataDir
process.env.BRIDGE_API_KEY = 'test-key'
process.env.BRIDGE_PROFILE_DIR = profileDir

function writeModels(value: unknown): void {
  writeFileSync(path.join(dataDir, 'models.json'), JSON.stringify(value), 'utf8')
}

test('freebuff-new est le premier modèle exposé', async () => {
  writeModels([
    { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
    { id: 'z-ai/glm-5.3', label: 'GLM 5.3' },
  ])
  const { listExposedModels } = await import('../src/models.ts')
  const models = listExposedModels()

  assert.equal(models[0]?.id, 'freebuff-new')
  assert.deepEqual(
    models.slice(1).map(m => m.agentModel),
    ['deepseek/deepseek-v4-flash', 'z-ai/glm-5.3'],
  )
  assert.equal(new Set(models.map(m => m.id)).size, models.length)
})

test('deux fournisseurs avec le même nom court produisent deux identifiants distincts', async () => {
  writeModels([
    { id: 'z-ai/glm-5.3', label: 'GLM 5.3 (Z.ai)' },
    { id: 'acme/glm-5.3', label: 'GLM 5.3 (Acme)' },
  ])
  const { listExposedModels } = await import('../src/models.ts')
  const models = listExposedModels()

  assert.equal(models.length, 3)
  assert.equal(new Set(models.map(m => m.id)).size, 3)
  assert.deepEqual(models.slice(1).map(m => m.id), ['freebuff-glm-5-3', 'freebuff-acme-glm-5-3'])
})

test('un models.json invalide retombe sur le modèle par défaut', async () => {
  writeFileSync(path.join(dataDir, 'models.json'), '{ pas du json', 'utf8')
  const { listExposedModels } = await import('../src/models.ts')
  const models = listExposedModels()

  assert.equal(models.length, 2)
  assert.equal(models[1]?.agentModel, 'deepseek/deepseek-v4-flash')
})

test('un models.json vide retombe sur le modèle par défaut', async () => {
  writeModels([])
  const { listExposedModels } = await import('../src/models.ts')
  const models = listExposedModels()

  assert.equal(models.length, 2)
  assert.equal(models[1]?.agentModel, 'deepseek/deepseek-v4-flash')
})

test('resolveModelChoice renvoie le modèle Freebuff ou null pour le nouveau projet', async () => {
  writeModels([{ id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' }])
  const { resolveModelChoice, isNewProjectModel } = await import('../src/models.ts')

  assert.deepEqual(resolveModelChoice('freebuff-deepseek-v4-flash'), {
    id: 'deepseek/deepseek-v4-flash',
    key: null,
  })
  assert.equal(resolveModelChoice('freebuff-inconnu'), null)
  assert.equal(resolveModelChoice('freebuff-new'), null)
  assert.equal(isNewProjectModel('freebuff-new'), true)
  assert.equal(isNewProjectModel('freebuff-deepseek-v4-flash'), false)
})

test('le coût horaire est affiché dans le nom du modèle', async () => {
  writeModels([
    { id: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash', cost: '4x' },
    { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4.1 Flash', cost: '3x' },
  ])
  const { listExposedModels } = await import('../src/models.ts')

  assert.deepEqual(
    listExposedModels().slice(1).map(m => m.name),
    ['Freebuff · GLM 5.3 Flash · 4x', 'Freebuff · DeepSeek V4.1 Flash · 3x'],
  )
})

test('un modèle sans coût garde un nom nu', async () => {
  writeModels([{ id: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash' }])
  const { listExposedModels } = await import('../src/models.ts')

  assert.equal(listExposedModels()[1]?.name, 'Freebuff · GLM 5.3 Flash')
})

test('une entrée sans identifiant est exposée et résolue par sa clé', async () => {
  writeModels([{ key: 'm-ddc687c50f', label: 'Nemotron 3.5 Lightning', cost: 'gratuit' }])
  const { listExposedModels, resolveModelChoice } = await import('../src/models.ts')
  const exposed = listExposedModels()

  assert.equal(exposed.length, 2)
  assert.equal(exposed[1]?.agentModel, null)
  assert.equal(exposed[1]?.key, 'm-ddc687c50f')
  assert.deepEqual(resolveModelChoice(exposed[1]?.id ?? ''), { id: null, key: 'm-ddc687c50f' })
})

test('une entrée sans identifiant ni clé est ignorée', async () => {
  writeModels([{ label: 'Modèle fantôme' }])
  const { listExposedModels } = await import('../src/models.ts')

  assert.equal(listExposedModels().length, 2)
  assert.equal(listExposedModels()[1]?.agentModel, 'deepseek/deepseek-v4-flash')
})

test('le modèle courant de settings.json est exposé, sans doublon', async () => {
  mkdirSync(profileDir, { recursive: true })
  writeModels([{ id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' }])
  writeFileSync(
    path.join(profileDir, 'settings.json'),
    JSON.stringify({ freebuffModel: 'z-ai/glm-5.3' }),
    'utf8',
  )
  const { listExposedModels } = await import('../src/models.ts')

  assert.deepEqual(
    listExposedModels().map(m => m.agentModel),
    [null, 'deepseek/deepseek-v4-flash', 'z-ai/glm-5.3'],
  )

  // Déjà présent dans models.json : aucun doublon.
  writeFileSync(
    path.join(profileDir, 'settings.json'),
    JSON.stringify({ freebuffModel: 'deepseek/deepseek-v4-flash' }),
    'utf8',
  )
  assert.equal(listExposedModels().length, 2)

  rmSync(path.join(profileDir, 'settings.json'))
})
