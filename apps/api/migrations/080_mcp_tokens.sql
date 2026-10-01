-- Conector MCP (1-oct-2026): tokens personales para que Claude, Codex y otras IAs lean y escriban como la persona.
-- Solo se guarda el hash; el token se muestra una vez al crearlo.
CREATE TABLE mcp_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  token_hash   bytea NOT NULL UNIQUE,
  token_hint   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX mcp_tokens_user ON mcp_tokens(user_id) WHERE revoked_at IS NULL;
