# Tanda del 28-sep-2026: lectura, asuntos personales, reuniones y calendario

El encargo completo es `release-assets/followups/read-meet-calendar-2026-09-28/BRIEF.md`. Esta guía es el contrato común de la web, iOS y Android. Contrato del cliente: `2026-09-28`. Hay que mandar `x-tiecoms-contract: 2026-09-28`.

## 1. Pendientes y «Marcar como leído»

**Causa real del caso de Danny.** El grupo «Estudio Norte · General» tenía leídos todos sus mensajes (`unread = 0`, por eso «Unread 0» y el menú ofrecía «Mark as unread»). Pero dos conversaciones **derivadas** del grupo, que Danny nunca abrió, sumaban 11 sin leer: «Diagnóstico · notificaciones duplicadas» (interna, 5) y «Decisión · fecha de salida» (directiva, 6). La fila las sumaba con el chip «💬 11» y el ícono de hilos, sin decir dónde estaban. Los filtros solo miraban el `unread` propio.

**Regla común:**
- `pendientesDelÁrbol(g)` = `g.unread` + la suma de `x.unread` de las conversaciones con `x.parentId == g.id` y `deriveKind != 'side'` en las que participo. Los sidechats se cuentan en DMs.
- Las menciones del árbol se suman igual, con `unreadMentions`.
- Esa cifra manda en todo: la sección «No leídos», el filtro «No leídos», el globo de la pestaña Grupos y el menú de la fila.
- El chip de la fila deja de ser «💬 N» y pasa a «⑂ N», con la ayuda «N sin leer en hilos y ramas».

**Menú de la fila (grupos y DMs):**
- Si `pendientesDelÁrbol > 0` o hay menciones sin leer, muestra «Marcar como leído / Mark as read». Si no, «Marcar como no leído».
- «Marcar como leído» llama a `POST /api/v1/conversations/:id/read-tree { items: [{ conversationId, seq }] }` con el grupo y cada derivada pendiente. Cada `seq` es el `lastMessageSeq` que **el cliente conoce**, así que lo que llegue después sigue sin leer (no hay carrera).
- El servidor valida que cada `conversationId` sea el grupo o una derivada suya (no un sidechat) en la que la persona participa, y emite `read.updated` por cada una, lo que sincroniza los otros dispositivos.
- Es una acción explícita, así que sí marca todo lo que el cliente vio en la lista.

**Dentro del chat:**
- Hay una franja nueva sobre los mensajes: «⑂ 11 sin leer en 2 conversaciones de este grupo · Ver». Abre la lista de derivadas pendientes con nombre, cifra y «@» si hay mención, y cada una lleva a su conversación.
- Lo de siempre se mantiene: la línea «N mensajes nuevos», el botón ⌄ y la píldora «@», que salta aunque la mención esté fuera de la página cargada.
- Abrir o recorrer una parte del chat **no** marca nada que no se vio: el cursor solo avanza con lo visible, igual que ahora.

## 2. Asuntos más compactos
Se quita el párrafo `issue.pageSub` («Lo que quedó pendiente…» / «What was left pending…») de la pantalla de Asuntos. Los filtros quedan pegados al título.

## 3. Asuntos personales (solo los ve su dueño)
- `POST /api/v1/issues { title, dueDate? }` crea un `IssueDTO` con `conversationId: null`, `workspaceId: null`, `visibility: 'private'`, y `ownerId`, `createdBy` y `viewerIds` iguales a yo.
- El servidor lo impone: solo el creador lo ve en listas, por id (404 para los demás) y en tiempo real (`issue.personal { issue }`, solo a su cuenta). No cuenta en los contadores de conversaciones, no manda push ni mensajes al chat, no admite tareas derivadas y no se reasigna ni se comparte (400).
- En gg, las herramientas solo lo muestran a su dueño, como «Personal (solo tú)».
- `GET /api/v1/issues` solo incluye personales si el cliente manda un contrato `≥ 2026-09-28`, porque las apps 1.6.5 no esperan `conversationId: null`.
- **En la interfaz:**
  - al crear un asunto, la primera opción de «¿Dónde?» es «🔒 Personal · solo tú»;
  - en Asuntos, «Por grupo» los agrupa en la sección «Personal · solo tú»;
  - la fila muestra 🔒;
  - el detalle no muestra «¿Quién lo hace?» (siempre eres tú), ni tareas, ni sidechat.

## 4. Reuniones reales con Google Meet, Microsoft Teams o Zoom
**API:**
- `GET /api/v1/meetings/connections` devuelve `{ connections: MeetingConnectionDTO[] }`. Cada una trae `available`, `unavailableReason`, `status` (`none`, `active` o `reconnect`) y `accountEmail`.
- `POST /api/v1/meetings/connect/:provider { platform, redirectScheme? }` devuelve `{ url }`. Esa URL se abre en el **navegador del sistema** (iOS: ASWebAuthenticationSession con esquema `chaggu`; Android: Custom Tabs).
- Al volver:
  - **web:** `/ajustes?provider=…&connected=1#reuniones`, o `&error=…`;
  - **nativas:** `chaggu://meetings/connected?provider=…&connected=1`, o `&error=cancelled|denied|…`.
- `DELETE /api/v1/meetings/connections/:provider` desconecta y revoca en Google.
- `POST /api/v1/meetings { provider, conversationId, idempotencyKey, title, startsAt?, durationMin, timezone, share }` devuelve un `MeetingDTO`.
  - Sin `startsAt`, la reunión es **ahora**.
  - `idempotencyKey` es un UUID por cada toque del botón. Reintentar con la misma llave devuelve la misma reunión y no crea otra.
  - Solo si el proveedor confirma se publica un mensaje con el enlace real y se crea la reunión en el calendario de chaggu (`location = joinUrl`).
- **Errores:**
  - 409 `not_connected` o `reconnect_required`: ofrecer Conectar o Reconectar;
  - 409 `no_teams`: la cuenta de Microsoft no tiene Teams para empresas;
  - 502 con el mensaje del proveedor;
  - 503 `provider_unavailable`: explicar `unavailableReason`, sin ofrecer un botón que no funciona.

**Permisos mínimos:**

| Proveedor | Permiso | Qué no se pide |
|---|---|---|
| Google | `openid email https://www.googleapis.com/auth/calendar.events` | No se pide Gmail |
| Microsoft | `openid email offline_access Calendars.ReadWrite` (Graph; evento con `isOnlineMeeting` y `teamsForBusiness`) | No se pide correo |
| Zoom | La app OAuth propia; crea reuniones en `/users/me/meetings` | — |

**Interfaz:**
- En el menú ＋ del chat: «📹 Reunión ahora» y «📅 Agendar reunión con enlace».
- El diálogo tiene:
  - los chips Google Meet, Teams y Zoom, cada uno con su estado: conectado (correo), «Conectar», «Reconectar» o «No disponible» con el motivo;
  - «Ahora» o fecha y hora; la duración (15, 30, 45 o 60 min); el título (por defecto «Reunión · {grupo}»);
  - el botón «Crear y compartir»;
  - el botón se desactiva mientras crea; si falla, el mismo reintento usa la misma llave.
- Al crearla aparece el enlace con «Abrir en Meet / Teams / Zoom» (URL https: la universal link abre la app si está instalada, y si no, la web) y «Copiar».
- En Ajustes, la sección «Reuniones» tiene Conectar, Reconectar y Desconectar por proveedor, con el correo de la cuenta.
- **No hay enlaces inventados.** Si el proveedor no confirma, no se muestra enlace ni se publica mensaje.

## 5. Calendario: Día, Semana y Mes
- El selector Día / Semana / Mes queda **en Semana por defecto**, recordado por dispositivo.
- Controles ‹ Hoy ›.
- **Día:** una columna de horas.
- **Mes:** una cuadrícula de 6×7 que empieza en lunes, con puntos o títulos por día y «+N más». Al tocar un día abre la vista Día.
- Se crea un evento desde cada vista (clic en el hueco o en el botón). Los eventos de las integraciones se ven como cualquier otro, con 📹 si `location` es un enlace de Meet, Teams o Zoom.
- Las fechas van en la zona del dispositivo. Meses de 28 a 31 días, con cambio de horario incluido. Con texto grande, los títulos se cortan con elipsis, sin desbordar.
