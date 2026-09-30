# Videos en el chat y medición de almacenamiento

Pedido de Danny, 29-sep-2026: «quiero mandarle un video a mi amigo… que no ponga lento nada… optimización de
espacio… luego le podemos cobrar al usuario por almacenamiento». Rama `video`. **Migración 043
(`043_video_storage.sql`) es de esta función.**

## Decisiones

| Tema | Decisión | Por qué |
|---|---|---|
| Dónde se comprime | En el cliente (web: Mediabunny + WebCodecs en un Worker; iOS: AVFoundation; Android: Media3 Transformer). | El EC2 es compartido (api 1 CPU / 512 MB, worker 0,5 CPU / 256 MB, disco al 94 %, /tmp en tmpfs). **Nada de ffmpeg ni transcodificación en el servidor.** |
| Formato | MP4 H.264 (avc) + AAC, lado largo ≤ 1280 px (corto ≤ 720), ~2 Mbps de video, 96 kbps de audio, ≤ 30 fps, moov al principio (fastStart). | Se reproduce en todos los navegadores y teléfonos sin transcodificar; fastStart deja arrancar sin bajar el final del archivo. |
| Cuándo no se recodifica | MP4/MOV H.264 + AAC (o sin audio), ≤ 720p, ≤ 31 fps y (≤ 5 MB **o** bitrate ≤ 2,6 Mbps). Si además ya es MP4 con moov al principio se sube tal cual; si no, se reempaqueta sin recodificar (copia de paquetes, segundos). | Recodificar algo ya liviano gasta batería y pierde calidad sin ahorrar espacio. |
| Videos largos | El bitrate baja para que la salida quepa en ~140 MB (mínimo 450 kbps). A 2,1 Mbps caben ~9 min; con el ajuste, ~30 min. | El límite del servidor es 150 MB. |
| Si recodificar no ahorra | Se sube el original si ya es H.264/AAC en MP4/MOV. | Nunca subir algo más grande que el original. |
| Sin WebCodecs / códec no soportado / error | Se sube el original si pesa ≤ 150 MB; si no, el borrador muestra «pesa más de 150 MB incluso comprimido». | Degradar sin bloquear. |
| Subida | Ruta nueva `POST /conversations/:id/videos`: el cuerpo pasa **por stream** a S3 con multipart (`@aws-sdk/lib-storage`, partes de 5 MB, 2 en vuelo ≈ 10 MB de memoria por subida). Nada en disco. | 25 MB en memoria por adjunto no escala a video. El bucket no tiene CORS, así que el navegador no puede hacer PUT directo a S3. |
| Tipo | Por los primeros bytes: `ftyp` (MP4/MOV, sin marcas de audio `M4A`/`M4B` ni de imagen HEIC/AVIF) o EBML con DocType `webm`. MKV se rechaza (el cliente lo convierte a MP4). | Lo declarado no se cree. |
| Reproducción | `GET /attachments/:id/play` → URL prefirmada de S3 (1 h, `inline`). El `<video>` pide rangos directo a S3. **El API no sirve los bytes del video.** | Arranque inmediato y cero carga en el API. |
| Contrato | `kind` sigue siendo `'file'` en videos; se agregan `durationMs` y `playUrl`. | Las apps publicadas decodifican `kind` como `'file' \| 'voice'`: un valor nuevo podría romper el mensaje entero. |
| Clientes viejos | `GET /attachments/:id` de un video (o de cualquier archivo > 8 MB) ya no carga el objeto en memoria: lo sirve por stream desde S3 y reenvía el `Range`. | Las apps sin `/play` siguen funcionando sin arriesgar el contenedor de 512 MB. |
| Almacenamiento | Solo medición (`/me/storage`, `/organizations/:id/storage`). No bloquea ni cobra nada todavía. | Primero medir; el cupo y el precio vienen después. |

## Contrato

Todas las rutas exigen `Authorization: Bearer`. Las constantes están en `packages/contracts`:
`MAX_VIDEO_BYTES = 150 MB` (los demás adjuntos siguen en `MAX_ATTACHMENT_BYTES = 25 MB`).

### `POST /api/v1/conversations/:id/videos` — subir un video

- Cuerpo: los bytes del video, crudos (`content-type: video/mp4` u `application/octet-stream`; el API no lo interpreta).
  Se recomienda mandar `content-length`: con más de 150 MB responde 413 sin leer el cuerpo.
- Cabeceras opcionales (enteros): `x-file-name` (URI-encoded), `x-duration-ms` (0–6 h), `x-width`, `x-height`
  (tamaño **en pantalla**, ya rotado; 0–16384).
- Acceso: `conversationAccess(..., 'post')` (quien no puede escribir recibe 404). Límite: 20 por minuto.
- Respuestas: `200` con `AttachmentDTO` (pendiente, igual que cualquier adjunto) · `413 too_large` (> 150 MB, también si
  llega por partes sin `content-length`) · `415 not_video` · `400` (cabeceras inválidas) · `404` · `401`.
- Después: `POST /attachments/:id/thumb` con el póster (JPEG/PNG/WebP ≤ 512 KB), y enviar el mensaje con
  `attachmentIds: [id]` como siempre (`claimForMessage`). Pendientes sin usar se limpian a las 24 h.

`AttachmentDTO` de un video:

```jsonc
{
  "id": "…", "name": "Paseo.mp4", "contentType": "video/mp4", "sizeBytes": 3246112,
  "width": 1280, "height": 720,            // del cliente
  "durationMs": 12000,                      // del cliente (puede ser null en videos viejos)
  "url": "/api/v1/attachments/…",           // sigue sirviendo (por stream), solo para apps viejas
  "thumbUrl": "/api/v1/attachments/…/thumb",// el póster, si se subió
  "playUrl": "/api/v1/attachments/…/play"   // NUEVO: úsalo para reproducir
  // sin "kind" (= 'file')
}
```

Los videos subidos antes por `POST /attachments` (tipo `video/*`) también traen `playUrl`. Mensajes guardados antes de
este cambio no lo traen en su copia JSON: el cliente puede armar `/api/v1/attachments/{id}/play` si `contentType`
empieza por `video/`.

### `GET /api/v1/attachments/:id/play[?download=1]` — URL para reproducir

Mismo acceso que `GET /attachments/:id` (pendiente: solo su dueño; enviado: quien lee el chat dentro de su historial;
una sola vista: 403). Solo videos (400 si no). Responde `{ url, expiresIn: 3600, contentType }` con
`cache-control: no-store`. La URL es de S3 con `response-content-disposition=inline` (o `attachment` con
`?download=1`). El cliente la guarda en caché hasta poco antes de vencer y pide otra si el reproductor falla.

### `GET /api/v1/me/storage` y `GET /api/v1/organizations/:id/storage`

```jsonc
{
  "scope": "user",            // o "organization"
  "id": "…", "totalBytes": 1288490188, "objects": 213,
  "breakdown": { "videos": 838860800, "photos": 314572800, "files": 125829120, "voice": 9227468 },
  "bySource": { "chat": 1200000000, "drive": 88490188 },
  "people": 12,               // solo en organization
  "measuredAt": "2026-09-29T…Z"
}
```

- Cuenta adjuntos del chat (incluye pendientes: ocupan espacio hasta la limpieza) y archivos del árbol (`files` con
  `purpose = 'document'`). Lo borrado (`deleted_at`) no cuenta.
- **Cada `s3_key` cuenta una vez**: reenviar crea otra fila con el mismo objeto; la cuenta la lleva la primera fila viva
  de ese objeto (orden `created_at, id`). Si el original se borra y queda un reenvío vivo, pasa a contar para quien
  reenvió (el objeto sigue ocupando espacio).
- Categorías: `voice` = notas de voz (`kind = 'voice'`); `videos` = `video/*`; `photos` = `image/*`; el resto `files`.
- Empresa = personas cuya **empresa principal** (`users.primary_org_id`) es esa. Solo owner/admin (403 a los demás
  miembros, 404 a quien no es de la empresa). Límite: 30 por minuto.
- No se cuentan las miniaturas ni la variante AAC de las notas de voz (pesan poco y no guardamos su tamaño).
- Índices en la migración 043: `attachments_owner_live` y `users_primary_org`. Las sumas se calculan al vuelo; si un día
  pesa, se materializa por persona en un job nocturno.

## Web (hecho)

- `apps/web/src/video.ts`: funciones puras (`planVideo`, `targetSize`, `targetVideoBps`, `formatDuration`,
  `formatBytes`, `moovBeforeMdat`), probadas en `apps/web/test/video.test.ts`.
- `apps/web/src/video-worker.ts`: Worker con Mediabunny (su propio chunk de ~570 KB; solo se descarga al adjuntar un
  video). Lee pistas, duración, tamaño en pantalla y fps; decide; comprime con `allowTransformationMetadata: false`
  (la rotación queda en los píxeles); saca el póster (cuadro del segundo 1, lado largo 480, JPEG ≤ 512 KB) **antes** de
  comprimir para mostrarlo en la tarjeta pendiente.
- `apps/web/src/video-prep.ts`: orquesta el Worker (se carga con `import()`), cancela con `AbortSignal` y cae al
  original con póster y duración sacados de un `<video>` local.
- Compositor: tarjeta pendiente con póster, «Comprimiendo… 40 %» → «Subiendo… 70 %» (XHR con progreso) y × para
  cancelar; al terminar, «🎬 0:12 · 3,1 MB».
- Burbuja: tarjeta con póster perezoso (IntersectionObserver), ▶, duración y tamaño, proporción real (9:16 a 16:9).
  **Se reproduce ahí mismo**: al tocar ▶ se monta el `<video preload="metadata" playsInline controls>` con la URL
  prefirmada (antes no se descarga nada del video). Uno a la vez (arrancar otro pausa el anterior); se pausa al salir de
  la vista y se desmonta al cambiar de chat; si la URL vence o falla, pide otra una vez y sigue donde iba. ⤓ descarga con
  la URL `attachment`.
- Ajustes › Almacenamiento: «Almacenamiento usado: 1,2 GB · videos 800 MB · fotos … · archivos … · notas de voz …» con
  barra por categoría y, para admins, la línea de su empresa.

## iOS (pendiente, para el agente de iOS)

1. **Elegir**: `PHPickerViewController` con `filter: .videos` (o `.any(of: [.images, .videos])`); cargar con
   `itemProvider.loadFileRepresentation(forTypeIdentifier: UTType.movie.identifier)` y copiar el archivo a
   `FileManager.default.temporaryDirectory` antes de que el callback termine.
2. **Decidir** con la misma regla que la web (`planVideo`): leer con `AVURLAsset`
   (`try await asset.load(.duration)`, pista `try await asset.loadTracks(withMediaType: .video).first`,
   `naturalSize.applying(preferredTransform)` en valor absoluto = tamaño en pantalla, `nominalFrameRate`,
   `formatDescriptions` → `CMFormatDescriptionGetMediaSubType == kCMVideoCodecType_H264`). Los videos del iPhone suelen
   ser HEVC 1080p/4K a 30/60 fps: casi siempre se recodifican.
3. **Comprimir** (simple y suficiente): `AVAssetExportSession(asset:, presetName: AVAssetExportPreset1280x720)`,
   `outputFileType = .mp4`, `shouldOptimizeForNetworkUse = true` (moov al principio),
   `fileLengthLimit = 140 * 1024 * 1024`. El preset conserva la orientación (aplica `preferredTransform`) y produce H.264
   + AAC. Para ≤ 30 fps pon `videoComposition = AVMutableVideoComposition(propertiesOf: asset)` con
   `frameDuration = CMTime(value: 1, timescale: 30)` si `nominalFrameRate > 31`.
   Si se necesita controlar el bitrate exacto (~2 Mbps, 96 kbps), usar `AVAssetReader` + `AVAssetWriter` con
   `AVVideoCodecKey: .h264`, `AVVideoWidthKey/HeightKey` del tamaño objetivo (lado largo 1280, corto 720, pares),
   `AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 2_000_000, AVVideoMaxKeyFrameIntervalKey: 60,
   AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel]`, audio `kAudioFormatMPEG4AAC` 96 000 bps 44,1/48 kHz,
   `writer.shouldOptimizeForNetworkUse = true`, y `input.transform = videoTrack.preferredTransform` para conservar la
   orientación. Progreso: `exportSession.progress` (o segundos escritos / duración) → «Comprimiendo… 40 %».
4. **Póster**: `AVAssetImageGenerator(asset:)` con `appliesPreferredTrackTransform = true`,
   `maximumSize = CGSize(width: 480, height: 480)`, `requestedTimeToleranceBefore/After = .zero` opcional;
   `try await generator.image(at: CMTime(seconds: min(1, duración/2), preferredTimescale: 600))` →
   `UIImage(cgImage:).jpegData(compressionQuality: 0.8)` (bajar a 0,6 si pasa de 512 KB).
5. **Subir**: `URLSession.uploadTask(with: request, fromFile: url)` a `POST /api/v1/conversations/{id}/videos` con
   `content-type: video/mp4`, `x-file-name`, `x-duration-ms`, `x-width`, `x-height` (tamaño en pantalla del archivo
   final). Progreso con `urlSession(_:task:didSendBodyData:totalBytesSent:totalBytesExpectedToSend:)` → «Subiendo… 70 %».
   Para que siga en segundo plano, usar una `URLSessionConfiguration.background` (exige subir desde archivo). Luego
   `POST /attachments/{id}/thumb` con el JPEG y enviar el mensaje con `attachmentIds`.
6. **Reproducir en la burbuja**: tarjeta con póster (`thumbUrl`, con Bearer), ▶, `formatDuration(durationMs)` y tamaño.
   Al tocar: `GET playUrl` → `AVPlayer(url:)` con la URL de S3 (sin cabeceras; AVPlayer pide rangos solo) en un
   `AVPlayerLayer`/`VideoPlayer` dentro de la celda. Un solo `AVPlayer` activo a la vez; pausar al salir la celda
   (`didEndDisplaying`) y al cambiar de chat. Caché de la URL hasta `expiresIn - 5 min`; si `AVPlayerItem.status ==
   .failed`, pedir otra y `seek` a donde iba. Pantalla completa: `AVPlayerViewController`.
7. Borrar los temporales al terminar o cancelar.

## Android (pendiente, para el agente de Android)

1. **Elegir**: Photo Picker (`ActivityResultContracts.PickVisualMedia(PickVisualMedia.VideoOnly)`), `Uri` de contenido.
2. **Decidir** con la misma regla: `MediaMetadataRetriever` (`METADATA_KEY_DURATION`, `VIDEO_WIDTH/HEIGHT`,
   `VIDEO_ROTATION` → si 90/270 se invierten, `CAPTURE_FRAMERATE`) y `MediaExtractor` para el códec
   (`MediaFormat.KEY_MIME == "video/avc"` y audio `"audio/mp4a-latm"`).
3. **Comprimir con Media3 Transformer** (`androidx.media3:media3-transformer` y `media3-effect`, misma versión que
   `media3-exoplayer`, ≥ 1.4):
   ```kotlin
   val encoder = DefaultEncoderFactory.Builder(context)
       .setRequestedVideoEncoderSettings(VideoEncoderSettings.Builder().setBitrate(2_000_000).build())
       .setEnableFallback(true)
       .build()
   val edited = EditedMediaItem.Builder(MediaItem.fromUri(uri))
       .setEffects(Effects(
           /* audio */ listOf(),
           /* video */ listOf(
               Presentation.createForShortSide(720),               // lado corto 720 → lado largo ≤ 1280 en 16:9
               FrameDropEffect.createDefaultFrameDropEffect(30f),  // ≤ 30 fps
           ),
       ))
       .build()
   Transformer.Builder(context)
       .setVideoMimeType(MimeTypes.VIDEO_H264)
       .setAudioMimeType(MimeTypes.AUDIO_AAC)
       .setEncoderFactory(encoder)
       .setMuxerFactory(InAppMp4Muxer.Factory())  // escribe el moov al principio (salida «streamable»)
       .addListener(listener)
       .build()
       .start(edited, outputFile.absolutePath)     // outputFile en cacheDir, .mp4
   ```
   Media3 conserva la orientación (aplica la rotación del archivo). El audio sale en AAC; si la versión de Media3 expone
   `AudioEncoderSettings`, pedir 96 000 bps; si no, el valor por defecto (~128 kbps) está bien. **Comprobar** en una
   prueba que el `moov` va antes que `mdat` (misma lógica que `moovBeforeMdat` de la web, o `ffprobe -v trace`); si no,
   el video igual se reproduce pero tarda más en arrancar. Progreso: `transformer.getProgress(progressHolder)` cada
   250 ms → «Comprimiendo… 40 %». Para videos muy largos, bajar el bitrate a `(140 MB · 8 / duración_s) − 96 000`
   (mínimo 450 000), como `targetVideoBps` de la web. Sin recodificar (misma regla `planVideo`): subir el archivo tal cual.
4. **Póster**: `MediaMetadataRetriever.getScaledFrameAtTime(min(1 s, duración/2) en µs, OPTION_CLOSEST_SYNC, 480, 480)`
   (API 27+; ya viene rotado) → `bitmap.compress(Bitmap.CompressFormat.JPEG, 80, stream)` (bajar a 60 si pasa de 512 KB).
5. **Subir**: OkHttp con un `RequestBody` que escribe el archivo por partes y reporta bytes enviados (o `ProgressRequestBody`)
   a `POST /api/v1/conversations/{id}/videos` con `content-type: video/mp4`, `content-length`, `x-file-name`,
   `x-duration-ms`, `x-width`, `x-height`. Para que sobreviva a salir de la app, un `WorkManager` con
   `setForeground` (notificación «Subiendo video… 70 %»). Luego `POST /attachments/{id}/thumb` y el mensaje.
6. **Reproducir en la burbuja**: tarjeta con póster, ▶, duración y tamaño. Al tocar: `GET playUrl` →
   `ExoPlayer` con `MediaItem.fromUri(url)` (DefaultHttpDataSource sin cabeceras; ExoPlayer pide rangos) en un
   `PlayerView` dentro del ítem. Un solo `ExoPlayer` compartido; pausar/soltar en `onViewDetachedFromWindow` y al cambiar
   de chat. Caché de la URL hasta `expiresIn - 5 min`; en `onPlayerError` con `HttpDataSourceException` 403, pedir otra y
   `seekTo` a donde iba. Pantalla completa con el botón de `PlayerView`.
7. Borrar los archivos de `cacheDir` al terminar o cancelar.

## Servidor (para el despliegue)

- **Dependencia nueva del API**: `@aws-sdk/lib-storage@3.1139.0` (misma versión que `client-s3`). Web: `mediabunny@1.61.0`.
- **No hace falta ffmpeg** ni ninguna herramienta de video en el servidor.
- **Migración 043** (`043_video_storage.sql`): dos índices, sin cambios de columnas. Rápida.
- **nginx** (`infra/nginx/api-locations.conf`): nueva ubicación `…/videos` con `client_max_body_size 151m`,
  `proxy_request_buffering off` (el cuerpo no se escribe en el disco del servidor), `proxy_read_timeout 900s`; y
  `proxy_max_temp_file_size 0` en `/api/v1/attachments/` para que los videos servidos por stream no se copien a disco.
  Hay que copiar el archivo al servidor y recargar nginx.
- **S3 / IAM**: el multipart usa `CreateMultipartUpload`, `UploadPart` y `CompleteMultipartUpload`, que entran en
  `s3:PutObject`. Si una subida se corta, lib-storage llama `AbortMultipartUpload`, que necesita
  `s3:AbortMultipartUpload` sobre `xerticoms/tiecoms/attachments/*`; sin ese permiso las partes quedan huérfanas (se
  cobran). Recomendado además una regla de ciclo de vida «AbortIncompleteMultipartUpload a 1 día» en el bucket.
- **CSP**: la web ya permite `media-src https://*.amazonaws.com`. En el escritorio (Tauri) se agregó
  `media-src 'self' blob: data: https://*.amazonaws.com; worker-src 'self' blob:`.
- **Variables**: ninguna nueva.

## Riesgos y pendientes

- **Cloudflare** limita el cuerpo de una petición a 100 MB en los planes Free/Pro. Un video comprimido rara vez pasa de
  eso (≈ 6 min a 2,1 Mbps), pero un original grande sin WebCodecs sí: respondería 413 desde Cloudflare. Si pasa seguido,
  el siguiente paso es la subida por partes desde el cliente (varias peticiones de 8 MB con `UploadPart`).
- Duración, ancho y alto los declara el cliente (el servidor no decodifica video). Solo se usan para mostrar.
- Safari: WebCodecs `AudioEncoder` llegó tarde; si no hay codificador AAC ni Opus, se sube el original (≤ 150 MB).
- Firefox sin H.264 en WebCodecs (Linux sin OpenH264): igual, sube el original.
- La compresión de un video largo en un equipo lento puede tardar; se puede cancelar y el progreso es visible.
- La cuenta de almacenamiento se calcula al vuelo; con muchos adjuntos por empresa conviene materializarla.
