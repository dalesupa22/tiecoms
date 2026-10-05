-- Persistent one-shot MCP schedules. Legacy native rows have no origin token and keep their behavior.
ALTER TABLE scheduled_messages ADD COLUMN mcp_token_id uuid REFERENCES mcp_tokens(id) ON DELETE CASCADE,
  ADD COLUMN timezone text;
CREATE INDEX scheduled_mcp_token ON scheduled_messages(mcp_token_id, send_at) WHERE mcp_token_id IS NOT NULL;

CREATE TABLE mcp_whatsapp_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mcp_token_id uuid NOT NULL REFERENCES mcp_tokens(id) ON DELETE CASCADE,
  account_id uuid REFERENCES wa_accounts(id) ON DELETE SET NULL,
  account_label text NOT NULL,
  jid text NOT NULL,
  target_label text NOT NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  send_at timestamptz NOT NULL,
  timezone text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','queued','sending','sent','failed','cancelled')),
  outbox_id uuid UNIQUE,
  message_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX mcp_wa_schedule_due ON mcp_whatsapp_schedules(send_at) WHERE status = 'pending';
CREATE INDEX mcp_wa_schedule_mine ON mcp_whatsapp_schedules(user_id, send_at);

-- A permanent key registry: unlike immediate-send receipts this is never pruned after 24 hours.
CREATE TABLE mcp_schedule_keys (
  token_id uuid NOT NULL REFERENCES mcp_tokens(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  channel text NOT NULL CHECK (channel IN ('chaggu','whatsapp')),
  schedule_id uuid NOT NULL UNIQUE,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (token_id, key)
);
ALTER TABLE wa_outbox ADD COLUMN mcp_schedule_id uuid UNIQUE REFERENCES mcp_whatsapp_schedules(id) ON DELETE CASCADE,
  ADD COLUMN claimed_at timestamptz;
-- Retain terminal receipt state when the ordinary outbox row is eventually purged, including privacy failures.
CREATE FUNCTION sync_mcp_wa_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE mcp_whatsapp_schedules SET status='failed',error='La cuenta o la cola de WhatsApp ya no está disponible',updated_at=now()
      WHERE id=OLD.mcp_schedule_id AND status IN ('pending','queued','sending');
    RETURN OLD;
  END IF;
  IF NEW.mcp_schedule_id IS NOT NULL THEN
    UPDATE mcp_whatsapp_schedules SET status = NEW.status, outbox_id = NEW.id,
      message_id = NEW.wa_message_id, error = NEW.error, sent_at = NEW.sent_at, updated_at = now()
      WHERE id = NEW.mcp_schedule_id AND status <> 'cancelled';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wa_outbox_mcp_schedule AFTER INSERT OR DELETE OR UPDATE OF status ON wa_outbox
  FOR EACH ROW EXECUTE FUNCTION sync_mcp_wa_schedule();

-- Account removal must not strand pending receipts or falsely claim a queued delivery can still run.
CREATE FUNCTION fail_removed_mcp_wa_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE wa_outbox SET status='failed',error='La cuenta de WhatsApp fue eliminada',body=''
    WHERE account_id=OLD.id AND mcp_schedule_id IS NOT NULL AND status IN ('queued','sending');
  UPDATE mcp_whatsapp_schedules SET status='failed',error='La cuenta de WhatsApp fue eliminada',updated_at=now()
    WHERE account_id=OLD.id AND status IN ('pending','queued','sending');
  RETURN OLD;
END $$;
CREATE TRIGGER wa_account_mcp_schedule_remove BEFORE DELETE ON wa_accounts
  FOR EACH ROW EXECUTE FUNCTION fail_removed_mcp_wa_account();

-- The app soft-removes accounts before the bridge's eventual purge; fail immediately even if the bridge is offline.
CREATE TRIGGER wa_account_mcp_schedule_soft_remove AFTER UPDATE OF removed_at ON wa_accounts
  FOR EACH ROW WHEN (OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL) EXECUTE FUNCTION fail_removed_mcp_wa_account();
