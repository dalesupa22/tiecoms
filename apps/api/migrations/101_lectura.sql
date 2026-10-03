-- Lista de lectura (3-oct-2026, docs/LECTURA.md): los enlaces de los chats de WhatsApp que la persona marque
-- («📚 Enlaces a Ver después», p. ej. el chat de su papá) entran solos a su lista, junto a lo que guardó en chaggu.
-- «Resúmeme todo» resume cada enlace por su contenido (artículo, subtítulos de YouTube, texto del post) y los marca leídos.
ALTER TABLE wa_chats ADD COLUMN reading_list boolean NOT NULL DEFAULT false, ADD COLUMN reading_since timestamptz;

CREATE TABLE reading_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url           text NOT NULL,
  url_hash      bytea NOT NULL,
  host          text NOT NULL,
  provider      text,
  kind          text NOT NULL DEFAULT 'link',
  preview       jsonb,
  source        text NOT NULL CHECK (source IN ('whatsapp', 'manual')),
  account_id    uuid REFERENCES wa_accounts(id) ON DELETE CASCADE,
  jid           text,
  wa_message_id text,
  from_name     text,
  shared_at     timestamptz NOT NULL DEFAULT now(),
  seen_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, url_hash)
);
CREATE INDEX reading_items_pending ON reading_items(user_id, shared_at DESC) WHERE seen_at IS NULL;

-- El resumen puede salir de los subtítulos de un video o del texto completo de un post, no solo del artículo.
ALTER TABLE link_summaries DROP CONSTRAINT IF EXISTS link_summaries_basis_check;
ALTER TABLE link_summaries ADD CONSTRAINT link_summaries_basis_check CHECK (basis IN ('article', 'description', 'transcript', 'post'));
