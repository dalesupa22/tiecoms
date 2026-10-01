# GIFs y memes en chats Chaggu

Selector GIF/Memes exclusivamente en conversaciones Chaggu. Búsqueda, destacados y paginación de GIFs animados de Wikimedia Commons vía Openverse; plantillas vía memegen.link. El motor Openverse y el generador memegen son de código abierto; cada GIF conserva su propia licencia y atribución, y las imágenes de memes conservan su procedencia (la licencia MIT del motor no se atribuye a las imágenes).

Web y escritorio comparten el selector, comando `/gif búsqueda` y editor con texto superior/inferior. Los clientes nativos ofrecen selección y edición local y conservan el borrador hasta pulsar Enviar. Los GIFs se importan como adjuntos estándar y el texto del mensaje conserva autor, fuente y licencia. El editor de memes dibuja el texto en el dispositivo, sin transmitir las frases al proveedor.

## API

- `GET /api/v1/gifs/trending`, `GET /api/v1/gifs/search?q=...&cursor=...`: sesión requerida; Openverse activo incluso si existe una clave comercial heredada.
- `GET /api/v1/memes/templates`: sesión requerida; URLs de preview/plantilla son proxies del mismo origen.
- `POST /api/v1/conversations/:id/gifs`: sesión y permiso de escritura; devuelve `{attachment, attribution}` para el envío estándar del mensaje.
- `GET /api/v1/gifs/media?t=...`: medios del catálogo, token cifrado y autenticado, hosts permitidos también tras redirecciones, DNS público, tipos de imagen comprobados y tamaños limitados.

Límites: 4 descargas activas y 64 pendientes por proveedor; saturación 503, caché de medios de 64 MB. Vista previa hasta 4 MB, importación hasta 10 MB. No se integra el selector a WhatsApp ni correo. Reply, tema y una sola vista se conservan en el envío. `GIFS_PROVIDER=off` / `MEMES_PROVIDER=off` permiten apagar cada catálogo.

## Proveedores

- [Openverse](https://github.com/WordPress/openverse): búsqueda de imágenes libres, filtrada a GIFs de Wikimedia Commons con BY/BY-SA/CC0/PDM y mature=false.
- [memegen](https://github.com/jacebrowning/memegen): motor MIT, plantillas y fuentes propias. El proxy descarga solo la imagen base; Chaggu agrega las frases localmente.

## Validación y entrega

Ver `docs/GIFS-PUBLICACION-2026-10-01.md` para commits, pruebas, builds, pistas de entrega y comprobación de las revisiones públicas existentes. Los builds móviles 1.7.6 (45) se destinan exclusivamente a pruebas internas. No se cambian los registros de actualizaciones públicas ni se sustituye la versión 1.7.5 (44) en revisión.
