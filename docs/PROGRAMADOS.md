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
