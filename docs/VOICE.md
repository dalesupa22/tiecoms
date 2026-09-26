# Notas de voz

Una nota de voz es un adjunto (`POST /api/v1/conversations/:id/attachments`) con `x-voice-note: 1`, `x-duration-ms` y, opcional,
`x-waveform` (≤ 64 valores 0–1 separados por comas). Al enviarse en un mensaje, el worker corre `voice.transcribe`:

1. Si el original no suena en todas partes (webm/ogg/flac), genera una variante **AAC m4a** mono 24 kHz 32 kbps con ffmpeg
   (`-map_metadata -1 -fflags +bitexact -flags:a +bitexact -movflags +faststart`: reproducible, mismos bytes para la misma entrada).
   `url` sirve esa variante; `?original=1` el archivo subido. Sin ffmpeg, la nota queda con el original.
2. **Inworld STT** (`inworld/inworld-stt-1`, síncrono) recibe el ARCHIVO ORIGINAL en base64 con `audioEncoding: 'AUTO_DETECT'`
   (acepta WAV, MP3, OGG, FLAC, M4A y WebM; PCM crudo no) y el idioma del autor (`es-CO` / `en-US`). Solo si el formato no es
   de esos o pesa más de 11 MB (≈ 15 MB en base64), ffmpeg lo pasa a WAV 16 kHz mono en trozos. Así las notas m4a de las apps
   se transcriben aunque no haya ffmpeg. Prueba real (25-sep-2026): m4a AAC 32 kbps de 6,4 s → texto exacto en es-CO.
3. Opcional, **DeepSeek** (`deepseek-chat`, `response_format: json_object`): recibe autor, participantes y conversación;
   resumen de una línea en tercera persona con el autor como sujeto si dura > 45 s, y `suggestedIssue` para pedidos y
   compromisos («el jueves te mando el contrato» → «Enviar el contrato revisado el jueves»).
4. Guarda `transcript` y emite `message.updated` (sin push).

Proveedores detrás de `Transcriber` y `Summarizer` (`apps/api/src/modules/voice-providers.ts`): otro proveedor implementa la interfaz.

## Configuración (`/opt/tiecoms/shared/api.env`, no en git)
```
INWORLD_API_KEY=<llave de Inworld (va tal cual en Authorization: Basic …)>
DEEPSEEK_API_KEY=<opcional>
```
Sin `INWORLD_API_KEY`: `transcript.status = 'disabled'` y la nota se envía y se escucha igual. ffmpeg viene en `infra/Dockerfile.api`
(`FFMPEG_PATH` lo cambia). Solo pruebas: `INWORLD_STT_URL`, `DEEPSEEK_URL` (servidores falsos `test/fake-voice.mjs`) y `test/fake-ffmpeg.mjs`.
Local: el coordinador copia `.secrets/inworld_api_key` y `.secrets/deepseek_api_key` al `.env` de pruebas.

Errores → `failed`; reintento con `POST /api/v1/attachments/:id/transcribe` (autor o quien pueda escribir en la conversación).

## Consentimiento de IA

La app explica los proveedores y los datos antes de cada nota. Solo una aceptación explícita añade `x-ai-consent: 1` a la subida. El servidor guarda esa decisión por adjunto; sin ella (incluidos clientes anteriores) no envía audio ni texto a Inworld o DeepSeek. El audio se envía y puede convertirse a AAC localmente sin IA. El consentimiento no se hereda al reenviar un adjunto.

El reintento `POST /api/v1/attachments/:id/transcribe` exige `{ "aiConsent": true }` y que el autor autorizara IA en la subida original; no permite que otra persona convierta una negativa en aceptación. `POST /api/v1/conversations/:id/return/suggest` solo usa DeepSeek con `{ "aiConsent": true }`; sin ello devuelve las últimas respuestas para editar manualmente.
