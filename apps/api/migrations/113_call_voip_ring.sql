-- Llamadas que timbran como WhatsApp (CH029, 2-nov):
-- 1) iOS registra además un token VoIP (PushKit) por sesión: provider 'apns_voip'. Solo lo usa el push de llamada
--    entrante; los avisos normales siguen yendo al token 'apns'.
-- 2) call_ringees.reached_at: el teléfono de esa persona confirmó que está sonando (POST /calls/:id/ringing).
--    Quien llama pasa de «Llamando…» a «Sonando…».
ALTER TABLE push_subscriptions DROP CONSTRAINT IF EXISTS push_subscriptions_provider_check;
ALTER TABLE push_subscriptions ADD CONSTRAINT push_subscriptions_provider_check CHECK (provider IN ('webpush', 'fcm', 'apns', 'apns_voip'));
ALTER TABLE call_ringees ADD COLUMN IF NOT EXISTS reached_at timestamptz;
