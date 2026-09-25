-- Qué tipo de conversación devolvió el resultado (p. ej. 'side' → «Desde un sidechat»), visible para todo el origen.
ALTER TABLE messages ADD COLUMN merged_kind text;
