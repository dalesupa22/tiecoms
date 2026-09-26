-- Foto de grupo, conversaciones laterales y notificaciones push (APNs / FCM).

-- ---------- Foto de grupo ----------
-- Se sirve igual que las fotos de personas (/api/v1/avatars/:id); propósito propio
-- para que eliminar la cuenta de quien la subió no borre la foto del grupo.
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_purpose_check;
ALTER TABLE files ADD CONSTRAINT files_purpose_check CHECK (purpose IN ('avatar', 'attachment', 'document', 'preview', 'group_avatar'));
ALTER TABLE conversations ADD COLUMN avatar_file_id uuid REFERENCES files(id) ON DELETE SET NULL;

-- ---------- Conversaciones laterales ----------
-- side = consulta privada desde un mensaje (chat multi fuera de los espacios que cuelga de su origen).
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_derive_kind_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_derive_kind_check CHECK (derive_kind IN ('same', 'internal', 'directive', 'side'));
CREATE INDEX conversations_parent_message ON conversations(parent_message_id) WHERE parent_message_id IS NOT NULL;

-- ---------- Push ----------
-- Un token por sesión (el dispositivo que inició sesión); se borra al cerrar sesión o si el proveedor lo rechaza.
ALTER TABLE push_subscriptions
  ADD COLUMN environment text NOT NULL DEFAULT 'production' CHECK (environment IN ('sandbox', 'production')),
  ADD COLUMN lang        text NOT NULL DEFAULT 'es' CHECK (lang IN ('es', 'en')),
  ADD COLUMN updated_at  timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_error  text,
  ADD COLUMN failures    int NOT NULL DEFAULT 0;
CREATE INDEX push_subscriptions_session ON push_subscriptions(session_id);
