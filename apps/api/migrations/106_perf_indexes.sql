-- migrate:no-transaction
-- Índices para consultas que corren todo el tiempo. CONCURRENTLY para no bloquear escrituras en tablas grandes.
-- Si una creación se corta, el índice puede quedar INVALID: revisar con
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
-- y borrarlo (DROP INDEX CONCURRENTLY) antes de volver a correr esta migración a mano.

-- /bootstrap cuenta los enlaces de cada conversación desde history_from_seq (antes recorría todos sus enlaces).
CREATE INDEX CONCURRENTLY IF NOT EXISTS message_links_conv_seq ON message_links (conversation_id, seq);

-- wa.transcribe_scan (cada minuto): notas de voz listas sin transcribir. Antes recorría toda wa_messages.
CREATE INDEX CONCURRENTLY IF NOT EXISTS wa_messages_voice_pending ON wa_messages (sent_at DESC)
  WHERE kind = 'audio' AND media_state = 'ready' AND transcript IS NULL;

-- El tope diario de transcripciones por cuenta del mismo barrido.
CREATE INDEX CONCURRENTLY IF NOT EXISTS wa_messages_transcribed ON wa_messages (account_id, sent_at)
  WHERE transcript IS NOT NULL;

-- Limpieza horaria del worker: borra jobs terminados y outbox despachado viejos.
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_done_at ON jobs (done_at) WHERE done_at IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS outbox_dispatched_at ON outbox (dispatched_at) WHERE dispatched_at IS NOT NULL;
