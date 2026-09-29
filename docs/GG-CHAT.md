# gg como chat y «Tú»

Pedido de Danny (29-sep-2026): escribirse a uno mismo, y que gg sea un chat siempre a mano, con la burbuja flotante y con @gg en cualquier chat.

## «Tú»
- Es un directo de la persona consigo misma: `dm_key` = `id:id`, con un solo miembro. Se crea al abrirlo (`POST /api/v1/me/notes`).
- Aparece fijo arriba en DMs. En el menú de cada mensaje hay «Guardar en Tú», que lo reenvía con su origen.
- gg también guarda ahí notas (`guardar_nota`) y recordatorios (`recordar`).

## gg
- gg es un participante bot único, con id fijo `0a9a9a9a-0000-4000-8000-000000000066` (`users.kind = 'agent'`, migración 041). Va en `bootstrap.people` y en `bootstrap.assistantId`.
- Su chat es el directo persona:gg (`POST /api/v1/assistant/chat`). El historial queda en el servidor.
- Escribir en ese chat, o `@gg` en cualquier chat, encola el trabajo `gg.reply` (`messages.sendMessage` → `gg.maybeQueue`). El worker llama a `assistant.respond` con los permisos de quien escribió y publica la respuesta como gg.
- **Permiso de IA:** `users.ai_consent_at`, que se da con `POST /api/v1/assistant/consent {on}` (banner «Autorizar gg» en su chat). Sin permiso, gg responde pidiéndolo. `bootstrap.me.aiConsent`.
- **@gg en un chat del equipo:** gg solo ve ese chat. Las herramientas se limitan a leerlo, sus tareas y reuniones, y notas o recordatorios de quien lo llamó (`SCOPED_TOOLS`), y cualquier `conversationId` se fuerza al del chat. Responde citando el mensaje. El prompt le prohíbe hablar de otros chats.
- **Acciones:** van en un mensaje de sistema `{k:'gg.actions', forUserId, actions, suggestions}`. Solo `forUserId` confirma: los tokens van firmados con su id. `POST /api/v1/assistant/run` con `messageId` y `actionId` guarda el nuevo estado en el mensaje (`message.updated`), y `POST /api/v1/assistant/actions/discard` descarta.
- **Web:** la burbuja flotante se ve siempre. Tocarla abre el chat con gg; mantenerla presionada es para hablarle (el panel de voz de siempre). También hay filas fijas «gg» y «Tú» en DMs y el aviso «gg está pensando…».

## Pruebas
`test/gg.test.ts` (API + worker, con DeepSeek falso en `/llm` de test/fake-mail.mjs) y `test/assistant.test.ts` (aislamiento).

## Pendiente
iOS y Android: filas fijas, tarjeta `gg.actions` y banner de permiso. Mientras tanto, las apps muestran gg como un directo normal y `gg.actions` como texto.
