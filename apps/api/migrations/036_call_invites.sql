-- Agregar personas a una llamada en curso (docs/LLAMADAS.md › Agregar personas): quien está en la llamada suma a
-- alguien con quien comparte empresa o espacio aunque no esté en el chat. La invitación da acceso a ESA llamada
-- (entrar, latir, transcripción, historial y resumen), no a los mensajes de la conversación.
CREATE TABLE IF NOT EXISTS call_invites (
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (call_id, user_id)
);
CREATE INDEX IF NOT EXISTS call_invites_user ON call_invites (user_id, created_at DESC);
