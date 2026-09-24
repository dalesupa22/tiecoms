# Arquitectura de TieComs

Implementa la propuesta de `EntreEmpresas/docs/nodo-requerimientos-arquitectura-inicial.md` (septiembre 2026). Estado al 23-sep-2026: primera sección vertical en producción.

```
 Web / PWA ─┐                                   ┌─ api (Fastify + Socket.IO) ── N réplicas
 macOS  ────┤   HTTPS + WSS    Cloudflare        │     │  outbox → despachador (SKIP LOCKED)
 Windows ───┼──────────────▶  nginx (EC2) ──────▶│     │  adaptador Socket.IO sobre PostgreSQL
 Android ───┤   mismo contrato                   │     │
 iOS ───────┘   /api/v1                          └─ worker (jobs con lease, reintentos)
                                                        │
                                               RDS PostgreSQL 17 (db tiecoms, TLS verificado)
```

## Decisiones

- **Monolito modular.** Auth, espacios, conversaciones, mensajes, invitaciones y tiempo real son módulos con límites claros (`apps/api/src/modules`), desplegados juntos. Se separa solo lo que las mediciones justifiquen.
- **Un contrato para cinco clientes.** `packages/contracts` define DTOs, validación y eventos. Cambios aditivos; un cambio incompatible sube `API_VERSION` (rutas `/api/v2`) y `MIN_CLIENT_CONTRACT` marca qué apps instaladas deben actualizarse.
- **Lógica de sincronización compartida.** `packages/client-core` no depende de React ni del navegador salvo por adaptadores (`KeyValueStorage`, `SecretStore`). Web usa IndexedDB y cookie httpOnly; las apps usan su almacenamiento y un refresh token por dispositivo.
- **Apps sobre el build web.** Tauri (macOS/Windows) y Capacitor (Android/iOS) empaquetan `apps/web/dist` con `VITE_API_ORIGIN=https://www.tiecoms.com`. Si una plataforma necesita UI nativa (p. ej. listas muy largas en móvil), se reemplaza solo la capa de UI: el contrato y `client-core` se mantienen.

## Garantías transaccionales

Enviar un mensaje (`tiecoms_append_message`, migración 002) ocurre en una transacción corta:

1. Autorización con la membresía activa de la conversación y del espacio (terceros: fecha de salida comprobada en cada acceso), con `FOR UPDATE` sobre la fila de la conversación.
2. `message_seq` y `event_seq` se incrementan bajo ese bloqueo → orden total por conversación, sin huecos.
3. Mensaje + evento durable (`conversation_events`) + cursor del autor + fila en `outbox` + `pg_notify`, todo o nada.
4. ACK al cliente solo después del commit.

Idempotencia: `UNIQUE (conversation_id, author_id, client_message_id)` más hash del cuerpo. Reintentar devuelve el mismo mensaje (200); reutilizar el id con otro texto → 409. Dos reintentos simultáneos convergen por la restricción única.

Entrega: el despachador lee el outbox con `FOR UPDATE SKIP LOCKED` y emite a las salas; `NOTIFY` solo despierta, un barrido cada 2 s recupera lo perdido. El cliente deduplica por `eventSeq`, detecta huecos y los recupera con `GET /conversations/:id/events?after=N`; cursor demasiado antiguo → `resetRequired` y snapshot nuevo. Al reconectar o volver del segundo plano: `/bootstrap` + recuperación de huecos + vaciado de la cola.

Cola local: el mensaje se guarda en IndexedDB antes de enviarse; sale por socket con ACK (8 s) y, si no, por HTTP con el mismo `clientMessageId`. Backoff exponencial con jitter; errores permanentes (403/404/409/400) quedan como "No se envió" con reintentar/descartar.

## Alcance y permisos

- La unidad es el **espacio entre empresas**. Cada persona participa con su propia empresa; nadie es "invitado" de otra. Aceptar una invitación suma la empresa al espacio.
- Grupos con membresía explícita; no hay herencia implícita del espacio. Los grupos fuera de alcance no revelan su nombre (ni en `/bootstrap`, ni en eventos, ni en sockets).
- Terceros (`guest`): solo grupos concretos, directorio limitado a sus grupos, no suman su empresa, no crean grupos ni invitan, vencen por `expires_at` (comprobado en cada consulta; el worker además los saca de las salas cada minuto).
- Historial: por defecto se ve desde la llegada (`history_from_seq`); ver el historial es una concesión explícita. Reingresar no restaura concesiones antiguas.
- Sesiones por dispositivo, revocables; revocar desconecta los sockets de esa sesión al instante. Refresh tokens rotativos con detección de reuso (ventana de gracia de 30 s para reintentos de red).
- Auditoría en `audit_events` para altas, invitaciones, cambios de miembros y sesiones.

## Escalar

| Señal | Paso |
| --- | --- |
| CPU/RAM del API | Más réplicas de `api` detrás de un balanceador. El adaptador PostgreSQL de Socket.IO reparte eventos entre nodos y el outbox ya es seguro con varios despachadores. Con long-polling activo, usar afinidad de sesión. |
| Jobs compiten con el chat | Mover `worker` a otra máquina (misma imagen, `node worker.js`). |
| Muchas conexiones a la BD | RDS Proxy o PgBouncer en modo transacción; hoy: pool 10 (API) + 2 (adaptador) + 1 (LISTEN) + 3 (worker). |
| Fan-out alto entre nodos | Cambiar el adaptador a Redis sin tocar el resto; PostgreSQL sigue siendo la fuente durable. |
| Tablas grandes | Particionar `messages`/`conversation_events` por rango de tiempo; purga de `outbox` ya automática (3 días). |
| Alta disponibilidad | Dos nodos + balanceador, RDS Multi-AZ, despliegue gradual. |

## Pendiente (siguiente iteración)

- Adjuntos en S3 (subida directa con URL prefirmada, validación y cuarentena).
- Push: Web Push (service worker), FCM y APNs; tabla `push_subscriptions` ya existe.
- Asuntos, Agenda, Mesa, Trazo (derivación y reencuentro) y agentes BYOA sobre este mismo modelo.
- Guardar el refresh token de las apps en Keychain/Keystore (hoy: almacenamiento de la WebView).
- Búsqueda con autorización (PostgreSQL FTS).
- Correo transaccional para invitaciones (hoy el enlace se comparte manualmente).
- CI que ejecute `typecheck`, pruebas y el despliegue.
