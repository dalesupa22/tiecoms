-- Invitación a unirse a una empresa (colegas). Distinta de la invitación a un espacio:
-- aquí la persona queda como miembro de la organización, no de un espacio.
CREATE TABLE org_invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   bytea NOT NULL UNIQUE,
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invited_by   uuid NOT NULL REFERENCES users(id),
  email        citext,
  role         text NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  expires_at   timestamptz NOT NULL,
  accepted_by  uuid REFERENCES users(id),
  accepted_at  timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX org_invitations_org ON org_invitations(org_id);
