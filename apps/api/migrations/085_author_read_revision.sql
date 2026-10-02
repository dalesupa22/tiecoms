-- Additive replacement: preserves 083/084 and the public message DTO.
CREATE OR REPLACE FUNCTION tiecoms_append_message(
  p_conv uuid, p_author uuid, p_client_id text, p_kind text, p_body text, p_reply uuid, p_merged uuid, p_forwarded jsonb,
  p_attachments jsonb DEFAULT NULL, p_hash bytea DEFAULT NULL, p_mentions jsonb DEFAULT NULL, p_topic uuid DEFAULT NULL,
  p_refs jsonb DEFAULT NULL, p_view_once_body text DEFAULT NULL, p_display_body text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_seq bigint; v_read_revision bigint; v_eseq bigint; v_id uuid; v_at timestamptz; v_dto jsonb; v_event jsonb; v_once boolean := p_view_once_body IS NOT NULL;
BEGIN
  UPDATE conversations
     SET last_message_seq = last_message_seq + 1, last_event_seq = last_event_seq + 1, last_message_at = now()
   WHERE id = p_conv
   RETURNING last_message_seq, last_event_seq INTO v_seq, v_eseq;
  IF v_seq IS NULL THEN RAISE EXCEPTION 'conversation % not found', p_conv USING ERRCODE = 'P0002'; END IF;

  INSERT INTO messages (conversation_id, seq, author_id, client_message_id, kind, body, body_sha256, reply_to, merged_from_conversation_id, forwarded, attachments, mentions, topic_id, topic_by, refs, view_once, view_once_body, display_body)
  VALUES (p_conv, v_seq, p_author, p_client_id, p_kind, p_body, COALESCE(p_hash, sha256(convert_to(p_body, 'UTF8'))), p_reply, p_merged, p_forwarded, p_attachments, p_mentions, p_topic, CASE WHEN p_topic IS NULL THEN NULL ELSE p_author END, p_refs, v_once, p_view_once_body, p_display_body)
  RETURNING id, created_at INTO v_id, v_at;

  v_dto := jsonb_build_object(
    'id', v_id, 'conversationId', p_conv, 'seq', v_seq, 'authorId', p_author, 'clientMessageId', p_client_id,
    'kind', p_kind, 'body', p_body, 'replyTo', p_reply, 'mergedFrom', p_merged, 'forwarded', p_forwarded,
    'attachments', COALESCE(p_attachments, '[]'::jsonb), 'mentions', COALESCE(p_mentions, '[]'::jsonb),
    'topicId', p_topic, 'topicBy', CASE WHEN p_topic IS NULL THEN NULL ELSE p_author END,
    'createdAt', to_char(v_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'editedAt', NULL, 'deletedAt', NULL);
  IF NOT v_once AND p_display_body IS NOT NULL THEN v_dto := v_dto || jsonb_build_object('displayBody',p_display_body); END IF;
  IF p_refs IS NOT NULL THEN v_dto := v_dto || jsonb_build_object('refs', p_refs); END IF;
  IF v_once THEN v_dto := v_dto || jsonb_build_object('viewOnce', true, 'viewOnceState', 'unopened', 'openedBy', '[]'::jsonb); END IF;
  v_event := jsonb_build_object('type', 'message.created', 'conversationId', p_conv, 'eventSeq', v_eseq, 'message', v_dto);

  INSERT INTO conversation_events (conversation_id, event_seq, type, message_id, payload)
  VALUES (p_conv, v_eseq, 'message.created', v_id, v_event);

  INSERT INTO read_cursors (conversation_id, user_id, last_read_seq, revision)
  SELECT p_conv, p_author, v_seq, 1
    FROM conversation_memberships cm
    LEFT JOIN read_cursors rc ON rc.conversation_id = cm.conversation_id AND rc.user_id = cm.user_id
   WHERE cm.conversation_id = p_conv AND cm.user_id = p_author AND cm.removed_at IS NULL
     AND GREATEST(COALESCE(rc.last_read_seq, 0), cm.history_from_seq) >= v_seq - 1
  ON CONFLICT (conversation_id, user_id)
  DO UPDATE SET last_read_seq = GREATEST(read_cursors.last_read_seq, EXCLUDED.last_read_seq), revision = read_cursors.revision + 1, updated_at = now()
    WHERE GREATEST(read_cursors.last_read_seq, COALESCE((
      SELECT cm.history_from_seq FROM conversation_memberships cm
       WHERE cm.conversation_id = p_conv AND cm.user_id = p_author AND cm.removed_at IS NULL
    ), 0)) >= EXCLUDED.last_read_seq - 1
  RETURNING revision INTO v_read_revision;

  -- The author's automatic read is a real cursor mutation: version it before
  -- delivering the message so late HTTP read ACKs cannot undo the new cursor.
  IF v_read_revision IS NOT NULL THEN
    INSERT INTO outbox (topic, payload) VALUES ('account.event', jsonb_build_object(
      'userIds', jsonb_build_array(p_author),
      'event', jsonb_build_object('type', 'read.updated', 'conversationId', p_conv,
        'seq', v_seq, 'readRevision', v_read_revision)));
  END IF;

  INSERT INTO outbox (topic, payload) VALUES ('conv.event', v_event);
  PERFORM pg_notify('tiecoms_outbox', '');
  RETURN v_dto;
END $$;
