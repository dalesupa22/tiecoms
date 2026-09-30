-- Tanda 1.7 (docs/TANDA-1.7.md): #grupos, «es hoy», tarea hecha/vencida, comentarios de eventos agrupados,
-- búsqueda en el chat y mensajes de una sola vista.

-- 1. #grupos: [{conversationId, name, start, length}] con el nombre al enviar.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS refs jsonb;

-- 7. Una sola vista: body y attachments de la fila quedan vacíos/sin URL; el contenido real vive aparte y solo
-- sale por POST /messages/:id/open (una vez por persona). view_once_opened = [{userId, at}] para los DTO.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS view_once boolean NOT NULL DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS view_once_body text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS view_once_opened jsonb;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS view_once_purged_at timestamptz;
CREATE INDEX IF NOT EXISTS messages_view_once_pending ON messages (created_at) WHERE view_once AND view_once_purged_at IS NULL;
CREATE TABLE IF NOT EXISTS message_views (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opened_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);

-- 2. «Es hoy»: una sola vez por evento. Los que ya terminaron no avisan.
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS today_posted_at timestamptz;
UPDATE calendar_events SET today_posted_at = now() WHERE today_posted_at IS NULL AND ends_at < now();
CREATE INDEX IF NOT EXISTS calendar_events_today_pending ON calendar_events (starts_at) WHERE today_posted_at IS NULL AND cancelled_at IS NULL;

-- 4. «No cumplimos»: una vez por fecha límite. Lo que ya estaba vencido al desplegar no se anuncia de golpe.
ALTER TABLE issues ADD COLUMN IF NOT EXISTS overdue_posted_for date;
UPDATE issues SET overdue_posted_for = due_date
 WHERE due_date IS NOT NULL AND status NOT IN ('done', 'cancelled') AND due_date < (now() AT TIME ZONE 'America/Bogota')::date;
CREATE INDEX IF NOT EXISTS issues_overdue_pending ON issues (due_date) WHERE due_date IS NOT NULL AND status NOT IN ('done', 'cancelled');

-- 5. Comentarios de eventos.
CREATE TABLE IF NOT EXISTS calendar_event_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calendar_event_comments_event ON calendar_event_comments (event_id, created_at);

-- 6. Búsqueda sin mayúsculas ni tildes, sin depender de la extensión unaccent (1 a 1: conserva las posiciones).
CREATE OR REPLACE FUNCTION tiecoms_fold(t text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT lower(translate(COALESCE(t, ''),
    'ÁÀÂÄÃÅáàâäãåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÖÕóòôöõÚÙÛÜúùûüÑñÇç',
    'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuNnCc'))
$$;
-- Índice trigram si pg_trgm está (o se puede crear); si no, la búsqueda usa LIKE sobre tiecoms_fold(body).
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_trgm no disponible: la búsqueda del chat va sin índice trigram';
  END;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS messages_body_fold_trgm ON messages USING gin (tiecoms_fold(body) gin_trgm_ops) WHERE kind = ''text'' AND deleted_at IS NULL';
  END IF;
END $$;

-- El envío lleva refs y la marca de una sola vista en la misma fila y en el evento.
DROP FUNCTION tiecoms_append_message(uuid, uuid, text, text, text, uuid, uuid, jsonb, jsonb, bytea, jsonb, uuid);
CREATE FUNCTION tiecoms_append_message(
  p_conv uuid, p_author uuid, p_client_id text, p_kind text, p_body text, p_reply uuid, p_merged uuid, p_forwarded jsonb,
  p_attachments jsonb DEFAULT NULL, p_hash bytea DEFAULT NULL, p_mentions jsonb DEFAULT NULL, p_topic uuid DEFAULT NULL,
  p_refs jsonb DEFAULT NULL, p_view_once_body text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_seq bigint; v_eseq bigint; v_id uuid; v_at timestamptz; v_dto jsonb; v_event jsonb; v_once boolean := p_view_once_body IS NOT NULL;
BEGIN
  UPDATE conversations
     SET last_message_seq = last_message_seq + 1, last_event_seq = last_event_seq + 1, last_message_at = now()
   WHERE id = p_conv
   RETURNING last_message_seq, last_event_seq INTO v_seq, v_eseq;
  IF v_seq IS NULL THEN RAISE EXCEPTION 'conversation % not found', p_conv USING ERRCODE = 'P0002'; END IF;

  INSERT INTO messages (conversation_id, seq, author_id, client_message_id, kind, body, body_sha256, reply_to, merged_from_conversation_id, forwarded, attachments, mentions, topic_id, topic_by, refs, view_once, view_once_body)
  VALUES (p_conv, v_seq, p_author, p_client_id, p_kind, p_body, COALESCE(p_hash, sha256(convert_to(p_body, 'UTF8'))), p_reply, p_merged, p_forwarded, p_attachments, p_mentions, p_topic, CASE WHEN p_topic IS NULL THEN NULL ELSE p_author END, p_refs, v_once, p_view_once_body)
  RETURNING id, created_at INTO v_id, v_at;

  v_dto := jsonb_build_object(
    'id', v_id, 'conversationId', p_conv, 'seq', v_seq, 'authorId', p_author, 'clientMessageId', p_client_id,
    'kind', p_kind, 'body', p_body, 'replyTo', p_reply, 'mergedFrom', p_merged, 'forwarded', p_forwarded,
    'attachments', COALESCE(p_attachments, '[]'::jsonb), 'mentions', COALESCE(p_mentions, '[]'::jsonb),
    'topicId', p_topic, 'topicBy', CASE WHEN p_topic IS NULL THEN NULL ELSE p_author END,
    'createdAt', to_char(v_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'editedAt', NULL, 'deletedAt', NULL);
  IF p_refs IS NOT NULL THEN v_dto := v_dto || jsonb_build_object('refs', p_refs); END IF;
  IF v_once THEN v_dto := v_dto || jsonb_build_object('viewOnce', true, 'viewOnceState', 'unopened', 'openedBy', '[]'::jsonb); END IF;
  v_event := jsonb_build_object('type', 'message.created', 'conversationId', p_conv, 'eventSeq', v_eseq, 'message', v_dto);

  INSERT INTO conversation_events (conversation_id, event_seq, type, message_id, payload)
  VALUES (p_conv, v_eseq, 'message.created', v_id, v_event);

  INSERT INTO read_cursors (conversation_id, user_id, last_read_seq)
  SELECT p_conv, p_author, v_seq
    FROM conversation_memberships cm
    LEFT JOIN read_cursors rc ON rc.conversation_id = cm.conversation_id AND rc.user_id = cm.user_id
   WHERE cm.conversation_id = p_conv AND cm.user_id = p_author AND cm.removed_at IS NULL
     AND GREATEST(COALESCE(rc.last_read_seq, 0), cm.history_from_seq) >= v_seq - 1
  ON CONFLICT (conversation_id, user_id)
  DO UPDATE SET last_read_seq = GREATEST(read_cursors.last_read_seq, EXCLUDED.last_read_seq), updated_at = now()
    WHERE GREATEST(read_cursors.last_read_seq, COALESCE((
      SELECT cm.history_from_seq FROM conversation_memberships cm
       WHERE cm.conversation_id = p_conv AND cm.user_id = p_author AND cm.removed_at IS NULL
    ), 0)) >= EXCLUDED.last_read_seq - 1;

  INSERT INTO outbox (topic, payload) VALUES ('conv.event', v_event);
  PERFORM pg_notify('tiecoms_outbox', '');
  RETURN v_dto;
END $$;
