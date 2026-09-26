-- Notas de voz: un adjunto de tipo 'voice' con duración, onda, transcripción y variante reproducible (AAC).
ALTER TABLE attachments
  ADD COLUMN kind        text NOT NULL DEFAULT 'file' CHECK (kind IN ('file', 'voice')),
  ADD COLUMN duration_ms int CHECK (duration_ms IS NULL OR duration_ms >= 0),
  ADD COLUMN waveform    jsonb,
  -- {status: pending|done|failed|disabled, text?, language?, summary?, suggestedIssue?, error?}
  ADD COLUMN transcript  jsonb,
  -- Copia en audio/mp4 (AAC) cuando el original no se reproduce en todos lados (webm/ogg).
  ADD COLUMN play_key    text,
  ADD COLUMN play_type   text;
