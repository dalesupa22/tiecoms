# «Actualización disponible»

Pedido de Danny (29-sep-2026). Como se publican versiones seguido y mucha gente sigue en TestFlight o en builds viejas de Android, cada app avisa cuando hay una versión nueva con una franja fija que no se puede cerrar hasta actualizar.

## Apps (iOS y Android)

- `GET /api/v1/app-version?platform=ios|android&lang=es` es público y no se guarda en caché. Responde `{ latestVersion, latestBuild, minBuild, url, notes }` desde la tabla `app_releases` (migración 033).
- La app lo consulta al abrirse, aunque no haya sesión, y cada vez que vuelve al frente.
  - Si su build (CFBundleVersion en iOS, versionCode en Android) es menor que `latestBuild`, muestra arriba la franja «Actualización disponible · chaggu X». No se puede cerrar.
  - Si es menor que `minBuild`, muestra una pantalla completa que pide actualizar para seguir.
- Botón «Actualizar»:
  - iOS abre TestFlight si la app vino de TestFlight (recibo sandbox); si no, abre la App Store.
  - Android abre Google Play (`market://`).

### Al publicar una build nueva

Hazlo solo cuando la build ya esté disponible para los usuarios en TestFlight o en Play.

```
ssh ReimaginedClubServer
cd /opt/tiecoms/releases/$(cat /opt/tiecoms/RELEASE)
sudo docker compose -f compose.yml run --rm api node ops.js app-version ios 1.6.7 24 "" "Notas en español" "Notes in English"
sudo docker compose -f compose.yml run --rm api node ops.js app-version android 1.6.7 26
```

(`TIECOMS_RELEASE=$(cat /opt/tiecoms/RELEASE)` delante de `docker compose` si lo pide.) Para obligar a actualizar las builds viejas, se pasa `minBuild` como cuarto argumento, que debe ser menor o igual que el build.

## Web

Cada build de la web publica `/version.json` con su id (`__BUILD_ID__`). Una pestaña abierta lo revisa cada 5 minutos y al volver a ella. Si el id cambió, muestra arriba la franja «Hay una versión nueva» con «Recargar». En desarrollo no hace nada.

## Escritorio (Mac y Windows)

La web va empaquetada dentro de la app, así que `/version.json` no sirve: la app compara su versión (`getVersion()` de Tauri, `tauri.conf.json`) con `GET /api/v1/app-version?platform=mac|windows`. En escritorio `latest_build` es la versión como número (0.3.0 → 300). Si hay una más nueva, muestra la franja fija «Actualización disponible · chaggu X para escritorio» con «Descargar», que abre `url` en el navegador. Revisa al abrir, al volver a la ventana y cada 5 minutos (migración 046, pedido de Danny 30-sep-2026: «siempre visible en las 5 versiones»).

```
sudo docker compose -f compose.yml run --rm api node ops.js app-version mac 0.3.0 https://…/chaggu_0.3.0_universal.dmg
sudo docker compose -f compose.yml run --rm api node ops.js app-version windows 0.3.0 https://…/chaggu_0.3.0_x64-setup.exe
```

Las apps de escritorio anteriores a este cambio (0.2.0) no traen el aviso: hay que instalar a mano la primera versión que lo tenga.
