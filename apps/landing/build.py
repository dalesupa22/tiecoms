"""Genera la landing estática de www.tiecoms.com en dist/: español en / e inglés en /en/.

La versión en inglés se produce aplicando src/i18n/landing.en.json sobre la misma
página; si una frase de origen deja de existir, el build falla para no publicar
una mezcla de idiomas.
"""
from pathlib import Path
import hashlib
import json
import shutil

root = Path(__file__).parent
src = root / 'src'
dist = root / 'dist'
shutil.rmtree(dist, ignore_errors=True)
(dist / 'en').mkdir(parents=True)
shutil.copytree(src / 'assets', dist / 'assets')
for name in ['landing.css', 'landing.js', 'relay.css', 'relay.js', 'legal.css']:
    shutil.copy2(src / name, dist / name)

landing = (src / 'landing.html').read_text()
# Versiona CSS/JS por contenido: Cloudflare los guarda horas en caché.
for name in ['landing.css', 'landing.js', 'relay.css', 'relay.js']:
    v = hashlib.sha256((src / name).read_bytes()).hexdigest()[:10]
    landing = landing.replace(f'"/{name}"', f'"/{name}?v={v}"')
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

# Páginas legales (privacidad y términos), enlazadas desde la pantalla de consentimiento
# de Google y Microsoft: /privacidad/, /terminos/, /en/privacy/, /en/terms/.
template = (src / 'legal' / 'template.html').read_text()
UPDATED = {'es': 'Última actualización: 24 de septiembre de 2026', 'en': 'Last updated: September 24, 2026'}
PRIVACY_UPDATED = {'es': 'Última actualización: 25 de septiembre de 2026', 'en': 'Last updated: September 25, 2026'}
PAGES = [
    # (idioma, ruta, fuente, título, ruta en el otro idioma, descripción)
    ('es', '/privacidad/', 'privacidad.es.html', 'Política de privacidad', '/en/privacy/', 'Cómo TieComs trata los datos personales.'),
    ('es', '/terminos/', 'terminos.es.html', 'Términos del servicio', '/en/terms/', 'Condiciones de uso de TieComs.'),
    ('en', '/en/privacy/', 'privacy.en.html', 'Privacy policy', '/privacidad/', 'How TieComs handles personal data.'),
    ('en', '/en/terms/', 'terms.en.html', 'Terms of service', '/terminos/', 'TieComs terms of service.'),
    ('es', '/soporte/', 'soporte.es.html', 'Soporte', '/en/support/', 'Ayuda con tu cuenta, conversaciones y archivos de TieComs.'),
    ('en', '/en/support/', 'support.en.html', 'Support', '/soporte/', 'Help with your TieComs account, conversations and files.'),
    ('es', '/eliminar-cuenta/', 'eliminar-cuenta.es.html', 'Eliminar tu cuenta', '/en/delete-account/', 'Cómo solicitar la eliminación de tu cuenta de TieComs y qué datos se conservan.'),
    ('en', '/en/delete-account/', 'delete-account.en.html', 'Delete your account', '/eliminar-cuenta/', 'How to request deletion of your TieComs account and which data is retained.'),
]
for lang, path, source, title, alt, desc in PAGES:
    es = lang == 'es'
    links = ('<a href="/soporte/">Soporte</a><a href="/eliminar-cuenta/">Eliminar cuenta</a><a href="/privacidad/">Privacidad</a><a href="/terminos/">Términos</a><a href="https://app.tiecoms.com/">App</a>' if es
             else '<a href="/en/support/">Support</a><a href="/en/delete-account/">Delete account</a><a href="/en/privacy/">Privacy</a><a href="/en/terms/">Terms</a><a href="https://app.tiecoms.com/">App</a>')
    values = {
        'lang': lang, 'title': title, 'description': desc, 'body': (src / 'legal' / source).read_text(),
        'path_es': path if es else alt, 'path_en': alt if es else path,
        'home': '/' if es else '/en/', 'alt_path': alt, 'alt_lang': 'en' if es else 'es', 'alt_label': 'EN' if es else 'ES',
        'app_label': 'Entrar' if es else 'Sign in', 'eyebrow': 'Legal', 'updated': (PRIVACY_UPDATED if source in ('privacidad.es.html', 'privacy.en.html') else UPDATED)[lang],
        'tagline': 'Conecta humanos, empresas y bots.' if es else 'Connects people, companies and bots.', 'footer_links': links,
    }
    page = template
    for k, v in values.items():
        page = page.replace('{{' + k + '}}', v)
    v = hashlib.sha256((src / 'legal.css').read_bytes()).hexdigest()[:10]
    page = page.replace('"/legal.css"', f'"/legal.css?v={v}"')
    out = dist / path.strip('/') / 'index.html'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page)
print('landing: páginas legales listas')
