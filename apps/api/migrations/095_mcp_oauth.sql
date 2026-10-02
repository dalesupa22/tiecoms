-- Conector MCP con OAuth (2-oct-2026): Claude, Codex o ChatGPT se conectan con la URL y cada persona autoriza con su
-- propia cuenta de chaggu. El token que recibe la IA es un mcp_tokens más (se ve y se revoca en Tú › Conector para IAs).
CREATE TABLE mcp_oauth_clients (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  redirect_uris text[] NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mcp_oauth_codes (
  code_hash      bytea PRIMARY KEY,
  client_id      text NOT NULL REFERENCES mcp_oauth_clients(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri   text NOT NULL,
  code_challenge text NOT NULL,
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz
);
ALTER TABLE mcp_tokens ADD COLUMN client_id text REFERENCES mcp_oauth_clients(id) ON DELETE SET NULL;
ALTER TABLE mcp_tokens ADD COLUMN refresh_hash bytea UNIQUE;
