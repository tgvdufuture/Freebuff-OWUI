#!/usr/bin/env python3
"""Rend les cases à cocher d'OpenWebUI utilisables pour `ask_user`.

OpenWebUI 0.12.x ne connaît qu'UN choix par question : son backend
(`utils/ask_user.py`) reconstruit chaque question sans `multi_select`, et son
frontend compilé (`AskUserCard.svelte`) n'émet que `{type: 'option'}`.

Ce script applique deux modifications locales, idempotentes :

1. **Backend** : `normalize_ask_user_request` conserve `multi_select: true` et
   accepte jusqu'à 10 options pour ces questions (le plafond de 3 reste pour
   les questions à choix unique). Sans ça, le champ est supprimé avant
   d'atteindre la carte, et une question à 4 cases est refusée.
2. **Frontend compilé** : une question `multi_select` coche/décoche plusieurs
   options et renvoie `{type: 'options', option_indices, labels}`. Le champ
   libre est fermé par le pont (`allow_other: false`) pour ne pas écraser la
   sélection.

Les fichiers modifiés sont sauvegardés en `.orig` au premier passage. Une mise
à jour d'OpenWebUI remplace le paquet : relancer ce script (ou `start-owui.sh`,
qui l'appelle) après chaque mise à jour. `--check` ne modifie rien et sort en
erreur si le patch manque ; `--revert` restaure les `.orig`.

Le frontend est un chunk minifié : les remplacements sont des chaînes exactes,
vérifiées une par une. Si OpenWebUI change ce code, le script le dit au lieu de
patcher à moitié.
"""
from __future__ import annotations

import argparse
import glob
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# --- Backend ---------------------------------------------------------------

BACKEND_OLD = """                'options': normalized_options,
                'allow_other': bool(question.get('allow_other', allow_other)),
"""
BACKEND_NEW = """                'options': normalized_options,
                'multi_select': bool(question.get('multi_select', False)),
                'allow_other': bool(question.get('allow_other', allow_other)),
"""
BACKEND_MARK = "'multi_select': bool(question.get('multi_select', False))"
# Plafond de cases à cocher : le pont (`MAX_CHECKBOX_OPTIONS`) envoie tout dans
# une seule carte, donc le normaliseur doit accepter plus de trois options.
CAP_OLD = """        options = question.get('options')
        if not isinstance(options, list) or not 2 <= len(options) <= 3:
            raise ValueError('Each question requires 2-3 options.')
"""
CAP_NEW = """        options = question.get('options')
        multi_select = bool(question.get('multi_select', False))
        max_options = 10 if multi_select else 3
        if not isinstance(options, list) or not 2 <= len(options) <= max_options:
            raise ValueError(f'Each question requires 2-{max_options} options.')
"""
CAP_MARK = 'max_options = 10 if multi_select else 3'

# --- Frontend --------------------------------------------------------------

# Repère du composant, stable avant ET après patch : le gabarit de la carte.
# Deux occurrences suffiraient à patcher le mauvais chunk.
CHUNK_MARK = 'my-1 rounded-2xl bg-gray-50/70 px-3.5 py-3'
FRONTEND_PATCHED = 'const c0=r(S)[H.id],ui=c0&&c0.type==="options"'
# Marqueur de la version courante : sans cette dépendance, cocher une case
# modifie l'état sans repeindre la ligne (mesuré en S11).
FRONTEND_PATCHED_V2 = '()=>(r(S),L(r(a),ye))'
# Marqueur de la version stylée (S12) : la case est dessinée par la feuille
# ajoutée au document, plus par un caractère ☐/☑ (rendu violet en emoji).
CSS_MARK = 'fb-askuser-css'
CLICK_MARK = 'Ie.classList.toggle("fb-on")'

# OWUI n'a pas de case à cocher : on en dessine une dans SA palette (gris
# 900 en clair, gris 100 en sombre), pas un caractère ☑ qui s'affiche en emoji
# coloré sous Windows.
CSS = """
.fb-opt>span:first-child::before{content:"";display:inline-flex;align-items:center;justify-content:center;width:.8125rem;height:.8125rem;margin-right:.5rem;border-radius:.25rem;border:1px solid rgb(209 213 219);vertical-align:-1px;font-size:.5625rem;line-height:1}
.dark .fb-opt>span:first-child::before{border-color:rgb(75 85 99)}
.fb-opt.fb-on>span:first-child::before{content:"\\2713";background:rgb(17 24 39);border-color:rgb(17 24 39);color:#fff}
.dark .fb-opt.fb-on>span:first-child::before{background:rgb(243 244 246);border-color:rgb(243 244 246);color:rgb(17 24 39)}
""".strip()

REPLACEMENTS: list[tuple[str, str, str]] = [
    (
        'hasAnswers accepte les cases cochées',
        'return(K==null?void 0:K.type)==="option"||(K==null?void 0:K.type)==="other"&&K.text.trim()!==""',
        'return(K==null?void 0:K.type)==="option"||(K==null?void 0:K.type)==="other"&&K.text.trim()!==""'
        '||(K==null?void 0:K.type)==="options"&&Array.isArray(K.labels)&&K.labels.length>0',
    ),
    (
        'submit transmet les cases cochées',
        '(ee==null?void 0:ee.type)==="option"?R[K.id]=ee:(ee==null?void 0:ee.type)==="other"&&(R[K.id]={type:"other",text:ee.text.trim()})',
        '(ee==null?void 0:ee.type)==="option"?R[K.id]=ee:(ee==null?void 0:ee.type)==="options"'
        '?(Array.isArray(ee.labels)&&ee.labels.length>0&&(R[K.id]={type:"options",option_indices:ee.option_indices,labels:ee.labels}))'
        ':(ee==null?void 0:ee.type)==="other"&&(R[K.id]={type:"other",text:ee.text.trim()})',
    ),
    (
        'selectOption coche/décoche au lieu de remplacer',
        'le=(H,R,K)=>{const ee={...r(S),[H.id]:{type:"option",option_index:K,label:R.label,description:R.description}};l(S,ee),j(ee)}',
        'le=(H,R,K)=>{if(H.multi_select){const c0=r(S)[H.id],'
        'ui=c0&&c0.type==="options"?[...c0.option_indices]:[],'
        'ul=c0&&c0.type==="options"?[...c0.labels]:[],'
        'at=ui.indexOf(K);'
        'at===-1?(ui.push(K),ul.push(R.label)):(ui.splice(at,1),ul.splice(at,1));'
        'l(S,{...r(S),[H.id]:{type:"options",option_indices:ui,labels:ul}});return}'
        'const ee={...r(S),[H.id]:{type:"option",option_index:K,label:R.label,description:R.description}};l(S,ee),j(ee)}',
    ),
    (
        'isSelectedOption lit les cases cochées',
        'L=(H,R)=>{const K=r(S)[H.id];return(K==null?void 0:K.type)==="option"&&K.option_index===R}',
        'L=(H,R)=>{const K=r(S)[H.id];'
        'return(K==null?void 0:K.type)==="option"&&K.option_index===R'
        '||(K==null?void 0:K.type)==="options"&&Array.isArray(K.option_indices)&&K.option_indices.includes(R)}',
    ),
    (
        # La classe est ajoutée dans le gabarit de la ligne : une expression y
        # est permise, donc aucun remplacement de parenthèses à équilibrer.
        'la ligne porte la case',
        '`group flex w-full min-w-0 items-baseline gap-2 rounded-lg py-1.5 text-left transition-colors ${ot??""}`',
        '`${r(a)&&r(a).multi_select?"fb-opt ":""}group flex w-full min-w-0 items-baseline gap-2 rounded-lg py-1.5 text-left transition-colors ${ot??""}`',
    ),
    (
        # Le composant ne repeint jamais une ligne (mesuré en S11) : cocher
        # l'état ne changeait rien à l'écran. La case se coche donc sur le nœud
        # lui-même, et l'état part quand même par le chemin normal.
        'le clic coche la case',
        'ge("click",Ie,()=>le(r(a),r(Ke),ye))',
        'ge("click",Ie,()=>{r(a)&&r(a).multi_select&&Ie.classList.toggle("fb-on");'
        'le(r(a),r(Ke),ye)})',
    ),
]


def package_dir(venv: Path) -> Path:
    for pattern in ('Lib/site-packages/open_webui', 'lib/python*/site-packages/open_webui'):
        found = glob.glob(str(venv / pattern))
        if found:
            return Path(found[0])
    raise SystemExit(f'paquet open_webui introuvable sous {venv}')


def frontend_chunk(pkg: Path) -> Path:
    for path in sorted((pkg / 'frontend/_app/immutable/chunks').glob('*.js')):
        # `__harness.js` est une copie de travail des spikes : jamais la cible.
        if path.name.startswith('__'):
            continue
        if path.read_text(encoding='utf-8', errors='ignore').count(CHUNK_MARK) == 1:
            return path
    raise SystemExit('chunk du composant AskUserCard introuvable (OpenWebUI a changé)')


def backup(path: Path) -> None:
    original = path.with_suffix(path.suffix + '.orig')
    if not original.exists():
        shutil.copy2(path, original)


def patch_backend(pkg: Path, check: bool) -> bool:
    path = pkg / 'utils/ask_user.py'
    text = path.read_text(encoding='utf-8')
    edits = [
        (BACKEND_MARK, BACKEND_OLD, BACKEND_NEW, 'multi_select conservé'),
        (CAP_MARK, CAP_OLD, CAP_NEW, 'plafond de 10 cases levé'),
    ]

    missing = [(mark, old, new, name) for mark, old, new, name in edits if mark not in text]
    if not missing:
        print('backend  : déjà patché')
        return True
    if check:
        for _, _, _, name in missing:
            print(f'backend  : patch manquant ({name})')
        return False

    broken = [name for _, old, _, name in missing if text.count(old) != 1]
    if broken:
        print(f"backend  : ancres introuvables ({', '.join(broken)}), RIEN appliqué", file=sys.stderr)
        return False

    backup(path)
    for _, old, new, name in missing:
        text = text.replace(old, new)
        print(f'backend  : {name}')
    path.write_text(text, encoding='utf-8')
    return True


def patch_frontend(pkg: Path, check: bool) -> bool:
    path = frontend_chunk(pkg)
    text = path.read_text(encoding='utf-8')
    if CSS_MARK in text and CLICK_MARK in text:
        print(f'frontend : déjà patché ({path.name})')
        return True
    if FRONTEND_PATCHED in text or FRONTEND_PATCHED_V2 in text:
        # Version précédente (case en caractère ☐/☑, rendue en emoji violet) ou
        # sans repeint : on repart de la sauvegarde plutôt que d'enchaîner des
        # remplacements sur une base déjà modifiée.
        original = path.with_suffix(path.suffix + '.orig')
        if check:
            print(f'frontend : patch à mettre à jour ({path.name})')
            return False
        if not original.exists():
            print(f'frontend : {original.name} manquant, revert impossible', file=sys.stderr)
            return False
        shutil.copy2(original, path)
        text = path.read_text(encoding='utf-8')
        print(f'frontend : {original.name} restauré avant repatch')
    if check:
        print(f'frontend : patch manquant ({path.name})')
        return False

    missing = [name for name, old, _ in REPLACEMENTS if text.count(old) != 1]
    if missing:
        print(f'frontend : ancres introuvables ({", ".join(missing)}), RIEN appliqué', file=sys.stderr)
        return False

    backup(path)
    for name, old, new in REPLACEMENTS:
        text = text.replace(old, new)
        print(f'frontend : {name}')
    if CSS_MARK not in text:
        text += (
            '\n;(()=>{if(document.getElementById("' + CSS_MARK + '"))return;'
            'const e=document.createElement("style");e.id="' + CSS_MARK + '";'
            'e.textContent=' + json.dumps(CSS) + ';document.head.appendChild(e)})()\n'
        )
        print('frontend : palette de la case (noir OWUI)')
    path.write_text(text, encoding='utf-8')
    print(f'frontend : cases à cocher dans {path.name}')
    return True


def revert(venv: Path) -> None:
    pkg = package_dir(venv)
    restored = 0
    for path in [pkg / 'utils/ask_user.py', *sorted((pkg / 'frontend/_app/immutable/chunks').glob('*.js.orig'))]:
        original = path.with_suffix(path.suffix + '.orig') if path.suffix == '.py' else path
        target = Path(str(original)[: -len('.orig')])
        if original.exists():
            shutil.copy2(original, target)
            original.unlink()
            restored += 1
            print(f'restauré : {target.name}')
    if restored == 0:
        print('aucune sauvegarde .orig à restaurer')


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--venv', default=str(ROOT / '.venv-owui'), help='environnement Python d’OpenWebUI')
    parser.add_argument('--check', action='store_true', help='ne rien modifier, sortir en erreur si le patch manque')
    parser.add_argument('--revert', action='store_true', help='restaurer les fichiers .orig')
    args = parser.parse_args()

    venv = Path(args.venv)
    pkg = package_dir(venv)
    if args.revert:
        revert(venv)
        return 0

    ok = patch_backend(pkg, args.check)
    ok = patch_frontend(pkg, args.check) and ok
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(main())
