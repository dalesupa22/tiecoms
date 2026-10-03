# Conector MCP de chaggu

Claude, Codex, ChatGPT y otras IAs leen y escriben en chaggu como la persona, con sus mismos permisos.

- **URL:** `https://app.chaggu.com/api/mcp` (MCP Streamable HTTP sin estado, JSON-RPC por POST).
- **Entrar (recomendado):** OAuth 2.1 con PKCE y registro dinámico. La IA solo necesita la URL; abre `/autorizar-ia`, la persona entra con SU cuenta y aprueba (`apps/api/src/modules/mcp-oauth.ts`, migración 095). Cada token es de una persona y solo ve lo que ella ve.
- **Token manual:** en la app, *Tú › Conector para IAs › Crear token* (o `POST /api/v1/me/mcp-tokens`). Empieza por `chgmcp_`,
  se muestra una vez, se guarda solo el hash (tabla `mcp_tokens`, migración 080) y se revoca en la misma pantalla.
- **Herramientas:**
  - Chats de chaggu: `whoami`, `list_chats`, `read_messages`, `send_message`, `send_direct_message`, `search_messages`, `unread_summary`, `mark_read`, `list_people`.
  - WhatsApp (ver «Privacidad de WhatsApp» abajo): `list_whatsapp_numbers`, `list_whatsapp_chats` (cursor, since, teléfono, quién habló de último; vista previa solo con `include_preview`), `read_whatsapp` (`fromMe`, `kind`, teléfono, transcripción de notas de voz; `since`/`before`/`kinds`), `find_whatsapp_chat` (por teléfono, también `@lid`), `get_whatsapp_group` (participantes), `search_whatsapp` (texto y transcripciones), `send_whatsapp` (a `chat` o a `phone` nuevo, con `idempotency_key`), `create_whatsapp_draft` / `list_whatsapp_drafts` / `delete_whatsapp_draft` (por aprobar en WhatsApp › Por enviar), `set_whatsapp_webhook` / `get_whatsapp_webhook` / `delete_whatsapp_webhook`.
  - Correo (Gmail/Outlook propio): `list_emails`, `read_email`, `reply_email`.
  - Tickets y tareas: `list_tasks`, `get_task`, `create_task`, `update_task` (estado, responsables, fecha, título), `comment_task`.
  - Calendario: `list_calendar`, `create_event`, `update_event` (incluye cancelar), `rsvp_event`.
  - Responder al cliente: `find_client_channels` + prompt `responder_cliente`. Las instrucciones del servidor piden que, al resolver un ticket, la IA pregunte si responderle al cliente y por qué canal, y que nunca envíe sin confirmación. Chats y personas se nombran por id o por nombre.
- Código: `apps/api/src/modules/mcp.ts` (herramientas y permisos), `mcp-wa.ts` (WhatsApp), `mcp-oauth.ts`; pruebas: `apps/api/test/mcp.test.ts` y `mcp-integraciones.test.ts`. Plan de origen: `docs/PLAN-MCP-INTEGRACIONES-SEMILLERO.md`.

## Permisos por token (migración 099)

- Scopes: `chats:read`, `chats:write`, `whatsapp:read`, `whatsapp:send`, `whatsapp:draft`, `email`, `tasks:read`, `tasks:write`, `calendar`. `NULL` = todos (tokens anteriores). `tools/list` solo muestra lo permitido y `tools/call` responde `[forbidden_scope]`.
- Vencimiento (`expires_at`, 401 al vencer) y nombre de la app (`client_name`). Se eligen al crear el token en Tú › Conector para IAs o al aprobar en `/autorizar-ia` (la IA puede pedir scopes con `scope=`).
- Bitácora `mcp_audit` (herramienta, objetivo, cantidad, error; sin contenido): `GET /api/v1/me/mcp-activity` y el resumen «Hoy: leyó 3 · envió 1» en cada token. Se guarda 90 días.
- Errores de herramienta con código estable en `structuredContent.error.code`: `forbidden_scope`, `not_found`, `send_disabled`, `not_connected`, `integrations_disabled`, `invalid_phone`, `idempotency_mismatch`, `bad_request`.

## Privacidad de WhatsApp (doble llave)

1. **Número:** `wa_accounts.integrations_enabled` («Compartir con integraciones» en la tarjeta). Business encendido, personal apagado por defecto.
2. **Token:** `mcp_tokens.wa_account_ids`. `NULL` = los números compartidos; con lista = exactamente esos (la persona puede darle el personal a SU ChatGPT para encargos sin dárselo a Semillero). Los tokens que ya existían quedaron con todos los números de su dueño (para no romperlos).
3. **Chat suelto:** `wa_chats.integrations_shared` («🤖 Compartir con integraciones» en el panel del chat), aunque el número esté apagado.
Siempre aplican además el dueño de la cuenta y los chats bloqueados de WhatsApp (`wa-privacy.ts`). La app de la persona no cambia.

## Notas de voz, avisos y borradores

- **Transcripción:** las notas de voz descargadas (`media_info.kind = voice`) de números o chats compartidos se transcriben solas (job `wa.transcribe`, escaneo cada minuto, últimos 3 días, tope `WA_TRANSCRIBE_DAILY_MAX`=300/día por cuenta y `WA_TRANSCRIBE_MAX_MS`=10 min). `read_whatsapp` también encola las que lea. Mismo proveedor que las notas de chaggu (Inworld + resumen DeepSeek).
- **Avisos al instante:** `set_whatsapp_webhook {url, chats, events}` por token, firmado como las integraciones (`x-chaggu-signature: t=…,v1=hmac`). Eventos `whatsapp.message.received|sent|transcribed`, `whatsapp.draft.sent|discarded`. Solo chats listados y aún compartidos (se revisa al entregar). Reintentos con backoff (job `mcp.webhook`, 8 intentos).
- **Borradores:** `create_whatsapp_draft` → WhatsApp › «Por enviar» (web) con push agrupado `wa.drafts`; Enviar (editable) o Descartar. Falta la pantalla en iOS/Android (el push llega, pero abre la app sin la lista).
- **Envío idempotente:** `idempotency_key` única por token 24 h (`mcp_idempotency`). `phone` crea el chat si no existe.

## Conectar

Claude Code (luego `/mcp` › chaggu › Authenticate):

    claude mcp add --transport http chaggu https://app.chaggu.com/api/mcp

Codex: `codex mcp add chaggu --url https://app.chaggu.com/api/mcp` y `codex mcp login chaggu`.

claude.ai / ChatGPT: conector personalizado con la misma URL.

Con token manual:

    claude mcp add --transport http chaggu https://app.chaggu.com/api/mcp --header "Authorization: Bearer chgmcp_…"

Codex (`~/.codex/config.toml`):

    [mcp_servers.chaggu]
    url = "https://app.chaggu.com/api/mcp"
    bearer_token_env_var = "CHAGGU_MCP_TOKEN"
