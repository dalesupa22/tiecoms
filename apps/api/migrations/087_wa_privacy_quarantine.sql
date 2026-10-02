-- Distinguish the first invalidation from retries while the account is already closed.
ALTER TABLE wa_accounts ADD COLUMN privacy_quarantined_at timestamptz;
-- Explicit app-state actions are ordered independently of late PN/LID mappings.
-- Revision zero denotes history metadata, which cannot overrule a later explicit action.
CREATE SEQUENCE wa_lock_revision_seq;
ALTER TABLE wa_chats ADD COLUMN wa_lock_revision bigint NOT NULL DEFAULT 0;
