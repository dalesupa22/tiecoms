-- Adjuntos en mensajes (fotos, videos y archivos).
-- Se suben primero (pendientes, message_id NULL) y un mensaje los toma al enviarse.
-- Reenviar crea filas nuevas que apuntan al mismo objeto S3 (no se copia el archivo).
CREATE TABLE attachments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  owner_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id      uuid REFERENCES messages(id) ON DELETE CASCADE,
  position        int NOT NULL DEFAULT 0,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  content_type    text NOT NULL,
  size_bytes      bigint NOT NULL CHECK (size_bytes > 0),
  width           int,
  height          int,
  s3_key          text NOT NULL,
  thumb_key       text,
  thumb_type      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX attachments_message ON attachments(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX attachments_pending ON attachments(created_at) WHERE message_id IS NULL AND deleted_at IS NULL;
CREATE INDEX attachments_s3_key ON attachments(s3_key);

-- Copia de los AttachmentDTO del mensaje (orden de envío): así los mensajes y sus eventos llevan los adjuntos.
ALTER TABLE messages ADD COLUMN attachments jsonb;

-- Alta de mensaje con adjuntos y hash de idempotencia calculado por el llamador (incluye los ids de adjuntos).
DROP FUNCTION IF EXISTS tiecoms_append_message(uuid, uuid, text, text, text, uuid, uuid, jsonb);
CREATE FUNCTION tiecoms_append_message(
  p_conv uuid, p_author uuid, p_client_id text, p_kind text, p_body text, p_reply uuid, p_merged uuid, p_forwarded jsonb,
  p_attachments jsonb DEFAULT NULL, p_hash bytea DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_seq bigint; v_eseq bigint; v_id uuid; v_at timestamptz; v_dto jsonb; v_event jsonb;
BEGIN
  UPDATE conversations
     SET last_message_seq = last_message_seq + 1, last_event_seq = last_event_seq + 1, last_message_at = now()
   WHERE id = p_conv
   RETURNING last_message_seq, last_event_seq INTO v_seq, v_eseq;
  IF v_seq IS NULL THEN RAISE EXCEPTION 'conversation % not found', p_conv USING ERRCODE = 'P0002'; END IF;

  INSERT INTO messages (conversation_id, seq, author_id, client_message_id, kind, body, body_sha256, reply_to, merged_from_conversation_id, forwarded, attachments)
  VALUES (p_conv, v_seq, p_author, p_client_id, p_kind, p_body, COALESCE(p_hash, sha256(convert_to(p_body, 'UTF8'))), p_reply, p_merged, p_forwarded, p_attachments)
  RETURNING id, created_at INTO v_id, v_at;

  v_dto := jsonb_build_object(
    'id', v_id, 'conversationId', p_conv, 'seq', v_seq, 'authorId', p_author, 'clientMessageId', p_client_id,
    'kind', p_kind, 'body', p_body, 'replyTo', p_reply, 'mergedFrom', p_merged, 'forwarded', p_forwarded,
    'attachments', COALESCE(p_attachments, '[]'::jsonb),
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
