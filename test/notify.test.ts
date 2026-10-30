import assert from 'node:assert/strict'
import test from 'node:test'
import { Notifier, toastFor, type Toast } from '../src/freebuff/notify.ts'
import { recordOf } from '../src/freebuff/turns.ts'
import type { TurnFinish } from '../src/freebuff/session.ts'

const turn = (outcome: TurnFinish, at = 1_700_000_000_000, status: number | null = null) => ({
  ...recordOf({ at, chatId: 'chat-1', projectPath: 'D:/code/alpha', outcome }),
  status,
})

const capture = () => {
  const sent: Toast[] = []
  return { sent, send: (toast: Toast): void => void sent.push(toast) }
}

test('une fin de tour normale envoie un toast', () => {
  const { sent, send } = capture()
  const notifier = new Notifier(send)

  const toast = notifier.notify(turn('ok'))

  assert.equal(sent.length, 1)
  assert.equal(toast?.title, sent[0]?.title)
})

test('une question de l’agent envoie un toast qui demande une réponse', () => {
  const { sent, send } = capture()
  new Notifier(send).notify(turn('question'))

  assert.equal(sent.length, 1)
  assert.match(sent[0]?.message ?? '', /Réponds/)
  assert.match(sent[0]?.title ?? '', /question/i)
})

test('une fin de session envoie un toast qui propose de continuer', () => {
  const { sent, send } = capture()
  new Notifier(send).notify(
    turn('session_ended', 1_700_000_000_001, 428),
    'Your free session has ended. Send your message again to start a new one.',
  )

  assert.equal(sent.length, 1)
  assert.match(sent[0]?.message ?? '', /Continuer/)
})

test('une erreur envoie un toast avec son code de statut, sur une seule ligne courte', () => {
  const { sent, send } = capture()
  const detail = 'ligne coupée\n'.repeat(60)
  new Notifier(send).notify(turn('refused', 1_700_000_000_002, 403), detail)

  assert.equal(sent.length, 1)
  assert.match(sent[0]?.message ?? '', /403/)
  assert.ok((sent[0]?.message ?? '').length <= 160, 'le détail est tronqué')
  assert.doesNotMatch(sent[0]?.message ?? '', /\n/, 'un toast reste sur une ligne')
})

test('un tour arrêté par l’utilisateur n’envoie aucun toast', () => {
  const { sent, send } = capture()
  const toast = new Notifier(send).notify(turn('stopped'))

  assert.equal(toast, null)
  assert.deepEqual(sent, [])
})

test('le même tour notifié deux fois ne part qu’une fois', () => {
  const { sent, send } = capture()
  const notifier = new Notifier(send)
  const once = turn('ok', 1_700_000_000_003)

  notifier.notify(once)
  notifier.notify(once)

  assert.equal(sent.length, 1)
})

test('dix tours consécutifs donnent dix toasts, sans doublon', () => {
  const { sent, send } = capture()
  const notifier = new Notifier(send)

  for (let i = 0; i < 10; i += 1) notifier.notify(turn('ok', 1_700_000_001_000 + i))

  assert.equal(sent.length, 10)
  assert.equal(new Set(sent.map(toast => `${toast.title}|${toast.message}`)).size, 1)
  assert.equal(new Set(sent).size, 10)
})

test('un envoi qui échoue ne remonte pas au tour', () => {
  const notifier = new Notifier(() => {
    throw new Error('bureau indisponible')
  })

  assert.doesNotThrow(() => notifier.notify(turn('ok', 1_700_000_000_004)))
})

test('sans envoi configuré, rien n’est tenté', () => {
  assert.equal(new Notifier(null).notify(turn('ok')), null)
  assert.equal(toastFor(turn('stopped')), null)
})
