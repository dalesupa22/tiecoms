-- 1) Asuntos personales: sin conversación, solo los ve su dueño (visibility 'private' y issue_viewers = él).
ALTER TABLE issues ALTER COLUMN conversation_id DROP NOT NULL;
ALTER TABLE issues ADD CONSTRAINT issues_personal_shape
  CHECK (conversation_id IS NOT NULL OR (visibility = 'private' AND parent_issue_id IS NULL AND workspace_id IS NULL));
CREATE INDEX issues_personal ON issues(created_by) WHERE conversation_id IS NULL;

-- 2) Conexiones por persona con Google, Microsoft o Zoom para crear reuniones (Meet, Teams, Zoom).
-- Los tokens se guardan cifrados (AES-256-GCM); nunca salen del servidor.
CREATE TABLE meeting_connections (
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         text NOT NULL CHECK (provider IN ('google','microsoft','zoom')),
  account_email    text,
  scopes           text NOT NULL DEFAULT '',
  access_token_enc bytea,
  refresh_token_enc bytea,
  expires_at       timestamptz,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','reconnect')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE meeting_flows (
  state_hash    bytea PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      text NOT NULL,
  verifier      text NOT NULL,
  platform      text NOT NULL,
  native_scheme text,
  expires_at    timestamptz NOT NULL
);

-- Cada «crear reunión» con su llave de idempotencia: un doble toque o un reintento no crea dos.
CREATE TABLE meetings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          text NOT NULL,
  conversation_id   uuid REFERENCES conversations(id) ON DELETE SET NULL,
  idempotency_key   text NOT NULL,
  status            text NOT NULL DEFAULT 'creating' CHECK (status IN ('creating','created','failed')),
  title             text NOT NULL,
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,
  timezone          text NOT NULL,
  join_url          text,
  external_id       text,
  calendar_event_id uuid REFERENCES calendar_events(id) ON DELETE SET NULL,
  message_id        uuid REFERENCES messages(id) ON DELETE SET NULL,
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
