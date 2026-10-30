import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * La feuille de bulles est une DONNÉE (du CSS dans un script) et non du code
 * exécuté : ces tests tiennent son contrat de forme, celui qui a été demandé —
 * un interrupteur, aucune couleur, des bulles séparées plutôt qu'une grande
 * boîte. Le rendu lui-même est vérifié dans le vrai OWUI (styles calculés +
 * captures, `spike/s15/`).
 */
const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'owui',
  'fb-bubbles.js',
)
const SOURCE = readFileSync(SCRIPT, 'utf8')

/** Le CSS embedé dans le script, commentaires retirés. */
function stylesheet(): string {
  const css = /var CSS = `([\s\S]*?)`/.exec(SOURCE)?.[1]
  assert.ok(css !== undefined, 'la feuille CSS est introuvable dans le script')
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Les règles à plat : le sélecteur et son corps. */
function rules(): Array<{ selector: string; body: string }> {
  return [...stylesheet().matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({
    selector: (match[1] ?? '').trim().replace(/\s+/g, ' '),
    body: match[2] ?? '',
  }))
}

/** Le préfixe qui conditionne TOUTE la feuille : le mode bulles natif d'OWUI. */
const GATE = ':has(.chat-user .justify-end > .rounded-3xl)'

test('la feuille se désactive avec le réglage d’OWUI : aucune règle hors de la condition', () => {
  const sheet = rules()

  assert.ok(sheet.length >= 4, `règles trouvées : ${sheet.length}`)
  for (const rule of sheet) {
    assert.ok(
      rule.selector.startsWith(`html${GATE}`) || rule.selector.startsWith(`html.dark${GATE}`),
      `règle hors de l'interrupteur (elle s'appliquerait bulles coupées) : ${rule.selector}`,
    )
  }
})

test('aucune couleur : les nuances viennent du gris, jamais d’un accent', () => {
  const css = stylesheet()

  for (const forbidden of ['--color-blue', '--color-red', '--color-green', '--color-amber', '--color-violet', '--color-indigo']) {
    assert.ok(!css.includes(forbidden), `couleur d'accent réintroduite : ${forbidden}`)
  }
})

test('mes messages et ceux du modèle se distinguent, dans chaque thème', () => {
  const sheet = rules()

  for (const gate of [GATE, `.dark${GATE}`]) {
    const block = sheet.find(rule => rule.selector === `html${gate}`)
    assert.ok(block !== undefined, `bloc des variables introuvable pour ${gate}`)

    const user = /--fb-user-bg:\s*([^;]+);/.exec(block.body)?.[1]?.trim()
    const model = /--fb-model:\s*([^;]+);/.exec(block.body)?.[1]?.trim()
    assert.ok(user !== undefined && model !== undefined, `les deux tons doivent être déclarés (${gate})`)
    assert.notEqual(user, model, `les deux camps doivent se distinguer (${gate})`)
  }
})

test('le texte de mes bulles reste lisible : le ton du fond est inversé', () => {
  const sheet = rules()
  const prose = sheet.find(
    rule => rule.selector.includes('.chat-user') && rule.body.includes('color: var(--fb-user-fg)'),
  )

  assert.ok(prose !== undefined, 'le markdown garde sa couleur d’origine : texte noir sur bulle noire')
  const gate = sheet.find(rule => rule.selector === `html${GATE}`)
  assert.match(gate?.body ?? '', /--fb-user-fg:/, 'le ton du texte doit être déclaré avec le fond')
})

test('un groupe de texte fait une bulle, pas une par paragraphe ni une pour le tour', () => {
  const sheet = rules()

  const wrapper = sheet.find(rule => rule.selector.includes('.flex.flex-col.relative'))
  assert.equal(wrapper, undefined, 'le tour entier est encore emballé dans une seule bulle')

  // La bulle se colle à son contenu au lieu de remplir la colonne.
  const prose = sheet.find(rule => rule.selector.endsWith('.chat-assistant .markdown-prose'))
  assert.ok(prose !== undefined, 'la largeur du message n’est pas posée sur son contenu')
  assert.match(prose.body, /width:\s*fit-content/)

  // Un groupe se referme sur une puce d'outil : c'est ce qui borne la bulle.
  const opener = sheet.find(rule => rule.body.includes('border-start-start-radius'))
  const closer = sheet.find(rule => rule.body.includes('border-end-start-radius'))
  assert.ok(opener !== undefined, 'rien ne pose les coins hauts de la capsule')
  assert.ok(closer !== undefined, 'rien ne pose les coins bas de la capsule')
  assert.match(opener.selector, /div\.w-full\.space-y-2 \+ \*/, 'la capsule ne se rouvre pas après une puce')
  assert.match(closer.selector, /:has\(\+ div\.w-full\.space-y-2\)/, 'la capsule ne se referme pas avant une puce')
})

test('une bulle par bloc d’appel d’outil', () => {
  const sheet = rules()

  const tool = sheet.find(rule => rule.selector.endsWith(':has(> button[aria-expanded])'))
  assert.ok(tool !== undefined, 'les blocs d’appels d’outil ne reçoivent pas de bulle')
  assert.match(tool.body, /border-radius:/)
  assert.match(tool.selector, /\.chat-assistant \.markdown-prose/)
})

test('le script des bulles est du JavaScript exécutable', () => {
  // Un backtick de trop dans un commentaire du template a déjà rendu la feuille
  // muette sans erreur visible (deux fois) : la syntaxe est vérifiée ici.
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', SCRIPT], { stdio: 'pipe' }))
})
