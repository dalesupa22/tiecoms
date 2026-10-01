-- Responsables múltiples y archivos propios de una tarea. Contrato aditivo para apps en revisión.
ALTER TABLE issues ADD COLUMN assignee_ids uuid[] NOT NULL DEFAULT '{}';
UPDATE issues SET assignee_ids = ARRAY[owner_id] WHERE owner_id IS NOT NULL;
CREATE INDEX issues_assignees ON issues USING gin (assignee_ids);
ALTER TABLE attachments ALTER COLUMN conversation_id DROP NOT NULL;
ALTER TABLE attachments ADD COLUMN issue_id uuid REFERENCES issues(id) ON DELETE CASCADE;
ALTER TABLE attachments ADD CONSTRAINT attachments_single_parent CHECK (message_id IS NULL OR issue_id IS NULL);
CREATE INDEX attachments_issue ON attachments(issue_id) WHERE issue_id IS NOT NULL AND deleted_at IS NULL;
ALTER TABLE issue_events DROP CONSTRAINT IF EXISTS issue_events_kind_check;
ALTER TABLE issue_events ADD CONSTRAINT issue_events_kind_check CHECK (kind IN ('created','status','owner','due','title','comment','waiting','visibility','assignees','attachments','moved'));
DROP INDEX IF EXISTS attachments_pending;
CREATE INDEX attachments_pending ON attachments(created_at) WHERE message_id IS NULL AND issue_id IS NULL AND deleted_at IS NULL;
