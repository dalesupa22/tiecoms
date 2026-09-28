-- OAuth callbacks never activate credentials. Only the initiating authenticated client can
-- redeem the unguessable receipt delivered to its browser, with its privately held proof.
ALTER TABLE meeting_flows ADD COLUMN proof_challenge text;
CREATE TABLE meeting_confirmations (
  receipt_hash bytea PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  proof_challenge text NOT NULL,
  tokens_enc bytea NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX meeting_confirmations_expiry ON meeting_confirmations(expires_at);

-- Reservations survive ambiguous provider responses and process restarts.
ALTER TABLE meetings ADD COLUMN request_fingerprint bytea;
ALTER TABLE meetings ADD COLUMN operation_state text NOT NULL DEFAULT 'reserved'
  CHECK (operation_state IN ('reserved','inflight','pending','uncertain','complete','failed'));
ALTER TABLE meetings ADD COLUMN error_code text;
ALTER TABLE meetings ADD COLUMN error_status integer;
ALTER TABLE meetings ADD COLUMN share_requested boolean NOT NULL DEFAULT false;
ALTER TABLE meetings ADD COLUMN instant boolean NOT NULL DEFAULT false;
-- Existing incomplete rows must never cause a second external POST after upgrading.
UPDATE meetings SET operation_state = CASE WHEN status = 'created' THEN 'complete' ELSE 'uncertain' END;

ALTER TABLE meeting_connections ADD COLUMN generation uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE meetings ADD COLUMN connection_generation uuid;
