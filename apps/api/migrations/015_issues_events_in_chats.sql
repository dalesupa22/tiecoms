-- Asuntos y reuniones también en directos y chats grupales (multi, laterales): sin espacio.
-- El acceso depende de la membresía de la conversación (y del espacio, si lo hay).
ALTER TABLE issues ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE calendar_events ALTER COLUMN workspace_id DROP NOT NULL;

-- Aviso «empieza en 10 minutos»: una sola vez por horario (se reinicia si la reunión se mueve).
ALTER TABLE calendar_events ADD COLUMN soon_notified_at timestamptz;
CREATE INDEX calendar_events_upcoming ON calendar_events(starts_at) WHERE cancelled_at IS NULL AND soon_notified_at IS NULL;
