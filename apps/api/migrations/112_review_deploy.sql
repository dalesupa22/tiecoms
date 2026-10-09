-- «Aprobar y desplegar» (9-oct): la persona aprueba el plan de la IA y la tarjeta vuelve al agente para que lo aplique
-- (despliegue a producción), deje evidencia y la pase otra vez por revisar para verificar. No cierra la tarea.
ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_review_check;
ALTER TABLE issues ADD CONSTRAINT issues_review_check CHECK (review IN ('pending', 'approved', 'changes', 'human', 'deploy'));
