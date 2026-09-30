-- Invitados por enlace a una llamada (docs/LLAMADAS.md › Invitados por enlace, 30-sep-2026).
-- Quien está en la llamada genera un enlace; cualquiera con él entra con su nombre, sin cuenta.
-- El enlace sirve solo mientras la llamada siga abierta. Del token y del secreto del invitado se guarda el hash.
CREATE TABLE IF NOT EXISTS call_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id     uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  token_hash  bytea NOT NULL UNIQUE,
  created_by  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE INDEX IF NOT EXISTS call_links_call ON call_links (call_id);

CREATE TABLE IF NOT EXISTS call_guests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id      uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  link_id      uuid NOT NULL REFERENCES call_links(id) ON DELETE CASCADE,
  name         text NOT NULL,
  secret_hash  bytea NOT NULL,
  attendee_id  text,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  left_at      timestamptz
);
CREATE INDEX IF NOT EXISTS call_guests_active ON call_guests (call_id) WHERE left_at IS NULL;
