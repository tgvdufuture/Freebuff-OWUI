import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ScreenBuffer,
  SCREEN_CAP,
  classifyRefusal,
  parseQuota,
  parseSessionLeft,
  quotaMatchCount,
  stripAnsi,
} from '../src/freebuff/screen.ts'

test('stripAnsi garde le texte et retire les séquences visuelles', () => {
  const raw = '\x1b[2J\x1b[H\x1b[31m0/12 hours remaining\x1b[0m'
  assert.equal(stripAnsi(raw), '0/12 hours remaining')
})

test('le quota 0/12 est reconnu comme épuisé', () => {
  const view = parseQuota('10/17 • max · sandbox · Chat: New chat0/12 hours remaining')
  assert.deepEqual(view, { found: true, remainingHours: 0, totalHours: 12, exhausted: true })
})

test('un quota non nul n’est pas épuisé', () => {
  const view = parseQuota('3/12 hours remaining')
  assert.equal(view.found, true)
  assert.equal(view.remainingHours, 3)
  assert.equal(view.exhausted, false)
})

test('un écran sans quota ne produit pas de faux positif', () => {
  const view = parseQuota('Chat: New chat · /model to change')
  assert.deepEqual(view, { found: false, remainingHours: null, totalHours: null, exhausted: false })
})

test('le panneau /model donne le quota courant (« hours daily »)', () => {
  // Pied réellement capturé le 23/10 dans la TUI :
  // « FREE · 7/12 hours daily · resets in 13h 27m ».
  assert.deepEqual(parseQuota('FREE · 7/12 hours daily · resets in 13h 27m'), {
    found: true,
    remainingHours: 7,
    totalHours: 12,
    exhausted: false,
  })
})

test('la valeur la PLUS RÉCENTE l’emporte sur le bandeau du démarrage', () => {
  // Le bandeau d'ouverture ne bouge plus ; la ligne du panneau est plus fraîche.
  const screen = 'PRO · 12/12 hours remaining\n…\nPRO · 7/12 hours daily · resets in 13h 27m'
  assert.equal(parseQuota(screen).remainingHours, 7)
  assert.equal(quotaMatchCount(screen), 2)
})

test('le décompte de session est lu en minutes', () => {
  // Pied réellement capturé : « ╯ 59m left » sous le panneau de quota.
  assert.deepEqual(parseSessionLeft('│ 8/12 hours remaining │\n╯ 59m left'), {
    found: true,
    minutes: 59,
  })
  assert.deepEqual(parseSessionLeft('1h 5m left'), { found: true, minutes: 65 })
  assert.deepEqual(parseSessionLeft('2h left'), { found: true, minutes: 120 })
})

test('la DERNIÈRE valeur de l’écran l’emporte, pas la première', () => {
  assert.deepEqual(parseSessionLeft('59m left\n────────────────\n42m left'), {
    found: true,
    minutes: 42,
  })
})

test('le bandeau d’heures n’est pas pris pour un décompte de session', () => {
  assert.deepEqual(parseSessionLeft('8/12 hours remaining'), { found: false, minutes: null })
})

test('le quota épuisé prend le pas sur les autres refus', () => {
  const screen = '0/12 hours remaining. Your concurrent-session limit across CLI and Desktop is reached'
  assert.equal(classifyRefusal(screen), 'quota_exhausted')
})

test('la limite de sessions est reconnue', () => {
  assert.equal(
    classifyRefusal('Your concurrent-session limit across CLI and Desktop is reached'),
    'concurrent_sessions',
  )
})

test('les modèles indisponibles sont reconnus', () => {
  assert.equal(classifyRefusal("Models aren't available on this connection"), 'models_unavailable')
})

test('le bandeau informatif « Some models aren’t available » n’est pas un refus', () => {
  assert.equal(classifyRefusal("Some models aren't available on this connection"), null)
})

test('un vrai refus reste détecté même si le bandeau informatif est présent', () => {
  const screen =
    "Some models aren't available on this connection\nModels aren't available on this connection"
  assert.equal(classifyRefusal(screen), 'models_unavailable')
})

test('un modèle trop cher pour les heures restantes est reconnu', () => {
  // Écran réellement capturé le 22/10 sur le profil freebuff-session (2 h) :
  // le modèle choisi coûte 3 h par heure, aucun tour ne démarre.
  const screen =
    'Starting your model session… Your message is saved.\n' +
    'Not enough hours for DeepSeek V4.1 Flash 10/17: an hour on it takes 3 hours. ' +
    'Choose another model with /model or visit https://frebuff.com/plans. Enter: retry  Esc: back to draft'
  assert.equal(classifyRefusal(screen), 'not_enough_hours')
})

test('le panneau « Not enough hours » gagne sur le bandeau informatif', () => {
  const screen =
    "Some models aren't available on this connection\nNot enough hours for GLM 5.3 Flash: an hour on it takes 4 hours."
  assert.equal(classifyRefusal(screen), 'not_enough_hours')
})

test('un écran ordinaire ne classe aucun refus', () => {
  assert.equal(classifyRefusal('Chat: New chat · 10/17 · max'), null)
})

test('ScreenBuffer conserve les derniers 32 Ko, sans ANSI', () => {
  const buffer = new ScreenBuffer()
  buffer.push(`\x1b[31m${'a'.repeat(SCREEN_CAP)}`)
  buffer.push('\x1b[0m0/12 hours remaining')

  assert.equal(buffer.value.length, SCREEN_CAP)
  assert.ok(buffer.value.endsWith('0/12 hours remaining'))
  assert.ok(!buffer.value.includes('\x1b['))
})

test('le bandeau réel, entouré de séquences de redessin, reste lisible', () => {
  const buffer = new ScreenBuffer()
  buffer.push('\x1b[2J\x1b[H')
  buffer.push('│ Chat: New chat0/12 hours remaining │')
  buffer.push('\x1b[10;1H\x1b[K')

  const quota = parseQuota(buffer.value)
  assert.equal(quota.exhausted, true)
  assert.equal(quota.totalHours, 12)
})
