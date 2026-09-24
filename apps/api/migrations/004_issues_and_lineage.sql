-- Asuntos y bifurcaciones (derivar / devolver) de conversaciones.

-- ---------- Bifurcaciones ----------
-- Una conversación puede derivarse de un mensaje de otra. La derivada guarda
-- su origen y, cuando devuelve el resultado, el mensaje que lo llevó de vuelta.
ALTER TABLE conversations
  ADD COLUMN parent_conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  ADD COLUMN parent_message_id      uuid REFERENCES messages(id) ON DELETE SET NULL,
  ADD COLUMN derive_kind            text CHECK (derive_kind IN ('same','internal','directive')),
  ADD COLUMN derive_reason          text,
  ADD COLUMN derived_by             uuid REFERENCES users(id),
  ADD COLUMN returned_at            timestamptz,
  ADD COLUMN returned_message_id    uuid REFERENCES messages(id) ON DELETE SET NULL,
  ADD CONSTRAINT conversations_derive_needs_parent CHECK (derive_kind IS NULL OR parent_conversation_id IS NOT NULL);
CREATE INDEX conversations_parent ON conversations(parent_conversation_id) WHERE parent_conversation_id IS NOT NULL;

-- El mensaje que trae de vuelta el resultado de una derivada.
ALTER TABLE messages ADD COLUMN merged_from_conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL;

-- ---------- Asuntos ----------
-- Un asunto vive en una conversación y hereda su audiencia: quien no puede leer
-- la conversación no ve el asunto (ni en listas, ni en contadores, ni en Hoy).
CREATE TABLE issues (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id   uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  origin_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  title             text NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','waiting','done','cancelled')),
  waiting_on_org_id uuid REFERENCES organizations(id),
  owner_id          uuid REFERENCES users(id),
  requested_by      uuid REFERENCES users(id),
  due_date          date,
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- Desde cuándo está en su estado actual: base para detectar cuellos de botella.
  status_since      timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz
);
CREATE INDEX issues_conversation ON issues(conversation_id);
CREATE INDEX issues_owner_open ON issues(owner_id) WHERE status NOT IN ('done','cancelled');
CREATE INDEX issues_workspace ON issues(workspace_id, status);

CREATE TABLE issue_events (
  id         bigserial PRIMARY KEY,
  issue_id   uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  actor_id   uuid NOT NULL REFERENCES users(id),
  kind       text NOT NULL CHECK (kind IN ('created','status','owner','due','title','comment','waiting')),
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX issue_events_issue ON issue_events(issue_id, id);

-- ---------- Alta de mensaje: ahora también registra el resultado devuelto ----------
DROP FUNCTION IF EXISTS tiecoms_append_message(uuid, uuid, text, text, text, uuid);
CREATE FUNCTION tiecoms_append_message(
  p_conv uuid, p_author uuid, p_client_id text, p_kind text, p_body text, p_reply uuid, p_merged uuid
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_seq bigint; v_eseq bigint; v_id uuid; v_at timestamptz; v_dto jsonb; v_event jsonb;
BEGIN
  UPDATE conversations
     SET last_message_seq = last_message_seq + 1, last_event_seq = last_event_seq + 1, last_message_at = now()
   WHERE id = p_conv
   RETURNING last_message_seq, last_event_seq INTO v_seq, v_eseq;
  IF v_seq IS NULL THEN RAISE EXCEPTION 'conversation % not found', p_conv USING ERRCODE = 'P0002'; END IF;

  INSERT INTO messages (conversation_id, seq, author_id, client_message_id, kind, body, body_sha256, reply_to, merged_from_conversation_id)
  VALUES (p_conv, v_seq, p_author, p_client_id, p_kind, p_body, sha256(convert_to(p_body, 'UTF8')), p_reply, p_merged)
  RETURNING id, created_at INTO v_id, v_at;

  v_dto := jsonb_build_object(
    'id', v_id, 'conversationId', p_conv, 'seq', v_seq, 'authorId', p_author, 'clientMessageId', p_client_id,
    'kind', p_kind, 'body', p_body, 'replyTo', p_reply, 'mergedFrom', p_merged,
    'createdAt', to_char(v_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'editedAt', NULL, 'deletedAt', NULL);
  v_event := jsonb_build_object('type', 'message.created', 'conversationId', p_conv, 'eventSeq', v_eseq, 'message', v_dto);

  INSERT INTO conversation_events (conversation_id, event_seq, type, message_id, payload)
  VALUES (p_conv, v_eseq, 'message.created', v_id, v_event);

  INSERT INTO read_cursors (conversation_id, user_id, last_read_seq) VALUES (p_conv, p_author, v_seq)
  ON CONFLICT (conversation_id, user_id)
  DO UPDATE SET last_read_seq = GREATEST(read_cursors.last_read_seq, EXCLUDED.last_read_seq), updated_at = now();

  INSERT INTO outbox (topic, payload) VALUES ('conv.event', v_event);
  PERFORM pg_notify('tiecoms_outbox', '');
  RETURN v_dto;
END $$;
