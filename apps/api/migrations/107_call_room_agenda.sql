-- Reuniones improvisadas (salas) en la agenda de quien las crea (pedido de Lorena, 7-oct-2026): cada llamada de
-- sala guarda su evento de agenda; volver a entrar a la misma llamada no crea otro.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS calendar_event_id uuid REFERENCES calendar_events(id) ON DELETE SET NULL;
