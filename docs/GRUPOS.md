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
- **Solo hay grupos y asuntos** (26-sep-2026): ningún espacio se muestra como cabecera o carpeta. Bajo «Tu organización»
  y bajo cada empresa de Relaciones / Invitado en van directamente sus grupos, de todos sus espacios. Si dos grupos de
  la misma empresa se llaman igual (p. ej. dos «General» de espacios viejos), se muestran como «{espacio} · {grupo}»
  (nunca en el espacio casa). Un espacio sin grupos no aparece. Una relación pendiente sin grupos sí aparece.
- Una relación pendiente muestra la marca **«Invitación pendiente»** junto al nombre.
- Filas de grupo: conversaciones del espacio con `kind` `group` o `internal`. Un `internal` lleva candado y
  «Solo {empresa}». **Los hilos (derivadas) no se listan en el árbol**: viven en la barra de su chat. Si tienen
  respuestas sin leer, la fila del grupo muestra «💬 N».
- **Archivar grupo** (menú del grupo, solo si `canManage`): `POST /conversations/{id}/archive`, con confirmación. Si era
  el último grupo de un espacio que no es casa, el espacio también se archiva y desaparece.
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
  - **Grupo**: el menú de conversación de siempre + «Nuevo asunto» (no para terceros) + «Invitar a este grupo» + «Archivar grupo».

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
Compartir del sistema con el texto «Te invito a {grupo} en Chaggu: {url} (código {code})» y «Vence el {fecha}.
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

## Viralidad: la otra empresa se vuelve coadministradora (25-sep-2026)

- Cuando la **primera persona de una empresa nueva** acepta una invitación (rol de empresa, no tercero) a una relación,
  queda como **admin del espacio** (`workspace_memberships.role = 'admin'`). Las siguientes de esa empresa entran como
  miembros. Así Uniandes invita a su gente, arma sus grupos y administra la relación igual que Xertify.
- **Canal propio en una relación**: `POST /groups` con `internal: true` (target `workspace` o `company`) crea un grupo
  `kind: 'internal'` solo de mi empresa. La otra empresa no lo ve. No admite invitaciones de fuera ni enlace.
  En el «+»: casilla «Solo {mi empresa}: nuestro propio canal en esta relación».
- Para la empresa invitada, la relación aparece sola en «Relaciones → {quien la invitó}», y su «Tu organización»
  empieza vacía con la invitación a crear su primer grupo interno.

## Entrada automática por dominio

- `PUT /organizations/{id}/join-policy` `{ joinPolicy: 'auto' | 'invite' }`, solo owner/admin; `auto` exige un dominio
  verificado (por Google Workspace/Microsoft Entra al registrarse, o por TXT).
- Con `auto`, quien inicia sesión con Google o Microsoft con un correo de ese dominio entra a la empresa sin invitación.
- `OrganizationDTO.joinPolicy` solo viene para owner/admin. En «Tú»: interruptor «Entrada automática con @dominio».

## Plegado de asuntos, completar rápido e hilos en directos (26-sep-2026)

- **Asuntos contraídos por defecto.** La fila del grupo lleva un chip «◆ N» (y «· M!» si hay vencidos). Tocarlo
  muestra u oculta los asuntos activos de ese grupo (hasta 3 y «+N asuntos») sin entrar al chat. Se recuerda por
  dispositivo (web: `localStorage['tiecoms:issuesOpen']`, la lista de grupos abiertos).
- Las **secciones** (Tu organización, Relaciones, Invitado en) se pliegan tocando su título. Su menú (clic derecho o
  pulsación larga) trae «Mostrar todos los asuntos», «Contraer todos los asuntos», «Plegar todo» y «Expandir todo».
- **Completar sin abrir**: clic derecho o pulsación larga sobre un asunto (en Grupos y en la lista de Asuntos) ofrece
  Completar, Marcar en curso, Marcar en espera y Abrir. Bajo los grupos solo se ven los activos (open, in_progress,
  waiting); al completarse sale de inmediato y baja el conteo.
- **Hilos en directos y chats grupales**: `POST /conversations/:id/derive` con `kind: 'same'` funciona también fuera
  de un espacio. Crea un chat `multi` con las mismas personas, `parentId` y `parentMessageId` del mensaje y
  `deriveKind: 'same'`. Allí no hay `internal` ni `directive` (400), y un hilo no se deriva otra vez (400). Los
  clientes no lo listan en DMs (solo los sidechats van allí): vive en la barra de hilos del chat.
- **Web**: «Nuevo chat» arriba de la barra lateral y ⌘K / Ctrl+K desde cualquier pantalla. Trazo, Personas,
  Archivos, Ver después y WhatsApp van bajo «Más» para que los grupos y las relaciones quepan sin scroll.

## Títulos de notificaciones y subidas (26-sep-2026)

- Los push de un chat de un espacio (grupos y sus hilos) llevan como título, o como subtítulo en menciones,
  recordatorios, reuniones y reacciones, **«Empresa - Grupo»** (p. ej. «Xertify - General»). La empresa se calcula
  por persona con la regla del árbol: invitado → anfitriona; otra empresa en el espacio → esa; relación pendiente
  → la contraparte; si no → la dueña. Helper `groupLabels()` en `apps/api/src/modules/push.ts`. Los clientes que
  arman notificaciones locales (web, iOS, Android en primer plano) usan la misma etiqueta.
- nginx: `POST /api/v1/conversations/:id/attachments` acepta hasta 26 MB (antes caía en el límite general de 128 KB
  y fotos de cámara y notas de voz de más de ~30 s respondían 413) y `/attachments/:id/thumb` hasta 1 MB.

## Barra de arriba y búsqueda rápida en la web (27-sep-2026)

Lo mismo que iOS 1.6.3, adaptado a escritorio:

- Grupos, DMs, Asuntos y Calendario llevan arriba a la derecha **✎ Mensaje nuevo** y **＋ Crear** (Nuevo grupo · Nuevo asunto ·
  Nueva reunión · Unirme con código). En escritorio la barra lateral repite el par arriba («Mensaje nuevo ⌘K» y «＋»); ⌘K / Ctrl+K
  sigue abriendo Mensaje nuevo desde cualquier pantalla. Grupos ya no tiene «Unirme con código» ni «＋ Nuevo grupo» sueltos, y
  Calendario pasa «＋ Reunión» al menú Crear (la semana y Hoy ‹ › quedan debajo del título).
- Plegar y desplegar: botón de vista ☰ (a la izquierda del título en Grupos y junto a los filtros de la barra lateral). El estado de
  plegado es uno solo para la barra y la pantalla.
- «＋ Nuevo asunto» sin grupo de origen pide «Grupo o chat» (`issueDestinations`: donde escribo, sin hilos, no como tercero,
  en el orden de Inicio; «Grupo · Empresa de la otra parte»).
- Buscar en Grupos y DMs: Personas (clic = su directo; se crea con POST /chats {userIds:[id]} si no existe), Grupos y Chats; quien
  ya tiene su directo entre los chats encontrados sale una sola vez. Enter abre el primer resultado; Esc borra.
- Mensaje nuevo: buscador fijo arriba, «Chat con varias personas» (selección, chips, nombre opcional con 2+, «Crear chat de {n}»),
  «Recientes» (personas de mis directos, máx. 8), personas por empresa (mi equipo primero) donde un clic abre el directo y, al buscar,
  grupos. Flechas mueven, Enter abre (o marca en selección múltiple; ⌘/Ctrl+Enter crea). «Grupo en un espacio» sigue abajo.
- Reglas puras en `apps/web/src/quick-search.ts` (mismas que `QuickSearch.swift`), probadas en `apps/web/test/quick-search.test.ts`.

## Bandeja ordenada, vista Lista/Árbol y chats largos (27-sep-2026)

Chaggu 1.6.4. Sin cambios de backend: todo sale de los DTO actuales (`pinnedAt`, `unread`, `unreadMentions`, `lastReadSeq`,
`historyFromSeq`, `mutedUntil`). En móvil la barra inferior sigue igual (Grupos, DMs, Asuntos, Calendario, Tú).

### Orden único (Inicio, DMs, Lista, «Todo» y dentro de cada sección del Árbol)
`compareConversations` (`apps/web/src/home-order.ts`):
1. **Fijadas primero** (`pinnedAt`). Entre fijadas, el mismo criterio de abajo.
2. Una **mención sin leer** (`unreadMentions > 0`), aunque esté silenciada.
3. **No leídos pendientes** (`pendingOf > 0`: no leídos y no silenciada).
4. El resto por **actividad** descendente (`activityOf`: último mensaje de una persona o, si no hay, el último). Desempate por id.

Antes era mención → no leído → fijada → actividad: la fijada sube al primer nivel. En el Árbol las empresas se ordenan igual
(con algo fijado, con mención, con no leídos, actividad) y bajo cada empresa van juntos los grupos de todos sus espacios.

### Separadores
En Lista, DMs y «Todo»: **Fijados**, **Sin leer** (mención o pendiente) y **Recientes**. Un bloque vacío no sale (`withSeparators`).

### Grupos: «Lista» | «Árbol»
- Control segmentado arriba de Grupos. Por defecto **Lista**. Se recuerda por dispositivo: web `localStorage['chaggu:groupsView']`,
  iOS UserDefaults `groupsView`, Android SharedPreferences `groupsView`; valores `list` / `tree`.
- **Lista**: las mismas filas de grupo del árbol (group/internal, sin hilos derivados) en una sola lista con el orden de arriba, sin
  cabeceras de sección. Cada fila en dos líneas: «{Empresa} · {Grupo}» con la empresa del árbol (Tu organización → mi empresa; Relaciones →
  la contraparte o `counterpartName`; Invitado en → la anfitriona); si el nombre ya empieza por la empresa (sin importar mayúsculas ni
  tildes) no se repite (`companyGroupLabel`), y se trunca al final con «…». Debajo «Nombre: texto» del último mensaje; a la derecha la hora,
  📌 si está fijada, candado si es internal, «💬 N» de hilos sin leer, el chip «◆ N · M!» de asuntos (mismo plegado) y los globos.
  Clic derecho / pulsación larga: el menú de grupo del árbol. En un separador: «Mostrar todos los asuntos» / «Contraer todos los asuntos».
- **Árbol**: el de siempre con el orden nuevo. El botón ☰ (plegar y desplegar) solo aplica en Árbol.
- La búsqueda de Grupos es la misma en ambas vistas.

### Web de escritorio (barra lateral)
- Pestañas **Todo · Grupos · DMs** con su número de no leídos pendientes, arriba de la lista (reemplazan la fila Todo/No leídos/Menciones).
  «Todo» = grupos (como en Lista) + DMs en una lista; «Grupos» = Lista o Árbol según el selector; «DMs» = los DMs. Se recuerda en
  `localStorage['chaggu:sidebarTab']` (`all` / `groups` / `dms`).
- «Sin leer» y «@ Menciones» pasan a filtros pequeños (se recuerdan en `tiecoms:homeTab`). Menciones abre la bandeja de menciones.
- El selector Lista | Árbol va junto a ☰ en la pestaña Grupos. Ya no hay bloque «Fijados» aparte: las fijadas van arriba en cada vista.

### Asuntos contraíbles
Como el 26-sep-2026: contraídos por defecto, chip «◆ N · M!», se recuerda por dispositivo (`tiecoms:issuesOpen`), tocar el resto de la
fila abre el chat. Funciona igual en Lista. En pantallas pequeñas los asuntos abiertos son sub-filas compactas con sangría, en una línea
(◆ título, estado si en curso/esperando, fecha límite pequeña a la derecha, en rojo si venció).

### Navegar un chat largo
1. **Abrir en el primer no leído**: con `unread > 0` se toma al montar `readFrom = max(lastReadSeq, historyFromSeq)`; el primer no leído es el
   primer mensaje con seq mayor (`firstUnread`, `apps/web/src/chat-nav.ts`). Si no está cargado se piden páginas antiguas (máx. 3,
   `MAX_OLDER_PAGES`); si no aparece, se abre al final. Sobre él va la línea **«N mensajes nuevos»** (N = `unread` al abrir) y ese mensaje
   vuelve a llevar autor y hora. La línea queda hasta salir del chat. Mientras se ubica no se marca leído; se marca al llegar al final.
2. **⌄ «Ir al final»** abajo a la derecha, sobre el compositor, cuando se está a más de una pantalla del final o llegaron mensajes estando
   arriba (globo con cuántos: seq actual − último seq visto abajo). Tocar: scroll animado al final y marca leído. Estando arriba los
   mensajes nuevos no arrastran al final.
3. **Píldora «↑ N nuevos»** arriba al centro cuando la línea quedó por encima de la vista; tocar salta a la línea.
4. **«@»** encima del ⌄ con menciones a mí sin leer (desde lo leído al abrir, con `MessageDTO.mentions`) que aún no pasaron por pantalla;
   tocar salta a la siguiente; cuando no quedan, desaparece.
5. Web: **Fin** o **⌥↓ / Alt+↓** con el foco fuera del compositor baja al final.
- Etiquetas: «Ir al final», «Ir a los mensajes nuevos», «Ir a la mención» (EN «Jump to latest», «Jump to new messages», «Jump to mention»).
- `client.markRead` también pone `unreadMentions: 0` en local (antes la «@» de la fila quedaba hasta recargar).

Pruebas: `apps/web/test/home-order.test.ts` (orden con fijados primero, separadores, «Empresa · Grupo», primer no leído).
