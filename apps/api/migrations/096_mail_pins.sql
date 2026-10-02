-- Dos pines por conversación de correo (pedido de Danny, 2-oct-2026), igual que WhatsApp:
--   main_pinned_at: arriba en la pantalla principal (Fijados de Grupos/DMs y la lista de la web).
--   mail_pinned_at: arriba en la pantalla Correo.
-- Se fija la conversación entera (thread_key = threadId del proveedor, o el id del correo si no tiene hilo).
-- Se guarda lo mínimo para pintar la fila sin pedirle nada al proveedor; la fila se borra cuando no queda ningún pin.
CREATE TABLE mail_pins (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider       text NOT NULL CHECK (provider IN ('google','microsoft')),
  thread_key     text NOT NULL CHECK (char_length(thread_key) BETWEEN 1 AND 500),
  message_id     text NOT NULL CHECK (char_length(message_id) BETWEEN 1 AND 500),
  subject        text NOT NULL DEFAULT '' CHECK (char_length(subject) <= 300),
  from_name      text CHECK (char_length(from_name) <= 200),
  from_email     text CHECK (char_length(from_email) <= 254),
  last_at        timestamptz,
  main_pinned_at timestamptz,
  mail_pinned_at timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider, thread_key)
);
