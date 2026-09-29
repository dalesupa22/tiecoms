-- gg como chat y «Tú» (docs/GG-CHAT.md).
-- gg es un participante bot único (users.kind = 'agent') con id fijo. Cada persona tiene un directo con gg
-- (dm_key persona:gg) donde queda el historial. «Tú» es un directo de la persona consigo misma (dm_key id:id).
INSERT INTO users (id, kind, name) VALUES ('0a9a9a9a-0000-4000-8000-000000000066', 'agent', 'gg')
  ON CONFLICT (id) DO NOTHING;

-- Consentimiento para usar IA (DeepSeek) con gg: se guarda para que gg responda en su chat y con @gg.
ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_consent_at timestamptz;
