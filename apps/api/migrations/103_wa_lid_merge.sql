-- Chats 1:1 duplicados por LID (4-oct-2026). WhatsApp a veces entrega un mensaje directo con la dirección LID
-- (…@lid) en vez del número (…@s.whatsapp.net): el mensaje quedaba en un chat nuevo sin nombre en lugar del
-- chat de siempre con esa persona. Desde ahora el puente guarda los chats 1:1 por número cuando conoce la
-- equivalencia (wa_jid_alias), y esta función une el chat LID con el del número: mensajes, estado del chat,
-- borradores, envíos, lista de lectura, avisos MCP y «gg de este chat». La privacidad no se afloja: si
-- cualquiera de los dos estaba bloqueado, el resultado queda bloqueado.

CREATE OR REPLACE FUNCTION wa_merge_lid_chat(acc uuid, lid text, pn text) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  l wa_chats%ROWTYPE;
  p wa_chats%ROWTYPE;
  l_ref text := acc::text || '|' || lid;
  p_ref text := acc::text || '|' || pn;
  l_src text := 'wa:' || acc::text || ':' || lid;
  p_src text := 'wa:' || acc::text || ':' || pn;
BEGIN
  IF lid NOT LIKE '%@lid' OR pn NOT LIKE '%@s.whatsapp.net' THEN RETURN false; END IF;
  SELECT * INTO l FROM wa_chats c WHERE c.account_id = acc AND c.jid = lid FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO p FROM wa_chats c WHERE c.account_id = acc AND c.jid = pn FOR UPDATE;

  IF NOT FOUND THEN
    -- No había chat con el número: el chat LID pasa a llamarse por el número.
    UPDATE wa_chats c SET jid = pn, updated_at = now() WHERE c.account_id = acc AND c.jid = lid;
  ELSE
    -- Si el chat del número era solo un marcador de privacidad, lo visible es lo del chat LID.
    UPDATE wa_chats c SET
      name = CASE WHEN p.privacy_only THEN COALESCE(l.name, p.name) ELSE COALESCE(p.name, l.name) END,
      participants = COALESCE(p.participants, l.participants),
      description = COALESCE(p.description, l.description),
      last_preview = CASE WHEN p.last_message_at IS NULL OR (l.last_message_at IS NOT NULL AND l.last_message_at > p.last_message_at)
                          THEN COALESCE(l.last_preview, p.last_preview) ELSE COALESCE(p.last_preview, l.last_preview) END,
      last_message_at = GREATEST(p.last_message_at, l.last_message_at),
      unread = p.unread + l.unread,
      wa_archived = CASE WHEN p.privacy_only THEN l.wa_archived ELSE p.wa_archived END,
      category = CASE WHEN p.category_manual OR NOT l.category_manual THEN p.category ELSE l.category END,
      category_manual = p.category_manual OR l.category_manual,
      pinned = p.pinned OR l.pinned,
      hidden = CASE WHEN p.privacy_only THEN l.hidden WHEN l.privacy_only THEN p.hidden ELSE p.hidden AND l.hidden END,
      linked_conversation_id = COALESCE(p.linked_conversation_id, l.linked_conversation_id),
      linked_since = CASE WHEN p.linked_conversation_id IS NOT NULL THEN p.linked_since ELSE l.linked_since END,
      inbox_place = COALESCE(p.inbox_place, l.inbox_place),
      inbox_pinned_at = COALESCE(p.inbox_pinned_at, l.inbox_pinned_at),
      -- Gana la decisión explícita más reciente; con la misma revisión, bloqueado gana.
      wa_locked = CASE
        WHEN l.wa_lock_revision > p.wa_lock_revision THEN COALESCE(l.wa_locked, p.wa_locked)
        WHEN p.wa_lock_revision > l.wa_lock_revision THEN COALESCE(p.wa_locked, l.wa_locked)
        WHEN p.wa_locked IS TRUE OR l.wa_locked IS TRUE THEN true
        ELSE COALESCE(p.wa_locked, l.wa_locked) END,
      wa_lock_revision = GREATEST(p.wa_lock_revision, l.wa_lock_revision),
      privacy_only = p.privacy_only AND l.privacy_only,
      integrations_shared = p.integrations_shared OR l.integrations_shared,
      members = COALESCE(p.members, l.members),
      reading_list = p.reading_list OR l.reading_list,
      reading_since = CASE WHEN p.reading_since IS NULL THEN l.reading_since WHEN l.reading_since IS NULL THEN p.reading_since
                           ELSE LEAST(p.reading_since, l.reading_since) END,
      created_at = LEAST(p.created_at, l.created_at),
      updated_at = now()
    WHERE c.account_id = acc AND c.jid = pn;

    -- El mismo mensaje en los dos chats: se queda el del número, con las reacciones de ambos.
    UPDATE wa_messages m SET reactions = NULLIF(COALESCE(m.reactions, '{}'::jsonb) || COALESCE(x.reactions, '{}'::jsonb), '{}'::jsonb),
                             transcript = COALESCE(m.transcript, x.transcript),
                             media_info = COALESCE(m.media_info, x.media_info)
      FROM wa_messages x
     WHERE m.account_id = acc AND m.chat_jid = pn AND x.account_id = acc AND x.chat_jid = lid AND x.id = m.id;
    DELETE FROM wa_messages x USING wa_messages m
     WHERE x.account_id = acc AND x.chat_jid = lid AND m.account_id = acc AND m.chat_jid = pn AND m.id = x.id;
    DELETE FROM wa_chats c WHERE c.account_id = acc AND c.jid = lid;
  END IF;

  UPDATE wa_messages m SET chat_jid = pn WHERE m.account_id = acc AND m.chat_jid = lid;
  UPDATE wa_drafts d SET jid = pn WHERE d.account_id = acc AND d.jid = lid;
  UPDATE wa_outbox o SET jid = pn WHERE o.account_id = acc AND o.jid = lid;
  UPDATE reading_items r SET jid = pn WHERE r.account_id = acc AND r.jid = lid;
  UPDATE mcp_webhooks h SET chats = ARRAY(SELECT DISTINCT unnest(array_replace(h.chats, l_ref, p_ref)))
   WHERE l_ref = ANY(h.chats);
  UPDATE gg_side_messages g SET source = p_src WHERE g.source = l_src;
  UPDATE gg_side_state g SET source = p_src
   WHERE g.source = l_src AND NOT EXISTS (SELECT 1 FROM gg_side_state o WHERE o.user_id = g.user_id AND o.source = p_src);
  UPDATE gg_side_state o SET pending_count = o.pending_count + g.pending_count
    FROM gg_side_state g WHERE g.source = l_src AND o.user_id = g.user_id AND o.source = p_src;
  DELETE FROM gg_side_state g WHERE g.source = l_src;
  RETURN true;
END $$;

-- Los que ya quedaron duplicados (o solo existen por LID) y cuyo número ya se conoce.
SELECT wa_merge_lid_chat(al.account_id, al.lid, al.pn)
  FROM wa_jid_alias al JOIN wa_chats c ON c.account_id = al.account_id AND c.jid = al.lid
 ORDER BY al.account_id, al.lid;
