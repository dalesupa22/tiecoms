-- WhatsApp igual que el correo (docs/CORREO.md): un mensaje de WhatsApp llevado a un chat se guarda como un
-- shared_emails con provider 'whatsapp', para tener el mismo hilo de comentarios, tarea y tarjeta.
-- meta guarda lo propio de WhatsApp (chat, grupo, cuenta). No se guarda nada más del chat de WhatsApp.
ALTER TABLE shared_emails DROP CONSTRAINT IF EXISTS shared_emails_provider_check;
ALTER TABLE shared_emails ADD CONSTRAINT shared_emails_provider_check CHECK (provider IN ('google','microsoft','whatsapp'));
ALTER TABLE shared_emails ADD COLUMN IF NOT EXISTS meta jsonb;
