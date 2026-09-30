-- Registro por empresa con correo corporativo (docs/REGISTRO.md, 30-sep-2026).
-- Con contraseña y un dominio corporativo, la cuenta nace al confirmar el correo con un enlace:
--   · si la empresa del dominio ya existe, la persona se suma;
--   · si no, la crea y reclama el dominio con estado 'email' (alguien probó que tiene un buzón ahí).
-- Así nadie se queda con un dominio ajeno escribiendo un correo que no es suyo, y la empresa no se parte en dos.

ALTER TABLE org_domains DROP CONSTRAINT IF EXISTS org_domains_status_check;
ALTER TABLE org_domains ADD CONSTRAINT org_domains_status_check CHECK (status IN ('pending','email','idp','dns'));
DROP INDEX IF EXISTS org_domains_claimed;
CREATE UNIQUE INDEX org_domains_claimed ON org_domains(domain) WHERE status IN ('email','idp','dns');

-- Quien llega después con el mismo dominio se suma solo (confirmando su correo o entrando con Google/Microsoft).
ALTER TABLE organizations ALTER COLUMN join_policy SET DEFAULT 'auto';
UPDATE organizations SET join_policy = 'auto' WHERE join_policy = 'invite';

CREATE TABLE IF NOT EXISTS signup_confirmations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  title         text,
  org_name      text,
  lang          text,
  token_hash    bytea NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz
);
CREATE INDEX IF NOT EXISTS signup_confirmations_email ON signup_confirmations (email, created_at DESC);
