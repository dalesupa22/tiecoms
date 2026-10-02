-- Additive explicit dialog data; old meeting retries keep the original fingerprint.
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS attendee_emails jsonb;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS invitee_ids uuid[];

ALTER TABLE users ADD COLUMN IF NOT EXISTS availability_sleeping boolean;
