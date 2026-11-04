/**
 * Explorateur de dossiers pour le sélecteur de projet.
 *
 * Le navigateur ne peut pas ouvrir un vrai « finder » ni lire un chemin
 * absolu ; c'est donc le pont qui liste les dossiers. `projectsRoot` n'est
 * qu'un point de départ : tout dossier absolu existant peut être ouvert.
 * Aucune écriture, aucune création : on ne propose que ce qui existe déjà.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalizeProjectPath } from './bindings.ts'

export interface ProjectFolder {
  name: string
  path: string
}

export interface Browse {
  path: string
  parent: string | null
  roots: string[]
  dirs: ProjectFolder[]
}

export type BrowseVerdict =
  | { ok: true; browse: Browse }
  | { ok: false; reason: string }

const MAX_DIRS = 200

function subdirectories(dir: string): ProjectFolder[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }

  const out: ProjectFolder[] = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    const full = path.join(dir, name)
    try {
      if (!fs.statSync(full).isDirectory()) continue
    } catch {
      continue
    }
    out.push({ name, path: full.replace(/\\/g, '/') })
  }

  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  return out.slice(0, MAX_DIRS)
}

/**
 * Premier dossier existant parmi les points de départ : `projectsRoot`, sinon
 * le dossier de l'utilisateur, sinon la racine du disque.
 */
function startDirectory(roots: string[], isDirectory: (dir: string) => boolean): string {
  for (const root of roots) {
    if (isDirectory(root)) return root
  }
  const home = os.homedir()
  return isDirectory(home) ? home : path.parse(process.cwd()).root
}

/**
 * Liste les dossiers d'un chemin.
 *
 * Sans chemin, on part du premier point de départ configuré. `projectsRoot`
 * ne limite rien : n'importe quel dossier absolu existant peut être ouvert et
 * remonter jusqu'à la racine du disque.
 */
export function browseProjects(
  input: string | undefined,
  roots: string[],
  isDirectory: (dir: string) => boolean = defaultIsDirectory,
): BrowseVerdict {
  const target =
    input === undefined || input.trim() === '' ? startDirectory(roots, isDirectory) : input.trim()
  const verdict = normalizeProjectPath(target, isDirectory)
  if (!verdict.ok) return verdict

  const resolved = path.resolve(verdict.path)
  const parent =
    path.parse(resolved).root === resolved ? null : path.dirname(resolved).replace(/\\/g, '/')

  return {
    ok: true,
    browse: {
      path: verdict.path,
      parent,
      roots: roots.map(value => path.resolve(value).replace(/\\/g, '/')),
      dirs: subdirectories(resolved),
    },
  }
}

function defaultIsDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}
