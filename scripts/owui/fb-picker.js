/**
 * Dossier du projet, ouvert depuis le NOM affiché au-dessus de la saisie.
 *
 * Aucun bouton en plus : ce nom devient le point d'entrée. Un clic dessus
 * ouvre l'explorateur de dossiers servi par le pont (`GET /api/projects`, sous
 * `projectsRoot` uniquement), puis `POST /api/bind` modifie le dossier du chat
 * courant — ou `POST /api/bind/pending` quand la conversation n'a pas encore
 * d'id (page d'accueil), le premier message le consomme alors.
 *
 * Mesuré dans le paquet OWUI installé : ce nom est le modèle courant sur une
 * conversation vide, et le modèle de la dernière réponse dès qu'il y a des
 * messages. Le titre de la conversation, lui, vit dans la barre du haut.
 */
;(function () {
  if (window.__fbPickerInstalled === true) return
  window.__fbPickerInstalled = true

  var script = document.currentScript
  var BRIDGE = (script && script.dataset && script.dataset.bridge) || 'http://127.0.0.1:7799'
  var LAST_KEY = 'fbp:last'
  var CHAT_RE = /^\/c\/([0-9a-fA-F-]{36})(?:\/|$)/
  var TITLE_ATTR = 'data-fbp-title'

  function el(tag, attrs, children) {
    var node = document.createElement(tag)
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key]
        if (value === null || value === undefined) return
        if (key === 'style') node.setAttribute('style', value)
        else if (key.indexOf('on') === 0) node.addEventListener(key.slice(2), value)
        else node.setAttribute(key, value)
      })
    }
    ;(children || []).forEach(function (child) {
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
    })
    return node
  }

  function jsonFetch(url, options) {
    return fetch(url, options).then(function (response) {
      return response
        .json()
        .catch(function () {
          return {}
        })
        .then(function (body) {
          if (!response.ok) {
            var message = (body && body.error && body.error.message) || (body && body.detail) || response.status
            throw new Error(String(message))
          }
          return body
        })
    })
  }

  // Les couleurs, rayons et tailles viennent des classes utilitaires déjà
  // compilées dans OWUI : le thème clair/sombre de l'application s'applique
  // sans avoir à le deviner. Seul le placement (calque, z-index, curseur) est
  // à nous, faute de classes fiables pour ça.
  var CARD = 'flex w-full flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white text-gray-900 shadow-xl dark:border-gray-800 dark:bg-gray-900 dark:text-gray-100'
  var ROW = 'block w-full rounded-lg px-2.5 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-850'
  var PRIMARY = 'rounded-lg bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-800 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100'
  var SECONDARY = 'rounded-lg border border-gray-200 bg-white px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-850 dark:text-gray-200 dark:hover:bg-gray-800'
  var STATUS = 'px-4 pb-2 text-xs text-gray-500 dark:text-gray-400'
  var TOAST = 'flex items-center gap-2 rounded-lg border border-gray-100 bg-white px-4 py-2.5 text-sm text-gray-700 shadow-lg dark:border-gray-800 dark:bg-gray-900 dark:text-gray-200'
  var MONO = 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace'

  var style = el('style', null, [
    [
      '[data-fbp-title]{cursor:pointer}',
      '.fbp-back{position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;',
      'justify-content:center;padding:16px;background:rgba(0,0,0,.45)}',
      // Le toast ne prend aucun clic : il flotte au-dessus de la saisie.
      '.fbp-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);',
      'z-index:2147483002;max-width:min(92vw,32rem);pointer-events:none}',
    ].join(''),
  ])

  var overlay = null
  var currentPath = ''
  var busy = false

  function chatId() {
    var match = CHAT_RE.exec(location.pathname)
    return match ? match[1] : null
  }

  function setStatus(message, isError) {
    var node = overlay && overlay.querySelector('.fbp-status')
    if (!node) return
    node.textContent = message || ''
    node.className = STATUS + (isError ? ' text-red-500 dark:text-red-400' : '')
  }

  /** Confirmation brève, à la manière des toasts d'OWUI. */
  function toast(message) {
    var node = el('div', { class: 'fbp-toast ' + TOAST, role: 'status' }, [message])
    document.body.appendChild(node)
    setTimeout(function () {
      node.remove()
    }, 3500)
  }

  function close() {
    if (overlay) overlay.remove()
    overlay = null
    busy = false
  }

  function remember(path) {
    try {
      localStorage.setItem(LAST_KEY, path)
    } catch {
      // Stockage plein ou désactivé : le chemin reste en mémoire de page.
    }
  }

  function lastPath() {
    try {
      return localStorage.getItem(LAST_KEY) || ''
    } catch {
      return ''
    }
  }

  function untag() {
    Array.prototype.forEach.call(document.querySelectorAll('[' + TITLE_ATTR + ']'), function (node) {
      node.removeAttribute(TITLE_ATTR)
    })
  }

  /**
   * Le nom affiché au-dessus de la zone de saisie, mesuré dans OWUI :
   * - conversation vide : le nom du modèle courant (Placeholder.svelte) ;
   * - conversation avec messages : le modèle de la dernière réponse
   *   (`#response-message-model-name`, id répété par message).
   * On prend celui dont le bas est le plus proche de la saisie.
   */
  function markTitle() {
    var composer = document.getElementById('chat-input')
    untag()
    if (!composer) return
    var box = composer.getBoundingClientRect()
    if (box.width === 0) return

    var best = null
    var nodes = document.querySelectorAll('#response-message-model-name, div.text-2xl span.line-clamp-1')
    Array.prototype.forEach.call(nodes, function (node) {
      if (node.closest('.fbp-back')) return
      var rect = node.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      if (rect.bottom > box.top + 2) return
      if (best === null || rect.bottom > best.bottom) best = { node: node, bottom: rect.bottom }
    })

    if (best !== null) best.node.setAttribute(TITLE_ATTR, '')
  }

  var markTimer = null
  function scheduleMark() {
    if (markTimer !== null) return
    markTimer = setTimeout(function () {
      markTimer = null
      markTitle()
    }, 250)
  }

  function open() {
    close()
    var list = el('div', { class: 'flex-1 overflow-auto px-2 py-2' })
    var pathInput = el('input', {
      class:
        'mb-1 w-full rounded-lg border border-gray-200 bg-transparent px-3 py-2 text-sm outline-none dark:border-gray-700',
      style: MONO,
      placeholder: 'D:/code/mon-projet',
    })
    var current = el('div', { class: 'px-4 pt-3 text-xs text-gray-500 dark:text-gray-400', style: MONO })
    var id = chatId()

    var card = el(
      'div',
      {
        class: CARD,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': 'Dossier du projet',
        style: 'max-width:34rem;max-height:min(80vh,40rem)',
      },
      [
        el('div', { class: 'flex items-center justify-between gap-3 border-b border-gray-100 px-4 py-3 dark:border-gray-800' }, [
          el('div', { class: 'text-base font-semibold' }, ['Dossier du projet']),
          el(
            'button',
            {
              class: 'rounded-lg p-1 text-lg leading-none text-gray-500 hover:text-gray-900 dark:hover:text-white',
              title: 'Fermer',
              'aria-label': 'Fermer',
              onclick: close,
            },
            ['×'],
          ),
        ]),
        current,
        list,
        el('div', { class: 'fbp-status ' + STATUS + ' mt-1' }),
        el('div', { class: 'flex flex-wrap justify-end gap-2 border-t border-gray-100 px-4 py-3 dark:border-gray-800' }, [
          el('button', { class: SECONDARY, onclick: close }, ['Annuler']),
          el(
            'button',
            {
              class: PRIMARY,
              onclick: function () {
                choose(currentPath)
              },
            },
            ['Utiliser ce dossier'],
          ),
        ]),
      ],
    )

    overlay = el('div', { class: 'fbp-back' }, [card])
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay) close()
    })
    overlay.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') close()
    })
    document.body.appendChild(overlay)
    pathInput.focus()

    if (id === null) {
      // Page d'accueil : OpenWebUI ne crée l'id du chat qu'au premier message.
      // Le dossier est donc retenu et s'appliquera à ce premier message.
      current.textContent = 'Nouvelle conversation : le dossier choisi sera utilisé dès son premier message.'
      openPath(lastPath())
      return
    }

    jsonFetch(BRIDGE + '/api/bind?chatId=' + encodeURIComponent(id))
      .then(function (binding) {
        current.textContent = 'Dossier actuel : ' + binding.projectPath
        openPath(binding.projectPath)
      })
      .catch(function () {
        current.textContent = 'Ce chat n’est lié à aucun projet.'
        openPath(lastPath())
      })

    function render(browse) {
      currentPath = browse.path
      pathInput.value = browse.path
      list.textContent = ''
      list.appendChild(pathInput)
      list.appendChild(
        el('button', { class: ROW, onclick: function () { openPath(pathInput.value) } }, [
          '↳ Aller à ce chemin',
        ]),
      )
      if (browse.parent) {
        list.appendChild(
          el('button', { class: ROW, onclick: function () { openPath(browse.parent) } }, ['↰ …']),
        )
      }
      browse.dirs.forEach(function (dir) {
        list.appendChild(el('button', { class: ROW, onclick: function () { openPath(dir.path) } }, ['📁 ' + dir.name]))
      })
      if (browse.dirs.length === 0) {
        list.appendChild(el('div', { class: 'px-2.5 py-2 text-sm text-gray-500 dark:text-gray-400' }, ['(aucun sous-dossier)']))
      }
    }

    function openPath(target) {
      if (busy) return
      setStatus('Lecture des dossiers…')
      jsonFetch(BRIDGE + '/api/projects?path=' + encodeURIComponent(target || ''))
        .then(function (browse) {
          setStatus('')
          render(browse)
        })
        .catch(function (error) {
          setStatus(String(error.message), true)
        })
    }
  }

  function choose(projectPath) {
    var id = chatId()
    if (busy || !projectPath) return
    busy = true
    remember(projectPath)
    var pending = id === null
    setStatus(pending ? 'Enregistrement du dossier…' : 'Mise à jour du dossier…')
    jsonFetch(BRIDGE + (pending ? '/api/bind/pending' : '/api/bind'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(pending ? { projectPath: projectPath } : { chatId: id, projectPath: projectPath }),
    })
      .then(function (binding) {
        // Le choix est enregistré : on ferme tout de suite et on confirme
        // discrètement, au lieu de laisser la fenêtre ouverte sur un statut.
        busy = false
        close()
        toast(
          pending
            ? 'Dossier retenu : ' + binding.projectPath + ' — envoie ton premier message.'
            : 'Dossier du projet : ' + binding.projectPath,
        )
      })
      .catch(function (error) {
        busy = false
        setStatus(String(error.message), true)
      })
  }

  function onClick(event) {
    if (!(event.target instanceof Element)) return
    var hit = event.target.closest('[' + TITLE_ATTR + ']')
    if (hit === null) return
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    open()
  }

  document.addEventListener('click', onClick, true)

  // Le style est en place dès le départ : le titre doit montrer qu'il est
  // cliquable avant la première ouverture.
  ;(document.body || document.documentElement).appendChild(style)

  // Le titre apparaît après le chargement du chat et la SPA ne recharge pas la
  // page entre deux chats : on le retrouve à chaque rendu.
  var observer = new MutationObserver(function () {
    scheduleMark()
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  setInterval(scheduleMark, 2_000)
  scheduleMark()
})()
