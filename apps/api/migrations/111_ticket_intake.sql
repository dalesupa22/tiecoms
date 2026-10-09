-- Al llegar un ticket (pedido de Danny 9-oct): por grupo, a quién se asigna solo y en qué estado entra.
-- NULL = manual: llega sin responsable y una persona decide si se lo pasa a la IA (como hasta hoy).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ticket_intake jsonb;

