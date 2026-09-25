# Notificaciones push (APNs y FCM)

El API guarda un token por sesión (`PUT /api/v1/push/token`) y el **worker** envía una notificación por:

- cada mensaje de texto nuevo, a los participantes que no son el autor, que no tienen la conversación silenciada
  (`conversation_prefs.muted_until`), sin bloqueo con el autor, en todas sus sesiones activas con token;
- cada recordatorio vencido (`reminder.due`), a su dueño (aunque la conversación esté silenciada);
- cada convocatoria a una reunión (crear evento), a los invitados menos quien organiza, respetando el silencio.

Tokens que el proveedor rechaza (APNs 410 / 400 `BadDeviceToken` o `DeviceTokenNotForTopic`, FCM `UNREGISTERED`) se borran.
Otros fallos suben `push_subscriptions.failures` y guardan `last_error`. Cerrar sesión o revocarla borra su token.
Sin librerías externas: APNs por HTTP/2 (`node:http2`) con JWT ES256; FCM HTTP v1 con OAuth de cuenta de servicio (JWT RS256).
Código: `apps/api/src/push-transport.ts` (transporte) y `apps/api/src/modules/push.ts` (destinatarios y payload).

**No hace falta esperar la aprobación del App Store**: en TestFlight funciona en cuanto el servidor tenga la llave APNs.

## Contrato

```
PUT    /api/v1/push/token   { provider: 'apns'|'fcm', token, environment?: 'sandbox'|'production', lang?: 'es'|'en' }
DELETE /api/v1/push/token
```
`environment`: `production` en TestFlight/App Store (y siempre en Android); `sandbox` en compilaciones Debug de Xcode.
`lang` (o `Accept-Language`) solo afecta los textos que arma el servidor (recordatorios y reuniones).

APNs (tema `com.tiecoms.app`, `apns-push-type: alert`, prioridad 10, `apns-collapse-id` = id del mensaje):
```json
{ "aps": { "alert": { "title": "General", "subtitle": "Ana · Acme", "body": "texto ≤ 180" },
           "badge": 3, "sound": "tc_notify.caf", "thread-id": "<conversationId>", "category": "TC_MESSAGE", "mutable-content": 1 },
  "type": "message", "conversationId": "…", "messageId": "…", "authorId": "…", "authorName": "Ana", "authorAvatarUrl": "/api/v1/avatars/…" }
```
- Directos: `title` = autor, sin `subtitle`. Grupos, chats grupales y laterales: `title` = nombre del chat, `subtitle` = `autor · empresa`.
- `badge` = no leídos de la persona en conversaciones no silenciadas.
- `authorAvatarUrl` es una ruta relativa (como en los DTO) o vacía: la app antepone su URL base.
- Recordatorio: `type: "reminder"`, `category: "TC_REMINDER"`, `reminderId` (+ `messageId`). Reunión: `type: "event"`, `category: "TC_EVENT"`, `eventId`.

FCM: **mensaje de datos** (sin `notification`), `android.priority: high`, `collapse_key` = conversación. `data` (todo texto):
`type, title, subtitle, body, badge, threadId, category, conversationId, messageId, authorId, authorName, authorAvatarUrl` (y `reminderId`/`eventId`).

## Lo que debe crear Danny

### 1. Llave APNs (iOS)
1. developer.apple.com → **Certificates, IDs & Profiles → Keys → +**.
2. Nombre `TieComs Push`, marcar **Apple Push Notifications service (APNs)** (entorno: Sandbox & Production), **Continue → Register**.
3. **Download** el archivo `AuthKey_XXXXXXXXXX.p8` (solo se puede bajar una vez) y anotar el **Key ID** (10 caracteres).
4. En Identifiers → `com.tiecoms.app` confirmar que tiene **Push Notifications** activado (y crear el identificador
   `com.tiecoms.app.notifications` para la Notification Service Extension). Team ID: `B76US7H3L3`.
Guardar la llave en `tiecoms/.secrets/` (fuera de git), nunca en el repositorio.

### 2. Proyecto Firebase (Android)
1. console.firebase.google.com → **Agregar proyecto** (p. ej. `tiecoms`; se puede usar el proyecto GCP `tiecoms` existente).
2. **Agregar app → Android**, paquete `com.tiecoms.app`, SHA-1/SHA-256 del certificado de subida y de Google Play.
3. Descargar **`google-services.json`** → va en `apps/android/app/google-services.json` (fuera de git; ver README de Android).
4. Configuración del proyecto → **Cuentas de servicio → Firebase Admin SDK → Generar nueva clave privada** → JSON de la cuenta
   de servicio (tiene `project_id`, `client_email`, `private_key`, `token_uri`). Guardarlo en `tiecoms/.secrets/`.
   (La API "Firebase Cloud Messaging API (V1)" debe quedar habilitada; viene activa en proyectos nuevos.)

## Variables en el servidor (`/opt/tiecoms/shared/api.env`, permisos 600)

El contenedor solo monta `rds-ca.pem`, así que las llaves van **en línea** (una sola línea cada una):

```
APNS_KEY_ID=XXXXXXXXXX
APNS_TEAM_ID=B76US7H3L3
APNS_BUNDLE_ID=com.tiecoms.app
APNS_KEY=-----BEGIN PRIVATE KEY-----\nMIGT...\n-----END PRIVATE KEY-----
FCM_SERVICE_ACCOUNT={"type":"service_account","project_id":"…","private_key":"-----BEGIN PRIVATE KEY-----\n…","client_email":"…","token_uri":"https://oauth2.googleapis.com/token"}
```
- `APNS_KEY`: el contenido del `.p8` con los saltos de línea escritos como `\n`:
  `awk 'NF {printf "%s\\n", $0}' AuthKey_XXXXXXXXXX.p8`.
- `FCM_SERVICE_ACCOUNT`: el JSON compactado en una línea: `jq -c . cuenta-servicio.json` (los `\n` de la llave quedan escapados).
- Alternativa: `APNS_KEY_PATH` / `FCM_SERVICE_ACCOUNT_PATH` apuntando a archivos montados en el contenedor (habría que añadir el
  montaje en `infra/compose.yml`).
- Después: reiniciar **api** y **worker** (`docker compose up -d`). El worker escribe una sola vez en el log si falta la
  configuración de un proveedor; en ese caso los tokens se guardan pero no se envía nada.

Solo pruebas: `APNS_HOST` y `FCM_HOST` apuntan a servidores falsos (no se usan en producción).

## Pruebas
- `apps/api/test/push-transport.test.ts`: APNs (h2c) y FCM falsos en el mismo proceso; verifica las firmas ES256/RS256.
- `apps/api/test/feedback.test.ts`: contra el API + worker con `node test/fake-push.mjs 59044 59045`
  (`APNS_HOST=http://localhost:59044`, `FCM_HOST=http://localhost:59045`, llaves de prueba generadas localmente,
  cuenta de servicio con `token_uri=http://localhost:59045/token`): registro, envío, silenciadas, token inválido, globo,
  recordatorio y reunión.
- Push real de punta a punta requiere la llave APNs y el proyecto Firebase. En el simulador de iOS se puede probar el payload
  con `xcrun simctl push booted com.tiecoms.app payload.apns`.
