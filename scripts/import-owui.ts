#!/usr/bin/env node
/**
 * `npm run import:owui` — importer les conversations Freebuff dans OpenWebUI.
 *
 * Aucune CLI n'est lancée, aucun tour n'est consommé : le script lit `chats/`
 * et appelle l'API HTTP d'OWUI. Il est idempotent (`data/imports.json`) et peut
 * être relancé autant de fois que nécessaire.
 *
 * Usage :
 *   npm run import:owui -- --dry-run
 *   npm run import:owui -- --profile freebuff-session
 *   npm run import:owui -- --limit 5
 *
 * Prérequis : OWUI tourne, et une clé API existe dans `data/owui-key.txt` (ou
 * `BRIDGE_OWUI_KEY`). Elle se crée dans OWUI : Settings → Account → API keys.
 */
import os from 'node:os'
import path from 'node:path'
import { Bindings } from '../src/bindings.ts'
import { config } from '../src/config.ts'
import {
  DEFAULT_ARCHIVE_MODEL,
  ImportBusyError,
  importHealth,
  profileList,
  runImport,
} from '../src/freebuff/importer.ts'
import { createOwuiClient, OwuiError, resolveOwuiKey } from '../src/freebuff/owui.ts'

interface Args {
  dryRun: boolean
  profile?: string
  limit?: number
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (value === '--dry-run') {
      args.dryRun = true
      continue
    }
    if (value === '--profile') {
      const next = argv[i + 1]
      if (next === undefined || next.trim() === '') {
        console.error('--profile attend un nom ou un chemin')
        process.exit(2)
      }
      args.profile = next.trim()
      i += 1
      continue
    }
    if (value === '--limit') {
      const next = argv[i + 1]
      const parsed = next === undefined ? Number.NaN : Number(next)
      if (!Number.isInteger(parsed) || parsed < 0) {
        console.error('--limit attend un entier positif')
        process.exit(2)
      }
      args.limit = parsed
      i += 1
      continue
    }
    console.error(`argument inconnu : ${value ?? ''}`)
    process.exit(2)
  }
  return args
}

function numberFromEnv(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
}

const args = parseArgs(process.argv.slice(2))
// Une simulation ne parle pas à OWUI : elle ne doit pas exiger de clé.
const apiKey = args.dryRun ? null : resolveOwuiKey(config.dataDir)
if (apiKey === null && !args.dryRun) {
  console.error(
    [
      'Aucune clé API OWUI.',
      'Crée-la dans OpenWebUI : Settings → Account → API keys, puis colle-la dans data/owui-key.txt',
      'ou expose-la dans BRIDGE_OWUI_KEY. Le JWT de session ne convient pas (il expire).',
    ].join('\n'),
  )
  process.exit(2)
}

const profiles = profileList(
  process.env.BRIDGE_IMPORT_PROFILES,
  os.homedir(),
  process.env.BRIDGE_PROFILE_DIR,
)
const client = createOwuiClient({ baseUrl: config.owuiBaseUrl, apiKey: apiKey ?? '' })

/** Profil actif du pont, pour ne lier que ses conversations. `null` s'il est arrêté. */
async function bridgeProfile(): Promise<string | null> {
  try {
    const response = await fetch(`http://${config.host}:${String(config.port)}/health`)
    if (!response.ok) return null
    const body = (await response.json()) as { profileDir?: { path?: unknown } }
    const profile = body.profileDir?.path
    return typeof profile === 'string' && profile !== '' ? profile : null
  } catch {
    return null
  }
}

const liveProfile = await bridgeProfile()
const currentProfile = liveProfile ?? config.profileDir
const bindings = args.dryRun
  ? undefined
  : new Bindings(path.join(config.dataDir, 'bindings.json'))

try {
  const outcome = await runImport({
    dataFile: path.join(config.dataDir, 'imports.json'),
    profiles,
    client,
    model: process.env.BRIDGE_IMPORT_MODEL?.trim() || DEFAULT_ARCHIVE_MODEL,
    dryRun: args.dryRun,
    profile: args.profile,
    limit: args.limit,
    maxChars: numberFromEnv('BRIDGE_IMPORT_MAX_CHARS'),
    maxMessages: numberFromEnv('BRIDGE_IMPORT_MAX_MESSAGES'),
    projectsRoot: config.projectsRoot,
    currentProfile,
    bindings,
    log: line => console.log(line),
  })

  const { report, preview, store } = outcome
  const label = report.dryRun ? 'simulation' : 'import'
  const linked = Object.values(store.items).filter(item => item.bound).length
  console.log('')
  console.log(`${label} terminé en ${String(Math.max(0, Date.now() - report.at))} ms`)
  console.log(
    [
      `profils       : ${report.profiles.join(', ')}`,
      `profil        : ${currentProfile}${liveProfile === null ? ' (pont arrêté)' : ''}`,
      `scannées      : ${String(report.scanned)}`,
      `créés         : ${String(report.created)}`,
      `mis à jour    : ${String(report.updated)}`,
      `inchangés     : ${String(report.unchanged)}`,
      `ignorés       : ${String(report.skipped)}`,
      `stale         : ${String(report.stale)}`,
      `dossiers      : ${String(Object.keys(store.projectFolders).length)} (par projet)`,
      `liés          : ${String(linked)}`,
      `erreurs       : ${String(report.errors.length)}`,
    ].join('\n'),
  )
  if (!report.dryRun && linked > 0 && liveProfile !== null) {
    console.log(
      '\nBindings écrits : le pont les relit à la prochaine requête, aucun redémarrage.',
    )
  }
  if (report.dryRun && preview.length > 0) {
    console.log('\nAperçu (20 au plus) :')
    for (const line of preview) console.log(`  ${line}`)
  }
  if (report.errors.length > 0) {
    console.log('\nErreurs (10 au plus) :')
    for (const error of report.errors.slice(0, 10)) console.log(`  ${error}`)
  }
  console.log(`\n${JSON.stringify(importHealth(path.join(config.dataDir, 'imports.json')))}`)
} catch (error) {
  if (error instanceof ImportBusyError) {
    console.error(error.message)
    process.exit(4)
  }
  if (error instanceof OwuiError) {
    console.error(`OWUI a refusé la requête (${String(error.status)}) : ${error.body}`)
    process.exit(error.status === 401 || error.status === 403 ? 3 : 1)
  }
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
