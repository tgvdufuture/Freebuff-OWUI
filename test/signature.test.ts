import assert from 'node:assert/strict'
import test from 'node:test'
import { compareThread, threadSignatures, waitsForInstruction } from '../src/signature.ts'

const user = (content: unknown) => ({ role: 'user', content })
const assistant = (content: unknown) => ({ role: 'assistant', content })

test('la même liste de messages est une régénération', () => {
  const stored = threadSignatures([user('bonjour'), assistant('salut'), user('continue')])
  const incoming = threadSignatures([user('bonjour'), assistant('salut'), user('continue')])

  assert.equal(compareThread(stored, incoming), 'regeneration')
})

test('un nouveau message utilisateur étend la signature', () => {
  const stored = threadSignatures([user('bonjour'), assistant('salut')])
  const incoming = threadSignatures([user('bonjour'), assistant('salut'), user('encore')])

  assert.equal(compareThread(stored, incoming), 'extended')
})

test('un message déjà envoyé modifié est une divergence, pas un refus', () => {
  const stored = threadSignatures([user('bonjour'), assistant('salut')])
  const incoming = threadSignatures([user('bonjour modifié'), assistant('salut')])

  assert.equal(compareThread(stored, incoming), 'diverged')
})

test('une liste raccourcie ou dans un autre ordre diverge', () => {
  const stored = threadSignatures([user('un'), assistant('deux'), user('trois')])

  assert.equal(compareThread(stored, threadSignatures([user('un'), assistant('deux')])), 'diverged')
  assert.equal(compareThread(stored, threadSignatures([assistant('deux'), user('un')])), 'diverged')
})

test('les messages système ne changent pas la signature', () => {
  const stored = threadSignatures([user('bonjour')])
  const incoming = threadSignatures([
    { role: 'system', content: 'Date : 2026-10-21' },
    user('bonjour'),
  ])

  assert.deepEqual(incoming, stored)
  assert.equal(compareThread(stored, incoming), 'regeneration')
})

test('un contenu en blocs texte est lu comme le texte équivalent', () => {
  const blocks = threadSignatures([user([{ type: 'text', text: 'bonjour' }])])
  const plain = threadSignatures([user('bonjour')])

  assert.deepEqual(blocks, plain)
})

test('sans tour enregistré, la requête est nouvelle', () => {
  const incoming = threadSignatures([user('bonjour')])
  assert.equal(compareThread(null, incoming), 'new')
  assert.equal(compareThread([], incoming), 'new')
})

test('seul un dernier message utilisateur porte une consigne', () => {
  assert.equal(waitsForInstruction([user('bonjour')]), false)
  assert.equal(waitsForInstruction([user('bonjour'), assistant('salut')]), true)
  assert.equal(waitsForInstruction([{ role: 'system', content: 'x' }]), true)
  assert.equal(waitsForInstruction([]), true)
})
