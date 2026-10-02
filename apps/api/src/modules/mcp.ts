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
import { pool } from '../db.ts';
import { ApiError, badRequest, notFound, unauthorized } from '../errors.ts';
import { randomToken, sha256 } from '../security.ts';
import { bootstrap } from './bootstrap.ts';
import { searchAll } from './chat-search.ts';
import { listMessages, markRead, sendMessage } from './messages.ts';
import { getOrCreateDirect } from './workspaces.ts';
import * as wa from './whatsapp.ts';
import * as mailbox from './mailbox.ts';
import * as issues from './issues.ts';
import * as cal from './calendar.ts';

const PREFIX = 'chgmcp_';
const MAX_TOKENS = 20;
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

// ---------- Tokens personales ----------

export async function listTokens(userId: string) {
  const { rows } = await pool.query(
    'SELECT id, name, token_hint, created_at, last_used_at, client_id FROM mcp_tokens WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC',
    [userId],
  );
  return { tokens: rows.map((r) => ({ id: r.id, name: r.name, tokenHint: r.token_hint, createdAt: iso(r.created_at), lastUsedAt: iso(r.last_used_at), oauth: !!r.client_id })) };
}

export async function createToken(userId: string, name: string) {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM mcp_tokens WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  if (rows[0].n >= MAX_TOKENS) throw badRequest(`Máximo ${MAX_TOKENS} tokens activos; revoca alguno`);
  const token = PREFIX + randomToken(32);
  const ins = await pool.query(
    'INSERT INTO mcp_tokens (user_id, name, token_hash, token_hint) VALUES ($1,$2,$3,$4) RETURNING id, created_at',
    [userId, name, sha256(token), `…${token.slice(-4)}`],
  );
  return { id: ins.rows[0].id, name, token, createdAt: iso(ins.rows[0].created_at), endpoint: '/api/mcp' };
}

export async function revokeToken(userId: string, id: string) {
  const { rowCount } = await pool.query('UPDATE mcp_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [id, userId]);
  if (!rowCount) throw notFound('Token');
  return { ok: true };
}

export async function authenticate(header: string | undefined): Promise<string> {
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token.startsWith(PREFIX) || token.length > 120) throw unauthorized('Token MCP inválido');
  const { rows } = await pool.query(
    `SELECT t.id, t.user_id, t.last_used_at FROM mcp_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND u.disabled_at IS NULL`,
    [sha256(token)],
  );
  const r = rows[0];
  if (!r) throw unauthorized('Token MCP inválido');
  if (!r.last_used_at || Date.now() - new Date(r.last_used_at).getTime() > 60_000) {
    await pool.query('UPDATE mcp_tokens SET last_used_at = now() WHERE id = $1', [r.id]);
  }
  return r.user_id as string;
}

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
    try { const p = JSON.parse(m.body); text = `[aviso ${p.k ?? 'sistema'}] ${p.subject ?? p.title ?? p.text ?? ''}`.trim(); } catch { text = `[aviso] ${m.body}`; }
  }
  const files = (m.attachments ?? []).map((a: any) => a.name ?? a.kind ?? 'adjunto');
  return {
    id: m.id, seq: m.seq, at: (m as any).createdAt ?? null, author, text,
    ...(files.length ? { attachments: files } : {}), ...(m.replyTo ? { replyTo: m.replyTo } : {}), ...((m as any).deletedAt ? { deleted: true } : {}),
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

async function findWa(userId: string, ref: string) {
  const bar = ref.indexOf('|');
  if (bar > 0) {
    const r = await wa.ownChat(userId, ref.slice(0, bar), ref.slice(bar + 1));
    return { accountId: r.account_id as string, jid: r.jid as string, name: (r.name ?? wa.phoneLabel(r.pn) ?? r.jid) as string, account: r.account_label as string };
  }
  const { chats } = await wa.listChats(userId, { search: ref, limit: 20 });
  const exact = chats.filter((c) => fold(c.name) === fold(ref));
  const hits = exact.length ? exact : chats;
  if (hits.length === 1) return { accountId: hits[0]!.accountId, jid: hits[0]!.jid, name: hits[0]!.name, account: hits[0]!.accountLabel };
  if (!hits.length) throw notFound('Chat de WhatsApp');
  throw badRequest(`Hay ${hits.length} chats de WhatsApp con ese nombre; usa el valor chat: ${hits.slice(0, 8).map((c) => `${c.name} (${c.accountLabel}) = ${c.accountId}|${c.jid}`).join('; ')}`);
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
    id: i.id, title: i.title, status: i.status, due: i.dueDate,
    assignees: (i.assigneeIds ?? (i.ownerId ? [i.ownerId] : [])).map(name), requestedBy: name(i.requestedBy), chat: c ? chatName(b, c) : null, chatId: i.conversationId,
    ...(i.externalId ? { ticket: i.externalId } : {}), ...(i.externalMeta ? { meta: i.externalMeta } : {}), ...(i.fields ? { fields: i.fields } : {}), comments: i.commentCount, updatedAt: i.updatedAt,
  };
}

// ---------- Herramientas ----------

type Tool = { name: string; description: string; schema: z.ZodObject<any>; readOnly?: boolean; run: (userId: string, a: any) => Promise<unknown> };

const tools: Tool[] = [
  {
    name: 'whoami', readOnly: true,
    description: 'Quién soy en chaggu: nombre, correo, empresas y grupos a los que pertenezco.',
    schema: z.object({}),
    run: async (userId) => {
      const b = await bootstrap(userId);
      return { id: b.me.id, name: b.me.name, email: (b.me as any).email ?? null, organizations: b.organizations.map((o) => o.name), groups: b.workspaces.map((w) => w.name) };
    },
  },
  {
    name: 'list_chats', readOnly: true,
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
    name: 'read_messages', readOnly: true,
    description: 'Lee los últimos mensajes de un chat (por id o nombre). Para paginar hacia atrás usa before_seq con el seq más viejo recibido.',
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
    name: 'send_message',
    description: 'Envía un mensaje de texto a un chat existente (por id o nombre) en mi nombre. Para escribirle a una persona sin chat usa send_direct_message.',
    schema: z.object({
      chat: z.string().min(1).max(200).describe('Id del chat o su nombre'),
      text: z.string().trim().min(1).max(8000),
      reply_to: z.string().uuid().optional().describe('Id del mensaje al que se responde'),
    }),
    run: async (userId, a) => {
      const b = await bootstrap(userId);
      const c = findChat(b, a.chat);
      const out = await sendMessage(userId, c.id, { clientMessageId: `mcp-${randomUUID()}`, body: a.text, replyTo: a.reply_to ?? null });
      return { sent: true, chat: chatName(b, c), chatId: c.id, message: messageView(b, out.message) };
    },
  },
  {
    name: 'send_direct_message',
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
    name: 'search_messages', readOnly: true,
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
    name: 'unread_summary', readOnly: true,
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
    name: 'mark_read',
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
    name: 'list_people', readOnly: true,
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

  // ---------- WhatsApp (solo las cuentas que la persona conectó; escribir exige «Responder desde chaggu») ----------
  {
    name: 'list_whatsapp_chats', readOnly: true,
    description: 'Lista mis chats de WhatsApp conectados a chaggu (personas y grupos), con no leídos y si puedo responder desde aquí.',
    schema: z.object({
      query: z.string().max(120).optional().describe('Parte del nombre del chat o grupo'),
      unread_only: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    run: async (userId, a) => {
      const accounts = await wa.listAccounts(userId);
      if (!accounts.length) return { chats: [], note: 'No tienes WhatsApp conectado en chaggu (WhatsApp › Conectar).' };
      const r = await wa.listChats(userId, { search: a.query, limit: a.limit ?? 30 });
      const chats = r.chats.filter((c) => !a.unread_only || c.unread > 0).map((c) => {
        const acc = accounts.find((x) => x.id === c.accountId);
        return { chat: `${c.accountId}|${c.jid}`, name: c.name, account: c.accountLabel, isGroup: c.isGroup, unread: c.unread, lastMessageAt: c.lastMessageAt, preview: c.lastPreview,
          canReply: !!acc?.sendEnabled && acc?.status === 'connected' };
      });
      return { chats };
    },
  },
  {
    name: 'read_whatsapp', readOnly: true,
    description: 'Lee los últimos mensajes de un chat de WhatsApp (usa el valor chat de list_whatsapp_chats o el nombre). No lo marca como leído.',
    schema: z.object({ chat: z.string().min(1).max(300), limit: z.number().int().min(1).max(100).optional() }),
    run: async (userId, a) => {
      const c = await findWa(userId, a.chat);
      const messages = await wa.messagesForGg(c.accountId, c.jid, { limit: a.limit ?? 30 });
      return { chat: { chat: `${c.accountId}|${c.jid}`, name: c.name, account: c.account }, messages: messages.map((m) => ({ id: m.id, at: m.at, author: m.mine ? 'Tú' : m.author, text: m.text })) };
    },
  },
  {
    name: 'send_whatsapp',
    description: 'Envía un mensaje de WhatsApp desde MI cuenta conectada a un chat o grupo. Solo funciona si activé «Responder desde chaggu» en esa cuenta. Confirma antes con la persona.',
    schema: z.object({ chat: z.string().min(1).max(300), text: z.string().trim().min(1).max(4000) }),
    run: async (userId, a) => {
      const c = await findWa(userId, a.chat);
      const r = await wa.sendToChat(userId, c.accountId, c.jid, a.text);
      return { to: c.name, account: c.account, ...r };
    },
  },
  // ---------- Correo (Gmail u Outlook conectado por la persona) ----------
  {
    name: 'list_emails', readOnly: true,
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
    name: 'read_email', readOnly: true,
    description: 'Lee un correo completo de mi buzón (valor email de list_emails).',
    schema: z.object({ email: z.string().min(3).max(500) }),
    run: async (userId, a) => {
      const { provider, id } = mailRef(a.email);
      const m = await mailbox.getMail(userId, provider, id);
      return { email: a.email, from: m.from, to: m.to, cc: m.cc, subject: m.subject, date: m.date, body: m.body.slice(0, 20000), attachments: m.attachments.map((x) => x.name) };
    },
  },
  {
    name: 'reply_email',
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
    name: 'list_tasks', readOnly: true,
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
    name: 'get_task', readOnly: true,
    description: 'Detalle de una tarea o ticket: estado, responsables, datos del cliente y comentarios.',
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
    name: 'comment_task',
    description: 'Comenta una tarea o ticket. En los tickets de la mesa de ayuda el comentario también vuelve al sistema del cliente.',
    schema: z.object({ id: z.string().uuid(), text: z.string().trim().min(1).max(4000) }),
    run: async (userId, a) => { await issues.commentIssue(userId, a.id, a.text); return { ok: true }; },
  },
  {
    name: 'update_task',
    description: 'Cambia un ticket o tarea: estado (open, in_progress, waiting, done, cancelled), responsables (por nombre o id; reemplaza la lista), fecha límite, título o campos dinámicos (fields: se mezclan con los que ya tiene; null borra un campo). Confirma antes con la persona.',
    schema: z.object({
      id: z.string().uuid(),
      status: z.enum(['open', 'in_progress', 'waiting', 'done', 'cancelled']).optional(),
      assignees: z.array(z.string().min(1).max(200)).max(20).optional().describe('Responsables (nombres o ids). [] = sin responsable'),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe('AAAA-MM-DD o null para quitarla'),
      title: z.string().trim().min(2).max(200).optional(),
      fields: IssueFieldsInput.optional().describe('Campos dinámicos { "Servicios": "…", "Prioridad": 2, "Bloqueado": true }; null borra'),
    }),
    run: async (userId, a) => {
      const b = await bootstrap(userId);
      const input: Record<string, unknown> = {};
      if (a.status) input.status = a.status;
      if (a.title) input.title = a.title;
      if (a.fields) input.fields = a.fields;
      if (a.due_date !== undefined) input.dueDate = a.due_date;
      if (a.assignees) input.assigneeIds = a.assignees.map((x: string) => personId(b, x));
      if (!Object.keys(input).length) throw badRequest('Nada que cambiar');
      return { task: taskView(b, await issues.updateIssue(userId, a.id, input as any)) };
    },
  },
  {
    name: 'get_task_columns', readOnly: true,
    description: 'Columnas de las tareas de un grupo: nombre, tipo (text, select = lista desplegable, number, checkbox) y las opciones de cada lista (p. ej. Tipo: Bug, Funcionalidad nueva, Mejora). Úsalo antes de crear o cambiar tareas con fields para usar las opciones válidas.',
    schema: z.object({ chat: z.string().min(1).max(200).describe('Id o nombre del grupo') }),
    run: async (userId, a) => issues.getTaskColumns(userId, findChat(await bootstrap(userId), a.chat).id),
  },
  {
    name: 'set_task_columns',
    description: 'Define las columnas de las tareas de un grupo (reemplaza la lista completa; trae primero las actuales con get_task_columns). type: text, select (lista desplegable con options), number o checkbox. Solo quien administra el grupo. Confirma antes con la persona.',
    schema: z.object({ chat: z.string().min(1).max(200), columns: z.array(TaskColumnInput).max(30) }),
    run: async (userId, a) => issues.setTaskColumns(userId, findChat(await bootstrap(userId), a.chat).id, { columns: a.columns }),
  },
  {
    name: 'create_task',
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
    name: 'list_calendar', readOnly: true,
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
    name: 'create_event',
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
    name: 'update_event',
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
    name: 'rsvp_event',
    description: 'Respondo a una invitación: yes, no o maybe.',
    schema: z.object({ id: z.string().uuid(), answer: z.enum(['yes', 'no', 'maybe']) }),
    run: async (userId, a) => { const b = await bootstrap(userId); return { event: eventView(b, await cal.rsvp(userId, a.id, a.answer) as any) }; },
  },
  // ---------- Responder al cliente ----------
  {
    name: 'find_client_channels', readOnly: true,
    description: 'Para responderle a un cliente: busca su nombre, empresa, correo o teléfono en mis chats de chaggu, mis WhatsApp y mi correo, y devuelve por dónde puedo escribirle.',
    schema: z.object({ client: z.string().trim().min(2).max(120).describe('Nombre, empresa, correo o teléfono del cliente') }),
    run: async (userId, a) => {
      const q = fold(a.client);
      const b = await bootstrap(userId);
      const chaggu = b.conversations.map((c) => chatView(b, c)).filter((c) => fold(`${c.name} ${c.group ?? ''}`).includes(q)).slice(0, 8)
        .map((c) => ({ channel: 'chaggu', chat: c.id, name: c.name, group: c.group, canReply: c.canPost, lastMessageAt: c.lastMessageAt }));
      const accounts = await wa.listAccounts(userId);
      const whatsapp = accounts.length ? (await wa.listChats(userId, { search: a.client, limit: 8 })).chats.map((c) => {
        const acc = accounts.find((x) => x.id === c.accountId);
        return { channel: 'whatsapp', chat: `${c.accountId}|${c.jid}`, name: c.name, account: c.accountLabel, isGroup: c.isGroup, lastMessageAt: c.lastMessageAt, canReply: !!acc?.sendEnabled && acc?.status === 'connected' };
      }) : [];
      const active = (await mailbox.listConnections(userId)).filter((c) => c.status === 'active');
      const mails = (await Promise.all(active.map((c) => mailbox.listMail(userId, { provider: c.provider, box: 'all', q: a.client }).catch(() => ({ items: [] as any[] })))))
        .flatMap((l) => l.items).slice(0, 5)
        .map((m) => ({ channel: 'email', email: `${m.provider}|${m.id}`, from: m.from, subject: m.subject, date: m.date, canReply: true }));
      const tickets = (await issues.listIssues(userId, { open: false })).filter((i) => i.externalMeta && fold(JSON.stringify(i.externalMeta) + i.title).includes(q)).slice(0, 5)
        .map((i) => ({ channel: 'ticket', task: i.id, title: i.title, status: i.status, meta: i.externalMeta }));
      return { chaggu, whatsapp, email: mails, tickets };
    },
  },
];

// ---------- JSON-RPC ----------

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = [
  'chaggu es el chat entre equipos de distintas empresas, con WhatsApp, correo y tareas/tickets en un solo lugar. Todo se hace como la persona dueña del token: solo ves y escribes lo que ella puede.',
  'Nunca envíes nada (chaggu, WhatsApp, correo, comentario de ticket) sin mostrar antes destinatario, canal y texto exacto y recibir un sí explícito.',
  'REGLA DE TICKETS: cuando termines de resolver o arreglar un ticket, caso, error o pedido de un cliente (aunque lo hayas resuelto en código, fuera de chaggu), pregúntale a la persona si quiere responderle al cliente desde aquí.',
  'Para eso usa find_client_channels (y get_task si hay ticket) y ofrécele los canales encontrados: WhatsApp, correo, chat de chaggu o comentario en el ticket. Propón un borrador breve y claro en el idioma del cliente, sin detalles internos ni secretos, y espera su confirmación antes de enviarlo.',
  'Después de responder, ofrece marcar el ticket como done con update_task.',
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

async function handleOne(userId: string, msg: any) {
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
          serverInfo: { name: 'chaggu', title: 'Chaggu', version: '1.0.0' },
          instructions: INSTRUCTIONS,
        },
      };
    }
    case 'ping': return { jsonrpc: '2.0', id: msg.id, result: {} };
    case 'tools/list': return { jsonrpc: '2.0', id: msg.id, result: { tools: tools.map(describeTool) } };
    case 'tools/call': {
      const t = tools.find((x) => x.name === msg.params?.name);
      if (!t) return rpcError(msg.id, -32602, `Herramienta desconocida: ${msg.params?.name}`);
      try {
        const args = t.schema.parse(msg.params?.arguments ?? {});
        const out = await t.run(userId, args);
        return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }], structuredContent: out } };
      } catch (err: any) {
        const text = err instanceof z.ZodError ? `Datos inválidos: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
          : err instanceof ApiError ? err.message : 'Error interno';
        if (!(err instanceof z.ZodError) && !(err instanceof ApiError)) console.error('[mcp] fallo en', t.name, err?.message ?? err);
        return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }], isError: true } };
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
export async function handleRpc(userId: string, body: unknown): Promise<unknown | null> {
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleOne(userId, m)))).filter(Boolean);
    return out.length ? out : null;
  }
  return handleOne(userId, body);
}

export const toolNames = () => tools.map((t) => t.name);
