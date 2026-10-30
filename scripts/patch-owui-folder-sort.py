#!/usr/bin/env python3
"""Trie les dossiers d'OpenWebUI du plus récent au plus ancien.

OpenWebUI 0.12.x trie les dossiers racine par NOM, en dur dans
`Folders.svelte` compilé ; il n'existe ni réglage ni champ d'ordre. Le pont
écrit donc `meta.lastActivity` (epoch secondes, activité la plus récente des
chats du dossier) et ce script apprend à OWUI à s'en servir.

Deux modifications locales, idempotentes :

1. **Backend** : `FolderMetadataResponse` déclare `lastActivity`. Sans ce
   champ, Pydantic retire la clé de `GET /api/v1/folders/` et le frontend ne
   peut pas la lire.
2. **Frontend compilé** : le comparateur racine trie par `meta.lastActivity`
   décroissant, puis par nom à égalité (dossiers jamais importés).

Sans métadonnée, le tri retombe sur `updated_at`, donc un dossier créé à la
main reste à sa place. Le pont rafraîchit `lastActivity` à chaque cycle.

Les fichiers modifiés sont sauvegardés en `.orig` au premier passage. Une mise
à jour d'OpenWebUI remplace le paquet : relancer ce script (ou
`start-owui.sh`, qui l'appelle) après chaque mise à jour. `--check` ne modifie
rien et sort en erreur si le patch manque ; `--revert` restaure les `.orig`.
"""
from __future__ import annotations

import argparse
import glob
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

BACKEND_OLD = """class FolderMetadataResponse(BaseModel):
    icon: Optional[str] = None
"""
BACKEND_NEW = """class FolderMetadataResponse(BaseModel):
    icon: Optional[str] = None
    lastActivity: Optional[int] = None
"""
BACKEND_MARK = '    lastActivity: Optional[int] = None\n'

FRONT_OLD = '.sort((Z,R)=>(x()[Z].name??"").localeCompare(x()[R].name??"",void 0,{numeric:!0,sensitivity:"base"}))'
FRONT_NEW = (
    '.sort((Z,R)=>(Number((x()[R].meta??{}).lastActivity??x()[R].updated_at??0)'
    '-Number((x()[Z].meta??{}).lastActivity??x()[Z].updated_at??0))'
    '||((x()[Z].name??"").localeCompare(x()[R].name??"",void 0,{numeric:!0,sensitivity:"base"})))'
)


def package_dir(venv: Path) -> Path:
    for pattern in ('Lib/site-packages/open_webui', 'lib/python*/site-packages/open_webui'):
        found = glob.glob(str(venv / pattern))
        if found:
            return Path(found[0])
    raise SystemExit(f'paquet open_webui introuvable sous {venv}')


def read_text(path: Path) -> str:
    with path.open('r', encoding='utf-8', newline='') as handle:
        return handle.read()


def write_text(path: Path, text: str) -> None:
    with path.open('w', encoding='utf-8', newline='') as handle:
        handle.write(text)


def backup(path: Path) -> None:
    original = path.with_name(path.name + '.orig')
    if not original.exists():
        shutil.copy2(path, original)


def frontend_chunk(pkg: Path) -> Path | None:
    for path in sorted((pkg / 'frontend' / '_app' / 'immutable' / 'nodes').glob('*.js')):
        if FRONT_OLD in read_text(path):
            return path
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--venv', default=str(ROOT / '.venv-owui'), help='environnement Python d’OpenWebUI')
    parser.add_argument('--check', action='store_true', help='ne rien modifier, sortir en erreur si le patch manque')
    parser.add_argument('--revert', action='store_true', help='restaurer les fichiers .orig')
    args = parser.parse_args()

    pkg = package_dir(Path(args.venv))
    backend = pkg / 'models' / 'folders.py'
    chunk = frontend_chunk(pkg)

    problems: list[str] = []
    if not backend.exists() or BACKEND_MARK not in read_text(backend):
        problems.append('champ lastActivity absent de FolderMetadataResponse')
    if chunk is None:
        # Soit déjà patché (le comparateur d'origine n'existe plus), soit OWUI a changé.
        patched = [
            path
            for path in sorted((pkg / 'frontend' / '_app' / 'immutable' / 'nodes').glob('*.js'))
            if 'lastActivity??x()[' in read_text(path)
        ]
        if not patched:
            problems.append('comparateur de dossiers introuvable dans le frontend compilé')

    if args.revert:
        originals = list((pkg / 'frontend' / '_app' / 'immutable' / 'nodes').glob('*.js.orig'))
        backend_original = backend.with_name(backend.name + '.orig')
        if backend_original.exists():
            originals.append(backend_original)
        for original in originals:
            shutil.copy2(original, original.with_suffix(''))
            original.unlink()
        print(f'tri des dossiers OWUI : {len(originals)} fichier(s) restauré(s)')
        return 0

    if args.check:
        print('tri des dossiers OWUI : ' + ('patché' if not problems else ' / '.join(problems)))
        return 0 if not problems else 1

    if not problems:
        print('tri des dossiers OWUI : déjà patché')
        return 0

    if not backend.exists():
        print(f'fichier introuvable : {backend}', file=sys.stderr)
        return 1
    if chunk is None:
        print('comparateur de dossiers introuvable : OWUI a changé son frontend', file=sys.stderr)
        return 1

    backend_text = read_text(backend)
    if BACKEND_MARK not in backend_text:
        if BACKEND_OLD not in backend_text:
            print('FolderMetadataResponse introuvable : patch impossible', file=sys.stderr)
            return 1
        backup(backend)
        write_text(backend, backend_text.replace(BACKEND_OLD, BACKEND_NEW, 1))

    chunk_text = read_text(chunk)
    if FRONT_OLD in chunk_text:
        backup(chunk)
        write_text(chunk, chunk_text.replace(FRONT_OLD, FRONT_NEW, 1))

    print(f'tri des dossiers OWUI : patché ({chunk.name})')
    return 0


if __name__ == '__main__':
    sys.exit(main())
