# Inicio de sesión con Google y Microsoft

Un solo flujo para web, iOS, Android y escritorio (Tauri). Los secretos de Google y
Microsoft viven solo en el servidor; los clientes nunca los ven.

## Flujo

1. **El cliente abre en el navegador del sistema** (iOS: `ASWebAuthenticationSession`
   con `prefersEphemeralWebBrowserSession = false`; Android: Custom Tabs; escritorio: el
   navegador por defecto; web: la misma pestaña). Nunca un WebView: Google lo bloquea.

   ```
   GET /api/v1/auth/{google|microsoft}/start
       ?platform=web|ios|android|macos|windows
       &code_challenge=<base64url(SHA-256(verifier)), 43 caracteres>
       &code_challenge_method=S256          (obligatorio; solo S256)
       [&org=<token de invitación de empresa>]
       [&org_name=<nombre de la empresa nueva>]
       [&next=/ruta/interna]
       [&device_id=<id>]                    (se acepta, no se usa)
   ```

   `/start` fija la cookie `tc_sso` (HttpOnly, SameSite=Lax, 10 min). El callback la exige,
   así que el vuelo debe terminar **en el mismo navegador** que lo empezó.

2. **El servidor habla con Google/Microsoft** y redirige al cliente:

   | Plataforma | Éxito | Error |
   |---|---|---|
   | web | `{origen}/auth/sso?code=…[&next=…]` | `{origen}/auth/sso?error=…&message=…` |
   | ios, android, macos, windows | `chaggu://auth/callback?code=…[&next=…]` con `redirect_scheme=chaggu` en `/start` (apps com.chaggu.app); sin él, `tiecoms://…` (apps anteriores) | igual, con `?error=…&message=…` |

   `message` viene en español y se puede mostrar tal cual. Códigos de error:
   `sso_expired`, `sso_state`, `sso_cancelled`, `sso_failed`, `sso_unavailable`,
   `sso_personal_account`, `sso_email_unverified`, `domain_claimed`, `account_disabled`.

3. **El cliente canjea el código** (60 s, un solo uso; se quema al primer intento aunque falle):

   ```
   POST /api/v1/auth/sso/exchange
   { "code": "…", "code_verifier": "…", "device": { "deviceId", "name", "platform", "contract" } }
   ```

   Se acepta `code_verifier` o `codeVerifier`. `device.platform` debe ser la misma de `/start`.
   Responde el mismo `AuthResult` que `/auth/login` (en web el refresh va en cookie).

## Reglas de identidad

- Google: sujeto `sub`. El dominio queda **confirmado** solo con cuentas de Google Workspace
  (`hd` igual al dominio del correo y `email_verified`).
- Microsoft: solo cuentas de trabajo o escuela (`/organizations`); sujeto `tid:oid`. El correo
  solo vale si viene con `xms_edov=true` (evita el ataque «nOAuth»). Sin eso no se crea ni
  se vincula ninguna cuenta.
- Si ya existe una cuenta con ese correo y el proveedor lo garantiza, se vincula.

## Empresas y dominios

- Persona nueva sin invitación con correo corporativo:
  - dominio libre → se crea la empresa; el dominio queda `idp` (confirmado por el proveedor)
    o `pending` (falta el TXT);
  - dominio ya confirmado por otra empresa → `domain_claimed`, salvo que esa empresa tenga
    `join_policy = 'auto'`, en cuyo caso entra como miembro.
- Correos públicos (gmail.com, outlook.com…) nunca reclaman dominio.
- Verificación por DNS (la más fuerte, exclusiva): `POST /api/v1/organizations/:id/domains
  {domain}` devuelve el TXT `tiecoms-verification=…`; luego
  `POST /api/v1/organizations/:id/domains/:domain/verify`.
- `OrganizationDTO.verification`: `none` | `idp` | `dns`, con `verifiedDomain`.

## Configuración

Variables del API: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`,
`MICROSOFT_CLIENT_SECRET`, `API_PUBLIC_ORIGIN` (origen de las redirect URI; por defecto
`PUBLIC_ORIGIN`), `SSO_NATIVE_REDIRECT` (por defecto `tiecoms://auth/callback`).

- Google Cloud: proyecto `tiecoms` (org xertify.co), cliente web «Chaggu API», en producción.
- Microsoft Entra: app «Chaggu», multi-tenant (solo organizaciones), claims opcionales
  `email` y `xms_edov` en el ID token.
- Redirect URI registradas: `https://app.chaggu.com/api/v1/auth/{google|microsoft}/callback`
  y `http://localhost:3021/api/v1/auth/{google|microsoft}/callback` para pruebas.

## Pendiente

- Verificación de publicador en Microsoft (MPN): sin ella, las personas de otros tenants no
  pueden dar consentimiento; solo el administrador del tenant.
- Exigir SSO por empresa (`require_sso`) y solicitudes de unión con aprobación.
- Redirección https (App Links / Universal Links) como alternativa al esquema `tiecoms://`,
  que otra app de Android podría registrar.
