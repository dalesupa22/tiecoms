# GIFs y memes — publicación del 1 de octubre de 2026 UTC

Entrega autorizada: GIFs y memes en todos los clientes de Chaggu, con iOS/Android exclusivamente en pruebas internas. La entrega ocurrió el 30 de septiembre por la noche en Bogotá. El [listado de Lorena](LORENA-MEJORAS-2026-09-30.md) conserva las 26 solicitudes concretas y sus resultados; esas mejoras siguen publicadas en web/API.

## Funcionalidad

- Selector GIF/Meme solamente en chats Chaggu (grupos, conversaciones internas y mensajes directos); no se agrega al compositor de WhatsApp ni correo.
- GIFs animados: destacados, búsqueda y paginación mediante [Openverse](https://github.com/WordPress/openverse), filtrados a GIFs de Wikimedia Commons con BY/BY-SA/CC0/PDM. Se conserva autor, fuente y licencia al enviarlos. El catálogo libre es más pequeño que los comerciales.
- Memes: plantillas de [memegen](https://github.com/jacebrowning/memegen), motor MIT. La licencia del motor no se aplica automáticamente a las imágenes de las plantillas. Texto superior e inferior generado en el dispositivo, sin enviar las frases al proveedor. Procedencia de la plantilla conservada.
- Adjuntos estándar, con permisos existentes. Borrador, respuesta, tema y una sola vista preservados. Importaciones pendientes se descartan al cambiar de sesión; envío protegido contra doble clic.
- Proxy con token autenticado/cifrado, controles de hosts y DNS, tipos/tamaños comprobados y colas acotadas. Ver [contrato y proveedores](GIFS.md).

## Entrega verificada

| Cliente | Entrega | Fuente y rama |
| --- | --- | --- |
| Web/API | Producción `20261001035401-0692c2f`; API listo, contrato `2026-09-29.2` | `0692c2f`, `temporal/lorena-mejoras-20260930` |
| Mac | 0.3.5 universal (Apple Silicon e Intel), firmada y notarizada; Gatekeeper Accepted | `51fffe84`, `temporal/desktop-gifs-035` |
| Windows | 0.3.5: instalador EXE y MSI, CI y prueba Rust aprobados | `7f8c920`, `temporal/desktop-gifs-035`; ejecución GitHub 36812431060 |
| iOS | 1.7.6 (45), TestFlight interno, `VALID / IN_BETA_TESTING`, cinco testers existentes | `4299a727`, `temporal/ios-gifs-memes-176` |
| Android | 1.7.6 (45), pista interna activa, disponible a testers | `21321af2`, `temporal/android-gifs-memes-176` |

Todas las ramas tienen commit y push. `principal` y sus cambios locales de otra sesión se conservaron. Los commits de esta entrega deben integrarse antes de un próximo despliegue desde esa rama, para conservar las mejoras.

Descargas verificadas mediante el cuerpo recibido por HTTPS, tamaño y SHA256, sin depender solo de HTTP 200:

- [Mac DMG](https://www.chaggu.com/descargas/chaggu-mac.dmg)
- [Windows EXE](https://www.chaggu.com/descargas/chaggu-windows.exe) / [Windows MSI](https://www.chaggu.com/descargas/chaggu-windows.msi)
- [Google Play: enlace de pruebas existente](https://play.google.com/apps/internaltest/4701693954296475255)
- iOS: TestFlight, grupo existente `Chaggu Internal`; no se crearon invitaciones ni grupo público.

## Revisión pública preservada

- Apple: versión pública 1.7.5, build 44; versión y submission originales `WAITING_FOR_REVIEW`. Nueva build 45 agregada exclusivamente a TestFlight interno. Grupo con acceso a todos los builds y los mismos cinco testers. Notas de pruebas español/inglés actualizadas solo para build 45.
- Google: producción 1.7.5 (44), idéntica antes/después; pantalla de Publishing overview sigue mostrando esa versión en Changes in review. Commit de la edición interna con `changesInReviewBehavior=ERROR_IF_IN_REVIEW`, que impide cancelar la revisión pendiente. Solo se actualizó `internal`; configuración de testers preservada y no se promocionó a producción.
- DB: los registros públicos `app_releases` siguen idénticos, incluidos `updated_at`; no se marcan las betas como actualización pública obligatoria.
- Overlay de descargas: API, contenedores, carpeta de app web, `RELEASE`, artefactos anteriores y metadata móvil preservados, con backup/rollback y hashes comprobados.

## Validación

- Web: 194 pruebas aprobadas en 29 archivos; typecheck de contratos/cliente/API/web correcto.
- API GIFs: 21 pruebas aprobadas; regresión Lorena: 23 aprobadas. Permisos, proxy, token, SSRF, límites de cola y descarga/importación comprobados.
- Web local: catálogo real y editor; meme enviado a un chat de prueba, JPEG descargado del S3 local y revisado visualmente con ambas frases; GIF de una sola vista persiste oculto y el control se restablece tras envío. Capturas en `docs/qa/gifs-20261001/`.
- Web producción: selector GIF abierto en chat personal, catálogo e imágenes reales cargan; no se enviaron mensajes en producción. API de producción comprobado con Openverse y memegen reales, GIF animado, JPEG y atribución.
- Android: 522 pruebas unitarias, 512 aprobadas y 10 omitidas por fixtures; 5/5 de interfaz en emulador API36. Lint sin errores y AAB firmado con versión/número/certificado comprobados.
- iOS: 604 pruebas unitarias, 38 omitidas por fixtures y cero fallos; 32 enfocadas aprobadas; prueba de interfaz local GIF+memes con borrador y ambos textos, sin pulsar Enviar. IPA, app y extensiones 1.7.6 (45), firma strict/deep correcta.
- Windows: CI success, instaladores EXE/MSI generados, una prueba Rust aprobada. No se hizo prueba de instalación en un PC físico. La firma de Microsoft sigue pendiente, igual que la distribución anterior; la landing lo indica.
- Mac: universal, firma, notarización de app/DMG y Gatekeeper verificados. La prueba visual de la app nativa no pudo hacerse porque el Mac estaba bloqueado; la interfaz compartida sí se verificó en web. No se cambiaron permisos del sistema para resolverlo.
- No se valida recepción de la beta en un iPhone/Android físico. TestFlight y Play verifican disponibilidad interna; los simuladores/emuladores verifican el flujo local. iOS limita las animaciones a 240 frames / presupuesto de memoria; las que exceden el límite se muestran estáticas.

## Recibos y artefactos

Los recibos locales se guardan fuera de Git en `../release-assets/1.7.6/` y `../release-assets/desktop-0.3.5/`; no contienen claves de API. Se conservan IPA, AAB, DMG, EXE/MSI, hashes, logs de compilación, xcresults, pruebas Android, capturas y comprobaciones de tiendas.

| Artefacto | SHA256 |
| --- | --- |
| iOS IPA 1.7.6 (45) | `cf22fdc03bee4a8d12d4303f95973f6e60f88257dc4ff7cd6c2e1f530b3d261c` |
| Android AAB 1.7.6 (45) | `b40708505f98d579bafa14f19e24c5739ce7ebef749ab697667b9193d0052da5` |
| Mac DMG 0.3.5 | `4708e6aabac828cf4c9469caeea77d9af4a932b79b3a1546dfb590775b7f3e3b` |
| Windows EXE 0.3.5 | `7637113a68700f2b4eead37a1f930d648fa646d020511df7dafda8a03c120a6b` |
| Windows MSI 0.3.5 | `ab54940922a49b9cc9ecd11e70500c98b3fa6ffeee4bc58253efe37de872f7ac` |

Recibos clave: `1.7.6/backend-verification.json`, `1.7.6/ios/internal-45-receipt.json`, `1.7.6/android/internal-45-receipt.json`, `desktop-0.3.5/mac-signing-receipt.json`, `desktop-0.3.5/deployment-receipt.json` y `desktop-0.3.5/public-verification.json`. Apple build45 ID: `945f1ea4-4b89-45ee-894b-e6c4977e4d7e`; Google release interna `19`.
