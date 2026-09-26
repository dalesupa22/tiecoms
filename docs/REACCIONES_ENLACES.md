# Reacciones, emojis y enlaces (26-sep-2026)

Las mismas reglas en web, iOS y Android. Migración `021_reactions_links.sql`, contrato `2026-09-26`.
Todo es aditivo y opcional: un cliente viejo ignora los campos nuevos y sigue funcionando.

## Por qué

En los chats de trabajo se comparten muchos videos, artículos, TikToks, Reels y posts. La gente se satura y no
los vuelve a ver. Además, la mitad de los mensajes son «ok 👍» o «gracias», que ensucian el chat y suben los
no leídos. La solución tiene dos partes:

1. **Reacciones** que reemplazan esos mensajes: no cuentan como no leído, no editan el mensaje y al autor le
   llega un solo aviso agrupado. En una empresa, 👀 y ✅ pueden además crear o cerrar un recordatorio.
2. **Enlaces como biblioteca**: una tarjeta por plataforma, compacta cuando alguien comparte varios seguidos,
   la pestaña «Enlaces» del chat, «Ver después» personal, un resumen con IA bajo pedido y un correo semanal opcional.

## Reacciones

### Modelo

- `MessageDTO.reactions?: ReactionDTO[]` = `{ emoji, userIds[], external?: [{ name, source }] }`, en el orden de la
  primera reacción. `external` son reacciones que llegaron por el puente de WhatsApp (sin cuenta en Chaggu).
- Llegan en vivo con **`message.updated`** (el mismo evento de siempre). Por eso:
  - **no** suben `unread` (los no leídos cuentan mensajes, no eventos);
  - **no** cambian `editedAt`, así que el mensaje no aparece como «editado».
- Forma canónica: `normalizeEmoji()` del contrato quita los selectores de variación sobrantes y agrega U+FE0F
  donde hace falta (`❤` → `❤️`, `👍️` → `👍`). Los clientes nativos deben mandar esa misma forma. El servidor la
  vuelve a aplicar y rechaza con 400 lo que no sea **exactamente un** emoji.
- Hay un máximo de 20 emojis distintos por mensaje (`MAX_REACTIONS_PER_MESSAGE`). Pasado ese límite, el API
  responde 409. Sumarse a un emoji que ya está siempre se puede.
- Solo reacciona quien puede publicar en la conversación (`canPost`). Los mensajes de sistema, los eliminados y
  los que quedan fuera de mi historial no aceptan reacciones. Al eliminar un mensaje se borran sus reacciones.

### API

| Método | Ruta | Cuerpo | Respuesta |
|---|---|---|---|
| PUT | `/api/v1/messages/:id/reactions/:emoji` (emoji URL-encoded) | opcional `{ remindAt? }` (ISO) | `{ message, reminder?, closedReminderIds?, openIssueId? }` |
| DELETE | `/api/v1/messages/:id/reactions/:emoji` | — | igual |
| PUT | `/api/v1/organizations/:id/reaction-actions` | `{ reactionActions: boolean }` (solo owner/admin) | `{ reactionActions }` |

PUT y DELETE son idempotentes: repetir la llamada no duplica ni falla. No mandes `content-type: application/json`
sin cuerpo; en ese caso usa `{}`.

### Barra rápida

Estos son los emojis de la barra, en este orden: `QUICK_REACTIONS = ['👍', '❤️', '😂', '👀', '✅', '🙏']`.

- **Web**: al pasar el mouse sobre el mensaje aparecen ☺ (selector completo) y 👍 ❤️ 😂. En el menú del mensaje
  (clic derecho o ⋯) está «Reaccionar», con la barra y «Más emojis…». Los chips de las reacciones van debajo
  del mensaje; al tocar uno se pone o se quita mi reacción, y su título dice quién reaccionó («Laura (Xertify),
  Beto y Pedro · WhatsApp»).
- **iOS / Android**: al mantener presionado el mensaje aparece la barra rápida encima del menú, igual que en
  WhatsApp e iMessage, más «＋» para el selector completo. Los chips se ven debajo de la burbuja.

### Reacciones con acción (👀 y ✅)

Se aplican según la empresa de quien reacciona (`OrganizationDTO.reactionActions`, activas por defecto). Owner
y admin las apagan en Ajustes.

- **👀 «Lo reviso»** crea un recordatorio personal sobre el mensaje. El cliente manda `remindAt`: en web es
  en 3 horas, o mañana a las 9:00 si eso cae después de las 19:00. Sin `remindAt`, el servidor usa +3 h. Al
  quitar el 👀 se cancela ese recordatorio (`closedReminderIds`).
- **✅ «Hecho»** cierra todos mis recordatorios de ese mensaje y reemplaza mi 👀. Si el mensaje abrió un asunto
  que sigue abierto, la respuesta trae `openIssueId` y el cliente ofrece «¿Cerrar también el asunto?». El API
  **no** cierra el asunto por su cuenta.
- Los otros dispositivos de la persona reciben el evento de cuenta **`reminders.changed`** y vuelven a pedir
  `GET /reminders`.

### Avisos

- **Push** al autor (y solo al autor): un único aviso por mensaje en ventanas de 2 minutos, que sale unos 20 s
  después para juntar las reacciones que llegan casi a la vez. Respeta el silencio de la conversación y los bloqueos.
  - `type: "reaction"`, `category: "TC_MESSAGE"`, `collapseId: react-<messageId>`, datos `conversationId`, `messageId`.
  - Título: «Laura y Beto reaccionaron 🎉👏» / «Laura and Beto reacted 🎉👏». Cuerpo: «texto del mensaje».
  - Tocar el aviso abre la conversación en ese mensaje.
  - No cambia el globo del ícono: una reacción no es un mensaje.
- **Web**: si la conversación está cargada, el cliente compara la reacción que llega con la que tenía y avisa
  (`ClientNotice` `reaction`): un toast si estoy en otra pantalla, o una notificación del sistema si la pestaña
  no está a la vista.

### Emojis en el compositor

- Al escribir `:pal` aparecen hasta 8 sugerencias, con los códigos de GitHub (`:thumbsup:`, `:tada:`) y los
  nombres en el idioma de la persona («pulgar», «fiesta»). Enter o Tab inserta el emoji y Esc cierra la lista.
- **Web**: el botón ☺ del compositor abre el selector. Solo aparece con mouse; en pantallas táctiles el teclado
  ya trae emojis. El selector tiene búsqueda, recientes (guardados en este dispositivo), categorías y tono de piel.
- Un mensaje que es solo emojis (de 1 a 3) se muestra grande (`isJumbo`).
- El catálogo es `emojibase-data` (en web se carga bajo demanda). En iOS y Android se usa el del sistema.

## Enlaces

### Vistas previas

- Cada mensaje trae vista previa de hasta 3 enlaces en `MessageDTO.linkPreviews` (el primero sigue en
  `linkPreview` para los clientes viejos). Llegan después con `message.updated`, igual que antes.
- `LinkPreviewDTO` suma estos campos:
  - `kind`: `video | short | post | article | audio | image | doc | code | link`;
  - `provider`: `youtube | tiktok | instagram | x | linkedin | facebook | vimeo | spotify | google | github`;
  - `author`, que es el canal o la cuenta;
  - `durationSec`;
  - `linkId`, el id del enlace en la biblioteca, para «Ver después» y el resumen desde la tarjeta.
- El worker usa oEmbed oficial, así que no hacen falta credenciales, salvo en Instagram:
  - YouTube, TikTok, Vimeo, Spotify y X lo usan tal cual;
  - Instagram necesita `META_OEMBED_TOKEN` (un token de app de Meta, `APPID|CLIENTTOKEN`). Sin él, se lee la
    página con el agente de vistas previas de Facebook y, si solo devuelve «Instagram», no se muestra tarjeta.
- La duración de YouTube sale de la página: `itemprop=duration` o `lengthSeconds`, que están pasados los
  700 KB del HTML (`HTML_MAX` = 1 MB).

### Cómo se ven

La preferencia es personal por conversación: `ConversationDTO.linkPreviews`, que se cambia con
`PUT /conversations/:id/prefs { linkPreviews }`.

- **Grande** (por defecto): tarjeta con miniatura, plataforma, tipo, autor y duración. Los shorts y reels van en
  vertical. Debajo de la tarjeta: 🔖 Ver después · ✨ ¿De qué trata? · ◆ Asunto.
- **Compacta**: una línea con el ícono de la plataforma, el título y 🔖. Un mensaje con varios enlaces siempre se
  muestra compacto.
- **Ninguna**: solo el texto.
- **Grupo**: 3 o más mensajes seguidos de la misma persona en 10 minutos que son casi solo enlaces se muestran
  como «Laura compartió 5 enlaces», en compacto, con «Ver como mensajes». No se agrupan los que tienen
  reacciones ni el mensaje al que se está saltando.
- No hay reproducción automática.

### Biblioteca («Enlaces» en la barra del chat)

La barra del chat queda así: Fijados · Asuntos · Hilos · Agenda · **Enlaces**, con el conteo `ConversationDTO.linkCount`.

- Ruta: `GET /api/v1/conversations/:id/links?kind=all|video|social|article|doc|other&q=&before=&limit=`, que
  devuelve `{ links: LinkItemDTO[], hasMore }`, del más reciente al más viejo. El valor de `before` es el
  `createdAt` del último enlace que ya tienes.
  - `video` = video, short y audio; `social` = post y short; `doc` = doc y code; `other` = link e image.
  - `q` busca en la URL, el título, la descripción y el autor.
- Respeta mi historial: quien entra sin historial no ve los enlaces anteriores. Editar el mensaje reindexa sus
  enlaces, y el que sigue en el texto conserva su id (y mi «Ver después»). Borrar el mensaje los saca.

### «Ver después» (solo mío)

- `PUT /api/v1/links/:id/state { saved?, seen? }` devuelve el `LinkItemDTO` con `savedAt` y `seenAt`.
- `GET /api/v1/links/saved?state=pending|seen|all&before=` devuelve `{ links, hasMore, pending }`. Los
  pendientes son los guardados que aún no he visto.
- Abrir un enlace desde Chaggu lo marca como visto (`seen: true`), pero **solo para mí**: nadie ve quién abrió qué.
- Pantalla `/ver-despues` (web) con las pestañas Pendientes y Vistos. Por enlace: Ya lo vi, ¿De qué trata?,
  Ir al mensaje y ⏰ Recuérdame (esta tarde, mañana a las 9 o el viernes), que crea un recordatorio sobre el
  mensaje con `POST /reminders`.

### ¿De qué trata? (IA bajo pedido)

- `POST /api/v1/links/:id/summary { lang? }` devuelve `{ summary, basis: 'article' | 'description', lang }`.
- Artículos y páginas: se lee el texto (`<article>` o `<main>`, sin navegación ni scripts). Con menos de 600
  caracteres, o si es video, red social o audio, se resume el título y la descripción, y el cliente muestra
  «Según la descripción». No se inventa lo que el video no dice.
- Se hace con DeepSeek (`DEEPSEEK_API_KEY`). Sin llave, el API responde 503 `ai_unavailable`.
- Se guarda en caché por URL e idioma (`link_summaries`): la segunda persona que lo pide ya no paga la llamada.
  El límite es de 20 resúmenes por minuto por persona.

### Resumen semanal por correo (opt-in)

- Se activa en Ajustes → «Enlaces y reacciones» (`PATCH /me { linkDigest }`; en bootstrap llega como `me.linkDigest`).
- Llega los lunes desde las 13:00 UTC (8:00 en Colombia), como mucho uno cada 6 días (`users.link_digest_sent_at`).
- Incluye los enlaces que compartieron **otros** en los últimos 7 días, por conversación (sin las conversaciones
  silenciadas), y hasta 5 pendientes de «Ver después». Si no hay nada, no se envía.
- Los dominios en `MAIL_SUPPRESS_DOMAINS` (demo, example) nunca reciben correos.

## WhatsApp

- Las reacciones de los chats de WhatsApp (`reactionMessage`) se guardan en `wa_messages.reactions` y se ven en
  `/whatsapp` (`WaMessageDTO.reactions`).
- Si el chat está vinculado a una conversación de Chaggu, la reacción llega al mensaje reenviado como
  `external` («Pedro · WhatsApp»). Quitarla en WhatsApp la quita también en Chaggu.
- Por ahora el puente no manda reacciones de Chaggu a WhatsApp, porque hoy tampoco manda mensajes en ese sentido.

## Pendiente en iOS y Android

1. Chips de reacciones bajo la burbuja, y la barra rápida al mantener presionado, con 👀 y ✅ marcados si
   `reactionActions !== false`.
2. `PUT` y `DELETE` de `/messages/:id/reactions/:emoji`, con `normalizeEmoji` (portar la función del contrato)
   y actualización optimista.
3. Push `type: "reaction"`: abrir la conversación en `messageId`.
4. Evento de cuenta `reminders.changed`: volver a pedir los recordatorios.
5. Tarjetas con `kind`, `provider`, `author` y `durationSec`, hasta 3 por mensaje, modos grande, compacta y
   ninguna, y el grupo «X compartió N enlaces».
6. Botón «Enlaces» en la barra del chat, con la lista y los filtros; pantalla «Ver después», que puede ir en
   la pestaña «Tú»; y «¿De qué trata?».
7. En Ajustes: el resumen semanal y, para owner y admin, las reacciones con acción.
