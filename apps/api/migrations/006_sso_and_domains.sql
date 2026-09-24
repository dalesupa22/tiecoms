-- TieComs · inicio de sesión con Google / Microsoft y verificación de empresas por dominio.

-- Identidades externas. El sujeto es estable: Google `sub`; Microsoft `tid:oid` (nunca el correo).
CREATE TABLE user_identities (
  provider     text NOT NULL CHECK (provider IN ('google','microsoft')),
  subject      text NOT NULL,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id    text,            -- Microsoft tid / Google Workspace hd
  email        citext,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX user_identities_user ON user_identities(user_id);

-- Vuelo OIDC en curso (state). Un solo uso, 10 minutos.
CREATE TABLE sso_flows (
  state_hash       bytea PRIMARY KEY,
  provider         text NOT NULL,
  nonce            text NOT NULL,
  idp_verifier     text NOT NULL,   -- PKCE hacia Google/Microsoft
  client_challenge text NOT NULL,   -- PKCE del cliente (web, app nativa, escritorio)
  platform         text NOT NULL,
  org_invite_token text,
  org_name         text,
  next_path        text,
  expires_at       timestamptz NOT NULL
);

-- Código de un solo uso que el cliente canjea por la sesión (60 s).
CREATE TABLE sso_codes (
  code_hash        bytea PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         text NOT NULL,
  client_challenge text NOT NULL,
  platform         text NOT NULL,
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz
);

-- Dominios de las empresas.
--   pending: reclamado, falta el TXT;   idp: confirmado por Google Workspace / Microsoft Entra;
--   dns: verificado con el registro TXT (el nivel más alto; exclusivo).
CREATE TABLE org_domains (
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain       citext NOT NULL CHECK (domain ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$'),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','idp','dns')),
  token        text NOT NULL,
  idp_provider text,
  idp_tenant   text,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  verified_at  timestamptz,
  last_checked_at timestamptz,
  PRIMARY KEY (org_id, domain)
);
-- Un dominio verificado (idp o dns) pertenece a una sola empresa.
CREATE UNIQUE INDEX org_domains_claimed ON org_domains(domain) WHERE status IN ('idp','dns');

ALTER TABLE organizations
  ADD COLUMN join_policy text NOT NULL DEFAULT 'invite' CHECK (join_policy IN ('invite','auto')),
  ADD COLUMN require_sso boolean NOT NULL DEFAULT false,
  ADD COLUMN ms_tenant_id text,
  ADD COLUMN google_hd citext;

ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
