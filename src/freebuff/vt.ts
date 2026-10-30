/**
 * Vue écran du PTY : les octets de la TUI, ramenés à une grille de texte.
 *
 * `ScreenBuffer` (screen.ts) garde un journal brut pour reconnaître les refus :
 * c'est volontairement bête et sans dépendance. Ici il faut autre chose — les
 * positions du curseur, les effacements et le repli des lignes — sinon les
 * redessins produisent du texte tronqué et dupliqué (mesuré en S6).
 *
 * `@xterm/headless` est l'émulateur officiel de VS Code : il rend la MÊME image
 * que la TUI, y compris `isWrapped`, qui permet de recoller les lignes repliées
 * sans deviner.
 */
import pkg from '@xterm/headless'
import type { ScreenLine } from './stream.ts'

const { Terminal } = pkg

export class ScreenView {
  private readonly term: InstanceType<typeof Terminal>

  constructor(cols = 120, rows = 40) {
    this.term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true })
  }

  write(chunk: string): void {
    this.term.write(chunk)
  }

  /**
   * L'émulateur traite ses écritures en file : lire sans attendre rend l'image
   * d'AVANT le chunk qui vient d'arriver. On ne lit donc qu'après ce vidage.
   */
  flush(): Promise<void> {
    return new Promise(resolve => {
      this.term.write('', () => resolve())
    })
  }

  /** Toutes les lignes connues, du haut du journal à la dernière écrite. */
  lines(): ScreenLine[] {
    const buffer = this.term.buffer.active
    const out: ScreenLine[] = []
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y)
      if (!line) continue
      let x = 0
      while (x < line.length && !(line.getCell(x)?.getChars() ?? '').trim()) x++
      const cell = line.getCell(x)
      out.push({
        text: line.translateToString(true),
        italic: (cell?.isItalic() ?? 0) !== 0,
        color: cell?.getFgColor(),
      })
    }
    return out
  }
}
