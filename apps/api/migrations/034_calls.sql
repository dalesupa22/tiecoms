-- Llamadas de voz y video dentro de una conversación, con Amazon Chime SDK (docs/LLAMADAS.md).
-- Una conversación tiene a lo sumo una llamada activa. La reunión de Chime vive mientras haya alguien
-- (Chime la cierra sola a los 5 minutos sin nadie); aquí queda el registro y quién entró.
CREATE TABLE calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  started_by uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('audio', 'video')),
  provider text NOT NULL DEFAULT 'chime',
  external_id text,
  media_region text,
  -- Respuesta de CreateMeeting (MediaPlacement, etc.): la necesitan los clientes para entrar.
  meeting jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  -- Transcripción en vivo (Amazon Transcribe vía Chime): se prende y apaga durante la llamada.
  transcribing boolean NOT NULL DEFAULT false,
  -- Las últimas frases llegan unos segundos después de apagar: se aceptan hasta 30 s.
  transcription_stopped_at timestamptz,
  -- Quien prendió la transcripción autorizó el resumen con DeepSeek.
  ai_summary boolean NOT NULL DEFAULT false,
  transcript_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  -- Resumen con DeepSeek de la transcripción, al terminar (si hay llave y transcripción).
  summary text
);
CREATE UNIQUE INDEX calls_one_active ON calls (conversation_id) WHERE ended_at IS NULL;
CREATE INDEX calls_conversation ON calls (conversation_id, started_at DESC);

CREATE TABLE call_participants (
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  attendee_id text,
  first_joined_at timestamptz NOT NULL DEFAULT now(),
  joined_at timestamptz NOT NULL DEFAULT now(),
  -- Latido del cliente cada 30 s: quien deja de latir sale solo (cierre de pestaña, app muerta).
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  PRIMARY KEY (call_id, user_id)
);

-- Frases finales de la transcripción. Las mandan los clientes que están en la llamada (todos reciben las
-- mismas del SDK): result_id de Transcribe las deduplica.
CREATE TABLE call_transcript_segments (
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  result_id text NOT NULL,
  speaker_user_id uuid REFERENCES users(id),
  speaker_name text,
  language text,
  body text NOT NULL,
  start_ms bigint NOT NULL,
  end_ms bigint NOT NULL,
  reported_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (call_id, result_id)
);
CREATE INDEX call_transcript_order ON call_transcript_segments (call_id, start_ms);
