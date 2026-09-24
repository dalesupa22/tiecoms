# Enlaces de las aplicaciones

`infra/nginx/app-links.conf` publica los archivos de asociación en HTTPS, sin
redirección, en `tiecoms.com`, `www.tiecoms.com` y `app.tiecoms.com`.

## Android

Paquete: `com.tiecoms.app`. Play Console: aplicación `4972162421982903452`.
Las siguientes huellas SHA-256 públicas se comprobaron en Play Console el
24 de septiembre de 2026, después de activar Play App Signing y cargar el AAB 3.
Se conserva además la clave de subida utilizada por las compilaciones locales.

| Certificado | SHA-256 |
| --- | --- |
| Subida / compilación local | `12:2C:D6:DA:89:5C:D5:D6:39:55:D9:C4:0A:9A:89:80:41:51:94:98:59:A6:40:E9:29:A5:02:2D:13:41:F4:B7` |
| Google Play anterior | `23:FD:12:67:40:D3:01:88:17:2C:BB:40:2D:58:3E:DD:9A:2A:74:2E:21:08:0F:BC:D9:A1:52:12:BE:25:10:25` |
| Google Play clásica actual | `1F:AA:E5:7E:B3:33:8A:1B:4A:DE:C5:88:59:92:99:3E:63:C6:39:F1:A2:4B:A7:0E:AC:C2:E4:72:FC:B3:6D:D1` |
| Google Play poscuántica actual | `FC:19:B5:B3:41:E2:59:24:B8:B1:01:8E:C8:ED:7B:09:73:4B:99:07:F5:96:F5:68:0C:99:7B:14:F2:A2:74:A3` |

La huella anterior coincide tanto con el SHA-256 mostrado por Play como con su
fragmento oficial de Digital Asset Links. Las otras dos pertenecen a las claves
activas clásica y poscuántica de la misma aplicación. Google documenta que la
firma híbrida para Android 17 añade una clave clásica nueva y otra poscuántica,
además de la clave para versiones anteriores de Android. Mantener las tres
huellas permite declarar la misma identidad de aplicación en esas variantes.

`sha256_cert_fingerprints` admite varias huellas. La clave de subida por sí sola
no verifica necesariamente una aplicación instalada desde Google Play.

- [Play App Signing y claves híbridas](https://support.google.com/googleplay/android-developer/answer/9842756?hl=en)
- [Publicar Digital Asset Links](https://developer.android.com/training/app-links/configure-assetlinks)

Después de cada rotación, comprobar las huellas en Play Console, actualizar esta
lista y desplegar. Verificar `/.well-known/assetlinks.json` en los tres dominios:
HTTP 200 directo, `Content-Type: application/json`, paquete exacto y todas las
huellas esperadas. La verificación del archivo publicado no sustituye una prueba
de apertura con una instalación de Google Play.

## Apple

`/.well-known/apple-app-site-association` declara `B76US7H3L3.com.tiecoms.app`
para `/c/*`, `/w/*`, `/invite/*` y `/signup?org=…`, y el mismo identificador para
credenciales web. No depende de los certificados de Android.
