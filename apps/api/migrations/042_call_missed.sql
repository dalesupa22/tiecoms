-- Llamadas perdidas (docs/LLAMADAS.md › Llamadas perdidas, 29-sep-2026): a quién le sonó cada llamada (o le habría
-- sonado, si tenía No molestar), si la rechazó, y hasta cuándo vio la pestaña Llamadas (el número rojo).
-- Perdida = la llamada terminó, me sonó, no la rechacé y no entré desde ningún dispositivo.
CREATE TABLE IF NOT EXISTS call_ringees (
  call_id     uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rung_at     timestamptz NOT NULL DEFAULT now(),
  declined_at timestamptz,
  PRIMARY KEY (call_id, user_id)
);
CREATE INDEX IF NOT EXISTS call_ringees_user ON call_ringees (user_id, rung_at DESC);
ALTER TABLE users ADD COLUMN IF NOT EXISTS calls_seen_at timestamptz;
