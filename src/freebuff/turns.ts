/**
 * Journal des tours : `data/turns.jsonl`, une ligne JSON par tour terminé.
 *
 * Il garde l'ISSUE (`ok`, `question`, `session_ended`, `refused`…) et le statut
 * HTTP de la CLI quand elle en donne un (`428 waiting_room_required`). Le PRD
 * l'exige pour ne pas confondre un refus avec un succès, et pour dater la fin
 * d'une session sans relire un écran.
 *
 * Une écriture qui échoue ne casse pas le tour : le pont a déjà répondu.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { CliFailure } from './transcript.ts'
import type { TurnFinish } from './session.ts'

export interface TurnRecord {
  /** ms epoch. */
  at: number
  chatId: string
  projectPath: string
  outcome: TurnFinish
  /** `statusCode` de la CLI, ou `null`. */
  status: number | null
}

export function recordOf(input: {
  at?: number
  chatId: string
  projectPath: string
  outcome: TurnFinish
  failure?: CliFailure | null
}): TurnRecord {
  return {
    at: input.at ?? Date.now(),
    chatId: input.chatId,
    projectPath: input.projectPath,
    outcome: input.outcome,
    status: input.failure?.status ?? null,
  }
}

export class TurnLog {
  private readonly file: string

  constructor(file: string) {
    this.file = file
  }

  append(record: TurnRecord): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`, 'utf8')
    } catch {
      // Disque indisponible : le tour reste rendu, seule la trace manque.
    }
  }
}
