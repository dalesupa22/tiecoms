-- Responder WhatsApp desde chaggu (30-sep-2026). Sigue siendo de solo lectura salvo que la persona lo active
-- en esa cuenta: wa_accounts.send_enabled (apagado por defecto). Lo que se envía pasa por wa_outbox: el API lo
-- encola y el puente (que tiene la sesión de WhatsApp) lo manda y deja el resultado.
ALTER TABLE wa_accounts ADD COLUMN send_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE wa_outbox (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  jid         text NOT NULL,
  body        text NOT NULL,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  error       text,
  attempts    int  NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX wa_outbox_pending ON wa_outbox(account_id, created_at) WHERE status IN ('queued', 'sending');
