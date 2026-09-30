-- WhatsApp identifica a muchos participantes por LID (@lid) en vez de su número. Aquí se guarda
-- la equivalencia LID ↔ número de cada cuenta para mostrar nombres (o al menos el número).
CREATE TABLE IF NOT EXISTS wa_jid_alias (
  account_id uuid NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
  lid text NOT NULL,
  pn text NOT NULL,
  PRIMARY KEY (account_id, lid)
);
CREATE INDEX IF NOT EXISTS wa_jid_alias_pn ON wa_jid_alias (account_id, pn);

-- El nombre que cada quien se pone en WhatsApp (pushName) va aparte: no debe pisar el de la libreta.
ALTER TABLE wa_contacts ADD COLUMN IF NOT EXISTS push_name text;
