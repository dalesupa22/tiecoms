# Plan: MCP de chaggu para integraciones (Semillero CRM, Claude, ChatGPT)

Fecha: 3-oct-2026. Base revisada: `origin/main` en `f0f1c7a` (worktree
`tiecoms-agentes-lista`). Origen: la integración WhatsApp ↔ Semillero
(`xertifyapp/agente_crm`, `docs/whatsapp-chaggu.md`). Semillero ya llama
`POST /api/mcp` con el token personal de cada comercial para listar chats, leer
los vinculados a una cuenta y enviar con confirmación.

Objetivo: que cualquier integración (Semillero, el Claude o ChatGPT de cada
persona) trabaje con WhatsApp de forma **segura** (nunca cruza personas ni toca
lo personal), **completa** (no pierde notas de voz, direcciones ni teléfonos) y
**eficiente** (sin sondeos ni lecturas repetidas).

Cada ítem dice el problema visto en uso real, el cambio y cómo se acepta. El
orden es de prioridad; P0 desbloquea lo demás.

---

## P0. Seguridad y aislamiento

### 1. Tokens con permisos, vencimiento y nombre de la app
- **Problema:** un `chgmcp_` hoy puede todo lo que puede la persona y nunca
  vence (`modules/mcp.ts:56-70`, migración 080; OAuth anuncia un único scope
  `chaggu`). Si Semillero solo necesita leer chats vinculados y enviar con
  confirmación, no debería poder leer tickets ni escribir en grupos de chaggu.
- **Cambio:**
  - Scopes en `mcp_tokens` y en OAuth: `whatsapp:read`, `whatsapp:send`,
    `chats:read`, `chats:write`, `tasks:read`, `tasks:write`, `calendar`,
    `email`.
  - Columnas `expires_at` y `client_name` («Semillero», «ChatGPT»).
  - `tools/list` muestra solo las herramientas permitidas y `tools/call` responde
    `forbidden_scope`.
  - En Tú › Conector para IAs: crear el token con esas casillas y ver/revocar
    los tokens por app.
- **Acepta:** un token con solo `whatsapp:read` recibe `forbidden_scope` en
  `send_whatsapp` y no ve `create_task` en `tools/list`. Un token vencido da 401.

### 2. Número de WhatsApp «no compartir con integraciones»
- **Problema:** cada persona tiene número corporativo y personal en la misma
  cuenta de chaggu. `list_whatsapp_chats` devuelve los dos mezclados (familia,
  bancos, amigos), con vista previa del último mensaje. Semillero se protege
  con lista blanca, pero el dato ya salió de chaggu.
- **Cambio:**
  - `wa_accounts.integrations_enabled` (por defecto `true` para business y
    `false` para el personal), editable en la tarjeta de la cuenta, junto a
    «Responder desde chaggu».
  - Con token MCP: los números apagados no aparecen en `list_whatsapp_chats`,
    `read_whatsapp`, `find_client_channels` ni `send_whatsapp`.
  - Excepción por chat: «compartir este chat con integraciones», para un
    cliente que escribe al personal.
- **Acepta:** con el personal apagado, un token MCP no ve ningún chat de ese
  número. La app de la persona sigue igual.

### 3. Vista previa opcional en `list_whatsapp_chats`
- **Problema:** `preview` trae el texto del último mensaje de todos los chats,
  incluso los personales. Semillero no lo usa.
- **Cambio:** parámetro `include_preview` (por defecto `false` con token MCP).
- **Acepta:** sin el parámetro, `preview` no viene.

### 4. Bitácora de accesos por token
- **Problema:** la persona no sabe qué leyó o envió su asistente.
- **Cambio:** registrar `tools/call` (herramienta, chat, cantidad, sin
  contenido) por token y mostrarlo en Conector para IAs como «Semillero leyó 3
  chats hoy · envió 1 mensaje».
- **Acepta:** después de un `send_whatsapp`, aparece en la bitácora con fecha,
  chat y app.

---

## P0. Datos completos para el CRM

### 5. `read_whatsapp`: dirección explícita, tipo y rango
- **Problema:**
  - La dirección se deduce de `author == "Tú"` (`mcp.ts:333`).
  - Solo trae los últimos N, sin «desde» (`messagesForGg`, `whatsapp.ts:346-359`).
  - Salta los mensajes sin cuerpo.
  - Semillero relee 50 mensajes cada 30 minutos por chat vinculado.
- **Cambio:**
  - Campos `fromMe: boolean`, `kind` (`text|audio|image|video|document|sticker|location`),
    `senderPhone` (E.164 desde `wa_jid_alias` cuando se conoce) y
    `senderPushName`.
  - Parámetros `since` (ISO), `before` (cursor) y `kinds`.
  - Respuesta con `nextCursor` y `hasMore`.
- **Acepta:** `read_whatsapp {since}` devuelve solo lo nuevo, y cada mensaje
  trae `fromMe` y `kind` sin depender del idioma del autor.

### 6. Transcribir las notas de voz de WhatsApp
- **Problema:** buena parte de lo comercial llega por audio y en el MCP solo se
  ve «🎤 Nota de voz» (`wa-sync.ts:92`). Casos reales: Banco Coopcentral,
  Uniquindío, «Jose Espiritual». Para chaggu ya existe la transcripción
  (`worker.ts:55`, Inworld/DeepSeek), pero no se aplica a WhatsApp, cuyo medio
  se guarda solo como descripción.
- **Cambio:**
  - Para las cuentas con integraciones encendidas, descargar el audio `ptt`,
    pasarlo por el mismo worker y guardar `transcript` y `summary` en
    `wa_messages`.
  - `read_whatsapp` los devuelve en `text` (prefijo «🎤 (transcrito)») y en
    `transcript`.
  - Límite de duración y de costo por cuenta.
- **Acepta:** una nota de voz de un cliente aparece en `read_whatsapp` con su
  transcripción minutos después de llegar.

### 7. `list_whatsapp_chats`: paginación, teléfono y quién habló de último
- **Problema:**
  - Máximo 100 chats y el MCP descarta el cursor HMAC que ya existe
    (`whatsapp.ts:159-204`).
  - `unread_only` filtra después del límite.
  - No se ve el teléfono de un 1 a 1 (los `@lid` lo ocultan), así que Semillero
    empareja chat ↔ contacto solo por el nombre de la libreta.
- **Cambio:**
  - `cursor`/`nextCursor`.
  - `since` (actividad posterior a una fecha).
  - Campos `phone` (E.164 del 1 a 1 cuando se conoce), `lastMessageFromMe` y
    `lastMessageKind`.
  - `unread_only` aplicado en SQL.
- **Acepta:** Semillero recorre todos los chats con actividad desde una fecha
  y, para un 1 a 1, recibe `phone`.

### 8. Buscar un chat por teléfono, aunque el contacto no esté guardado
- **Problema:** César tiene leads que son solo un número («WhatsApp +57 323
  4418536»). `find_client_channels` por teléfono no encuentra chats con `@lid`.
- **Cambio:** herramienta `find_whatsapp_chat {phone}` que resuelve E.164 →
  chat por `wa_jid_alias`, contactos y chats, y devuelve `chat`, `name`,
  `pushName` y `lastMessageAt`.
- **Acepta:** con el número de un lead sin guardar, devuelve su chat y el
  `pushName` con que se presenta.

### 9. Metadatos de grupos
- **Problema:** con partners trabajamos en grupos («Sember Xertify», «Brasil x
  Xertify», «Roberto con Power») y el MCP no dice quién está en el grupo.
- **Cambio:** `get_whatsapp_group {chat}` con asunto, descripción y
  participantes (nombre, pushName, teléfono si se conoce y si es de mi
  organización). El dato ya existe (`participants`, `whatsapp.ts:142`).
- **Acepta:** devuelve los participantes de «Sember Xertify» con nombres.

---

## P1. Eficiencia: dejar de sondear

### 10. Webhook de mensajes de WhatsApp por token y lista de chats
- **Problema:** no hay evento de WhatsApp hacia afuera (`wa-sync.ts:143` solo
  avisa a los dispositivos), así que Semillero sondea cada 30 minutos.
- **Cambio:**
  - `POST /api/v1/me/integrations/webhooks {url, events, chats[]}`, ligado a un
    token con `whatsapp:read`.
  - Eventos `whatsapp.message.received`, `whatsapp.message.sent` y
    `whatsapp.message.transcribed`, firmados con HMAC como `integration-events.ts`.
  - Solo para los chats de la lista, que Semillero mantiene con los chats
    vinculados a una cuenta, y nunca para números con integraciones apagadas.
  - Reintentos con backoff.
- **Acepta:** un mensaje entrante en un chat vinculado llega a Semillero en
  segundos, y uno de un chat no listado no llega.

### 11. Buscar dentro del texto de mis WhatsApp
- **Problema:** `search_messages` solo cubre chats de chaggu (`mcp.ts:253`). Para
  un cliente hay que adivinar el nombre del chat.
- **Cambio:** `search_whatsapp {query, since, account}` con FTS sobre
  `wa_messages` (incluidas las transcripciones), solo en las cuentas propias
  con integraciones encendidas, devolviendo fragmento, chat y fecha.
- **Acepta:** `search_whatsapp "convenio secretaría del trabajo"` encuentra el
  chat de INFOP.

---

## P1. Enviar mejor (seguimientos casi automáticos y seguros)

### 12. Borradores para aprobar en el celular
- **Problema:** queremos que el CRM prepare los seguimientos del día y que la
  persona los apruebe rápido, sin que nada salga sin su sí.
- **Cambio:**
  - `create_whatsapp_draft {chat|phone, text, source, external_ref}` crea un
    borrador visible en chaggu, en la bandeja «Por enviar», con push.
  - La persona toca Enviar, Editar o Descartar.
  - Webhook `whatsapp.draft.sent|discarded` con `external_ref` para que
    Semillero registre el seguimiento.
  - `list_whatsapp_drafts` y `delete_whatsapp_draft`.
- **Acepta:** Semillero crea 10 borradores, la persona aprueba 7 desde el
  celular y Semillero recibe 7 `sent` y 3 `discarded`.

### 13. `send_whatsapp` idempotente y a un número nuevo
- **Problema:**
  - Un reintento después de un timeout (la herramienta espera unos 12 s) puede
    duplicar el mensaje.
  - No se puede escribir a un número sin chat previo.
  - Los errores llegan como texto.
- **Cambio:**
  - `idempotency_key` (único por token durante 24 h).
  - `phone` como alternativa a `chat`.
  - Errores con `code`: `not_connected`, `send_disabled`, `forbidden_scope`,
    `integrations_disabled`, `rate_limited`, `invalid_phone`.
- **Acepta:** dos llamadas con la misma llave envían un solo mensaje; con
  `phone` se crea el chat.

---

## P2. Agente @semillero y experiencia

### 14. El agente `semillero` como canal de avisos del equipo
Ya existe en producción (org Xertify, dueño danny@). Falta lo siguiente:
- Un token de agente con scope `chats:write` limitado a mensajes directos.
- Una plantilla de «resumen del día» (Follow up por persona) que Semillero envía
  por `send_direct_message`. Hoy ese resumen sale por Slack.
- Que la persona pueda responder «hecho, mañana» y le llegue a Semillero por
  `message.direct` (`agents.ts:109-135`).

### 15. Instrucciones del servidor
Agregar a las instrucciones del MCP:
- Leer solo chats de trabajo.
- Mostrar destinatario, número y texto exacto antes de cada envío.
- Preferir `create_whatsapp_draft` cuando haya más de un mensaje.

---

## Contrato con Semillero mientras tanto

Semillero ya funciona sin nada de esto (lista blanca, lectura de 50, `fromMe`
deducido de «Tú», sondeo cada 30 min). Cuando existan, usará:
- 5 (`since`, `fromMe`): sincronización incremental.
- 6 (transcripciones): las notas de voz cuentan como contacto con contenido.
- 7 y 8 (teléfono): emparejar por número y dejar de depender del nombre.
- 10 (webhook): «cliente espera respuesta» en tiempo real.
- 12 (borradores): seguimientos en lote aprobados desde el celular.
- 2 (integraciones apagadas en el personal): doble llave de privacidad.

---

## Estado (3-oct-2026, rama `mcp-integraciones`, migración 099)

Hecho en chaggu: 1 (scopes, vencimiento, app, Ajustes y aprobación OAuth), 2 (número y chat, más números por token), 3, 4 (bitácora y resumen del día), 5, 6 (transcripción automática en números/chats compartidos), 7, 8, 9 (participantes desde los metadatos del grupo; antes de que el puente reconecte, quienes han escrito), 10, 11, 12 (API, web «Por enviar» y push; falta la pantalla móvil), 13 y 15. Detalle en `docs/MCP.md`.

Pendiente (lado Semillero o de otra sesión): 14 (resumen del día por @semillero y su token solo-directos), la pantalla «Por enviar» en iOS/Android y adaptar Semillero a `since`, `phone`, webhooks y borradores.
