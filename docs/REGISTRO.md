# Registro por empresa (correo corporativo)

Pedido de Danny (30-sep-2026): el primero que llega de una compañía crea la cuenta de la empresa y los demás se suman. El identificador es el correo corporativo.

## Reglas

| Cómo se registra | Dominio sin empresa | Dominio con empresa |
|---|---|---|
| **Google / Microsoft (SSO)** | Crea la empresa y reclama el dominio (`idp`). | Se suma como miembro (el proveedor garantiza el correo). |
| **Correo y contraseña, corporativo** | Recibe un enlace; al confirmar crea la empresa y reclama el dominio (`email`). | Recibe un enlace; al confirmar se suma como miembro. |
| **Correo personal (Gmail, Hotmail…)** | Crea su empresa al momento, sin reclamar dominio. | — |
| **Con invitación** | Entra al momento a la empresa de la invitación. | Igual. |

- La empresa del dominio se decide **al confirmar**, no al pedir el enlace. Si dos personas de la misma compañía se registran a la vez, la primera que confirme la crea y la segunda se suma: la empresa no se parte.
- Con contraseña nunca se entra sin confirmar el correo. Si no, cualquiera podría escribir `gerente@empresa.com` y quedarse con el dominio o entrar a la empresa.
- El campo «Empresa» es opcional con correo corporativo: si la empresa ya existe se ignora; si no, se usa ese nombre o el del dominio.
- `join_policy`: por defecto `auto` desde la migración 045. Con `invite`, quien llega por dominio recibe `domain_claimed` («pide que te invite»).
- Estados del dominio: `pending` (falta verificar), `email` (alguien confirmó un buzón), `idp` (Google/Microsoft), `dns` (registro TXT, el más fuerte). Un dominio en `email`, `idp` o `dns` pertenece a una sola empresa.

## API

- `POST /auth/signup` con correo corporativo y sin invitación: guarda la solicitud (`signup_confirmations`, hash de la contraseña y del token), manda el correo y responde **409 `email_confirm_sent`** con el mensaje para mostrar. Las apps publicadas muestran ese mensaje tal cual, así que no hubo que actualizarlas. Máximo 5 correos por dirección y hora.
- `GET /auth/signup/confirm/:token`: `{ email, name, orgName, joining }` para la pantalla.
- `POST /auth/signup/confirm { token, device }`: crea la cuenta (correo verificado), la suma o crea la empresa y devuelve la sesión. El enlace es de un solo uso y vence en 48 h.
- Web: `/confirmar/:token` confirma con un toque (no al abrir: los antivirus del correo abren los enlaces solos). En móvil el enlace abre la web; después se entra en la app con correo y contraseña.
- Sin `BREVO_API_KEY` (desarrollo), el registro corporativo sigue siendo inmediato, como antes.

## Pruebas

`test/signup-domain.test.ts` (Brevo falso: `node test/fake-brevo.mjs 59111`) y `test/org-invite-groups.test.ts`.
