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
