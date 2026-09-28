# Admins de grupo e integraciones por grupo (28-sep-2026)

Rama `integraciones`, migración `030_group_admins_integrations.sql`. Todo lo nuevo en el contrato es **aditivo y
opcional**: un cliente debe tolerar que falte (servidor anterior) y el servidor no exige clientes nuevos.

## 1. Admins de grupo (como WhatsApp) — web, iOS y Android

### Contrato
- `ConversationDTO.adminIds?: string[]` — admins explícitos del grupo (orden de ingreso). Solo en `group`, `internal`, `multi`.
- `ConversationDTO.createdBy?: string` — quien creó el grupo.
- `canManage` (ya existía) sigue diciendo si **yo** puedo administrar. Es true si estoy en `adminIds` **o** si administro
  el espacio (lead/admin), aunque no aparezca en `adminIds`.
- Evento `members.changed` trae además `adminIds?: string[]`.
- `PUT /api/v1/conversations/{id}/members/{userId}/admin` con `{ "admin": true | false }` → `{ adminIds: string[] }`.
- Sacar: `DELETE /api/v1/conversations/{id}/members/{userId}` (ya existía).

### Reglas (las aplica el API; el cliente solo oculta lo que no se puede)
- Quien crea el grupo es admin. Un admin nombra o quita admins, suma y saca a cualquiera, **también a otros admins**.
- A quien creó el grupo (`createdBy`) **no se le quita el admin ni se le saca** (403). Él sí puede salir.
- Los terceros (`PersonDTO.guest`) y los bots (`PersonDTO.kind === 'agent'`) **no pueden ser admins** (400).
- Un admin puede dejar de serlo él mismo («Dejar de ser admin»), salvo quien creó el grupo.
- Nunca un grupo sin admin: si sale o deja de ser admin el último, el miembro más antiguo (no tercero, no bot) pasa a serlo.

### UI (información del grupo → Participantes)
- Junto al nombre: etiqueta **«Admin»** si está en `adminIds`, **«Bot»** si `kind === 'agent'`.
- Si `canManage`, al mantener presionado un participante (clic derecho / menú «⋯» en web): 
  - «Nombrar admin» (si no es admin, ni tercero, ni bot) — confirmación «¿Nombrar a {name} admin del grupo? Podrá sumar y
    sacar personas y nombrar otros admins.»
  - «Quitar como admin» (si es admin y no es `createdBy`) — «¿Quitarle el admin a {name}?»
  - «Quitar del grupo» (si no es `createdBy` ni bot).
- Sobre mí, si soy admin y no creé el grupo: «Dejar de ser admin».
- Tras la acción, refrescar el bootstrap (o aplicar `adminIds` de la respuesta).

### Mensajes de sistema nuevos (`{"k": …}`)
| k | es | en |
|---|---|---|
| `admin.added` | {name} ahora es admin del grupo. | {name} is now a group admin. |
| `admin.removed` | {name} ya no es admin del grupo. | {name} is no longer a group admin. |
| `integration.added` | Se conectó la integración «{name}». | The “{name}” integration was connected. |
| `integration.removed` | Se desconectó la integración «{name}». | The “{name}” integration was disconnected. |

## 2. Integraciones por grupo (API + web; en las apps solo se ve el bot)

Las crea, rota y revoca quien administra el **espacio** (lead/admin) o la **empresa** dueña (owner/admin). Los admins del
grupo las ven sin secretos. Cada integración publica como un participante bot (`users.kind = 'agent'`).

| Qué | Cómo |
|---|---|
| Crear | `POST /api/v1/conversations/{id}/integrations` `{ name, outgoingUrl? }` → `IntegrationSecretDTO` (token y secreto **una vez**) |
| Listar | `GET /api/v1/conversations/{id}/integrations` → `{ integrations, canConfigure }` |
| Editar | `PATCH /api/v1/integrations/{id}` `{ name?, outgoingUrl?, rotateOutgoingSecret? }` |
| Rotar token | `POST /api/v1/integrations/{id}/rotate` |
| Revocar | `DELETE /api/v1/integrations/{id}` (el bot sale; mensajes y asuntos quedan) |

### Webhook entrante (formato Slack)
`POST https://app.chaggu.com/api/hooks/{id}` con `Authorization: Bearer chg_…`, o `POST …/api/hooks/{id}/{token}` para
sistemas que solo aceptan una URL. Cuerpo igual al de un Incoming Webhook de Slack: `text`, `blocks` (header, section con
fields, context, divider, rich_text) y `attachments` (pretext, title, text, fields). El mrkdwn se pasa a texto plano.
`Idempotency-Key` opcional. Límite: 120 por minuto por integración. Para mensajes y comentarios, una llave queda ligada a la operación, al recurso y al contenido: reutilizarla con otro payload devuelve `409 idempotency_mismatch`. Las peticiones simultáneas con la misma llave se serializan; el cambio y su recibo se guardan en una sola transacción. Los recibos anteriores a la migración `031_integration_request_fingerprints.sql` conservan la respuesta guardada y no se vuelven a ejecutar (no es posible reconstruir su fingerprint histórico). Incluso un replay exige que el bot conserve acceso al grupo.

La importación por `(integración, externalId)` guarda asunto, vínculo de origen, historial, estado, anuncio y outbox de forma atómica. Repetir un `externalId` devuelve el asunto existente; para cambiarlo se usa PATCH. Un fallo intermedio no deja un asunto parcial que bloquee el reintento.

Los destinos de salida requieren HTTPS sin credenciales en la URL; se bloquean direcciones IP privadas, loopback y metadatos tanto al configurar como al entregar, y la resolución DNS se valida en cada conexión. `INTEGRATIONS_ALLOW_LOCAL=true` sólo se respeta fuera de producción para fixtures loopback. Las respuestas/error del receptor no se copian al log ni a `last_error`, porque pueden devolver secretos; se conserva el estado HTTP. Los logs del API y nginx redactan las rutas de webhooks con tokens (incluidos errores y referers); nginx mantiene estado y método en su log sanitizado.

### API de asuntos (token del grupo)
Base `https://app.chaggu.com/api/integration/v1`, `Authorization: Bearer chg_…`:
- `GET /me`
- `POST /messages` (igual que el webhook)
- `POST /issues` `{ title, externalId, description?, externalMeta?, status?, announce?, history? }` → `{ issue, created }`.
  Idempotente por `externalId`.
- `GET /issues?externalId=…`, `GET /issues/{id}` → `{ issue, events }` (con `actorName`, `actorIsBot`)
- `PATCH /issues/{id}` `{ status?, title?, externalMeta? }`
- `POST /issues/{id}/comments` `{ body, author? }`

### Webhook de salida
Si la integración tiene `outgoingUrl`, cada cambio de **estado** o **comentario** que hace una persona sobre un asunto de
esa integración se envía (POST JSON `IntegrationEventDTO`) con:
- `X-Chaggu-Event`: `issue.status_changed` | `issue.commented` | `issue.updated`
- `X-Chaggu-Delivery`: id único (sirve para deduplicar)
- `X-Chaggu-Signature`: `t=<unix>,v1=<hex(hmac_sha256(secreto, "<t>.<cuerpo>"))>`

Lo que hace el propio bot no se reenvía. Reintentos con backoff (hasta 10). Las entregas pueden llegar fuera de orden:
usar `createdAt` del evento.

## 3. Mesa de ayuda de Xertify → grupo «operaciones-xertify»
- Ticket = asunto; `externalId` = `ticket_number`; `externalMeta` = cliente, correo, categoría, prioridad.
- Estados: Por hacer ↔ `open`, En proceso ↔ `in_progress` (y `waiting`), Completado ↔ `done` (y `cancelled`).
- Comentario del cliente en Xertify → `POST /issues/{id}/comments` con `author`. Respuesta de soporte en Chaggu → evento
  `issue.commented` → comentario `origen: 'chaggu'` en el ticket y correo al cliente.

Revisión de acceso: quitar al bot del grupo impide nuevos webhooks salientes y descarta la entrega de los que estaban en cola cuando ya no tiene acceso. Los admins sólo del grupo ven únicamente el origen del destino de salida; el path/query potencialmente secreto queda reservado a quienes pueden configurar la integración.
