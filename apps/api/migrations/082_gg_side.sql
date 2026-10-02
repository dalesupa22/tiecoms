-- «gg de este chat» (1-oct-2026, docs/WA-BANDEJA-GG-CHAT.md): conversación PRIVADA de una persona con gg sobre UN chat
-- (de chaggu 'c:<conversationId>' o de WhatsApp 'wa:<accountId>:<jid>'). El chat general de gg sigue aparte.
CREATE TABLE gg_side_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source      text NOT NULL,
  session     int  NOT NULL DEFAULT 1,
  role        text NOT NULL CHECK (role IN ('user','gg')),
  body        text NOT NULL,
  quoted      jsonb,
  extra       jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gg_side_by_source ON gg_side_messages(user_id, source, session, created_at);
CREATE TABLE gg_side_state (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source  text NOT NULL,
  session int NOT NULL DEFAULT 1,
  pending_count int NOT NULL DEFAULT 0,
  pending_seen_seq bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, source)
);
