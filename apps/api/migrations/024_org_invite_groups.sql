-- Invitar a un colega a mi empresa desde «Agregar al grupo»: la invitación a la empresa puede llevar
-- los grupos a los que entra (y su espacio), con el historial elegido, y servir como enlace o código
-- para varias personas, igual que las de un espacio (020). Todo opcional: las invitaciones viejas
-- quedan sin grupos y de un solo uso.
ALTER TABLE org_invitations
  ADD COLUMN workspace_id     uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  ADD COLUMN conversation_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN history          text NOT NULL DEFAULT 'now' CHECK (history IN ('now', 'all')),
  ADD COLUMN code_hash        bytea UNIQUE,
  ADD COLUMN multi_use        boolean NOT NULL DEFAULT false,
  ADD COLUMN uses             integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT org_invitations_multi_use_no_email CHECK (NOT multi_use OR email IS NULL);
