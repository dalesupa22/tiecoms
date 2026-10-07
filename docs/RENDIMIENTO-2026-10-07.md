# Rendimiento — 7 oct 2026

Pedido: «Chaggu está muy lento, revisa cómo volverlo más rápido».

## Diagnóstico

- **Red y entrega (medido):** desde fuera, cada petición tarda entre 130 y 180 ms. De eso, entre 90 y 130 ms son TCP+TLS hacia Cloudflare y entre 40 y 60 ms son del servidor. La compresión br y la caché `immutable` de los assets funcionan. No hay problema ahí.
- **Cliente (leído en el código):**
  - Cada evento del socket cambia `state.data` y hay unos 116 `useClient((s) => s.data)` repartidos, así que un mensaje en cualquier chat vuelve a pintar casi toda la app.
  - Cada fila de mensaje hacía búsquedas lineales sobre personas, conversaciones y asuntos.
  - Volver a la pestaña pedía `/bootstrap` completo.
- **API (leído en el código):**
  - `/bootstrap` no tiene límite y hace unas 11 subconsultas por conversación, con un pool de 10 conexiones.
  - El worker procesa de a un job, así que la IA y las transcripciones retrasan los push.
  - Faltan índices en el barrido de audios de WhatsApp (corre cada minuto) y en el conteo de enlaces.

No se midió con datos de producción: `EXPLAIN`, `pg_stat_statements` y la latencia real de `/bootstrap` quedan pendientes y requieren SSH a `chaggu-xerticalls-prod`.

## Hecho (rama `claude/perf-20261007`)

| ID | Cambio | Archivos |
|---|---|---|
| PERF-C1 | Volver a la pestaña con el socket conectado y menos de 60 s oculta ya no pide `/bootstrap` ni recarga WhatsApp | `client-core/src/client.ts` |
| PERF-C2 | `members.changed` solo pide el snapshot si entra alguien que no está en el directorio (antes lo pedían todos los miembros a la vez) | `client.ts` |
| PERF-C3 | «Escribiendo» se emite como máximo cada 1,5 s; el borrador se guarda en `localStorage` con un respiro de 400 ms y se vacía al desmontar u ocultar | `client.ts`, `Conversation.tsx` |
| PERF-C4 | La caché del bootstrap se guarda cada 5 s (antes 1,5 s) y enseguida al ocultar | `client.ts` |
| PERF-A1 | Un mensaje nuevo actualiza y reordena la lista con un solo cambio de estado (antes eran dos) | `client.ts` |
| PERF-B1 | `personById`/`orgById` en O(1) con índice cacheado por arreglo; hilos y laterales por padre; asunto por mensaje y mensaje anterior por `seq` con `Map` | `ui.tsx`, `ChatBar.tsx`, `Side.tsx`, `Conversation.tsx` |
| PERF-B2 | Subtareas (`childrenOf`) con índice por padre, antes O(n²) en Tareas | `Issues.tsx` |
| PERF-D1 | Migración 106: índices `CONCURRENTLY` en `message_links(conversation_id, seq)`, audios de WhatsApp pendientes y transcritos, `jobs.done_at` y `outbox.dispatched_at` | `migrations/106_perf_indexes.sql` |
| PERF-D2 | El migrador admite `-- migrate:no-transaction` y espera el lock reintentando (`pg_try_advisory_lock`); antes, con API y worker migrando a la vez, `CONCURRENTLY` se bloqueaba con el que esperaba y dejaba un índice INVALID (se reprodujo y se cubrió con una prueba) | `src/migrate.ts`, `test/migrate-concurrency.test.ts` |
| PERF-D3 | Las 6 consultas finales de `/bootstrap` van en paralelo | `modules/bootstrap.ts` |
| PERF-E1 | Worker con dos carriles: el rápido (`push.*`, vistas previas, vencimiento de terceros) ya no espera detrás del lento (gg, transcripciones, resúmenes, webhooks) | `src/worker.ts` |

## Pendiente (NO EJECUTADO)

- **Medir en producción:**
  - `pg_stat_statements` ordenado por `total_exec_time`.
  - `EXPLAIN (ANALYZE, BUFFERS)` de `/bootstrap`, `queryIssues`, `searchAll` y `queueSharedVoiceNotes` con un usuario pesado.
  - `pool.waitingCount` y el lag del event loop.
- **Pool:**
  - Hecho: `DB_POOL_MAX` del worker subió de 3 a 5 (`infra/compose.yml`) por los dos carriles más el ciclo periódico.
  - Evaluar subir el del API o poner PgBouncer.
- **`/bootstrap`:** limitar o paginar las conversaciones y sacar `member_ids` y `link_count` del snapshot (cambio de contrato).
- **Cliente:**
  - Selectores estrechos en lugar de `s.data` completo.
  - `MessageRow` memoizada.
  - Compositor separado.
  - Virtualizar los mensajes y las listas de Tareas y WhatsApp.
  - Carga diferida por ruta e i18n por idioma (unos 1,7 MB de JS/CSS sin comprimir en la carga inicial).
- **Búsqueda global y listado de tareas:** reescribir como `UNION ALL` con índices trigram (ver la auditoría).
- **PDF:** sacar pdfjs y pdf-lib del event loop del API (`worker_threads`).
- **nginx:** `gzip` para JSON en el origen y `upstream` con keepalive.

## Despliegue

`infra/deploy.sh` corre `node migrate.js` antes de cambiar de versión, así que la migración 106 crea los índices con la versión anterior todavía atendiendo. En tablas grandes (`wa_messages`) puede tardar, pero no bloquea escrituras. Si un índice queda INVALID, revisar con `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid`.

## Entrega (7 oct 2026, UTC)

| Plataforma | Canal | Versión | Commit | Resultado |
|---|---|---|---|---|
| Web + API + worker | producción (`chaggu-xerticalls-prod`) | release `20261007181244-92e6198` y luego `20261007181545-1090cf7` (con la landing) | `92e6198`, `1090cf7` | En línea. Migración 106 aplicada: 5 índices válidos y 0 inválidos. Worker con `DB_POOL_MAX=5`; los dos carriles procesan push y transcripciones sin pendientes; sin errores en el API. `app.chaggu.com` sirve el bundle nuevo. Lectura real con una cuenta vía MCP correcta. Anterior: `20261007174839-58c87d0`. |
| Windows | descarga pública (sin firma, igual que la 0.3.17) | 0.3.18 (build 318) | `81573f9` (Actions run 37665394319) | `.exe` sha256 `20f08eac15b58514…` y `.msi` es-ES sha256 `5d926b9dfb07ecdb…` en `/descargas/`. `latest.json` lleva versión por plataforma; respaldo en `latest.before-0.3.18-windows.json`. `app_releases.windows` pasó de 0.3.17/317 a 0.3.18/318. No se probó la instalación en Windows real. |
| macOS | — | sigue la 0.3.17 | — | **Pendiente.** El Mac mini no tiene la identidad Developer ID Application, Rust ni Node, y los secretos de notarización están en el Mac de Danny. Hay que correr `apps/desktop/scripts/release-mac.sh` en ese Mac desde `principal` y luego `ops.js app-version mac 0.3.18 …`. |
| iOS / Android | — | sin build nueva | — | Las apps móviles son nativas (`apps/ios` y `apps/android`) y no usan `client-core` ni la web. Reciben las mejoras del API sin publicar nada. `app_releases` de iOS y Android no se tocó. |

`principal` avanzó por fast-forward de `58c87d0` a `1090cf7`; `main` no se tocó.
