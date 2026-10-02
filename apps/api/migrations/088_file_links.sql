-- Enlace para ver un archivo de chaggu sin cuenta (2-oct-2026): se usa al llevar un adjunto a un chat de WhatsApp,
-- que desde chaggu solo acepta texto. Se guarda el hash del token (como call_links), caduca y se puede revocar.
CREATE TABLE file_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    bytea NOT NULL UNIQUE,
  attachment_id uuid NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  created_by    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  opened_count  int NOT NULL DEFAULT 0
);
CREATE INDEX file_links_attachment ON file_links(attachment_id);
