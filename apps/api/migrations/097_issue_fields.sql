-- Campos dinámicos en las tareas (2-oct-2026): pares nombre → valor (texto, número o sí/no) que llegan por
-- webhook, por la API de integraciones, por el MCP o a mano. En la lista se muestran como columnas.
ALTER TABLE issues ADD COLUMN IF NOT EXISTS fields jsonb;
ALTER TABLE issue_events DROP CONSTRAINT IF EXISTS issue_events_kind_check;
ALTER TABLE issue_events ADD CONSTRAINT issue_events_kind_check CHECK (kind IN ('created','status','owner','due','title','comment','waiting','visibility','assignees','attachments','moved','fields'));
-- Columnas definidas por grupo: nombre, tipo (texto, lista desplegable, número, casilla) y opciones de la lista.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS task_columns jsonb;
