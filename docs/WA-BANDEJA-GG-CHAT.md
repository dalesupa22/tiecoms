# WhatsApp en la bandeja y «gg de este chat» (API + web, 1-oct-2026)

Implementa las partes A (web) y B del contrato común `docs/CONTRATO-GG-CHAT-WA-INBOX.md`. iOS y Android siguen el mismo contrato en sus ramas. Rama: `web-wa-gg`. Migraciones: **081** y **082**.

## A. WhatsApp en la bandeja

### Modelo (081_wa_inbox.sql)
- `wa_chats.inbox_place` ('groups' | 'dms' | NULL) e `inbox_pinned_at`. Si `inbox_place` es NULL, el chat solo sale en la pantalla WhatsApp.
- `wa_chats.pinned` es el fijado *dentro* de WhatsApp y no se toca.

### API
- `PATCH /api/v1/whatsapp/chats/:accountId/:jid` acepta además:
  - `inboxPlace: 'groups' | 'dms' | 'auto' | null`. 'auto' resuelve por `is_group`; null saca de la bandeja y desfija.
  - `inboxPinned: boolean`. true fija (si no estaba en la bandeja, aplica 'auto'); false desfija.
- `WaChatDTO` agrega `inboxPlace`, `inboxPinnedAt` y `accountStatus` (estado de la cuenta; distinto de 'connected' = fila atenuada).
- Bootstrap: `waInbox: WaChatDTO[]`. Trae los chats en la bandeja de cuentas no removidas y sin ocultar (máximo 300).
- Evento de cuenta `{ type: 'wa.inbox', chat }` a la dueña. Se emite:
  - al cambiar `inbox_*`;
  - al ocultar o mostrar un chat que está en la bandeja;
  - al leerlo (unread → 0);
  - cuando entra un mensaje a un chat de la bandeja (`storeMessages` en `wa-sync.ts`).
- El cliente reemplaza la fila por `accountId+jid` y la quita si `inboxPlace` es null o `hidden`.
  - `client-core`: `putWaInbox`, `setWaInbox` y `markWaInboxRead`.

### Web
- `home-order.ts`:
  - `waAsConversation(w)` convierte la fila en una `ConversationDTO` sintética (`id = wa:<acc>:<jid>`; `inboxPinnedAt` hace de `pinnedAt`). Así pasa por `compareConversations` y `withSeparators` sin tocarlos.
  - `waInboxFor(list, place)` separa por sección.
- `Groups.tsx` mezcla las filas en DmsList (`dms`), GroupsList (`groups`) y AllList (todas), con el mismo orden y los mismos separadores. Los chips de filtro aplican igual: un WhatsApp con no leídos sale en «Sin leer» y nunca en «Menciones».
  - En la vista Árbol, los de Grupos van en un bloque «WhatsApp» arriba, porque no son de ninguna empresa.
- `screens/WaInbox.tsx`:
  - `WaRow`: avatar con el logo verde de WhatsApp en la esquina; nombre; «WhatsApp · {cuenta}» en gris, o «WhatsApp desconectado» y la fila atenuada; contador verde; 📌.
  - Al hacer clic abre `/whatsapp/:accountId/:jid`. La fila se arrastra a la cuadrícula como `wa`.
  - Menú de la fila: Fijar / Quitar de fijados, Mover a Grupos / Mover a DMs, Abrir en WhatsApp y Sacar de mi lista principal.
- Pantalla WhatsApp: en el clic derecho y en el «⋯» de cada fila, y en el pie del detalle:
  - «Mover a mi lista principal», con el submenú A Grupos / A DMs y la sugerida marcada;
  - «📌 Fijar arriba» o «Quitar de fijados»;
  - «Sacar de mi lista principal» si ya está.
  - El detalle tiene además ⤢ para abrirlo a pantalla completa.
- Ruta nueva `/whatsapp/:accountId/:jid` (`router.ts` › `waChat`). La pinta `WaChatScreen` en `Panes.tsx`: cabecera con ‹, avatar, nombre, botón gg y ⋯ con el menú de la bandeja. La fila activa se resalta en la barra.
- i18n es/en: `wa.moveToInbox`, `wa.toGroups`, `wa.toDms`, `wa.pinTop`, `wa.inboxPin`, `wa.inboxUnpin`, `wa.removeFromInbox`, `wa.moveGroups`, `wa.moveDms`, `wa.disconnected`…
  - Ojo: `wa.pin` y `wa.unpin` ya existían para el fijado dentro de WhatsApp. Por eso el «unpin» del contrato es `wa.inboxUnpin`.

## B. gg dentro del chat

### Modelo (082_gg_side.sql)
`gg_side_messages` (hilo privado por persona y fuente, con `session`) y `gg_side_state` (sesión actual y caché del número del botón).

### API (`apps/api/src/modules/gg-side.ts`)
Fuente: `c:<conversationId>` o `wa:<accountId>:<jid>`.
- **Aislamiento:**
  - `c:` exige `conversationAccess(..., 'read')` y respeta `history_from_seq`; `wa:` exige `ownChat`. Si no, 404.
  - gg recibe los últimos 60 mensajes de texto de esa fuente, más los citados validados contra la misma fuente.
  - Los mensajes van entre `<<<MENSAJES_DEL_CHAT … >>>` y `<<<CITADOS … >>>`, y el prompt dice que son datos y no instrucciones.
  - Sin herramientas. Pide `response_format: json_object` al cliente DeepSeek de `assistant.ts` (`completeJson`).
  - La salida se valida y se normaliza: si el modelo se sale del formato, el cliente igual recibe la misma forma.
- **Consentimiento:** lo que usa IA (`open`, preguntar, `reply-for-me`, `suggest`) exige `users.ai_consent_at`; si falta, responde 403 `ai_consent_required`. Leer el hilo, `new` y `pending` no usan IA.
- **Endpoints:**

| Ruta | Respuesta |
|---|---|
| `GET /gg/side?source=` | `{ session, messages, pending }` |
| `POST /gg/side/open {source}` | `{ message }` con `extra.pending` (solo `messageId` válidos) y `followUps`; actualiza la caché |
| `POST /gg/side {source,text,quotedMessageIds?}` | `{ message, question }` (`question` es el mensaje del usuario guardado; es un campo extra) |
| `POST /gg/side/reply-for-me {source,tone?,quotedMessageIds?}` | `{ drafts }`: 3 borradores short/warm/action, y action puede traer `{kind,title,assigneeName,due}`. También queda como mensaje de gg en el hilo |
| `POST /gg/side/suggest {source,messageIds}` | `{ suggestions }`: de 2 a 6, sin repetir; los tipos inválidos se descartan; `forMessageIds` solo de la fuente. 404 si ningún id es de la fuente |
| `POST /gg/side/new {source}` | `{ session }` |
| `GET /gg/side/pending?sources=a,b` | `{ [source]: n }`, de la caché, sin IA |
| **Nuevo:** `POST /gg/side/pending/refresh {source}` | `{ source, pending, recalculated }` |

- `pending/refresh` recalcula con IA solo si hay mensajes nuevos de otra persona desde `pending_seen_seq` y pasaron más de 10 minutos. En WhatsApp, `pending_seen_seq` es el `sent_at` en ms.
- Límite de 30 llamadas por minuto por persona en los endpoints con IA.

### Web (`apps/web/src/screens/GgSide.tsx`)
- **`GgButton`:** las letras gg en un círculo oscuro con la chispa (`gg-mark-oscuro.svg`) y el número de la caché.
  - Va entre el nombre y la píldora existente del encabezado del chat de chaggu. No sale en el chat con gg ni en el sidechat incrustado.
  - En WhatsApp va en la cabecera de la pantalla completa y en la del panel de la cuadrícula (`PaneHead` con `extra`).
  - Al entrar llama `pending/refresh`.
- **`GgSidePanel`** (panel derecho; en el móvil es una hoja):
  - «Solo ve este chat · Solo tú ves esta conversación».
  - Saludo con pendientes, que se pueden tocar para saltar al mensaje, y chips de arranque: Responder por mí, Resúmeme, ¿Qué me falta responder?, ¿Qué acordamos?.
  - Siguientes preguntas como chips y las citas encima de la caja.
  - ⋯ › Nueva conversación / Abrir en gg.
  - Si no hay permiso, muestra el banner de siempre (`GgConsentBanner`) y arranca al autorizar.
- **Menú del mensaje:** se agregan «✨ Preguntar a gg» (cita el mensaje y abre el panel) y «Seleccionar»; no se quita nada.
- **Selección:** Shift+clic o el círculo junto al avatar. Sale el flotante «✨ Pedir a gg (N)», que abre `SuggestDialog`: casillas, «Hacer estas N» y «O pide lo que quieras…».
- **`ReplyForMe`:** sale junto a la caja cuando el último mensaje es de otra persona. Muestra 3 borradores (Corta, Cálida, Con acción) y chips de tono (Como yo, Más corto, Más formal, Otras).
- **Nada se ejecuta sin confirmar:**
  - Elegir un borrador lo pone en la caja con el rótulo «✨ Borrador de gg». Nunca envía.
  - La tarea abre `NewIssueDialog`, ya lleno con título, responsable por nombre y fecha (props nuevas `defaultAssigneeName` y `defaultDue`).
  - El recordatorio abre `ReminderDialog`, ya exportado, con `defaultNote` y `defaultDate`.
  - «Escribirle a X» abre su directo con el borrador guardado, sin enviar.
  - «Resumir» se pregunta en el panel.
- **WhatsApp:**
  - Elegir un borrador lo pone en la caja solo si la cuenta tiene «Responder desde chaggu» y está conectada. Si no, se copia al portapapeles.
  - Los recordatorios van a «Tú», porque reminders exige una conversación de chaggu.
  - La tarea abre el diálogo sin conversación, con la tarea personal por defecto.
- Se cierra el panel y queda «✨ Seguir con gg» sobre la caja.

## Pruebas
- API, contra Postgres propio en Docker (`chaggu-wa-gg-pg`, puerto 55481) y API en 3481:
  - `test/gg-side.test.ts` (10);
  - `test/whatsapp.test.ts` (24, 6 de ellos de la bandeja);
  - `test/assistant.test.ts` (11);
  - `test/gg.test.ts` (6, con `fake-mail.mjs` /llm y el worker);
  - `test/mcp.test.ts` y `test/chats.test.ts` (13).
- Web: `src/home-order.test.ts` (nuevo) y el resto de vitest (196 en total), más typecheck de contracts, client-core, api y web.
- Revisado en el arnés (`harness.html`), que ahora trae `waInbox` de ejemplo y respuestas fijas de `/gg/side/*`:
  - `?to=/grupos`;
  - `?to=/whatsapp/wa1/g1%2540g.us`;
  - `?to=/c/general`;
  - `?to=/c/dm-ana`;
  - `?consent=0` muestra el permiso y `?waoff=1` la cuenta desconectada.

## Pendiente / límites
- «Hacer estas N» con dos tareas abre un solo diálogo (el último), porque los diálogos no hacen cola. Tarea + recordatorio sí abren los dos.
- Los contadores del riel (Grupos/DMs) no suman los no leídos de WhatsApp de la bandeja, para no contarlos dos veces con el ícono de WhatsApp.
- Los mensajes de WhatsApp en la cuadrícula no tienen «Responder» citado: solo el texto va a la caja.
