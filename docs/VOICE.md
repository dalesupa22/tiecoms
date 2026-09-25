# Notas de voz

Una nota de voz es un adjunto (`POST /api/v1/conversations/:id/attachments`) con `x-voice-note: 1`, `x-duration-ms` y, opcional,
`x-waveform` (≤ 64 valores 0–1 separados por comas). Al enviarse en un mensaje, el worker corre `voice.transcribe`:

1. Si el original no suena en todas partes (webm/ogg/flac), genera una variante **AAC m4a** mono 24 kHz 32 kbps con ffmpeg
   (`-map_metadata -1 -fflags +bitexact -flags:a +bitexact -movflags +faststart`: reproducible, mismos bytes para la misma entrada).
   `url` sirve esa variante; `?original=1` el archivo subido.
2. Convierte a PCM LINEAR16 16 kHz mono, lo parte en trozos de ≤ 11 MB (≈ 15 MB en base64) y llama a **Inworld STT**
   (`inworld/inworld-stt-1`) con el idioma del autor (`es-CO` / `en-US`).
3. Opcional, **DeepSeek** (`deepseek-chat`): resumen de una línea si dura > 45 s y `suggestedIssue` si pide una tarea.
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
