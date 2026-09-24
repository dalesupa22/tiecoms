"""Genera la landing estática de www.tiecoms.com en dist/: español en / e inglés en /en/.

La versión en inglés se produce aplicando src/i18n/landing.en.json sobre la misma
página; si una frase de origen deja de existir, el build falla para no publicar
una mezcla de idiomas.
"""
from pathlib import Path
import json
import shutil

root = Path(__file__).parent
src = root / 'src'
dist = root / 'dist'
shutil.rmtree(dist, ignore_errors=True)
(dist / 'en').mkdir(parents=True)
shutil.copytree(src / 'assets', dist / 'assets')
for name in ['landing.css', 'landing.js']:
    shutil.copy2(src / name, dist / name)

landing = (src / 'landing.html').read_text()
(dist / 'index.html').write_text(landing)

english, missing = landing, []
for es, en in json.loads((src / 'i18n' / 'landing.en.json').read_text()):
    if es not in english:
        missing.append(es[:80])
    english = english.replace(es, en)
if missing:
    raise SystemExit('Traducción desactualizada; no se encontraron:\n  ' + '\n  '.join(missing))
(dist / 'en' / 'index.html').write_text(english)
print('landing: dist listo (es + en)')
