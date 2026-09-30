-- «Nueva llamada» con enlace para invitados (docs/LLAMADAS.md › Nueva llamada, 30-sep-2026).
-- 1) El invitado por enlace entra con nombre y correo: el correo solo lo ven los de chaggu que están en la llamada.
ALTER TABLE call_guests ADD COLUMN IF NOT EXISTS email text;
-- 2) La conversación propia de una reunión rápida (POST /calls/instant). Sin mensajes de personas y sin llamada
--    en curso no sale en el bootstrap (no ensucia la bandeja); si alguien escribe en ella, aparece como un chat más.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_meeting boolean NOT NULL DEFAULT false;
