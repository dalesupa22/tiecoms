# TieComs para iOS (nativo)

App nativa en SwiftUI (iOS 17+), sin WebView ni Capacitor y sin dependencias externas.
Se comporta igual que la app Android (especificación común: navegación, textos, sonidos,
enlaces y reglas de sincronización de `packages/client-core`).

| | |
|---|---|
| Bundle ID | `com.tiecoms.app` |
| Team | `B76US7H3L3` (CERTILABOR SAS), firma automática |
| Versión | 1.0.0 (build 1) — `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` en `project.yml` |
| Idiomas | es, en (inglés si el sistema no está en español) |
| API | `https://app.tiecoms.com` por defecto; `-TCApiURL <url>` al lanzar (pruebas) |

## Estructura

```
apps/ios/
  project.yml                 XcodeGen (fuente de verdad del proyecto)
  TieComs.xcodeproj           generado por XcodeGen (no editar a mano)
  TieComs/
    App/TieComsApp.swift      @main, AppDelegate (notificaciones, punto de extensión APNs)
    Core/
      Models.swift            DTO con decodificación tolerante; eventos desconocidos → .other (avanzan el cursor)
      SocketIOProtocol.swift  paquetes Engine.IO v4 / Socket.IO v5 (0/1/2/3/4x, ACK, namespaces)
      SocketIOClient.swift    WebSocket (URLSessionWebSocketTask): ping/pong, vigilancia, ACK, backoff 0,5→30 s con jitter
      APIClient.swift         HTTP, refresh de vuelo único, reintento ante 401, cierre de sesión si el refresh da 401
      AppStore.swift          estado observable: bootstrap, cursores, catch-up /events, resetRequired, cola persistente,
                              envío socket+ACK con respaldo HTTP (mismo clientMessageId), leído con debounce, escribiendo,
                              enlaces, ciclo de vida (primer plano / red)
      SSO.swift               Google/Microsoft: PKCE S256 + ASWebAuthenticationSession; AuthRoutes.base = "/api/v1/auth"
      Storage.swift           refresh token en Keychain (AfterFirstUnlockThisDeviceOnly), preferencias, cola en disco
      Feedback.swift          sonidos (.ambient), notificaciones locales con tc_notify.caf, PushRegistration (APNs, apagado)
      DeepLink.swift          https://{app.,www.,}tiecoms.com/{c,w,invite,signup} y tiecoms://… (tiecoms://auth/* reservado a SSO)
      L10n.swift, Naming.swift
    UI/                       Login, Registro, Inicio, Conversación, Detalles, Ajustes, Invitación, pantalla oculta de servidor
    Resources/                Info.plist (generado), entitlements, PrivacyInfo.xcprivacy, Assets (AppIcon 1024), Sounds/*.caf, es/en.lproj
  TieComsTests/               unitarias (paquetes, decodificación, sincronización, SSO con URLProtocol simulado) + integración
  TieComsUITests/             recorrido real: login → conversación → eco del par → deep links
```

## Compilar

```bash
cd apps/ios
/opt/homebrew/bin/xcodegen generate          # tras cambiar project.yml o añadir archivos
xcodebuild -scheme TieComs -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO build
```

Si hay dos simuladores con el mismo nombre, usa `id=<UDID>` (`xcrun simctl list devices`).
En simulador también compila con la firma normal ("Sign to Run Locally"), que es la que conviene
para probar: así el Keychain tiene `application-identifier`. El entitlement de Associated Domains
no impide compilar en simulador, así que hay una sola configuración.

Servidor en depuración: argumento `-TCApiURL http://localhost:3021`, o mantener pulsado el logo
del login (solo builds Debug) y escribir la URL (se aplica al reiniciar). `-TCResetSession YES`
borra la sesión guardada al arrancar (lo usa la prueba de UI).

## Probar

Nunca contra producción. API de pruebas en `http://localhost:3021` (base `tiecoms_test`).

```bash
cd <raíz del worktree>
API_URL=http://localhost:3021 FIXTURE_OUT=/tmp/fx.json node scripts/mobile-fixture.mjs   # A y B de dos empresas
FIXTURE=/tmp/fx.json PEER_TIMEOUT_MS=400000 node scripts/realtime-peer.mjs &             # par que responde "eco: …"

cd apps/ios
# Unitarias (sin red) — las de integración se omiten si no hay fixture
xcodebuild test -scheme TieComs -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -only-testing:TieComsTests

# Integración + UI: el fixture llega por el entorno del test runner (Xcode quita el prefijo TEST_RUNNER_)
TEST_RUNNER_TC_FIXTURE=/tmp/fx.json TEST_RUNNER_TC_PEER=1 TEST_RUNNER_TC_SHOTS=/tmp/shots \
  xcodebuild test -scheme TieComs -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
```

Las credenciales solo están en el JSON del fixture (contraseña aleatoria); nada va en el código.
El login del API tiene límite de 10/min por IP: las pruebas de integración comparten una sesión.

## Enlaces

- Esquema propio: `tiecoms://c/<id>`, `tiecoms://w/<id>`, `tiecoms://invite/<token>`, `tiecoms://signup?org=<token>`.
- Enlaces universales: `applinks:app.tiecoms.com`, `applinks:tiecoms.com`, `applinks:www.tiecoms.com`
  (entitlement en `TieComs/Resources/TieComs.entitlements`). El servidor debe publicar
  `https://<host>/.well-known/apple-app-site-association` con `appIDs: ["B76US7H3L3.com.tiecoms.app"]`
  y rutas `/c/*`, `/w/*`, `/invite/*`, `/signup*` (lo hace el coordinador). Hasta que el AASA exista
  y la app esté firmada con el App ID que tenga la capacidad, un enlace https abre Safari.
- `tiecoms://auth/callback` está reservado al SSO y el router lo ignora.

## SSO (Google / Microsoft)

`<base>/api/v1/auth/{google|microsoft}/start?platform=ios&device_id=…&code_challenge=…&code_challenge_method=S256`
en `ASWebAuthenticationSession` (callback `tiecoms`, sesión no efímera) → `tiecoms://auth/callback?code=…`
→ `POST <base>/api/v1/auth/sso/exchange {code, code_verifier, device}`. Si el backend mueve las rutas a
`/api/auth`, cambiar solo `AuthRoutes.base` en `Core/SSO.swift`. Probado con URLProtocol simulado
(el endpoint aún no existía en el API de pruebas).

## Push remoto

El backend todavía no recibe tokens de dispositivo. Punto de extensión en `Core/Feedback.swift`
(`PushRegistration`): activar la capacidad Push Notifications (`aps-environment`), poner
`enabled = true` y enviar el token al endpoint cuando exista. Mientras tanto hay notificaciones
locales mientras la app está viva (banner en primer plano solo si el mensaje es de otra conversación).

## Firmar y subir a App Store Connect — qué falta

1. **App ID** `com.tiecoms.app` en developer.apple.com (team B76US7H3L3) con la capacidad
   **Associated Domains** (y Push Notifications cuando exista el backend). Con firma automática
   Xcode lo crea si la cuenta está iniciada en Xcode › Settings › Accounts.
2. **App en App Store Connect**: "Nueva app" → iOS, nombre "TieComs", idioma principal español,
   bundle `com.tiecoms.app`, SKU (p. ej. `tiecoms-ios`).
3. Archivar y subir:
   ```bash
   xcodebuild -scheme TieComs -configuration Release -destination 'generic/platform=iOS' \
     -archivePath build/TieComs.xcarchive -allowProvisioningUpdates archive
   xcodebuild -exportArchive -archivePath build/TieComs.xcarchive -exportPath build/export \
     -exportOptionsPlist ExportOptions.plist -allowProvisioningUpdates
   xcrun altool --upload-app -f build/export/TieComs.ipa -t ios --apiKey <KEY_ID> --apiIssuer <ISSUER_ID>
   ```
   `ExportOptions.plist`: `method` = `app-store-connect`, `teamID` = `B76US7H3L3`, `signingStyle` = `automatic`.
   Para CI hace falta una clave de API de App Store Connect (.p8); no está en el repo.
4. **Ficha**: capturas 6,9" (iPhone 17 Pro Max, 1320×2868) y 13" iPad si se mantiene iPad
   (`TARGETED_DEVICE_FAMILY` = 1,2; quitar el 2 si no se publica para iPad), descripción, palabras clave,
   URL de soporte y de privacidad, categoría (Negocios / Productividad), clasificación por edad.
5. **Privacidad**: el manifiesto `PrivacyInfo.xcprivacy` declara UserDefaults (CA92.1) y datos
   vinculados sin rastreo (correo, nombre, contenido). Responder igual en "Privacidad de la app".
6. **Revisión**: la app requiere cuenta → dar a Apple una cuenta de demostración con una conversación.
   Si hay registro dentro de la app, Apple exige también **borrar la cuenta desde la app**
   (guía 5.1.1(v)): falta un endpoint en el API y el botón en Ajustes.
7. `ITSAppUsesNonExemptEncryption = false` ya está en el Info.plist (solo HTTPS del sistema).
8. ATS: `NSAllowsLocalNetworking` solo permite http a localhost/red local (pruebas); producción es https.
