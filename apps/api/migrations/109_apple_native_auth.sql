-- Additive native Apple authentication. Existing Google/Microsoft clients stay unchanged.
ALTER TABLE user_identities DROP CONSTRAINT user_identities_provider_check;
ALTER TABLE user_identities ADD CONSTRAINT user_identities_provider_check CHECK (provider IN ('google','microsoft','apple'));
CREATE UNIQUE INDEX user_identities_one_apple_per_user ON user_identities(user_id) WHERE provider = 'apple';

CREATE TABLE apple_auth_challenges (
  challenge_hash bytea PRIMARY KEY,
  nonce text NOT NULL,
  client_challenge text NOT NULL,
  device_id text NOT NULL,
  link_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  link_session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
  org_invite_token text,
  org_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK ((link_user_id IS NULL) = (link_session_id IS NULL))
);
CREATE INDEX apple_auth_challenges_expiry ON apple_auth_challenges(expires_at);

-- Tokens are AES-256-GCM ciphertext with record-id-bound authenticated data.
-- No Apple token ever goes in jobs, audit_events, outbox or logs.
CREATE TABLE apple_auth_tokens (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  subject_hash bytea NOT NULL,
  encrypted_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoke_pending boolean NOT NULL DEFAULT false
);
CREATE INDEX apple_auth_tokens_user ON apple_auth_tokens(user_id);
CREATE INDEX apple_auth_tokens_pending ON apple_auth_tokens(revoke_pending, created_at);

-- Short-lived, non-reversible marker rejects a token issued before account deletion.
-- It cannot identify a user or recreate a deleted identity.
CREATE TABLE apple_auth_deletions (
  subject_hash bytea PRIMARY KEY,
  deleted_at timestamptz NOT NULL DEFAULT now()
);
