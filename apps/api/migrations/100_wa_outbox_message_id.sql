-- send_whatsapp devuelve el id de WhatsApp del mensaje enviado (el mismo de read_whatsapp) para deduplicar exacto.
ALTER TABLE wa_outbox ADD COLUMN wa_message_id text;
