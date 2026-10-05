/** Durable, permission-bound one-shot schedules for MCP. All queue mutations are local DB transactions. */
import { createHash, randomUUID } from 'node:crypto';
import { conversationAccess } from '../access.ts';
import { enqueueOutbox, pool, tx, type Db, type Tx } from '../db.ts';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { type McpCtx, target, chatRef, allowedAccounts } from './mcp-wa.ts';
import { sendMessage } from './messages.ts';
import { parseScheduleTime } from './mcp-schedule-time.ts';

export type ScheduleChannel = 'chaggu' | 'whatsapp';
type When = { text: string; sendAt: string; timezone: string; idempotencyKey: string };
const table = (channel: ScheduleChannel) => channel === 'chaggu' ? 'scheduled_messages' : 'mcp_whatsapp_schedules';
const scope = (channel: ScheduleChannel, read = false) => channel === 'chaggu' ? `chats:${read ? 'read' : 'write'}` : 'whatsapp:send';
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = (d: any) => d ? new Date(d).toISOString() : null;
const errorText = (e: any) => String(e?.message ?? 'No se pudo enviar').slice(0, 300);
function textBody(body: string) { if (!body?.trim() || body.length > 8000) throw badRequest('text debe contener entre 1 y 8000 caracteres'); return body; }

/** Never trust the authorization snapshot captured when the schedule was created. Share locks serialize revocation. */
export async function currentScheduleContext(db: Db, userId: string, tokenId: string, requiredScope: string, lock = true): Promise<McpCtx> {
  const r = (await db.query(`SELECT t.id, t.user_id, t.scopes, t.wa_account_ids, COALESCE(t.client_name,t.name) AS app
    FROM mcp_tokens t JOIN users u ON u.id=t.user_id WHERE t.id=$1 AND t.user_id=$2
      AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>now()) AND u.disabled_at IS NULL
      AND (t.scopes IS NULL OR $3=ANY(t.scopes)) ${lock ? 'FOR SHARE OF t,u' : ''}`, [tokenId, userId, requiredScope])).rows[0];
  if (!r) throw forbidden('La autorización MCP venció, fue revocada o ya no permite esta operación');
  return { userId: r.user_id, tokenId: r.id, scopes: r.scopes, waAccountIds: r.wa_account_ids, clientName: r.app };
}

async function nativeAccess(db: Db, ctx: McpCtx, conversationId: string, read = false) {
  // Lock membership rows as well as the conversation so access changes cannot race a native append.
  await db.query(`SELECT c.id FROM conversations c JOIN conversation_memberships cm ON cm.conversation_id=c.id
    WHERE c.id=$1 AND cm.user_id=$2 FOR SHARE OF c,cm`, [conversationId, ctx.userId]);
  await db.query(`SELECT wm.user_id FROM workspace_memberships wm JOIN conversations c ON c.workspace_id=wm.workspace_id
    WHERE c.id=$1 AND wm.user_id=$2 FOR SHARE OF wm`, [conversationId, ctx.userId]);
  return conversationAccess(db, ctx.userId, conversationId, read ? 'read' : 'post');
}

async function whatsappAccess(db: Db, ctx: McpCtx, accountId: string | null, jid: string, lock = true, ready = true) {
  const r = (await db.query(`SELECT a.id, a.label FROM wa_accounts a JOIN wa_chats c ON c.account_id=a.id
    WHERE a.id=$3 AND c.jid=$4 AND a.user_id=$1 AND a.removed_at IS NULL ${ready ? "AND a.send_enabled AND a.status='connected'" : ''} AND wa_chat_visible(a.id,c.jid)
      AND c.jid NOT LIKE '%@broadcast' AND c.jid NOT LIKE '%@newsletter'
      AND (c.integrations_shared OR CASE WHEN $2::uuid[] IS NULL THEN a.integrations_enabled ELSE a.id=ANY($2) END)
    ${lock ? 'FOR SHARE OF a,c' : ''}`, [ctx.userId, ctx.waAccountIds, accountId, jid])).rows[0];
  if (!r) throw forbidden('Ese WhatsApp ya no está conectado, habilitado o compartido con esta integración, o el chat está bloqueado');
  return r;
}

async function authorize(db: Db, ctx: McpCtx, channel: ScheduleChannel, row: any, read = false) {
  return channel === 'chaggu' ? nativeAccess(db, ctx, row.conversation_id, read) : whatsappAccess(db, ctx, row.account_id, row.jid, true, !read);
}

function restrictedReceipt(channel: ScheduleChannel, r: any) {
  return { id: r.id, channel, status: r.status, ...parseScheduleTime(iso(r.send_at)!, r.timezone ?? 'UTC', false), restricted: true };
}

function receipt(channel: ScheduleChannel, r: any) {
  const when = parseScheduleTime(iso(r.send_at)!, r.timezone ?? 'UTC', false);
  return { id: r.id, channel, status: r.status, ...when, text: r.body,
    ...(channel === 'chaggu' ? { conversationId: r.conversation_id, ...(r.reply_to ? { replyTo: r.reply_to } : {}) }
      : { chat: r.account_id ? chatRef(r.account_id, r.jid) : null, account: r.account_label, to: r.target_label, ...(r.outbox_id ? { outboxId: r.outbox_id } : {}) }),
    ...(r.message_id ? { messageId: r.message_id } : {}), ...(r.error ? { error: r.error } : {}),
    createdAt: iso(r.created_at), ...(r.sent_at ? { sentAt: iso(r.sent_at) } : {}),
  };
}

export async function notifyNativeSchedule(db: Db, r: any) {
  await enqueueOutbox(db as Tx, 'account.event', { userIds: [r.user_id], event: { type: 'scheduled.updated', scheduled: {
    id: r.id, conversationId: r.conversation_id, body: r.body, mentions: r.mentions ?? [], replyTo: r.reply_to,
    sendAt: iso(r.send_at), status: r.status, messageId: r.message_id, error: r.error, createdAt: iso(r.created_at), sentAt: iso(r.sent_at),
  } } });
}

async function keyLock(db: Db, tokenId: string, key: string) {
  if (!key?.trim() || key.length > 200) throw badRequest('idempotencyKey es obligatoria y admite hasta 200 caracteres');
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`mcp-schedule:${tokenId}:${key}`]);
}
async function existing(db: Db, ctx: McpCtx, channel: ScheduleChannel, key: string, hash: string) {
  const k = (await db.query('SELECT * FROM mcp_schedule_keys WHERE token_id=$1 AND key=$2', [ctx.tokenId, key])).rows[0];
  if (!k) return null;
  if (k.channel !== channel || k.request_hash !== hash) throw new ApiError(409, 'idempotency_mismatch', 'Esa idempotencyKey ya se usó con otra programación');
  const row = (await db.query(`SELECT * FROM ${table(channel)} WHERE id=$1 AND user_id=$2 AND mcp_token_id=$3`, [k.schedule_id, ctx.userId, ctx.tokenId])).rows[0];
  if (!row) throw conflict('La programación original ya no está disponible; la clave se conserva para impedir duplicados');
  await authorize(db, ctx, channel, row);
  return { ...receipt(channel, row), duplicate: true };
}
async function saveKey(db: Db, ctx: McpCtx, channel: ScheduleChannel, id: string, key: string, hash: string) {
  await db.query('INSERT INTO mcp_schedule_keys(token_id,key,channel,schedule_id,request_hash) VALUES($1,$2,$3,$4,$5)', [ctx.tokenId, key, channel, id, hash]);
}

export async function createChaggu(ctx: McpCtx, a: When & { conversationId: string; replyTo?: string }) {
  const when = parseScheduleTime(a.sendAt, a.timezone, false), body = textBody(a.text);
  const hash = fingerprint(['chaggu', a.conversationId, body, when.sendAt, when.timezone, a.replyTo ?? null]);
  return tx(async db => {
    await keyLock(db, ctx.tokenId, a.idempotencyKey);
    const live = await currentScheduleContext(db, ctx.userId, ctx.tokenId, scope('chaggu'));
    const replay = await existing(db, live, 'chaggu', a.idempotencyKey, hash); if (replay) return replay;
    parseScheduleTime(a.sendAt, a.timezone);
    await nativeAccess(db, live, a.conversationId);
    if (a.replyTo && !(await db.query('SELECT 1 FROM messages WHERE id=$1 AND conversation_id=$2', [a.replyTo, a.conversationId])).rowCount) throw badRequest('El mensaje citado no está en esta conversación');
    const r = (await db.query(`INSERT INTO scheduled_messages(user_id,conversation_id,body,reply_to,send_at,mcp_token_id,timezone)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [ctx.userId, a.conversationId, body, a.replyTo ?? null, when.sendAt, ctx.tokenId, when.timezone])).rows[0];
    await saveKey(db, live, 'chaggu', r.id, a.idempotencyKey, hash);
    await notifyNativeSchedule(db, r);
    return receipt('chaggu', r);
  });
}

export async function createWhatsapp(ctx: McpCtx, a: When & { chat?: string; phone?: string; account?: string }) {
  const when = parseScheduleTime(a.sendAt, a.timezone, false), body = textBody(a.text);
  if (body.length > 4000) throw badRequest('Los mensajes de WhatsApp admiten hasta 4000 caracteres');
  if ((!a.chat && !a.phone) || (a.chat && a.phone)) throw badRequest('Indica exactamente uno de chat o phone');
  const hash = fingerprint(['whatsapp', a.chat ?? null, a.phone ?? null, a.account ?? null, body, when.sendAt, when.timezone]);
  return tx(async db => {
    await keyLock(db, ctx.tokenId, a.idempotencyKey);
    const live = await currentScheduleContext(db, ctx.userId, ctx.tokenId, scope('whatsapp'));
    const replay = await existing(db, live, 'whatsapp', a.idempotencyKey, hash); if (replay) return replay;
    parseScheduleTime(a.sendAt, a.timezone);
    if (a.phone && !a.account && (await allowedAccounts(live, db)).length > 1) throw badRequest('Tienes varias cuentas de WhatsApp; indica account para elegir desde qué número programar');
    const t = await target(live, a, db);
    await whatsappAccess(db, live, t.accountId, t.jid);
    const r = (await db.query(`INSERT INTO mcp_whatsapp_schedules(user_id,mcp_token_id,account_id,account_label,jid,target_label,body,send_at,timezone)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [ctx.userId, ctx.tokenId, t.accountId, t.account.label, t.jid, t.label, body, when.sendAt, when.timezone])).rows[0];
    await saveKey(db, live, 'whatsapp', r.id, a.idempotencyKey, hash);
    return receipt('whatsapp', r);
  });
}

export async function list(ctx: McpCtx, a: { channel: ScheduleChannel; status?: 'pending' | 'sending' | 'queued' | 'sent' | 'failed' | 'cancelled' | 'all'; limit?: number }) {
  return tx(async db => {
    const live = await currentScheduleContext(db, ctx.userId, ctx.tokenId, scope(a.channel, true));
    const limit = Math.min(Math.max(a.limit ?? 50, 1), 100);
    const rows = (await db.query(`SELECT * FROM ${table(a.channel)} WHERE user_id=$1 AND mcp_token_id=$2
      AND ($3::text IS NULL OR status=$3) ORDER BY send_at DESC,id LIMIT $4`, [ctx.userId, ctx.tokenId, !a.status || a.status === 'all' ? null : a.status, limit + 1])).rows;
    const schedules = [];
    for (const row of rows.slice(0, limit)) {
      try { await authorize(db, live, a.channel, row, true); schedules.push(receipt(a.channel, row)); }
      catch (e: any) { if (![403, 404].includes(e?.status ?? e?.statusCode)) throw e; schedules.push(restrictedReceipt(a.channel, row)); }
    }
    return { schedules, hasMore: rows.length > limit };
  });
}

async function own(db: Db, ctx: McpCtx, channel: ScheduleChannel, id: string) {
  const r = (await db.query(`SELECT * FROM ${table(channel)} WHERE id=$1 AND user_id=$2 AND mcp_token_id=$3 FOR UPDATE`, [id, ctx.userId, ctx.tokenId])).rows[0];
  if (!r) throw notFound('Programación');
  return r;
}
export async function update(ctx: McpCtx, a: { channel: ScheduleChannel; id: string; text?: string; sendAt?: string; timezone?: string }) {
  if (a.text === undefined && !a.sendAt && !a.timezone) throw badRequest('Indica text, sendAt o timezone');
  return tx(async db => {
    const r = await own(db, ctx, a.channel, a.id);
    const live = await currentScheduleContext(db, ctx.userId, ctx.tokenId, scope(a.channel));
    await authorize(db, live, a.channel, r);
    if (r.status !== 'pending') throw conflict('Solo se puede editar una programación pendiente; una fallida requiere una nueva clave');
    if (a.channel === 'whatsapp' && a.text !== undefined && a.text.length > 4000) throw badRequest('Los mensajes de WhatsApp admiten hasta 4000 caracteres');
    const when = parseScheduleTime(a.sendAt ?? iso(r.send_at)!, a.timezone ?? r.timezone);
    const out = (await db.query(`UPDATE ${table(a.channel)} SET body=$2,send_at=$3,timezone=$4,updated_at=now() WHERE id=$1 RETURNING *`,
      [r.id, a.text === undefined ? r.body : textBody(a.text), when.sendAt, when.timezone])).rows[0];
    if (a.channel === 'chaggu') await notifyNativeSchedule(db, out);
    return receipt(a.channel, out);
  });
}
export async function cancel(ctx: McpCtx, a: { channel: ScheduleChannel; id: string }) {
  return tx(async db => {
    const r = await own(db, ctx, a.channel, a.id);
    const live = await currentScheduleContext(db, ctx.userId, ctx.tokenId, scope(a.channel));
    let visible = true;
    try { await authorize(db, live, a.channel, r, true); }
    catch (e: any) { if (![403, 404].includes(e?.status ?? e?.statusCode)) throw e; visible = false; }
    if (r.status === 'cancelled') return visible ? receipt(a.channel, r) : restrictedReceipt(a.channel, r);
    if (!['pending', 'queued', 'failed'].includes(r.status)) throw conflict('La programación ya salió o está enviándose y no se puede cancelar');
    if (r.outbox_id) {
      const outbox = (await db.query('SELECT status FROM wa_outbox WHERE id=$1 FOR UPDATE', [r.outbox_id])).rows[0];
      if (outbox && ['sending', 'sent'].includes(outbox.status)) throw conflict('WhatsApp ya tomó el envío; no se puede cancelar');
    }
    const out = (await db.query(`UPDATE ${table(a.channel)} SET status='cancelled',error=NULL,updated_at=now() WHERE id=$1 RETURNING *`, [r.id])).rows[0];
    if (r.outbox_id) await db.query("UPDATE wa_outbox SET status='failed',body='',error='Programación cancelada' WHERE id=$1 AND status='queued'", [r.outbox_id]);
    if (a.channel === 'chaggu') await notifyNativeSchedule(db, out);
    return visible ? receipt(a.channel, out) : restrictedReceipt(a.channel, out);
  });
}

/** Called from the native scheduler; append and receipt commit together. No external send occurs here. */
export async function deliverMcpChaggu(id: string) {
  return tx(async db => {
    const r = (await db.query('SELECT * FROM scheduled_messages WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!r || r.status !== 'sending') return r;
    await db.query('SAVEPOINT native_schedule_send');
    try {
      const live = await currentScheduleContext(db, r.user_id, r.mcp_token_id, scope('chaggu'));
      await nativeAccess(db, live, r.conversation_id);
      const { message } = await sendMessage(r.user_id, r.conversation_id, { clientMessageId: `sched-${r.id}`, body: r.body, mentions: r.mentions ?? undefined, replyTo: r.reply_to ?? null }, undefined, db);
      const out = (await db.query("UPDATE scheduled_messages SET status='sent',message_id=$2,sent_at=now(),updated_at=now() WHERE id=$1 RETURNING *", [id, message.id])).rows[0];
      await notifyNativeSchedule(db, out);
      return out;
    } catch (e: any) {
      if (!e?.status || e.status < 400 || e.status >= 500) throw e;
      await db.query('ROLLBACK TO SAVEPOINT native_schedule_send');
      const out = (await db.query("UPDATE scheduled_messages SET status='failed',error=$2,updated_at=now() WHERE id=$1 RETURNING *", [id, errorText(e)])).rows[0];
      await notifyNativeSchedule(db, out);
      return out;
    }
  });
}

/** Atomically creates exactly one outbox row. Worker crashes roll back or leave a durable queued receipt. */
export async function sendDueWhatsappSchedules(): Promise<number> {
  let queued = 0;
  for (let i = 0; i < 100; i++) {
    const result = await tx(async db => {
      const r = (await db.query("SELECT * FROM mcp_whatsapp_schedules WHERE status='pending' AND send_at<=now() ORDER BY send_at LIMIT 1 FOR UPDATE SKIP LOCKED")).rows[0];
      if (!r) return null;
      try {
        const live = await currentScheduleContext(db, r.user_id, r.mcp_token_id, scope('whatsapp'));
        await whatsappAccess(db, live, r.account_id, r.jid);
        await db.query(`INSERT INTO wa_outbox(id,account_id,user_id,jid,body,mcp_schedule_id) VALUES($1,$2,$3,$4,$5,$6)`, [randomUUID(), r.account_id, r.user_id, r.jid, r.body, r.id]);
        return true;
      } catch (e: any) {
        if (!e?.status || e.status < 400 || e.status >= 500) throw e;
        await db.query("UPDATE mcp_whatsapp_schedules SET status='failed',error=$2,updated_at=now() WHERE id=$1", [r.id, errorText(e)]);
        return false;
      }
    });
    if (result === null) break;
    if (result) queued++;
  }
  return queued;
}

export { assertScheduledWaSend, deliverScheduledWaOutbox } from './mcp-scheduled-wa-guard.ts';
