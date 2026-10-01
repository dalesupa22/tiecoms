# chaggu de escritorio (Mac y Windows)

Tauri 2 en `apps/desktop`: la web de `apps/web` empaquetada dentro de la app, hablando con `https://app.chaggu.com`. La parte nativa está en Rust y usa el WebView del sistema (WKWebView en Mac, WebView2 en Windows): no es Electron, por eso pesa ~12 MB en Mac (universal) y ~5,5 MB en Windows.

## Ramas

- `desktop`: base común; se pone al día con `git merge origin/main`.
- `desktop-mac`: `apps/desktop/scripts/release-mac.sh` arma el .dmg universal firmado (Developer ID) y notarizado.
- `desktop-windows`: `.github/workflows/desktop-windows.yml` compila en `windows-latest` y publica el release `desktop-v<versión>` con el .exe (NSIS, por usuario, sin admin) y el .msi.

Lo común va en `desktop` y se fusiona a las dos.

## Publicar una versión

1. Sube `version` en `apps/desktop/src-tauri/tauri.conf.json` y en `Cargo.toml` (rama `desktop`) y fusiona a `desktop-mac` y `desktop-windows`.
2. **Mac:** `npm run build:mac` (sin firmar) o `bash apps/desktop/scripts/release-mac.sh` (firmado y notarizado).
3. **Windows:** `git push origin desktop-windows`. Al terminar el workflow, el release `desktop-v<versión>` tiene los instaladores.
4. Sube los archivos a `/opt/tiecoms/downloads/` en el servidor. Van con nombre fijo (`chaggu-mac.dmg`, `chaggu-windows.exe`, `chaggu-windows.msi`) y con copia versionada (`chaggu-<v>-mac.dmg`…). Actualiza `latest.json` con `{ version, date, mac, windows, windowsMsi }` y, en cada archivo, `{ file, size, sha256 }`.
5. `www.chaggu.com/descargas/` los sirve (`infra/nginx/tiecoms.conf`). La sección «Descarga chaggu» de la landing (`#descargar`) resalta el sistema de quien visita y muestra versión y peso desde `latest.json`.

Los instaladores viven fuera de las releases del servidor: un despliegue no los borra ni los vuelve a subir.

## Firma

- **Mac:** Developer ID Application: CERTILABOR SAS (B76US7H3L3) está instalado con su clave privada en el Llavero. La 0.3.4 pública está firmada, notarizada y engrapada (app y DMG), con `codesign`, `stapler` y Gatekeeper verificados. La notarización usa `.secrets/notary_*`; no se incluyen secretos en Git.
- **Windows:** Azure Artifact Signing ya tiene la cuenta `xertichaggusigning` y los permisos de validación y firma. La identidad pública de XERTI, INC. está `In Progress`; los instaladores de Windows 0.3.4 siguen sin firma hasta la aprobación de Microsoft.
- La landing distingue la descarga de Mac firmada del aviso de Windows. Los enlaces usan los nombres versionados de `latest.json` para evitar servir un instalador anterior desde caché.
- No se ha verificado todavía que el permiso de grabación de pantalla persista entre versiones.
