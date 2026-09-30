# Citas por enlace (tipo Calendly)

Pedido de Danny (30-sep-2026): «la competencia de Calendly por chaggu», con `/xertifyfounders` y `/xertifyexplore`, solo web, para compartirle el enlace a un tercero cualquiera y que reserve.

## Cómo funciona
- Una **página de citas** tiene un nombre en el enlace (`slug`), una duración, un horario de atención, unos anfitriones y un modo.
- Cualquiera, **sin cuenta**, abre el enlace, elige día y hora (en su zona horaria), deja nombre y correo, y confirma.
- **Libre** = dentro del horario de atención **y** sin nada en la agenda de chaggu, **ni** en el calendario real (Google o Microsoft) de quien atiende, **ni** en otra cita. Nunca se muestra qué hay en una agenda.
- **Modos:**
  - `collective`: hay que coincidir con **todos** los anfitriones (reunión con todo el equipo). Organiza el primero con calendario conectado; los demás van de invitados.
  - `round_robin`: basta **uno** libre; la cita se reparte entre quienes tienen menos citas por delante. Solo entran a la ronda quienes tienen calendario conectado.
- Al reservar:
  1. Se vuelve a calcular el horario en fresco (el calendario pudo cambiar). Un bloqueo por anfitrión (`pg_advisory_xact_lock`) y una reserva provisional de 3 minutos evitan que dos personas tomen el mismo horario.
  2. Se crea **una sala de chaggu propia de esa cita** (la videollamada; ver `docs/LLAMADAS.md › Salas`). Sin llamadas activas en el servidor se pide Meet/Teams al proveedor.
  3. Se crea el evento en el calendario de quien organiza (con la sala en «ubicación») e invita al tercero y a los demás anfitriones: el proveedor manda su invitación.
  4. El tercero recibe el **correo de confirmación** (Brevo) con tarjeta de fecha, botón de videollamada, «Agregar al calendario» y «Cambiar o cancelar».
  5. **gg le escribe directo a cada anfitrión** en su chat con gg: «🗓️ ¡Nueva cita en …!» con quién, cuándo, la nota que dejó y el enlace. También avisa si la cambian o la cancelan.
- El tercero puede **cambiar de horario** (se mueve el mismo evento, conserva el enlace) o **cancelar** con `/r/<clave>`; la clave solo llega en la confirmación y del servidor solo se guarda su hash. Un anfitrión cancela desde Agenda › Mis enlaces. Cancelar cierra la sala de la cita.
- Límites: máximo 3 citas futuras y 5 por hora por correo; campo trampa anti-bots; límite de peticiones por IP.

## Dónde se ve
- **Público:** `https://cita.chaggu.com/<nombre>` (mientras el dominio no esté listo, `https://app.chaggu.com/cita/<nombre>`). Responsive, es/en según el navegador.
- **Administración (web):** Agenda › **Mis enlaces**: crear y editar páginas (título, enlace, duración, modo, anfitriones, días y horas, zona, aviso mínimo, días hacia adelante), copiar el enlace, ver qué anfitriones tienen calendario conectado («Conectar mi calendario» lleva a Ajustes › Reuniones) y las próximas citas.
- Por consola: `node ops.js booking-page <correo dueño> <slug> "<título>" <collective|round_robin> <minutos> <correos> ["<descripción>"]` (crea o actualiza) y `node ops.js booking-status`.

## Calendarios
No hay permisos nuevos: se usa la conexión de **Ajustes › Reuniones** (Google `calendar.events.owned`, Microsoft `Calendars.ReadWrite`). Solo se leen horas ocupadas (no el contenido); los eventos «disponible» o rechazados no bloquean. Un anfitrión **sin calendario conectado** solo cuenta con su agenda de chaggu y se marca en rojo en Mis enlaces: conviene que conecte el suyo. Si Google no responde, ese anfitrión se da por ocupado (nunca se ofrece un horario sin poder comprobarlo).

## Configuración
- `BOOKING_PUBLIC_ORIGIN=https://cita.chaggu.com` cuando el dominio esté listo (enlaces de la página y de «Cambiar o cancelar»).
- `BOOKING_CACHE_MS` (45 000): cuánto se recuerda la agenda de Google entre consultas; reservar siempre mira en fresco.
- Dominio: DNS `cita` (CNAME, con proxy de Cloudflare) y `sudo tiecoms-cert add-chaggu cita.chaggu.com` en el servidor para agregarlo al certificado. nginx ya lo sirve (mismo app y API que app.chaggu.com; la web reconoce el host `cita.`).

## Pruebas
`test/booking.test.ts` (API con MEETINGS_ENABLED, CALLS_ENABLED + CALLS_PROVIDER=fake, `test/fake-meetings.mjs` y `test/fake-brevo.mjs`; BOOKING_CACHE_MS=0): zonas y cambio de horario, páginas, horarios contra el calendario, reparto, carrera de dos personas, collective, anti-abuso, cambiar y cancelar, avisos de correo y de gg. Esto NO prueba OAuth ni la agenda real de Google.

## Pendiente
iOS y Android (por ahora solo web, como se pidió). Recordatorios antes de la cita y preguntas personalizadas.
