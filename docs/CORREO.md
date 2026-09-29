# Correo y WhatsApp en el chat

Cuando llega un correo o un WhatsApp que hay que hablar con el equipo, se lleva a un grupo, a un DM o a una tarea. En el chat aparece como una tarjeta, igual que la de un evento, con el icono de Gmail, de Outlook o de WhatsApp. El equipo lo comenta en su hilo. Después, quien lo trajo lo responde o programa la respuesta sin salir de chaggu. Diseño aprobado por Danny el 29-sep-2026: https://claude.ai/artifact/6UF8uafA12q67FX6wrBVyJ

## Reglas de producto

- **No se guarda la bandeja.** La lista, la búsqueda y el correo abierto se leen en vivo de Gmail u Outlook con el token de cada persona.
- **Solo se guarda lo que se comparte:** remitente, destinatarios, asunto y el texto del correo que alguien lleva a un chat. El texto nuevo se recorta sin el historial citado ni la firma. El original completo se trae en vivo al pedirlo.
- **Los adjuntos se bajan bajo demanda** del buzón de quien compartió, cuando alguien los abre. No se guardan. Si esa persona desconecta su correo, la tarjeta dice «pídeselo a …».
- **La lista.** Por defecto muestra los últimos 50 de Recibidos › Principal, sin promociones. Las pestañas son:
  - Gmail: Principal, Notificaciones, Promociones, Social, Foros y Todo.
  - Outlook: Prioritarios, Otros y Todo.
- **La búsqueda** llega a todo el buzón, también a los correos viejos. Filtros: palabras, fecha (hoy, 7 días, 30 días, este año, más de un año o entre dos fechas), De, Para, Con adjuntos, No leídos y Etiqueta o Categoría. Al buscar, la pestaña pasa a Todo, salvo que la persona haya elegido una.
- **Recibido ↙ y enviado ↗ se distinguen** en la lista, en la tarjeta (borde azul o verde azulado) y en el estado («Por responder» o «Enviado por ti»).
- **Dos entradas, un solo gesto:** Más › Correo › «Llevar a un chat», o el ＋ del chat › Correo. Desde el chat, el destino ya viene elegido.
- **El hilo tiene un solo compositor con dos modos:**
  - «Comentar al equipo»: el remitente nunca lo ve.
  - «Responder a …»: solo aparece para quien trajo el correo, porque sale de su buzón. Responde a todos menos a uno mismo y el CC se puede editar. gg redacta con lo que dijo el hilo, y se pueden adjuntar archivos del chat. Con ▾ se programa: en 1 h, en 3 h, mañana 9:00, el lunes 9:00 o una fecha elegida.
- **Tarea desde el correo:** responsable, fecha y la casilla «cerrar cuando se responda».
- **WhatsApp:** clic derecho o pulsación larga sobre un mensaje en la pantalla WhatsApp › «Comentar en chaggu…». Queda una tarjeta verde con el mensaje citado. Solo el dueño de la cuenta de WhatsApp puede compartir sus mensajes.
- **No hay avisos de correo nuevo.** Eso ya lo hace Gmail u Outlook.

## Permisos (se piden una sola vez al conectar)

| Para qué | Gmail | Outlook (Graph, delegados) |
|---|---|---|
| Lista, búsqueda, abrir, adjuntos | `gmail.readonly` | `Mail.ReadWrite` |
| Responder y programar | `gmail.send` | `Mail.Send` |
| Borradores | `gmail.compose` | `Mail.ReadWrite` |
| Seguir conectado | refresh token (`access_type=offline`) | `offline_access` |

La conexión es independiente de la de Reuniones: tiene su propia tabla `mail_connections` y su propio consentimiento. Usa las mismas redirect URI del login (`/api/v1/auth/{google|microsoft}/callback`), y el `state` con prefijo `mail_` distingue el flujo. Como en Reuniones, el callback no activa nada. Entrega un recibo de un solo uso, y ese recibo solo lo canjea el navegador que empezó el flujo, con su prueba PKCE (`POST /mail/connect/confirm`).

Programar no necesita un permiso extra: chaggu guarda la respuesta en `mail_replies` y el worker la envía a la hora elegida. Al enviarla se borra el texto, porque la respuesta queda en los Enviados de la persona.

### Lo que falta configurar (lo hace Danny)

1. **Google Cloud (proyecto `tiecoms`):** activar la **Gmail API** y agregar los tres scopes de Gmail en la pantalla de consentimiento (Data Access). `gmail.readonly` es un permiso **restringido**. Fuera de xertify.co exige verificar la app y una evaluación de seguridad anual (CASA). Mientras sale, Google muestra «app no verificada» y limita a 100 usuarios.
2. **Microsoft Entra (app TieComs):** agregar los permisos delegados `Mail.ReadWrite` y `Mail.Send` de Microsoft Graph. Algunas empresas exigen consentimiento del administrador.
3. **Servidor:** `MAIL_ENABLED=true` en `/opt/tiecoms/shared/api.env`. Opcional: `MAIL_TOKEN_KEY`, que si falta se deriva de `JWT_SECRET`; si cambia, hay que volver a conectar.

## API

| Ruta | Qué hace |
|---|---|
| `GET /mail/connections` · `POST /mail/connect/:provider` · `POST /mail/connect/confirm` · `DELETE /mail/connections/:provider` | Conexión |
| `GET /mail/messages?provider&box&category&q&from&to&after&before&attachments&unread&label&page` | Lista o búsqueda en vivo (caché de 60 s; `fresh=1` la salta) |
| `GET /mail/messages/:provider/:id` | Correo completo en vivo (vista previa) |
| `POST /mail/share` | Llevar a un chat: crea `shared_emails` y el mensaje de sistema `mail.shared` |
| `GET /mail/shared/:id` · `GET /mail/shared?ids=` | Tarjeta(s) sin cuerpo; hasta 50 por lote. `?full=1` trae el cuerpo |
| `GET /mail/shared/:id/original` | El correo tal cual está en el buzón (con historial y firma), en vivo y sin guardar |
| `GET/POST /mail/shared/:id/comments` | Hilo. Aviso agrupado `mail.comments` en el chat |
| `GET /mail/shared/:id/attachments/:att` | Adjunto bajo demanda |
| `POST /mail/shared/:id/draft` | gg redacta |
| `POST /mail/shared/:id/reply` · `DELETE …/reply` | Responder ya o programar (`sendAt`); cancelar lo programado |
| `POST /mail/shared/:id/task` | Tarea enlazada |
| `POST /whatsapp/share` | «Comentar en chaggu» desde un mensaje de WhatsApp (`wa.shared`) |

Mensajes de sistema nuevos: `mail.shared`, `mail.comments`, `mail.replied`, `mail.reply_failed` y `wa.shared`. Evento en vivo nuevo: `mail.updated`. Las apps que no los conozcan deben mostrar el texto de `sys.*` o ignorarlos.

## Rendimiento y almacenamiento

- **Gmail:** una página cuesta 2 peticiones, la lista y un lote (`POST /batch/gmail/v1`) con la metadata de los 50 correos, con `fields=`. Si el lote falla, se piden de a 10 en paralelo. Antes eran 51.
- **Outlook:** el correo y la lista de adjuntos se piden juntos con `$expand=attachments($select=…)`.
- **Caché en memoria del API** (`ByteLru`, por persona, nunca en disco): 60 s la lista (16 MB) y 5 min el correo abierto (24 MB). Así la vista previa y compartir no piden el correo dos veces. Desconectar o responder la invalida.
- **Web:** se guarda en memoria la lista por filtro (volver pinta al instante y se refresca por detrás si tiene más de 20 s). La vista previa se precarga al pasar el cursor, y ↻ fuerza `fresh=1`. Las tarjetas del chat se piden en lotes de hasta 50.
- **Base de datos:** `body_text` guarda solo el texto nuevo (`cleanBody`: sin historial citado, sin firma, máx. 20 000 caracteres) y `body_trimmed` marca si se cortó. Las tarjetas y el evento en vivo `mail.updated` van sin cuerpo, así `conversation_events` no repite el texto en cada comentario. El worker borra cada hora las respuestas resueltas de hace más de 30 días y los flujos OAuth vencidos.

## Pruebas locales

```bash
node apps/api/test/fake-mail.mjs 59397
```

Es un Gmail y un Outlook **falsos**: pasar con ellos no demuestra que OAuth ni los permisos reales funcionen. En `apps/api/.env` van `MAIL_ENABLED=true`, `MAIL_GOOGLE_*`, `MAIL_MS_*` y `DEEPSEEK_URL` apuntando al falso. La base es el esquema aislado `correo` de `tiecoms_test`. Las pruebas están en `apps/api/test/mailbox.test.ts`.

## Pendiente

- Paridad en iOS y Android: la tarjeta, el panel, el ＋ › Correo y el menú de WhatsApp. Las apps publicadas hoy mostrarían solo el texto de `sys.mail.*`.
- La verificación de Google para `gmail.readonly` (CASA).
