/**
 * Tuer un processus ET ses enfants.
 *
 * `term.kill()` de ConPTY termine le processus lancé, pas ce que la CLI a
 * elle-même lancé. Sur Windows, `taskkill /T /F` est le seul moyen fiable de
 * couvrir l'arbre — et il doit partir AVANT `term.kill()` : une fois le parent
 * mort, `taskkill` ne retrouve plus la filiation.
 *
 * Un échec n'est jamais masqué : le PID encore vivant est rendu à l'appelant,
 * qui le signale au lieu de prétendre avoir arrêté le tour.
 */
import { spawnSync } from 'node:child_process'

export interface KillResult {
  ok: boolean
  pid: number
  /** Vrai si le processus est encore vivant après la tentative. */
  remaining: boolean
}

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM : le processus existe mais ne nous appartient pas.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface KillDeps {
  /** Injecté par les tests pour simuler un `taskkill` en échec. */
  taskkill?: (pid: number) => number | null
  alive?: (pid: number) => boolean
}

function runTaskkill(pid: number): number | null {
  // 3 s : au-delà, l'AC « arrêter tue l'arbre en moins de 3 s » est déjà violé.
  const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    timeout: 3_000,
  })
  return result.status
}

export function killTree(pid: number, deps: KillDeps = {}): KillResult {
  const alive = deps.alive ?? isAlive
  if (!alive(pid)) return { ok: true, pid, remaining: false }

  if (deps.taskkill !== undefined || process.platform === 'win32') {
    const status = (deps.taskkill ?? runTaskkill)(pid)
    if (status !== 0 && alive(pid)) return { ok: false, pid, remaining: true }
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Morte entre la vérification et le tir : ce n'est pas un échec.
    }
  }

  return { ok: !alive(pid), pid, remaining: alive(pid) }
}
