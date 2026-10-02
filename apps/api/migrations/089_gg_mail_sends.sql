-- Correos que gg envía por la persona (2-oct-2026), SIEMPRE después de que ella los revisa y toca «Enviar».
-- La clave de idempotencia evita que un doble toque o un reintento manden el mismo correo dos veces.
CREATE TABLE gg_mail_sends (
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 80),
  provider        text NOT NULL CHECK (provider IN ('google','microsoft')),
  source          text NOT NULL,
  recipients      int NOT NULL,
  status          text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending','sent','failed')),
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, idempotency_key)
);
