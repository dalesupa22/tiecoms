-- Admins de grupo (como WhatsApp) e integraciones por grupo (webhook entrante, API de asuntos y webhook de salida).
--
-- Admins: conversation_memberships.can_manage ya existía. Aquí solo se completa: quien creó el grupo es admin
-- (lo era desde 001) y ningún grupo queda sin admin; lo demás son reglas del API.
--
-- Integraciones: un grupo puede tener varias. Cada una publica como un participante bot (users.kind = 'agent')
-- que es miembro de la conversación. La crea quien administra el espacio (lead/admin) o la empresa (owner/admin).
--   token_hash      → sha256 del token `chg_…` (se muestra una sola vez). Autoriza el webhook entrante y el API.
--   outgoing_url    → a dónde se avisan los cambios de sus asuntos (estado y comentarios), firmados con HMAC.
--   outgoing_secret → cifrado (aes-256-gcm) porque hay que poder firmar con él.

-- Grupos sin admin (p. ej. el creador salió): el miembro más antiguo que no es tercero pasa a serlo.
UPDATE conversation_memberships m SET can_manage = true
  FROM (
    SELECT DISTINCT ON (x.conversation_id) x.conversation_id, x.user_id
      FROM conversation_memberships x
      JOIN conversations c ON c.id = x.conversation_id AND c.kind IN ('group','internal') AND c.archived_at IS NULL
      LEFT JOIN workspace_memberships wm ON wm.workspace_id = c.workspace_id AND wm.user_id = x.user_id
     WHERE x.removed_at IS NULL AND COALESCE(wm.role, 'member') <> 'guest'
       AND NOT EXISTS (SELECT 1 FROM conversation_memberships y WHERE y.conversation_id = x.conversation_id AND y.removed_at IS NULL AND y.can_manage)
     ORDER BY x.conversation_id, x.joined_at
  ) pick
 WHERE m.conversation_id = pick.conversation_id AND m.user_id = pick.user_id;

CREATE TABLE integrations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  bot_user_id      uuid NOT NULL REFERENCES users(id),
  name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  token_hash       bytea NOT NULL UNIQUE,
  token_hint       text NOT NULL,
  outgoing_url     text,
  outgoing_secret  bytea,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  rotated_at       timestamptz,
  last_used_at     timestamptz,
  revoked_at       timestamptz
);
CREATE INDEX integrations_conversation ON integrations(conversation_id) WHERE revoked_at IS NULL;

-- Asuntos que vienen de un sistema externo (p. ej. tickets de la mesa de ayuda de Xertify).
-- external_id es único por integración: crear dos veces el mismo ticket devuelve el mismo asunto.
ALTER TABLE issues
  ADD COLUMN integration_id uuid REFERENCES integrations(id) ON DELETE SET NULL,
  ADD COLUMN external_id    text CHECK (external_id IS NULL OR length(external_id) BETWEEN 1 AND 120),
  ADD COLUMN external_meta  jsonb;
CREATE UNIQUE INDEX issues_integration_external ON issues(integration_id, external_id) WHERE integration_id IS NOT NULL AND external_id IS NOT NULL;

-- Idempotencia del webhook entrante y de los comentarios del API (reintentos del sistema externo).
CREATE TABLE integration_requests (
  integration_id  uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  response        jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (integration_id, idempotency_key)
);

-- Entregas del webhook de salida: una fila por evento; el worker reintenta con backoff (jobs).
CREATE TABLE integration_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id  uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  event_type      text NOT NULL,
  payload         jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  attempts        int NOT NULL DEFAULT 0,
  last_status     int,
  last_error      text,
  delivered_at    timestamptz
);
CREATE INDEX integration_deliveries_pending ON integration_deliveries(integration_id, created_at) WHERE delivered_at IS NULL;
