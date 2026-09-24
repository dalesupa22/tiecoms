-- Archivos en S3 (por ahora, fotos de perfil) y foto de cada persona.
CREATE TABLE files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose      text NOT NULL CHECK (purpose IN ('avatar', 'attachment')),
  s3_key       text NOT NULL UNIQUE,
  content_type text NOT NULL,
  size_bytes   int NOT NULL CHECK (size_bytes > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX files_owner ON files(owner_id) WHERE deleted_at IS NULL;

ALTER TABLE users ADD COLUMN avatar_file_id uuid REFERENCES files(id) ON DELETE SET NULL;
