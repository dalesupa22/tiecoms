-- La IA toma tarjetas (llamada con Lorena 7-oct): reserva con vencimiento para que dos corridas (webhook y cron)
-- no trabajen la misma tarea a la vez. Se libera al dejarla por revisar, al cerrarla o al vencer.
ALTER TABLE issues ADD COLUMN claimed_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE issues ADD COLUMN claimed_until timestamptz;
