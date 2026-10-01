-- Conversation files use the conversation's actual active members, including DMs.
ALTER TABLE folders ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE folders DROP CONSTRAINT IF EXISTS folders_check;
ALTER TABLE folders ADD CONSTRAINT folders_single_scope CHECK (num_nonnulls(workspace_id, owner_id, conversation_id) = 1);
CREATE INDEX folders_conversation ON folders(conversation_id) WHERE deleted_at IS NULL;

ALTER TABLE files ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE;
-- Preserve existing workspace sharing; personal documents remain owner-only in the API.
ALTER TABLE files ADD COLUMN visibility text NOT NULL DEFAULT 'shared' CHECK (visibility IN ('private','shared'));
ALTER TABLE files ADD CONSTRAINT document_single_audience CHECK (purpose <> 'document' OR num_nonnulls(workspace_id, conversation_id) <= 1);
CREATE INDEX files_conversation_docs ON files(conversation_id) WHERE purpose = 'document' AND deleted_at IS NULL;
