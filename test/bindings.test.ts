import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Bindings, PENDING_TTL_MS, normalizeProjectPath } from '../src/bindings.ts'

const ROOT = 'D:/code'
const alwaysDir = () => true

function bindingsFile(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), 'fb-bindings-')), 'bindings.json')
}

test('un binding écrit hors du pont est relu sans redémarrer', () => {
  const file = bindingsFile()
  const live = new Bindings(file)
  live.set('chat-1', 'D:/code/alpha')

  // Un `npm run import:owui` concurrent écrit un second chat.
  const manual = new Bindings(file)
  manual.set('chat-2', 'D:/code/beta')
  assert.equal(live.get('chat-2'), null)

  live.refresh()
  assert.equal(live.get('chat-2'), 'D:/code/beta')
  assert.equal(live.get('chat-1'), 'D:/code/alpha')
})

test('un chemin absolu sous une racine autorisée est accepté et normalisé', () => {
  const verdict = normalizeProjectPath('D:\\code\\mon-projet\\', [ROOT], alwaysDir)
  assert.deepEqual(verdict, { ok: true, path: 'D:/code/mon-projet' })
})

test('un chemin relatif est refusé', () => {
  const verdict = normalizeProjectPath('mon-projet', [ROOT], alwaysDir)
  assert.equal(verdict.ok, false)
  assert.match(verdict.ok ? '' : verdict.reason, /absolu/)
})

test('un chemin contenant « .. » est refusé même s’il reste sous la racine', () => {
  const verdict = normalizeProjectPath('D:/code/alpha/../beta', [ROOT], alwaysDir)
  assert.equal(verdict.ok, false)
  assert.match(verdict.ok ? '' : verdict.reason, /\.\./)
})

test('un chemin hors des racines autorisées est refusé avec la liste', () => {
  const verdict = normalizeProjectPath('D:/autre/projet', [ROOT], alwaysDir)
  assert.equal(verdict.ok, false)
  assert.match(verdict.ok ? '' : verdict.reason, /D:\/code/)
})

test('un dossier inexistant est refusé', () => {
  const verdict = normalizeProjectPath('D:/code/fantome', [ROOT], () => false)
  assert.equal(verdict.ok, false)
  assert.match(verdict.ok ? '' : verdict.reason, /n'existe pas/)
})

test('un chemin vide ou non textuel est refusé', () => {
  assert.equal(normalizeProjectPath('   ', [ROOT], alwaysDir).ok, false)
  assert.equal(normalizeProjectPath(null, [ROOT], alwaysDir).ok, false)
  assert.equal(normalizeProjectPath(42, [ROOT], alwaysDir).ok, false)
})

test('les guillemets autour d’un chemin collé sont tolérés', () => {
  assert.deepEqual(normalizeProjectPath('"D:/code/alpha"', [ROOT], alwaysDir), {
    ok: true,
    path: 'D:/code/alpha',
  })
})

test('un binding est relu après redémarrage et expose les projets récents', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fb-bindings-'))
  const file = path.join(dir, 'bindings.json')

  const first = new Bindings(file)
  assert.equal(first.count(), 0)
  first.set('chat-1', 'D:/code/alpha')
  first.set('chat-2', 'D:/code/beta')
  first.set('chat-3', 'D:/code/alpha')

  const reloaded = new Bindings(file)
  assert.equal(reloaded.get('chat-1'), 'D:/code/alpha')
  assert.equal(reloaded.get('inconnu'), null)
  assert.deepEqual(reloaded.recent(), ['D:/code/alpha', 'D:/code/beta'])
  assert.equal(reloaded.readError, null)
})

test('un binding d’import garde la reprise et le profil, sans écraser un chat existant', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fb-bindings-'))
  const file = path.join(dir, 'bindings.json')
  const ref = '2026-10-22T10-00-00.000Z'

  const bindings = new Bindings(file)
  assert.equal(
    bindings.bindImported('chat-import', {
      projectPath: 'D:/code/alpha',
      ref,
      profileDir: 'C:/Users/moi/.config/freebuff-session',
      importedAt: 1_700_000_000_000,
      lastTurnAt: 1_699_999_000_000,
    }),
    true,
  )
  assert.equal(bindings.resumeRef('chat-import'), ref)
  assert.deepEqual(bindings.chatRefs('chat-import'), [ref])

  // Un second import du même chat ne remplace pas le premier binding.
  assert.equal(
    bindings.bindImported('chat-import', {
      projectPath: 'D:/code/beta',
      ref: 'autre-ref',
      profileDir: 'C:/autre',
      importedAt: 2,
      lastTurnAt: 2,
    }),
    false,
  )
  assert.equal(bindings.get('chat-import'), 'D:/code/alpha')

  bindings.recordTurn('chat-import', ['hash'])
  assert.equal(bindings.resumeRef('chat-import'), null)

  const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>
  assert.equal(stored['chat-import']?.profileDir, 'C:/Users/moi/.config/freebuff-session')
  assert.equal(stored['chat-import']?.importedAt, 1_700_000_000_000)
  assert.equal(new Bindings(file).chatRefs('chat-import')[0], ref)
})

test('un bindings.json corrompu n’est jamais réécrit', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fb-bindings-'))
  const file = path.join(dir, 'bindings.json')
  writeFileSync(file, '{ pas du json', 'utf8')

  const bindings = new Bindings(file)
  assert.match(bindings.readError ?? '', /illisible/)
  assert.equal(bindings.get('chat-1'), null)
  assert.throws(() => bindings.set('chat-1', 'D:/code/alpha'), /illisible/)
  assert.equal(readFileSync(file, 'utf8'), '{ pas du json')
})

test('le dossier retenu survit au redémarrage et n’est pas compté comme un binding', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fb-bindings-'))
  const file = path.join(dir, 'bindings.json')

  const first = new Bindings(file)
  first.setPending('D:/code/alpha')
  assert.equal(first.count(), 0)

  const reloaded = new Bindings(file)
  assert.equal(reloaded.pendingPath(), 'D:/code/alpha')
  assert.equal(reloaded.count(), 0)
  assert.equal(reloaded.recent().length, 0)
})

test('le dossier retenu est consommé une seule fois', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fb-bindings-'))
  const file = path.join(dir, 'bindings.json')

  const bindings = new Bindings(file)
  bindings.setPending('D:/code/alpha')
  assert.equal(bindings.takePending('chat-neuf'), 'D:/code/alpha')
  assert.equal(bindings.get('chat-neuf'), 'D:/code/alpha')
  assert.equal(bindings.pendingPath(), null)
  assert.equal(bindings.takePending('chat-neuf-2'), null)
  assert.equal(bindings.get('chat-neuf-2'), null)
})

test('un dossier retenu trop vieux est ignoré', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fb-bindings-'))
  const file = path.join(dir, 'bindings.json')

  const bindings = new Bindings(file)
  bindings.setPending('D:/code/alpha')
  const later = Date.now() + PENDING_TTL_MS + 1

  assert.equal(bindings.pendingPath(later), null)
  assert.equal(bindings.takePending('chat-neuf', later), null)
  assert.equal(bindings.get('chat-neuf'), null)
})

test('les signatures d’un tour survivent au redémarrage', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fb-bindings-'))
  const file = path.join(dir, 'bindings.json')

  const first = new Bindings(file)
  first.set('chat-1', 'D:/code/alpha')
  assert.equal(first.signatures('chat-1'), null)
  first.recordTurn('chat-1', ['hash-a', 'hash-b'])

  const reloaded = new Bindings(file)
  assert.deepEqual(reloaded.signatures('chat-1'), ['hash-a', 'hash-b'])
  assert.equal(reloaded.signatures('inconnu'), null)
})

test('la conversation à reprendre est persistée, puis oubliée dès un tour abouti', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fb-bindings-'))
  const file = path.join(dir, 'bindings.json')

  const first = new Bindings(file)
  first.set('chat-1', 'D:/code/alpha')
  assert.equal(first.resumeRef('chat-1'), null)
  first.setResumeRef('chat-1', '2026-10-22T10-00-00.000Z')

  // La reprise survit au redémarrage : c'est un choix de l'utilisateur.
  const reloaded = new Bindings(file)
  assert.equal(reloaded.resumeRef('chat-1'), '2026-10-22T10-00-00.000Z')

  reloaded.recordTurn('chat-1', ['hash-a'])
  assert.equal(reloaded.resumeRef('chat-1'), null)
  assert.equal(new Bindings(file).resumeRef('chat-1'), null)
})

test('une reprise ne peut pas être notée sur un chat inconnu ou un fichier corrompu', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fb-bindings-'))
  const file = path.join(dir, 'bindings.json')
  const bindings = new Bindings(file)
  bindings.set('chat-1', 'D:/code/alpha')
  assert.throws(() => bindings.setResumeRef('inconnu', 'ref'), /inconnu/)

  const corrupted = path.join(dir, 'corrompu.json')
  writeFileSync(corrupted, '{ pas du json', 'utf8')
  assert.throws(() => new Bindings(corrupted).setResumeRef('chat-1', 'ref'), /illisible/)
  assert.equal(readFileSync(corrupted, 'utf8'), '{ pas du json')
})

test('le fichier écrit est du JSON lisible à la main', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fb-bindings-'))
  const file = path.join(dir, 'bindings.json')
  new Bindings(file).set('chat-1', 'D:/code/alpha')

  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { projectPath: string }>
  assert.equal(parsed['chat-1']?.projectPath, 'D:/code/alpha')
})

test('les conversations utilisées par un chat sont gardées, la plus récente d’abord', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fb-bindings-'))
  const file = path.join(dir, 'bindings.json')

  const bindings = new Bindings(file)
  bindings.set('chat-1', 'D:/code/alpha')
  assert.deepEqual(bindings.chatRefs('chat-1'), [])

  bindings.recordChatRef('chat-1', 'ref-a')
  bindings.recordChatRef('chat-1', 'ref-b')
  // Revoir une conversation la remet en tête, sans doublon.
  bindings.recordChatRef('chat-1', 'ref-a')
  assert.deepEqual(bindings.chatRefs('chat-1'), ['ref-a', 'ref-b'])

  // Trois au plus : la plus ancienne sort.
  bindings.recordChatRef('chat-1', 'ref-c')
  bindings.recordChatRef('chat-1', 'ref-d')
  assert.deepEqual(bindings.chatRefs('chat-1'), ['ref-d', 'ref-c', 'ref-a'])

  const reloaded = new Bindings(file)
  assert.deepEqual(reloaded.chatRefs('chat-1'), ['ref-d', 'ref-c', 'ref-a'])
  assert.deepEqual(reloaded.chatRefs('inconnu'), [])
  assert.throws(() => reloaded.recordChatRef('inconnu', 'ref'), /inconnu/)
})
