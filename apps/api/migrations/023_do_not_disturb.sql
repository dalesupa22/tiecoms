-- «No molestar» general: mientras dnd_until > now() no sale ningún push para esa persona
-- (mensajes, menciones, reacciones, reuniones ni recordatorios). NULL = apagado.
ALTER TABLE users ADD COLUMN IF NOT EXISTS dnd_until timestamptz;
