import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { browseProjects } from '../src/projects.ts'

const root = mkdtempSync(path.join(os.tmpdir(), 'fb-browse-'))
mkdirSync(path.join(root, 'alpha'))
mkdirSync(path.join(root, 'Beta'))
mkdirSync(path.join(root, '.cache'))
mkdirSync(path.join(root, 'alpha', 'sous-dossier'))
writeFileSync(path.join(root, 'fichier.txt'), 'x', 'utf8')

const roots = [root.replace(/\\/g, '/')]

test('sans chemin, l’explorateur part de la racine et ne remonte pas au-dessus', () => {
  const verdict = browseProjects(undefined, roots)
  assert.equal(verdict.ok, true)
  if (!verdict.ok) return

  assert.equal(verdict.browse.path, roots[0])
  assert.equal(verdict.browse.parent, null)
  assert.deepEqual(
    verdict.browse.dirs.map(dir => dir.name),
    ['alpha', 'Beta'],
  )
})

test('un sous-dossier expose son parent et ses propres dossiers', () => {
  const verdict = browseProjects(path.join(root, 'alpha'), roots)
  assert.equal(verdict.ok, true)
  if (!verdict.ok) return

  assert.equal(verdict.browse.parent, roots[0])
  assert.deepEqual(
    verdict.browse.dirs.map(dir => dir.name),
    ['sous-dossier'],
  )
})

test('un chemin hors racine est refusé', () => {
  const outside = mountSibling()
  const verdict = browseProjects(outside, roots)
  assert.equal(verdict.ok, false)
  if (!verdict.ok) assert.match(verdict.reason, /hors des racines/)
})

test('un chemin avec « .. » ou un dossier absent est refusé', () => {
  assert.equal(browseProjects(`${root}/../ailleurs`, roots).ok, false)
  assert.equal(browseProjects(path.join(root, 'inexistant'), roots).ok, false)
})

test('les fichiers et dossiers cachés ne sont jamais proposés', () => {
  const verdict = browseProjects(root, roots)
  assert.equal(verdict.ok, true)
  if (!verdict.ok) return
  const names = verdict.browse.dirs.map(dir => dir.name)
  assert.equal(names.includes('.cache'), false)
  assert.equal(names.includes('fichier.txt'), false)
})

/** Un dossier voisin du root, forcément hors racine. */
function mountSibling(): string {
  return path.resolve(root, '..')
}
