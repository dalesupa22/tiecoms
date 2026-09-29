# Tanda 1.7: #grupos, avisos de tareas y eventos en el chat, búsqueda en el chat y mensajes de una sola vista

Pedido de Danny (29-sep-2026). Es la especificación común para API, web, iOS y Android: si algo no está aquí, se decide por lo que haga la web. La base del backend y de la web es la rama `llamadas-chime`, que ya incluye la 1.6.10 web. La migración nueva es la **037**.

Todos los mensajes de sistema nuevos llevan el cuerpo `{"k": clave, ...}`. Los clientes viejos muestran el texto de `sys.<clave>` que ya conocen. Para los que no conocen, hay que agregar los textos es/en en las tres plataformas.

## 1. Etiquetar un grupo con `#`

- **Escribir:** al escribir `#` en el campo de mensaje se sugieren las conversaciones que puedo ver: grupos, chats y directos, con el mismo buscador de «Mensaje nuevo». Al elegir una, el texto queda `#Nombre`.
- **Envío:** `SendMessageInput.refs` y `EditMessageInput.refs`: `[{ conversationId, start, length }]`, con un máximo de 20. El servidor comprueba que el **autor** pueda leer esa conversación y descarta las inválidas sin dar error, igual que las menciones. Guarda en `messages.refs` (jsonb) el nombre en ese momento. `MessageDTO.refs?: { conversationId, name, start, length }[]`.
- **Mostrar:** `#Nombre` va como una pastilla tocable del color del acento.
  - Si la persona tiene esa conversación en su lista (bootstrap), se abre al tocarla.
  - Si no la tiene, sale el aviso «No tienes acceso a #Nombre» y no navega. No hace falta un endpoint nuevo.
- **Para las integraciones:** la vista previa de la lista y los push usan el texto tal cual (`#Nombre`).

## 2. «Es hoy»: aviso de evento en el chat principal

- **Cuándo:** el worker revisa cada 15 s, en el mismo ciclo que `fireSoonEvents`. Un evento no cancelado cuya fecha de inicio es **hoy en su `timezone`**, y cuya hora local ya pasó las 07:00 (o ya empezó, si es antes de las 07:00), publica **una sola vez** el mensaje `sys('event.today', { eventId, title, startsAt, timezone })` en su conversación. Queda en la columna `calendar_events.today_posted_at`.
- **Cómo se ve:** los clientes lo dibujan como la **tarjeta del evento** (la misma de `event.created`), con el encabezado «📅 ES HOY · 3:00 p. m.» y los botones Unirse / Asistiré. Sin tarjeta, el texto es «Hoy: {title} a las {when}».
- **Sin avisos viejos:** los eventos creados el mismo día después de las 07:00 también lo publican, pero solo si faltan más de 10 minutos para que empiece. Si no, ya bastan `event.created` y «empieza en 10 min».

## 3. Tarea completada: mensaje con confeti

- **El mensaje:** cuando una tarea con `visibility = 'all'` pasa a `done`, el servidor publica `sys('issue.done', { issueId, title, byId, byName })` en su conversación. Si vuelve a abrirse y se cierra otra vez, publica otro.
- **Cómo se ve:** la tarjeta de la tarea en verde, con «✅ {byName} completó la tarea».
- **Confeti:** los clientes lanzan una animación de confeti de unos 1,2 s, solo cuando el mensaje llega **en vivo** mientras el chat está a la vista. No sale al cargar el historial. Una vez por mensaje y por dispositivo, y respetando «reducir movimiento».

## 4. Tarea vencida: «No cumplimos»

- **Cuándo:** el worker revisa cada minuto. Una tarea abierta (`status` distinto de done/cancelled) con `due_date` vencida publica **una vez por fecha límite** `sys('issue.overdue', { issueId, title, ownerId, ownerName, dueDate })` en su conversación, y lo guarda en `issues.overdue_posted_for` (date).
  - Vencida significa: la fecha es anterior a hoy en la zona de la organización, que por ahora es `America/Bogota`. Si la tarea tiene hora, cuenta la hora.
  - Si alguien cambia la fecha y esa nueva fecha también se vence, se vuelve a publicar.
- **Cómo se ve:** la tarjeta de la tarea en rojo, con la animación de carita triste 😢 (una sola vez, igual que el confeti) y el texto «No cumplimos: {title} venció el {fecha}».
- **Botones en la tarjeta:**
  - **Nueva fecha**, con un selector rápido: Hoy, Mañana, Próximo lunes o Elegir fecha. Hace `PATCH /issues/:id {dueDate}`.
  - **Marcar hecha.**
  - **Reasignar**, con un selector de persona que hace `PATCH {ownerId}`.
- **Además:** push al responsable con la categoría de tarea que ya existe.

## 5. Comentarios en tareas y eventos: aviso agrupado en el chat

- **Comentarios de eventos (nuevo):** tabla `calendar_event_comments` con los endpoints `GET/POST /events/:id/comments {body}`. `CalendarEventDTO.commentCount` y `lastComments` (los 2 últimos), igual que las tareas.
- **Cada comentario nuevo:** en una tarea visible para todos o en un evento, el servidor busca el último mensaje `issue.comments` o `event.comments` de ese elemento en la conversación.
  - **Si está entre los últimos 15 mensajes del chat:** lo **actualiza** con `message.updated` (cuerpo nuevo con `count` + 1 y `lastById`/`lastByName`/`lastExcerpt`), sin subir el contador de no leídos.
  - **Si no:** publica uno nuevo, `sys('issue.comments', { issueId, title, count: 1, lastById, lastByName, lastExcerpt })`, o su equivalente `event.comments` con `eventId`.
  - Así, varios comentarios seguidos no llenan la línea de tiempo.
- **Cómo se ve:** la tarjeta de la tarea o del evento, con la franja «💬 Comentario añadido» (o «💬 N comentarios nuevos», que se actualiza), el último extracto y «Responder» para comentar desde ahí.
- **Nota:** este aviso **sí cuenta como no leído** la primera vez, porque es un mensaje nuevo. Las actualizaciones no cuentan.

## 6. Buscar dentro del chat

- **API:** `GET /conversations/:id/search?q=&before=&limit=30` devuelve `{ results: [{ message: MessageDTO, snippet, matches: [[start,len]] }], hasMore }`.
  - Busca en el cuerpo de los mensajes de texto, sin importar mayúsculas ni tildes (`unaccent`, o `lower` + `translate` si no hay extensión).
  - También busca en los nombres de los adjuntos y en las transcripciones de las notas de voz.
  - Respeta `history_from_seq` y los mensajes borrados. Nunca muestra mensajes de una sola vista.
  - Mínimo 2 caracteres. Índice trigram si está disponible (`pg_trgm`); si no, `ILIKE` sobre `lower(body)`.
- **Cliente:** una lupa 🔎 en el encabezado del chat (en móvil también en el menú ⋯) abre una barra de búsqueda arriba.
  - Mientras se escribe, la búsqueda espera 250 ms.
  - Muestra «3 de 17» con ↑ ↓ para ir de resultado en resultado, salta al mensaje (reusando `ensureMessage`/`jumpTo`) y resalta lo que coincide.
  - En escritorio también hay una lista de resultados con autor, fecha y fragmento. Esc cierra.
  - Se puede filtrar por persona con `from:Nombre`. Si da problemas, se deja para después.

## 7. Mensajes de una sola vista (texto, fotos y notas de voz)

- **Envío:** `SendMessageInput.viewOnce: boolean`. Se aplica al texto, a las imágenes y a las notas de voz. No aplica a archivos ni reenvíos: si viene con otros adjuntos, responde 400.
  - Se guarda en `messages.view_once = true`.
  - No se puede editar, reenviar, copiar, fijar ni convertir en tarea. El servidor rechaza con 409 `view_once` los endpoints de reenviar, fijar, editar y crear tarea desde ese mensaje.
- **Cómo lo ven los demás:**
  - En `MessageDTO` para quien **no es autor**: `viewOnce: true`, `body: ''`, adjuntos sin `url` ni `thumbUrl` (con `kind` y `durationMs`), y `viewOnceState: 'unopened' | 'opened'` para esa persona.
  - Para el **autor**: `viewOnceState: 'sent'` y `openedBy: [{userId, at}]`. El autor tampoco ve el contenido después de enviarlo, igual que en WhatsApp: solo ve «📷 Foto · una vista · Visto por Ana».
- **Abrir:** `POST /messages/:id/open` devuelve **una sola vez por persona** `{ body, attachments (con URLs firmadas de 60 s) }`.
  - Registra `message_views (message_id, user_id, opened_at)`, emite `message.updated` (solo cambia el estado para el autor, sin mostrar contenido) y responde 410 `already_opened` la segunda vez.
  - Las URLs firmadas de esos adjuntos solo salen por este endpoint. El endpoint general de adjuntos responde 403 para archivos de una sola vista.
- **Cliente:**
  - Botón **①** en el campo de mensaje, que prende o apaga «una vista» para el próximo mensaje: se ve como un círculo con el 1.
  - El mensaje se muestra como una burbuja cerrada, «① Foto», «① Mensaje» o «① Nota de voz». Al tocarla se abre en pantalla completa y, al cerrarla, queda «Abierto».
  - En la notificación y la vista previa: «① Foto», «① Mensaje», «① Nota de voz», nunca el contenido.
  - **Móvil:** Android con `FLAG_SECURE` en el visor. iOS oculta el contenido si detecta captura o grabación (`UIScreen.capturedDidChange`) y avisa que se tomó una captura: queda para después si complica.
  - **Web:** sin protección contra capturas. Se desactivan el clic derecho y el arrastrar del visor.
- **Retención:** los adjuntos de una sola vista se borran de forma lógica (sin URL) cuando todos los destinatarios los abrieron, o a los 14 días.

## Pruebas mínimas

- **API:**
  - refs válidas e inválidas;
  - `event.today` una vez, respetando la zona horaria;
  - `issue.done` e `issue.overdue` una vez;
  - agrupación de comentarios: se actualiza dentro de los últimos 15 mensajes y crea uno nuevo si no;
  - búsqueda con tildes y mayúsculas, respetando el historial;
  - una vista: contenido oculto, se abre una vez, 410 la segunda, 409 al reenviar, sin URL en los endpoints generales.
- **Web:** pruebas unitarias de las utilidades de render (refs, búsqueda) y una pasada en el navegador.
- **Móvil:** decodificación de los DTO nuevos, textos de sistema, la barra de búsqueda y el visor de una sola vista.
