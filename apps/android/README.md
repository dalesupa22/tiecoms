# TieComs para Android (nativa)

App nativa en Kotlin + Jetpack Compose (Material 3). No usa WebView ni Capacitor. Sigue las especificaciones comunes con iOS (`SPEC.md` y `SPEC-v2.md`): la navegación, los textos, los sonidos, los enlaces, la sincronización y el splash son los mismos en las dos apps y en la web.

| | |
|---|---|
| applicationId | `com.tiecoms.app` |
| minSdk / target / compile | 26 / 36 / 36 |
| Versión | `versionName 1.1.0`, `versionCode 3`. Sube el `versionCode` en cada envío a Play. |
| Contrato | `2026-09-23`. Se envía en `x-tiecoms-contract` y en `device.contract`. |
| API por defecto | `https://app.tiecoms.com` |
| Toolchain | Gradle 8.14.3 (wrapper), AGP 8.13.2, Kotlin 2.3.21 y JDK 17 |

## Qué hace

- **Pestañas:** Inicio · Asuntos · Agenda · Ajustes. WhatsApp, Trazo y Recordatorios se abren desde los accesos de Inicio y desde Ajustes.
- **Menú del mensaje** (pulsación larga; es el clic derecho de la web):
  - Responder, con la cita visible.
  - Copiar texto y copiar enlace.
  - Fijar o quitar de fijados, con la barra 📌 N.
  - Recordarme, con tiempos rápidos o fecha y hora.
  - Marcar como no leído desde aquí.
  - Derivar, abrir un asunto y agendar una reunión.
  - Reenviar a otra conversación de TieComs, por WhatsApp o por correo, o copiarlo para Slack o Teams.
  - Editar y eliminar, solo en los mensajes propios.
- **Menú de conversación** (pulsación larga en Inicio, o ⋯ en la cabecera):
  - Fijar arriba.
  - Marcar como leído o como no leído.
  - Silenciar por 1 h, 8 h, 1 semana o hasta reactivar.
  - Recordarme y agendar una reunión.
  - Copiar enlace y salir del grupo.
  - En los espacios también hay «Fijar arriba».
- **Asuntos:** filtros Míos, Abiertos y Cerrados, agrupados por espacio. El detalle trae estado, responsable, fecha, «esperando a <empresa>», origen, historial y comentarios. Cada conversación muestra sus «Asuntos aquí» y el contador en Inicio.
- **Trazo y bifurcaciones:** una barra de linaje en el chat (viene de…, derivó en…, «Devolver el resultado») y la pantalla Trazo. El resultado devuelto llega al origen como mensaje `mergedFrom`.
- **Agenda:**
  - Semana por días, con navegación entre semanas.
  - Crear y editar reuniones, con zona horaria e invitados, y cancelarlas.
  - Responder asistencia (RSVP).
  - Añadir la reunión al calendario del teléfono, a Google o a Outlook.
  - Tarjeta de la reunión dentro del chat, con RSVP.
- **Recordatorios:** la lista con Ahora y Próximos, Hecho y Posponer 1 h. El evento `reminder.due` genera una notificación local con `tc_notify`.
- **Reenviados:** la burbuja muestra «Reenviado desde WhatsApp · Juan · fecha» o «Reenviado desde «<conversación>»». Traer desde WhatsApp, Slack o correo (⤓ en el compositor) interpreta los chats exportados de WhatsApp y las cabeceras De/Asunto de los correos.
- **Chats entre personas** (✎ en Inicio → «Nuevo chat»):
  - Personas de `bootstrap.people` (solo humanas, sin mí) por empresa: «Tu equipo» primero, luego las demás por nombre y al final los terceros. Cada fila lleva foto o iniciales, el logo de la empresa, nombre y «cargo · área». Buscador por nombre, cargo, área o empresa (sin tildes) y chips con los elegidos.
  - Una persona abre su directo y varias crean un chat `multi` (`POST /chats {userIds, name?}`), con los logos de las empresas y un nombre opcional. Después se recarga `/bootstrap` y se abre el chat.
  - Sin nombre, el título son los primeros nombres («Mateo, Ana, Laura y 2 más»). Subtítulo «Chat grupal · empresas». En Inicio van con los directos (sección «Chats») con caritas apiladas.
  - Detalles: cargo · área · empresa de cada persona; en un `multi`, «Agregar al grupo» (`history: now`) y «Salir del grupo».
- **Vista previa de enlaces:** los enlaces del texto son tocables (`LinkAnnotation`, sin la puntuación final) y, cuando llega `message.updated` con `linkPreview`, se pinta la tarjeta (miniatura pública `/api/v1/previews/…`, sitio, título y descripción). Se abre en Custom Tabs.
- **Reenviar a otro chat** (pulsación larga): hoja con buscador, hasta 10 chats y comentario opcional. Por destino, primero el comentario y luego el original con `forwarded {source: tiecoms, author, sentAt, fromConversationId}`, todo por la cola persistente (un `clientMessageId` por envío).
- **Perfil** (Ajustes → Editar perfil): nombre, cargo y área (`PATCH /me`); foto con el Photo Picker del sistema, con orientación EXIF, recorte al centro a 512×512 JPEG (`POST /me/avatar`, máx. 3 MB) y «Quitar foto». Las fotos se ven en todos los avatares, con las iniciales de respaldo. El cargador es propio (`platform/ImageLoader`): LRU en memoria y caché HTTP de OkHttp en disco.
- **Archivos** (Ajustes o el acceso de Inicio): «Mis archivos» y una raíz por espacio, con migas, buscador en todo el árbol, crear carpeta, subir (octet-stream + `x-file-type`, hasta 25 MB) y abrir con el enlace firmado. `drive.updated` recarga la carpeta abierta.
- **Compartir hacia TieComs:** es un destino `ACTION_SEND text/plain`. Se elige la conversación y el texto se envía con `forwarded`. El origen se detecta por el paquete de la app que comparte (WhatsApp, Slack, Teams, Gmail u Outlook); si no se reconoce, queda como `other`.
- **WhatsApp:**
  - Cuentas personal y Business, vinculadas con QR (imagen `data:` del API) o con código de 8 letras.
  - Re-vincular y desconectar.
  - Organizador por categorías, con búsqueda, filtro de grupos y ocultos.
  - Ver los mensajes, fijar u ocultar un chat y vincularlo a una conversación. El evento `whatsapp.updated` refresca la pantalla.
- **Empresa → Dominios** (solo owner o admin): listar, agregar y verificar con TXT. También se muestra el sello «Empresa verificada».
- **Eliminar cuenta:** `DELETE /api/v1/account {confirmEmail, password?}`. La pantalla explica qué se borra y qué se conserva. Responde 400 si el correo no coincide y 403 si la contraseña está mal o falta. Al terminar borra las credenciales locales y vuelve al login.
- **Seguridad de la comunidad:** los detalles de conversación permiten reportar y bloquear/desbloquear participantes; la pulsación larga permite reportar mensajes. El API guarda los reportes para revisión. El bloqueo oculta los mensajes del usuario y sus notificaciones y evita mensajes directos y nuevos chats entre las partes. Los grupos existentes siguen disponibles. El registro requiere aceptar los términos y la política de privacidad, accesibles también desde Login y Ajustes.
- **Login y registro:** «Continuar con Google / Microsoft» y «o con tu correo». En el registro, el SSO exige antes el nombre de la empresa (`org_name`) o usa la invitación (`org`). Los errores `sso_*` y `domain_claimed` usan los textos de la web.
- **Deep links:** `/c/<id>` (con `?m=<seq>` salta al mensaje), `/w/<id>`, `/invite/<token>`, `/signup?org=`, `/asuntos`, `/agenda`, `/trazo`, `/whatsapp`, `/ajustes` y `/share?text=`. Funcionan en los tres hosts con `autoVerify` y con el esquema `tiecoms://`. `tiecoms://auth/*` está reservado para el SSO.

### Splash «Un solo hilo» (SPEC-v2 §4)

- **Coreografía:** es una función pura del tiempo en `core/SplashChoreo.kt` (probada en la JVM) y se dibuja en un `Canvas` de Compose (`ui/Splash.kt`) a 60 fps. No usa GIF ni video.
- **Fases:** personas → hilo (Catmull-Rom + `PathMeasure`) → se amarra, con giro de 20° y háptico en t=1,02 → nace el logo, con pulso, 10 chispas, resorte naranja y tinta de izquierda a derecha → eslogan → salida.
- **Sonido:** `tc_splash` suena en t=0,30. Respeta el interruptor de Sonidos y el modo silencio.
- **Cuándo se muestra:** solo en el arranque en frío. Si el arranque en frío viene de un deep link, hay versión corta (salta a la fase 4 y dura 1,2 s). Un toque salta al final. Con las animaciones del sistema desactivadas, solo se funde el logo en 0,4 s.
- **Espera:** si la sesión todavía carga, un punto late bajo el eslogan hasta 6 s.
- **Reloj:** arranca en el primer fotograma fluido y cada fotograma avanza como máximo 50 ms. Si el hilo principal se traba, la animación no se salta fases.
- **Splash del sistema:** Android 12+ usa la SplashScreen API (fondo crema, o `#161413` en oscuro, con el ícono TC), que da paso al splash animado con un fundido de 150 ms.
- **Textos:** «Conecta humanos, empresas y bots» / «Cada empresa. Cada canal.» / «**Un solo hilo.**». En inglés: «Connects humans, companies & bots» / «Every company. Every channel.» / «One thread.».

### Sonidos y avisos

| Sonido | Cuándo suena |
|---|---|
| `tc_splash` | Splash en frío |
| `tc_send` | El servidor confirmó el mensaje (y háptico ligero al pulsar Enviar) |
| `tc_receive` | Mensaje en la conversación abierta |
| `tc_notify` | Otra conversación, recordatorio vencido, reunión nueva/movida/cancelada (si te invitaron y no la organizaste) |

- En primer plano el sonido lo pone SoundPool y la notificación sale en silencio. En segundo plano la notificación usa el canal «Mensajes».
- Las conversaciones silenciadas no suenan ni notifican.
- Los eventos de catch-up no suenan: solo cuenta lo creado después de que la conexión quedó en vivo.

## Estructura

```
app/src/main/java/com/tiecoms/app/
  core/            Kotlin puro (JVM): DTO tolerantes, eventos, Socket.IO propio, cliente, SSO/PKCE, deep links,
                   SplashChoreo (coreografía), Bring (interpretar WhatsApp y correo)
  platform/        Keystore (refresh token), SharedPreferences, SoundPool, notificaciones, PushRegistrar
  ui/              AppRoot (pestañas y rutas), Splash, AuthScreens, HomeScreen, ConversationScreen, ChatDialogs,
                   IssuesScreens, AgendaScreens, MoreScreens (Trazo, Recordatorios, Compartir, Dominios, Eliminar cuenta),
                   WhatsAppScreen, OtherScreens (Detalles, Ajustes, Invitación), Widgets
tools/strings_v2.py  textos v2 (es/en) copiados de apps/web/src/i18n.ts → res/values{,-es}/strings_v2.xml
```

Hay unos pocos textos que la web todavía no tiene: dominios, eliminar cuenta, «Calendario del teléfono» y los avisos de reunión. Están marcados como «nativo» en `tools/strings_v2.py`, para copiarlos igual en iOS.

## Compilar

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
echo "sdk.dir=/opt/homebrew/share/android-commandlinetools" > local.properties   # no se commitea
./gradlew :app:assembleDebug
```

**Servidor en debug.** Mantén pulsado el logo en Login o usa `adb shell am start -n com.tiecoms.app/.MainActivity -e apiUrl http://10.0.2.2:3041`. El emulador ve el host en `10.0.2.2`. El HTTP sin cifrar se permite solo en debug.

## Probar

Nunca contra producción. El API de pruebas es `http://localhost:3041` (base `tiecoms_mobile`, con worker). El 3042 lleva la rama `account-deletion`. Los scripts de Node necesitan `node_modules`; `realtime-peer2.mjs` los toma de `NODE_ROOT`.

```bash
# 1. JVM: unitarias + integración en vivo (dos clientes reales A y B contra 3041) + eliminar cuenta contra 3042
API_URL=http://localhost:3041 FIXTURE_OUT=/tmp/fx.json node scripts/mobile-fixture.mjs
TIECOMS_FIXTURE=/tmp/fx.json TIECOMS_PEER_DIR=<carpeta con scripts/ y node_modules> TIECOMS_DELETE_API=http://localhost:3042 \
  ./gradlew :app:testDebugUnitTest

# 2. UI en el emulador (conviene -gpu host: con swiftshader y la máquina cargada, el splash se traba)
./gradlew :app:installDebug :app:installDebugAndroidTest
adb shell am instrument -w -e apiUrl http://10.0.2.2:3041 -e class com.tiecoms.app.SplashUiTest com.tiecoms.app.test/androidx.test.runner.AndroidJUnitRunner
FIXTURE=/tmp/fx.json API_URL=http://localhost:3041 NODE_ROOT=<carpeta con node_modules> node scripts/realtime-peer2.mjs &
adb shell am instrument -w -e apiUrl http://10.0.2.2:3041 -e email <a.email> -e password <password> -e conversationId <id> \
  -e class com.tiecoms.app.LiveUiTest com.tiecoms.app.test/androidx.test.runner.AndroidJUnitRunner
adb pull /sdcard/Android/data/com.tiecoms.app/files/   # splash-*.png, ui-*.png
```

- **v3** (chats `multi`, vista previa, perfil y archivos) necesita un API con almacenamiento y worker. Se probó con una base propia en el Postgres Docker (`tiecoms-sso-pg`, puerto 55432, base `tiecoms_android_v3`), el S3 falso de main (`node apps/api/test/fake-s3.mjs 59044`) y el API en el 3044 (`S3_BUCKET=local S3_ENDPOINT=http://localhost:59044 AWS_ACCESS_KEY_ID=x AWS_SECRET_ACCESS_KEY=y`, con `src/server.ts` y `src/worker.ts`). `V3DecodingTest` y `V3ApiContractTest` corren sin servidor.
- `TIECOMS_PEER_DIR` debe tener `scripts/` copiado (no enlazado) junto a `node_modules`: Node resuelve los módulos desde la ruta real del script.
- **`SplashUiTest`** usa UiAutomator con el reloj real; la regla de Compose usa un reloj virtual. En debug, las etiquetas de prueba se exponen como `resource-id`.
- **`LiveUiTest`** recorre login → pestañas → conversación → eco del par → pulsación larga → fijar («visto fijado: 1» del par) → editar («visto editado: …» del par) → compartir con `ACTION_SEND` → deep links → rotación.
- **App Links `https://`:** sin un `assetlinks.json` válido, Android 12+ abre Chrome. Para probar sin verificar: `adb shell pm set-app-links-user-selection --user 0 --package com.tiecoms.app true all`.

## Firmar

La firma de subida se lee del entorno o de `-P`, nunca del repo:

- `TIECOMS_UPLOAD_STORE=/Users/danny/Documents/EntreEmpresas/tiecoms/.secrets/android-upload.jks`
- `TIECOMS_UPLOAD_ALIAS=tiecoms-upload` (es el valor por defecto)
- `TIECOMS_UPLOAD_PASSWORD_FILE=/Users/danny/Documents/EntreEmpresas/tiecoms/.secrets/android_upload_password` (la misma contraseña sirve para el almacén y para la clave)

```bash
S=/Users/danny/Documents/EntreEmpresas/tiecoms/.secrets
TIECOMS_UPLOAD_STORE=$S/android-upload.jks TIECOMS_UPLOAD_PASSWORD_FILE=$S/android_upload_password ./gradlew :app:bundleRelease
jarsigner -verify app/build/outputs/bundle/release/app-release.aab
keytool -printcert -jarfile app/build/outputs/bundle/release/app-release.aab   # SHA256 12:2C:D6:…:F4:B7
```

El release lleva R8 y reducción de recursos. Las reglas de serialización están en `proguard-rules.pro`.

## Publicar en Google Play Console

1. **Crear la app.** Nombre «TieComs», idioma predeterminado español, gratuita.
2. **Play App Signing.** Google genera la clave de firma de la app. Se sube el AAB firmado con la clave de subida `tiecoms-upload`, cuyo SHA-256 es `12:2C:D6:DA:89:5C:D5:D6:39:55:D9:C4:0A:9A:89:80:41:51:94:98:59:A6:40:E9:29:A5:02:2D:13:41:F4:B7`.
3. **App Links.** Copia el **SHA-256 del certificado de firma de la app** desde Integridad de la app › Firma de apps y agrégalo a `sha256_cert_fingerprints` de `/.well-known/assetlinks.json` en los tres hosts, junto al de subida. Sin ese valor, los enlaces `https` abren el navegador. Las rutas nuevas (`/asuntos`, `/agenda`, `/trazo`, `/whatsapp`, `/share`, `/ajustes`) no requieren cambios en `assetlinks.json`, que cubre todo el dominio.
4. **Ficha de Play Store.**
   - Ícono: `play-512.png`, junto a este README.
   - Gráfico de funciones: 1024×500.
   - Categoría: Empresa. Contacto: soporte@tiecoms.com.

   Capturas sugeridas (teléfono, en español; en el scratchpad de pruebas hay versiones de referencia):
   1. Splash «Un solo hilo» (fotograma del logo con el eslogan).
   2. Inicio con los accesos y los espacios.
   3. Conversación entre dos empresas, con respuesta citada y mensaje reenviado desde WhatsApp.
   4. Menú de pulsación larga.
   5. Asuntos con estados.
   6. Agenda con la tarjeta de la reunión y el RSVP.
   7. WhatsApp organizado por categorías.
   8. Modo oscuro.

   Textos de la ficha:

   | Campo | ES | EN |
   |---|---|---|
   | Nombre | TieComs | TieComs |
   | Descripción corta | «Un solo hilo entre las empresas con las que trabajas.» | «One thread across the companies you work with.» |
   | Descripción completa | «TieComs conecta a personas, empresas y bots en un mismo lugar. Cada empresa conserva su identidad y cada persona ve solo su alcance. Conversa en espacios compartidos con clientes y proveedores; convierte mensajes en asuntos con responsable y fecha; agenda reuniones con confirmación; deriva una conversación para resolver algo aparte y devuelve el resultado; recibe recordatorios; trae mensajes desde WhatsApp, Slack o el correo con su origen; y organiza tus grupos de WhatsApp personal y Business. Cada empresa. Cada canal. Un solo hilo.» | «TieComs connects people, companies and bots in one place. Each company keeps its identity and everyone sees only their own scope. Talk in spaces shared with clients and suppliers; turn messages into issues with an owner and a date; schedule meetings with RSVPs; branch a conversation to solve something separately and bring the result back; get reminders; bring messages from WhatsApp, Slack or email with their origin; and organise your personal and Business WhatsApp groups. Every company. Every channel. One thread.» |

5. **Contenido de la app.**
   - **Privacidad:** `https://www.tiecoms.com/privacidad/`.
   - **Borrado de cuenta:** dentro de la app (Ajustes › Eliminar cuenta). Enlace web: `https://www.tiecoms.com/eliminar-cuenta/`.
   - **Anuncios:** no.
   - **IARC:** los usuarios interactúan entre sí y comparten contenido.
   - **Público:** mayores de 18.
   - **Seguridad de los datos:** nombre, correo, identificadores de usuario y dispositivo, mensajes y, de forma opcional, cargo/área, foto de perfil, archivos, reuniones, reportes, chats y contactos de WhatsApp de una cuenta conectada (sin permiso para acceder a la agenda del teléfono). Los datos viajan cifrados en tránsito. Declara los fines y la retención según la política publicada; el contenido compartido se muestra a los participantes autorizados.
   - **Cuenta demo para la revisión:** crea una cuenta en producción, por ejemplo `revision.play@tiecoms.com`, con una empresa y un espacio de ejemplo con otra cuenta demo de otra empresa. Pon las credenciales en «Acceso a la app». No uses las cuentas de prueba de 3041, que no existen en producción.
6. **Permisos y por qué:**

   | Permiso | Uso |
   |---|---|
   | `INTERNET` | API y tiempo real |
   | `ACCESS_NETWORK_STATE` | Reconectar al volver la red |
   | `POST_NOTIFICATIONS` | Mensajes, recordatorios y reuniones |

   No se usan cámara, micrófono, contactos ni ubicación. El QR de WhatsApp lo muestra la app; no se escanea con la cámara del teléfono.
7. **Pruebas internas.** Crea la versión, sube `app-release.aab` y agrega a los testers. Verifica login, SSO, envío, notificaciones, compartir desde WhatsApp y los enlaces `https`, que con la app de Play ya deberían verificar.

## Pendientes y puntos de extensión

- **Push remoto (FCM):** el backend aún no tiene registro de dispositivos. `PushRegistrar` / `NoopPushRegistrar` queda como punto de extensión. Mientras tanto, las notificaciones (mensajes, recordatorios y reuniones) son locales y solo llegan con el proceso vivo.
- **Backend de publicación:** eliminación de cuenta, reportes y bloqueo están integrados en `main` (`e679a10`) y verificados en producción el 24 de septiembre de 2026. El bloqueo de mensajes directos se aplica en el servidor, no solo en la interfaz.
- **SSO en vivo:** 3041 no tiene credenciales de Google/Microsoft y `/start` responde 503 `sso_unavailable` (controlado). El canje está probado con MockWebServer. Falta la prueba real en producción.
- **WhatsApp:** en pruebas no hay WhatsApp real. Los estados y la interfaz se probaron con el API (lista vacía) y con MockWebServer (cuentas, QR, chats, vínculo). Falta una prueba con una cuenta real.
- **Dominios:** falta la verificación real con DNS.
- **Gestión de miembros:** la web tiene más herramientas de administración (crear espacio o grupo, invitar, agregar o quitar miembros) que no se portaron en esta ronda.
