#!/usr/bin/env python3
"""Injecte l'interface Freebuff (sélecteur de projet + barre de quota) dans OpenWebUI.

Le pont ne peut pas dessiner d'interface dans OpenWebUI (c'est une API OpenAI),
et un navigateur ne donne jamais un chemin absolu (`showDirectoryPicker` ne
renvoie que des noms). L'interface est donc faite de petits scripts servis par
OWUI lui-même :

1. les fichiers de `scripts/owui/` sont **servis par le pont** (OWUI vide son
   dossier `static/` à chaque démarrage — `config.py` — donc y copier un
   script le faisait disparaître) ;
2. `frontend/index.html` reçoit une balise `<script>` par fichier avant
   `</body>`, avec l'origine du pont en `data-bridge`.

- `fb-picker.js` : clic sur le nom du modèle → choisir le dossier du projet
  (`GET /api/projects`, `POST /api/bind`), sans consommer de tour.
- `fb-quota.js` : barre du quota au-dessus de la saisie, lue sur l'écran de la
  session (`GET /api/quota`).
- `fb-bubbles.js` : feuille de style des messages en bulles (couleur d'accent
  pour l'utilisateur, surface neutre pour le modèle, une bulle par appel
  d'outil). Elle ne s'applique que si le mode bulles natif d'OWUI est actif,
  donc le réglage d'OWUI sert d'interrupteur.

Idempotent : les balises précédentes sont remplacées, jamais dupliquées. Le
fichier HTML d'origine est sauvegardé en `.orig` au premier passage. `--check`
ne modifie rien et sort en erreur si l'injection manque ou est périmée ;
`--revert` restaure le HTML et supprime les scripts copiés.

Une mise à jour d'OpenWebUI remplace le paquet : relancer ce script (ou
`start-owui.sh`, qui l'appelle) après chaque mise à jour.
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE_DIR = ROOT / 'scripts' / 'owui'
# Ordre d'injection : le sélecteur d'abord, puis la barre de quota, puis les
# bulles (une feuille de style indépendante du reste).
SOURCES = ('fb-picker.js', 'fb-quota.js', 'fb-bubbles.js')


def package_dir(venv: Path) -> Path:
    for pattern in ('Lib/site-packages/open_webui', 'lib/python*/site-packages/open_webui'):
        found = glob.glob(str(venv / pattern))
        if found:
            return Path(found[0])
    raise SystemExit(f'paquet open_webui introuvable sous {venv}')


def tag_for(mark: str, bridge: str, digest: str) -> str:
    return f'<script src="{bridge}/{mark}?v={digest}" data-bridge="{bridge}" defer></script>'


def tag_re(mark: str) -> re.Pattern[str]:
    """Une balise de CE fichier et la fin de ligne qui la suit, sans toucher au reste."""
    return re.compile(r'[ \t]*<script[^>]*' + re.escape(mark) + r'[^>]*>\s*</script>\r?\n?')


def read_text(path: Path) -> str:
    """Lecture SANS traduction de fins de ligne (le fichier d'OWUI est en CRLF)."""
    with path.open('r', encoding='utf-8', newline='') as handle:
        return handle.read()


def write_text(path: Path, text: str) -> None:
    with path.open('w', encoding='utf-8', newline='') as handle:
        handle.write(text)


def strip_existing(html: str) -> str:
    """Retire les balises déjà injectées, sans toucher au reste."""
    for mark in SOURCES:
        html = tag_re(mark).sub('', html)
    return html


def inject(html: str, tags: list[str]) -> str:
    cleaned = strip_existing(html)
    index = cleaned.rfind('</body>')
    if index < 0:
        raise SystemExit("index.html d'OpenWebUI sans </body> : patch impossible")
    newline = '\r\n' if '\r\n' in cleaned else '\n'
    block = ''.join(tag + newline for tag in tags)
    return f'{cleaned[:index]}{block}{cleaned[index:]}'


def status(index: Path, tags: list[tuple[str, str]]) -> tuple[bool, list[str]]:
    if not index.exists():
        return False, [f'index.html introuvable : {index}']
    html = read_text(index)
    problems: list[str] = []
    for mark, tag in tags:
        if tag not in html:
            problems.append(f'balise absente ou périmée dans index.html ({mark})')
    return not problems, problems


def backup(path: Path) -> None:
    original = path.with_suffix(path.suffix + '.orig')
    if not original.exists():
        shutil.copy2(path, original)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--venv', default=str(ROOT / '.venv-owui'), help='environnement Python d’OpenWebUI')
    parser.add_argument('--bridge', default='http://127.0.0.1:7799', help='origine du pont, vue par le navigateur')
    parser.add_argument('--check', action='store_true', help='ne rien modifier, sortir en erreur si le patch manque')
    parser.add_argument('--revert', action='store_true', help='restaurer index.html et retirer les scripts')
    args = parser.parse_args()

    pkg = package_dir(Path(args.venv))
    index = pkg / 'frontend' / 'index.html'
    tags = [
        (mark, tag_for(mark, args.bridge, hashlib.sha256((SOURCE_DIR / mark).read_bytes()).hexdigest()[:10]))
        for mark in SOURCES
    ]

    if args.revert:
        original = index.with_suffix(index.suffix + '.orig')
        if original.exists():
            shutil.copy2(original, index)
            original.unlink()
            print(f'restauré : {index.name}')
        else:
            print('aucune sauvegarde .orig à restaurer')
        return 0

    ok, problems = status(index, tags)
    if args.check:
        print('interface OWUI : ' + ('injectée' if ok else ' / '.join(problems)))
        return 0 if ok else 1

    if ok:
        print(f'interface OWUI : déjà injectée ({index.name})')
        return 0

    if not index.exists():
        print(f'index.html introuvable : {index}', file=sys.stderr)
        return 1
    missing = [mark for mark in SOURCES if not (SOURCE_DIR / mark).exists()]
    if missing:
        print(f'source introuvable : {", ".join(missing)}', file=sys.stderr)
        return 1

    backup(index)
    write_text(index, inject(read_text(index), [tag for _, tag in tags]))
    print(f'interface OWUI : injectée ({", ".join(SOURCES)}, pont {args.bridge})')
    return 0


if __name__ == '__main__':
    sys.exit(main())
