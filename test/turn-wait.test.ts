import assert from 'node:assert/strict'
import test from 'node:test'
import { waitExpired } from '../src/freebuff/turn-wait.ts'

const MIN = 60_000

test('un tour qui avance n’est jamais rendu, même après le délai historique', () => {
  const now = 40 * MIN
  assert.equal(waitExpired({ now, deadline: 45 * MIN, lastProgress: now - 5_000, idleMs: 10 * MIN }), null)
})

test('un tour coupé (plus aucune écriture) est rendu après le délai d’inactivité', () => {
  const now = 30 * MIN
  assert.equal(waitExpired({ now, deadline: 45 * MIN, lastProgress: now - 10 * MIN, idleMs: 10 * MIN }), 'idle')
})

test('le plafond total s’applique même si la CLI écrit encore', () => {
  const now = 45 * MIN
  assert.equal(waitExpired({ now, deadline: 45 * MIN, lastProgress: now - 1_000, idleMs: 10 * MIN }), 'total')
})

test('l’inactivité l’emporte quand les deux échéances sont passées', () => {
  const now = 50 * MIN
  assert.equal(waitExpired({ now, deadline: 45 * MIN, lastProgress: now - 20 * MIN, idleMs: 10 * MIN }), 'idle')
})
