-- Firmar PDFs desde el chat. Cada persona guarda sus firmas (PNG transparente, privado) y al firmar
-- el servidor estampa las firmas en el PDF, sube el resultado como adjunto nuevo y responde en el hilo.
-- pdf_signings es la constancia: huellas SHA-256 del original y del firmado, quién, cuándo y desde dónde.
-- Nada se borra de verdad: las firmas se retiran con deleted_at y la constancia no se toca.
CREATE TABLE user_signatures (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'signature' CHECK (kind IN ('signature', 'initials')),
  source      text NOT NULL CHECK (source IN ('drawn', 'typed', 'uploaded')),
  s3_key      text NOT NULL,
  width       integer NOT NULL CHECK (width > 0),
  height      integer NOT NULL CHECK (height > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX user_signatures_user ON user_signatures (user_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE pdf_signings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id       uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_attachment_id  uuid NOT NULL REFERENCES attachments(id),
  result_attachment_id  uuid NOT NULL REFERENCES attachments(id),
  message_id            uuid REFERENCES messages(id),
  original_sha256       bytea NOT NULL,
  signed_sha256         bytea NOT NULL,
  placements            jsonb NOT NULL,
  pages                 integer NOT NULL,
  ip                    text,
  user_agent            text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pdf_signings_source ON pdf_signings (source_attachment_id);
CREATE INDEX pdf_signings_result ON pdf_signings (result_attachment_id);

-- El adjunto firmado lleva su constancia resumida (AttachmentSigningDTO); los reenvíos la copian.
ALTER TABLE attachments ADD COLUMN signing jsonb;
