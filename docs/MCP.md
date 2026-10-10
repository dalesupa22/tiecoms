# Conector MCP de chaggu

Claude, Codex, ChatGPT y otras IAs leen y escriben en chaggu como la persona, con sus mismos permisos.

- **URL:** `https://app.chaggu.com/api/mcp` (MCP Streamable HTTP sin estado, JSON-RPC por POST).
- **Entrar (recomendado):** OAuth 2.1 con PKCE y registro dinámico. La IA solo necesita la URL; abre `/autorizar-ia`, la persona entra con SU cuenta y aprueba (`apps/api/src/modules/mcp-oauth.ts`, migración 095). Cada token es de una persona y solo ve lo que ella ve.
- **Token manual:** en la app, *Tú › Conector para IAs › Crear token* (o `POST /api/v1/me/mcp-tokens`). Empieza por `chgmcp_`,
  se muestra una vez, se guarda solo el hash (tabla `mcp_tokens`, migración 080) y se revoca en la misma pantalla.
- **Herramientas:**
  - Chats de chaggu: `whoami`, `list_chats`, `read_messages`, `upload_chat_attachment`, `create_upload_link`, `send_message`, `send_direct_message`, `search_messages`, `unread_summary`, `mark_read`, `list_people`.
  - Programados de texto: `schedule_message`, `list_scheduled_messages`, `update_scheduled_message`, `cancel_scheduled_message`; WhatsApp: `schedule_whatsapp`, `list_scheduled_whatsapp`, `update_scheduled_whatsapp`, `cancel_scheduled_whatsapp`. Persisten en el servidor; no requieren dejar la IA ni la app abiertas. Ver [Programados](PROGRAMADOS.md) para fechas, recibos, permisos y límites.
  - WhatsApp (ver «Privacidad de WhatsApp» abajo): `list_whatsapp_numbers`, `list_whatsapp_chats` (cursor, since, teléfono, quién habló de último; vista previa solo con `include_preview`), `read_whatsapp` (`fromMe`, `kind`, teléfono, transcripción de notas de voz; `since`/`before`/`kinds`), `find_whatsapp_chat` (por teléfono, también `@lid`), `get_whatsapp_group` (participantes), `search_whatsapp` (texto y transcripciones), `send_whatsapp` (a `chat` o a `phone` nuevo, con `idempotency_key`; devuelve `outboxId` y, si ya salió, `messageId` = id de WhatsApp de `read_whatsapp`), `create_whatsapp_draft` / `list_whatsapp_drafts` / `delete_whatsapp_draft` (por aprobar en WhatsApp › Por enviar), `set_whatsapp_webhook` / `get_whatsapp_webhook` / `delete_whatsapp_webhook`.
  - Correo (Gmail/Outlook propio): `list_emails`, `read_email`, `reply_email`.
  - Tickets y tareas: `list_tasks`, `get_task`, `create_task`, `upload_task_attachment`, `update_task` (estado, responsables, fecha, título), `comment_task`.
  - Calendario: `list_calendar`, `create_event`, `update_event` (incluye cancelar), `rsvp_event`.
  - Responder al cliente: `find_client_channels` + prompt `responder_cliente`. Las instrucciones del servidor piden que, al resolver un ticket, la IA pregunte si responderle al cliente y por qué canal, y que nunca envíe sin confirmación. Chats y personas se nombran por id o por nombre.
- Código: `apps/api/src/modules/mcp.ts` (herramientas y permisos), `mcp-wa.ts` (WhatsApp), `mcp-oauth.ts`; pruebas: `apps/api/test/mcp.test.ts` y `mcp-integraciones.test.ts`. Plan de origen: `docs/PLAN-MCP-INTEGRACIONES-SEMILLERO.md`.

## Permisos por token (migración 099)

- Scopes: `chats:read`, `chats:write`, `whatsapp:read`, `whatsapp:send`, `whatsapp:draft`, `email`, `tasks:read`, `tasks:write`, `calendar`. `NULL` = todos (tokens anteriores). `tools/list` solo muestra lo permitido y `tools/call` responde `[forbidden_scope]`.
- Vencimiento (`expires_at`, 401 al vencer) y nombre de la app (`client_name`). Se eligen al crear el token en Tú › Conector para IAs o al aprobar en `/autorizar-ia` (la IA puede pedir scopes con `scope=`).
- Bitácora `mcp_audit` (herramienta, objetivo, cantidad, error; sin contenido): `GET /api/v1/me/mcp-activity` y el resumen «Hoy: leyó 3 · envió 1» en cada token. Se guarda 90 días.
- Errores de herramienta con código estable en `structuredContent.error.code`: `forbidden_scope`, `not_found`, `send_disabled`, `not_connected`, `integrations_disabled`, `invalid_phone`, `idempotency_mismatch`, `bad_request`.

## Mensajes programados (MCP 1.1.0)

Una solicitud como «mañana a las 10 am envíale a Ana por chaggu: Nos vemos en la reunión» se resuelve usando **la fecha actual y la zona horaria de la persona**. `whoami.server_time` aporta el instante actual UTC; no permite inferir su zona horaria. Antes de crear el programado, el asistente confirma destinatario, canal, texto y fecha/hora local exacta con su zona. Para WhatsApp también confirma el número emisor. Si faltan destinatario, texto o zona, los solicita; una frase de ejemplo no crea mensajes.

Creación: `schedule_message {chat | to, text, send_at, timezone, idempotency_key, reply_to?}` o `schedule_whatsapp {chat | phone, account?, text, send_at, timezone, idempotency_key}`. `chat`/`to` y `chat`/`phone` son excluyentes. `send_at` es ISO con offset explícito o `Z`; `timezone` es IANA (por ejemplo `America/Bogota`). El recibo conserva `id`, `channel`, `status`, `sendAt` UTC, `localSendAt` y `timezone`. Un mensaje **programado o en cola todavía no está enviado**.

Las listas muestran pendientes por defecto y permiten `status: "all"` para consultar el historial. La edición admite `text`, `send_at` + `timezone`, o solamente `timezone` para presentar el mismo instante en otra zona. La cancelación recibe el `id`. Crear/editar/cancelar en chaggu requiere `chats:write`; listar requiere `chats:read`. Todas las operaciones de WhatsApp programado, incluida la consulta de sus textos, requieren `whatsapp:send`. Cada token gestiona solo sus propias programaciones. La pérdida de acceso al destino oculta texto/destinatario y permite conservar un recibo mínimo para cancelarlo.

El endpoint y el mecanismo de acceso siguen iguales. `initialize.serverInfo.version` es `1.1.0`. El transporte sin estado sigue anunciando `listChanged: false`: los clientes deben volver a consultar `tools/list` o refrescar/reconectar su catálogo para descubrir las herramientas nuevas; no existe una notificación espontánea de cambio de catálogo.

## Imágenes y archivos en chats y tareas

Las herramientas reutilizan el almacenamiento, los adjuntos y las reglas de acceso del producto. Cada archivo admite **25 MiB decodificados**. El cuerpo JSON de `POST /api/mcp` admite 36 MiB para el base64; la autenticación se valida antes de leer ese cuerpo. Las demás rutas conservan sus límites.

1. `upload_chat_attachment {chat, name, content_type, data_base64, idempotency_key}` sube un archivo pendiente a un chat existente. Devuelve `{chatId, attachment}`; `attachment.id` es el identificador que se usa al enviar.
2. `send_message {chat, text?, attachment_ids?, reply_to?, idempotency_key?}` acepta texto, hasta 10 adjuntos propios pendientes del mismo chat, o ambos. Con adjuntos, `idempotency_key` es obligatoria. Los clientes de texto anteriores siguen funcionando. El resultado conserva `message` y añade `messageId` y `attachments` con sus IDs, nombres, MIME, tamaños y URLs del producto.
3. `read_messages {chat}` conserva `attachments: string[]` (nombres) y añade `attachment_details` con los metadatos de los adjuntos efectivamente asociados a cada mensaje. Se puede buscar `messages[].id === messageId` y comparar los IDs subidos.

Para tareas, `upload_task_attachment {id, name, content_type, data_base64, idempotency_key}` **sube y añade** un archivo a la tarea en una operación, sin reemplazar los actuales. Máximo 20 por tarea. Devuelve `{taskId, attachment, attachments}`. La lista se lee y se actualiza bajo el mismo bloqueo que las ediciones del producto; dos subidas concurrentes conservan ambos archivos. `get_task` y `list_tasks` incluyen `task.attachments`.

`comment_task {id, text, idempotency_key?}` y `update_task {id, status?, ..., idempotency_key?}` ya existían; ahora admiten reintentos sin repetir comentarios o cambios cuando se usa la llave. Los estados siguen siendo `open`, `in_progress`, `waiting`, `done` y `cancelled`. `get_task.activity` verifica comentarios y transiciones. Los comentarios de tickets siguen usando la integración del producto.

### Formato, permisos y reintentos

- `data_base64` debe ser base64 estándar canónico, sin espacios ni prefijo `data:`. No se aceptan URLs, rutas locales ni descargas por parte del servidor. La longitud se valida antes de reservar el buffer decodificado.
- Se comprueba el contenido de PNG, JPEG, GIF, WebP y HEIC/HEIF usando el detector de imágenes del producto; PDF requiere cabecera y cierre; texto plano/CSV/Markdown debe ser UTF-8 sin NUL; JSON debe parsear; ZIP requiere su firma. El MIME declarado debe coincidir. Videos MP4/MOV/WebM se reconocen por su contenedor y se guardan como `video/*` (se reproducen en línea). Cualquier otro archivo (Office, Illustrator, PostScript…) conserva su MIME real `application/*`, `font/*` o `model/*`, o `application/octet-stream`; el audio queda como descarga genérica. Siguen rechazados HTML, SVG, XML y JavaScript. No se procesan ni ejecutan los archivos.
- `upload_chat_attachment` y `send_message` requieren `chats:write`; `upload_task_attachment`, comentarios y estados requieren `tasks:write`. Se comprueba acceso a la conversación o visibilidad de la tarea, bloqueos y permiso de publicar. Una subida no permite usar archivos ajenos, de otra conversación, borrados o ya consumidos en otro mensaje.
- Usa una llave distinta para cada subida, envío, comentario o cambio. En un reintento usa **la misma llave y contenido con el mismo token**. Cambiar operación, destino o contenido produce `idempotency_mismatch`. La ventana garantizada es 24 horas, igual que la tabla MCP existente; después verifica el mensaje/tarea antes de repetir una operación.
- Efecto SQL y recibo se confirman en la misma transacción. Las subidas retienen un bloqueo de sesión por token/llave mientras escriben S3, **sin una transacción SQL abierta durante la red**, y vuelven a validar permisos antes de persistir. El objeto y el ID son deterministas: un fallo después de S3 y antes del commit se recupera escribiendo la misma ubicación, sin duplicar archivos. Un fallo sin reintento puede dejar un objeto sin fila, como una subida interrumpida del producto.
- Los reintentos vuelven a verificar acceso y que el recurso siga disponible, incluidos archivos de una sola vista, historial recortado y mensajes/adjuntos eliminados. Nunca reconstruyen un archivo borrado desde el recibo.

Ejemplo de secuencia (sustituir los IDs y el base64 por los reales):

```json
{"name":"upload_chat_attachment","arguments":{"chat":"CHAT_ID","name":"prueba.png","content_type":"image/png","data_base64":"BASE64_DEL_PNG","idempotency_key":"prueba-png-001"}}
{"name":"upload_chat_attachment","arguments":{"chat":"CHAT_ID","name":"prueba.pdf","content_type":"application/pdf","data_base64":"BASE64_DEL_PDF","idempotency_key":"prueba-pdf-001"}}
{"name":"send_message","arguments":{"chat":"CHAT_ID","text":"Adjuntos de prueba autorizados","attachment_ids":["PNG_ID","PDF_ID"],"idempotency_key":"prueba-envio-001"}}
{"name":"read_messages","arguments":{"chat":"CHAT_ID"}}
```

### Videos y archivos grandes: `create_upload_link` (10-oct-2026)

Un agente no puede pegar varios MB de base64 en una llamada. `create_upload_link {chat | task_id, name, content_type}` devuelve una URL de **un solo uso que vence en 15 minutos**; el agente sube los bytes crudos por stream, con los permisos del dueño del token:

```bash
curl -sS -X POST --data-binary @video.mp4 -H 'content-type: video/mp4' 'https://app.chaggu.com/api/mcp/uploads/TOKEN_ID/SECRETO'
```

- Chat (`chats:write`): un `video/*` va por la ruta de videos (hasta 150 MB, MP4/MOV/WebM, se reproduce en línea); otro archivo por la de archivos grandes (150 MB). La respuesta trae `attachment.id`, que se envía con `send_message`.
- Tarea (`task_id`, `tasks:write`): el archivo se agrega a la tarea (máximo 20). Los videos quedan como archivo descargable.
- El secreto solo se guarda como sha256 en `mcp_idempotency` (purga de 24 h). Un token revocado, vencido o de una cuenta desactivada invalida sus enlaces (404). Vencido: 410. Un reintento tras una subida exitosa devuelve el mismo adjunto sin volver a subir; una subida concurrente con el mismo enlace: 409.
- nginx: `^/api/mcp/uploads/<uuid>/<secreto>$` anidada en `/api/`, 151 MB sin buffer.

Pruebas: `apps/api/test/mcp-attachments.test.ts` (DM autorizado, PNG/PDF, asociación, permisos y concurrencia), `mcp-file-input.test.ts` (base64/tipos/tamaño) y `mcp-idempotency.test.ts` (transacciones, fallos y liberación de bloqueos). No requieren cambiar credenciales ni registros OAuth de Claude o ChatGPT.

## Privacidad de WhatsApp (doble llave)

1. **Número:** `wa_accounts.integrations_enabled` («Compartir con integraciones» en la tarjeta). Business encendido, personal apagado por defecto.
2. **Token:** `mcp_tokens.wa_account_ids`. `NULL` = los números compartidos; con lista = exactamente esos (la persona puede darle el personal a SU ChatGPT para encargos sin dárselo a Semillero). Los tokens que ya existían quedaron con todos los números de su dueño (para no romperlos).
3. **Chat suelto:** `wa_chats.integrations_shared` («🤖 Compartir con integraciones» en el panel del chat), aunque el número esté apagado.
Siempre aplican además el dueño de la cuenta y los chats bloqueados de WhatsApp (`wa-privacy.ts`). La app de la persona no cambia.

### Historial de un contacto con direcciones PN/LID

WhatsApp puede guardar parte de un contacto bajo su número (`@s.whatsapp.net`) y parte bajo uno o varios identificadores `@lid`. `read_whatsapp` reúne el historial del mismo contacto **dentro de una sola cuenta**, usando únicamente los aliases que cumplen individualmente las reglas de integración y Chat Lock. Compartir un alias no comparte sus demás direcciones ni habilita toda la cuenta.

- `find_whatsapp_chat`, `list_whatsapp_chats` y la búsqueda por nombre muestran un contacto por cuenta; cuentas diferentes y grupos siguen separados. La referencia representativa usa el PN si está permitido; de lo contrario, un alias permitido. Una referencia explícita `cuenta|jid` debe seguir autorizada y conserva ese JID para envíos, borradores y webhooks.
- `aliasCount` indica cuántas direcciones autorizadas reúne la vista. Nombre, fecha, vista previa y dirección/tipo del último mensaje se calculan solo con esos aliases. `unread` usa el máximo de los contadores del proveedor, evitando sumar dos veces el mismo contador replicado en aliases.
- `read_whatsapp` y `search_whatsapp` deduplican por ID de mensaje dentro del contacto y la cuenta. Si hay varias copias autorizadas, eligen la más reciente de forma determinista antes de aplicar filtros. El mismo ID en otro contacto, grupo o cuenta no desaparece.
- Cada página vuelve a comprobar permisos. Una revocación o Chat Lock puede reducir el historial disponible o hacer que la referencia deje de estar disponible. Los cursores nunca otorgan acceso.

Para recorrer todo el historial:

1. Hacia atrás: `read_whatsapp {chat, limit: 200}`. Mientras `hasMore` sea verdadero, repetir con `cursor: nextCursor`.
2. Hacia adelante: `read_whatsapp {chat, since: "2026-10-01T00:00:00Z", limit: 200}`. Continuar con `cursor: nextCursor`.

`before` y `since` siguen aceptando fechas ISO, con sus límites exclusivos anteriores. `nextBefore` y `nextSince` conservan ese formato para clientes que validan una definición anterior de la herramienta. El nuevo **`nextCursor` opaco versionado `wa1.…`** se reenvía en `cursor`, sin `before` ni `since`; conserva microsegundos, ID de desempate, dirección, `kinds` y el límite ISO opuesto. Es la forma recomendada para no perder mensajes que comparten fecha. Cambiar contacto, cuenta o filtros da `bad_request`; el tamaño de página puede cambiar. También se aceptan cursores en `before`/`since` para clientes que ya adoptaron ese formato. La paginación antigua por fecha conserva su limitación ante empates; actualizar el catálogo permite usar `cursor`.

La respuesta mantiene el orden de presentación cronológico: `since` avanza en orden ascendente; cada página hacia atrás contiene del más viejo al más nuevo entre los mensajes de esa página. Las notas de voz se encolan usando el JID real de cada mensaje. No se marca el chat como leído ni se modifica la sincronización de WhatsApp.

Pruebas: `apps/api/test/mcp-wa-history.test.ts`, con una base local aislada y un contacto sintético de **490 mensajes PN + 45 LID**; verifica los 535 IDs en ambos sentidos, permisos separados por alias/cuenta/persona, Chat Lock, duplicados, microsegundos, empates, filtros, búsqueda y transcripción.

## Notas de voz, avisos y borradores

- **Transcripción:** las notas de voz descargadas (`media_info.kind = voice`) de números o chats compartidos se transcriben solas (job `wa.transcribe`, escaneo cada minuto, últimos 3 días, tope `WA_TRANSCRIBE_DAILY_MAX`=300/día por cuenta y `WA_TRANSCRIBE_MAX_MS`=10 min). `read_whatsapp` también encola las que lea. Mismo proveedor que las notas de chaggu (Inworld + resumen DeepSeek).
- **Avisos al instante:** `set_whatsapp_webhook {url, chats, events}` por token, firmado como las integraciones (`x-chaggu-signature: t=…,v1=hmac`). Eventos `whatsapp.message.received|sent|transcribed`, `whatsapp.draft.sent|discarded`. Solo chats listados y aún compartidos (se revisa al entregar). Reintentos con backoff (job `mcp.webhook`, 8 intentos).
- **Borradores:** `create_whatsapp_draft` → WhatsApp › «Por enviar» (web) con push agrupado `wa.drafts`; Enviar (editable) o Descartar. Falta la pantalla en iOS/Android (el push llega, pero abre la app sin la lista).
- **Envío idempotente:** `idempotency_key` única por token 24 h (`mcp_idempotency`). `phone` crea el chat si no existe.

## Conectar

Claude Code (luego `/mcp` › chaggu › Authenticate):

    claude mcp add --transport http chaggu https://app.chaggu.com/api/mcp

Codex: `codex mcp add chaggu --url https://app.chaggu.com/api/mcp` y `codex mcp login chaggu`.

claude.ai / ChatGPT: conector personalizado con la misma URL.

Con token manual:

    claude mcp add --transport http chaggu https://app.chaggu.com/api/mcp --header "Authorization: Bearer chgmcp_…"

Codex (`~/.codex/config.toml`):

    [mcp_servers.chaggu]
    url = "https://app.chaggu.com/api/mcp"
    bearer_token_env_var = "CHAGGU_MCP_TOKEN"
