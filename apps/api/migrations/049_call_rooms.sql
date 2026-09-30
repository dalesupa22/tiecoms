-- Salas de reunión abiertas, tipo «Crear una reunión para después» de Google Meet (docs/LLAMADAS.md › Salas).
-- Un enlace permanente (chaggu.com/sala/abc-defg-hij) que su dueño crea una vez y deja abierto: cualquiera con el
-- enlace entra con su nombre, sin cuenta, aunque el dueño no esté. Cada vez que alguien entra a una sala vacía se
-- abre una llamada nueva de Chime; cuando todos salen, se cierra. El enlace sigue sirviendo.
CREATE TABLE call_rooms (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code       text NOT NULL UNIQUE CHECK (code ~ '^[a-z]{3}-[a-z]{4}-[a-z]{3}$'),
  title      text NOT NULL DEFAULT '' CHECK (char_length(title) <= 120),
  -- manual: creada por su dueño; booking: la de una cita agendada (docs/CITAS.md).
  source     text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','booking')),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX call_rooms_owner ON call_rooms(owner_id) WHERE revoked_at IS NULL;

ALTER TABLE calls ADD COLUMN room_id uuid REFERENCES call_rooms(id) ON DELETE SET NULL;
-- Una sola llamada abierta por sala: si dos personas entran a la vez, comparten la misma.
CREATE UNIQUE INDEX calls_one_open_per_room ON calls(room_id) WHERE room_id IS NOT NULL AND ended_at IS NULL;

-- La cita agendada lleva su propia sala (la videollamada de chaggu).
ALTER TABLE bookings ADD COLUMN room_id uuid REFERENCES call_rooms(id) ON DELETE SET NULL;
