-- Agentes miembro (docs/AGENTES.md): webhook de salida por agente para que responda al instante.
-- Un agente es users.kind = 'agent' con token MCP propio. Cuando le escriben por directo, lo mencionan o le
-- responden un mensaje (o, con all_messages, ante cualquier mensaje de sus grupos), se le avisa por HTTPS firmado.
--   secret → cifrado (aes-256-gcm, mismo esquema que integrations.outgoing_secret) porque hay que firmar con él.
CREATE TABLE agent_webhooks (
  agent_user_id  uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  url            text NOT NULL,
  secret         bytea NOT NULL,
  all_messages   boolean NOT NULL DEFAULT false,
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz
);

CREATE TABLE agent_deliveries (
  id             uuid PRIMARY KEY,
  agent_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  event_type     text NOT NULL,
  payload        jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  attempts       int NOT NULL DEFAULT 0,
  last_status    int,
  last_error     text,
  delivered_at   timestamptz
);
CREATE INDEX agent_deliveries_pending ON agent_deliveries(agent_user_id, created_at) WHERE delivered_at IS NULL;
