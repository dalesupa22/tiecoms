# TieComs para iOS (nativo)

App nativa en SwiftUI (iOS 17+). No usa WebView, Capacitor ni dependencias externas.
Se comporta igual que la app Android y que la web: la navegación, los textos, los sonidos, los enlaces
y las reglas de sincronización salen de `packages/client-core` y de `apps/web`.
Especificación común: `SPEC.md` y `SPEC-v2.md` del coordinador.

| | |
|---|---|
| Bundle ID | `com.tiecoms.app` (app) · `com.tiecoms.app.share` (extensión Compartir) |
| Team | `B76US7H3L3` (CERTILABOR SAS), firma automática |
| App Group | `group.com.tiecoms.app`: Keychain compartido y lista de conversaciones para la extensión |
| Versión | 1.1.0 (build 4), en `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` de `project.yml` |
| Idiomas | es, en (inglés si el sistema no está en español) |
| API | `https://app.tiecoms.com` por defecto; `-TCApiURL <url>` al lanzar (pruebas) |

## Qué hace (v1.1)

- **Pestañas**: Inicio · Asuntos · Agenda · Ajustes. Trazo, Recordatorios y WhatsApp se abren desde el
  menú ⋯ de Inicio y desde Ajustes.
- **Conversación**:
  - Pulsación larga sobre un mensaje (equivale al clic derecho de la web): responder con cita, copiar
    texto o enlace, fijar o quitar, recordarme (tiempos rápidos o fecha elegida), marcar como no leído
    desde aquí, derivar, abrir asunto, agendar reunión, reenviar (a TieComs, WhatsApp, Slack, Teams o
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
    conversación de TieComs.
  - `whatsapp.updated` refresca la pantalla.
- **Dominios de empresa** (solo owner/admin, en Ajustes → Tu empresa): listar, agregar y verificar por
  TXT.
- **Seguridad**: reportar mensajes/personas, bloquear mensajes directos y ocultar contenido de personas
  bloqueadas; lista para desbloquear en Ajustes. El registro requiere aceptar términos y normas.
- **Eliminar cuenta** (Ajustes): pantalla que explica qué se borra y qué se conserva, pide el correo y
  la contraseña (si la cuenta tiene), y ejecuta `DELETE /api/v1/account`. Al terminar borra las
  credenciales locales y vuelve al login.
- **Compartir hacia TieComs**:
  - La extensión de iOS acepta texto o un enlace desde cualquier app. El usuario elige la conversación
    y el texto se publica con `forwarded`.
  - El origen se detecta por el formato: un chat de WhatsApp se separa en mensajes con su autor; un
    correo toma De/Asunto; en otro caso queda como "otra app".
  - La extensión usa la sesión de la app (Keychain del grupo). En la app, lo mismo funciona con
    `tiecoms://share?text=…`.
- **Login y registro**:
  - "Continuar con Google" y "Continuar con Microsoft" abren `ASWebAuthenticationSession` con PKCE S256.
  - En el registro, el nombre de la empresa (`org_name`) o la invitación (`org`) se pasan al `/start`.
  - Los errores del SSO usan los mismos textos que la web (`err.sso_*`, `err.domain_claimed`).
- **Splash "Un solo hilo"** (arranque en frío, `UI/Splash.swift`):
  - Personas, luego el hilo naranja que las une, el nudo, el logo que nace con un pulso y chispas, y
    el eslogan.
  - Se dibuja con Canvas + TimelineView a 60 fps. La coreografía es una función pura del tiempo
    (`SplashTimeline`).
  - Sonido `tc_splash` en t = 0,30 s (respeta el interruptor de Sonidos y el modo silencio) y háptico
    ligero en el nudo (t = 1,02 s).
  - Un toque salta al final. Con Reduce Motion solo hace un fundido del logo. Con un enlace en frío
    empieza en la fase 4 y dura como máximo 1,2 s. Si la sesión aún carga, un punto late hasta 6 s.
  - Launch Screen: crema liso, `#161413` en modo oscuro.

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
      DeepLink.swift          /c /w /invite /signup /asuntos /agenda /trazo /whatsapp /share (tiecoms://auth/* reservado al SSO)
    UI/                       RootView (pestañas, splash, toast), Home, Conversation, Menus, Sheets, IssuesViews,
                              AgendaViews, MoreViews (Trazo, Recordatorios, WhatsApp, Dominios, Eliminar cuenta), Splash,
                              ChatsViews (nuevo chat, sumar personas, reenviar, vista previa), ProfileFilesViews (perfil, archivos)
    Resources/                Info.plist (generado), entitlements, PrivacyInfo, Assets (AppIcon, wordmark por capas), Sounds/*.caf, es/en
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
- `scripts/realtime-peer2.mjs` es propio de iOS v2. `realtime-peer.mjs` no se cambió (lo usa Android).
  El par v2:
  - responde "eco: …" a los mensajes de A;
  - responde "vi edición: …", "vi borrado" o "vi fijados: n" cuando A edita, borra o fija;
  - con "par: edita" publica, edita y fija un mensaje suyo;
  - con "par: reunión" confirma la última reunión.
- Las credenciales solo están en el JSON del fixture; nada va en el código. El login tiene límite de 10/min.
- La prueba del recordatorio espera hasta 100 s, porque lo crea para dentro de 1 min.

## Enlaces

- Esquema propio: `tiecoms://c/<id>`, `/w/<id>`, `/invite/<token>`, `/signup?org=`, `/asuntos`, `/agenda`, `/trazo`,
  `/whatsapp`, `/share?text=`.
- Enlaces universales: `applinks:` para app.tiecoms.com, tiecoms.com y www.tiecoms.com. El AASA lo
  publica el coordinador. Sin AASA y sin firmar con el App ID, un enlace https abre Safari: está
  comprobado en simulador.

## Push remoto

El backend aún no recibe tokens. El punto de extensión es `PushRegistration` en `Core/Feedback.swift`.
Las notificaciones locales (mensajes de otra conversación, recordatorios y reuniones nuevas) solo se
disparan mientras la app está viva.

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
  `TieComs AppStore` y `TieComsShare AppStore`:
  ```bash
  xcodebuild -scheme TieComs -configuration Release -destination 'generic/platform=iOS' \
    -archivePath build/TieComs.xcarchive CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY='Apple Distribution' \
    'PROVISIONING_PROFILE_SPECIFIER=$(TARGET_NAME) AppStore' archive
  xcodebuild -exportArchive -archivePath build/TieComs.xcarchive -exportPath build/export \
    -exportOptionsPlist ExportOptions.plist
  ```
  `ExportOptions.plist` incluye el team y la correspondencia de ambos perfiles manuales. No contiene
  claves privadas ni credenciales de App Store Connect.

**Portal de desarrollo**
- App IDs `com.tiecoms.app` (Associated Domains + App Groups) y `com.tiecoms.app.share` (App Groups).
- App Group `group.com.tiecoms.app`.
- La firma automática los crea con `-allowProvisioningUpdates`.

**App Store Connect**
- Nueva app iOS "TieComs", idioma principal español, bundle `com.tiecoms.app`, SKU `tiecoms-ios`.
- Categoría Negocios (secundaria Productividad), clasificación 4+.

**Capturas sugeridas** (6,9", iPhone 17 Pro Max 1320×2868; sale de `TieComsUITests` con `TC_SHOTS`)
1. Splash / logo "Un solo hilo".
2. Inicio con espacios, fijadas y no leídos.
3. Conversación entre dos empresas con cita y reenviado.
4. Menú de acciones de un mensaje.
5. Asuntos con cuello de botella.
6. Agenda con reunión y RSVP.
7. WhatsApp organizado.

**Texto de la ficha (es)**
- Subtítulo: "Una red entre empresas".
- Descripción: "TieComs une a las personas de las empresas con las que trabajas en una sola red. Cada
  empresa conserva su identidad y cada persona ve solo su alcance. Conversa en grupos compartidos o
  internos, convierte mensajes en asuntos con responsable y fecha, agenda reuniones, deriva un tema y
  devuelve el resultado, y trae lo importante desde WhatsApp, Slack o el correo. Cada empresa. Cada
  canal. Un solo hilo."
- Palabras clave: "chat empresas,clientes,proveedores,asuntos,agenda,whatsapp,equipos,b2b".

**Store listing (en)**
- Subtitle: "One network across companies".
- Description: "TieComs connects the people of the companies you work with in one network. Every
  company keeps its identity and everyone only sees their own scope. Talk in shared or internal
  groups, turn messages into issues with an owner and a due date, schedule meetings, branch a topic
  off and bring the result back, and bring in what matters from WhatsApp, Slack or email. Every
  company. Every channel. One thread."
- Keywords: "business chat,clients,suppliers,issues,calendar,whatsapp,teams,b2b".

**Permisos y por qué**
- Notificaciones: avisos de mensajes, recordatorios y reuniones. Se piden después del primer login.
- Red local (ATS `NSAllowsLocalNetworking`): solo para pruebas contra localhost.
- No solicita permisos de cámara, micrófono, contactos ni ubicación. El QR de WhatsApp se muestra,
  no se escanea. Si el usuario conecta WhatsApp, el servidor sincroniza los contactos de esa cuenta.
- Compartir: la extensión recibe el texto o enlace que el usuario comparte a propósito.

**Privacidad**
- `PrivacyInfo.xcprivacy` se incluye en la app y la extensión: UserDefaults propios (CA92.1) y del
  App Group (1C8F.1); nombre, correo, teléfono y contactos opcionales de WhatsApp, mensajes, fotos elegidas,
  audio y archivos elegidos, otro contenido del usuario, reportes de soporte, ID de cuenta, ID propio del dispositivo e interacción
  con el producto (lecturas, actividad y sesiones) y búsquedas de WhatsApp enviadas al servidor (los registros HTTP conservan la consulta), vinculados a la cuenta para funcionalidad, sin rastreo. Las fotos usan el selector del sistema; no se solicita
  acceso completo a la fototeca.
- Contenido de WhatsApp: solo lo ve el dueño.

**Inicio de sesión (guía 4.8)**
- Se conservan Google y Microsoft, además de correo/contraseña. Apple exime las apps de educación o
  empresa que requieren una cuenta educativa o empresarial existente. Como TieComs también permite
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
