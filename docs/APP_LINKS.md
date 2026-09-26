# Enlaces de las aplicaciones

`infra/nginx/app-links.conf` publica los archivos de asociación en HTTPS, sin
redirección, en `chaggu.com`, `www.chaggu.com`, `app.chaggu.com` y los tres hosts
equivalentes de `tiecoms.com`.

## Android

### Chaggu

Paquete: `com.chaggu.app`. Play Console: aplicación `4974615302608394008`.
Certificados públicos descargados del ZIP oficial de Play Console y comprobados
por SHA-256 el 26 de septiembre de 2026. Se conserva la clave de subida local.

| Certificado | SHA-256 |
| --- | --- |
| Subida / compilación local | `12:2C:D6:DA:89:5C:D5:D6:39:55:D9:C4:0A:9A:89:80:41:51:94:98:59:A6:40:E9:29:A5:02:2D:13:41:F4:B7` |
| deployment_cert.der | `AC:D8:D4:BB:B8:27:F3:6E:CC:7C:42:B7:CE:80:95:7A:6C:1C:A2:0B:D9:B5:B6:DB:C2:2E:B4:4C:5B:D5:CA:4B` |
| hybrid_classical_cert.der | `08:F4:33:91:39:BF:B7:94:99:F6:D9:05:C0:CF:3B:05:3B:A5:FD:8A:DC:1B:DA:07:85:4E:D1:15:ED:A1:44:1F` |
| hybrid_pqc_cert.der | `70:E2:E3:44:0D:3E:9B:95:52:96:95:D9:2A:B4:6E:8B:FF:7A:47:6C:4E:69:2E:41:76:FD:56:EB:1A:6E:AD:B5` |

Los tres certificados de Play corresponden a la firma clásica de Android 16 o
anterior y a las dos claves de firma híbrida de Android 17 o posterior. Google
pide registrar las tres huellas también en Digital Asset Links.

### TieComs (compatibilidad)

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
lista y desplegar. Verificar `/.well-known/assetlinks.json` en los seis hosts:
HTTP 200 directo, `Content-Type: application/json`, paquete exacto y todas las
huellas esperadas. La verificación del archivo publicado no sustituye una prueba
de apertura con una instalación de Google Play.

## Apple

`/.well-known/apple-app-site-association` declara `B76US7H3L3.com.chaggu.app` y
`B76US7H3L3.com.tiecoms.app`
para `/c/*`, `/w/*`, `/invite/*` y `/signup?org=…`, y ambos identificadores para
credenciales web. No depende de los certificados de Android.
