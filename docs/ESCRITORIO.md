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

## Firma (pendiente)

- **Mac:** el certificado «Developer ID Application: CERTILABOR SAS» ya está creado en Apple (vence en 2031). Falta importarlo en el Llavero junto con `tiecoms/.secrets/developerid_app.key`. La notarización usa la llave de App Store Connect guardada en `.secrets/notary_*`. Sin firma, macOS pide «Abrir de todos modos» en Privacidad y seguridad.
- **Windows:** Azure Trusted Signing. Sin firma, SmartScreen muestra «Más información › Ejecutar de todos modos».
- La landing explica los dos avisos en «¿Tu computador muestra un aviso al abrirla?». Quítalo cuando las dos firmas estén listas.
