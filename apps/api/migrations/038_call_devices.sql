-- Llamadas desde varios dispositivos (docs/LLAMADAS.md › Varios dispositivos, 1.7.1): un attendee de Chime por
-- dispositivo (ExternalUserId "{userId}#{deviceKey}") y el latido por dispositivo. Las filas de antes (y los
-- clientes 1.7.0, que no mandan deviceKey) quedan con device_key 'legacy'.
ALTER TABLE call_participants ADD COLUMN IF NOT EXISTS device_key text NOT NULL DEFAULT 'legacy';
ALTER TABLE call_participants ADD COLUMN IF NOT EXISTS platform text;
ALTER TABLE call_participants ADD COLUMN IF NOT EXISTS label text;
ALTER TABLE call_participants DROP CONSTRAINT IF EXISTS call_participants_pkey;
ALTER TABLE call_participants ADD PRIMARY KEY (call_id, user_id, device_key);
CREATE INDEX IF NOT EXISTS call_participants_active_user ON call_participants (user_id) WHERE left_at IS NULL;

-- «＋ Agregar» a una llamada en curso: a quién se llamó y cuándo (miembros del chat o de fuera), para mostrar
-- «Llamando…», «No contestó» y «Volver a llamar» (CallDTO.invited).
CREATE TABLE IF NOT EXISTS call_rings (
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rung_by uuid NOT NULL REFERENCES users(id),
  rung_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (call_id, user_id)
);
