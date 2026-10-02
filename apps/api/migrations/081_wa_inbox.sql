-- WhatsApp en la bandeja (1-oct-2026, docs/WA-BANDEJA-GG-CHAT.md): un chat de WhatsApp se puede «mover a mi lista
-- principal» (Grupos o DMs de chaggu) y además fijarlo arriba. wa_chats.pinned (fijado dentro de WhatsApp) no se toca.
ALTER TABLE wa_chats
  ADD COLUMN IF NOT EXISTS inbox_place text CHECK (inbox_place IN ('groups','dms')),
  ADD COLUMN IF NOT EXISTS inbox_pinned_at timestamptz;
CREATE INDEX IF NOT EXISTS wa_chats_inbox ON wa_chats(account_id) WHERE inbox_place IS NOT NULL;
