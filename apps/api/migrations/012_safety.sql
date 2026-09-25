-- Bloqueos personales y reportes de contenido con cola de moderación auditable.
CREATE TABLE user_blocks (
  blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX user_blocks_target ON user_blocks(blocked_id);

CREATE TABLE safety_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reported_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 5 AND 2000),
  message_snapshot text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','message_removed','user_suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  resolved_at timestamptz,
  resolution_note text
);
CREATE INDEX safety_reports_pending ON safety_reports(created_at) WHERE status = 'open';
