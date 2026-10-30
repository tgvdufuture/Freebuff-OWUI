import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.ts'
import { ModelSettings } from './freebuff/settings.ts'

/**
 * La liste des modèles est LOCALE et ÉDITABLE.
 *
 * Aucun fichier de la CLI n'énumère les modèles du compte : la liste vient du
 * serveur Freebuff et n'est visible que dans le sélecteur de la TUI. Comme on
 * refuse l'API, le pont ne peut pas la deviner. `data/models.json` est donc une
 * liste relevée à la main dans ce sélecteur, que l'utilisateur corrige.
 *
 * Deux façons de désigner un modèle, mesurées le 2026-10-21 sur la CLI 0.2.29 :
 * - `id` : identifiant lisible (`deepseek/deepseek-v4-flash`), écrit dans
 *   `freebuffModel` et affiché par le bandeau de la CLI ;
 * - `key` : clé opaque (`m-…`), écrite dans `freebuffModelKey`, la seule voie
 *   pour les modèles que la CLI ne connaît que par leur clé.
 * La CLI préfère `freebuffModelKey` quand elle existe : écrire un `id` sans
 * effacer la clé périmée laisse donc l'ancien modèle actif.
 */
export interface AgentModel {
  /** Identifiant attendu par `freebuffModel`, ou `null` si seule la clé existe. */
  id: string | null
  /** Clé attendue par `freebuffModelKey`, ou `null` si l'identifiant suffit. */
  key: string | null
  /** Libellé lisible affiché par OpenWebUI. */
  label: string
  /** Coût horaire tel que l'affiche la CLI (`3x`, `gratuit`, `payant`), ou `null`. */
  cost: string | null
}

export interface ExposedModel {
  /** Identifiant stable envoyé par OpenWebUI dans `model`. */
  id: string
  /** Nom affiché dans le sélecteur, coût compris. */
  name: string
  /** Modèle Freebuff (`freebuffModel`), ou `null`. */
  agentModel: string | null
  /** Clé Freebuff (`freebuffModelKey`), ou `null`. */
  key: string | null
  /** Coût horaire affiché, ou `null`. */
  cost: string | null
}

/** Ce qu'il faut écrire dans `settings.json` pour sélectionner un modèle. */
export interface ModelChoice {
  id: string | null
  key: string | null
}

const NEW_PROJECT_ID = 'freebuff-new'

const DEFAULT_MODELS: AgentModel[] = [
  { id: 'deepseek/deepseek-v4-flash', key: null, label: 'DeepSeek V4.1 Flash', cost: null },
]

function readAgentModels(): AgentModel[] {
  const file = path.join(config.dataDir, 'models.json')
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed)) return DEFAULT_MODELS
    const out: AgentModel[] = []
    for (const raw of parsed) {
      if (typeof raw !== 'object' || raw === null) continue
      const entry = raw as Record<string, unknown>
      const id = typeof entry.id === 'string' ? entry.id.trim() : ''
      const key = typeof entry.key === 'string' ? entry.key.trim() : ''
      const label = typeof entry.label === 'string' ? entry.label.trim() : ''
      const cost = typeof entry.cost === 'string' ? entry.cost.trim() : ''
      if (!label || (!id && !key)) continue
      out.push({ id: id || null, key: key || null, label, cost: cost || null })
    }
    return out.length ? out : DEFAULT_MODELS
  } catch {
    return DEFAULT_MODELS
  }
}

function slugify(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

/**
 * Construit la liste exposée : « Nouveau projet » puis un identifiant par
 * modèle. L'identifiant est stable tant que le modèle ne change pas ; en cas de
 * collision (deux fournisseurs, même nom court), le fournisseur est ajouté.
 *
 * Le modèle actuellement écrit dans `settings.json` est ajouté s'il manque à la
 * liste : OpenWebUI doit pouvoir afficher le modèle réellement actif même
 * quand `data/models.json` ne le mentionne pas encore.
 *
 * `profileDir` est passé par l'appelant : le pont peut changer de profil en
 * cours d'exécution, donc le modèle actif n'est plus celui de `config`.
 */
export function listExposedModels(profileDir: string = config.profileDir): ExposedModel[] {
  const models = [...readAgentModels()]
  const current = new ModelSettings(path.join(profileDir, 'settings.json')).read()
  if (current !== null && !models.some(m => m.id === current)) {
    models.push({ id: current, key: null, label: current, cost: null })
  }
  const seen = new Set<string>()

  const out: ExposedModel[] = [
    { id: NEW_PROJECT_ID, name: 'Freebuff · Nouveau projet', agentModel: null, key: null, cost: null },
  ]
  for (const m of models) {
    const source = m.id ?? m.key ?? m.label
    const [provider, ...rest] = source.includes('/') ? source.split('/') : ['', source]
    const short = slugify(rest.join('-') || provider || source)
    const base = `freebuff-${short}`
    let id = base
    if (seen.has(id)) id = `freebuff-${slugify(provider ?? 'model')}-${short}`
    let n = 2
    while (seen.has(id)) id = `${base}-${n++}`
    seen.add(id)
    out.push({
      id,
      name: `Freebuff · ${m.label}${m.cost ? ` · ${m.cost}` : ''}`,
      agentModel: m.id,
      key: m.key,
      cost: m.cost,
    })
  }
  return out
}

export function isNewProjectModel(id: string): boolean {
  return id === NEW_PROJECT_ID
}

/**
 * Coût horaire affiché pour un modèle donné (`3x`, `gratuit`…), ou `null`.
 *
 * Le modèle actif est écrit dans `settings.json` sous `freebuffModel` (un id)
 * ou `freebuffModelKey` (une clé opaque) : les deux formes sont cherchées.
 */
export function modelCost(choice: string | null): string | null {
  if (choice === null) return null
  const found = readAgentModels().find(model => model.id === choice || model.key === choice)
  return found?.cost ?? null
}

/** Ce qu'il faut écrire dans `settings.json` pour le modèle demandé, ou `null`. */
export function resolveModelChoice(id: string, profileDir: string = config.profileDir): ModelChoice | null {
  const found = listExposedModels(profileDir).find(m => m.id === id)
  if (!found || (found.agentModel === null && found.key === null)) return null
  return { id: found.agentModel, key: found.key }
}
