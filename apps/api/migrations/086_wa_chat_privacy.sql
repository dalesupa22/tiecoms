-- Chat Lock is independent from archive, local hide and group admin restrictions.
-- Existing accounts start closed until a complete provider app-state reconstruction.
ALTER TABLE wa_chats ADD COLUMN wa_locked boolean, ADD COLUMN privacy_only boolean NOT NULL DEFAULT false;
ALTER TABLE wa_accounts ADD COLUMN privacy_synced_at timestamptz, ADD COLUMN privacy_hydrated_at timestamptz;
CREATE INDEX wa_chats_locked ON wa_chats(account_id,jid) WHERE wa_locked IS TRUE;

CREATE FUNCTION wa_account_visible(acc uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM wa_accounts a WHERE a.id=acc AND a.removed_at IS NULL
    AND a.privacy_synced_at IS NOT NULL AND a.lease_owner IS NOT NULL AND a.lease_until > now()
    -- An unresolved locked PN/LID could alias any known direct chat.
    AND NOT EXISTS (
      SELECT 1 FROM wa_chats locked WHERE locked.account_id=acc AND locked.wa_locked IS TRUE
        AND (locked.jid LIKE '%@lid' OR locked.jid LIKE '%@s.whatsapp.net')
        AND NOT EXISTS (SELECT 1 FROM wa_jid_alias al WHERE al.account_id=acc AND (al.lid=locked.jid OR al.pn=locked.jid))
    ))
$$;

CREATE FUNCTION wa_chat_visible(acc uuid, chat text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM wa_chats c WHERE c.account_id=acc AND c.jid=chat
      AND wa_account_visible(acc) AND NOT c.privacy_only AND c.wa_locked IS NOT TRUE
      AND NOT EXISTS (
        SELECT 1 FROM wa_jid_alias al JOIN wa_chats locked ON locked.account_id=al.account_id
          AND (locked.jid=al.lid OR locked.jid=al.pn)
        WHERE al.account_id=acc AND (al.lid=chat OR al.pn=chat) AND locked.wa_locked IS TRUE
      )
  )
$$;
