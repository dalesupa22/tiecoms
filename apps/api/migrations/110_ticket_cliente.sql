-- Cliente en los tickets (pedido de Danny 8-oct): los tickets que llegan por una integración con «Empresa» en sus datos
-- (la mesa de ayuda de Xertify la envía) muestran el cliente en una columna «Cliente» del grupo. Los nuevos la llenan
-- solos al llegar (integrations.createIssue); aquí se agrega la columna y se llenan los que ya existen, sin eventos.
UPDATE conversations c SET task_columns = COALESCE(c.task_columns, '[]'::jsonb) || '[{"name":"Cliente","type":"text"}]'::jsonb
 WHERE EXISTS (SELECT 1 FROM issues i WHERE i.conversation_id = c.id AND i.integration_id IS NOT NULL
                AND COALESCE(i.external_meta->>'Empresa', '') <> '')
   AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(c.task_columns, '[]'::jsonb)) col WHERE lower(col->>'name') = 'cliente');

UPDATE issues SET fields = COALESCE(fields, '{}'::jsonb) || jsonb_build_object('Cliente', btrim(external_meta->>'Empresa'))
 WHERE integration_id IS NOT NULL AND COALESCE(btrim(external_meta->>'Empresa'), '') <> ''
   AND NOT (COALESCE(fields, '{}'::jsonb) ? 'Cliente');
