# TieComs

La red de trabajo **entre empresas**: espacios compartidos, grupos con audiencia propia, terceros con fecha de salida y mensajería durable. Web responsive primero; macOS, Windows, Android e iOS sobre el mismo contrato.

## Estructura

| Carpeta | Qué es |
| --- | --- |
| `packages/contracts` | Contrato versionado (tipos + validación zod) que comparten API y todos los clientes |
| `packages/client-core` | Motor de sincronización sin UI: cola persistente, reintentos idempotentes, cursores con detección de huecos, no leídos entre dispositivos |
| `apps/api` | Fastify + Socket.IO + PostgreSQL. Monolito modular; `server.js` (API y tiempo real) y `worker.js` (trabajos) |
| `apps/web` | App en app.tiecoms.com. React + Vite, responsive (lista → conversación → detalles en móvil) y PWA |
| `apps/landing` | Landing de www.tiecoms.com (español en `/`, inglés en `/en/`), estática; `python3 apps/landing/build.py` |
| `apps/desktop` | Tauri 2 para macOS y Windows (envuelve `apps/web/dist`) |
| `apps/mobile` | Capacitor 8 para Android e iOS (envuelve `apps/web/dist`) |
| `infra` | Dockerfile, Compose, nginx, `bootstrap-server.sh`, `deploy.sh` |

Arquitectura, garantías y cómo escalar: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Desarrollo

```bash
npm install
cp apps/api/.env.example apps/api/.env   # completar DATABASE_URL y JWT_SECRET
npm run migrate
npm run dev:api     # http://localhost:3020
npm run dev:web     # http://localhost:5173 (proxy /api → 3020)
```

Pruebas de extremo a extremo (contra una base de pruebas, nunca producción):

```bash
API_URL=http://localhost:3020 npm test
```

## Asuntos y bifurcaciones

- **Asuntos**: pendientes que nacen de un mensaje (o a mano), con responsable, fecha, estado (abierto, en curso, esperando a otra empresa, resuelto, descartado), historial y comentarios. Heredan la audiencia de su conversación. Se marcan como posible cuello de botella si llevan 2+ días sin moverse o se vencen.
- **Bifurcaciones**: «⑂ Derivar» un mensaje crea una conversación aparte (misma audiencia, diagnóstico interno de mi empresa o decisión directiva). La derivada muestra su linaje y «↩ Devolver el resultado» publica el cierre en el origen. En el origen no se revela el nombre de una derivada que no todos pueden ver. **Trazo** muestra cada cadena completa.
- Arnés visual sin backend para desarrollo: `npm -w @tiecoms/web run dev` y abrir `/harness.html?to=/c/general&lang=es`.

## Clic derecho, agenda, recordatorios, fijados y reenvíos

- **Clic derecho** (y pulsación larga en táctil, o tecla de menú / Shift+F10) en mensajes, conversaciones, espacios, personas y reuniones: responder, copiar texto o enlace, fijar, recordarme, marcar como no leído, silenciar, derivar, abrir asunto, agendar, reenviar, editar y eliminar.
- **Agenda**: reuniones que viven en un grupo (su audiencia), con invitados, respuesta de asistencia, zona horaria, enlace de Meet/Teams/Zoom y botones para Google Calendar, Outlook o `.ics`.
- **Recordatorios**: sobre una conversación o un mensaje; el worker los dispara y llegan como aviso en vivo y notificación del navegador.
- **Fijados**: conversaciones y espacios fijados arriba (personal) y mensajes fijados en cada grupo (compartido). Silenciar deja de notificar y de sumar al contador.
- **Reenvíos**: hacia WhatsApp, Slack, Teams, correo u otra conversación de TieComs; y «Traer desde WhatsApp, Slack o correo» (pegado, con detección de chats de WhatsApp). En Android, la PWA instalada aparece en «Compartir».

## Datos de demostración

`scripts/seed-demo.mjs` crea por el API 3 empresas (Xertify, Estudio Norte, Nexo Logística), 6 personas, un tercero (Julián Castro, consultor con fecha de salida), 2 espacios entre empresas, grupos compartidos, directivo, internos y directos. Cuentas: `danny|laura|mateo|ana|lucia|carlos|julian@demo.tiecoms.com`, misma contraseña (en `.secrets/demo_password`, fuera de git).

```bash
API_URL=https://app.tiecoms.com DEMO_PASSWORD='...' node scripts/seed-demo.mjs        # una sola vez
API_URL=https://app.tiecoms.com DEMO_PASSWORD='...' node scripts/seed-demo-extras.mjs # asuntos y bifurcaciones de demo
API_URL=https://app.tiecoms.com DEMO_PASSWORD='...' node scripts/seed-demo-agenda.mjs # reuniones y un mensaje fijado
API_URL=https://app.tiecoms.com DEMO_PASSWORD='...' node scripts/three-sessions.mjs   # 3 sesiones en vivo: latencia y alcance
```

Idioma: la app usa el del navegador (español si lo prefiere, inglés en otro caso); se puede fijar en Ajustes. Los mensajes de sistema se guardan como clave + datos y cada cliente los muestra en su idioma.

## Despliegue

Dominios: www.tiecoms.com (landing es/en), app.tiecoms.com (app + API en `/api/`). `tiecoms.com` y las rutas antiguas `/app/*` y `/producto.html` redirigen.

`npm run deploy` compila en local, sube un artefacto versionado a `/opt/tiecoms/releases/<versión>`, construye la imagen, migra, arranca `api` y `worker` con Compose, verifica `/api/health/ready` y cambia la web de forma atómica. Si la verificación falla, vuelve a la versión anterior. Se conservan las últimas 5 versiones.

Servidor: `ssh ReimaginedClubServer` (EC2 t4g.large, compartida con otros servicios; TieComs solo usa `/opt/tiecoms`, `127.0.0.1:3020` y sus propios archivos de nginx). Secretos en `/opt/tiecoms/shared/api.env` (600). Base: `tiecoms` en RDS con el rol `tiecoms_app` (límite 25 conexiones), TLS verificado con el CA de RDS.

## Apps

```bash
# Escritorio (requiere Rust): macOS universal / Windows
npm -w @tiecoms/desktop run build:mac
npm -w @tiecoms/desktop run build:win
# Móvil (requiere Android Studio / Xcode)
npm -w @tiecoms/mobile run add:android && npm -w @tiecoms/mobile run sync
npm -w @tiecoms/mobile run add:ios && npm -w @tiecoms/mobile run sync
```
