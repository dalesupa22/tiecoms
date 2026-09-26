# Grupos, relaciones, DMs e invitaciones (25-sep-2026)

Las mismas reglas en web, iOS y Android. El API es de la rama `grupos` (migraciones 019 y 020, contrato `2026-09-25`).
Todo lo nuevo en el contrato es aditivo y opcional: un cliente debe tolerar que falte.

## Modelo que ve la persona

```
Empresa (organización)
  └── Grupo            (conversación kind group/internal dentro de un espacio)
        └── Asuntos    (issues abiertos del grupo; algunos con fecha límite)
```

- **Tu organización**: los grupos internos de mi empresa. Viven en el *espacio casa* de la empresa
  (`WorkspaceDTO.isOrgHome = true`), que el API crea solo la primera vez que alguien arma un grupo interno.
- **Relaciones**: los espacios que comparto con otra empresa, agrupados por esa empresa. Un espacio es la
  «carpeta» de una relación (p. ej. Ongoing → «Xertify» con 5 mentorías). Una relación nueva cuya empresa
  aún no entra tiene `counterpartName` y se muestra como **pendiente**.
- **Invitado en**: espacios donde soy tercero (`myRole === 'guest'`), agrupados por la empresa anfitriona.
- Cada persona solo ve los grupos donde está. Cualquier participante que no sea tercero puede crear grupos y asuntos.
- Los terceros (asesores, mentores, invitados de fuera) **participan** en los asuntos (comentan, cambian estado,
  pueden ser responsables) pero **no los crean**. El API responde 403 si lo intentan.
- Quien administra una empresa (owner/admin) puede ver y leer en solo lectura los grupos donde está su gente.

## Barra inferior (móvil): 5 pestañas fijas, en este orden

| # | Pestaña | Contenido | Globo |
|---|---|---|---|
| 1 | **Grupos** | El árbol de abajo (sin directos ni chats) | no leídos de conversaciones con `workspaceId` (no silenciadas) |
| 2 | **DMs** | `kind` `direct` y `multi` **incluidos los sidechats** (`deriveKind === 'side'`) | no leídos de esas conversaciones |
| 3 | **Asuntos** | La pantalla de asuntos que ya existe | la cuenta que ya tenía |
| 4 | **Calendario** | La agenda que ya existe | — |
| 5 | **Tú** | Tu foto como ícono. Perfil, ajustes, «Unirme con código», «Supervisión» (si administras) | — |

Web de escritorio: la barra lateral muestra las mismas secciones del árbol y debajo la sección **DMs**.

### DMs
- Orden: `compareConversations` (el mismo de Inicio).
- Un sidechat lleva una burbuja **«Sidechat»** y, si puedo ver el origen, «desde #Nombre del grupo».
  Los sidechats ya no cuelgan bajo los grupos del árbol.
- Botón «Mensaje nuevo» arriba: el diálogo de nuevo chat que ya existe (1 persona → directo, 2+ → chat grupal).

## Árbol de Grupos (regla exacta)

```
myOrgIds = organizations con myRole
para cada workspace w:
  si w.myRole == 'guest'                         → «Invitado en», bajo org(w.owningOrgId)
  si no, contraparte = primera de w.organizationIds que no está en myOrgIds
    si hay contraparte                           → «Relaciones», bajo org(contraparte)
    si no y w.counterpartName                    → «Relaciones», bajo counterpartName (pendiente)
    si no                                        → «Tu organización · org(w.owningOrgId)»
```

- Orden de secciones fijo: Tu organización (una por cada empresa mía), Relaciones, Invitado en. Dentro de cada
  una, las reglas de orden de siempre (no leídos primero, luego actividad).
- Dentro de una empresa, un espacio con `isOrgHome` no muestra cabecera: sus grupos van directo. Los demás
  espacios muestran su nombre como cabecera (la carpeta). En Relaciones, si la empresa tiene un solo espacio,
  se omite la cabecera del espacio.
- Una relación pendiente muestra la marca **«Invitación pendiente»** junto al nombre.
- Filas de grupo: conversaciones del espacio con `kind` `group` o `internal`. Un `internal` lleva candado y
  «Solo {empresa}». Las derivadas (same/internal/directive) siguen con sangría bajo su origen, como hoy.
- **Bajo cada grupo, sus asuntos abiertos** (status distinto de done/cancelled): «◆ título», fecha límite si
  tiene (en rojo si ya venció) y el estado si es «en curso» o «esperando». Se ven hasta 3 y luego una fila
  «+N asuntos» que abre los asuntos de ese grupo. Tocar un asunto abre su detalle.
  Para tenerlos, el cliente carga `GET /issues?open=1` al iniciar y cuando cambia el alcance, y los mantiene
  al día con los eventos `issue.updated` que ya llegan.
- Cabeceras plegables (tocar pliega o despliega). Plegada, una cabecera muestra la suma de no leídos.
- Botón «+» en las cabeceras de sección: el de Tu organización abre «Nuevo grupo» con «Solo {mi empresa}»
  marcado; el de Relaciones lo abre con «Con otra empresa» marcado.
- Mantener presionado (clic derecho en la web):
  - **Empresa o relación**: Nuevo grupo (con la empresa ya puesta), Invitar a la empresa…, Plegar todo.
  - **Espacio (carpeta)**: Nuevo grupo aquí, Invitar, Fijar, Abrir espacio.
  - **Grupo**: el menú de conversación de siempre + «Nuevo asunto» (no para terceros) + «Invitar a este grupo».

## Nuevo grupo (el «+»)

Una sola hoja, con **títulos visibles en cada campo**:

1. **¿Para quién es?**: «Solo {mi empresa}» (equipo interno) | «Con otra empresa» (cliente, proveedor, aliado).
2. Si es con otra empresa, **Empresa**: lista las relaciones que ya existen (y las pendientes) y ofrece
   «Empresa nueva…» (campo de nombre). Si la relación elegida tiene varios espacios, se elige el espacio
   (por defecto, el primero).
3. **Nombre del grupo** (placeholder «Ej. Pagos y facturación»).
4. **Personas de {mi empresa}**: selección múltiple de colegas. En una relación existente, las personas del espacio.
5. **Invitar de fuera** (opcional): correos separados por coma o espacio, y el rol:
   - «De {empresa}» (`member`): suma su empresa a la relación.
   - «Tercero a título propio (asesor, mentor…)» (`guest`).
   En «Solo {mi empresa}» el rol queda fijo en tercero, con el aviso «Entrarán como invitados de fuera».
6. **Crear enlace para compartir** (interruptor, encendido por defecto en «Con otra empresa»).

Envía `POST /api/v1/groups`:

```json
{ "name": "Pagos", "target": { "kind": "org" } }
{ "name": "Pagos", "target": { "kind": "workspace", "workspaceId": "…" } }
{ "name": "Pagos", "target": { "kind": "company", "companyName": "Nestlé" },
  "memberIds": ["…"], "inviteEmails": ["ana@nestle.com"], "inviteRole": "member", "shareLink": true, "lang": "es" }
```

Respuesta: `{ workspaceId, conversationId, invited, inviteUrl?, inviteCode? }`. Si viene `inviteUrl`, se muestra
la **pantalla de compartir** (abajo). «Listo» abre el grupo. Después de crear, se refresca el bootstrap.

## Invitar a un grupo (correo, enlace o código)

Hoja «Invitar a {grupo}», desde el menú del grupo y desde su información:

- **Rol**: «Persona de otra empresa» (`member`) o «Tercero (asesor, mentor…)» (`guest`). En un grupo de
  Tu organización (`isOrgHome`) solo tercero.
- **Por correo**: un `POST /workspaces/{wsId}/invitations` por correo, con
  `{ email, role, conversationIds: [groupId], history: "all", lang }`.
- **Enlace y código**: `POST /workspaces/{wsId}/invitations` con
  `{ role, conversationIds: [groupId], multiUse: true, expiresInDays: 14, history: "all", lang }`.
  La respuesta trae `url` y `code`.

**Pantalla de compartir**: el código en grande (`K7QM-4XPA`, con botón Copiar), el enlace (Copiar), el botón
Compartir del sistema con el texto «Te invito a {grupo} en TieComs: {url} (código {code})» y «Vence el {fecha}.
Sirve para varias personas».

## Unirme con código

En «Tú» y en el estado vacío de Grupos: campo para `XXXX-XXXX`. Acepta minúsculas, espacios y sin guion.

1. `GET /invitations/{código}` → `InvitationPreviewDTO`: «{invitedByName} de {invitedByOrg} te invita a
   {groupNames} en {workspaceName}». Si `role === 'guest'`: «como invitado de fuera». Si `valid` es false:
   «Esta invitación venció o ya no está disponible».
2. «Unirme» → `POST /invitations/{código}/accept` `{}` → refrescar el bootstrap → abrir el primer grupo de la invitación.

El enlace `/invite/{token}` (ya existente) muestra la misma vista previa con `groupNames`.

## Terceros y asuntos

Si el espacio de la conversación tiene `myRole === 'guest'`, se ocultan «Nuevo asunto», «Crear asunto desde
este mensaje» y la sugerencia de asunto de las notas de voz. Si el API responde 403 igual, se muestra su mensaje.

## Supervisión (administradores)

En «Tú», «Supervisión de {empresa}» para cada empresa donde soy owner/admin. `GET /organizations/{id}/oversight`:

```ts
{ orgId, groups: [{ conversationId, name, kind, workspaceId, workspaceName, owningOrgId, organizationIds,
                    memberCount, myOrgMemberIds, lastMessageAt, iAmMember }] }
```

- Lista agrupada por espacio. Cada fila: nombre del grupo, avatares de mi gente, última actividad y, si
  `!iAmMember`, la marca «Solo lectura».
- Tocar: si soy miembro, abre el grupo normal. Si no, un **visor de solo lectura**:
  `GET /conversations/{id}/messages` (paginado igual que siempre), sin compositor, con la franja
  «Solo lectura · supervisión de administrador». Escribir responde 404.
- En la información de un grupo: «Los administradores de las empresas participantes pueden leer este grupo.»

## Textos

Español e inglés, en el archivo de textos de cada cliente. Nombres: Grupos / Groups, DMs, Asuntos / Issues,
Calendario / Calendar, Tú / You, Tu organización / Your organization, Relaciones / Relationships,
Invitado en / Guest in, Invitación pendiente / Invitation pending, Sidechat, Unirme con código / Join with code,
Supervisión / Oversight, Solo lectura / Read only.

## Dentro del chat: barra de accesos, hilos y el «+» (25-sep-2026)

Tres ideas distintas, sin mezclarlas:

| | Qué es | Quién lo ve |
|---|---|---|
| **Asunto ◆** | Algo por resolver: responsable, estado y a veces fecha límite | Los del chat |
| **Hilo 💬** | Una conversación que cuelga de un mensaje, como un hilo de Slack (por dentro es una derivada, `deriveKind` same/internal/directive) | Los del chat, o solo mi equipo |
| **Sidechat 🔒** | Un hilo **privado** (`deriveKind === 'side'`): con quien yo elija, incluso un bot, o para validar algo solo | Solo quienes están en él |

La respuesta citada («Responder») sigue igual y no tiene acceso propio.

### Barra de accesos (reemplaza las franjas de fijados, asuntos y ramas)

Una fila fija bajo la cabecera del chat, con 4 botones siempre visibles y su cuenta (en gris si es 0):

`📌 Fijados · ◆ Asuntos · 💬 Hilos · 📅 Agenda`

- **Fijados**: la lista de fijados que ya existe.
- **Asuntos**: los asuntos abiertos del chat (con fecha límite primero) y «＋ Asunto». Se marca en naranja si hay uno vencido.
- **Hilos**: los hilos y sidechats que salen de esta conversación (`parentId === conv.id`). Cada fila muestra el ícono
  (💬 o 🔒), el título sin prefijo («Hilo ·», «Sidechat ·», «Thread ·»…), «Con los del chat» o «🔒 Privado», el
  número de personas, las respuestas (`lastMessageSeq - 1`), la última actividad y el estado «Abierto» o «✓ Resuelto»
  (`returnedAt`). La cuenta es de los abiertos. Se marca si alguno tiene no leídos.
- **Agenda**: por fecha, las reuniones del chat (`GET /events?conversationId=`), las fechas límite de sus asuntos
  abiertos y mis recordatorios en ese chat (solo yo los veo). Tiene «＋ Evento» y «＋ Asunto». Se marca si hay una reunión hoy.
- Dentro de un hilo abierto al lado no se muestra la barra.

### Hilos como en Slack

- En el menú de un mensaje, dos bloques separados por una línea:
  1. «↩ Responder» y «✉ Responder en privado» (por DM al autor; pista «Por DM a {nombre}»).
  2. «💬 Responder en un hilo» (pista «Con los del chat»; no en directos ni para terceros) y «🔒 Sidechat privado»
     (pista «Solo con quien elijas»). Responder en privado y el sidechat son opciones distintas y no se juntan.
- «Responder en un hilo» usa el diálogo de derivar, con los textos nuevos: «Todos los del chat» (same), «Solo mi
  equipo · {empresa}» (internal), «Con quien dirige» (directive). Nombre por defecto: «Hilo · {extracto}». Botón «Abrir hilo».
- «Sidechat privado» usa el diálogo de sidechat que ya existe (elegir personas o un bot).
- Al crearlo, **se abre al lado** (la misma vista dividida del sidechat), con el cursor en su compositor. No se sale del chat.
- **Los hilos no ensucian el chat**: no se muestra el aviso de sistema `derived.from`. Bajo su mensaje queda un chip
  como en Slack: «💬 3 respuestas · Laura: ya va» (o «💬 ✓ título» si está resuelto). Tocar el chip abre el hilo al lado.
  El sidechat privado sigue con su chip propio.
- Dentro del hilo: «＋ Personas» en la cabecera (si puedo administrarlo) para sumar a quien quiera, y el botón
  «✓ Resolver y dejar el resultado» (antes «Devolver el resultado»), que deja el resumen en el chat.
- Donde decía «Derivar», «Rama» o «⑂», ahora dice **Hilo** (ícono 💬).

### El «+» del compositor

El botón de adjuntar pasa a ser **«＋»**, con: Fotos y videos, Archivos, (separador), **Evento** (nueva reunión o fecha del
chat, para todos) y **Asunto** (no para terceros). Los dos se crean a mano.
