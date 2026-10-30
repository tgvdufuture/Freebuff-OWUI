/**
 * Quota Freebuff dans OpenWebUI, à deux endroits.
 *
 * - **Au-dessus du profil**, en bas de la barre latérale : le quota du compte,
 *   tel que la CLI l'écrit dans son bandeau (`1/12 hours remaining`) →
 *   `01h00 / 12h00`.
 * - **Au-dessus de la zone de saisie** : l'HEURE de quota en cours, lue dans le
 *   pied de la TUI (`59m left`). C'est la seule durée qui s'épuise pendant
 *   qu'on travaille ; entre deux lectures elle baisse avec l'horloge, puisque
 *   c'est un décompte.
 *
 * Attention, une heure n'est pas une CLI : mesuré le 23/10, une CLI relancée
 * reprend l'heure d'une CLI précédente (`[freebuff-session] resuming the hour a
 * previous CLI left behind` dans son journal). Une « nouvelle session » peut
 * donc afficher 8 min : c'est le reste de l'heure partagée, pas un bug. Quand
 * l'heure est écoulée, la CLI reste ouverte et le message suivant en ouvre une
 * autre — la barre le dit, au lieu d'annoncer une session morte qui tourne.
 *
 * Rien n'est estimé ni inventé : tout vient de `GET /api/quota?chatId=…`, qui
 * lit l'écran de la session du projet lié à ce chat. Sans session ouverte, la
 * barre de la saisie le dit au lieu d'afficher un chiffre.
 */
;(function () {
  if (window.__fbQuotaInstalled === true) return
  window.__fbQuotaInstalled = true

  var script = document.currentScript
  var BRIDGE = (script && script.dataset && script.dataset.bridge) || 'http://127.0.0.1:7799'
  var CHAT_RE = /^\/c\/([0-9a-fA-F-]{36})(?:\/|$)/
  /** La CLI n'écrit son décompte qu'à certains moments : on relit sans forcer. */
  var POLL_MS = 20_000
  /** Rythme d'affichage : la barre avance entre deux lectures. */
  var TICK_MS = 2_000
  /** Sous ce seuil, la session est presque finie : le remplissage passe en alerte. */
  var LOW_MINUTES = 10

  var BAR = 'fbq flex items-center gap-2 px-1 text-xs text-gray-500 dark:text-gray-400'
  var TRACK = 'fbq-track relative h-1 flex-1 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800'
  var FILL = 'fbq-fill absolute inset-y-0 left-0 rounded-full'
  var HOURS = 'fbq-hours flex items-center justify-between gap-2 px-2 py-1 text-xs text-gray-500 dark:text-gray-400'
  var CALM = 'bg-gray-400 dark:bg-gray-600'
  var LOW = 'bg-amber-500'
  var EMPTY = 'bg-red-500'

  function el(tag, attrs, children) {
    var node = document.createElement(tag)
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key]
        if (value === null || value === undefined) return
        if (key === 'style') node.setAttribute('style', value)
        else node.setAttribute(key, value)
      })
    }
    ;(children || []).forEach(function (child) {
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
    })
    return node
  }

  function chatId() {
    var match = CHAT_RE.exec(location.pathname)
    return match ? match[1] : null
  }

  function clock(at) {
    var date = new Date(at)
    return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
  }

  /** `1` → `01h00` : la CLI ne donne que des heures pleines, jamais de minutes. */
  function hours(value) {
    return String(value).padStart(2, '0') + 'h00'
  }

  // --- Session, au-dessus de la saisie ------------------------------------

  // La transition est écrite en style : les classes arbitraires de Tailwind ne
  // sont pas compilées dans le bundle d'OWUI, seule la liste de base l'est.
  var fill = el('div', { class: FILL + ' ' + CALM, style: 'width:0%;transition:width .7s linear' })
  var track = el(
    'div',
    {
      class: TRACK,
      role: 'progressbar',
      'aria-label': 'Temps restant de l’heure Freebuff',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
    },
    [fill],
  )
  var sessionLabel = el('span', { class: 'fbq-text tabular-nums whitespace-nowrap' })
  var bar = el('div', { class: BAR, style: 'display:none' }, [track, sessionLabel])

  // --- Quota, au-dessus du profil -----------------------------------------

  var hoursValue = el('span', { class: 'fbq-hours-value tabular-nums whitespace-nowrap' })
  var hoursLine = el('div', { class: HOURS, style: 'display:none' }, [
    el('span', { class: 'whitespace-nowrap' }, ['Freebuff']),
    hoursValue,
  ])

  // --- Bascule de profil, sous le quota -----------------------------------

  // Le profil est un COMPTE Freebuff : une CLI ne change pas de compte à
  // chaud, donc choisir ici ferme les CLI ouvertes et les suivantes s'ouvrent
  // ailleurs. La liste et les heures viennent de la sonde du LANCEMENT
  // (`/api/profiles`) : rien n'est relancé au clic.
  var profileName = el(
    'span',
    {
      class: 'fbp-name',
      // Classes arbitraires non compilées par OWUI : la coupure est en style.
      style: 'max-width:8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
    },
    [''],
  )
  var profileButton = el(
    'button',
    {
      type: 'button',
      class:
        'fbp-btn flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800',
      title: 'Changer de profil Freebuff (ferme les CLI ouvertes)',
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
    },
    [profileName, el('span', { 'aria-hidden': 'true' }, ['▾'])],
  )
  var profileLine = el('div', { class: HOURS, style: 'display:none' }, [
    el('span', { class: 'whitespace-nowrap' }, ['Compte']),
    profileButton,
  ])

  /** Dernière liste connue du pont ; `null` tant qu'elle n'a pas été lue. */
  var profiles = null
  var popover = null
  var profilesAt = 0
  var profilesLoading = false
  /** Un clic pendant la lecture d'ouverture : on ouvrira dès la réponse. */
  var pendingOpen = false

  function profileHours(profile) {
    if (typeof profile.remainingHours !== 'number') return 'heures inconnues'
    return hours(profile.remainingHours) + (typeof profile.totalHours === 'number' ? ' / ' + hours(profile.totalHours) : '')
  }

  function closeProfiles(reason) {
    // Un clic qui a demandé l'ouverture ne doit pas survivre à une fermeture.
    pendingOpen = false
    if (popover === null) return
    if (popover.parentNode !== null) popover.parentNode.removeChild(popover)
    popover = null
    profileButton.setAttribute('aria-expanded', 'false')
    if (reason === 'reload') loadProfiles(true)
  }

  /** Position au-dessus du bouton : la barre est en bas de l'écran. */
  function openProfiles() {
    if (profiles === null) {
      pendingOpen = true
      loadProfiles(true)
      return
    }
    pendingOpen = false
    var box = el('div', {
      class:
        'fbp-pop fixed z-50 w-72 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg text-xs text-gray-700 dark:text-gray-200',
      role: 'listbox',
      // Défilement si la liste dépasse : quatre profils tiennent, pas dix.
      style: 'display:none;max-height:60vh;overflow-y:auto',
    })
    if (profiles.detectedAt !== null) {
      box.appendChild(
        el('div', { class: 'px-3 py-2 text-gray-500 dark:text-gray-400' }, [
          'Détecté au lancement à ' + clock(profiles.detectedAt),
        ]),
      )
    }

    profiles.profiles.forEach(function (profile) {
      var row = el(
        'button',
        {
          type: 'button',
          class:
            'fbp-row flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800',
          role: 'option',
          'aria-selected': profile.current ? 'true' : 'false',
          'data-path': profile.path,
        },
        [
          el('span', { class: 'font-medium truncate' }, [profile.name + (profile.current ? ' ✓' : '')]),
          el('span', { class: 'text-gray-500 dark:text-gray-400 whitespace-nowrap' }, [profileHours(profile)]),
        ],
      )
      row.addEventListener('click', function () {
        switchProfile(profile, box)
      })
      box.appendChild(row)
    })
    box.appendChild(el('div', { class: 'fbp-error px-3 py-2 text-red-500', style: 'display:none' }))

    document.body.appendChild(box)
    // Ancrage sur le PIED de la barre latérale, pas sur le bouton : le bouton
    // est collé au bord de l'écran, donc s'aligner sur son bord droit faisait
    // sortir le panneau à gauche (mesuré à l'ouverture). On borne aussi à
    // l'écran, pour un rail replié ou une fenêtre étroite.
    var rect = profileButton.getBoundingClientRect()
    var anchor = footerNode !== null ? footerNode.getBoundingClientRect() : rect
    var width = box.getBoundingClientRect().width
    var left = Math.max(8, Math.min(anchor.left + 8, window.innerWidth - width - 8))
    box.style.left = left + 'px'
    box.style.bottom = window.innerHeight - rect.top + 6 + 'px'
    box.style.display = ''
    popover = box
    profileButton.setAttribute('aria-expanded', 'true')
  }

  function showProfileError(box, message) {
    var line = box.querySelector('.fbp-error')
    if (line === null) return
    line.textContent = message
    line.style.display = ''
  }

  function switchProfile(profile, box) {
    if (profile.current) {
      closeProfiles()
      return
    }
    fetch(BRIDGE + '/api/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: profile.path }),
    })
      .then(function (response) {
        return response.json().then(function (body) {
          return { ok: response.ok, body: body }
        })
      })
      .then(function (result) {
        if (!result.ok) {
          var error = result.body && result.body.error
          showProfileError(
            box,
            error && error.code === 'profile_switch_busy'
              ? 'Un tour est en cours : réessaie quand il est fini.'
              : error && error.code === 'profile_switch_stuck'
                ? error.message
                : 'Bascule refusée (' + ((error && error.code) || 'inconnu') + ').',
          )
          return
        }
        profiles = null
        profileName.textContent = result.body.profile.name
        closeProfiles('reload')
        // La lecture de quota appartenait à l'ancien compte : on la redemande.
        reading = reading === null ? null : { at: reading.at, left: null, quota: null }
        render()
        refresh(chatId() || '')
      })
      .catch(function () {
        showProfileError(box, 'Pont injoignable.')
      })
  }

  function loadProfiles(force) {
    // Le tick appelle cette lecture en boucle : une requête à la fois, et pas
    // plus d'une par `POLL_MS` tant que le pont n'a rien de neuf à dire.
    if (profilesLoading) return
    if (force !== true && Date.now() - profilesAt < POLL_MS) return
    profilesLoading = true
    profilesAt = Date.now()
    fetch(BRIDGE + '/api/profiles')
      .then(function (response) {
        if (!response.ok) throw new Error(String(response.status))
        return response.json()
      })
      .then(function (body) {
        profiles = body
        profileName.textContent = body.current
        profileLine.style.display = ''
        if (pendingOpen) openProfiles()
      })
      .catch(function () {
        profileLine.style.display = 'none'
      })
      .then(function () {
        profilesLoading = false
      })
  }

  profileButton.addEventListener('click', function (event) {
    event.stopPropagation()
    if (popover === null) openProfiles()
    else closeProfiles()
  })
  document.addEventListener('click', function (event) {
    if (popover === null) return
    if (event.target === profileButton || profileButton.contains(event.target)) return
    if (popover.contains(event.target)) return
    closeProfiles()
  })
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeProfiles()
  })
  // Le panneau est ancré en pixels : un redimensionnement le laisserait ailleurs.
  window.addEventListener('resize', function () {
    closeProfiles()
  })

  /** Dernière réponse du pont : `left` (session) et/ou `quota` (heures). */
  var reading = null
  /** `undefined` : aucun tour d'horloge encore passé (le premier lit tout de suite). */
  var lastChat
  var lastError = false

  function paint(color) {
    fill.classList.remove.apply(fill.classList, CALM.split(' ').concat(LOW.split(' '), EMPTY.split(' ')))
    fill.classList.add.apply(fill.classList, color.split(' '))
  }

  function showSession(percent, text, color, title) {
    fill.style.width = percent.toFixed(1) + '%'
    paint(color)
    sessionLabel.textContent = text
    bar.title = title
    track.setAttribute('aria-valuenow', String(Math.round(percent)))
    track.setAttribute('aria-valuetext', text)
    bar.style.display = ''
  }

  function renderSession() {
    if (bar.parentElement === null) return
    if (lastError) {
      bar.style.display = 'none'
      return
    }

    var left = reading && reading.left
    if (left && typeof left.minutes === 'number') {
      // Extrapolation : le décompte baisse avec l'horloge, pas avec les appels.
      var minutes = Math.max(0, Math.min(left.minutes, left.minutes - (Date.now() - left.at) / 60_000))
      var total = left.totalMinutes > 0 ? left.totalMinutes : minutes
      var percent = total > 0 ? (minutes / total) * 100 : 0
      var color = minutes <= 0 ? EMPTY : minutes <= LOW_MINUTES ? LOW : CALM
      if (minutes <= 0) {
        // L'heure de quota est finie, la CLI non : le prochain message en
        // ouvre une autre. Annoncer « session terminée » mentait sur la CLI.
        showSession(
          0,
          'heure écoulée',
          EMPTY,
          'Les 60 min de quota de cette heure sont consommées. La session reste ouverte : le prochain message ouvre une nouvelle heure (1 h).',
        )
        return
      }
      var text = Math.ceil(minutes) + ' min restantes'
      showSession(
        percent,
        text,
        color,
        'Heure Freebuff : ' + text + ' (lu à ' + clock(left.at) + '). Une heure est partagée : une CLI relancée la reprend où elle en était.',
      )
      return
    }

    // Aucune session : on le dit, plutôt que d'afficher une barre muette.
    showSession(0, 'aucune session en cours', CALM, 'Aucune session Freebuff ouverte : le prochain message en ouvrira une.')
  }

  function renderHours() {
    if (hoursLine.parentElement === null) return
    var quota = reading && reading.quota
    if (lastError || !quota || !quota.totalHours) {
      hoursLine.style.display = 'none'
      return
    }
    var rest = quota.remainingHours === null ? 0 : quota.remainingHours
    hoursValue.textContent = hours(rest) + ' / ' + hours(quota.totalHours)
    hoursValue.className =
      'fbq-hours-value tabular-nums whitespace-nowrap ' +
      (quota.exhausted
        ? 'text-red-500 dark:text-red-400'
        : rest <= 1
          ? 'text-amber-600 dark:text-amber-400'
          : '')
    hoursLine.title =
      'Quota Freebuff : ' +
      hours(rest) +
      ' restantes sur ' +
      hours(quota.totalHours) +
      ' (lu à ' +
      clock(quota.at) +
      ', ' +
      (quota.source === 'probe' ? 'sonde' : 'session') +
      ')'
    hoursLine.style.display = ''
  }

  // --- Attention dans l'onglet --------------------------------------------

  // Un tour fini ou une question posée pendant que l'onglet est en arrière-plan
  // doit se voir : compte dans le titre et pastille sur le favicon. Rien n'est
  // inventé, tout vient de `attention` dans la réponse du pont.
  var ATTENTION = { baseline: Date.now(), seen: {}, count: 0 }
  var badgeIcon = null

  function paintTitle() {
    var current = document.title.replace(/^\(\d+\)\s*/, '')
    if (ATTENTION.count > 0 && document.hidden) document.title = '(' + ATTENTION.count + ') ' + current
    else if (current !== document.title) document.title = current
  }

  function paintIcon() {
    if (ATTENTION.count === 0) {
      if (badgeIcon !== null && badgeIcon.parentNode !== null) badgeIcon.parentNode.removeChild(badgeIcon)
      badgeIcon = null
      return
    }
    // OWUI peut réécrire son favicon : on remet le nôtre en dernier si besoin.
    if (badgeIcon !== null && document.head.lastElementChild === badgeIcon) return

    var canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    var context = canvas.getContext('2d')
    if (context === null) return
    context.fillStyle = '#dc2626'
    context.beginPath()
    context.arc(32, 32, 30, 0, Math.PI * 2)
    context.fill()
    context.fillStyle = '#ffffff'
    context.font = 'bold 30px sans-serif'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(ATTENTION.count > 9 ? '9+' : String(ATTENTION.count), 32, 34)

    var link = document.createElement('link')
    link.rel = 'icon'
    link.type = 'image/png'
    link.href = canvas.toDataURL('image/png')
    if (badgeIcon !== null && badgeIcon.parentNode !== null) badgeIcon.parentNode.removeChild(badgeIcon)
    badgeIcon = link
    document.head.appendChild(link)
  }

  function clearAttention() {
    ATTENTION.count = 0
    paintTitle()
    paintIcon()
  }

  function noteAttention(id, attention) {
    if (!attention || typeof attention.at !== 'number') return
    if (attention.at <= ATTENTION.baseline) return
    if ((ATTENTION.seen[id] || 0) >= attention.at) return
    ATTENTION.seen[id] = attention.at
    // L'utilisateur regarde l'onglet : la réponse est sous ses yeux.
    if (!document.hidden) return
    ATTENTION.count += 1
    paintTitle()
    paintIcon()
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) clearAttention()
  })
  window.addEventListener('focus', clearAttention)

  function render() {
    renderHours()
    renderSession()
    if (ATTENTION.count > 0 || /^\(\d+\)\s/.test(document.title)) paintTitle()
    paintIcon()
  }

  /** Le pied de la saisie : `#message-input-container` dans son formulaire. */
  function mountComposer() {
    var box = chatId() === null ? null : document.getElementById('message-input-container')
    var parent = box === null ? null : box.parentElement
    if (parent === null) {
      if (bar.parentElement !== null) bar.remove()
      return
    }
    // Premier enfant du formulaire : la barre est au-dessus de la boîte, à sa
    // largeur, sans dépendre de la structure interne du composeur.
    if (bar.parentElement !== parent) parent.insertBefore(bar, parent.firstChild)
  }

  /**
   * Le pied de la barre latérale, mesuré dans OWUI : un bloc `sticky bottom-0`
   * qui porte l'avatar et le bouton de profil. On ne s'appuie ni sur son id ni
   * sur un libellé traduit : la barre existe en deux versions dans le DOM (le
   * rail replié et la colonne ouverte), et seule la colonne a ce pied.
   */
  var footerNode = null

  function findProfileFooter() {
    var nodes = document.querySelectorAll('div')
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i]
      var cls = typeof node.className === 'string' ? node.className : ''
      if (!cls.includes('sticky') || !cls.includes('bottom-0')) continue
      if (node.querySelector('img') === null) continue
      if (node.getBoundingClientRect().width < 120) continue
      return node
    }
    return null
  }

  function mountHours() {
    if (footerNode !== null && !document.contains(footerNode)) footerNode = null
    if (footerNode === null) footerNode = findProfileFooter()
    if (footerNode === null) {
      if (hoursLine.parentElement !== null) hoursLine.remove()
      if (profileLine.parentElement !== null) profileLine.remove()
      // Le pied a disparu (rail replié, autre page) : un panneau flottant
      // resterait sinon au-dessus de l'interface, sans bouton d'origine.
      closeProfiles()
      return
    }
    if (hoursLine.parentElement !== footerNode) footerNode.insertBefore(hoursLine, footerNode.firstChild)
    // Sous le quota : le compte est le même pour tout le pont, chat ou pas.
    if (profileLine.parentElement !== footerNode) footerNode.insertBefore(profileLine, hoursLine.nextSibling)
    if (profiles === null) loadProfiles()
  }

  function refresh(id) {
    fetch(BRIDGE + '/api/quota?chatId=' + encodeURIComponent(id))
      .then(function (response) {
        if (!response.ok) throw new Error(String(response.status))
        return response.json()
      })
      .then(function (body) {
        // Une réponse pour un autre chat ne doit pas écraser l'affichage courant.
        if ((chatId() || '') !== id) return
        lastError = false
        reading = body
        render()
        noteAttention(id, body.attention)
      })
      .catch(function () {
        // Pont arrêté : on ne montre pas une valeur qui n'a plus de source.
        if ((chatId() || '') !== id) return
        lastError = true
        render()
      })
  }

  setInterval(function () {
    var id = chatId() || ''
    mountComposer()
    mountHours()
    if (id !== lastChat) {
      lastChat = id
      // Le quota du compte ne dépend pas du chat : on le garde d'un chat à
      // l'autre (la prochaine lecture le rafraîchit), seul le décompte de
      // session repart de zéro.
      reading = reading === null ? null : { at: reading.at, left: null, quota: reading.quota }
      lastError = false
      render()
      refresh(id)
      return
    }
    render()
  }, TICK_MS)

  // Le quota ne dépend pas du chat ouvert : il se rafraîchit aussi sur l'accueil,
  // où OpenWebUI n'a pas encore d'identifiant de conversation.
  setInterval(function () {
    refresh(chatId() || '')
  }, POLL_MS)
})()
