-- Conectar WhatsApp: cada persona puede vincular varias cuentas (personal y
-- Business) como «dispositivo vinculado». Todo es privado de su dueño: nadie
-- más en TieComs ve estos chats salvo que la persona vincule uno a una conversación.

CREATE TABLE wa_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label           text NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  kind            text NOT NULL CHECK (kind IN ('personal', 'business')),
  -- pending: esperando al puente · qr: mostrando código · connected · reconnecting ·
  -- expired: nadie escaneó a tiempo · logged_out: se cerró desde el teléfono · error
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'qr', 'connected', 'reconnecting', 'expired', 'logged_out', 'error')),
  qr              text,
  pair_phone      text,
  pairing_code    text,
  phone           text,
  push_name       text,
  platform        text,
  last_error      text,
  connected_at    timestamptz,
  last_sync_at    timestamptz,
  removed_at      timestamptz,
  lease_owner     text,
  lease_until     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wa_accounts_user ON wa_accounts(user_id) WHERE removed_at IS NULL;

-- Credenciales y llaves de Signal del dispositivo vinculado, cifradas (AES-256-GCM).
CREATE TABLE wa_auth (
  account_id uuid NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
  key        text NOT NULL,
  value      bytea NOT NULL,
  PRIMARY KEY (account_id, key)
);

CREATE TABLE wa_contacts (
  account_id uuid NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
  jid        text NOT NULL,
  name       text,
  PRIMARY KEY (account_id, jid)
);

CREATE TABLE wa_chats (
  account_id        uuid NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
  jid               text NOT NULL,
  name              text,
  is_group          boolean NOT NULL DEFAULT false,
  participants      int,
  description       text,
  last_message_at   timestamptz,
  last_preview      text,
  unread            int NOT NULL DEFAULT 0,
  wa_archived       boolean NOT NULL DEFAULT false,
  -- Organización propia de TieComs (no cambia nada en WhatsApp).
  category          text NOT NULL DEFAULT 'otros'
                    CHECK (category IN ('trabajo', 'clientes', 'familia', 'amigos', 'comunidad', 'otros')),
  category_manual   boolean NOT NULL DEFAULT false,
  pinned            boolean NOT NULL DEFAULT false,
  hidden            boolean NOT NULL DEFAULT false,
  linked_conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  linked_since      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, jid)
);
CREATE INDEX wa_chats_recent ON wa_chats(account_id, last_message_at DESC NULLS LAST);
CREATE INDEX wa_chats_linked ON wa_chats(linked_conversation_id) WHERE linked_conversation_id IS NOT NULL;

-- Solo texto (y la descripción de lo multimedia); los archivos no se descargan.
CREATE TABLE wa_messages (
  account_id  uuid NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
  chat_jid    text NOT NULL,
  id          text NOT NULL,
  from_me     boolean NOT NULL DEFAULT false,
  author_jid  text,
  author_name text,
  kind        text NOT NULL DEFAULT 'text',
  body        text NOT NULL,
  sent_at     timestamptz NOT NULL,
  PRIMARY KEY (account_id, chat_jid, id)
);
CREATE INDEX wa_messages_chat ON wa_messages(account_id, chat_jid, sent_at DESC);
