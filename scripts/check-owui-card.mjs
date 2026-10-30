#!/usr/bin/env node
/**
 * Vérifie que le patch local d'OpenWebUI fait toujours ce qu'il promet.
 *
 * Le patch (`scripts/patch-owui-multiselect.py`) vit dans `.venv-owui`, hors
 * dépôt : une mise à jour d'OpenWebUI le remplace, et `start-owui.sh` peut
 * réappliquer des remplacements devenus obsolètes sans que rien ne se voie.
 * Ce contrôle monte le VRAI composant `AskUserCard` du chunk patché dans un
 * Chrome headless, clique les cases et lit ce qui en sort.
 *
 * Sorties : 0 = tout est conforme, 1 = une vérification a échoué,
 * 2 = impossible de vérifier (OpenWebUI ou Chrome absent, chunk introuvable).
 *
 * Usage : `npm run check-owui`
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VENV = process.env.OWUI_VENV ?? path.join(ROOT, '.venv-owui')
const PORT = Number(process.env.CHECK_OWUI_PORT ?? 8123)
const CHUNK_MARK = 'my-1 rounded-2xl bg-gray-50/70 px-3.5 py-3'
const WORK_COPY = '__check.js'

const fail = (message, code = 2) => {
  console.error(`check-owui : ${message}`)
  process.exit(code)
}

/** Dossier du paquet `open_webui` dans le venv (Windows ou POSIX). */
function packageDir() {
  const candidates = [
    path.join(VENV, 'Lib/site-packages/open_webui'),
    path.join(VENV, 'lib/python3.12/site-packages/open_webui'),
    path.join(VENV, 'lib/python3.13/site-packages/open_webui'),
  ]
  for (const dir of candidates) if (fs.existsSync(dir)) return dir
  // Dernier recours : les venvs Linux nomment la version.
  const lib = path.join(VENV, 'lib')
  if (fs.existsSync(lib)) {
    for (const version of fs.readdirSync(lib)) {
      const dir = path.join(lib, version, 'site-packages/open_webui')
      if (fs.existsSync(dir)) return dir
    }
  }
  return null
}

const pkg = packageDir()
if (pkg === null) fail(`paquet open_webui introuvable sous ${VENV}`)

const chunksDir = path.join(pkg, 'frontend/_app/immutable/chunks')
if (!fs.existsSync(chunksDir)) fail(`chunks introuvables : ${chunksDir}`)

const chunks = fs
  .readdirSync(chunksDir)
  .filter(name => name.endsWith('.js') && !name.startsWith('__'))

/** Le chunk du composant AskUserCard : un seul contient son gabarit. */
const cardChunk = chunks
  .map(name => path.join(chunksDir, name))
  .find(file => fs.readFileSync(file, 'utf8').split(CHUNK_MARK).length === 2)
if (cardChunk === undefined) fail('chunk AskUserCard introuvable (OpenWebUI a changé de build ?)')

/**
 * Le runtime Svelte : le chunk qui définit `mount`/`tick`, avec leurs noms
 * d'export minifiés — ils changent à chaque build, donc on les lit.
 */
function runtimeNames() {
  for (const name of chunks) {
    const file = path.join(chunksDir, name)
    const text = fs.readFileSync(file, 'utf8')
    if (!text.includes('function zr(e,t){return Wr(e,t)}') || !text.includes('function di(')) continue
    const block = /export\{([^}]*)\}/.exec(text)
    if (block === null) continue
    const names = new Map()
    for (const pair of block[1].split(',')) {
      const [local, exported] = pair.split(' as ').map(part => part.trim())
      if (exported !== undefined) names.set(local, exported)
    }
    const mount = names.get('zr')
    const tick = names.get('di')
    if (mount !== undefined && tick !== undefined) return { file: name, mount, tick }
  }
  return null
}

const runtime = runtimeNames()
if (runtime === null) fail('runtime Svelte introuvable (mount/tick) — OpenWebUI a changé')

// Copie de travail : le composant n'est pas exporté par le chunk.
fs.writeFileSync(path.join(chunksDir, WORK_COPY), `${fs.readFileSync(cardChunk, 'utf8')}\nexport{Ax as inner}\n`)
const cleanup = () => {
  try {
    fs.rmSync(path.join(chunksDir, WORK_COPY))
  } catch {
    // déjà supprimé
  }
}
process.on('exit', cleanup)
process.on('SIGINT', () => process.exit(130))

const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>check</title></head>
<body><div id="app"></div><pre id="check"></pre>
<script type="module">
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail: String(detail) }) }
const finish = () => { document.getElementById('check').textContent = JSON.stringify(results) }
window.addEventListener('error', event => { check('page sans erreur', false, event.message); finish() })
window.addEventListener('unhandledrejection', event => { check('page sans erreur', false, String(event.reason)); finish() })

const rt = await import('/immutable/chunks/${runtime.file}')
const card = await import('/immutable/chunks/${WORK_COPY}')
const mount = rt.${runtime.mount}
const tick = rt.${runtime.tick}
const i18n = { subscribe: run => { run({ t: key => key, language: 'fr' }); return () => {} } }
const context = new Map([['i18n', i18n]])
const settle = ms => new Promise(done => setTimeout(done, ms))

const multi = options => [{
  id: 'q-multi', header: 'Freebuff', question: 'Quels dossiers ?',
  multi_select: true, allow_other: false,
  options: options.map(label => ({ label, description: label })),
}]
const single = [{
  id: 'q-single', header: 'Freebuff', question: 'Quelle taille ?', allow_other: false,
  options: [{ label: 'court', description: 'court' }, { label: 'long', description: 'long' }],
}]

const confirmed = []
const mountCard = async (questions, target) => {
  mount(card.inner, {
    target, context,
    props: { show: true, questions, allowOther: false },
    events: { confirm: event => confirmed.push(event.detail) },
  })
  await tick()
  await settle(30)
}
const rows = target => [...target.querySelectorAll('button')]
const row = (target, label) => rows(target).find(candidate => candidate.innerText.includes(label))
const box = (target, label) => {
  const element = row(target, label)
  if (element === undefined) return null
  const pseudo = getComputedStyle(element.querySelector('span'), '::before')
  return {
    selected: element.className.includes('fb-on'),
    hasBox: element.className.includes('fb-opt'),
    background: pseudo.backgroundColor,
    content: pseudo.content,
    color: pseudo.color,
  }
}
const submitOf = target => rows(target).find(candidate => candidate.innerText.includes('Submit'))

// 1. Carte à quatre cases : rendu, coche, état visuel.
const body = document.getElementById('app')
const multiTarget = document.createElement('div')
body.appendChild(multiTarget)
await mountCard(multi(['tests', 'documentation', 'performance', 'sécurité']), multiTarget)
const labels = multiTarget.innerText
check('les quatre libellés sont rendus', ['tests', 'documentation', 'performance', 'sécurité'].every(label => labels.includes(label)), labels)
check('aucun caractère ☐/☑ (emoji violet)', !labels.includes('☐') && !labels.includes('☑'), labels)
check('quatre cases dessinées', rows(multiTarget).filter(candidate => candidate.className.includes('fb-opt')).length === 4)
const initial = box(multiTarget, 'tests')
check('case vide au départ', initial !== null && !initial.selected && initial.background === 'rgba(0, 0, 0, 0)', JSON.stringify(initial))
check('envoi désactivé sans coche', submitOf(multiTarget)?.disabled === true)

row(multiTarget, 'tests').click()
await settle(40)
const ticked = box(multiTarget, 'tests')
check('clic : case cochée', ticked !== null && ticked.selected, JSON.stringify(ticked))
check('clic : fond noir OWUI', ticked !== null && ticked.background === 'rgb(17, 24, 39)', JSON.stringify(ticked))
check('clic : coche blanche', ticked !== null && ticked.content.includes('✓') && ticked.color === 'rgb(255, 255, 255)', JSON.stringify(ticked))

row(multiTarget, 'performance').click()
await settle(40)
check('deux cases cochées', box(multiTarget, 'performance')?.selected === true)
check('envoi activé avec deux coches', submitOf(multiTarget)?.disabled === false)

submitOf(multiTarget).click()
await settle(40)
const answer = confirmed.at(-1)
check(
  'réponse : deux libellés exacts',
  answer?.status === 'answered' &&
    Array.isArray(answer.answers['q-multi']?.labels) &&
    JSON.stringify(answer.answers['q-multi'].labels) === JSON.stringify(['tests', 'performance']) &&
    JSON.stringify(answer.answers['q-multi'].option_indices) === JSON.stringify([0, 2]),
  JSON.stringify(answer),
)

// 2. Re-clic : la case se décoche, l'envoi redevient impossible.
const toggleTarget = document.createElement('div')
body.appendChild(toggleTarget)
await mountCard(multi(['tests', 'documentation']), toggleTarget)
row(toggleTarget, 'tests').click()
await settle(40)
row(toggleTarget, 'tests').click()
await settle(40)
const unticked = box(toggleTarget, 'tests')
check('re-clic : case décochée', unticked !== null && !unticked.selected && unticked.background === 'rgba(0, 0, 0, 0)', JSON.stringify(unticked))
check('re-clic : envoi désactivé', submitOf(toggleTarget)?.disabled === true)

// 3. Choix unique : aucune case, réponse inchangée.
const singleTarget = document.createElement('div')
body.appendChild(singleTarget)
await mountCard(single, singleTarget)
check('choix unique : aucune case', rows(singleTarget).every(candidate => !candidate.className.includes('fb-opt')), singleTarget.innerText)
const beforeSingle = confirmed.length
row(singleTarget, 'court').click()
await settle(60)
const singleAnswer = confirmed.at(-1)
check(
  'choix unique : réponse option',
  confirmed.length > beforeSingle &&
    singleAnswer?.answers['q-single']?.type === 'option' &&
    singleAnswer?.answers['q-single']?.option_index === 0,
  JSON.stringify(singleAnswer),
)

// 4. Thème sombre : case cochée claire, coche sombre.
document.documentElement.classList.add('dark')
const darkTarget = document.createElement('div')
body.appendChild(darkTarget)
await mountCard(multi(['tests', 'documentation']), darkTarget)
row(darkTarget, 'tests').click()
await settle(40)
const darkBox = box(darkTarget, 'tests')
check('sombre : fond clair', darkBox !== null && darkBox.background === 'rgb(243, 244, 246)', JSON.stringify(darkBox))
check('sombre : coche sombre', darkBox !== null && darkBox.color === 'rgb(17, 24, 39)', JSON.stringify(darkBox))

// 5. Le gestionnaire de clic ne casse pas la carte : aucune erreur page.
finish()
document.title = 'fini'
</script>
</body></html>`

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/' || url.pathname === '/check') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(page)
    return
  }
  const rel = url.pathname.replace(/^\/immutable\/chunks\//, '')
  const file = path.join(chunksDir, rel)
  if (!file.startsWith(chunksDir) || !fs.existsSync(file)) {
    response.writeHead(404).end('introuvable')
    return
  }
  response.writeHead(200, { 'content-type': 'text/javascript' })
  response.end(fs.readFileSync(file))
})

/** Chrome : variable d'environnement, puis emplacements connus, puis PATH. */
function chromeBin() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  return 'chrome'
}

await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve))

let dom = ''
try {
  // Asynchrone : le serveur ci-dessus tourne dans CE processus, un `spawnSync`
  // bloquerait la boucle d'événements et Chrome attendrait une réponse qui ne
  // peut pas venir.
  const { stdout } = await run(
    chromeBin(),
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--virtual-time-budget=20000',
      '--dump-dom',
      `http://127.0.0.1:${String(PORT)}/check`,
    ],
    { encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
  )
  dom = stdout
} catch (error) {
  server.close()
  fail(`Chrome n'a pas répondu (${error instanceof Error ? error.message : String(error)})`)
}
server.close()

const raw = /<pre id="check">([\s\S]*?)<\/pre>/.exec(dom)
if (raw === null) fail('la page de contrôle n’a rien rendu (Chrome a-t-il bloqué le script ?)')

let results
try {
  results = JSON.parse(raw[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
} catch (error) {
  fail(`résultats illisibles : ${error instanceof Error ? error.message : String(error)} — ${raw[1].slice(0, 200)}`)
}
if (!Array.isArray(results) || results.length === 0) fail('aucune vérification rendue')

let failed = 0
for (const entry of results) {
  if (entry.ok) {
    console.log(`  ok    ${entry.name}`)
  } else {
    failed += 1
    console.log(`  ÉCHEC ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`)
  }
}
console.log(`\n${String(results.length - failed)}/${String(results.length)} vérifications de la carte OK`)
process.exit(failed === 0 ? 0 : 1)
