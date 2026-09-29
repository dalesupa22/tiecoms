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

## Push de llamada entrante

- Job `push.call`: `category` es `TC_CALL` y `data` es `{type: 'call', callId, conversationId, kind}`. Sale con el título de quien llama y el texto «📞 Te está llamando».
- No sale con «No molestar» ni en modo sueño.
- Las apps muestran Contestar / Ahora no y entran con `/calls/:id/join`.
