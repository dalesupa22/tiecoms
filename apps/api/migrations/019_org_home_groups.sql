-- «Tu organización»: cada empresa tiene un espacio casa, sin otras empresas, donde viven
-- sus grupos internos (Diseño, Comercial…). Se crea la primera vez que alguien arma un
-- grupo «solo de mi empresa». Los demás espacios son relaciones con otras empresas.
ALTER TABLE workspaces ADD COLUMN is_org_home boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX workspaces_org_home ON workspaces(owning_org_id) WHERE is_org_home AND archived_at IS NULL;

-- Relación nueva con una empresa que aún no está en TieComs: el nombre que escribió quien la
-- invitó. Mientras ninguna otra empresa entre al espacio, se muestra en «Relaciones» como pendiente.
ALTER TABLE workspaces ADD COLUMN counterpart_name text CHECK (length(counterpart_name) BETWEEN 2 AND 120);

