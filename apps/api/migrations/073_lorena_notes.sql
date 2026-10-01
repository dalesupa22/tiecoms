-- Notes and chat organization are personal. Referencing a chat never publishes a message there.
CREATE TABLE personal_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  tags jsonb NOT NULL DEFAULT '[]',
  file_ids uuid[] NOT NULL DEFAULT '{}',
  links jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX personal_notes_owner_updated ON personal_notes(owner_id, updated_at DESC);
CREATE TABLE user_personal_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  preferences jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_phone text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_company text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_bio text;
