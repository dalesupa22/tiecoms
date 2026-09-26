# Chaggu para iOS (nativo)

App nativa en SwiftUI (iOS 17+). No usa WebView, Capacitor ni dependencias externas.
Se comporta igual que la app Android y que la web: la navegación, los textos, los sonidos, los enlaces
y las reglas de sincronización salen de `packages/client-core` y de `apps/web`.
Especificación común: `SPEC.md`, `SPEC-v2.md` y `SPEC-v3.md` (feedback de TestFlight) del coordinador.

| | |
|---|---|
| Bundle ID | `com.chaggu.app` (app) · `com.chaggu.app.share` (Compartir) · `com.chaggu.app.notifications` (Notification Service Extension) · pruebas `com.chaggu.app.tests` / `com.chaggu.app.uitests` |
| Team | `B76US7H3L3` (CERTILABOR SAS), firma automática |
| App Group | `group.com.chaggu.app`: Keychain compartido (servicio `com.chaggu.app.session`) y lista de conversaciones para la extensión |
| Versión | 1.6.1 (build 13), en `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` de `project.yml` |
| Idiomas | es, en (inglés si el sistema no está en español) |
| API | `https://app.chaggu.com` por defecto (web: `https://www.chaggu.com`); `-TCApiURL <url>` al lanzar (pruebas) |

## Qué hace (v1.1)

- **Pestañas**: Inicio · Asuntos · Agenda · Ajustes. Trazo, Recordatorios y WhatsApp se abren desde el
  menú ⋯ de Inicio y desde Ajustes.
- **Conversación**:
  - Pulsación larga sobre un mensaje (equivale al clic derecho de la web): responder con cita, copiar
    texto o enlace, fijar o quitar, recordarme (tiempos rápidos o fecha elegida), marcar como no leído
    desde aquí, derivar, abrir asunto, agendar reunión, reenviar (a Chaggu, WhatsApp, Slack, Teams o
    correo), editar ("(editado)") y eliminar ("Mensaje eliminado").
  - Barra de fijados, etiqueta "Reenviado desde…", tarjeta de resultado de una derivada (`mergedFrom`),
    barra de linaje (de dónde viene, derivadas, devolver el resultado) y tarjetas de reunión en el chat.
- **Chats entre personas** (botón ✎ de Inicio → «Nuevo chat»):
  - Personas de `bootstrap.people` agrupadas por empresa (primero «Tu equipo», luego las demás por nombre y al
    final terceros), con buscador por nombre, cargo, área o empresa y chips de seleccionados.
  - Una persona abre su directo; varias crean un chat grupal `multi` (`POST /chats`), con nombre opcional y los
    logos de las empresas involucradas. Sin nombre, el título son los primeros nombres («Mateo, Ana y 2 más»).
  - En Inicio los `multi` van con los directos (sección «Chats») con caritas apiladas. En Detalles: cargo · área ·
    empresa, «Agregar al grupo» (`history: now`) y «Salir del grupo».
- **Vista previa de enlaces**: los enlaces del texto son tocables y, cuando llega `message.updated` con
  `linkPreview`, se pinta la tarjeta (miniatura pública `/api/v1/previews/…`, sitio, título y descripción).
- **Reenviar a otro chat**: hoja con buscador, selección de hasta 10 chats y comentario opcional. Todo va por
  la cola persistente (cada envío con su `clientMessageId`).
- **Perfil** (Ajustes → Editar perfil): nombre, cargo y área (`PATCH /me`); foto con PhotosPicker, recortada al
  centro a 512×512 JPEG (`POST /me/avatar`, máx. 3 MB) y «Quitar foto». Las fotos se ven en todos los avatares
  (iniciales de respaldo) con caché en memoria y URLCache.
- **Archivos** (Ajustes o menú ⋯ de Inicio): «Mis archivos» y las carpetas de cada espacio; navegar, crear
  carpeta, subir (octet-stream + `x-file-type`, hasta 25 MB) y abrir con la vista rápida del sistema (Compartir).
  `drive.updated` recarga la carpeta abierta.
- **Preferencias**: fijar arriba (conversaciones y espacios) y silenciar (1 h, 8 h, 1 semana o hasta
  que se reactive). Una conversación silenciada no suena ni notifica, pero cuenta como no leída.
- **Asuntos**: filtros Míos / Abiertos / Cerrados agrupados por espacio. El detalle tiene estado,
  responsable, fecha límite, "esperando a <empresa>", mensaje de origen, historial y comentarios, y
  muestra la señal de cuello de botella.
- **Agenda**: lista por día y semana; crear, editar y cancelar reuniones con zona horaria e invitados;
  RSVP (Asistiré / Tal vez / No asistiré); agregar a Google Calendar u Outlook.
- **Recordatorios**: lista Ahora / Próximos, Hecho y Posponer 1 h. `reminder.due` genera una
  notificación local con `tc_notify`.
- **WhatsApp**:
  - Cuentas personal y Business con QR o código de emparejamiento; generar otro código y desconectar.
  - Organizador por categorías, chats con sus mensajes, fijar u ocultar, y vincular un chat a una
    conversación de Chaggu.
  - `whatsapp.updated` refresca la pantalla.
- **Dominios de empresa** (solo owner/admin, en Ajustes → Tu empresa): listar, agregar y verificar por
  TXT.
- **Seguridad**: reportar mensajes/personas, bloquear mensajes directos y ocultar contenido de personas
  bloqueadas; lista para desbloquear en Ajustes. El registro requiere aceptar términos y normas.
- **Eliminar cuenta** (Ajustes): pantalla que explica qué se borra y qué se conserva, pide el correo y
  la contraseña (si la cuenta tiene), y ejecuta `DELETE /api/v1/account`. Al terminar borra las
  credenciales locales y vuelve al login.
- **Compartir hacia Chaggu**:
  - La extensión de iOS acepta texto o un enlace desde cualquier app. El usuario elige la conversación
    y el texto se publica con `forwarded`.
  - El origen se detecta por el formato: un chat de WhatsApp se separa en mensajes con su autor; un
    correo toma De/Asunto; en otro caso queda como "otra app".
  - La extensión usa la sesión de la app (Keychain del grupo). En la app, lo mismo funciona con
    `chaggu://share?text=…`.
- **Login y registro**:
  - "Continuar con Google" y "Continuar con Microsoft" abren `ASWebAuthenticationSession` con PKCE S256.
  - En el registro, el nombre de la empresa (`org_name`) o la invitación (`org`) se pasan al `/start`.
  - Los errores del SSO usan los mismos textos que la web (`err.sso_*`, `err.domain_claimed`).
- **Splash** (arranque en frío, `UI/Splash.swift`): «los puntitos escriben y la marca se enciende», sobre tinta `#17161F`.
  - Empieza idéntico a la Launch Screen (`LaunchSymbol` = símbolo sin rayitas, 200 pt, centrado). Capas con el
    mismo lienzo: `SplashBubbleWhite`/`SplashBubbleOrange` (burbujas sin huecos, 1b/2b) y `SplashSparks`; los 6 puntos
    se dibujan como círculos de tinta (posiciones de `capas-splash/puntitos.txt`).
  - 0–0,15 s quieto; puntos papel «escribiendo» (dos olas, cada punto pulsa en 0,15 + 0,13·i + 0,40·k durante 0,30 s:
    opacidad 1 → 0,25 → 1 y sube 0,35 radios); desde 0,85 s lo mismo con los mandarina; 1,65–1,85 s ¡pum!: rayitas
    (opacidad en 0,08 s, escala 0,3 → 1,15 → 1 desde x=0,83, y=0,17) y golpecito de la mandarina (1 → 1,04 → 1 en su
    centro), con sonido `tc_splash` y háptico; 1,80–2,15 s eslogan (`splash.tagline`, papel al 80 %); 2,35–2,65 s salida.
  - Si la sesión aún carga, se queda en el último cuadro (máx. 6 s). Un toque adelanta. Enlace en frío: desde 1,55 s.
    Reduce Motion: puntos solo con opacidad, rayitas con fundido, sin escalas. Tiempos puros en `SplashTimeline`.
  - Launch Screen: tinta `#17161F` (claro y oscuro) con `LaunchSymbol` (200 pt) centrado.
- **Teclado** (`Core/Keyboard.swift`, también en la extensión): se cierra al deslizar cualquier lista
  (`.scrollDismissesKeyboard(.interactively)` en la raíz), al tocar fuera de un campo (reconocedor en la ventana que no
  roba toques) y con «Listo» en la barra del teclado de los formularios. En el chat, la lista de mensajes lo cierra al
  tocar o deslizar (enviar o elegir una mención no lo cierra) y el compositor solo reenfoca cuando cambia `focused`.
- **Marca**: Chaggu (antes TieComs). Tinta `#17161F`, mandarina `#FF5A36`, papel `#F6F3EC`.
  Contraste AA: en claro, textos/enlaces de acento y botones rellenos usan `#C73A1A` (texto blanco);
  en oscuro, mandarina `#FF5A36` para textos y botones rellenos con texto tinta (`Theme.accentText`,
  `Theme.primaryFill`/`onPrimary`, `primaryProminent()`). La mandarina pura queda para lo decorativo. Ícono y
  logos salen de `chaggu-marca/definitivo` (`AppIcon-1024.png` = `chaggu-appstore-1024.png`, sin alfa;
  `Logo` = `chaggu-logo-para-claro`/`-para-oscuro` con transparencia real, sin placa, @1x/@2x/@3x con
  `rsvg-convert -w 250/500/750`; capas del splash desde `capas-splash/` a 200/400/600 px). Desde la build 9
  (1.6.0) se publica como **app nueva** en App Store Connect: bundle IDs `com.chaggu.app*`, App Group
  `group.com.chaggu.app`, Keychain `com.chaggu.app.session` y esquema `chaggu://` (ver
  «Cambio de identificadores»). Los targets, carpetas y clases Swift (`TieComs…`) y los headers
  `x-tiecoms-*` del API conservan el nombre anterior a propósito.

### Cambio de identificadores (build 9)

- Antes (builds 1–8, app TieComs en App Store Connect): bundle IDs y App Group con el prefijo anterior
  (`…tiecoms.app`) y esquema `tiecoms://`. Esa app queda publicada aparte; Chaggu no comparte con
  ella ni Keychain ni App Group, así que no hay migración de sesión: al instalar Chaggu hay que
  iniciar sesión otra vez. Se quitó la migración de la build 6 (cuenta única del Keychain), que solo
  servía para la app anterior.
- El esquema registrado (CFBundleURLSchemes) es solo `chaggu`, para no chocar con la app anterior si
  las dos están instaladas. El código sigue entendiendo `tiecoms://` (callback de SSO y enlaces) por si
  llega uno.
- SSO: `GET /api/v1/auth/{google|microsoft}/start` lleva `redirect_scheme=chaggu` y el backend
  redirige a `chaggu://auth/callback?code=…`.
- Menciones dentro de la app: `chaggu-mention://<userId>` (solo interno).
- Pendiente fuera de este repo: en el servidor, `APNS_BUNDLE_ID=com.chaggu.app` (el topic de APNs es el
  bundle ID) y el AASA de los dominios debe incluir `B76US7H3L3.com.chaggu.app` en `applinks`.

## Estructura

```
apps/ios/
  project.yml                 XcodeGen (fuente de verdad del proyecto)
  TieComs.xcodeproj           generado por XcodeGen (no editar a mano)
  tools/gen-strings.mjs       genera Localizable.strings desde apps/web/src/i18n.ts + tools/ios-strings.json
  TieComs/
    App/TieComsApp.swift      @main, AppDelegate (notificaciones, punto de extensión APNs), detección de enlace en frío
    Core/
      Models.swift, ModelsV2.swift   DTO con decodificación tolerante (asuntos, agenda, recordatorios, reenvíos, dominios, WhatsApp)
      SocketIOProtocol.swift  paquetes Engine.IO v4 / Socket.IO v5
      SocketIOClient.swift    WebSocket propio: ping/pong, vigilancia, ACK, backoff 0,5→30 s con jitter
      APIClient.swift         HTTP, refresh de vuelo único, AuthRoutes (base /api/v1/auth)
      AppStore.swift          estado y sincronización (cursores, catch-up, cola, eventos nuevos, pestañas y enlaces)
      AppStore+Features.swift edición, fijados, prefs, asuntos, agenda, recordatorios, derivar, reenviar, chats, perfil, archivos, dominios, WhatsApp, eliminar cuenta
      SSO.swift, SharedText.swift, Storage.swift (Keychain del grupo, ShareTargets), Feedback.swift (sonidos, hápticos, avisos)
      DeepLink.swift          /c /w /invite /signup /asuntos /agenda /trazo /whatsapp /share (chaggu://auth/* reservado al SSO)
    UI/                       RootView (pestañas, splash, toast), Home, Conversation, Menus, Sheets, IssuesViews,
                              AgendaViews, MoreViews (Trazo, Recordatorios, WhatsApp, Dominios, Eliminar cuenta), Splash,
                              ChatsViews (nuevo chat, sumar personas, reenviar, vista previa), ProfileFilesViews (perfil, archivos)
    Resources/                Info.plist (generado), entitlements, PrivacyInfo, Assets (AppIcon, Logo claro/oscuro), Sounds/*.caf, es/en
  TieComsShare/               extensión Compartir (SwiftUI) + Info.plist + entitlements
  TieComsTests/               unitarias + integración (IntegrationTests v1, IntegrationV2Tests)
  TieComsUITests/             recorridos v1 (deep links) y v2 (splash → login → fijar/editar → par en vivo), fotogramas del splash
```

## Compilar

```bash
cd apps/ios
node tools/gen-strings.mjs                    # si cambian los textos de la web o tools/ios-strings.json
/opt/homebrew/bin/xcodegen generate           # tras cambiar project.yml o añadir archivos
xcodebuild -scheme TieComs -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO build
```

Si hay dos simuladores con el mismo nombre, usa `id=<UDID>`. Para las pruebas conviene la firma local
del simulador ("Sign to Run Locally"): aplica los entitlements (Keychain del grupo). Si el grupo no está
disponible (build sin firma), el Keychain cae al grupo propio de la app y la extensión no ve la sesión.

Argumentos de lanzamiento (solo pruebas):

| Argumento | Efecto |
|---|---|
| `-TCApiURL <url>` | Usa esa URL de API. |
| `-TCResetSession YES` | Borra la sesión al arrancar. |
| `-TCNoSplash YES` | Arranca sin splash. |
| `-TCSplashFreeze <s>` | Congela el splash en ese instante (capturas). |
| `-TCMetrics YES` | Expone la duración del splash a la prueba de UI. |

En builds Debug también se puede cambiar el servidor manteniendo pulsado el logo del login.

## Probar

Nunca contra producción. API de pruebas en `http://localhost:3041` (base `tiecoms_mobile`, con worker).
La eliminación de cuenta se prueba en `http://localhost:3042` (rama backend `account-deletion`, misma base).

```bash
cd <raíz del worktree>
API_URL=http://localhost:3041 FIXTURE_OUT=/tmp/fx.json node scripts/mobile-fixture.mjs
FIXTURE=/tmp/fx.json API_URL=http://localhost:3041 node scripts/realtime-peer2.mjs &   # par v2 (eco, edición, fijados, RSVP)

cd apps/ios
TEST_RUNNER_TC_FIXTURE=/tmp/fx.json TEST_RUNNER_TC_PEER=1 TEST_RUNNER_TC_PEER2=1 TEST_RUNNER_TC_UI_V1=1 \
TEST_RUNNER_TC_DELETE_API=http://localhost:3042 TEST_RUNNER_TC_SHOTS=/tmp/shots \
  xcodebuild test -scheme TieComs -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
```

- v3 (chats grupales, vista previa, perfil, archivos) necesita un API con almacenamiento y worker. Se probó con
  una base propia y el S3 falso del API:
  ```bash
  node apps/api/test/fake-s3.mjs 59043 &
  # entorno = .env.mobile con PORT=3043, otra base y S3_BUCKET=local S3_ENDPOINT=http://localhost:59043
  # AWS_ACCESS_KEY_ID=x AWS_SECRET_ACCESS_KEY=y; levantar src/server.ts y src/worker.ts con ese entorno
  API_URL=http://localhost:3043 FIXTURE_OUT=/tmp/fx.json node scripts/mobile-fixture.mjs
  ```
  Luego se siembran la tercera persona, el chat `multi` (`multiId` en el fixture), mensajes con enlaces y una
  carpeta, y se corren `TEST_RUNNER_TC_V3=1` (IntegrationV3Tests) y `TEST_RUNNER_TC_UI_V3=1`
  (`testV3ChatsLinksForwardProfileFiles`, capturas con `TC_SHOTS`).
- Feedback v3 (API de la rama `mobile-feedback`, puerto 3043):
  ```bash
  API_URL=http://localhost:3043 FIXTURE_OUT=/tmp/fx3.json node scripts/mobile-fixture.mjs
  TEST_RUNNER_TC_FIXTURE3=/tmp/fx3.json TEST_RUNNER_TC_SHOTS=/tmp/v3fb \
    xcodebuild test -scheme TieComs -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
    -only-testing:TieComsTests -only-testing:TieComsUITests/FeedbackUITests
  ```
  Para ver la pantalla previa al permiso, desinstala la app antes (`xcrun simctl uninstall <UDID> com.chaggu.app`).
  `-TCDemoPhoto YES` (solo Debug) agrega una foto de prueba al elegir la foto, y `-TCOpenConversation <id>` abre un chat al entrar.
- `scripts/realtime-peer2.mjs` es propio de iOS v2. `realtime-peer.mjs` no se cambió (lo usa Android).
  El par v2:
  - responde "eco: …" a los mensajes de A;
  - responde "vi edición: …", "vi borrado" o "vi fijados: n" cuando A edita, borra o fija;
  - con "par: edita" publica, edita y fija un mensaje suyo;
  - con "par: reunión" confirma la última reunión.
- Las credenciales solo están en el JSON del fixture; nada va en el código. El login tiene límite de 10/min.
- La prueba del recordatorio espera hasta 100 s, porque lo crea para dentro de 1 min.

## Enlaces

- Esquema propio: `chaggu://c/<id>`, `/w/<id>`, `/invite/<token>`, `/signup?org=`, `/asuntos`, `/agenda`, `/trazo`,
  `/whatsapp`, `/share?text=`.
- Enlaces universales: `applinks:` para app.chaggu.com, chaggu.com y www.chaggu.com, y también los
  del dominio anterior (app.tiecoms.com, tiecoms.com, www.tiecoms.com) para enlaces viejos. El AASA lo
  publica el coordinador. Sin AASA y sin firmar con el App ID, un enlace https abre Safari: está
  comprobado en simulador.

## Feedback de TestFlight (build 5)

| # | Qué cambió |
|---|---|
| 1 | Foto del grupo: Detalles → «Poner / Cambiar foto del grupo» (grupos con `canManage`, cualquier miembro en chats grupales) y «Quitar foto». Se ve en Inicio, en la cabecera y en Detalles. |
| 2 | Foto de perfil: se toca la foto y se elige de la galería, la cámara o Archivos. Luego un recorte circular (mover y zoom) con **Cancelar / Guardar**, barra de progreso y «Foto actualizada». El resultado es un JPEG de ≤ 512 px y ≤ 3 MB. Grupo y perfil usan el mismo editor (`UI/PhotoEditor.swift`). |
| 3 | Asuntos: un solo compositor, con «Escribe una actualización o una pregunta…» y **Comentar** a la derecha. Los comentarios salen con autor, foto o iniciales y hora. |
| 4 | Conversaciones laterales: en el menú del mensaje, «Preguntar en privado (lateral)». Se eligen personas: miembros y colegas; `side_outsider` las marca como no disponibles. Se abre en una hoja en iPhone o como inspector en iPad. El chip «💬 Consulta lateral» va bajo el ancla, y la lateral cuelga de su origen en Inicio. Tiene «Llevar la respuesta al hilo». |
| 5 | Autor visible: avatar de 28 pt y nombre con color estable por persona, con el mismo algoritmo y paleta que `personColor()` de la web (FNV-1a sobre el id en minúsculas, % 8). Rachas de menos de 5 min. Burbujas propias en `#E8710A` / `#C75F08`. |
| 6 | Push: ver la sección siguiente. |
| 7 | Responder en privado: abre el directo con la cita sobre el compositor y envía `forwarded.messageId`. El servidor agrega `messageSeq` y `excerpt`. «Ver original» salta con `?m=<seq>`. Hay «Enviar mensaje» en Participantes y el lápiz de Inicio abre Nuevo chat. |
| 8 | Pulsación larga con vista previa de la burbuja (`contextMenu` + `preview`), sin reacciones. |
| 9 | Inicio igual que la barra lateral de la web: EMPRESAS Y ESPACIOS (empresa → espacio → conversaciones → laterales, plegables, con no leídos agregados) y CHATS, cada uno con su +. Chip «◆ N asuntos», cabecera «Empresa · Espacio» y barra «Asuntos abiertos (N)». La pestaña Asuntos se agrupa Empresa → Espacio → Conversación, con filtros Míos / Abiertos / Todos. La vista previa de los mensajes de sistema es legible aunque llegue cortada. |

Los textos salen de `tiecoms-feedback/apps/web/src/i18n.ts`: `WEB_I18N=<ruta> node tools/gen-strings.mjs`.
Cuando `mobile-feedback` llegue a main, basta con `node tools/gen-strings.mjs`.
El generador reemplaza en los valores el nombre y el dominio anteriores (TieComs, tiecoms.com) por Chaggu y
chaggu.com, así la app no los muestra aunque la web aún no se haya renombrado. Las claves no cambian.

## SPEC-v4 (build 6)

- **Adjuntos**: clip del compositor (Fotos, Cámara, Archivos), vista previa y progreso antes de enviar, cuadrícula de fotos
  (1–4 + «+N»), visor con zoom, video y Quick Look. Subida `POST /conversations/:id/attachments` + miniatura de 480 px
  (`/attachments/:id/thumb`); descarga con Bearer y caché (`AttachmentCache`). Máx. 10 por mensaje y 25 MB cada uno.
- **Compartir en Chaggu** (`TieComsShare`): la regla SUBQUERY vive en `ShareItems.activationRule` y en `project.yml`
  (una prueba compara ambas con el Info.plist compilado). Acepta fotos, videos, archivos, enlaces y texto, hasta 5 destinos.
  Sugerencias de la fila de arriba: `Donations` (INSendMessageIntent al enviar y al abrir; se borran al cerrar sesión, al
  eliminar la cuenta y al salir de la conversación).
- **Inicio**: pestañas Todo · No leídos · Asuntos · Chats · Laterales (`HomeFilter`), orden por no leídos igual que la web
  (`HomeOrder`, Shell.tsx `compareConversations`/`sortHome`), badge con color de empresa solo si cumple AA; si no, #B45309.
- **Nuevo chat**: «Persona o chat grupal» o «Grupo en un espacio» (`SpaceGroupForm`, `POST /workspaces/:id/conversations`).
- **Asuntos y reuniones en directos y multi** (`workspaceId` null) con sección «Chats»; aviso de reunión 10 min antes
  (`event.soon` y push `TC_EVENT` con `minutes`).
- **Notas de voz** (`Voice.swift`, `VoiceViews.swift`): mantener pulsado el micrófono (soltar envía, ← cancela, ↑ bloquea),
  AAC m4a mono 32 kbps 24 kHz, onda de 64 valores (`x-waveform`), burbuja con velocidad, «Ver transcripción», resumen y
  chip «Crear asunto».
- **Sesión**: el refresh token se guarda por servidor (`refreshToken@host:puerto`; producción conserva `refreshToken`) y
  solo un 401 del refresh cierra la sesión (un 5xx o sin red no). En Debug, `-TCApiURL` queda guardado.

Pruebas v4 (API 3043):

```sh
API_URL=http://localhost:3043 FIXTURE_OUT=/tmp/fx4.json node scripts/mobile-fixture.mjs
xcrun simctl addmedia <sim> foto.png        # nunca en los simuladores de Danny
TEST_RUNNER_TC_FIXTURE4=/tmp/fx4.json TEST_RUNNER_TC_SHOTS=/tmp/v4 xcodebuild test -scheme TieComs \
  -destination 'platform=iOS Simulator,id=<sim>' -only-testing:TieComsTests -only-testing:TieComsUITests/ShareUITests
```

### Sidechats (SPEC-v4 G)

- `SideViews.swift`: iniciar (ancla como burbuja, sugerencias autor/mencionados/frecuentes, Enter envía con una persona),
  panel (avatares, «Privado · solo ustedes N», ⋯, tarjeta del ancla, respuestas rápidas), chip-hilo bajo el ancla
  (`lastMessageSeq − 1` mensajes, verde si se llevó al hilo) y `SidePanelPresenter`: split ~40 % con conector curvo en iPad
  (preferencias de anclaje `SideAnchorKey`), hoja media/grande con línea al ancla en iPhone y burbuja flotante al arrastrar abajo.
- Push `TC_SIDE` con «Responder» en línea; al tocarlo abre el origen con el sidechat desplegado (`AppStore.openSide`).
- «Llevar al hilo» con `POST /conversations/:sideId/return/suggest` (IA o respaldo) y vista previa; `mergedKind:'side'`.
- Notas de voz seguidas se reproducen una tras otra (`VoicePlayer.next`).

### Menciones con @ (SPEC-v4 H)

- `Mentions.swift` (lógica pura, offsets UTF-16 con `utf16`/`NSString`): consulta «@…» al final del borrador, inserción del
  token «@Nombre », `reconcile` (un retroceso borra el token entero; las demás se corren), recorte como el servidor, validación
  (empieza con @, sin solapes, máx. 50), `mentionsMe` (@todos para todos menos el autor) y resaltado en la burbuja.
- `MentionViews.swift`: buscador sobre el compositor (quien más escribe primero, @todos en grupos, «X no está en este chat ·
  Añadir / Preguntarle en un sidechat») y ficha de la persona al tocar una mención.
- Inicio: badge «@» y orden arriba aunque esté silenciada (`unreadMentions`), pestaña «Menciones» con la bandeja `GET /mentions`.
- Avisos: una mención notifica aunque el chat esté silenciado (salvo «siempre»); `droppedMentions` → aviso sutil.

## Push (APNs)

- **Registro**:
  - Tras el primer login aparece una pantalla previa (`push.primerTitle`) y después el permiso del sistema.
  - Con el token se hace `PUT /api/v1/push/token {provider:'apns', token, environment, lang}`. `environment` es `sandbox` en Debug y `production` en Release/TestFlight.
  - Al cerrar sesión se hace `DELETE /push/token`; el logout del API también lo borra.
- **Notification Service Extension** (`TieComsNotifications`):
  - Descarga la foto del autor desde `authorAvatarUrl` (relativa, con la URL base guardada en el App Group).
  - Dona un `INSendMessageIntent` para que salga como **notificación de comunicación** con la foto del remitente y el nombre del grupo, agrupada por `thread-id`.
  - La lógica está en `Core/CommunicationNotification.swift` (probada en unitarias).
- **Acciones**: `TC_MESSAGE` tiene Responder (texto, envía por HTTP) y Marcar como leído. `TC_REMINDER` y `TC_EVENT` abren la conversación.
- **Badge**: no leídos de las conversaciones no silenciadas, igual que el servidor.
- **En primer plano**: no hay banner si es la conversación abierta; si el socket está en línea, el push remoto se omite porque el aviso local ya salió.
- **Lo que debe crear Danny**:
  1. developer.apple.com → Certificates, IDs & Profiles → **Keys** → nueva llave con **Apple Push Notifications service (APNs)**. Descargar el `.p8` (solo una vez) y anotar su Key ID.
  2. En el servidor: `APNS_KEY_ID=<Key ID>`, `APNS_TEAM_ID=B76US7H3L3`, `APNS_BUNDLE_ID=com.chaggu.app` y `APNS_KEY_PATH=/opt/tiecoms/.secrets/apns.p8` (o `APNS_KEY` con el contenido). Nunca en git.
  3. App IDs, con firma automática o a mano:
     - `com.chaggu.app`: capacidades **Push Notifications**, **Communication Notifications**, **App Groups** (`group.com.chaggu.app`) y **Associated Domains**.
     - `com.chaggu.app.notifications` y `com.chaggu.app.share`: **App Groups**.
  4. No hace falta esperar la aprobación de App Store: en TestFlight funciona en cuanto el servidor tenga la llave (entorno `production`).
- **Qué se probó y qué no**:
  - Probado:
    - Registro y borrado del token contra 3043.
    - Payload con `xcrun simctl push` (banner, título y subtítulo, badge 3/4, capturas `v3fb/v3-11-*`, `v3-12-*`).
    - Construcción del intent en unitarias.
  - No probado: el simulador no ejecutó la Notification Service Extension con `simctl push` (no aparece su proceso en el log), así que la foto del remitente solo se puede ver en un iPhone real con la llave APNs.

## Checklist de publicación (App Store Connect)

**Firma**
- El proyecto usa firma automática. Para esa vía, inicia sesión con una cuenta del team en
  Xcode › Settings › Accounts. Un archivo con `CODE_SIGNING_ALLOWED=NO` sirve para validar la
  compilación, pero no se puede subir sin firmarlo.
- Con la cuenta configurada, archiva así:
  ```bash
  xcodebuild -scheme TieComs -configuration Release -destination 'generic/platform=iOS' \
    -archivePath build/TieComs.xcarchive -allowProvisioningUpdates archive
  xcodebuild -exportArchive -archivePath build/TieComs.xcarchive -exportPath build/export \
    -exportOptionsPlist ExportOptions.plist -allowProvisioningUpdates   # method app-store-connect, teamID B76US7H3L3
  ```

- También se puede archivar sin iniciar sesión en Xcode si el llavero contiene el certificado
  Apple Distribution y su clave privada, y están instalados los perfiles de distribución
  `Chaggu App Store`, `Chaggu Share App Store` y `Chaggu Notifications App Store` (cada target los
  tiene en `CHAGGU_APPSTORE_PROFILE` de `project.yml`):
  ```bash
  xcodebuild -scheme TieComs -configuration Release -destination 'generic/platform=iOS' \
    -archivePath build/TieComs.xcarchive CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY='Apple Distribution' \
    'PROVISIONING_PROFILE_SPECIFIER=$(CHAGGU_APPSTORE_PROFILE)' archive
  xcodebuild -exportArchive -archivePath build/TieComs.xcarchive -exportPath build/export \
    -exportOptionsPlist ExportOptions.plist
  ```
  `ExportOptions.plist` incluye el team y la correspondencia de los tres perfiles manuales. No contiene
  claves privadas ni credenciales de App Store Connect.

**Portal de desarrollo**
Chaggu es una app nueva: hay que crear en developer.apple.com › Certificates, IDs & Profiles (team
`B76US7H3L3`) lo siguiente. Aún no existe nada de esto.
1. **App Group** (Identifiers › App Groups): `group.com.chaggu.app` (descripción «Chaggu»).
2. **App IDs** (Identifiers › App IDs, explícitos):
   - `com.chaggu.app` («Chaggu»): **App Groups** (`group.com.chaggu.app`), **Associated Domains**,
     **Push Notifications** y **Communication Notifications**.
   - `com.chaggu.app.share` («Chaggu Share»): **App Groups** (`group.com.chaggu.app`).
   - `com.chaggu.app.notifications` («Chaggu Notifications»): **App Groups** (`group.com.chaggu.app`).
3. **Perfiles** (Profiles › Distribution › App Store Connect, certificado Apple Distribution), con
   estos nombres exactos, que son los de `ExportOptions.plist`:
   - `Chaggu App Store` → `com.chaggu.app`
   - `Chaggu Share App Store` → `com.chaggu.app.share`
   - `Chaggu Notifications App Store` → `com.chaggu.app.notifications`
- Con firma automática y `-allowProvisioningUpdates`, Xcode puede crear los App IDs y perfiles de
  desarrollo; los de App Store con esos nombres se crean a mano.
- `com.chaggu.app.tests` y `com.chaggu.app.uitests` no necesitan App ID ni perfil de distribución.

**App Store Connect**
- Nueva app iOS "Chaggu", idioma principal español, bundle `com.chaggu.app`, SKU `chaggu-ios`.
- Categoría Negocios (secundaria Productividad), clasificación 4+.

**Capturas sugeridas** (6,9", iPhone 17 Pro Max 1320×2868; sale de `TieComsUITests` con `TC_SHOTS`)
1. Splash con el logo de Chaggu.
2. Inicio con espacios, fijadas y no leídos.
3. Conversación entre dos empresas con cita y reenviado.
4. Menú de acciones de un mensaje.
5. Asuntos con cuello de botella.
6. Agenda con reunión y RSVP.
7. WhatsApp organizado.

**Texto de la ficha (es)**
- Subtítulo: "Una red entre empresas".
- Descripción: "Chaggu une a las personas de las empresas con las que trabajas en una sola red. Cada
  empresa conserva su identidad y cada persona ve solo su alcance. Conversa en grupos compartidos o
  internos, convierte mensajes en asuntos con responsable y fecha, agenda reuniones, deriva un tema y
  devuelve el resultado, y trae lo importante desde WhatsApp, Slack o el correo. Cada empresa. Cada
  canal. Un solo hilo."
- Palabras clave: "chat empresas,clientes,proveedores,asuntos,agenda,whatsapp,equipos,b2b".

**Store listing (en)**
- Subtitle: "One network across companies".
- Description: "Chaggu connects the people of the companies you work with in one network. Every
  company keeps its identity and everyone only sees their own scope. Talk in shared or internal
  groups, turn messages into issues with an owner and a due date, schedule meetings, branch a topic
  off and bring the result back, and bring in what matters from WhatsApp, Slack or email. Every
  company. Every channel. One thread."
- Keywords: "business chat,clients,suppliers,issues,calendar,whatsapp,teams,b2b".

**Permisos y por qué**
- Notificaciones: avisos de mensajes, recordatorios y reuniones. Se piden después del primer login.
- Red local (ATS `NSAllowsLocalNetworking`): solo para pruebas contra localhost.
- Cámara: tomar una foto de perfil o grupo, o una foto o video para adjuntar. Micrófono: grabar notas de voz.
- No solicita permisos de contactos ni ubicación. El QR de WhatsApp se muestra, no se escanea.
  Si el usuario conecta WhatsApp, el servidor sincroniza los contactos de esa cuenta.
- Compartir: la extensión recibe fotos, videos, archivos, texto o enlaces que el usuario comparte a propósito.

**Privacidad**
- `PrivacyInfo.xcprivacy` se incluye en la app y la extensión: UserDefaults propios (CA92.1) y del
  App Group (1C8F.1); nombre, correo, teléfono y contactos opcionales de WhatsApp, mensajes, fotos elegidas,
  audio y archivos elegidos, otro contenido del usuario, reportes de soporte, ID de cuenta, ID propio del dispositivo e interacción
  con el producto (lecturas, actividad y sesiones) y búsquedas de WhatsApp enviadas al servidor (los registros HTTP conservan la consulta), vinculados a la cuenta para funcionalidad, sin rastreo. Las fotos usan el selector del sistema; no se solicita
  acceso completo a la fototeca.
- Contenido de WhatsApp: solo lo ve el dueño.

**Inicio de sesión (guía 4.8)**
- Se conservan Google y Microsoft, además de correo/contraseña. Apple exime las apps de educación o
  empresa que requieren una cuenta educativa o empresarial existente. Como Chaggu también permite
  crear una empresa desde el registro, App Review debe evaluar si esta excepción aplica; no se asume
  aprobación. Fuente: https://developer.apple.com/app-store/review/guidelines/#login-services

**Cuentas de demostración para la revisión**
- Crea dos cuentas de empresas distintas con un grupo compartido en producción (mismo esquema que
  `scripts/mobile-fixture.mjs`).
- Entrega una a Apple con conversación, un asunto y una reunión de ejemplo.
- WhatsApp necesita un teléfono real: explícalo en las notas de revisión.

**Eliminar cuenta (guía 5.1.1(v))**
- Implementado contra `DELETE /api/v1/account`.
- Backend integrado en producción en `e679a10`: eliminación de cuenta y controles de reporte/bloqueo.
  Antes de enviar una nueva versión, vuelve a verificar la eliminación con una cuenta de prueba.

**Otros**
- `ITSAppUsesNonExemptEncryption = false` (solo HTTPS del sistema).
- iPad: `TARGETED_DEVICE_FAMILY` = 1,2; quita el 2 si no se publica para iPad.

**Qué falta de backend**
- Endpoint de tokens push (APNs).
- AASA en los 3 hosts.
- Credenciales de SSO en el entorno donde se pruebe (3041 responde `503 sso_unavailable`).
