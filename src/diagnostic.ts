/**
 * Diagnostic local : ce que le pont sait de lui-même, sans lancer la CLI et
 * sans lire un seul fichier de compte.
 *
 * La version vient de `freebuff-metadata.json`, déposé à côté du binaire par
 * l'installateur. La CLI n'est interrogée que par ses flags autorisés
 * (`--continue`, `--cwd`, `--trust-agents`) : pas de `--version`, donc pas de
 * processus lancé pour `/health`.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ImportHealth } from './freebuff/importer.ts'

export interface CliStatus {
  found: boolean
  path: string
  version: string | null
}

export interface RefusalRecord {
  at: number
  status: number
  code: string
}

export interface SessionSnapshot {
  /** `chat:<id>` pour une conversation, `project:<chemin>` sans identifiant. */
  key?: string
  pid: number
  alive: boolean
  chatRef: string | null
  projectDir: string
}

/** Quota restant lu sur l'écran de la TUI — jamais deviné. */
export interface QuotaSnapshot {
  remainingHours: number | null
  totalHours: number | null
  exhausted: boolean
  /** ms epoch de la lecture. */
  at: number
  /** `session` : bandeau d'une session ouverte ; `probe` : TUI lancée sans consigne. */
  source: 'session' | 'probe'
}

export interface HealthSnapshot {
  ok: true
  stub: boolean
  /** Dernier passage de `npm run import:owui` (Phase 1) ; `null` avant le premier. */
  import?: ImportHealth | null
  cli: CliStatus
  profileDir: { path: string; exists: boolean }
  model: string | null
  /** Coût horaire du modèle actif tel que l'affiche le sélecteur, ou `null`. */
  modelCost?: string | null
  /** Dernier quota lu, ou `null` tant qu'aucune lecture n'a eu lieu. */
  quota?: QuotaSnapshot | null
  models: number
  captureDir: string
  /** `false` en marche réelle : aucun corps de requête n'est écrit sur disque. */
  capture?: boolean
  projectsRoot: string[]
  bindings: number
  bindingsError: string | null
  session: SessionSnapshot | null
  /** Une session par conversation, en parallèle (voir `SessionHost`). */
  sessions?: SessionSnapshot[]
  lastRefusal: RefusalRecord | null
}

export function cliStatus(bin: string): CliStatus {
  const found = fs.existsSync(bin)
  let version: string | null = null

  if (found) {
    try {
      const raw: unknown = JSON.parse(
        fs.readFileSync(path.join(path.dirname(bin), 'freebuff-metadata.json'), 'utf8'),
      )
      if (typeof raw === 'object' && raw !== null) {
        const value = (raw as Record<string, unknown>).version
        if (typeof value === 'string' && value.trim() !== '') version = value.trim()
      }
    } catch {
      // Métadonnée absente ou illisible : la version reste inconnue, sans
      // lancer la CLI. Ce n'est pas une erreur de diagnostic.
    }
  }

  return { found, path: bin, version }
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, char => HTML_ESCAPES[char] ?? char)

const yesNo = (value: boolean): string => (value ? 'oui' : 'non')

/**
 * Page autonome : aucune ressource externe, aucun secret. Les valeurs lues sur
 * le disque sont échappées — un nom de projet peut contenir `<`.
 */
export function renderDiagnosticPage(snapshot: HealthSnapshot): string {
  const cli = snapshot.cli
  const session = snapshot.session
  const refusal = snapshot.lastRefusal

  const rows: Array<[string, string]> = [
    ['Mode', snapshot.stub ? 'stub (aucune CLI pilotée)' : 'réel (session gardée ouverte)'],
    ['Binaire', cli.found ? escapeHtml(cli.path) : `introuvable — ${escapeHtml(cli.path)}`],
    ['Version', cli.version === null ? 'inconnue (métadonnée absente)' : escapeHtml(cli.version)],
    [
      'Profil',
      `${escapeHtml(snapshot.profileDir.path)} (existe : ${yesNo(snapshot.profileDir.exists)})`,
    ],
    ['Modèle écrit', snapshot.model === null ? 'aucun' : escapeHtml(snapshot.model)],
    ['Modèles exposés', String(snapshot.models)],
    [
      'Sessions',
      (snapshot.sessions ?? (session === null ? [] : [session])).length === 0
        ? 'aucune session ouverte'
        : (snapshot.sessions ?? [session as SessionSnapshot])
            .map(
              item =>
                `pid ${String(item.pid)}, vivante : ${yesNo(item.alive)}, ` +
                `chat ${escapeHtml(item.chatRef ?? '—')}, projet ${escapeHtml(item.projectDir)}`,
            )
            .join('<br>'),
    ],
    [
      'Dernier refus',
      refusal === null
        ? 'aucun depuis le démarrage'
        : `${escapeHtml(refusal.code)} (HTTP ${refusal.status}, ${escapeHtml(new Date(refusal.at).toISOString())})`,
    ],
    ['Racines projets', escapeHtml(snapshot.projectsRoot.join(', '))],
    ['Chats liés', String(snapshot.bindings)],
    [
      'Capture',
      snapshot.capture === false
        ? `désactivée (les prompts ne sont pas écrits ; dossier inutilisé : ${escapeHtml(snapshot.captureDir)})`
        : escapeHtml(snapshot.captureDir),
    ],
  ]

  if (snapshot.bindingsError !== null) {
    rows.push(['Bindings', escapeHtml(snapshot.bindingsError)])
  }

  const cells = rows
    .map(([label, value]) => `      <dt>${label}</dt>\n      <dd>${value}</dd>`)
    .join('\n')

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Freebuff OWUI — diagnostic</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 2rem 1rem; }
  main { max-width: 52rem; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
  p { margin: 0 0 1.5rem; opacity: 0.75; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.5rem 1.5rem; margin: 0; }
  dt { font-weight: 600; }
  dd { margin: 0; overflow-wrap: anywhere; }
  footer { margin-top: 2rem; font-size: 0.85rem; opacity: 0.6; }
</style>
</head>
<body>
  <main>
    <h1>Freebuff OWUI</h1>
    <p>Diagnostic local — aucune CLI lancée pour cette page.</p>
    <dl>
${cells}
    </dl>
    <footer>Aucun secret n'est affiché : le pont ne lit aucun fichier de compte.</footer>
  </main>
</body>
</html>
`
}
