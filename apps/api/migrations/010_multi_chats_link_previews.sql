-- Chats grupales entre personas (de una o varias empresas) que no viven en un
-- espacio, y vista previa de enlaces en los mensajes.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_kind_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_kind_check CHECK (kind IN ('group', 'internal', 'direct', 'multi'));
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_check2;
ALTER TABLE conversations ADD CONSTRAINT conversations_workspace_needed CHECK (kind IN ('direct', 'multi') OR workspace_id IS NOT NULL);

-- Vista previa ya resuelta (título, descripción, sitio, miniatura en S3).
ALTER TABLE messages ADD COLUMN link_preview jsonb;

-- Caché por URL: la misma página compartida en varios chats se lee una vez.
CREATE TABLE link_previews (
  url_hash   bytea PRIMARY KEY,
  url        text NOT NULL,
  status     text NOT NULL CHECK (status IN ('ok', 'empty', 'failed')),
  data       jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE files DROP CONSTRAINT IF EXISTS files_purpose_check;
ALTER TABLE files ADD CONSTRAINT files_purpose_check CHECK (purpose IN ('avatar', 'attachment', 'document', 'preview'));
ALTER TABLE files ALTER COLUMN owner_id DROP NOT NULL;
