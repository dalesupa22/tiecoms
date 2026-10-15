# Entrega 2026-10-14: llevar varios mensajes de WhatsApp juntos a un chat

Pedido de Danny (2026-10-15): «despliega por favor una nueva versión de android y iphone».

## Recibo iOS 1.7.18 (59), TestFlight interno (CH018)

- **Candidata**: commit `ec8d0ea1c3e1bb17fc687c5cfc3989a6d82a0c23` (= `origin/principal`), `apps/ios`, `MARKETING_VERSION` 1.7.18, `CURRENT_PROJECT_VERSION` 59, bundles `com.chaggu.app`, `.share` y `.notifications`. No se tocaron fuentes ni versiones.
- **Preflight** `operations/mobile-publishing/ios-ready.sh` (2026-10-15T03:34Z): `ready: true`, Xcode 26.1 (17B55), identidad Apple Distribution del team B76US7H3L3, los tres perfiles Chaggu por UUID vigentes hasta el 25-dic-2026 y lectura ASC con HTTP 200.
- **ASC antes**: versión pública 1.7.17 `READY_FOR_SALE` y último build 1.7.17 (58) `VALID` en el grupo «Chaggu Internal». La consulta por el build 59 devolvió 0 resultados. No había revisión abierta: todas las `reviewSubmissions` estaban `COMPLETE`.
- **Build único aislado** en el Mac mini mediante `with-ios-build-lock.sh`:
  - Carpeta de trabajo: `/Users/rentamac/build/chaggu-ios/20261015T033718Z-ZageoA`, con `src/`, `DerivedData/`, `SourcePackages/`, `TieComs.xcarchive`, `export/` y `logs/`.
  - Fuente: `git archive` de `apps/ios` del commit, sha256 `5e748dcb…36b1`.
  - Override de firma solo en la copia de build: `CHAGGU_APPSTORE_PROFILE` con los UUID 2946841f…/56fffda6…/f94b1b94… (6 especificadores; diff en `logs/signing-override.diff`).
  - Archive Release para `generic/platform=iOS`: exit 0, un solo `** ARCHIVE SUCCEEDED **` y 0 líneas `error:`, sin errores de módulos Swift ni de la base de builds.
  - Export: el script de build se detuvo tras el archive por un `grep -c` con `pipefail`. El export se hizo después, también bajo el lock, sobre el mismo `.xcarchive` sin recompilar. El segundo workdir del lock (`20261015T033959Z-usdEFe`) quedó vacío salvo `NOTE.txt`.
  - Export manual `app-store-connect` con las mismas opciones del repositorio (`ExportOptions.plist`, `testFlightInternalTestingOnly=false`, igual que el 58) y perfiles por UUID: `** EXPORT SUCCEEDED **`.
  - `chaggu.ipa` sha256 `0c89fea0d2b8173d72fa64de1900adadaf4cf40868d4451a19218febecaae5f6`.
- **Verificación**:
  - `codesign --verify --deep --strict` de la app: exit 0. Cada bundle se verifica por separado (exit 0) con «Apple Distribution: CERTILABOR SAS (B76US7H3L3)».
  - La app y ambas extensiones reportan 1.7.18 (59).
  - La app incluye `com.apple.developer.applesignin` y `aps-environment=production`, con el perfil 2946841f-95e6-422a-a955-015f26cba300.
- **Subida**: `altool --upload-app` con la clave API del Mac. `UPLOAD SUCCEEDED`, Delivery UUID / build id `26ba195f-d7d1-49c7-a2c7-e2be4f7ce164`, a las 2026-10-15T03:41Z.
- **ASC después**:
  - Build 1.7.18 (59) `VALID`, `usesNonExemptEncryption=false` (igual que los anteriores), `internalBuildState=IN_BETA_TESTING`, vence el 2027-01-12.
  - Disponible en «Chaggu Internal», que tiene acceso a todos los builds; no se añadió a «Chaggu External».
  - La versión pública sigue en 1.7.17 `READY_FOR_SALE`.
- **No se hizo**: envío a revisión, creación o cambio de una versión App Store, testers externos, cambios en `app_releases` de Chaggu, ni creación o revocación de certificados o perfiles.
- **Evidencia del incidente**: `~/ch018-ios-release` se conservó intacto y no se reutilizó `archive.sh`.
- **Pendiente**: prueba funcional en dispositivo por testers internos. Publicar en la App Store o abrir TestFlight externo requiere una autorización aparte.
