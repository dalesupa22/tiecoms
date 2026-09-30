-- Videos y medición de almacenamiento (docs/VIDEO.md, 29-sep-2026).
-- Los videos siguen en attachments (kind 'file', content_type video/*) con duration_ms, width y height que manda
-- el cliente. No hace falta columna nueva: solo índices para sumar bytes por persona y por empresa sin recorrer
-- toda la tabla. Cada s3_key cuenta una vez (el reenvío crea otra fila con el mismo objeto): la cuenta la lleva la
-- primera fila viva de ese objeto (created_at, id), se busca con attachments_s3_key.
CREATE INDEX IF NOT EXISTS attachments_owner_live ON attachments (owner_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS users_primary_org ON users (primary_org_id) WHERE primary_org_id IS NOT NULL;
