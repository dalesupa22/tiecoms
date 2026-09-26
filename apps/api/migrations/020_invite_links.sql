-- Invitar con enlace directo o con código corto (K7QM-4XPA), además del correo. El código se guarda
-- con hash, como el token. Un enlace o código sin correo puede servir a varias personas hasta vencer.
ALTER TABLE invitations
  ADD COLUMN code_hash bytea UNIQUE,
  ADD COLUMN multi_use boolean NOT NULL DEFAULT false,
  ADD COLUMN uses integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT invitations_multi_use_no_email CHECK (NOT multi_use OR email IS NULL);
