/**
 * Conector MCP de Chaggu (1-oct-2026): Claude, Codex y otras IAs leen y escriben en chaggu como la persona.
 *
 * - Transporte: MCP «Streamable HTTP» sin estado en `POST /api/mcp` (JSON-RPC 2.0, respuesta JSON).
 * - Autenticación: `Authorization: Bearer chgmcp_…`, un token personal que se crea en la web (Cuenta › Conector IA)
 *   o con `POST /api/v1/me/mcp-tokens`. Solo se guarda el hash; se revoca en cualquier momento.
 * - Todo corre con el userId del token y pasa por las mismas funciones (y permisos) que usa la app.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BootstrapDTO, CalendarEventDTO, ConversationDTO, IssueDTO, MessageDTO } from '@tiecoms/contracts';
import { IssueFieldsInput, TaskColumnInput } from '@tiecoms/contracts';
import { pool, type Tx } from '../db.ts';
import { conversationAccess } from '../access.ts';
import { ApiError, badRequest, notFound, unauthorized } from '../errors.ts';
import { randomToken, sha256 } from '../security.ts';
import { bootstrap } from './bootstrap.ts';
import { searchAll } from './chat-search.ts';
import { listMessages, markRead, sendMessage } from './messages.ts';
import { getOrCreateDirect } from './workspaces.ts';
import * as mailbox from './mailbox.ts';
import * as issues from './issues.ts';
import * as mcpAttachments from './mcp-attachments.ts';
import { MAX_BASE64_LENGTH } from './mcp-file-input.ts';
import { idempotent, requestHash } from './mcp-idempotency.ts';
import * as cal from './calendar.ts';
import * as mwa from './mcp-wa.ts';
import * as scheduled from './mcp-scheduled.ts';
import * as reading from './reading.ts';
import * as calls from './calls.ts';
import { WA_KINDS, WA_WEBHOOK_EVENTS } from './mcp-consts.ts';
import type { McpCtx } from './mcp-wa.ts';

const PREFIX = 'chgmcp_';
const MAX_TOKENS = 20;
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

// ---------- Tokens personales ----------

/** Permisos que puede tener un token (docs/MCP.md). NULL en la base = todos (tokens anteriores). */
export const SCOPES = ['chats:read', 'chats:write', 'whatsapp:read', 'whatsapp:send', 'whatsapp:draft', 'email', 'tasks:read', 'tasks:write', 'calendar', 'reading'] as const;
export type Scope = typeof SCOPES[number];

export interface TokenOptions { scopes?: string[] | null; expiresAt?: string | null; clientName?: string | null; waAccountIds?: string[] | null }

export async function listTokens(userId: string) {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.token_hint, t.created_at, t.last_used_at, t.client_id, t.scopes, t.expires_at, t.client_name, t.wa_account_ids,
            (SELECT json_agg(json_build_object('tool', x.tool, 'n', x.n)) FROM (SELECT tool, count(*)::int AS n FROM mcp_audit au
               WHERE au.token_id = t.id AND au.ok AND au.created_at > now() - interval '24 hours' GROUP BY tool) x) AS today,
            EXISTS (SELECT 1 FROM mcp_webhooks h WHERE h.token_id = t.id AND h.revoked_at IS NULL) AS webhook
       FROM mcp_tokens t WHERE t.user_id = $1 AND t.revoked_at IS NULL ORDER BY t.created_at DESC`,
    [userId],
  );
  const accounts = (await pool.query('SELECT id, label FROM wa_accounts WHERE user_id = $1 AND removed_at IS NULL', [userId])).rows;
  return {
    tokens: rows.map((r) => ({
      id: r.id, name: r.name, app: r.client_name ?? r.name, tokenHint: r.token_hint, createdAt: iso(r.created_at), lastUsedAt: iso(r.last_used_at), oauth: !!r.client_id,
      scopes: r.scopes ?? [...SCOPES], expiresAt: iso(r.expires_at), expired: !!r.expires_at && new Date(r.expires_at) < new Date(),
      whatsapp: r.wa_account_ids === null ? { mode: 'shared' as const, numbers: [] as string[] } : { mode: 'chosen' as const, numbers: accounts.filter((a) => r.wa_account_ids.includes(a.id)).map((a) => a.label) },
      waAccountIds: r.wa_account_ids, today: r.today ?? [], webhook: r.webhook,
    })),
  };
}

/** Normaliza permisos y números (solo los suyos). */
export async function tokenOptions(userId: string, o: TokenOptions) {
  const scopes = o.scopes == null ? null : [...new Set(o.scopes.filter((x) => (SCOPES as readonly string[]).includes(x)))];
  let wa: string[] | null = null;
  if (o.waAccountIds) {
    const own = (await pool.query('SELECT id FROM wa_accounts WHERE user_id = $1 AND removed_at IS NULL AND id = ANY($2)', [userId, o.waAccountIds])).rows.map((r) => r.id as string);
    wa = own;
  }
  if (o.expiresAt && Number.isNaN(Date.parse(o.expiresAt))) throw badRequest('Vencimiento inválido');
  return { scopes: scopes && scopes.length === SCOPES.length ? null : scopes, waAccountIds: wa, expiresAt: o.expiresAt ?? null, clientName: o.clientName?.trim().slice(0, 60) || null };
}

export async function createToken(userId: string, name: string, o: TokenOptions = {}) {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM mcp_tokens WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  if (rows[0].n >= MAX_TOKENS) throw badRequest(`Máximo ${MAX_TOKENS} tokens activos; revoca alguno`);
  const opt = await tokenOptions(userId, o);
  const token = PREFIX + randomToken(32);
  const ins = await pool.query(
    'INSERT INTO mcp_tokens (user_id, name, token_hash, token_hint, scopes, expires_at, client_name, wa_account_ids) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at',
    [userId, name, sha256(token), `…${token.slice(-4)}`, opt.scopes, opt.expiresAt, opt.clientName ?? name, opt.waAccountIds],
  );
  return { id: ins.rows[0].id, name, token, createdAt: iso(ins.rows[0].created_at), endpoint: '/api/mcp', scopes: opt.scopes ?? [...SCOPES], expiresAt: opt.expiresAt };
}

/** Cambiar permisos, números o vencimiento de un token existente (la persona, desde Tú › Conector para IAs). */
export async function updateToken(userId: string, id: string, o: TokenOptions) {
  const opt = await tokenOptions(userId, o);
  const sets: string[] = []; const vals: unknown[] = [id, userId];
  if (o.scopes !== undefined) { vals.push(opt.scopes); sets.push(`scopes = $${vals.length}`); }
  if (o.waAccountIds !== undefined) { vals.push(opt.waAccountIds); sets.push(`wa_account_ids = $${vals.length}`); }
  if (o.expiresAt !== undefined) { vals.push(opt.expiresAt); sets.push(`expires_at = $${vals.length}`); }
  if (!sets.length) throw badRequest('Nada que cambiar');
  const { rowCount } = await pool.query(`UPDATE mcp_tokens SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, vals);
  if (!rowCount) throw notFound('Token');
  return { ok: true };
}

export async function revokeToken(userId: string, id: string) {
  const { rowCount } = await pool.query('UPDATE mcp_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [id, userId]);
  if (!rowCount) throw notFound('Token');
  return { ok: true };
}

/** 4. Bitácora de la persona: qué hizo cada asistente (sin contenido). */
export async function activity(userId: string, opts: { tokenId?: string; limit?: number } = {}) {
  const { rows } = await pool.query(
    `SELECT au.tool, au.target, au.items, au.ok, au.error, au.created_at, COALESCE(t.client_name, t.name) AS app FROM mcp_audit au JOIN mcp_tokens t ON t.id = au.token_id
      WHERE au.user_id = $1 AND ($2::uuid IS NULL OR au.token_id = $2) ORDER BY au.created_at DESC LIMIT $3`,
    [userId, opts.tokenId ?? null, Math.min(opts.limit ?? 100, 500)],
  );
  return { activity: rows.map((r) => ({ app: r.app, tool: r.tool, target: r.target, items: r.items, ok: r.ok, error: r.error, at: iso(r.created_at) })) };
}

export async function authenticate(header: string | undefined): Promise<McpCtx> {
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token.startsWith(PREFIX) || token.length > 120) throw unauthorized('Token MCP inválido');
  const { rows } = await pool.query(
    `SELECT t.id, t.user_id, t.last_used_at, t.scopes, t.wa_account_ids, t.expires_at, COALESCE(t.client_name, t.name) AS app FROM mcp_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND u.disabled_at IS NULL`,
    [sha256(token)],
  );
  const r = rows[0];
  if (!r) throw unauthorized('Token MCP inválido');
  if (r.expires_at && new Date(r.expires_at) < new Date()) throw unauthorized('Token MCP vencido');
  if (!r.last_used_at || Date.now() - new Date(r.last_used_at).getTime() > 60_000) {
    await pool.query('UPDATE mcp_tokens SET last_used_at = now() WHERE id = $1', [r.id]);
  }
  return { userId: r.user_id, tokenId: r.id, scopes: r.scopes, waAccountIds: r.wa_account_ids, clientName: r.app };
}

const can = (ctx: McpCtx, scope: string) => !ctx.scopes || ctx.scopes.includes(scope);

// ---------- Vista compacta para la IA ----------

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function chatName(b: BootstrapDTO, c: ConversationDTO): string {
  if (c.name) return c.name;
  const others = c.memberIds.filter((id) => id !== b.me.id);
  if (c.kind === 'direct' && !others.length) return 'Mis notas';
  const names = others.map((id) => b.people.find((p) => p.id === id)?.name ?? 'Alguien');
  return names.join(', ') || 'Chat';
}

function chatView(b: BootstrapDTO, c: ConversationDTO) {
  const ws = c.workspaceId ? b.workspaces.find((w) => w.id === c.workspaceId) : null;
  return {
    id: c.id, name: chatName(b, c), kind: c.kind, group: ws?.name ?? null,
    unread: c.unread, lastMessageAt: c.lastMessageAt, preview: c.lastMessagePreview, canPost: c.canPost,
  };
}

function messageView(b: BootstrapDTO, m: MessageDTO) {
  const author = m.authorId === b.me.id ? `${b.me.name} (tú)` : (b.people.find((p) => p.id === m.authorId)?.name ?? 'Alguien');
  let text = m.body;
  if (m.kind === 'system') {
    try { const p = JSON.parse(m.body); text = `[aviso ${p.k ?? 'sistema'}] ${p.subject ?? p.title ?? p.text ?? ''}${p.callId ? ` (call_id ${p.callId}; transcripción con read_call_transcript)` : ''}`.trim(); } catch { text = `[aviso] ${m.body}`; }
  }
  const files = (m.attachments ?? []).map((a: any) => a.name ?? a.kind ?? 'adjunto');
  return {
    id: m.id, seq: m.seq, at: (m as any).createdAt ?? null, author, text,
    ...(files.length ? { attachments: files, attachment_details: m.attachments } : {}), ...(m.replyTo ? { replyTo: m.replyTo } : {}), ...((m as any).deletedAt ? { deleted: true } : {}),
  };
}

/** Acepta el id del chat o su nombre (sin tildes ni mayúsculas). */
function findChat(b: BootstrapDTO, ref: string): ConversationDTO {
  const byId = b.conversations.find((c) => c.id === ref);
  if (byId) return byId;
  const q = fold(ref.trim());
  const named = b.conversations.map((c) => ({ c, n: fold(chatName(b, c)) }));
  const exact = named.filter((x) => x.n === q);
  const hits = exact.length ? exact : named.filter((x) => x.n.includes(q));
  if (hits.length === 1) return hits[0]!.c;
  if (!hits.length) throw notFound('Chat');
  throw badRequest(`Hay ${hits.length} chats con ese nombre; usa el id: ${hits.slice(0, 8).map((x) => `${chatName(b, x.c)} = ${x.c.id}`).join('; ')}`);
}

function findPerson(b: BootstrapDTO, ref: string) {
  const byId = b.people.find((p) => p.id === ref);
  if (byId) return byId;
  const q = fold(ref.trim());
  const exact = b.people.filter((p) => fold(p.name) === q);
  const hits = exact.length ? exact : b.people.filter((p) => fold(p.name).includes(q));
  if (hits.length === 1) return hits[0]!;
  if (!hits.length) throw notFound('Persona');
  throw badRequest(`Hay ${hits.length} personas con ese nombre; usa el id: ${hits.slice(0, 8).map((p) => `${p.name} = ${p.id}`).join('; ')}`);
}


function personId(b: BootstrapDTO, ref: string) { return ref === b.me.id || fold(ref) === fold(b.me.name) ? b.me.id : findPerson(b, ref).id; }

function eventView(b: BootstrapDTO, e: CalendarEventDTO) {
  const name = (id: string) => (id === b.me.id ? `${b.me.name} (tú)` : (b.people.find((p) => p.id === id)?.name ?? 'Alguien'));
  const c = b.conversations.find((x) => x.id === e.conversationId);
  return {
    id: e.id, title: e.title, startsAt: e.startsAt, endsAt: e.endsAt, timezone: e.timezone, chat: c ? chatName(b, c) : null, chatId: e.conversationId,
    organizer: name(e.organizerId), invitees: e.invitees.map((i) => ({ name: name(i.userId), rsvp: i.rsvp })),
    ...(e.description ? { description: e.description } : {}), ...(e.location ? { location: e.location } : {}), ...(e.cancelledAt ? { cancelled: true } : {}),
  };
}

function mailRef(ref: string): { provider: 'google' | 'microsoft'; id: string } {
  const bar = ref.indexOf('|');
  const provider = ref.slice(0, bar);
  if (bar < 1 || (provider !== 'google' && provider !== 'microsoft')) throw badRequest('Usa el valor email de list_emails (proveedor|id)');
  return { provider, id: ref.slice(bar + 1) };
}

function taskView(b: BootstrapDTO, i: IssueDTO) {
  const name = (id: string | null | undefined) => (id ? (id === b.me.id ? `${b.me.name} (tú)` : (b.people.find((p) => p.id === id)?.name ?? 'Alguien')) : null);
  const c = i.conversationId ? b.conversations.find((x) => x.id === i.conversationId) : null;
  return {
    id: i.id, title: i.title, status: i.status, due: i.dueDate, attachments: i.attachments ?? [],
    assignees: (i.assigneeIds ?? (i.ownerId ? [i.ownerId] : [])).map(name), requestedBy: name(i.requestedBy), chat: c ? chatName(b, c) : null, chatId: i.conversationId,
    ...(i.externalId ? { ticket: i.externalId } : {}), ...(i.externalMeta ? { meta: i.externalMeta } : {}), ...(i.fields ? { fields: i.fields } : {}), comments: i.commentCount, updatedAt: i.updatedAt,
  };
}

// ---------- Herramientas ----------

type Tool = { name: string; description: string; scope?: Scope; schema: z.ZodObject<any>; readOnly?: boolean; run: (userId: string, a: any, ctx: McpCtx) => Promise<unknown> };

const idempotencyKey = z.string().min(8).max(120).describe('Llave única por operación: reutiliza exactamente la misma llave y contenido al reintentar');
const scheduledAt = z.string().datetime({ offset: true }).describe('Instante ISO 8601 futuro con offset explícito o Z. Resuelve fechas relativas con la fecha y zona horaria actuales de la persona');
const scheduledTimezone = z.string().min(1).max(100).describe('Zona horaria IANA de la persona, p. ej. America/Bogota. Un offset numérico debe corresponder a esa zona; Z expresa un instante UTC que se convierte a esa zona');
const scheduledStatus = z.enum(['pending', 'sending', 'queued', 'sent', 'failed', 'cancelled', 'all']);
const scheduleFields = { send_at: scheduledAt, timezone: scheduledTimezone, idempotency_key: idempotencyKey };
const scheduleListFields = { status: scheduledStatus.optional().describe('Por defecto pending; all incluye el historial'), limit: z.number().int().min(1).max(100).optional() };
const fileFields = {
  name: z.string().trim().min(1).max(200).describe('Nombre del archivo con extensión'),
  content_type: z.string().trim().min(3).max(100).describe('MIME real: imagen, application/pdf, text/plain, text/csv, text/markdown, application/json, application/zip u application/octet-stream'),
  data_base64: z.string().min(4).max(MAX_BASE64_LENGTH).describe('Bytes en base64 estándar, sin prefijo data:, espacios, URL ni ruta local; máximo 25 MiB decodificados'),
  idempotency_key: idempotencyKey,
};

async function assertMessageAvailable(c: Tx, userId: string, chatId: string, messageId: string) {
  const access = await conversationAccess(c, userId, chatId, 'read');
  const row = (await c.query('SELECT id FROM messages WHERE id = $1 AND conversation_id = $2 AND deleted_at IS NULL AND NOT view_once AND seq > $3', [messageId, chatId, access.historyFromSeq])).rows[0];
  if (!row) throw notFound('Mensaje');
}

const tools: Tool[] = [
  {
    name: 'whoami', readOnly: true,
    description: 'Quién soy en chaggu: nombre, correo, empresas y grupos a los que pertenezco.',
    schema: z.object({}),
    run: async (userId) => {
      const b = await bootstrap(userId);
      return { id: b.me.id, name: b.me.name, email: (b.me as any).email ?? null, organizations: b.organizations.map((o) => o.name), groups: b.workspaces.map((w) => w.name), server_time: new Date().toISOString() };
    },
  },
  {
    name: 'list_chats', readOnly: true, scope: 'chats:read',
    description: 'Lista mis chats (directos, grupos, asuntos), los más recientes primero, con mensajes sin leer y vista previa. Filtra por nombre con query.',
    schema: z.object({
      query: z.string().max(120).optional().describe('Parte del nombre del chat o de la persona'),
      unread_only: z.boolean().optional().describe('Solo chats con mensajes sin leer'),
      limit: z.number().int().min(1).max(200).optional().describe('Máximo de chats (30 por defecto)'),
    }),
    run: async (userId, a) => {
      const b = await bootstrap(userId);
      let list = b.conversations.map((c) => chatView(b, c));
      if (a.query) { const q = fold(a.query); list = list.filter((c) => fold(c.name).includes(q) || (c.group && fold(c.group).includes(q))); }
      if (a.unread_only) list = list.filter((c) => c.unread > 0);
      return { chats: list.slice(0, a.limit ?? 30), total: list.length };
    },
  },
  {
    name: 'read_messages', readOnly: true, scope: 'chats:read',
    description: 'Lee los últimos mensajes de un chat (por id o nombre). attachments conserva los nombres y attachment_details incluye id, nombre, MIME, tamaño y URL de cada adjunto asociado. Para paginar hacia atrás usa before_seq con el seq más viejo recibido.',
    schema: z.object({
      chat: z.string().min(1).max(200).describe('Id del chat o su nombre (p. ej. el nombre de la persona)'),
      limit: z.number().int().min(1).max(100).optional().describe('Cuántos mensajes (30 por defecto)'),
      before_seq: z.number().int().positive().optional(),
      mark_as_read: z.boolean().optional().describe('Marcar el chat como leído después de leerlo (por defecto no)'),
    }),
    run: async (userId, a) => {
      const b = await bootstrap(userId);
      const c = findChat(b, a.chat);
      const page = await listMessages(userId, c.id, a.before_seq, a.limit ?? 30);
      const last = page.messages.at(-1);
      if (a.mark_as_read && last) await markRead(userId, c.id, last.seq);
      return { chat: chatView(b, c), messages: page.messages.map((m) => messageView(b, m)), hasMore: page.hasMore };
    },
  },
  {
    name: 'upload_chat_attachment', scope: 'chats:write',
    description: 'Sube una imagen o archivo (hasta 25 MiB) a un chat existente con mis permisos. Devuelve attachment.id pendiente: inclúyelo en send_message. Reintenta con la misma idempotency_key; no acepta URLs ni rutas locales.',
    schema: z.object({ chat: z.string().min(1).max(200), ...fileFields }),
    run: async (userId, a, ctx) => mcpAttachments.uploadChat(ctx, findChat(await bootstrap(userId), a.chat).id, a),
  },
  {
    name: 'send_message', scope: 'chats:write',
    description: 'Envía texto y/o hasta 10 adjuntos propios previamente subidos con upload_chat_attachment a un chat existente. Con adjuntos, idempotency_key es obligatoria para evitar duplicados. Devuelve messageId y attachments; read_messages permite verificar la asociación. Para escribirle a una persona sin chat usa send_direct_message.',
    schema: z.object({
      chat: z.string().min(1).max(200).describe('Id del chat o su nombre'),
      text: z.string().trim().max(8000).optional(),
      attachment_ids: z.array(z.string().uuid()).min(1).max(10).optional(),
      idempotency_key: idempotencyKey.optional(),
      reply_to: z.string().uuid().optional().describe('Id del mensaje al que se responde'),
    }),
    run: async (userId, a, ctx) => {
      const b = await bootstrap(userId);
      const chat = findChat(b, a.chat);
      const attachmentIds = a.attachment_ids ?? [];
      if (!a.text && !attachmentIds.length) throw badRequest('Incluye texto o al menos un adjunto');
      if (attachmentIds.length && !a.idempotency_key) throw badRequest('Los mensajes con adjuntos requieren idempotency_key');
      const payload = { chatId: chat.id, body: a.text ?? '', attachmentIds, replyTo: a.reply_to ?? null };
      return idempotent(ctx, a.idempotency_key, 'send_message', payload,
        (c) => conversationAccess(c, userId, chat.id, 'post', true),
        async (c) => {
          const clientMessageId = a.idempotency_key ? `mcp-${requestHash('message-client', [ctx.tokenId, a.idempotency_key]).toString('base64url')}` : `mcp-${randomUUID()}`;
          const out = await sendMessage(userId, chat.id, { clientMessageId, body: payload.body, attachmentIds, replyTo: payload.replyTo }, undefined, c);
          await assertMessageAvailable(c, userId, chat.id, out.message.id);
          return { sent: true, chat: chatName(b, chat), chatId: chat.id, messageId: out.message.id,
            attachments: out.message.attachments ?? [], message: messageView(b, out.message) };
        },
        (c, response) => assertMessageAvailable(c, userId, chat.id, response.messageId));
    },
  },
  {
    name: 'send_direct_message', scope: 'chats:write',
    description: 'Envía un mensaje directo a una persona (por id o nombre). Crea el chat directo si no existe.',
    schema: z.object({ person: z.string().min(1).max(200).describe('Id o nombre de la persona'), text: z.string().trim().min(1).max(8000) }),
    run: async (userId, a) => {
      const b = await bootstrap(userId);
      const p = findPerson(b, a.person);
      const conv: any = await getOrCreateDirect(userId, p.id);
      const convId: string = conv?.id ?? conv?.conversation?.id ?? conv?.conversationId;
      if (!convId) throw new ApiError(500, 'internal', 'No pude abrir el chat directo');
      const out = await sendMessage(userId, convId, { clientMessageId: `mcp-${randomUUID()}`, body: a.text });
      return { sent: true, to: p.name, chatId: convId, message: messageView(b, out.message) };
    },
  },
  {
    name: 'schedule_message', scope: 'chats:write',
    description: 'Programa un texto de chaggu para una fecha futura; no lo envía ahora. Usa exactamente uno: chat (id/nombre de un chat existente) o to (id/nombre de una persona, abre el DM). Confirma destinatario, texto y fecha/hora/zona exactas. Devuelve recibo con id y estado pending para consultar, editar o cancelar. Reutiliza la misma idempotency_key al reintentar.',
    schema: z.object({
      chat: z.string().trim().min(1).max(200).optional().describe('Chat existente; excluyente con to'),
      to: z.string().trim().min(1).max(200).optional().describe('Persona para mensaje directo; excluyente con chat'),
      text: z.string().trim().min(1).max(8000), ...scheduleFields,
      reply_to: z.string().uuid().optional(),
    }),
    run: async (userId, a, ctx) => {
      if (!!a.chat === !!a.to) throw badRequest('Indica exactamente uno: chat o to');
      const b = await bootstrap(userId);
      let conversationId: string;
      if (a.chat) conversationId = findChat(b, a.chat).id;
      else {
        const person = findPerson(b, a.to);
        const conv: any = await getOrCreateDirect(userId, person.id);
        conversationId = conv?.id ?? conv?.conversation?.id ?? conv?.conversationId;
        if (!conversationId) throw new ApiError(500, 'internal', 'No pude abrir el chat directo');
      }
      return scheduled.createChaggu(ctx, { conversationId, text: a.text, sendAt: a.send_at, timezone: a.timezone, idempotencyKey: a.idempotency_key, replyTo: a.reply_to });
    },
  },
  {
    name: 'list_scheduled_messages', readOnly: true, scope: 'chats:read',
    description: 'Consulta los textos de chaggu programados por este token, su fecha/zona y estado real; por defecto pendientes. status=all incluye enviados, fallidos y cancelados. Un recibo pending o sending no prueba que el mensaje se haya enviado.',
    schema: z.object(scheduleListFields),
    run: async (_u, a, ctx) => scheduled.list(ctx, { channel: 'chaggu', status: a.status ?? 'pending', limit: a.limit }),
  },
  {
    name: 'update_scheduled_message', scope: 'chats:write',
    description: 'Edita texto o fecha de un mensaje de chaggu pendiente de este token. Para cambiar la fecha, indica send_at y timezone juntos; timezone sola cambia la zona de presentación del mismo instante. Confirma el texto y horario resultantes; no envía el mensaje ahora.',
    schema: z.object({ id: z.string().uuid(), text: z.string().trim().min(1).max(8000).optional(), send_at: scheduledAt.optional(), timezone: scheduledTimezone.optional() }),
    run: async (_u, a, ctx) => {
      if (a.send_at && !a.timezone) throw badRequest('Al cambiar send_at indica también timezone');
      return scheduled.update(ctx, { channel: 'chaggu', id: a.id, text: a.text, sendAt: a.send_at, timezone: a.timezone });
    },
  },
  {
    name: 'cancel_scheduled_message', scope: 'chats:write',
    description: 'Cancela por id un mensaje de chaggu pendiente de este token; conserva el recibo cancelled. Un envío ya iniciado o enviado no puede cancelarse.',
    schema: z.object({ id: z.string().uuid() }),
    run: async (_u, a, ctx) => scheduled.cancel(ctx, { channel: 'chaggu', id: a.id }),
  },
  {
    name: 'search_messages', readOnly: true, scope: 'chats:read',
    description: 'Busca en todos mis chats (texto, adjuntos, notas de voz, correos y WhatsApps compartidos). Admite from:Nombre.',
    schema: z.object({ query: z.string().trim().min(2).max(120), limit: z.number().int().min(1).max(50).optional() }),
    run: async (userId, a) => {
      const [b, r] = await Promise.all([bootstrap(userId), searchAll(userId, { q: a.query, limit: a.limit ?? 20 })]);
      return {
        results: r.results.map((x) => {
          const c = b.conversations.find((cc) => cc.id === x.message.conversationId);
          return { chat: c ? chatName(b, c) : null, chatId: x.message.conversationId, snippet: x.snippet, message: messageView(b, x.message) };
        }),
        hasMore: r.hasMore,
      };
    },
  },
  {
    name: 'list_calls', readOnly: true, scope: 'chats:read',
    description: 'Mis llamadas de chaggu (las más recientes primero): chat, quién participó, duración y si tienen transcripción o resumen. Filtra por chat (id o nombre). Para leerla usa read_call_transcript con su call_id.',
    schema: z.object({
      chat: z.string().min(1).max(200).optional().describe('Id o nombre del chat (p. ej. la persona)'),
      limit: z.number().int().min(1).max(50).optional().describe('Cuántas llamadas (20 por defecto)'),
    }),
    run: async (userId, a) => {
      const b = await bootstrap(userId);
      const chatId = a.chat ? findChat(b, a.chat).id : null;
      const out: unknown[] = [];
      let before: string | undefined;
      // El historial es global: se pagina hasta juntar las del chat pedido (máximo 10 páginas).
      for (let i = 0; i < 10 && out.length < (a.limit ?? 20); i++) {
        const page = await calls.history(userId, { before, limit: 50 });
        for (const h of page.calls) {
          if (chatId && h.call.conversationId !== chatId) continue;
          const c = b.conversations.find((x) => x.id === h.call.conversationId);
          const who = (id: string) => (id === b.me.id ? `${b.me.name} (tú)` : (b.people.find((p) => p.id === id)?.name ?? h.call.names?.[id] ?? 'Alguien'));
          out.push({
            call_id: h.call.id, chat: c ? chatName(b, c) : null, chatId: h.call.conversationId, kind: h.call.kind, startedAt: h.call.startedAt, endedAt: h.call.endedAt,
            durationSec: h.durationSec, participants: h.participantIds.map(who), hasTranscript: h.call.hasTranscript, hasSummary: h.hasSummary, ...(h.missed ? { missed: true } : {}),
          });
          if (out.length >= (a.limit ?? 20)) break;
        }
        if (!page.hasMore || !page.calls.length) break;
        before = page.calls.at(-1)!.call.startedAt;
      }
      return { calls: out };
    },
  },
  {
    name: 'read_call_transcript', readOnly: true, scope: 'chats:read',
    description: 'Lee la transcripción (frases con quién habló y minuto) y el resumen de una llamada de chaggu. Usa call_id (de list_calls o del aviso call.transcript en read_messages) o chat para la última llamada con transcripción de ese chat.',
    schema: z.object({
      call_id: z.string().uuid().optional(),
      chat: z.string().min(1).max(200).optional().describe('Id o nombre del chat: toma su última llamada con transcripción'),
    }),
    run: async (userId, a) => {
      let id = a.call_id as string | undefined;
      const b = await bootstrap(userId);
      if (!id) {
        if (!a.chat) throw badRequest('Indica call_id o chat');
        const chatId = findChat(b, a.chat).id;
        const { rows } = await pool.query(
          `SELECT c.id FROM calls c WHERE c.conversation_id = $1 AND EXISTS (SELECT 1 FROM call_transcript_segments s WHERE s.call_id = c.id)
            ORDER BY c.started_at DESC LIMIT 1`, [chatId]);
        if (!rows[0]) throw notFound('Llamada con transcripción');
        id = rows[0].id as string;
      }
      const t = await calls.transcript(userId, id!);
      const c = b.conversations.find((x) => x.id === t.call.conversationId);
      const stamp = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
      return {
        call_id: t.call.id, chat: c ? chatName(b, c) : null, chatId: t.call.conversationId, startedAt: t.call.startedAt, endedAt: t.call.endedAt,
        summary: t.summary, segments: t.segments.length,
        transcript: t.segments.map((s) => `[${stamp(s.startMs)}] ${s.speakerName ?? '?'}: ${s.text}`).join('\n'),
      };
    },
  },
  {
    name: 'unread_summary', readOnly: true, scope: 'chats:read',
    description: 'Resumen de lo pendiente: chats con mensajes sin leer y esos mensajes (hasta 10 por chat). No los marca como leídos.',
    schema: z.object({ max_chats: z.number().int().min(1).max(30).optional() }),
    run: async (userId, a) => {
      const b = await bootstrap(userId);
      const pending = b.conversations.filter((c) => c.unread > 0).slice(0, a.max_chats ?? 10);
      const chats = await Promise.all(pending.map(async (c) => {
        const page = await listMessages(userId, c.id, undefined, Math.min(Math.max(c.unread, 1), 10));
        return { ...chatView(b, c), messages: page.messages.filter((m) => m.seq > c.lastReadSeq).map((m) => messageView(b, m)) };
      }));
      return { chats, totalUnreadChats: b.conversations.filter((c) => c.unread > 0).length };
    },
  },
  {
    name: 'mark_read', scope: 'chats:write',
    description: 'Marca un chat como leído hasta el último mensaje.',
    schema: z.object({ chat: z.string().min(1).max(200) }),
    run: async (userId, a) => {
      const b = await bootstrap(userId);
      const c = findChat(b, a.chat);
      await markRead(userId, c.id, c.lastMessageSeq);
      return { ok: true, chat: chatName(b, c) };
    },
  },
  {
    name: 'list_people', readOnly: true, scope: 'chats:read',
    description: 'Personas a las que puedo escribir (comparten grupo o empresa conmigo), con empresa y cargo.',
    schema: z.object({ query: z.string().max(120).optional(), limit: z.number().int().min(1).max(200).optional() }),
    run: async (userId, a) => {
      const b = await bootstrap(userId);
      let people = b.people.filter((p) => p.id !== b.me.id).map((p) => ({
        id: p.id, name: p.name, kind: p.kind, title: p.title,
        company: b.organizations.find((o) => o.id === p.orgId)?.name ?? p.company ?? null,
      }));
      if (a.query) { const q = fold(a.query); people = people.filter((p) => fold(`${p.name} ${p.company ?? ''} ${p.title ?? ''}`).includes(q)); }
      return { people: people.slice(0, a.limit ?? 50), total: people.length };
    },
  },

  // ---------- WhatsApp: doble llave (números o chats compartidos con esta integración), ver mcp-wa.ts ----------
  {
    name: 'list_whatsapp_numbers', readOnly: true, scope: 'whatsapp:read',
    description: 'Mis números de WhatsApp que esta integración puede usar, y si puede enviar por cada uno.',
    schema: z.object({}),
    run: async (_u, _a, ctx) => {
      const acc = await mwa.allowedAccounts(ctx);
      return { numbers: acc.map((x) => ({ account: x.id, label: x.label, kind: x.kind, connected: x.status === 'connected', canSend: x.send_enabled && x.status === 'connected' })),
        ...(acc.length ? {} : { note: 'Ningún número está compartido con esta integración. La persona lo activa en chaggu › WhatsApp («Compartir con integraciones») o en Tú › Conector para IAs.' }) };
    },
  },
  {
    name: 'list_whatsapp_chats', readOnly: true, scope: 'whatsapp:read',
    description: 'Chats de WhatsApp compartidos con esta integración, los más recientes primero. Pagina con cursor; since = solo con actividad desde esa fecha. Trae teléfono (1 a 1), quién habló de último y si se puede responder. La vista previa solo con include_preview.',
    schema: z.object({
      query: z.string().max(120).optional().describe('Parte del nombre o del número'),
      unread_only: z.boolean().optional(),
      since: z.string().datetime({ offset: true }).optional(),
      groups: z.boolean().optional().describe('true = solo grupos; false = solo 1 a 1'),
      include_preview: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      cursor: z.string().max(500).optional(),
    }),
    run: async (_u, a, ctx) => {
      const r = await mwa.listChats(ctx, { query: a.query, unreadOnly: a.unread_only, since: a.since, groups: a.groups, includePreview: a.include_preview, limit: a.limit ?? 50, cursor: a.cursor });
      if (r.chats.length || a.cursor) return r;
      const shared = await mwa.allowedAccounts(ctx);
      return shared.length ? r : { ...r, note: 'Ningún número de WhatsApp está compartido con esta integración (o no hay WhatsApp conectado). La persona lo activa en chaggu › WhatsApp («Compartir con integraciones») o en Tú › Conector para IAs.' };
    },
  },
  {
    name: 'read_whatsapp', readOnly: true, scope: 'whatsapp:read',
    description: 'Mensajes de un contacto o grupo de WhatsApp (valor chat o nombre), reuniendo sus aliases PN/LID autorizados en la misma cuenta sin duplicar IDs. Cada mensaje trae fromMe, kind, teléfono de quien escribe y transcripción. since = solo lo nuevo (ascendente); before = hacia atrás. Para paginar sin perder empates, envía cursor: nextCursor sin since/before. nextSince/nextBefore conservan fechas ISO para clientes anteriores. No marca como leído.',
    schema: z.object({
      chat: z.string().min(1).max(300),
      since: z.string().min(1).max(4096).optional().describe('Fecha ISO inicial o nextSince; se recomienda cursor para continuar'),
      before: z.string().min(1).max(4096).optional().describe('Fecha ISO inicial o nextBefore; se recomienda cursor para continuar'),
      cursor: z.string().min(1).max(4096).optional().describe('nextCursor opaco de read_whatsapp, sin since/before; conserva filtros y empates'),
      kinds: z.array(z.enum(WA_KINDS)).max(10).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    run: async (_u, a, ctx) => mwa.readChat(ctx, a.chat, { limit: a.limit ?? 50, since: a.since, before: a.before, cursor: a.cursor, kinds: a.kinds }),
  },
  {
    name: 'find_whatsapp_chat', readOnly: true, scope: 'whatsapp:read',
    description: 'Busca el chat de un número de teléfono (aunque no esté guardado en la libreta) y devuelve el nombre con que se presenta.',
    schema: z.object({ phone: z.string().min(6).max(30) }),
    run: async (_u, a, ctx) => mwa.findByPhone(ctx, a.phone),
  },
  {
    name: 'get_whatsapp_group', readOnly: true, scope: 'whatsapp:read',
    description: 'Asunto, descripción y participantes de un grupo de WhatsApp (nombre, teléfono si se conoce, admin).',
    schema: z.object({ chat: z.string().min(1).max(300) }),
    run: async (_u, a, ctx) => mwa.groupInfo(ctx, a.chat),
  },
  {
    name: 'search_whatsapp', readOnly: true, scope: 'whatsapp:read',
    description: 'Busca texto dentro de mis WhatsApp compartidos (incluye notas de voz transcritas). Devuelve fragmento, chat y fecha.',
    schema: z.object({ query: z.string().trim().min(2).max(120), since: z.string().datetime({ offset: true }).optional(), limit: z.number().int().min(1).max(50).optional() }),
    run: async (_u, a, ctx) => mwa.search(ctx, { query: a.query, since: a.since, limit: a.limit ?? 20 }),
  },
  {
    name: 'send_whatsapp', scope: 'whatsapp:send',
    description: 'Envía un WhatsApp desde mi número a un chat (chat) o a un número nuevo (phone, con indicativo). Usa idempotency_key para que un reintento no duplique. Antes muestra a la persona destinatario, número y texto exacto y espera su sí. Errores con código: not_connected, send_disabled, forbidden_scope, integrations_disabled, invalid_phone.',
    schema: z.object({
      chat: z.string().min(1).max(300).optional(), phone: z.string().min(6).max(30).optional(), account: z.string().max(100).optional().describe('Número a usar si tengo varios'),
      text: z.string().trim().min(1).max(4000), idempotency_key: z.string().min(8).max(120).optional(),
    }),
    run: async (_u, a, ctx) => mwa.send(ctx, { chat: a.chat, phone: a.phone, account: a.account, text: a.text, idempotencyKey: a.idempotency_key }),
  },
  {
    name: 'schedule_whatsapp', scope: 'whatsapp:send',
    description: 'Programa un WhatsApp de texto para una fecha futura; no lo envía ahora. Usa exactamente chat o phone (con indicativo), y account si hay varios números. Confirma destinatario, número emisor, texto y fecha/hora/zona exactas. Conserva los permisos del token y del chat al ejecutar. Devuelve recibo pending; queued significa en cola, solo sent confirma el envío.',
    schema: z.object({
      chat: z.string().trim().min(1).max(300).optional().describe('Chat de WhatsApp; excluyente con phone'),
      phone: z.string().trim().min(6).max(30).optional().describe('Teléfono con indicativo; excluyente con chat'),
      account: z.string().max(100).optional().describe('Id o nombre del número emisor autorizado'),
      text: z.string().trim().min(1).max(4000), ...scheduleFields,
    }),
    run: async (_u, a, ctx) => {
      if (!!a.chat === !!a.phone) throw badRequest('Indica exactamente uno: chat o phone');
      return scheduled.createWhatsapp(ctx, { chat: a.chat, phone: a.phone, account: a.account, text: a.text, sendAt: a.send_at, timezone: a.timezone, idempotencyKey: a.idempotency_key });
    },
  },
  {
    name: 'list_scheduled_whatsapp', readOnly: true, scope: 'whatsapp:send',
    description: 'Consulta los WhatsApps programados por este token y todavía autorizados, con fecha/zona y estado real. Por defecto pending; status=all incluye historial. pending, sending y queued no son sent. Requiere whatsapp:send para no exponer textos programados con un permiso de solo lectura.',
    schema: z.object(scheduleListFields),
    run: async (_u, a, ctx) => scheduled.list(ctx, { channel: 'whatsapp', status: a.status ?? 'pending', limit: a.limit }),
  },
  {
    name: 'update_scheduled_whatsapp', scope: 'whatsapp:send',
    description: 'Edita texto o fecha de un WhatsApp pendiente de este token. Para cambiar fecha indica send_at y timezone juntos; timezone sola cambia la zona de presentación del mismo instante. Confirma texto y horario resultantes. No cambia destinatario/cuenta ni permite editar un envío ya en cola.',
    schema: z.object({ id: z.string().uuid(), text: z.string().trim().min(1).max(4000).optional(), send_at: scheduledAt.optional(), timezone: scheduledTimezone.optional() }),
    run: async (_u, a, ctx) => {
      if (a.send_at && !a.timezone) throw badRequest('Al cambiar send_at indica también timezone');
      return scheduled.update(ctx, { channel: 'whatsapp', id: a.id, text: a.text, sendAt: a.send_at, timezone: a.timezone });
    },
  },
  {
    name: 'cancel_scheduled_whatsapp', scope: 'whatsapp:send',
    description: 'Cancela por id un WhatsApp pendiente, fallido o en cola de este token y devuelve cancelled. Si el puente ya empezó a enviarlo (sending) o salió (sent), no puede cancelarse.',
    schema: z.object({ id: z.string().uuid() }),
    run: async (_u, a, ctx) => scheduled.cancel(ctx, { channel: 'whatsapp', id: a.id }),
  },
  {
    name: 'create_whatsapp_draft', scope: 'whatsapp:draft',
    description: 'Deja un WhatsApp listo para que la persona lo apruebe en chaggu (Enviar, Editar o Descartar), a un chat o a un número nuevo. Preferido cuando son varios mensajes. external_ref vuelve en el aviso whatsapp.draft.sent/discarded.',
    schema: z.object({
      chat: z.string().min(1).max(300).optional(), phone: z.string().min(6).max(30).optional(), account: z.string().max(100).optional(),
      text: z.string().trim().min(1).max(4000), source: z.string().max(60).optional(), external_ref: z.string().max(200).optional(),
    }),
    run: async (_u, a, ctx) => mwa.createDraft(ctx, { chat: a.chat, phone: a.phone, account: a.account, text: a.text, source: a.source, externalRef: a.external_ref }),
  },
  {
    name: 'list_whatsapp_drafts', readOnly: true, scope: 'whatsapp:draft',
    description: 'Borradores que creó esta integración y en qué quedaron (pending, sent, discarded, failed).',
    schema: z.object({ status: z.enum(['pending', 'sent', 'discarded', 'failed']).optional() }),
    run: async (userId, a, ctx) => ({ drafts: await mwa.listDrafts(userId, { tokenId: ctx.tokenId, status: a.status }) }),
  },
  {
    name: 'delete_whatsapp_draft', scope: 'whatsapp:draft',
    description: 'Retira un borrador pendiente que creó esta integración.',
    schema: z.object({ id: z.string().uuid() }),
    run: async (userId, a, ctx) => mwa.discardDraft(userId, a.id, ctx.tokenId),
  },
  {
    name: 'set_whatsapp_webhook', scope: 'whatsapp:read',
    description: 'Avisos al instante (POST firmado) de mensajes nuevos, enviados, transcritos y borradores, SOLO de los chats listados. Reemplaza el webhook anterior de este token. Devuelve el secreto una sola vez.',
    schema: z.object({ url: z.string().url().max(2000), chats: z.array(z.string().min(1).max(300)).max(500), events: z.array(z.enum(WA_WEBHOOK_EVENTS)).optional() }),
    run: async (_u, a, ctx) => mwa.setWebhook(ctx, a),
  },
  {
    name: 'get_whatsapp_webhook', readOnly: true, scope: 'whatsapp:read',
    description: 'El webhook de WhatsApp de este token (URL, eventos y chats), sin el secreto.',
    schema: z.object({}),
    run: async (_u, _a, ctx) => mwa.getWebhook(ctx),
  },
  {
    name: 'delete_whatsapp_webhook', scope: 'whatsapp:read',
    description: 'Apaga el webhook de WhatsApp de este token.',
    schema: z.object({}),
    run: async (_u, _a, ctx) => mwa.deleteWebhook(ctx),
  },
  // ---------- Lista de lectura (docs/LECTURA.md) ----------
  {
    name: 'list_reading', readOnly: true, scope: 'reading',
    description: 'Mi lista de lectura: lo que guardé en «Ver después» de chaggu y los enlaces (artículos, videos, tweets) que llegan a los chats de WhatsApp marcados con «📚», p. ej. lo que me manda mi papá. Por defecto, lo pendiente.',
    schema: z.object({ state: z.enum(['pending', 'seen', 'all']).optional(), source: z.enum(['whatsapp', 'chaggu', 'all']).optional(), limit: z.number().int().min(1).max(100).optional() }),
    run: async (userId, a) => reading.list(userId, { state: a.state ?? 'pending', source: a.source ?? 'all', limit: a.limit ?? 50 }),
  },
  {
    name: 'summarize_reading', scope: 'reading',
    description: 'Resume lo pendiente por leer (o los ids dados): cada enlace por su contenido real (artículo completo, subtítulos de YouTube, texto completo de X) y un resumen general por temas. Por defecto los marca como leídos (mark_read=false para no marcarlos). Hasta 15 por llamada; remaining dice cuántos quedan. Muestra el digest a la persona tal cual.',
    schema: z.object({ ids: z.array(z.string().regex(/^[rl]:[0-9a-f-]{36}$/)).max(15).optional(), limit: z.number().int().min(1).max(15).optional(), mark_read: z.boolean().optional(), source: z.enum(['whatsapp', 'chaggu', 'all']).optional() }),
    run: async (userId, a) => reading.digest(userId, { ids: a.ids, limit: a.limit, markRead: a.mark_read, source: a.source }),
  },
  {
    name: 'mark_reading', scope: 'reading',
    description: 'Marca como leídos (read=true) o pendientes (read=false) elementos de la lista de lectura.',
    schema: z.object({ ids: z.array(z.string().regex(/^[rl]:[0-9a-f-]{36}$/)).min(1).max(200), read: z.boolean() }),
    run: async (userId, a) => reading.setSeen(userId, a.ids, a.read),
  },
  {
    name: 'add_to_reading', scope: 'reading',
    description: 'Agrega un enlace a mi lista de lectura.',
    schema: z.object({ url: z.string().min(8).max(2000) }),
    run: async (userId, a) => reading.addManual(userId, a.url),
  },
  {
    name: 'set_whatsapp_reading', scope: 'reading',
    description: 'Enciende o apaga «📚 Enlaces a Ver después» en un chat de WhatsApp (valor chat o nombre): sus enlaces entran solos a la lista de lectura. Al encender trae los de los últimos 30 días.',
    schema: z.object({ chat: z.string().min(1).max(300), on: z.boolean() }),
    run: async (userId, a, ctx) => {
      const c = await mwa.findChat(ctx, a.chat);
      await reading.setWaReading(userId, c.account_id, c.jid, a.on);
      return { ok: true, chat: c.name, readingList: a.on, ...(a.on ? { pending: (await reading.list(userId, { state: 'pending', source: 'whatsapp', limit: 100 })).pendingWhatsApp } : {}) };
    },
  },
  // ---------- Correo (Gmail u Outlook conectado por la persona) ----------
  {
    name: 'list_emails', readOnly: true, scope: 'email',
    description: 'Busca o lista correos de MI buzón conectado (Gmail u Outlook). query admite texto libre; from filtra por remitente.',
    schema: z.object({
      query: z.string().trim().max(200).optional(),
      from: z.string().trim().max(200).optional(),
      unread_only: z.boolean().optional(),
      box: z.enum(['inbox', 'sent', 'all']).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    run: async (userId, a) => {
      const active = (await mailbox.listConnections(userId)).filter((c) => c.status === 'active');
      if (!active.length) return { emails: [], note: 'No tienes correo conectado en chaggu (Correo › Conectar Gmail u Outlook).' };
      const lists = await Promise.all(active.map((c) => mailbox.listMail(userId, {
        provider: c.provider, box: a.box ?? 'inbox', ...(a.query ? { q: a.query } : {}), ...(a.from ? { from: a.from } : {}), ...(a.unread_only ? { unread: 'true' as const } : {}),
      }).catch(() => ({ items: [] as any[] }))));
      const emails = lists.flatMap((l) => l.items).sort((x, y) => String(y.date ?? '').localeCompare(String(x.date ?? ''))).slice(0, a.limit ?? 20)
        .map((m) => ({ email: `${m.provider}|${m.id}`, from: m.from, to: m.to, subject: m.subject, snippet: m.snippet, date: m.date, unread: m.unread }));
      return { emails };
    },
  },
  {
    name: 'read_email', readOnly: true, scope: 'email',
    description: 'Lee un correo completo de mi buzón (valor email de list_emails).',
    schema: z.object({ email: z.string().min(3).max(500) }),
    run: async (userId, a) => {
      const { provider, id } = mailRef(a.email);
      const m = await mailbox.getMail(userId, provider, id);
      return { email: a.email, from: m.from, to: m.to, cc: m.cc, subject: m.subject, date: m.date, body: m.body.slice(0, 20000), attachments: m.attachments.map((x) => x.name) };
    },
  },
  {
    name: 'reply_email', scope: 'email',
    description: 'Responde un correo de mi buzón en el mismo hilo (Re:), desde mi cuenta, a quien lo escribió. Confirma antes con la persona.',
    schema: z.object({ email: z.string().min(3).max(500), text: z.string().trim().min(1).max(20000), cc: z.array(z.string().email()).max(20).optional() }),
    run: async (userId, a) => {
      const { provider, id } = mailRef(a.email);
      const r = await mailbox.replyLive(userId, provider, id, { body: a.text, ...(a.cc ? { cc: a.cc } : {}) });
      return { sent: true, to: r.to };
    },
  },
  // ---------- Tareas y tickets (asuntos; los de la mesa de ayuda llegan por integración) ----------
  {
    name: 'list_tasks', readOnly: true, scope: 'tasks:read',
    description: 'Tareas y tickets que puedo ver. mine=true: solo los asignados a mí. chat: solo las de ese chat o grupo. Incluye los tickets de la mesa de ayuda (con cliente y correo en meta) y los campos dinámicos de cada tarea (fields, que en la app son columnas). field + field_value filtran por un campo.',
    schema: z.object({
      mine: z.boolean().optional(), include_closed: z.boolean().optional(), query: z.string().max(120).optional(), limit: z.number().int().min(1).max(100).optional(),
      chat: z.string().max(200).optional().describe('Id o nombre del chat o grupo'),
      field: z.string().max(60).optional().describe('Nombre de un campo dinámico (p. ej. «Resultado»)'),
      field_value: z.string().max(200).optional().describe('Valor que debe contener ese campo'),
    }),
    run: async (userId, a) => {
      const b = await bootstrap(userId);
      const conversationId = a.chat ? findChat(b, a.chat).id : undefined;
      const list = await issues.listIssues(userId, { mine: a.mine ?? false, open: !a.include_closed, ...(conversationId ? { conversationId } : {}) });
      let out = list.map((i) => taskView(b, i));
      if (a.query) { const q = fold(a.query); out = out.filter((t) => fold(`${t.title} ${JSON.stringify(t.meta ?? {})} ${JSON.stringify(t.fields ?? {})} ${t.ticket ?? ''}`).includes(q)); }
      if (a.field) {
        const k = fold(a.field); const v = a.field_value ? fold(a.field_value) : null;
        out = out.filter((t) => Object.entries(t.fields ?? {}).some(([fk, fv]) => fold(fk) === k && (v === null || fold(String(fv)).includes(v))));
      }
      const defined = conversationId ? (await issues.getTaskColumns(userId, conversationId)).columns : [];
      const columns = [...new Set([...defined.map((c) => c.name), ...out.flatMap((t) => Object.keys(t.fields ?? {}))])];
      return { tasks: out.slice(0, a.limit ?? 30), total: out.length, ...(columns.length ? { columns } : {}), ...(defined.length ? { columnTypes: defined } : {}) };
    },
  },
  {
    name: 'get_task', readOnly: true, scope: 'tasks:read',
    description: 'Detalle de una tarea o ticket: estado, responsables, datos del cliente, adjuntos (id, nombre, tipo, tamaño y URL) y comentarios.',
    schema: z.object({ id: z.string().uuid() }),
    run: async (userId, a) => {
      const [b, r] = await Promise.all([bootstrap(userId), issues.getIssue(userId, a.id)]);
      const name = (id: string | null) => (id ? (b.people.find((p) => p.id === id)?.name ?? (id === b.me.id ? b.me.name : 'Alguien')) : null);
      return {
        task: taskView(b, r.issue),
        activity: r.events.slice(-40).map((e) => ({ at: e.createdAt, by: name(e.actorId), kind: e.kind, ...(e.kind === 'comment' ? { text: (e.payload as any)?.body } : { change: e.payload }) })),
      };
    },
  },
  {
    name: 'upload_task_attachment', scope: 'tasks:write',
    description: 'Sube y adjunta una imagen o archivo (hasta 25 MiB) a una tarea existente, conservando sus archivos actuales (máximo 20). Usa mis permisos, valida el tipo real y evita duplicados con idempotency_key. get_task verifica los adjuntos.',
    schema: z.object({ id: z.string().uuid().describe('Id de la tarea'), ...fileFields }),
    run: async (_userId, a, ctx) => mcpAttachments.uploadTask(ctx, a.id, a),
  },
  {
    name: 'comment_task', scope: 'tasks:write',
    description: 'Comenta una tarea o ticket. En los tickets de la mesa de ayuda el comentario también vuelve al sistema del cliente. Usa idempotency_key para reintentar sin duplicar el comentario.',
    schema: z.object({ id: z.string().uuid(), text: z.string().trim().min(1).max(4000), idempotency_key: idempotencyKey.optional() }),
    run: async (userId, a, ctx) => idempotent(ctx, a.idempotency_key, 'comment_task', { id: a.id, text: a.text },
      (c) => mcpAttachments.taskWriteAccess(c, userId, a.id),
      async (c) => { const task = await issues.commentIssue(userId, a.id, a.text, {}, c); return { ok: true, taskId: task.id, status: task.status, comments: task.commentCount }; }),
  },
  {
    name: 'update_task', scope: 'tasks:write',
    description: 'Cambia un ticket o tarea (idempotency_key evita repetir el cambio): estado (open, in_progress, waiting, done, cancelled), responsables (por nombre o id; reemplaza la lista), fecha límite, título o campos dinámicos (fields: se mezclan con los que ya tiene; null borra un campo). Confirma antes con la persona.',
    schema: z.object({
      id: z.string().uuid(), idempotency_key: idempotencyKey.optional(),
      status: z.enum(['open', 'in_progress', 'waiting', 'done', 'cancelled']).optional(),
      assignees: z.array(z.string().min(1).max(200)).max(20).optional().describe('Responsables (nombres o ids). [] = sin responsable'),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe('AAAA-MM-DD o null para quitarla'),
      title: z.string().trim().min(2).max(200).optional(),
      fields: IssueFieldsInput.optional().describe('Campos dinámicos { "Servicios": "…", "Prioridad": 2, "Bloqueado": true }; null borra'),
    }),
    run: async (userId, a, ctx) => {
      const b = await bootstrap(userId);
      const input: Record<string, unknown> = {};
      if (a.status) input.status = a.status;
      if (a.title) input.title = a.title;
      if (a.fields) input.fields = a.fields;
      if (a.due_date !== undefined) input.dueDate = a.due_date;
      if (a.assignees) input.assigneeIds = a.assignees.map((x: string) => personId(b, x));
      if (!Object.keys(input).length) throw badRequest('Nada que cambiar');
      return idempotent(ctx, a.idempotency_key, 'update_task', { id: a.id, input },
        (c) => mcpAttachments.taskWriteAccess(c, userId, a.id),
        async (c) => ({ task: taskView(b, await issues.updateIssue(userId, a.id, input as any, c)) }),
        async (c, response) => { response.task.attachments = (await issues.loadVisible(c, userId, a.id)).attachments ?? []; });
    },
  },
  {
    name: 'get_task_columns', readOnly: true, scope: 'tasks:read',
    description: 'Columnas de las tareas de un grupo: nombre, tipo (text, select = lista desplegable, number, checkbox) y las opciones de cada lista (p. ej. Tipo: Bug, Funcionalidad nueva, Mejora). Úsalo antes de crear o cambiar tareas con fields para usar las opciones válidas.',
    schema: z.object({ chat: z.string().min(1).max(200).describe('Id o nombre del grupo') }),
    run: async (userId, a) => issues.getTaskColumns(userId, findChat(await bootstrap(userId), a.chat).id),
  },
  {
    name: 'set_task_columns', scope: 'tasks:write',
    description: 'Define las columnas de las tareas de un grupo (reemplaza la lista completa; trae primero las actuales con get_task_columns). type: text, select (lista desplegable con options), number o checkbox. Solo quien administra el grupo. Confirma antes con la persona.',
    schema: z.object({ chat: z.string().min(1).max(200), columns: z.array(TaskColumnInput).max(30) }),
    run: async (userId, a) => issues.setTaskColumns(userId, findChat(await bootstrap(userId), a.chat).id, { columns: a.columns }),
  },
  {
    name: 'create_task', scope: 'tasks:write',
    description: 'Crea una tarea o ticket en un chat de chaggu (por id o nombre), con responsables, fecha límite, descripción (primer comentario) y campos dinámicos opcionales (fields: columnas propias como «Servicios», «Motivo», «Ambiente»). Confirma antes con la persona.',
    schema: z.object({
      chat: z.string().min(1).max(200),
      title: z.string().trim().min(2).max(200),
      assignees: z.array(z.string().min(1).max(200)).max(20).optional(),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      description: z.string().trim().min(1).max(4000).optional(),
      fields: IssueFieldsInput.optional().describe('Campos dinámicos { "Tipo": "Bug", "Servicios": "…", "Prioridad": 2 }. En las columnas de lista (get_task_columns) usa una de sus opciones'),
    }),
    run: async (userId, a) => {
      const b = await bootstrap(userId);
      const c = findChat(b, a.chat);
      let i = await issues.createIssue(userId, c.id, {
        title: a.title, ...(a.assignees ? { assigneeIds: a.assignees.map((x: string) => personId(b, x)) } : {}), ...(a.due_date ? { dueDate: a.due_date } : {}), ...(a.fields ? { fields: a.fields } : {}),
      });
      if (a.description) i = await issues.commentIssue(userId, i.id, a.description);
      return { task: taskView(b, i) };
    },
  },
  // ---------- Calendario (reuniones de chaggu en los chats donde estoy) ----------
  {
    name: 'list_calendar', readOnly: true, scope: 'calendar',
    description: 'Mi agenda en chaggu: reuniones entre from y to (ISO). Por defecto, de hoy a 7 días.',
    schema: z.object({ from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(), chat: z.string().max(200).optional() }),
    run: async (userId, a) => {
      const b = await bootstrap(userId);
      const from = a.from ?? new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
      const to = a.to ?? new Date(Date.parse(from) + 7 * 86400_000).toISOString();
      const conv = a.chat ? findChat(b, a.chat).id : undefined;
      const events = await cal.listEvents(userId, from, to, conv);
      return { from, to, events: events.map((e) => eventView(b, e)) };
    },
  },
  {
    name: 'create_event', scope: 'calendar',
    description: 'Agenda una reunión en un chat de chaggu e invita a personas (por nombre o id). Fechas ISO; zona horaria por defecto America/Bogota. Confirma antes con la persona.',
    schema: z.object({
      chat: z.string().min(1).max(200),
      title: z.string().trim().min(2).max(200),
      starts_at: z.string().datetime({ offset: true }),
      ends_at: z.string().datetime({ offset: true }),
      timezone: z.string().max(64).optional(),
      invitees: z.array(z.string().min(1).max(200)).max(100).optional(),
      description: z.string().max(4000).optional(),
      location: z.string().max(500).optional(),
    }),
    run: async (userId, a) => {
      const b = await bootstrap(userId);
      const c = findChat(b, a.chat);
      const ev = await cal.createEvent(userId, c.id, {
        title: a.title, startsAt: new Date(a.starts_at).toISOString(), endsAt: new Date(a.ends_at).toISOString(), timezone: a.timezone ?? 'America/Bogota',
        ...(a.invitees ? { inviteeIds: a.invitees.map((x: string) => personId(b, x)) } : {}), ...(a.description ? { description: a.description } : {}), ...(a.location ? { location: a.location } : {}),
      });
      return { event: eventView(b, ev) };
    },
  },
  {
    name: 'update_event', scope: 'calendar',
    description: 'Cambia o cancela una reunión que organizo (cancel=true la cancela). Confirma antes con la persona.',
    schema: z.object({
      id: z.string().uuid(), cancel: z.boolean().optional(),
      title: z.string().trim().min(2).max(200).optional(), starts_at: z.string().datetime({ offset: true }).optional(), ends_at: z.string().datetime({ offset: true }).optional(),
      invitees: z.array(z.string().min(1).max(200)).max(100).optional(), description: z.string().max(4000).optional(), location: z.string().max(500).optional(),
    }),
    run: async (userId, a) => {
      const b = await bootstrap(userId);
      if (a.cancel) return { event: eventView(b, await cal.cancelEvent(userId, a.id)) };
      const input: Record<string, unknown> = {};
      if (a.title) input.title = a.title;
      if (a.starts_at) input.startsAt = new Date(a.starts_at).toISOString();
      if (a.ends_at) input.endsAt = new Date(a.ends_at).toISOString();
      if (a.description !== undefined) input.description = a.description;
      if (a.location !== undefined) input.location = a.location;
      if (a.invitees) input.inviteeIds = a.invitees.map((x: string) => personId(b, x));
      return { event: eventView(b, await cal.updateEvent(userId, a.id, input as any)) };
    },
  },
  {
    name: 'rsvp_event', scope: 'calendar',
    description: 'Respondo a una invitación: yes, no o maybe.',
    schema: z.object({ id: z.string().uuid(), answer: z.enum(['yes', 'no', 'maybe']) }),
    run: async (userId, a) => { const b = await bootstrap(userId); return { event: eventView(b, await cal.rsvp(userId, a.id, a.answer) as any) }; },
  },
  // ---------- Responder al cliente ----------
  {
    name: 'find_client_channels', readOnly: true, scope: 'chats:read',
    description: 'Para responderle a un cliente: busca su nombre, empresa, correo o teléfono en mis chats de chaggu, mis WhatsApp y mi correo, y devuelve por dónde puedo escribirle.',
    schema: z.object({ client: z.string().trim().min(2).max(120).describe('Nombre, empresa, correo o teléfono del cliente') }),
    run: async (userId, a, ctx) => {
      const q = fold(a.client);
      const b = await bootstrap(userId);
      const chaggu = b.conversations.map((c) => chatView(b, c)).filter((c) => fold(`${c.name} ${c.group ?? ''}`).includes(q)).slice(0, 8)
        .map((c) => ({ channel: 'chaggu', chat: c.id, name: c.name, group: c.group, canReply: c.canPost, lastMessageAt: c.lastMessageAt }));
      const whatsapp = can(ctx, 'whatsapp:read') ? [
        ...(/\d{7,}/.test(a.client.replace(/\D/g, '')) ? (await mwa.findByPhone(ctx, a.client).catch(() => ({ chats: [] as any[] }))).chats : []),
        ...(await mwa.listChats(ctx, { query: a.client, limit: 8 })).chats,
      ].map((c: any) => ({ channel: 'whatsapp', ...c })) : [];
      const active = can(ctx, 'email') ? (await mailbox.listConnections(userId)).filter((c) => c.status === 'active') : [];
      const mails = (await Promise.all(active.map((c) => mailbox.listMail(userId, { provider: c.provider, box: 'all', q: a.client }).catch(() => ({ items: [] as any[] })))))
        .flatMap((l) => l.items).slice(0, 5)
        .map((m) => ({ channel: 'email', email: `${m.provider}|${m.id}`, from: m.from, subject: m.subject, date: m.date, canReply: true }));
      const tickets = !can(ctx, 'tasks:read') ? [] : (await issues.listIssues(userId, { open: false })).filter((i) => i.externalMeta && fold(JSON.stringify(i.externalMeta) + i.title).includes(q)).slice(0, 5)
        .map((i) => ({ channel: 'ticket', task: i.id, title: i.title, status: i.status, meta: i.externalMeta }));
      return { chaggu, whatsapp, email: mails, tickets };
    },
  },
];

// ---------- JSON-RPC ----------

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = [
  'chaggu es el chat entre equipos de distintas empresas, con WhatsApp, correo y tareas/tickets en un solo lugar. Todo se hace como la persona dueña del token: solo ves y escribes lo que ella puede, y solo los números o chats de WhatsApp que compartió con esta integración.',
  'Nunca envíes nada (chaggu, WhatsApp, correo, comentario de ticket) sin mostrar antes destinatario, canal, número y texto exacto y recibir un sí explícito. Si son varios mensajes, muéstralos todos juntos y pide un solo sí, o usa create_whatsapp_draft para que la persona los apruebe en chaggu.',
  'En WhatsApp lee solo lo necesario para la tarea; no resumas ni repitas chats personales que no te pidieron.',
  'PROGRAMADOS: para «mañana a las 10 am» usa la fecha actual y la zona horaria IANA de la persona; whoami.server_time da el instante actual UTC, pero no indica su zona. No supongas la zona del servidor. Si faltan destinatario, texto o zona horaria, pide esos datos. Antes de schedule_message o schedule_whatsapp confirma canal, destinatario, cuenta/número emisor, texto y fecha/hora local exacta con su zona. send_at debe llevar offset o Z y timezone es obligatoria. Conserva el id del recibo para consultar con list_scheduled_messages/list_scheduled_whatsapp, editar con update_scheduled_message/update_scheduled_whatsapp o cancelar con cancel_scheduled_message/cancel_scheduled_whatsapp. Di «programado», nunca «enviado», mientras el estado no sea sent. Los permisos se revisan otra vez antes del envío; una revocación puede dejarlo fallido. Una solicitud de ejemplo sin destinatario o texto no autoriza crear un mensaje real.',
  'Encargos personales (p. ej. «escríbele a 3 ferreterías y pídeles cotización»): consigue los números (de la persona, de find_whatsapp_chat o buscando en la web), propón un mensaje corto y cordial que diga quién escribe y qué necesita, muestra la lista de números con el texto, y tras el sí usa send_whatsapp con phone e idempotency_key. Después revisa las respuestas con read_whatsapp (since) y resúmelas.',
  'REGLA DE TICKETS: cuando termines de resolver o arreglar un ticket, caso, error o pedido de un cliente (aunque lo hayas resuelto en código, fuera de chaggu), pregúntale a la persona si quiere responderle al cliente desde aquí.',
  'Para eso usa find_client_channels (y get_task si hay ticket) y ofrécele los canales encontrados: WhatsApp, correo, chat de chaggu o comentario en el ticket. Propón un borrador breve y claro en el idioma del cliente, sin detalles internos ni secretos, y espera su confirmación antes de enviarlo.',
  'Después de responder, ofrece marcar el ticket como done con update_task.',
  'LECTURA: si la persona pide «resúmeme lo que me mandaron», «qué tengo por leer» o algo parecido (artículos, videos, tweets, p. ej. de su papá), usa summarize_reading y muéstrale el digest; ya quedan marcados como leídos. Si hay remaining, ofrece seguir. Si quiere que un chat de WhatsApp alimente la lista, usa set_whatsapp_reading.',
].join(' ');

const PROMPTS = [{
  name: 'responder_cliente',
  title: 'Responder al cliente',
  description: 'Tras resolver un ticket o caso, redacta la respuesta y envíala por el canal que elijas (WhatsApp, correo, chaggu o el ticket).',
  arguments: [{ name: 'cliente', description: 'Nombre, empresa, correo o teléfono del cliente', required: true }, { name: 'resumen', description: 'Qué se arregló', required: false }],
}];
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

function describeTool(t: Tool) {
  const schema: any = z.toJSONSchema(t.schema);
  delete schema.$schema;
  return { name: t.name, description: t.description, inputSchema: schema, annotations: { readOnlyHint: !!t.readOnly, destructiveHint: false, openWorldHint: !t.readOnly } };
}

async function handleOne(ctx: McpCtx, msg: any) {
  const userId = ctx.userId;
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id, -32600, 'Invalid Request');
  const isNotification = msg.id === undefined;
  if (isNotification) return null;
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return {
        jsonrpc: '2.0', id: msg.id,
        result: {
          protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name: 'chaggu', title: 'Chaggu', version: '1.1.0' },
          instructions: INSTRUCTIONS,
        },
      };
    }
    case 'ping': return { jsonrpc: '2.0', id: msg.id, result: {} };
    case 'tools/list': return { jsonrpc: '2.0', id: msg.id, result: { tools: tools.filter((t) => !t.scope || can(ctx, t.scope)).map(describeTool) } };
    case 'tools/call': {
      const t = tools.find((x) => x.name === msg.params?.name);
      if (!t) return rpcError(msg.id, -32602, `Herramienta desconocida: ${msg.params?.name}`);
      const fail = (code: string, message: string) => ({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `[${code}] ${message}` }], structuredContent: { error: { code, message } }, isError: true } });
      if (t.scope && !can(ctx, t.scope)) {
        await audit(ctx, t.name, msg.params?.arguments, null, 'forbidden_scope');
        return fail('forbidden_scope', `Este token no tiene el permiso ${t.scope}. La persona lo cambia en chaggu › Tú › Conector para IAs.`);
      }
      try {
        const args = t.schema.parse(msg.params?.arguments ?? {});
        const out = await t.run(userId, args, ctx);
        await audit(ctx, t.name, args, out, null);
        return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }], structuredContent: out } };
      } catch (err: any) {
        if (err instanceof z.ZodError) return fail('bad_request', `Datos inválidos: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        if (!(err instanceof ApiError)) console.error('[mcp] fallo en', t.name, err?.message ?? err);
        const code = err instanceof ApiError ? (err.code === 'forbidden' && t.name.includes('whatsapp') ? 'send_disabled' : err.code) : 'internal';
        await audit(ctx, t.name, msg.params?.arguments, null, code);
        return fail(code, err instanceof ApiError ? err.message : 'Error interno');
      }
    }
    case 'resources/list': return { jsonrpc: '2.0', id: msg.id, result: { resources: [] } };
    case 'prompts/list': return { jsonrpc: '2.0', id: msg.id, result: { prompts: PROMPTS } };
    case 'prompts/get': {
      if (msg.params?.name !== 'responder_cliente') return rpcError(msg.id, -32602, 'Prompt desconocido');
      const a = msg.params?.arguments ?? {};
      const text = `Quiero responderle al cliente «${String(a.cliente ?? '').slice(0, 120)}»${a.resumen ? ` sobre esto que se resolvió: ${String(a.resumen).slice(0, 2000)}` : ''}. `
        + 'Usa find_client_channels para ver por dónde le puedo escribir (WhatsApp, correo, chaggu o el ticket), muéstrame las opciones, redacta un borrador corto y espera mi confirmación antes de enviarlo.';
      return { jsonrpc: '2.0', id: msg.id, result: { description: PROMPTS[0]!.description, messages: [{ role: 'user', content: { type: 'text', text } }] } };
    }
    default: return rpcError(msg.id, -32601, `Método no soportado: ${msg.method}`);
  }
}

/** Devuelve el cuerpo de la respuesta, o null si solo eran notificaciones (202 sin cuerpo). */
export async function handleRpc(ctx: McpCtx, body: unknown): Promise<unknown | null> {
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleOne(ctx, m)))).filter(Boolean);
    return out.length ? out : null;
  }
  return handleOne(ctx, body);
}

/** Bitácora sin contenido: herramienta, a qué (chat, número, id) y cuántos elementos devolvió. */
async function audit(ctx: McpCtx, tool: string, args: any, out: any, error: string | null) {
  const target = args && typeof args === 'object' ? String(args.chat ?? args.phone ?? args.to ?? args.person ?? args.email ?? args.id ?? '').slice(0, 300) || null : null;
  const items = out && typeof out === 'object' ? Object.values(out).reduce<number>((n, v) => n + (Array.isArray(v) ? v.length : 0), 0) : 0;
  await pool.query('INSERT INTO mcp_audit (token_id, user_id, tool, target, items, ok, error) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [ctx.tokenId, ctx.userId, tool, target, items, !error, error]).catch(() => {});
}

export const toolNames = () => tools.map((t) => t.name);
