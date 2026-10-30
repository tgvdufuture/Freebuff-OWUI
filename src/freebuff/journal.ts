/**
 * Journal local du pont : un fichier par jour, rotation par taille.
 *
 * Règle de confidentialité (PRD §5) : aucun prompt, aucune réponse. Ce journal
 * sert à dater une connexion, un refus ou un binding — pas à relire le travail
 * de l'agent. Une écriture qui échoue ne doit jamais casser un tour.
 */
import fs from 'node:fs'
import path from 'node:path'

export interface JournalOptions {
  dir: string
  /** Taille maximale d'un fichier avant de passer au suivant. */
  maxBytes?: number
  /** Horloge injectable : les tests de rotation ne dorment pas. */
  now?: () => Date
}

const DEFAULT_MAX_BYTES = 2_000_000

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

export class Journal {
  private readonly dir: string
  private readonly maxBytes: number
  private readonly now: () => Date
  private day: string | null = null
  private file: string | null = null
  private size = 0

  constructor(options: JournalOptions) {
    this.dir = options.dir
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.now = options.now ?? (() => new Date())
  }

  write(event: string, fields: Record<string, unknown> = {}): void {
    try {
      const now = this.now()
      const day = now.toISOString().slice(0, 10)
      if (day !== this.day || this.file === null || this.size >= this.maxBytes) {
        this.rotate(day)
      }
      const line = JSON.stringify({ at: now.toISOString(), event, ...fields })
      fs.appendFileSync(this.file as string, `${line}\n`, 'utf8')
      this.size += Buffer.byteLength(line) + 1
    } catch (error) {
      // Un journal plein ne doit pas empêcher un tour : on le dit, on continue.
      console.error(`[journal] écriture impossible : ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Choisit le premier fichier du jour qui n'a pas atteint la limite. */
  private rotate(day: string): void {
    this.day = day
    fs.mkdirSync(this.dir, { recursive: true })

    let index = 0
    let file = path.join(this.dir, `bridge-${day}.log`)
    let size = sizeOf(file)
    while (size >= this.maxBytes) {
      index += 1
      file = path.join(this.dir, `bridge-${day}.${index}.log`)
      size = sizeOf(file)
    }
    this.file = file
    this.size = size
  }
}
