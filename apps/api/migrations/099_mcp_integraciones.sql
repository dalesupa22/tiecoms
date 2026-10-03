-- MCP para integraciones (3-oct-2026, docs/PLAN-MCP-INTEGRACIONES-SEMILLERO.md y docs/MCP.md).

-- 1. Permisos por token: scopes (NULL = todos, tokens anteriores), vencimiento, app y números de WhatsApp.
--    wa_account_ids NULL = los números con integraciones encendidas; con lista = exactamente esos (los elige la persona).
ALTER TABLE mcp_tokens ADD COLUMN scopes text[], ADD COLUMN expires_at timestamptz, ADD COLUMN client_name text,
  ADD COLUMN wa_account_ids uuid[];
ALTER TABLE mcp_oauth_codes ADD COLUMN scopes text[], ADD COLUMN wa_account_ids uuid[];
-- Los tokens que ya existen siguen viendo lo mismo que antes: se les fijan los números actuales de su dueño.
UPDATE mcp_tokens t SET wa_account_ids = ARRAY(SELECT a.id FROM wa_accounts a WHERE a.user_id = t.user_id AND a.removed_at IS NULL)
 WHERE t.revoked_at IS NULL AND EXISTS (SELECT 1 FROM wa_accounts a WHERE a.user_id = t.user_id AND a.removed_at IS NULL);

-- 2. Doble llave de WhatsApp: el número decide si lo ven las integraciones (personal apagado por defecto) y un
--    chat suelto se puede compartir aunque su número esté apagado.
ALTER TABLE wa_accounts ADD COLUMN integrations_enabled boolean NOT NULL DEFAULT false;
UPDATE wa_accounts SET integrations_enabled = true WHERE kind = 'business';
ALTER TABLE wa_chats ADD COLUMN integrations_shared boolean NOT NULL DEFAULT false;
-- 9. Participantes de los grupos (los guarda el puente con los metadatos del grupo).
ALTER TABLE wa_chats ADD COLUMN members jsonb;

-- 6. Transcripción de las notas de voz de WhatsApp: {status, text, summary, language, error}.
ALTER TABLE wa_messages ADD COLUMN transcript jsonb;

-- 4. Bitácora por token: qué herramienta, sobre qué y cuántos, sin contenido.
CREATE TABLE mcp_audit (
  id         bigserial PRIMARY KEY,
  token_id   uuid NOT NULL REFERENCES mcp_tokens(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool       text NOT NULL,
  target     text,
  items      int NOT NULL DEFAULT 0,
  ok         boolean NOT NULL,
  error      text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mcp_audit_user ON mcp_audit(user_id, created_at DESC);

-- 13. Envíos idempotentes: una llave por token durante 24 h.
CREATE TABLE mcp_idempotency (
  token_id   uuid NOT NULL REFERENCES mcp_tokens(id) ON DELETE CASCADE,
  key        text NOT NULL,
  request    bytea NOT NULL,
  response   jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (token_id, key)
);

-- 10. Avisos al instante de WhatsApp hacia una integración, solo de los chats de su lista.
CREATE TABLE mcp_webhooks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id   uuid NOT NULL REFERENCES mcp_tokens(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url        text NOT NULL,
  secret     bytea NOT NULL,
  events     text[] NOT NULL,
  chats      text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX mcp_webhooks_user ON mcp_webhooks(user_id) WHERE revoked_at IS NULL;
CREATE TABLE mcp_webhook_deliveries (
  id          uuid PRIMARY KEY,
  webhook_id  uuid NOT NULL REFERENCES mcp_webhooks(id) ON DELETE CASCADE,
  event_type  text NOT NULL,
  payload     jsonb NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  last_status int,
  last_error  text,
  delivered_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mcp_webhook_deliveries_hook ON mcp_webhook_deliveries(webhook_id, created_at DESC);

-- 12. Borradores de WhatsApp que la persona aprueba (Enviar, Editar o Descartar).
CREATE TABLE wa_drafts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_id     uuid REFERENCES mcp_tokens(id) ON DELETE SET NULL,
  account_id   uuid NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
  jid          text NOT NULL,
  to_label     text,
  body         text NOT NULL,
  source       text,
  external_ref text,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'discarded', 'failed')),
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz
);
CREATE INDEX wa_drafts_pending ON wa_drafts(user_id, created_at DESC) WHERE status = 'pending';
