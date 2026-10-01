# Conector MCP de chaggu

Claude, Codex, ChatGPT y otras IAs leen y escriben en chaggu como la persona, con sus mismos permisos.

- **URL:** `https://app.chaggu.com/api/mcp` (MCP Streamable HTTP sin estado, JSON-RPC por POST).
- **Token:** en la app, *Tú › Conector para IAs › Crear token* (o `POST /api/v1/me/mcp-tokens`). Empieza por `chgmcp_`,
  se muestra una vez, se guarda solo el hash (tabla `mcp_tokens`, migración 080) y se revoca en la misma pantalla.
- **Herramientas:** `whoami`, `list_chats`, `read_messages`, `send_message`, `send_direct_message`, `search_messages`,
  `unread_summary`, `mark_read`, `list_people`. Chats y personas se nombran por id o por nombre.
- Código: `apps/api/src/modules/mcp.ts`; pruebas: `apps/api/test/mcp.test.ts`.

## Conectar

Claude Code:

    claude mcp add --transport http chaggu https://app.chaggu.com/api/mcp --header "Authorization: Bearer chgmcp_…"

Codex (`~/.codex/config.toml`):

    [mcp_servers.chaggu]
    url = "https://app.chaggu.com/api/mcp"
    bearer_token_env_var = "CHAGGU_MCP_TOKEN"
