-- Las invitaciones se entregan por correo (Brevo): se guarda el idioma para los
-- reenvíos y el resultado del último envío para mostrarlo a quien invita.
ALTER TABLE invitations
  ADD COLUMN lang          text NOT NULL DEFAULT 'es' CHECK (lang IN ('es', 'en')),
  ADD COLUMN email_status  text CHECK (email_status IN ('sent', 'failed', 'skipped')),
  ADD COLUMN email_error   text,
  ADD COLUMN email_sent_at timestamptz,
  ADD COLUMN send_count    int NOT NULL DEFAULT 0;

ALTER TABLE org_invitations
  ADD COLUMN lang          text NOT NULL DEFAULT 'es' CHECK (lang IN ('es', 'en')),
  ADD COLUMN email_status  text CHECK (email_status IN ('sent', 'failed', 'skipped')),
  ADD COLUMN email_error   text,
  ADD COLUMN email_sent_at timestamptz,
  ADD COLUMN send_count    int NOT NULL DEFAULT 0;

-- Pendientes por correo (para no dejar varias invitaciones vivas a la misma persona).
CREATE INDEX invitations_pending_email ON invitations (workspace_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX org_invitations_pending_email ON org_invitations (org_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
