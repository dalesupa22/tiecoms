-- Archivos en árbol de carpetas. Cada árbol tiene un alcance: «Mis archivos»
-- (workspace_id NULL, solo su dueño) o un espacio (todos sus miembros activos).
-- El borrado es lógico: la política de S3 de TieComs no permite borrar objetos.
CREATE TABLE folders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  parent_id    uuid REFERENCES folders(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  CHECK ((workspace_id IS NULL) <> (owner_id IS NULL))
);
CREATE INDEX folders_ws ON folders(workspace_id) WHERE deleted_at IS NULL;
CREATE INDEX folders_owner ON folders(owner_id) WHERE deleted_at IS NULL;

ALTER TABLE files DROP CONSTRAINT files_purpose_check;
ALTER TABLE files ADD CONSTRAINT files_purpose_check CHECK (purpose IN ('avatar', 'attachment', 'document'));
ALTER TABLE files ADD COLUMN name text;
ALTER TABLE files ADD COLUMN workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE files ADD COLUMN folder_id uuid REFERENCES folders(id) ON DELETE SET NULL;
ALTER TABLE files ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX files_ws_docs ON files(workspace_id) WHERE purpose = 'document' AND deleted_at IS NULL;
CREATE INDEX files_owner_docs ON files(owner_id) WHERE purpose = 'document' AND workspace_id IS NULL AND deleted_at IS NULL;
