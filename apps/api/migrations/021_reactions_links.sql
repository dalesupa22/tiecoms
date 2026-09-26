-- Reacciones con emoji, biblioteca de enlaces por conversación, «Ver después» personal,
-- resúmenes de enlaces bajo pedido y resumen semanal por correo (docs/REACCIONES_ENLACES.md).

-- ---------- Reacciones ----------
CREATE TABLE message_reactions (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      text NOT NULL CHECK (length(emoji) BETWEEN 1 AND 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, emoji, user_id)
);
CREATE INDEX message_reactions_user ON message_reactions(user_id, created_at DESC);

-- Resumen ya agregado que viaja en MessageDTO.reactions: [{emoji, userIds, external?}].
ALTER TABLE messages ADD COLUMN reactions jsonb;
-- Reacciones llegadas por el puente (WhatsApp): {"<jid>": {"emoji": "👍", "name": "Laura"}}.
ALTER TABLE messages ADD COLUMN external_reactions jsonb;
ALTER TABLE wa_messages ADD COLUMN reactions jsonb;

-- Reacciones con acción (👀 → recordatorio, ✅ → hecho). Las aplica la empresa de quien reacciona.
ALTER TABLE organizations ADD COLUMN reaction_actions boolean NOT NULL DEFAULT true;
-- Recordatorio creado por una reacción: quitarla lo cancela.
ALTER TABLE reminders ADD COLUMN via_reaction text;
CREATE INDEX reminders_via_reaction ON reminders(message_id, user_id) WHERE via_reaction IS NOT NULL AND done_at IS NULL;

-- ---------- Enlaces ----------
-- Vista previa de hasta 3 enlaces; link_preview (el primero) sigue para clientes viejos.
ALTER TABLE messages ADD COLUMN link_previews jsonb;

CREATE TABLE message_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             bigint NOT NULL,
  author_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  position        smallint NOT NULL,
  url             text NOT NULL,
  url_hash        bytea NOT NULL,
  host            text NOT NULL,
  provider        text,
  kind            text NOT NULL DEFAULT 'link' CHECK (kind IN ('video', 'short', 'post', 'article', 'audio', 'image', 'doc', 'code', 'link')),
  preview         jsonb,
  created_at      timestamptz NOT NULL,
  UNIQUE (message_id, position)
);
CREATE INDEX message_links_conv ON message_links(conversation_id, created_at DESC);
CREATE INDEX message_links_url ON message_links(url_hash);

-- Estado personal de cada enlace: guardado para ver después y visto. Nadie más lo ve.
CREATE TABLE link_states (
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  link_id  uuid NOT NULL REFERENCES message_links(id) ON DELETE CASCADE,
  saved_at timestamptz,
  seen_at  timestamptz,
  PRIMARY KEY (user_id, link_id)
);
CREATE INDEX link_states_saved ON link_states(user_id, saved_at DESC) WHERE saved_at IS NOT NULL;

-- Resumen con IA bajo pedido, compartido por URL e idioma (el contenido es público).
CREATE TABLE link_summaries (
  url_hash   bytea NOT NULL,
  lang       text NOT NULL CHECK (lang IN ('es', 'en')),
  summary    text NOT NULL,
  basis      text NOT NULL CHECK (basis IN ('article', 'description')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (url_hash, lang)
);

-- Vista previa grande, compacta o ninguna, por persona y conversación.
ALTER TABLE conversation_prefs ADD COLUMN link_previews text CHECK (link_previews IN ('large', 'compact', 'none'));

-- Resumen semanal de enlaces por correo (se activa en el perfil).
ALTER TABLE users ADD COLUMN link_digest boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN link_digest_sent_at timestamptz;

-- Índice inicial: los enlaces que ya estaban en los mensajes (sin leer páginas: solo URL y tipo por dominio).
INSERT INTO message_links (message_id, conversation_id, seq, author_id, position, url, url_hash, host, created_at, preview)
SELECT m.id, m.conversation_id, m.seq, m.author_id, (u.ord - 1)::smallint,
       u.url, sha256(convert_to(u.url, 'UTF8')), lower(regexp_replace(substring(u.url FROM '^https?://([^/:?#]+)'), '^www\.', '')), m.created_at,
       CASE WHEN u.ord = 1 THEN m.link_preview END
  FROM messages m
  CROSS JOIN LATERAL (
    SELECT regexp_replace(x[1], '[.,;:!?¿¡)\]}»”’]+$', '') AS url, ord
      FROM regexp_matches(m.body, '(https?://[^\s<>"''`]+)', 'gi') WITH ORDINALITY AS r(x, ord)
  ) u
 WHERE m.kind = 'text' AND m.deleted_at IS NULL AND m.body ~* 'https?://' AND u.ord <= 10
ON CONFLICT DO NOTHING;

-- Tipo y plataforma por dominio (la misma regla que classifyUrl en modules/links.ts).
UPDATE message_links SET
  provider = CASE
    WHEN host IN ('youtube.com', 'm.youtube.com', 'youtu.be', 'music.youtube.com') THEN 'youtube'
    WHEN host LIKE '%tiktok.com' THEN 'tiktok'
    WHEN host IN ('instagram.com', 'instagr.am') THEN 'instagram'
    WHEN host IN ('x.com', 'twitter.com', 'mobile.twitter.com') THEN 'x'
    WHEN host LIKE '%linkedin.com' OR host = 'lnkd.in' THEN 'linkedin'
    WHEN host IN ('facebook.com', 'm.facebook.com', 'fb.watch') THEN 'facebook'
    WHEN host LIKE '%vimeo.com' THEN 'vimeo'
    WHEN host = 'open.spotify.com' THEN 'spotify'
    WHEN host IN ('docs.google.com', 'drive.google.com') THEN 'google'
    WHEN host = 'github.com' THEN 'github'
  END,
  kind = CASE
    WHEN host IN ('youtube.com', 'm.youtube.com') AND url ~* '/shorts/' THEN 'short'
    WHEN host IN ('youtube.com', 'm.youtube.com', 'youtu.be', 'fb.watch') OR host LIKE '%vimeo.com' THEN 'video'
    WHEN host LIKE '%tiktok.com' THEN 'short'
    WHEN host IN ('instagram.com', 'instagr.am') AND url ~* '/(reel|reels|tv)/' THEN 'short'
    WHEN host IN ('instagram.com', 'instagr.am', 'x.com', 'twitter.com', 'mobile.twitter.com', 'facebook.com', 'm.facebook.com') OR host LIKE '%linkedin.com' OR host = 'lnkd.in' THEN 'post'
    WHEN host = 'open.spotify.com' OR host = 'music.youtube.com' THEN 'audio'
    WHEN host IN ('docs.google.com', 'drive.google.com') OR url ~* '\.(pdf|docx?|xlsx?|pptx?)([?#]|$)' THEN 'doc'
    WHEN host = 'github.com' THEN 'code'
    WHEN url ~* '\.(png|jpe?g|gif|webp)([?#]|$)' THEN 'image'
    ELSE 'link'
  END;
