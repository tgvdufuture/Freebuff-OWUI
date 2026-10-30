import assert from 'node:assert/strict'
import test from 'node:test'
import { captureEnabled, sessionLimit } from '../src/config.ts'

test('la capture est active pour le harnais S0 (stub par défaut)', () => {
  assert.equal(captureEnabled({}), true)
  assert.equal(captureEnabled({ BRIDGE_STUB: '1' }), true)
})

test('un pont en marche réelle n’écrit pas les prompts sur disque', () => {
  assert.equal(captureEnabled({ BRIDGE_STUB: '0' }), false)
  // Une valeur quelconque autre que '0' reste le stub : on ne capture que là.
  assert.equal(captureEnabled({ BRIDGE_STUB: 'oui' }), true)
})

test('la capture peut être demandée explicitement en marche réelle', () => {
  assert.equal(captureEnabled({ BRIDGE_STUB: '0', BRIDGE_CAPTURE: '1' }), true)
  assert.equal(captureEnabled({ BRIDGE_STUB: '0', BRIDGE_CAPTURE: '0' }), false)
})

test('la limite de sessions vaut 3 par défaut', () => {
  assert.equal(sessionLimit({}), 3)
  assert.equal(sessionLimit({ BRIDGE_MAX_SESSIONS: '2' }), 2)
})

test('une limite absurde retombe sur 3 plutôt que de tout autoriser', () => {
  // `NaN` comparé à un compte vaut toujours faux : sans repli, plus aucune limite.
  assert.equal(sessionLimit({ BRIDGE_MAX_SESSIONS: 'abc' }), 3)
  assert.equal(sessionLimit({ BRIDGE_MAX_SESSIONS: '0' }), 3)
  assert.equal(sessionLimit({ BRIDGE_MAX_SESSIONS: '-1' }), 3)
  assert.equal(sessionLimit({ BRIDGE_MAX_SESSIONS: '2.5' }), 3)
})
