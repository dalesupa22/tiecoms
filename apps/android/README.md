# TieComs para Android (nativa)

App nativa en Kotlin + Jetpack Compose (Material 3). No usa WebView ni Capacitor. El comportamiento es el de la especificación común con iOS: navegación, textos, sonidos, enlaces y sincronización iguales en las dos apps.

| | |
|---|---|
| applicationId | `com.tiecoms.app` |
| minSdk / target / compile | 26 / 36 / 36 |
| versión | `versionName 1.0.0`, `versionCode 1` (súbelo en cada envío a Play) |
| contrato | `2026-09-23` (se envía en `x-tiecoms-contract` y en `device.contract`) |
| API por defecto | `https://app.tiecoms.com` |
| Toolchain | Gradle 8.14.3 (wrapper), AGP 8.13.2, Kotlin 2.3.21, JDK 17 |

## Estructura

```
app/src/main/java/com/tiecoms/app/
  core/          Kotlin puro, sin Android: se prueba en la JVM
    Models.kt            DTO con decodificación tolerante (TcJson: ignoreUnknownKeys, coerceInputValues, explicitNulls=false)
    Events.kt            eventos de conversación y de cuenta; un tipo desconocido, redacted o issue.updated solo avanza el cursor
    SocketIoProtocol.kt  parser y codificador de Engine.IO v4 / Socket.IO v5
    RealtimeSocket.kt    cliente propio sobre OkHttp WebSocket: latido, ACK, backoff con jitter de 0,5 a 30 s, 44 → refresh
    Http.kt              HTTP con los encabezados del contrato y errores ApiException / NetworkException
    TieComsClient.kt     sesión y refresh de vuelo único, bootstrap, cursores, catch-up por /events, cola persistente, idempotencia
    Sso.kt               PKCE S256, URL de inicio, lectura del callback; AUTH_BASE_PATH = "/api/v1/auth"
    DeepLink.kt, Names.kt
  platform/      Keystore (refresh token), SharedPreferences, SoundPool, notificaciones, PushRegistrar
  ui/            pantallas en Compose: Login, Registro, Inicio, Conversación, Detalles, Ajustes, Invitación
  TieComsApp.kt  contenedor de la app (una instancia por proceso), sonidos, notificaciones, SSO
  MainActivity.kt  singleTask, recibe enlaces en onCreate y onNewIntent
```

- **Sesión.** El refresh token se guarda cifrado con AES-256/GCM y una clave del Android Keystore. El access token vive solo en memoria. Las preferencias de sesión quedan fuera de los respaldos.
- **Envío.** Primero se pinta la burbuja ("Enviando…") y el mensaje se guarda en la cola en disco. Sale por socket con ACK (8 s). Si falla, va por `POST /messages` con el mismo `clientMessageId`. Un error 4xx definitivo (que no sea 401 ni 429) deja la burbuja en "No enviado · toca para reintentar".
- **Sonidos.** `tc_send` suena con la confirmación del servidor. `tc_receive` suena con un mensaje de otra persona en la conversación abierta. `tc_notify` suena con un mensaje en otra conversación, junto con una notificación local en el canal "Mensajes". No suenan los mensajes de sistema ni los que llegan por catch-up: solo cuentan los creados después de que la conexión actual quedó en vivo. Se respetan el interruptor de Ajustes y el modo silencio.
- **Idioma.** Español si el sistema está en español, inglés en cualquier otro caso (`values/` y `values-es/`). Cubre también el idioma por app de Android 13+.
- **Accesibilidad y robustez.** Hay `contentDescription` en iconos y filas, encabezados semánticos, textos en `sp`, modo oscuro y rotación sin perder estado (borradores con `rememberSaveable`, estado en el contenedor de la app).

## Compilar

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
echo "sdk.dir=/opt/homebrew/share/android-commandlinetools" > local.properties   # no se commitea
./gradlew :app:assembleDebug
```

**Servidor en debug.** Solo los builds debug permiten cambiar de servidor; el release siempre usa producción. Hay dos formas:
- mantener pulsado el logo en Login, o
- lanzar con el extra `apiUrl`:

```bash
adb shell am start -n com.tiecoms.app/.MainActivity -e apiUrl http://10.0.2.2:3021
```

El emulador ve el host en `10.0.2.2`. El HTTP sin cifrar se permite solo en debug y solo hacia `10.0.2.2`, `localhost` y `127.0.0.1` (`src/debug/res/xml/network_security_config.xml`).

## Probar

Nunca contra producción. El API de pruebas es `http://localhost:3021` (base `tiecoms_test`). Los scripts `scripts/mobile-fixture.mjs` y `scripts/realtime-peer.mjs` necesitan `node_modules` (socket.io-client).

```bash
# 1. Unitarias JVM: parser Socket.IO, decodificación tolerante, enlaces, SSO/PKCE con MockWebServer
./gradlew :app:testDebugUnitTest

# 2. Integración JVM contra 3021: login, bootstrap, ready, ACK, recepción en vivo < 2 s, catch-up, idempotencia
API_URL=http://localhost:3021 FIXTURE_OUT=/tmp/fx.json node scripts/mobile-fixture.mjs
TIECOMS_FIXTURE=/tmp/fx.json TIECOMS_PEER_DIR=<carpeta con scripts/ y node_modules> ./gradlew :app:testDebugUnitTest --tests '*LiveApiIntegrationTest*'

# 3. UI en el emulador (Compose UI test). Las credenciales van como argumentos, nunca en la app.
FIXTURE=/tmp/fx.json node scripts/realtime-peer.mjs &     # B responde "eco: …"
./gradlew :app:installDebug :app:installDebugAndroidTest
adb shell am instrument -w -e apiUrl http://10.0.2.2:3021 -e email <a.email> -e password <password> \
  -e conversationId <id> -e class com.tiecoms.app.LiveUiTest com.tiecoms.app.test/androidx.test.runner.AndroidJUnitRunner
adb pull /sdcard/Android/data/com.tiecoms.app/files/ui-02-final.png

# 4. Enlaces desde fuera de la app
adb shell am start -a android.intent.action.VIEW -d "tiecoms://c/<id>"
adb shell am start -a android.intent.action.VIEW -d "https://app.tiecoms.com/c/<id>"
```

Con el enlace `https://` hay que saber dos cosas:
- **Sin `assetlinks.json` válido, Android 12+ abre Chrome.** Así pasó en el emulador: verificación `1024`, que es "no verificado".
- **Para probar sin el dominio verificado** se puede simular que la persona eligió la app:

```bash
adb shell pm set-app-links-user-selection --user 0 --package com.tiecoms.app true all
```

## Firmar

La firma de subida se lee de propiedades de Gradle (`-P…`) o del entorno. Ningún secreto vive en el repo.

| Variable | Valor |
|---|---|
| `TIECOMS_UPLOAD_STORE` | `/Users/danny/Documents/EntreEmpresas/tiecoms/.secrets/android-upload.jks` |
| `TIECOMS_UPLOAD_ALIAS` | `tiecoms-upload` (valor por defecto) |
| `TIECOMS_UPLOAD_PASSWORD_FILE` | `/Users/danny/Documents/EntreEmpresas/tiecoms/.secrets/android_upload_password` (la misma contraseña para el almacén y la clave). También sirve `TIECOMS_UPLOAD_PASSWORD`. |

```bash
S=/Users/danny/Documents/EntreEmpresas/tiecoms/.secrets
TIECOMS_UPLOAD_STORE=$S/android-upload.jks TIECOMS_UPLOAD_PASSWORD_FILE=$S/android_upload_password ./gradlew :app:bundleRelease
jarsigner -verify app/build/outputs/bundle/release/app-release.aab
keytool -printcert -jarfile app/build/outputs/bundle/release/app-release.aab   # SHA256 12:2C:D6:…:F4:B7
```

El release lleva R8 y reducción de recursos. Las reglas de serialización están en `proguard-rules.pro`.

## Publicar en Google Play Console

1. **Crear la app.** Nombre "TieComs", idioma predeterminado español, tipo aplicación, gratuita. Acepta las declaraciones.
2. **Activar Play App Signing** (obligatorio para AAB):
   - Deja que Google genere la clave de firma de la app y sube este AAB, firmado con la clave de subida `tiecoms-upload`.
   - SHA-256 del certificado de subida: `12:2C:D6:DA:89:5C:D5:D6:39:55:D9:C4:0A:9A:89:80:41:51:94:98:59:A6:40:E9:29:A5:02:2D:13:41:F4:B7`.
3. **App Links.** En Configuración › Integridad de la app › Firma de apps, copia el **SHA-256 del certificado de firma de la app** (el de Google, distinto del de subida). Agrégalo a `sha256_cert_fingerprints` de `/.well-known/assetlinks.json` en `app.tiecoms.com`, `tiecoms.com` y `www.tiecoms.com`, junto al de subida (útil para builds instaladas por fuera de Play). Sin ese SHA-256, los enlaces `https://…/c/<id>` de la app instalada desde Play abrirán el navegador.

   ```json
   [{"relation":["delegate_permission/common.handle_all_urls"],
     "target":{"namespace":"android_app","package_name":"com.tiecoms.app",
       "sha256_cert_fingerprints":["<SHA-256 de Play App Signing>","12:2C:D6:DA:89:5C:D5:D6:39:55:D9:C4:0A:9A:89:80:41:51:94:98:59:A6:40:E9:29:A5:02:2D:13:41:F4:B7"]}}]
   ```

4. **Ficha de Play Store:**
   - ícono de 512×512: `play-512.png` (junto a este README);
   - gráfico de funciones de 1024×500;
   - al menos 2 capturas de teléfono;
   - descripción corta (80 caracteres) y completa;
   - categoría Empresa o Comunicación;
   - correo de contacto.
5. **Contenido de la app:**
   - Política de privacidad: URL pública, por ejemplo `https://tiecoms.com/privacidad`.
   - Acceso a la app: da credenciales de una cuenta de prueba para la revisión.
   - Anuncios: no.
   - Clasificación de contenido: cuestionario IARC. Es una app de comunicación entre usuarios, así que hay que declarar que los usuarios interactúan entre sí.
   - Público objetivo: mayores de 18.
   - Seguridad de los datos. Se recogen el nombre, el correo, los mensajes y un identificador del dispositivo. Todo va cifrado en tránsito, se puede solicitar el borrado y no se comparte con terceros.
   - Declaración de permisos: solo `POST_NOTIFICATIONS`, `INTERNET` y `ACCESS_NETWORK_STATE`.
6. **Pruebas internas.**
   - Crea una versión en Pruebas › Prueba interna, sube `app-release.aab`, añade la lista de testers (correos) y publica.
   - Instala desde el enlace de participación. Comprueba el login, el envío, las notificaciones y los enlaces `https` (con la app de Play ya deberían verificar).
   - Después pasa a prueba cerrada o producción.
7. **En cada nueva versión** sube `versionCode` en `app/build.gradle.kts`.

## Pendientes y puntos de extensión

- **Push remoto (FCM).** El backend aún no tiene registro de dispositivos. `platform/Notifier.kt` define `PushRegistrar` / `NoopPushRegistrar`, que solo guarda el token en local. Cuando exista el endpoint se añade `firebase-messaging` y se implementa `register()`. Mientras tanto, las notificaciones son locales y solo llegan con el proceso vivo (socket abierto).
- **SSO Google/Microsoft.** El cliente está completo: PKCE S256 con el verifier guardado en disco, Custom Tabs, retorno `tiecoms://auth/callback` y `POST $AUTH_BASE_PATH/sso/exchange`. Está probado con MockWebServer; falta probarlo en vivo cuando el backend publique `/auth/{google|microsoft}/start`. Si la ruta termina siendo `/api/auth`, basta con cambiar `AUTH_BASE_PATH` en `core/Sso.kt`.
- **Bifurcaciones e issues.** `parentId`, `openIssues` y `mergedFrom` se aceptan en los DTO. `issue.updated` se ignora pero avanza el cursor. No hay interfaz para ellos todavía.
