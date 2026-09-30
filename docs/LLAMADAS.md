# Llamadas de voz y video (Amazon Chime SDK)

Llamadas individuales y grupales dentro de cualquier conversación: directos, chats y grupos. La transcripción se prende y apaga durante la llamada, y al final puede haber un resumen con IA.

## Costos (verificados el 28-sep-2026)

- **Sin mensualidad ni activación.** Se paga solo el consumo.
- **Chime:** US$0.0017 por persona-minuto, cobrado cada 6 s. Ejemplos:
  - 2 personas durante 30 min: US$0.10;
  - 5 personas durante 1 hora: US$0.51.
- **Transcribe:** US$0.01 por minuto de llamada con la transcripción prendida.
  - Es un solo flujo por llamada, sin importar cuántas personas haya.
  - El nivel gratis da 60 min al mes durante 12 meses.
- **Resumen con DeepSeek:** fracciones de centavo por llamada. Solo se genera si quien prendió la transcripción lo autorizó.

## Cómo funciona

- **Una llamada activa por conversación.**
  - `POST /conversations/:id/call` la empieza o entra a la que está en curso.
  - La reunión de Chime usa `ClientRequestToken = id de la llamada`: dos personas que llaman a la vez caen en la misma.
- **Presencia:**
  - El cliente manda un latido cada 30 s (`/calls/:id/heartbeat`).
  - El worker (`reapCalls`, cada 15 s) saca a quien lleva 75 s sin latir.
  - Cuando la llamada queda vacía, el worker la cierra y borra la reunión en Chime.
- **Eventos y avisos:**
  - `call.updated` (evento de la conversación) informa quién está y si se transcribe.
  - `call.ringing` (evento de la cuenta) avisa a los demás miembros, salvo a quien tiene No molestar.
- **Transcripción:**
  - `POST /calls/:id/transcription {on, aiSummary}` llama a `Start/StopMeetingTranscription`. Transcribe detecta es-US o en-US y prefiere español.
  - Los clientes reciben las frases por el SDK y mandan las finales a `POST /calls/:id/transcript`, que las deduplica por `resultId`.
  - Todos en la llamada ven «Se está transcribiendo».
  - En el chat queda quién la prendió o la apagó.
- **Al colgar:**
  - En el chat quedan los mensajes «Terminó la llamada · m:ss» y «Quedó guardada la transcripción · Ver transcripción».
  - Si se autorizó el resumen, se encola el job `call.summary`.
- **Pestaña «Llamadas»:** historial en `GET /calls`, detalle con resumen y transcripción, y «Compartir»:
  - enviar a otro chat (`POST /calls/:id/share`, sale como mensaje de quien comparte);
  - compartir con el sistema (Web Share);
  - copiar;
  - descargar .txt.
- **Quién ve una llamada terminada:** quien estuvo en ella, o quien tiene su mensaje dentro de su historial visible.

## Variables

| Variable | Valor |
|---|---|
| `CALLS_ENABLED` | `true` para prenderlas. Sin ella: 503 `calls_disabled` y `features.calls=false` en el bootstrap, así que no aparecen botones ni pestaña. |
| `CALLS_PROVIDER` | `fake` para pruebas y desarrollo sin AWS. |
| `CHIME_CONTROL_REGION` | Por defecto `us-east-1`. |
| `CHIME_MEDIA_REGION` | Por defecto `us-east-1`, la más cercana a Colombia. `sa-east-1` también existe. |
| `CALLS_TRANSCRIBE_LANGUAGES` | Por defecto `es-US,en-US`. |
| `CALLS_TRANSCRIBE_PREFERRED` | Por defecto `es-US`. |
| `CALLS_TRANSCRIBE_REGION` | Por defecto `auto`. |

Las llaves AWS son las mismas del servidor, las del usuario IAM de S3. A ese usuario le faltan estos permisos:

```
chime:CreateMeeting, chime:DeleteMeeting, chime:GetMeeting, chime:CreateAttendee,
chime:StartMeetingTranscription, chime:StopMeetingTranscription,
transcribe:StartStreamTranscription, iam:CreateServiceLinkedRole (para AWSServiceRoleForAmazonChimeTranscription)
```

## Antes de prenderlas en producción

1. Dar a IAM los permisos de arriba. La primera transcripción crea el rol vinculado `AWSServiceRoleForAmazonChimeTranscription`.
2. **Apps móviles:** las publicadas muestran el JSON crudo de los mensajes de sistema nuevos (`call.started`, `call.ended`, `call.transcription.on/off`, `call.transcript`). Hay que publicar iOS/Android con esos textos, y con las llamadas nativas (SDK de Chime para iOS/Android), antes de `CALLS_ENABLED=true`.
3. **Privacidad:** por defecto, AWS puede usar el audio de Transcribe para mejorar sus servicios. Se evita con una política de exclusión de servicios de IA en AWS Organizations.
4. En Colombia hay que avisar que se transcribe (Ley 1581). La app lo muestra a todos y lo deja escrito en el chat.

## Pruebas

```
API con CALLS_ENABLED=true CALLS_PROVIDER=fake
API_URL=http://localhost:<puerto> npx vitest run test/calls.test.ts
```

## Transcripción con Groq Whisper (desde el 29-sep-2026, por defecto)

Pedido de Danny: la opción más barata. Groq cobra ≈ US$0.04 por hora de audio con voz y mínimo 10 s por petición. Una llamada transcrita de una hora cuesta ≈ US$0.05, frente a los US$0.60 de Transcribe.

- **Prender o apagar** sigue siendo `POST /calls/:id/transcription {on, aiSummary}`. Con Groq no se llama a Chime: solo cambia el estado. `CALLS_STT=chime` vuelve a Amazon Transcribe.
- **Cada dispositivo graba su propio micrófono**, en una pista aparte con cancelación de eco, mientras la transcripción está prendida.
  - Los pedazos duran de 12 a 20 s: se corta en el primer silencio después de 12 s, y a los 20 s como máximo.
  - Un pedazo solo se manda si tiene ≥ 0,8 s de voz (RMS > 0,015) y el micrófono no está silenciado.
  - Se envía a `POST /calls/:id/audio` como `application/octet-stream`, con las cabeceras `x-file-type` (audio/webm, audio/mp4…), `x-seg-id` (id del cliente: reintentar no duplica), `x-offset-ms` (desde el inicio de la llamada) y `x-duration-ms`.
- **En el servidor:**
  1. Avisa `call.processing {callId, userId, segId}` por la cuenta a quienes están dentro. Los clientes muestran «⏳ Procesando…» con el nombre.
  2. Transcribe con `whisper-large-v3-turbo` (`verbose_json`), con la pista de ortografía `CALLS_STT_VOCAB` + los nombres de la llamada + el nombre del chat.
  3. Filtra las alucinaciones típicas de Whisper en silencio.
  4. Guarda las frases con `speaker` = quien mandó el pedazo.
  5. Envía `call.transcript {callId, userId, segId, segments[]}`.
- **Variables:** `GROQ_API_KEY` (se sube con `tiecoms/.secrets/push-groq-env.sh`), `GROQ_STT_MODEL` y `GROQ_STT_URL`. En pruebas, `CALLS_STT_PROVIDER=fake`.

## Agregar personas a la llamada

- `POST /calls/:id/invite {userIds}`. Quien agrega tiene que estar dentro, y solo puede agregar gente con la que comparte empresa o espacio.
- **Si la persona está en el chat**, solo le vuelve a sonar.
- **Si no está en el chat**, queda en `call_invites` (migración 036) y tiene acceso a ESA llamada: entrar (`/calls/:id/join`), latir, mandar audio, historial y detalle. No tiene acceso a los mensajes.
  - Los cambios de la llamada le llegan por la cuenta, en `call.updated {call}`.
  - `CallDTO.invitedUserIds` y `CallDTO.names` traen los nombres de quienes no están en su lista de personas.

## Quién ve la llamada: huddle de la empresa (29-sep-2026)

Pedido de Danny: las llamadas funcionan como los huddles de Slack. Por ahora solo las ve la empresa de quien la empezó.

- En un chat con gente de otras empresas, a esas personas:
  - no les suena;
  - no la ven en curso (ni en `/calls/active`, ni en `GET /conversations/:id/call`, ni con el punto verde);
  - no la ven en el historial y no pueden abrirla ni entrar (404).
- En ese chat, `call.updated` no va por la conversación, porque lo recibirían todos. Va por la cuenta de cada persona de la empresa (los clientes 1.7.1 ya lo manejan).
- En ese chat tampoco se dejan los mensajes de sistema: empezó, terminó, transcripción prendida o apagada, y «Ver transcripción».
- Si alguien de la otra empresa intenta llamar mientras está la llamada, recibe `409 call_busy`.
- Excepciones:
  - quien la agregaron con «＋ Agregar» la ve y puede entrar;
  - en un chat directo la ven los dos, aunque sean de empresas distintas.
- Implementación: `seesCallSql` / `callAudience` / `callNote` en `apps/api/src/modules/calls.ts`. Pruebas en `apps/api/test/calls-huddle.test.ts`.

## Push de llamada entrante

- Job `push.call`: `category` es `TC_CALL` y `data` es `{type: 'call', callId, conversationId, kind}`. Sale con el título de quien llama y el texto «📞 Te está llamando».
- No sale con «No molestar» ni en modo sueño.
- Las apps muestran Contestar / Ahora no y entran con `/calls/:id/join`.

## Varios dispositivos, altavoz y llamadas en curso (1.7.1, 29-sep-2026)

Pedido de Danny. César lo llamó, contestó en el iPhone y el PC siguió sonando.

- **Un attendee por dispositivo.**
  - `CreateAttendee` usa `ExternalUserId = "{userId}#{deviceKey}"`, donde `deviceKey` son los primeros 8 caracteres del id de sesión o de dispositivo; en total son como mucho 45 caracteres.
  - Así la misma persona puede estar en la llamada desde dos dispositivos sin que Chime saque al primero (antes, reusar el attendee daba `AudioJoinedFromAnotherDevice`).
  - Los clientes toman el id de la persona con `externalUserId.split('#')[0]`, tanto para los nombres y quién habla como para la transcripción; el API también acepta el id sin `#`.
  - Migración 038: `call_participants` pasa a tener la clave `(call_id, user_id, device_key)`, con el latido por dispositivo.
  - `CallDTO.activeUserIds` sigue con las **personas** (sin repetir). Se agrega `CallDTO.myDevices?: { deviceKey, platform, label }[]`, solo con los míos.
- **Contestar o rechazar se coordina entre mis dispositivos.**
  - Al entrar (`join`/`startOrJoin`), el servidor manda a **mis otras sesiones** por la cuenta `call.answered { callId, deviceKey, platform, label }`. Esos dispositivos dejan de sonar y cierran el aviso y la notificación.
  - `POST /calls/:id/decline` (nuevo) manda `call.declined { callId }` a mis sesiones. Todas dejan de sonar. Para los demás no cambia nada: si nadie contesta, la llamada termina sola.
  - En iOS y Android, al recibir `call.answered` o `call.declined`, también se quita la notificación push de esa llamada (collapseId `call-{id}`). El push de llamada lleva `callId` para identificarla.
- **«Llamada en curso en otro dispositivo».** Si estoy en una llamada en un dispositivo, los demás muestran una franja fija arriba: «📞 En llamada en tu iPhone · {chat}», con dos botones:
  - **Pasar aquí:** entra desde este dispositivo y, cuando conecta, llama a `POST /calls/:id/leave {deviceKey: el otro}`, que saca solo a ese dispositivo.
  - **Unirme también.**
  - El estado sale de `CallDTO.myDevices` en `call.updated` y del bootstrap (`BootstrapDTO.myActiveCall?: CallDTO`).
- **Llamadas en curso.**
  - `GET /calls/active` devuelve las llamadas sin terminar de mis conversaciones (y a las que me invitaron): `CallDTO` con `activeUserIds` y el título.
  - **Web:** en la pestaña Llamadas, una sección «En curso ahora» arriba del historial, con avatares de quién está y el botón Unirse. Además, un punto verde 📞 junto a la conversación en la lista lateral, sacado de `calls[convId]` o de `call.updated`.
  - **Móvil:** la misma sección en la pestaña Llamadas.
- **Altavoz.**
  - **iOS:** botón 🔊 en la pantalla de llamada. Por defecto va el auricular en voz y el altavoz en video. Alterna con `overrideOutputAudioPort(.speaker/.none)` o con la lista de dispositivos de audio de Chime (`listAudioDevices`/`chooseAudioDevice`), mostrando Bluetooth y audífonos si hay.
  - **Android:** lo mismo con `audioVideo.listAudioDevices()` y `chooseAudioDevice(...)` de Chime (auricular, altavoz, Bluetooth, cable).
  - **Web:** menú «Salida de audio» con `chooseAudioOutput` del SDK (`setSinkId`) donde el navegador lo permita, y micrófono con `listAudioInputDevices`.

### Implementación 1.7.1 (API y web, 29-sep-2026)

- **Contrato** (`contratos 1.7.1`, `CONTRACT_VERSION = '2026-09-29.1'`): `CallDeviceKey`, `LEGACY_DEVICE_KEY = 'legacy'`, `callUserId(externalUserId)`, `StartCallInput.deviceKey`, `CallDeviceInput { deviceKey? }` para `join`, `heartbeat` y `leave`, `CallDeviceDTO`, `CallDTO.myDevices`, `ActiveCallDTO { call, title }`, `BootstrapDTO.myActiveCall` y los eventos de cuenta `call.answered { callId, conversationId, deviceKey, platform, label }` y `call.declined { callId, conversationId }`.
- **La llave la manda el cliente** (`deviceKey`: en la web, los primeros 8 caracteres del id de dispositivo). Sin llave (clientes 1.7.0) es `'legacy'`: el attendee queda con `ExternalUserId = userId` como antes. `platform` y `label` salen de la sesión que entra.
- **`myDevices`** solo viaja por la cuenta: después de cada `call.updated` de la conversación, cada persona que estuvo en la llamada recibe por su cuenta la misma llamada con sus dispositivos. El cliente conserva el último `myDevices` cuando el evento de la conversación no lo trae. `call.answered` llega a todas mis sesiones (incluida la que entra): se ignora si `deviceKey` es el propio.
- **«＋ Agregar» con estado** (pedido aparte): `CallDTO.invited?: { userId, at, joined }[]` (tabla `call_rings`, migración 038). Cada `POST /calls/:id/invite` renueva `at` y vuelve a sonar (el push de llamada ya no se deduplica en un segundo intento). La web muestra el botón con texto «＋ Agregar» en la barra de la llamada, en la franja «En llamada en tu …» y en cada tarjeta de «En curso ahora»; en el panel, los invitados que no han entrado salen «Llamando…» y, a los 45 s, «No contestó» con «Volver a llamar».
- **Cámara en plena llamada (web):** `toggleCamera` prende o apaga el recuadro local sin reconectar (`startVideoInput` + `startLocalVideoTile`; al apagar, `stopLocalVideoTile` y mi recuadro vuelve al avatar). Con al menos un video el panel pasa a cuadrícula con **todas** las personas: quien no tiene cámara se ve como avatar dentro de la cuadrícula. Cada persona lleva los indicadores de cámara apagada y micrófono silenciado (`realtimeSubscribeToVolumeIndicator`, `muted` por attendee; con varios dispositivos, silenciada si lo están todos).
- **Audio (web):** botón 🔊 en la barra con «Salida de audio» (`listAudioOutputDevices` / `chooseAudioOutput`, solo donde existe `setSinkId`; si no, lo dice) y «Micrófono» (`listAudioInputDevices` / `startAudioInput`).
- **Web, resto:** «Ahora no» llama a `POST /calls/:id/decline`; `call.answered` de otro dispositivo o `call.declined` cierran el aviso, el tono y la notificación del sistema. Franja fija «📞 En llamada en tu iPhone · {chat}» con Pasar aquí / Unirme también / ＋ Agregar. «En curso ahora» arriba del historial (`GET /calls/active`). Punto verde 📞 en la lista lateral (`calls[convId]`, que se llena con `/calls/active` tras el arranque y con `call.updated`).

## Compartir pantalla (desde el 30-sep-2026)

- Botón 🖥️ en la llamada (web, Mac y Windows; no en móviles, que no tienen `getDisplayMedia`). Usa `startContentShareFromScreenCapture` de Chime a 15 cuadros por segundo: un recuadro de contenido aparte, sin tocar la cámara.
- La persona elige pantalla, ventana o pestaña en el selector del navegador o del sistema. Cancelar no es error. Si deja de compartir desde la barra del sistema, `contentShareDidStop` apaga el botón.
- Los demás ven la pantalla grande (el panel se agranda a 960 px) y con pantalla completa. La propia no se muestra (el recuadro de contenido cuyo attendee empieza por el mío se ignora).
- En Chime la pantalla es otro attendee, `{attendeeId}#content`, con externalUserId `{externalUserId}#content`: `callUserId` da la persona. Cobra como una persona más mientras se comparte.
- Escritorio (Tauri): `on_permission_request` autoriza micrófono, cámara y captura de pantalla solo a la interfaz empaquetada. macOS pide una vez el permiso «Grabación de pantalla» para chaggu.

## Invitados por enlace (desde el 30-sep-2026, migración 044)

- Quien está dentro toca 🔗 «Enlace para invitados»: `POST /calls/:id/link` crea el enlace `https://app.chaggu.com/llamada/<token>` y se copia. `DELETE /calls/:id/link` lo quita (quien ya entró sigue).
- El invitado abre `/llamada/<token>` sin cuenta, escribe su nombre y entra con voz o video; puede silenciarse, prender la cámara y compartir pantalla.
- API público (sin sesión, con límite de peticiones):
  - `GET /call-links/:token`: título (no en chats directos), quién invita y su empresa, y si hay alguien dentro. No devuelve ids de la conversación.
  - `POST /call-links/:token/join {name}`: crea el attendee `guest:{id}` y devuelve la reunión, el `guestId` y un `secret`.
  - `POST /call-guests/:id/heartbeat {secret}` cada 15 s (también trae quién está: el invitado no tiene socket) y `/leave`.
- Reglas:
  - Del token y del secreto solo se guarda el hash (`call_links`, `call_guests`).
  - Máximo 10 invitados a la vez. El enlace muere cuando la llamada termina.
  - Los invitados no sostienen la llamada: cuando sale el último de chaggu, termina y se les corta.
  - A los 45 s sin latir, el worker los saca.
  - No transcriben su audio (la transcripción con Groq pide sesión).
- `CallDTO.guests` lleva los invitados que están dentro, para que todos vean su nombre.
- Pruebas: `test/calls-guests.test.ts`.


## Salas abiertas (desde el 30-sep-2026, migración 049)

Como «Crear una reunión para después» de Google Meet: un enlace **permanente** que su dueño crea una vez y deja abierto para invitar a quien quiera.

- **Crear:** Agenda › Mis enlaces › «＋ Enlace de reunión», o «＋ Crear» › «Crear enlace de reunión». «Iniciar una reunión ahora» crea la sala, copia el enlace y entra. Con «Programar reunión» se sigue agendando en el calendario como siempre.
- **Enlace:** `https://app.chaggu.com/sala/abc-defg-hij` (10 letras al azar). Cualquiera entra con su nombre, sin cuenta, por voz o video, **aunque el dueño no esté**.
- **Ciclo:** al entrar el primero a una sala vacía se abre una llamada nueva (en el chat «Tú» del dueño, que solo él ve); cuando sale el último (de chaggu o invitado) se cierra. El enlace sigue sirviendo. A diferencia de las llamadas de chat, **los invitados sostienen una sala**. gg le avisa al dueño cuando alguien entra a su sala vacía.
- **API:** `POST /rooms {title}`, `GET /rooms`, `DELETE /rooms/:id` (el enlace deja de servir y se cierra la llamada), `POST /rooms/:id/enter` (el dueño entra desde la app); públicos: `GET /rooms/:code`, `POST /rooms/:code/join {name}`. Mismo límite de 10 invitados.
- **Citas:** cada cita por enlace (`docs/CITAS.md`) crea su propia sala (`source='booking'`), que no aparece en Mis enlaces y se cierra al cancelar la cita.
- Pruebas: `test/rooms.test.ts`.
