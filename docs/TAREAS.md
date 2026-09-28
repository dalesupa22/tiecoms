# Tareas derivadas y visibilidad (web, iOS y Android)

Caso: James (Los Andes) abre un asunto en el grupo con Xertify. De ahí salen tareas para Danny, Lorena y Adriana que solo ve Xertify, a veces una privada con un tercero de otra empresa, o se abren en un sidechat. James no ve nada de eso.

## Modelo (migración 027)
- `issues.parent_issue_id`: una tarea hija de un asunto. Hay un solo nivel: las tareas no tienen subtareas.
- `issues.visibility` puede ser:
  - `all`: todo el chat, como hasta ahora;
  - `org`: solo las personas de `visible_org_id` que están en el chat, más `issue_viewers`;
  - `private`: solo `issue_viewers` (quien la creó, el responsable y los agregados).
- En los asuntos restringidos, el responsable o un agregado puede no estar en el chat (por ejemplo, un tercero de otra empresa): ve la tarea, no el chat. Debe ser contacto de quien lo agrega.
- Una tarea hija vive en el chat del asunto o en un **sidechat que salió de él**. Ahí la ve solo el sidechat.
- `conversations.side_issue_id`: el sidechat se abrió desde ese asunto (`POST /conversations/:id/side { issueId, userIds }`). En el DTO llega como `sideIssueId`.

## API
- `POST /api/v1/issues/:id/children` `{ title, ownerId?, dueDate?, visibility?, viewerIds?, conversationId? }`. `conversationId` = un sidechat del chat del asunto.
- `POST /api/v1/conversations/:id/issues` también acepta `parentIssueId`, `visibility` y `viewerIds`.
- `PATCH /api/v1/issues/:id` también acepta `visibility` y `viewerIds`. Solo quien creó el asunto cambia la visibilidad; si otra persona lo intenta, recibe 403.
- `GET /api/v1/issues/:id` devuelve `{ issue, events, children }`, con solo las hijas que yo veo.
- Si no puedo ver un asunto, la respuesta es 404, para no confirmar que existe.
- **En vivo:**
  - un asunto `all` viaja por la conversación, como siempre;
  - uno restringido llega por la cuenta como `issue.updated { issue }` (sin `eventSeq`);
  - quien pierde acceso recibe `issue.hidden { issueId, conversationId }` y lo saca de su lista;
  - el catch-up de la conversación redacta los `issue.updated` de asuntos que hoy están restringidos.
- En el chat solo se anuncia (mensaje de sistema) lo que es `all`. Las tareas hijas no anuncian el cierre en el chat.
- **Push:** `type: 'issue'` con `{ issueId, conversationId, inChat }` cuando te asignan algo que asignó otra persona. Si `inChat` es `false`, abre el asunto sin abrir el chat.
- Contadores (`openIssues` del bootstrap): el servidor cuenta solo `all`. El cliente recuenta con lo que tiene.

## Interfaz (igual en las tres plataformas)
- **Fila de asunto:**
  - si tiene tareas, muestra la chapita «☑ 1/3»;
  - la chapita se pone verde cuando están todas hechas;
  - 🔒 delante del título si es restringida (tooltip «Solo Xertify» / «Privada»).
- **Tareas debajo del asunto**, sangradas con «↳» y una casilla más pequeña. En móvil, bajo el asunto contraíble.
- **Crear una tarea**, por tres caminos:
  - escritorio: al pasar el mouse sobre la fila aparece «＋»;
  - clic sostenido o clic derecho en el asunto: «＋ Tarea derivada» y «💬 Hablar aparte (sidechat)»;
  - dentro del asunto: la sección «Tareas».
- **Alta de tarea:**
  - título y Enter;
  - «¿Quién la hace?»: chips de los del chat y «＋ Otra persona» para cualquier contacto;
  - «¿Quién la ve?»: 👁 Todo el chat / 🔒 Solo {mi empresa} / 🔒 Privada;
  - por defecto, «Solo mi empresa» si en el chat hay más de una empresa;
  - si la persona no está en el chat, «Todo el chat» se desactiva y la tarea queda privada, con el aviso «{nombre} no está en este chat…».
- **Detalle de una tarea:** «↑ Parte de «asunto»» (navega al asunto dentro del mismo detalle) y «¿Quién la ve?» (solo para quien la creó).
- **Sidechat desde el asunto:** eliges personas y un primer mensaje opcional. Arriba del compositor aparece la franja «◆ asunto · ☑ 1/3 · ＋ Tarea», y en el menú ＋ del compositor, «Tarea del asunto».
- **Asuntos, por grupo:** las tareas van debajo de su asunto. **Por responsable:** van sueltas, con «↳ asunto». Las compartidas conmigo de chats que no leo salen en «Compartidas contigo».
