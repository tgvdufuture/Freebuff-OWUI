#!/usr/bin/env node
/**
 * Récupère la sortie de l'agent dans une conversation de la CLI.
 *
 * À utiliser quand un tour n'a pas livré sa réponse dans OpenWebUI et que la
 * session est déjà fermée : tout est déjà sur le disque
 * (`projects/<projet>/chats/<ref>/chat-messages.json`), aucune CLI n'est
 * lancée, aucun tour n'est consommé.
 *
 * Usage :
 *   npm run recover                       # conversation la plus récente, tous projets
 *   npm run recover -- --project <chemin> # la plus récente de ce projet
 *   npm run recover -- --project <chemin> --ref <ref>
 *
 * Pour rediriger vers un fichier sans le préambule de npm :
 *   npm run recover --silent -- --project <chemin> > reponse.md
 *
 * Sortie : TOUT le dernier message de l'agent, raisonnements et réponses dans
 * l'ordre (la fin est gardée en priorité). Une conversation vide, ou dont la
 * seule réponse est « [response interrupted] », est ignorée au profit de la
 * précédente. Code 1 si rien n'a été trouvé.
 */
import path from 'node:path'
import { config } from '../src/config.ts'
import {
  conversationDir,
  hasAgentContent,
  lastAgentOutput,
  latestAgentOutput,
  latestConversation,
  renderAgentOutput,
  type AgentOutput,
  type LatestConversation,
} from '../src/freebuff/history.ts'

const USAGE = `usage : npm run recover -- [--project <chemin>] [--ref <nom>]
        (redirection : npm run recover --silent -- … > fichier.md)`

function flag(name: string): string | null {
  const index = process.argv.indexOf(name)
  if (index === -1) return null
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    console.error(`${name} attend une valeur\n${USAGE}`)
    process.exit(2)
  }
  return value
}

const projectArg = flag('--project')
const refArg = flag('--ref')

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(USAGE)
  process.exit(0)
}

if (refArg !== null && projectArg === null) {
  console.error(`--ref demande aussi --project (le ref seul ne dit pas où chercher)\n${USAGE}`)
  process.exit(2)
}

/** Projet d'une conversation, reconstruit depuis `projects/<nom>`. */
const projectOf = (conversation: LatestConversation): string =>
  path.join(config.profileDir, 'projects', conversation.project)

function pick(): { conversation: LatestConversation; output: AgentOutput } | null {
  if (projectArg !== null && refArg !== null) {
    const dir = conversationDir(config.profileDir, projectArg, refArg)
    if (dir === null) {
      console.error(`ref invalide : ${refArg}`)
      process.exit(2)
    }
    const output = lastAgentOutput(dir)
    if (!hasAgentContent(output)) return null
    return {
      conversation: { project: path.basename(projectArg), ref: refArg, dir, updatedAt: 0 },
      output,
    }
  }
  if (projectArg !== null) return latestAgentOutput(config.profileDir, projectArg)

  const latest = latestConversation(config.profileDir)
  if (latest === null) return null
  return latestAgentOutput(config.profileDir, projectOf(latest))
}

const found = pick()
if (found === null) {
  console.error(
    `aucun texte d'agent dans les conversations de ${projectArg ?? config.profileDir}`,
  )
  process.exit(1)
}

const { conversation, output } = found
const when =
  conversation.updatedAt === 0
    ? ''
    : `\nÉcrite       : ${new Date(conversation.updatedAt).toLocaleString('fr-FR')}`
const cut = output.error === null ? '' : `\nTour         : coupé — ${output.error}`
const rendered = renderAgentOutput(output)

console.log(`Conversation : ${conversation.project}/${conversation.ref}${when}${cut}`)
console.log('')
console.log(rendered.markdown)
