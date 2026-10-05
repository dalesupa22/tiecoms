import { pool } from '../db.ts';
import { conflict, forbidden } from '../errors.ts';

/** Final read immediately before Baileys. Do not await any other operation between this guard and sendMessage. */
export async function assertScheduledWaSend(outboxId: string) {
  const r = (await pool.query(`SELECT o.status AS outbox_status,o.mcp_schedule_id,s.* FROM wa_outbox o
    LEFT JOIN mcp_whatsapp_schedules s ON s.id=o.mcp_schedule_id WHERE o.id=$1`, [outboxId])).rows[0];
  if (!r || r.outbox_status !== 'sending') throw conflict('El envío ya no está disponible');
  if (!r.mcp_schedule_id) return;
  if (r.status !== 'sending') throw conflict('La programación ya no está disponible');
  // Single final authorization query avoids a token revocation occurring between separate permission reads.
  const ok = await pool.query(`SELECT 1 FROM mcp_tokens t JOIN users u ON u.id=t.user_id
    JOIN wa_accounts a ON a.user_id=u.id JOIN wa_chats c ON c.account_id=a.id
    JOIN wa_outbox o ON o.id=$5 JOIN mcp_whatsapp_schedules s ON s.id=o.mcp_schedule_id
    WHERE t.id=$1 AND u.id=$2 AND a.id=$3 AND c.jid=$4 AND o.status='sending' AND s.status='sending'
      AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>now()) AND u.disabled_at IS NULL
      AND (t.scopes IS NULL OR 'whatsapp:send'=ANY(t.scopes)) AND a.removed_at IS NULL AND a.send_enabled AND a.status='connected'
      AND wa_chat_visible(a.id,c.jid) AND c.jid NOT LIKE '%@broadcast' AND c.jid NOT LIKE '%@newsletter'
      AND (c.integrations_shared OR CASE WHEN t.wa_account_ids IS NULL THEN a.integrations_enabled ELSE a.id=ANY(t.wa_account_ids) END)`,
    [r.mcp_token_id, r.user_id, r.account_id, r.jid, outboxId]);
  if (!ok.rowCount) throw forbidden('La autorización de esta programación fue revocada o el destino ya no está disponible');
}

/** No automatic retry: even an exception can mean WhatsApp accepted the message before a connection failed. */
export async function deliverScheduledWaOutbox<T extends { key?: { id?: string | null } } | undefined>(
  outboxId: string, sendProvider: () => Promise<T>, afterSent?: (sent: T) => Promise<void>,
): Promise<T> {
  let sent: T;
  try {
    await assertScheduledWaSend(outboxId);
    sent = await sendProvider();
    if (!sent?.key?.id) throw new Error('WhatsApp no confirmó el identificador del mensaje. Revisa en WhatsApp antes de programarlo otra vez.');
    await pool.query("UPDATE wa_outbox SET status='sent',sent_at=now(),body='',wa_message_id=$2,error=NULL WHERE id=$1", [outboxId, sent.key.id]);
  } catch (e: any) {
    await pool.query("UPDATE wa_outbox SET status='failed',error=$2,body='' WHERE id=$1 AND status='sending'", [outboxId, String(e?.message ?? e).slice(0, 300)]);
    throw e;
  }
  // Provider receipt is already durable. History/download/webhook bookkeeping must never relabel it as failed.
  try { await afterSent?.(sent); } catch (e: any) { console.error('[wa] scheduled sent; local bookkeeping failed', outboxId, e?.message); }
  return sent;
}
