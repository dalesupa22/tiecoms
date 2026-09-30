-- Mensajes programados: se escriben ahora y salen solos a la hora elegida.
-- El worker los revisa cada 15 s con el índice parcial de pendientes: la consulta
-- solo toca filas por enviar (normalmente cero), no el histórico de enviados.
CREATE TABLE scheduled_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  body            text NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  mentions        jsonb,
  reply_to        uuid REFERENCES messages(id) ON DELETE SET NULL,
  send_at         timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','cancelled','failed')),
  claimed_at      timestamptz,
  message_id      uuid REFERENCES messages(id) ON DELETE SET NULL,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);
CREATE INDEX scheduled_due ON scheduled_messages(send_at) WHERE status IN ('pending','sending');
CREATE INDEX scheduled_mine ON scheduled_messages(user_id, send_at) WHERE status IN ('pending','sending','failed');
