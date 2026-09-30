-- Correo en el chat (docs/CORREO.md). La bandeja NO se guarda: se consulta en vivo a Gmail u Outlook.
-- Solo se guarda una copia de texto del correo que alguien lleva a un chat, sin adjuntos.
-- (038 la usa la rama llamadas-chime.)

-- Conexión por persona, igual que meeting_connections pero con permisos de correo y consentimiento aparte.
CREATE TABLE mail_connections (
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          text NOT NULL CHECK (provider IN ('google','microsoft')),
  account_email     text,
  scopes            text NOT NULL DEFAULT '',
  access_token_enc  bytea,
  refresh_token_enc bytea,
  expires_at        timestamptz,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','reconnect')),
  generation        uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE mail_flows (
  state_hash      bytea PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        text NOT NULL,
  verifier        text NOT NULL,
  platform        text NOT NULL,
  native_scheme   text,
  proof_challenge text NOT NULL,
  expires_at      timestamptz NOT NULL
);

CREATE TABLE mail_confirmations (
  receipt_hash    bytea PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        text NOT NULL,
  proof_challenge text NOT NULL,
  tokens_enc      bytea NOT NULL,
  expires_at      timestamptz NOT NULL
);
CREATE INDEX mail_confirmations_expiry ON mail_confirmations(expires_at);

-- Un correo llevado a un chat. body_text es texto plano, solo lo nuevo (sin historial citado ni firma), máx. 20 000
-- caracteres; body_trimmed dice si se cortó (el original completo se trae en vivo del buzón al pedirlo).
CREATE TABLE shared_emails (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  shared_by        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         text NOT NULL CHECK (provider IN ('google','microsoft')),
  account_email    text,
  external_id      text NOT NULL,
  thread_id        text,
  internet_id      text,
  direction        text NOT NULL CHECK (direction IN ('in','out')),
  from_name        text,
  from_email       text,
  to_list          jsonb NOT NULL DEFAULT '[]',
  cc_list          jsonb NOT NULL DEFAULT '[]',
  subject          text NOT NULL DEFAULT '',
  snippet          text NOT NULL DEFAULT '',
  body_text        text NOT NULL DEFAULT '' CHECK (char_length(body_text) <= 20000),
  body_trimmed     boolean NOT NULL DEFAULT false,
  sent_at          timestamptz,
  attachments      jsonb NOT NULL DEFAULT '[]',
  message_id       uuid REFERENCES messages(id) ON DELETE SET NULL,
  comment          text CHECK (comment IS NULL OR char_length(comment) <= 4000),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','scheduled','replied')),
  replied_at       timestamptz,
  replied_by       uuid REFERENCES users(id),
  issue_id         uuid REFERENCES issues(id) ON DELETE SET NULL,
  close_issue_on_reply boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shared_emails_conversation ON shared_emails(conversation_id, created_at DESC);
CREATE INDEX shared_emails_issue ON shared_emails(issue_id) WHERE issue_id IS NOT NULL;

CREATE TABLE shared_email_comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id   uuid NOT NULL REFERENCES shared_emails(id) ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES users(id),
  body       text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shared_email_comments_email ON shared_email_comments(email_id, created_at);

-- Respuestas: enviadas ya o programadas. El texto se borra al enviarse (queda en los Enviados de la persona).
CREATE TABLE mail_replies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id       uuid NOT NULL REFERENCES shared_emails(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body           text NOT NULL CHECK (char_length(body) <= 20000),
  cc             jsonb, -- NULL = responder a todos (menos yo)
  attachment_ids jsonb NOT NULL DEFAULT '[]',
  notify_chat    boolean NOT NULL DEFAULT true,
  send_at        timestamptz NOT NULL DEFAULT now(),
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed','cancelled')),
  attempts       int NOT NULL DEFAULT 0,
  error          text,
  sent_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mail_replies_due ON mail_replies(send_at) WHERE status = 'queued';
CREATE UNIQUE INDEX mail_replies_one_open ON mail_replies(email_id) WHERE status IN ('queued','sending');
