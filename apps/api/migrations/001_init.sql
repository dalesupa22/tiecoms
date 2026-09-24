-- TieComs · esquema inicial
-- Reglas: UUID para identidad, secuencias por conversación para orden,
-- timestamps UTC, autorización por memberships (nunca solo por company_id).

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------- Identidad ----------
CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  mark        text NOT NULL,
  color_bg    text NOT NULL,
  color_fg    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL DEFAULT 'human' CHECK (kind IN ('human','agent')),
  email         citext UNIQUE,
  name          text NOT NULL,
  password_hash text,
  primary_org_id uuid REFERENCES organizations(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  disabled_at   timestamptz,
  CHECK (kind = 'agent' OR email IS NOT NULL)
);

CREATE TABLE organization_memberships (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  title      text,
  area       text,
  joined_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX organization_memberships_user ON organization_memberships(user_id);

-- Una sesión = un dispositivo o navegador. Revocable de forma individual.
CREATE TABLE sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id      text NOT NULL,
  device_name    text NOT NULL,
  platform       text NOT NULL,
  contract       text NOT NULL,
  refresh_hash   bytea NOT NULL,
  prev_refresh_hash bytea,
  rotated_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz
);
CREATE UNIQUE INDEX sessions_refresh ON sessions(refresh_hash);
CREATE INDEX sessions_user_active ON sessions(user_id) WHERE revoked_at IS NULL;

CREATE TABLE push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  provider    text NOT NULL CHECK (provider IN ('webpush','fcm','apns')),
  token       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, token)
);

-- ---------- Trabajo compartido entre empresas ----------
CREATE TABLE workspaces (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owning_org_id uuid NOT NULL REFERENCES organizations(id),
  name          text NOT NULL,
  department    text,
  glyph         text,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz
);

CREATE TABLE workspace_organizations (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  org_id       uuid NOT NULL REFERENCES organizations(id),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  left_at      timestamptz,
  PRIMARY KEY (workspace_id, org_id)
);
CREATE INDEX workspace_organizations_org ON workspace_organizations(org_id);

-- org_id: con qué empresa participa la persona en este espacio.
-- guest: tercero sin membresía implícita en grupos; expires_at se revisa en cada acceso.
CREATE TABLE workspace_memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id       uuid REFERENCES organizations(id),
  role         text NOT NULL CHECK (role IN ('lead','admin','member','guest')),
  sponsor_id   uuid REFERENCES users(id),
  expires_at   timestamptz,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_memberships_user ON workspace_memberships(user_id) WHERE revoked_at IS NULL;

-- ---------- Conversaciones ----------
CREATE TABLE conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('group','internal','direct')),
  level            text CHECK (level IN ('directivo','operativo')),
  name             text,
  internal_org_id  uuid REFERENCES organizations(id),
  dm_key           text UNIQUE,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  archived_at      timestamptz,
  -- Contadores bajo bloqueo de fila en la misma transacción que el mensaje.
  last_message_seq bigint NOT NULL DEFAULT 0,
  last_event_seq   bigint NOT NULL DEFAULT 0,
  last_message_at  timestamptz,
  CHECK ((kind = 'direct') = (dm_key IS NOT NULL)),
  CHECK (kind <> 'internal' OR internal_org_id IS NOT NULL),
  CHECK (kind = 'direct' OR workspace_id IS NOT NULL)
);
CREATE INDEX conversations_workspace ON conversations(workspace_id);

CREATE TABLE conversation_memberships (
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  can_post         boolean NOT NULL DEFAULT true,
  can_manage       boolean NOT NULL DEFAULT false,
  -- Solo ve mensajes con seq > history_from_seq. Reingresar no restaura historial.
  history_from_seq bigint NOT NULL DEFAULT 0,
  added_by         uuid REFERENCES users(id),
  joined_at        timestamptz NOT NULL DEFAULT now(),
  removed_at       timestamptz,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_memberships_user ON conversation_memberships(user_id) WHERE removed_at IS NULL;

CREATE TABLE messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq               bigint NOT NULL,
  author_id         uuid NOT NULL REFERENCES users(id),
  client_message_id text,
  kind              text NOT NULL DEFAULT 'text' CHECK (kind IN ('text','system')),
  body              text NOT NULL,
  body_sha256       bytea,
  reply_to          uuid REFERENCES messages(id),
  source_channel    text NOT NULL DEFAULT 'tiecoms',
  external_id       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  edited_at         timestamptz,
  deleted_at        timestamptz,
  UNIQUE (conversation_id, seq),
  UNIQUE (conversation_id, author_id, client_message_id)
);

-- Registro durable de cambios por conversación (creación, edición, borrado, miembros).
CREATE TABLE conversation_events (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  event_seq       bigint NOT NULL,
  type            text NOT NULL,
  message_id      uuid REFERENCES messages(id) ON DELETE CASCADE,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, event_seq)
);

CREATE TABLE read_cursors (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_seq   bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

-- ---------- Invitaciones ----------
CREATE TABLE invitations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash       bytea NOT NULL UNIQUE,
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  invited_by       uuid NOT NULL REFERENCES users(id),
  email            citext,
  role             text NOT NULL CHECK (role IN ('admin','member','guest')),
  conversation_ids uuid[] NOT NULL DEFAULT '{}',
  history          text NOT NULL DEFAULT 'now' CHECK (history IN ('now','all')),
  access_until     timestamptz,
  expires_at       timestamptz NOT NULL,
  accepted_by      uuid REFERENCES users(id),
  accepted_at      timestamptz,
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_workspace ON invitations(workspace_id);

-- ---------- Soporte: outbox, jobs, auditoría ----------
-- Se escribe en la misma transacción que el cambio; un despachador lo publica.
CREATE TABLE outbox (
  id            bigserial PRIMARY KEY,
  topic         text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  attempts      int NOT NULL DEFAULT 0,
  dispatched_at timestamptz
);
CREATE INDEX outbox_pending ON outbox(id) WHERE dispatched_at IS NULL;

CREATE TABLE jobs (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key   text UNIQUE,
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 8,
  locked_until timestamptz,
  locked_by    text,
  last_error   text,
  done_at      timestamptz,
  failed_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready ON jobs(run_at) WHERE done_at IS NULL AND failed_at IS NULL;

CREATE TABLE audit_events (
  id           bigserial PRIMARY KEY,
  actor_id     uuid REFERENCES users(id),
  action       text NOT NULL,
  target_type  text,
  target_id    uuid,
  workspace_id uuid,
  meta         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_workspace ON audit_events(workspace_id, created_at);

-- Tabla que usa @socket.io/postgres-adapter para paquetes grandes entre nodos.
CREATE TABLE socket_io_attachments (
  id          bigserial UNIQUE,
  created_at  timestamptz DEFAULT now(),
  payload     bytea
);
