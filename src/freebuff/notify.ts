/**
 * Toasts Windows : prévenir sans terminal (PRD F4.3).
 *
 * Le texte est FIXE : ni le prompt, ni une sortie d'outil ne sortent de la
 * machine — seul le code de l'issue et, pour une erreur, le message court de la
 * CLI. Un tour déjà notifié ne l'est pas deux fois (clé chat + horodatage), et
 * un envoi qui échoue ne casse jamais le tour : le pont a déjà répondu.
 */
import { createRequire } from 'node:module'
import type { TurnRecord } from './turns.ts'

export interface Toast {
  title: string
  message: string
}

const DETAIL_MAX = 120

function shorten(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > DETAIL_MAX ? `${oneLine.slice(0, DETAIL_MAX - 1)}…` : oneLine
}

/** Texte du toast pour un tour terminé, ou `null` quand il n'y a rien à dire. */
export function toastFor(record: TurnRecord, detail?: string | null): Toast | null {
  switch (record.outcome) {
    case 'ok':
      return { title: 'Freebuff — tour terminé', message: 'La réponse est prête dans OpenWebUI.' }
    case 'question':
      return {
        title: 'Freebuff — question de l’agent',
        message: 'Réponds dans OpenWebUI pour débloquer le tour.',
      }
    case 'session_ended':
      return {
        title: 'Freebuff — session terminée',
        message: 'Clique Continuer pour reprendre la conversation.',
      }
    case 'stopped':
      // L'utilisateur a arrêté lui-même : le prévenir ne lui apprend rien.
      return null
    default: {
      const status = record.status === null ? '' : ` (${String(record.status)})`
      const reason = detail?.trim() ? ` : ${shorten(detail)}` : ''
      return { title: 'Freebuff — tour non abouti', message: `${record.outcome}${status}${reason}` }
    }
  }
}

export class Notifier {
  private readonly send: ((toast: Toast) => void) | null
  private readonly seen = new Set<string>()

  /** @param send envoi réel ; `null` = aucun toast (tests, autre plateforme). */
  constructor(send: ((toast: Toast) => void) | null) {
    this.send = send
  }

  /** Envoie le toast de ce tour ; rend le toast parti, ou `null` s'il est ignoré. */
  notify(record: TurnRecord, detail?: string | null): Toast | null {
    if (this.send === null) return null
    const key = `${record.chatId}:${String(record.at)}`
    if (this.seen.has(key)) return null
    const toast = toastFor(record, detail)
    if (toast === null) return null
    this.seen.add(key)
    if (this.seen.size > 500) this.seen.clear()
    try {
      this.send(toast)
    } catch {
      // Un toast raté ne doit pas faire échouer un tour déjà rendu.
    }
    return toast
  }
}

/** Envoi réel sur Windows (`node-notifier`) ; `null` sur les autres systèmes. */
export function windowsToastSender(): ((toast: Toast) => void) | null {
  if (process.platform !== 'win32') return null
  const require = createRequire(import.meta.url)
  const notifier = require('node-notifier') as {
    notify: (options: { title: string; message: string; timeout?: number }) => void
  }
  return toast => {
    notifier.notify({ title: toast.title, message: toast.message, timeout: 8 })
  }
}
