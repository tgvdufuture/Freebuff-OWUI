/**
 * Explorateur de dossiers pour le sélecteur de projet.
 *
 * Le navigateur ne peut pas ouvrir un vrai « finder » ni lire un chemin
 * absolu ; c'est donc le pont qui liste les dossiers, et seulement sous
 * `projectsRoot`. Aucune écriture, aucune création : on ne propose que ce qui
 * existe déjà.
 */
import fs from 'node:fs'
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
 * Liste les dossiers d'un chemin, sous les racines autorisées.
 *
 * Sans chemin, on part de la première racine — le point d'entrée du sélecteur.
 * Une racine peut remonter jusqu'à elle-même, jamais au-dessus.
 */
export function browseProjects(
  input: string | undefined,
  roots: string[],
  isDirectory: (dir: string) => boolean = defaultIsDirectory,
): BrowseVerdict {
  const root = roots[0]
  if (root === undefined) {
    return { ok: false, reason: 'aucune racine de projets configurée (BRIDGE_PROJECTS_ROOT).' }
  }

  const target = input === undefined || input.trim() === '' ? root : input.trim()
  const verdict = normalizeProjectPath(target, roots, isDirectory)
  if (!verdict.ok) return verdict

  const resolved = path.resolve(verdict.path)
  const insideRoot = roots.some(candidate => {
    const rel = path.relative(path.resolve(candidate), resolved)
    return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`))
  })
  if (!insideRoot) return { ok: false, reason: `« ${resolved} » est hors des racines autorisées.` }

  const parent = roots.some(candidate => path.resolve(candidate) === resolved)
    ? null
    : path.dirname(resolved).replace(/\\/g, '/')

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
