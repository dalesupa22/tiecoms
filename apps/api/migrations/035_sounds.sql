-- Sonidos (docs/SONIDOS.md): el de cada chat, el predeterminado de la persona y su tono de llamada.
-- NULL = el predeterminado; 'none' = sin sonido. Los nombres viven en @tiecoms/contracts (MESSAGE_SOUNDS, RINGTONES).
ALTER TABLE conversation_prefs ADD COLUMN IF NOT EXISTS sound text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS message_sound text, ADD COLUMN IF NOT EXISTS ringtone text;
