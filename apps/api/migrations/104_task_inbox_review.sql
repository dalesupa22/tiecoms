-- Llamada con Lorena (7-oct-2026): avisar las tareas que llegan (no solo las que se cierran) y una etapa de
-- revisión humana para los tickets que resuelve la IA. Columnas nuevas opcionales: los clientes anteriores las ignoran.
ALTER TABLE issues ADD COLUMN review text CHECK (review IN ('pending', 'approved', 'changes', 'human'));
ALTER TABLE issues ADD COLUMN review_by uuid REFERENCES users(id);
ALTER TABLE issues ADD COLUMN review_at timestamptz;
-- Quién pidió la revisión (la IA o la persona que la dejó «por revisar»): recibe la decisión.
ALTER TABLE issues ADD COLUMN review_requested_by uuid REFERENCES users(id);

-- Bandeja «Nuevas» de cada persona: una fila por tarea, se renueva si vuelve a llegar algo y se limpia al verla.
CREATE TABLE issue_inbox (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason IN ('assigned', 'review', 'reviewed')),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  seen_at timestamptz,
  PRIMARY KEY (user_id, issue_id)
);
CREATE INDEX issue_inbox_unseen ON issue_inbox (user_id, created_at DESC) WHERE seen_at IS NULL;

ALTER TABLE issue_events DROP CONSTRAINT IF EXISTS issue_events_kind_check;
ALTER TABLE issue_events ADD CONSTRAINT issue_events_kind_check CHECK (kind IN ('created','status','owner','due','title','comment','waiting','visibility','assignees','attachments','moved','fields','review'));
