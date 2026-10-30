/**
 * Bulles façon iMessage dans OpenWebUI — activables et désactivables.
 *
 * Ce qu'OpenWebUI fait seul (`chatBubble`, Réglages → Interface → « interface à
 * bulles »), mesuré dans son DOM réel (0.12.3) : une bulle arrondie alignée à
 * droite pour MES messages — `.chat-user .justify-end > .rounded-3xl`, fond
 * `bg-gray-50` / `dark:bg-gray-850`, rayon 24 px, largeur bornée à 90 % — et
 * RIEN pour le modèle. Aucun conteneur colorable côté modèle, et chaque bloc
 * « Travail » est un `div.w-full.space-y-2 > button[aria-expanded]`.
 *
 * Cette feuille ajoute ce qui manque, sans rien remplacer :
 * - **une bulle par bloc de message**, pas une grande boîte : chaque enfant
 *   direct de `.markdown-prose` (paragraphe, liste, code) devient sa propre
 *   bulle, et chaque bloc d'appels d'outil la sienne — comme des messages qui
 *   s'empilent ;
 * - **aucune couleur** : mes bulles sont le ton le plus tranché de la palette
 *   (noir sur fond clair, blanc sur fond sombre) et celles du modèle une
 *   surface à peine teintée, donc les deux camps se distinguent par la nuance ;
 * - deux jeux de nuances seulement, un par thème, dans les blocs de variables.
 *
 * L'INTERRUPTEUR est celui d'OWUI : toutes les règles sont sous
 * `html:has(.chat-user .justify-end > .rounded-3xl)`, c'est-à-dire « la bulle
 * native est là ». Mesuré : ce conteneur `justify-end` n'existe qu'avec
 * « interface à bulles » actif (sans lui, c'est `flex w-full`). Le désactiver
 * rend la mise en page plate d'origine, feuille comprise et sans redémarrage.
 */
;(function () {
  if (window.__fbBubblesInstalled === true) return
  window.__fbBubblesInstalled = true

  var STYLE_ID = 'fb-bubbles'

  var CSS = `
/* Thème clair : moi en noir, le modèle en gris très clair. */
html:has(.chat-user .justify-end > .rounded-3xl) {
  --fb-user-bg: var(--color-gray-900);
  --fb-user-fg: var(--color-gray-50);
  --fb-model: color-mix(in oklab, var(--color-gray-500) 12%, transparent);
  --fb-line: color-mix(in oklab, var(--color-gray-500) 20%, transparent);
  --fb-radius: 1.15rem;
  --fb-pad: 0.45rem 0.85rem;
}

/* Thème sombre : les mêmes nuances, inversées. OWUI marque son thème par la
   classe « dark » sur <html>, pas par une media query. */
html.dark:has(.chat-user .justify-end > .rounded-3xl) {
  --fb-user-bg: var(--color-gray-100);
  --fb-user-fg: var(--color-gray-900);
  --fb-model: color-mix(in oklab, var(--color-gray-50) 8%, transparent);
  --fb-line: color-mix(in oklab, var(--color-gray-50) 14%, transparent);
}

/* 1. Mes messages : le ton tranché, alignés à droite par OWUI. */
html:has(.chat-user .justify-end > .rounded-3xl) .chat-user .justify-end > .rounded-3xl {
  background: var(--fb-user-bg);
  color: var(--fb-user-fg);
  border: 0;
  border-radius: var(--fb-radius);
  padding: var(--fb-pad);
}

/* Le markdown d'OWUI pose SA couleur (gris foncé sur fond clair) : dans une
   bulle noire, il faut la reprendre jusqu'aux blocs, sinon le texte disparaît.
   Mesuré : sans ça, oklch(0.373) sur oklch(0.2). */
html:has(.chat-user .justify-end > .rounded-3xl) .chat-user .justify-end > .rounded-3xl .markdown-prose {
  color: var(--fb-user-fg);
}

html:has(.chat-user .justify-end > .rounded-3xl) .chat-user .justify-end > .rounded-3xl .markdown-prose :is(p, li, h1, h2, h3, h4, h5, h6, strong, em, blockquote, td, th) {
  color: inherit;
}

html:has(.chat-user .justify-end > .rounded-3xl) .chat-user .justify-end > .rounded-3xl a {
  color: inherit;
  text-decoration: underline;
}

/* Le code garde son fond, mais accordé au texte de la bulle. */
html:has(.chat-user .justify-end > .rounded-3xl) .chat-user .justify-end > .rounded-3xl :is(code, pre) {
  background: color-mix(in oklab, currentColor 16%, transparent);
  color: inherit;
  border: 0;
}

/* 2. Le modèle : UNE bulle par GROUPE DE TEXTE, pas une par paragraphe et pas
   une autour du tour entier. Un groupe, c'est une suite de blocs de texte ;
   une puce d'outil le referme. D'où des segments jointifs : les bords
   verticaux partout, les coins et l'air seulement au premier et au dernier.

   La largeur est posée sur le conteneur (fit-content) et les segments la
   remplissent : tous les groupes gardent la même largeur, donc les capsules
   restent alignées au lieu de faire des escaliers. */
html:has(.chat-user .justify-end > .rounded-3xl) .chat-assistant .markdown-prose {
  width: fit-content;
  max-width: 92%;
}

/* :where() pour que cette base ne batte pas les coins ci-dessous : la
   spécificité, sinon, écrase les capsules (mesuré : bords et marges à 0). */
html:has(.chat-user .justify-end > .rounded-3xl) .chat-assistant .markdown-prose > :where(*:not(div.w-full.space-y-2):not(hr)) {
  background: var(--fb-model);
  border: 0 solid var(--fb-line);
  border-left-width: 1px;
  border-right-width: 1px;
  border-radius: 0;
  padding: 0.08rem 0.85rem;
  width: 100%;
  margin-block: 0 !important;
}

/* Un groupe d'UN SEUL bloc se colle à son texte : la largeur commune ne sert
   qu'à souder plusieurs paragraphes en une capsule. C'est le cas courant d'un
   tour d'outils (une phrase, un appel, une phrase), et sans ça une ligne de
   dix mots occupe toute la colonne. */
html:has(.chat-user .justify-end > .rounded-3xl) .chat-assistant .markdown-prose > :where(*:not(div.w-full.space-y-2):not(hr)):is(:first-child, div.w-full.space-y-2 + *):is(:last-child, :has(+ div.w-full.space-y-2)) {
  width: fit-content;
}

/* Premier du groupe : coins hauts, trait haut, air au-dessus. */
html:has(.chat-user .justify-end > .rounded-3xl) .chat-assistant .markdown-prose > *:first-child,
html:has(.chat-user .justify-end > .rounded-3xl) .chat-assistant .markdown-prose > div.w-full.space-y-2 + * {
  border-top-width: 1px;
  border-start-start-radius: var(--fb-radius);
  border-start-end-radius: var(--fb-radius);
  padding-top: 0.3rem;
  margin-top: 0.18rem !important;
}

/* Dernier du groupe : coins bas, trait bas, air en dessous. */
html:has(.chat-user .justify-end > .rounded-3xl) .chat-assistant .markdown-prose > *:last-child,
html:has(.chat-user .justify-end > .rounded-3xl) .chat-assistant .markdown-prose > *:has(+ div.w-full.space-y-2) {
  border-bottom-width: 1px;
  border-end-start-radius: var(--fb-radius);
  border-end-end-radius: var(--fb-radius);
  padding-bottom: 0.3rem;
  margin-bottom: 0.18rem !important;
}

/* 3. Une bulle par bloc d'appels d'outil. Le bouton replié reste le seul
   contenu visible : seules sa forme et sa teinte changent. */
html:has(.chat-user .justify-end > .rounded-3xl) .chat-assistant .markdown-prose > div.w-full.space-y-2:has(> button[aria-expanded]) {
  background: var(--fb-model);
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius);
  padding: 0.05rem 0.7rem;
  margin: 0.18rem 0;
  width: fit-content;
  max-width: 92%;
}

html:has(.chat-user .justify-end > .rounded-3xl) .chat-assistant .markdown-prose > div.w-full.space-y-2 > button[aria-expanded] {
  padding: 0.3rem 0;
}

`

  function mount() {
    // Le <head> survit aux navigations internes d'OWUI : une seule pose suffit.
    if (document.getElementById(STYLE_ID) !== null) return
    var style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.appendChild(style)
  }

  mount()
})()
