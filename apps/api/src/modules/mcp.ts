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
import type { BootstrapDTO, ConversationDTO, MessageDTO } from '@tiecoms/contracts';
import { pool } from '../db.ts';
import { ApiError, badRequest, notFound, unauthorized } from '../errors.ts';
import { randomToken, sha256 } from '../security.ts';
import { bootstrap } from './bootstrap.ts';
import { searchAll } from './chat-search.ts';
import { listMessages, markRead, sendMessage } from './messages.ts';
import { getOrCreateDirect } from './workspaces.ts';

const PREFIX = 'chgmcp_';
const MAX_TOKENS = 20;
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

// ---------- Tokens personales ----------

export async function listTokens(userId: string) {
  const { rows } = await pool.query(
    'SELECT id, name, token_hint, created_at, last_used_at FROM mcp_tokens WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC',
    [userId],
  );
  return { tokens: rows.map((r) => ({ id: r.id, name: r.name, tokenHint: r.token_hint, createdAt: iso(r.created_at), lastUsedAt: iso(r.last_used_at) })) };
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
];

// ---------- JSON-RPC ----------

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
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
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'chaggu', title: 'Chaggu', version: '1.0.0' },
          instructions: 'Chaggu es el chat entre equipos de distintas empresas. Todo se hace como la persona dueña del token. '
            + 'Antes de enviar un mensaje confirma con la persona el destinatario y el texto. Los chats y personas se pueden nombrar por id o por nombre.',
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
    case 'prompts/list': return { jsonrpc: '2.0', id: msg.id, result: { prompts: [] } };
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
