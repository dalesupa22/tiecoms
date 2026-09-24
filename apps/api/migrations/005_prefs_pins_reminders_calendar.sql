-- Fijados, silencios, recordatorios y calendario.

-- Preferencias personales por conversación y por espacio (solo las ve su dueño).
CREATE TABLE conversation_prefs (
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  pinned_at       timestamptz,
  muted_until     timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, conversation_id)
);
CREATE TABLE workspace_prefs (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  pinned_at    timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, workspace_id)
);

-- Mensajes fijados de una conversación (compartidos con sus miembros).
CREATE TABLE message_pins (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  pinned_by       uuid NOT NULL REFERENCES users(id),
  pinned_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, message_id)
);

-- Recordatorios personales sobre una conversación o un mensaje.
CREATE TABLE reminders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      uuid REFERENCES messages(id) ON DELETE SET NULL,
  note            text,
  remind_at       timestamptz NOT NULL,
  fired_at        timestamptz,
  done_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reminders_due ON reminders(remind_at) WHERE fired_at IS NULL AND done_at IS NULL;
CREATE INDEX reminders_user ON reminders(user_id) WHERE done_at IS NULL;

-- Calendario: cada reunión vive en una conversación (su audiencia son los
-- miembros de esa conversación) y tiene invitados explícitos con su respuesta.
CREATE TABLE calendar_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id   uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  origin_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  title             text NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  description       text,
  location          text,
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,
  timezone          text NOT NULL,
  organizer_id      uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  cancelled_at      timestamptz,
  CHECK (ends_at > starts_at)
);
CREATE INDEX calendar_events_range ON calendar_events(starts_at, ends_at);
CREATE INDEX calendar_events_conversation ON calendar_events(conversation_id);

CREATE TABLE calendar_event_invitees (
  event_id     uuid NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rsvp         text NOT NULL DEFAULT 'pending' CHECK (rsvp IN ('pending','yes','no','maybe')),
  responded_at timestamptz,
  PRIMARY KEY (event_id, user_id)
);

-- ---------- Reenvíos: mensajes traídos desde WhatsApp, Slack, correo u otra conversación ----------
-- forwarded = {source, author, sentAt, fromConversationId}. Es metadata declarada por quien reenvía.
ALTER TABLE messages ADD COLUMN forwarded jsonb;

DROP FUNCTION IF EXISTS tiecoms_append_message(uuid, uuid, text, text, text, uuid, uuid);
CREATE FUNCTION tiecoms_append_message(
  p_conv uuid, p_author uuid, p_client_id text, p_kind text, p_body text, p_reply uuid, p_merged uuid, p_forwarded jsonb
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_seq bigint; v_eseq bigint; v_id uuid; v_at timestamptz; v_dto jsonb; v_event jsonb;
BEGIN
  UPDATE conversations
     SET last_message_seq = last_message_seq + 1, last_event_seq = last_event_seq + 1, last_message_at = now()
   WHERE id = p_conv
   RETURNING last_message_seq, last_event_seq INTO v_seq, v_eseq;
  IF v_seq IS NULL THEN RAISE EXCEPTION 'conversation % not found', p_conv USING ERRCODE = 'P0002'; END IF;

  INSERT INTO messages (conversation_id, seq, author_id, client_message_id, kind, body, body_sha256, reply_to, merged_from_conversation_id, forwarded)
  VALUES (p_conv, v_seq, p_author, p_client_id, p_kind, p_body, sha256(convert_to(p_body, 'UTF8')), p_reply, p_merged, p_forwarded)
  RETURNING id, created_at INTO v_id, v_at;

  v_dto := jsonb_build_object(
    'id', v_id, 'conversationId', p_conv, 'seq', v_seq, 'authorId', p_author, 'clientMessageId', p_client_id,
    'kind', p_kind, 'body', p_body, 'replyTo', p_reply, 'mergedFrom', p_merged, 'forwarded', p_forwarded,
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
