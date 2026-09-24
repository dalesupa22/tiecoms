# Conectar WhatsApp

Cada persona puede conectar varias cuentas (hasta 5): su WhatsApp personal y su WhatsApp Business. TieComs lee sus grupos, chats y mensajes y los organiza por tema. Todo es privado de su dueño.

## Cómo funciona

- **Librería:** [Baileys](https://github.com/WhiskeySockets/Baileys) (`baileys@7.0.0-rc14`). Se vincula como *dispositivo vinculado*, igual que WhatsApp Web, así que sirve para la app personal y para la app Business. No es la API oficial de Meta (esa solo sirve para números Business registrados en la Cloud API y no lee grupos de una cuenta personal).
- **Proceso `wa`** (`apps/api/src/wa-bridge.ts`, servicio `wa` en `infra/compose.yml`): mantiene una sesión por cuenta. Reclama cada cuenta con un lease en `wa_accounts` (una sola sesión aunque haya varias réplicas) y se despierta con `NOTIFY tiecoms_wa`.
- **Guardado** (`apps/api/src/modules/wa-sync.ts`): credenciales y llaves de Signal cifradas con AES-256-GCM en `wa_auth` (llave `WA_STORE_KEY`, o derivada de `JWT_SECRET` si no está; si cambia, hay que volver a vincular). Chats, contactos y mensajes de texto en `wa_chats`, `wa_contacts`, `wa_messages` (del historial inicial, solo los últimos 120 días). Lo multimedia se guarda como descripción («📷 Foto»), no se descarga.
- **API** (`apps/api/src/modules/whatsapp.ts`): `/api/v1/whatsapp/accounts` (crear, listar, `relink`, borrar), `/api/v1/whatsapp/chats` (filtros por cuenta, categoría, grupos, búsqueda, ocultos), `PATCH /chats/:accountId/:jid` (categoría, fijar, ocultar, vincular) y `/organize`.
- **Organizador** (`apps/api/src/modules/wa-organize.ts`): sugiere Trabajo, Clientes, Familia, Amigos, Comunidad u Otros por el nombre del grupo o contacto. Lo que la persona mueve a mano no se vuelve a tocar.
- **Vincular a TieComs:** un chat puede enviar sus mensajes *nuevos* a una conversación donde la persona puede publicar; llegan como «reenviado de WhatsApp», a su nombre, sin duplicados.
- **Solo lectura:** no envía mensajes, no marca como leído y no se pone «en línea».

## Vincular

QR (Ajustes › Dispositivos vinculados › Vincular un dispositivo) o, desde el mismo teléfono, código de 8 letras con el número («Vincular con el número de teléfono»). El QR vence si nadie lo escanea; la pantalla ofrece otro. Si se cierra la sesión desde el teléfono, la cuenta queda en `logged_out` y se borran sus credenciales.

## Notas

- Con `Browsers.macOS('Desktop')` WhatsApp cierra con 428 antes del QR (probado el 24-sep-2026); se usa `Browsers.macOS('Chrome')`.
- Se anuncia la versión actual de WhatsApp Web (`fetchLatestWaWebVersion`, refrescada cada 6 h).
- Riesgo: WhatsApp no permite oficialmente clientes no oficiales y puede suspender números que los usan de forma abusiva. Para lectura personal el riesgo es bajo, pero existe.
- Pruebas: `test/whatsapp.test.ts` (API + guardado, sin hablar con WhatsApp).
