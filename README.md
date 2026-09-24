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
