# Mensajes programados

Se escribe ahora y sale solo a la hora elegida. Solo lo ve quien lo escribió hasta que sale.

## API (migración 025)
- `POST /api/v1/conversations/:id/scheduled` `{ body, sendAt, mentions?, replyTo? }`. `sendAt` debe estar entre +30 s y +1 año, y hay que poder escribir en la conversación.
- `GET /api/v1/scheduled[?conversationId=]`: mis pendientes, los que se están enviando y los fallidos (de conversaciones donde sigo).
- `PATCH /api/v1/scheduled/:id` `{ body?, sendAt? }`: si estaba fallido, vuelve a la cola.
- `DELETE /api/v1/scheduled/:id`: cancela.
- `POST /api/v1/scheduled/:id/send`: lo envía ya.
- Evento de cuenta `scheduled.updated { scheduled }`, que llega a todos mis dispositivos. Un programado sale de la lista cuando queda `sent` o `cancelled`.

## Envío
El worker revisa cada 15 s, en el mismo ciclo de los recordatorios. Usa el índice parcial `scheduled_due`, que solo tiene pendientes, así que sin nada por enviar la consulta no cuesta. Toma hasta 100 filas con `FOR UPDATE SKIP LOCKED`.

Cada programado sale por `sendMessage` con `clientMessageId = sched-<id>`: si se reintenta o se cae el worker, el mensaje no se duplica. Un envío que queda colgado en `sending` se retoma a los 2 minutos.

Cuando llega la hora se revalida el acceso. Un error 4xx (por ejemplo, ya no está en el grupo) lo deja en `failed` con el motivo. Los errores de red o de base de datos se reintentan en el siguiente ciclo.

## Interfaz (igual en las 3 plataformas)
- Con texto escrito aparece 🕒 junto a enviar. Clic derecho o pulsación larga en ➤ abre el mismo menú.
- Opciones del menú:
  - «En 1 hora» (redondeado a 5 min);
  - «Esta tarde» a las 18:00 (solo antes de las 16:00);
  - «Mañana temprano» a las 8:00;
  - «El lunes temprano» a las 8:00 (si mañana no es lunes);
  - «Elegir fecha y hora…».
- Al programar, el compositor se vacía y sale el aviso «🕒 Programado para mañana a las 8:00 a. m.» con «Deshacer».
- Encima del compositor hay una franja: «🕒 N mensajes programados · el próximo sale …» con «Ver». La franja se vuelve naranja si alguno falló.
- La lista tiene «Enviar ahora», «Cambiar hora», «Editar» y «Cancelar envío». Cancelar también tiene «Deshacer».
- Pantalla «Programados» en Más, en `/programados`.
- Solo se programa texto (con menciones y respuesta). Los adjuntos y las notas de voz se envían al momento.

# No molestar todas las noches (modo sueño)

Complementa a «No molestar» (`dnd_until`, que es manual y por un rato) con un horario diario automático. Migración 026.

- **Base de datos:**
  - Columnas nuevas en `users`: `sleep_on` (por defecto `true`), `sleep_start` (22:00), `sleep_end` (07:00), `sleep_tz` (America/Bogota) y `sleep_tz_auto`.
  - Función `tiecoms_sleeping(on, start, end, tz)`. Soporta ventanas que cruzan la medianoche.
- **Push:** el filtro `ACTIVE_SESSION` de `push.ts` descarta a quien está en su ventana. Funciona igual que No molestar: no sale ningún push, pero los no leídos se cuentan igual.
- **API:**
  - `PUT /api/v1/me/sleep` `{ on?, start?, end?, tz?, tzAuto? }` responde `{ sleep }` y manda el evento `me.sleep` a mis sesiones.
  - Si llega `tz` sin `tzAuto`, la zona queda fijada a mano.
  - El cliente ajusta la zona según el dispositivo mientras `tzAuto` sea `true` (viajes).
- **Bootstrap:**
  - `me.sleep` trae mi configuración completa.
  - `people[].sleep` trae `{ start, end, tz }`, o `null` si la persona lo tiene apagado.
- **Interfaz:**
  - En el menú de «No molestar» y en Ajustes aparece «Todas las noches», con desde y hasta.
  - La lunita del avatar se enciende también durante la ventana.
  - A quien escribe se le muestra un aviso:
    - en un directo con alguien que está descansando: «Ana está descansando: le llega sin sonar. Lo verá mañana a las 7:00 a. m.» y el botón «🕒 Enviar a las 7:00», que programa el mensaje;
    - en grupos, solo mientras escribe: «N personas del chat están descansando…».

# Programar mensajes desde MCP

El conector MCP admite programaciones puntuales de **texto** tanto en chaggu como en WhatsApp. La fecha y el contenido quedan guardados en PostgreSQL. El worker de chaggu procesa los vencidos y el puente de WhatsApp toma sus mensajes de la cola. Cerrar la conversación con la IA o la app no borra la programación.

## Herramientas

| Canal | Crear | Consultar | Editar | Cancelar |
| --- | --- | --- | --- | --- |
| chaggu | `schedule_message` | `list_scheduled_messages` | `update_scheduled_message` | `cancel_scheduled_message` |
| WhatsApp | `schedule_whatsapp` | `list_scheduled_whatsapp` | `update_scheduled_whatsapp` | `cancel_scheduled_whatsapp` |

Para chaggu se indica exactamente uno de `chat` (chat existente por ID/nombre) o `to` (persona por ID/nombre). `to` abre el DM si hace falta, sin publicar el mensaje antes de la fecha. Si hay homónimos, se usa el ID. `reply_to` permite responder a un mensaje de esa conversación.

Para WhatsApp se indica exactamente uno de `chat` (referencia `cuenta|jid` o nombre inequívoco) o `phone` (teléfono con indicativo). `account` selecciona el número emisor cuando hay varios. Solo se admiten números/chats autorizados para esa integración; siguen aplicando la privacidad y Chat Lock del producto.

Cada creación requiere `text`, `send_at`, `timezone` e `idempotency_key`. La llave debe tener de 8 a 120 caracteres. Reintentar la misma operación con la misma llave devuelve la programación original con su **estado actual**; no reprograma un mensaje ya cancelado o enviado. Cambiar el destino, contenido, fecha o zona con una llave ya usada da `idempotency_mismatch`. Para otra programación se usa una nueva llave. Este registro persiste durante la vida del token y no tiene el vencimiento de 24 horas de los envíos inmediatos.

## Fechas y consentimiento

1. Resolver «mañana», «el lunes» o «a las 10» con la fecha y zona actuales de la persona. `whoami.server_time` es un reloj UTC, no una preferencia de zona. Si la zona no está disponible en su contexto, preguntarla.
2. Mostrar canal, destinatario, número emisor cuando corresponda, texto y fecha/hora local exacta con la zona. Obtener la confirmación de la persona antes de programar.
3. Enviar `send_at` en ISO 8601 con `Z` o un offset numérico, y `timezone` IANA. El mínimo son 30 segundos en el futuro y el máximo 366 días. No se aceptan fechas sin offset.
4. Devolver el recibo como **programado** y conservar su ID. Nunca afirmar «enviado» a partir de `pending`, `queued` o `sending`.

Un offset numérico representa la hora local indicada y debe coincidir con la zona IANA en esa fecha; esto evita horarios inexistentes o desplazados por cambios de horario. `Z` representa un instante UTC que se presenta en la zona indicada. El servidor devuelve `sendAt` UTC, `localSendAt` y `timezone` para que la persona pueda verificarlo.

Ejemplo de referencia, **con fecha fija ilustrativa que debe sustituirse por la fecha futura confirmada**:

```json
{"name":"schedule_message","arguments":{"to":"ID_PERSONA","text":"Nos vemos en la reunión","send_at":"2026-10-05T10:00:00-05:00","timezone":"America/Bogota","idempotency_key":"reunion-20261005-001"}}
{"name":"schedule_whatsapp","arguments":{"phone":"+573001234567","account":"ID_NUMERO_EMISOR","text":"Nos vemos en la reunión","send_at":"2026-10-05T10:00:00-05:00","timezone":"America/Bogota","idempotency_key":"reunion-wa-20261005-001"}}
```

No se ejecutan estos ejemplos durante el despliegue ni las pruebas.

## Consulta, cambios y estado

Ambas listas aceptan `status` (`pending`, `queued`, `sending`, `sent`, `failed`, `cancelled`, `all`) y `limit` (1–100). El valor por defecto es `pending`; chaggu no usa el estado `queued`. La respuesta contiene `schedules` y `hasMore`. Es una consulta limitada de los registros más recientes, sin cursor de paginación.

| Estado | Qué significa |
| --- | --- |
| `pending` | Guardado y esperando su fecha. |
| `queued` | Solo WhatsApp: el worker lo entregó a la cola, aún no hay confirmación del proveedor. |
| `sending` | El proceso de envío lo tomó; puede estar en curso. |
| `sent` | chaggu confirmó su mensaje, o el puente confirmó el envío a WhatsApp. Incluye `messageId` cuando está disponible; no significa que el destinatario lo leyó. |
| `failed` | No se pudo completar. Se conserva el error disponible y requiere revisión. |
| `cancelled` | Cancelado antes de que empezara el envío. |

Las ediciones reciben `id` y `text`, `send_at` + `timezone`, o solo `timezone` para cambiar la presentación del mismo instante. Solo se editan pendientes. No cambian el destinatario ni la cuenta emisora. Para reintentar uno fallido se crea una nueva programación con una nueva llave.

Las cancelaciones reciben `id` y son idempotentes. Se puede cancelar un pendiente o fallido; también un WhatsApp `queued` si el puente todavía no lo ha tomado. `sending` y `sent` ya no se pueden cancelar. La operación coordina el registro y su fila de cola para impedir un envío después de una cancelación confirmada.

## Permisos y operación

- Chaggu: crear/editar/cancelar requieren `chats:write`; listar, `chats:read`. WhatsApp: las cuatro operaciones requieren `whatsapp:send`.
- Cada token solo gestiona las programaciones que creó. Otro token de la misma persona no obtiene esos textos ni puede modificarlos. Los permisos se revisan al crear, consultar, cambiar y ejecutar; una instantánea antigua no conserva autorización.
- La revocación, vencimiento o pérdida de scope del token impide nuevos envíos. También se revisan el usuario activo, la membresía/permisos del chat, el número emisor, los permisos de integración y Chat Lock. WhatsApp vuelve a comprobar la autorización inmediatamente antes de la llamada al proveedor.
- Si el destino deja de estar disponible, la lista devuelve únicamente un recibo mínimo con `restricted: true`, sin texto ni destino. El mismo token vigente puede cancelarlo. Esto permite retirar una programación aunque se haya desconectado el número o se haya retirado el acceso al chat.
- El worker revisa los vencidos periódicamente (15 segundos); la hora es el momento mínimo previsto, no una garantía de entrega al segundo. Se necesita que el servidor y, para WhatsApp, el puente estén operativos. Los errores de autorización dejan un recibo fallido; no se reactivan automáticamente cuando vuelven los permisos.
- El recibo diferencia la cola del envío confirmado. Una caída después de un envío externo puede dejar un resultado incierto; no se debe crear otra programación a ciegas. Primero se verifica la conversación.
- Esta entrega no añade recurrencia, adjuntos programados ni nuevas pantallas móviles. El conector usa el mismo endpoint y requiere refrescar el catálogo del cliente para descubrir las herramientas.

## Implementación y validación

`mcp.ts` publica las herramientas. `mcp-scheduled.ts` gestiona permisos, recibos, idempotencia y WhatsApp; `mcp-schedule-time.ts` valida instantes y zonas. La migración `102_mcp_scheduled.sql` incorpora el token/zona al programador nativo, la tabla `mcp_whatsapp_schedules` y el registro persistente `mcp_schedule_keys`. El estado del outbox actualiza el recibo de WhatsApp dentro de la misma transacción.

`apps/api/test/mcp-scheduled.test.ts` usa HTTP real y la base local dedicada `chaggu_mcp_scheduled_20261004`; rechaza otros hosts/bases. Prueba catálogo/scopes, creación/lista/edición/cancelación, concurrencia, ausencia de publicación temprana, permisos revocados/vencidos, eliminación de cuentas y separación entre cola/envío. La confirmación de WhatsApp se simula en el outbox; no se abre una sesión Baileys ni se envían mensajes reales. `mcp-scheduled-wa-delivery.test.ts` usa un proveedor falso para comprobar errores y confirmaciones de envío, incluso si falla después el registro local del historial. Las pruebas de fechas y cambio de horario están en `mcp-schedule-time.test.ts`.
