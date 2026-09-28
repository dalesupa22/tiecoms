-- Tareas derivadas de un asunto y visibilidad por asunto.
-- Ejemplo: James (Los Andes) abre un asunto en el grupo con Xertify; de ahí salen tareas para Danny,
-- Lorena y Adriana que solo ve Xertify, o una privada con un tercero de otra empresa.
--   visibility = 'all'     → quien puede leer la conversación (como hasta ahora)
--   visibility = 'org'     → solo las personas de visible_org_id que están en la conversación, más issue_viewers
--   visibility = 'private' → solo issue_viewers (quien la creó, el responsable y a quien se agregue)
-- Un responsable de un asunto restringido puede no estar en la conversación: ve la tarea, no el chat.
ALTER TABLE issues
  ADD COLUMN parent_issue_id uuid REFERENCES issues(id) ON DELETE CASCADE,
  ADD COLUMN visibility text NOT NULL DEFAULT 'all' CHECK (visibility IN ('all','org','private')),
  ADD COLUMN visible_org_id uuid REFERENCES organizations(id),
  ADD CONSTRAINT issues_org_visibility CHECK (visibility <> 'org' OR visible_org_id IS NOT NULL);
CREATE INDEX issues_parent ON issues(parent_issue_id) WHERE parent_issue_id IS NOT NULL;

CREATE TABLE issue_viewers (
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by uuid REFERENCES users(id),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issue_id, user_id)
);
CREATE INDEX issue_viewers_user ON issue_viewers(user_id);

-- Sidechat abierto desde un asunto: las tareas que nacen ahí son hijas de ese asunto y solo las ve el sidechat.
ALTER TABLE conversations ADD COLUMN side_issue_id uuid REFERENCES issues(id) ON DELETE SET NULL;

-- Historial: cambio de quién ve el asunto.
ALTER TABLE issue_events DROP CONSTRAINT IF EXISTS issue_events_kind_check;
ALTER TABLE issue_events ADD CONSTRAINT issue_events_kind_check CHECK (kind IN ('created','status','owner','due','title','comment','waiting','visibility'));
