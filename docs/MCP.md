# Conector MCP de chaggu

Claude, Codex, ChatGPT y otras IAs leen y escriben en chaggu como la persona, con sus mismos permisos.

- **URL:** `https://app.chaggu.com/api/mcp` (MCP Streamable HTTP sin estado, JSON-RPC por POST).
- **Entrar (recomendado):** OAuth 2.1 con PKCE y registro dinámico. La IA solo necesita la URL; abre `/autorizar-ia`, la persona entra con SU cuenta y aprueba (`apps/api/src/modules/mcp-oauth.ts`, migración 095). Cada token es de una persona y solo ve lo que ella ve.
- **Token manual:** en la app, *Tú › Conector para IAs › Crear token* (o `POST /api/v1/me/mcp-tokens`). Empieza por `chgmcp_`,
  se muestra una vez, se guarda solo el hash (tabla `mcp_tokens`, migración 080) y se revoca en la misma pantalla.
- **Herramientas:**
  - Chats de chaggu: `whoami`, `list_chats`, `read_messages`, `send_message`, `send_direct_message`, `search_messages`, `unread_summary`, `mark_read`, `list_people`.
  - WhatsApp (cuentas propias; enviar exige «Responder desde chaggu»; respeta chats bloqueados): `list_whatsapp_chats`, `read_whatsapp`, `send_whatsapp`.
  - Correo (Gmail/Outlook propio): `list_emails`, `read_email`, `reply_email`.
  - Tickets y tareas: `list_tasks`, `get_task`, `create_task`, `update_task` (estado, responsables, fecha, título), `comment_task`.
  - Calendario: `list_calendar`, `create_event`, `update_event` (incluye cancelar), `rsvp_event`.
  - Responder al cliente: `find_client_channels` + prompt `responder_cliente`. Las instrucciones del servidor piden que, al resolver un ticket, la IA pregunte si responderle al cliente y por qué canal, y que nunca envíe sin confirmación. Chats y personas se nombran por id o por nombre.
- Código: `apps/api/src/modules/mcp.ts`; pruebas: `apps/api/test/mcp.test.ts`.

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
