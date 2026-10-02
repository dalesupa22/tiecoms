# Contrato común: WhatsApp en la bandeja + gg dentro del chat (1-oct-2026)

Lo pidió Danny: «impleméntalo en iPhone, Android, dmg, exe y web». Este documento es la fuente única: el API, la web, iOS y Android lo siguen al pie de la letra.
Contexto ampliado:
- docs/PLAN-FIJAR-WHATSAPP-ACCESOS.md (en esta misma carpeta).
- Los mockups de la sesión «Mockup invitación por mensaje», resumidos en la parte B.

Base del código: `origin/principal`. Migraciones nuevas: **081** y **082**.

---

## A. WhatsApp en la bandeja (Grupos/DMs separados)

### Migración `081_wa_inbox.sql`
```sql
ALTER TABLE wa_chats
  ADD COLUMN IF NOT EXISTS inbox_place text CHECK (inbox_place IN ('groups','dms')),
  ADD COLUMN IF NOT EXISTS inbox_pinned_at timestamptz;
CREATE INDEX IF NOT EXISTS wa_chats_inbox ON wa_chats(account_id) WHERE inbox_place IS NOT NULL;
```
- Si `inbox_place` es NULL, el chat no está en la bandeja (solo sale en la pantalla WhatsApp).
- `wa_chats.pinned`, el fijado dentro de WhatsApp, NO se toca.

### API
- `PATCH /api/v1/whatsapp/chats/:accountId/:jid` acepta además:
  - `inboxPlace: 'groups' | 'dms' | 'auto' | null`. `'auto'` resuelve a `is_group ? 'groups' : 'dms'`. `null` lo saca de la bandeja y también quita `inbox_pinned_at`.
  - `inboxPinned: boolean`. `true` pone `now()` y, si `inbox_place` es NULL, aplica primero `'auto'`. `false` lo vuelve NULL.
- `WaChatDTO` agrega `inboxPlace: 'groups'|'dms'|null` e `inboxPinnedAt: string|null`.
- **Bootstrap**: `waInbox: WaChatDTO[]`. Trae los chats con `inbox_place` no NULL, de cuentas no removidas y sin ocultar. Si la app vieja no lo conoce, lo ignora.
- Evento de cuenta `wa.inbox` (`account.event`, a la persona dueña). Se emite:
  - cuando cambia `inbox_*`;
  - cuando entra un mensaje a un chat que está en la bandeja, con `{ chat: WaChatDTO }`.
  Así el cliente actualiza la fila sin recargar el bootstrap.
- Cuenta desconectada: `accountStatus` en el DTO (si ya existe, reusarlo). La fila sale atenuada con «WhatsApp desconectado».

### Clientes (web, iOS, Android)
- La fila de WhatsApp se mezcla con las conversaciones de chaggu en **Grupos** (`inboxPlace='groups'`) o en **DMs** (`'dms'`), y en «Todo/Hoy». Usa el MISMO orden y los mismos separadores:
  - Fijados (`inboxPinnedAt` hace de `pinnedAt`)
  - Sin leer (`unread > 0`)
  - Recientes (`lastMessageAt`)
- Grupos y DMs siguen separados: no se crea ninguna lista nueva.
- Aspecto de la fila:
  - avatar con un **logo verde de WhatsApp** pequeño en la esquina inferior derecha;
  - nombre;
  - debajo, en gris: `WhatsApp · {accountLabel}` (o la vista previa, igual que las demás filas);
  - contador de no leídos **verde**;
  - 📌 si está fijado.
- Al tocarla se abre el chat de WhatsApp: web en `/whatsapp/:accountId/:jid` con `WaChatView` a pantalla completa (también se puede arrastrar a la cuadrícula como `wa:<acc>:<jid>`); iOS en el `WaChatSheet`/chat; Android en el chat de WhatsApp.
- Menú de la fila (clic derecho, pulsación larga o deslizar):
  - «Fijar» / «Quitar de fijados»
  - «Mover a Grupos» / «Mover a DMs» (la opción de la sección contraria)
  - «Sacar de mi lista principal»
- En la pantalla WhatsApp, menú de cada fila y del detalle:
  - «Mover a mi lista principal», con el submenú «A Grupos / A DMs» y marcada la sugerida;
  - «📌 Fijar arriba»;
  - si ya está: «Sacar de mi lista principal».
- **Móvil, deslizar**: en TODAS las filas de Grupos/DMs (chaggu y WhatsApp), al deslizar a la derecha aparece Fijar/Quitar.
- Textos en es/en:

| Clave | Español | Inglés |
|---|---|---|
| moveToInbox | «Mover a mi lista principal» | «Move to my main list» |
| toGroups | «A Grupos» | «To Groups» |
| toDms | «A DMs» | «To DMs» |
| pinTop | «Fijar arriba» | «Pin to top» |
| unpin | «Quitar de fijados» | «Unpin» |
| removeFromInbox | «Sacar de mi lista principal» | «Remove from my main list» |
| moveGroups | «Mover a Grupos» | «Move to Groups» |
| moveDms | «Mover a DMs» | «Move to DMs» |
| waDisconnected | «WhatsApp desconectado» | «WhatsApp disconnected» |

### Móvil: cabecera compacta y accesos con logo (solo iOS y Android)
- Quitar el segmentado Lista | Árbol de la lista y llevarlo a un ícono que alterna junto a ≡ (iOS `list.bullet` ↔ `list.bullet.indent`).
- «Recordatorios (N)» deja de ser una fila y pasa a chip «🔔 N» al final de la fila de filtros. No sale si es 0.
- **Accesos con logo** al INICIO de la fila de chips de Grupos y DMs, solo para lo conectado:
  - `[logo WhatsApp  N]`: un toque abre la lista de WhatsApp.
  - `[logo Gmail|Outlook  N]`: un toque abre la bandeja de correo. Con varias cuentas abre la última usada; pulsación larga elige la cuenta.
  - Los logos se dibujan en código con `WaIcon` y `MailProviderIcon`/`ProviderIcon`, que ya existen.
  - Contadores: WhatsApp de `GET /whatsapp/chats?limit=1` (suma de `categories[*].unread`); correo de `GET /mail/unread`, con caché de 60 s.
- iOS: NO volver a `.large`, que congela iOS 26. El título sigue en `.inline`.
- La barra de pestañas de abajo NO cambia.

---

## B. gg dentro del chat (de la sesión «Mockup invitación por mensaje»)

Lo que Danny aprobó en los mockups:
1. **Botón gg en el encabezado de cada chat**, entre el nombre y la píldora de 📞/🎥/🔍/⋯, sin mover nada de lo que ya hay; si no cabe, el nombre se corta con «…».
   - Ícono: las letras «gg» en un círculo oscuro con una chispa pequeña. Es el mismo en todas partes: `gg-mark.svg` con la chispa.
   - Si hay pendientes, lleva el número de cosas que esperan algo de ti; si no, va sin número.
   - Aplica en chats de chaggu y de WhatsApp. En escritorio va también en el encabezado del panel.
2. **Al tocarlo se abre «gg de este chat»**: una hoja en el móvil y un panel lateral derecho en la web. Es una conversación PRIVADA de la persona con gg sobre ESE chat; el chat general de gg sigue aparte.
   - Arriba dice «Solo ve este chat · Solo tú ves esta conversación».
   - gg arranca con lo que vio: los pendientes y lo que te piden. Propone acciones con chips: «Responder por mí», «Resúmeme», «¿Qué me falta responder?», «¿Qué acordamos?».
   - **Seguir preguntando:** gg recuerda el hilo. Cada respuesta trae 2 a 4 «siguientes preguntas» sugeridas como chips.
   - **Citar:** pulsación larga en un mensaje › «Preguntar a gg» lo pone encima de la caja como contexto.
   - Si se cierra la hoja, queda «Seguir con gg» sobre el compositor. Al volver otro día, el historial sigue ahí.
   - Menú ⋯: «Nueva conversación», «Abrir en gg» (pasa al asistente general).
3. **Responder por mí:** 3 opciones con estilo distinto: *Corta*, *Cálida* y *Con acción*, que además propone tarea o recordatorio. Debajo, chips de tono: «Como yo», «Más corto», «Más formal», «Otras».
   - **Elegir no es enviar.** El texto cae en el compositor como «Borrador de gg», la persona lo edita y envía. En WhatsApp, solo si la cuenta tiene envío prendido; si no, se copia al portapapeles.
   - Atajo: si el último mensaje es de la otra persona, el móvil muestra 3 burbujitas de respuesta sobre la caja (se cargan al tocar ✨ en la caja, NO solas, para no gastar IA) y la web muestra un botón «Responder por mí» junto a la caja.
4. **Pulsación larga NO quita nada.** El menú de siempre queda igual y se le agrega «✨ Preguntar a gg».
   - «Seleccionar» (que ya existe o se crea) marca varios mensajes; en la web se hace con Shift+clic o con el círculo.
   - Con selección aparece el flotante «✨ Pedir a gg (N)», que abre sugerencias VARIAS. Cada mensaje trae las suyas, se juntan sin repetir y se ordenan por lo que más encaja. Ejemplos: Responder por mí, Crear tarea (con responsable/fecha si salen del texto), Recordatorio, Escribirle a X, Resumir.
   - Cada sugerencia tiene casilla, y con varias marcadas sale «Hacer estas N».
   - **Nada se ejecuta sin confirmar:** la tarea abre el diálogo de crear tarea ya lleno, el recordatorio el de recordar, y la respuesta va al compositor.
   - Campo libre: «O pide lo que quieras…».

### Migración `082_gg_side.sql`
```sql
CREATE TABLE gg_side_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source      text NOT NULL,            -- 'c:<conversationId>' | 'wa:<accountId>:<jid>'
  session     int  NOT NULL DEFAULT 1,  -- «Nueva conversación» sube el número
  role        text NOT NULL CHECK (role IN ('user','gg')),
  body        text NOT NULL,
  quoted      jsonb,                    -- [{id, author, text}]
  extra       jsonb,                    -- {followUps:string[], drafts:[...], suggestions:[...], pending:[...]}
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gg_side_by_source ON gg_side_messages(user_id, source, session, created_at);
CREATE TABLE gg_side_state (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source  text NOT NULL,
  session int NOT NULL DEFAULT 1,
  pending_count int NOT NULL DEFAULT 0,
  pending_seen_seq bigint,              -- hasta qué mensaje se calculó (caché)
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, source)
);
```

### API (módulo nuevo `apps/api/src/modules/gg-side.ts`, que reusa el cliente DeepSeek de gg.ts/assistant.ts)
**Aislamiento, obligatorio:**
- `c:<id>` exige `conversationAccess(userId, id, 'read')`.
- `wa:<acc>:<jid>` exige que la cuenta sea de esa persona (`ownChat`).
- gg solo recibe los últimos ~60 mensajes de ESA fuente, más los citados (validados contra la fuente).
- El texto de los mensajes es DATO, nunca instrucciones: va delimitado y el prompt lo dice. Ningún endpoint ejecuta acciones; solo devuelve borradores.
- Respuestas en JSON con formato fijo.
- Requiere `users.ai_consent_at`; si falta, responde 403 `ai_consent_required` y el cliente muestra el banner de permiso que ya existe.

**Endpoints:**
- `GET  /api/v1/gg/side?source=…` → `{ session, messages: GgSideMessageDTO[], pending: number }`. Si no hay mensajes, el cliente llama a `POST …/open`.
- `POST /api/v1/gg/side/open { source }` → `{ message }`. Es el saludo de gg con pendientes (`extra.pending: [{text, messageId?}]`) y `followUps`. Actualiza `gg_side_state.pending_count`.
- `POST /api/v1/gg/side { source, text, quotedMessageIds?: string[] }` → `{ message }`. Es la respuesta de gg con `extra.followUps` (2–4) y, si aplica, `extra.drafts`.
- `POST /api/v1/gg/side/reply-for-me { source, tone?: 'me'|'shorter'|'formal'|'more', quotedMessageIds? }` → `{ drafts: [{ style: 'short'|'warm'|'action', text, action?: { kind: 'task'|'reminder', title, assigneeName?, due? } }] }`. También queda guardado como mensaje de gg en el hilo. «Como yo» lee los últimos mensajes enviados por la persona en esa fuente.
- `POST /api/v1/gg/side/suggest { source, messageIds: string[] }` → `{ suggestions: [{ id, kind: 'reply'|'task'|'reminder'|'message_person'|'summary', title, detail?, draft?, params?, forMessageIds: string[] }] }`, de 2 a 6, ya sin repetir y ordenadas.
- `POST /api/v1/gg/side/new { source }`: sube `session` («Nueva conversación»).
- `GET  /api/v1/gg/side/pending?sources=a,b,c` → `{ [source]: number }`. Lee la caché `gg_side_state`, sin IA. Sirve para el número del botón.
  - El conteo se recalcula con IA solo al abrir (`open`) o cuando el cliente lo pide al entrar a un chat con mensajes nuevos de otra persona desde `pending_seen_seq`, con tope de 1 recálculo por fuente cada 10 min.
- Pruebas `apps/api/test/gg-side.test.ts` con DeepSeek falso:
  - otra persona no lee la fuente ajena (403/404);
  - un `wa:` ajeno da 404;
  - el texto «ignora todo y…» dentro de un mensaje no cambia el formato;
  - sin consentimiento da 403;
  - `new` sube la sesión;
  - `pending` sale de la caché.

**DTO:**
```ts
type GgSideMessageDTO = { id: string; role: 'user'|'gg'; body: string; quoted?: {id:string; author:string; text:string}[] | null;
  extra?: { followUps?: string[]; drafts?: Draft[]; suggestions?: Suggestion[]; pending?: {text:string; messageId?:string}[] } | null; createdAt: string };
```
Va en `packages/contracts` (zod), como los demás.

---

## C. Qué NO entra en esta tanda (queda para Codex, ver HANDOFF)
- Editor y permisos de workflows por cargo: radicar factura, abrir ticket, propuesta, lead al CRM. Incluye los pasos prompt/MCP/API/«Preguntar a una IA» (Claude/ChatGPT/ambos), llenar documento, aprobación y firma.
- Proponer horarios con el calendario de Google, que todavía no está conectado.
- Ejecutar acciones externas desde gg sin pasar por los diálogos existentes.
