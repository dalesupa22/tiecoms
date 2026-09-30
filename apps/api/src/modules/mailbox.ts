import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { z } from 'zod';
import type {
  MailAddressDTO, MailAttachmentInfoDTO, MailConnectionDTO, MailListDTO, MailListItemDTO, MailListQuery, MailMessageDTO, MailProvider,
  ForwardSharedInput, MailReplyInput, MailTaskInput, MessageDTO, ShareMailInput, ShareWaInput, SharedMailCommentDTO, SharedMailDTO,
} from '@tiecoms/contracts';
import { conversationAccess } from '../access.ts';
import { config } from '../config.ts';
import { audit, pool, tx, type Db, type Tx } from '../db.ts';
import { safeHtml } from './mail-html.ts';
import { safeGet, sniffImage } from './link-preview.ts';
import { ApiError, badRequest, forbidden, notFound } from '../errors.ts';
import { getObject } from '../storage.ts';
import { ByteLru } from '../lru.ts';
import { appendEvent, appendMessage } from './messages.ts';
import { bumpCommentNotice } from './chat-notices.ts';
import { createIssue, updateIssue } from './issues.ts';

/**
 * Correo en el chat (docs/CORREO.md).
 * - La bandeja NO se guarda: listar, buscar y abrir consultan a Gmail u Outlook en vivo con el token de la persona.
 * - Llevar un correo a un chat guarda SOLO ese correo en texto (asunto, remitente, cuerpo) para que el chat lo lea.
 * - Los adjuntos se bajan del buzón de quien lo compartió cuando alguien los abre; nunca se guardan.
 * - Solo quien lo compartió responde (sale de su buzón). Programar lo guarda en mail_replies y lo manda el worker.
 * - OAuth igual que las reuniones: state `mail_`, recibo de un solo uso y prueba PKCE del cliente que lo inició.
 */

const FLOW_TTL_MIN = 10;
const CONFIRM_TTL_SECONDS = 120;
const PAGE = 50;
const MAX_BODY = 50_000;
/** Lo que se guarda del correo compartido: solo el texto nuevo (sin historial citado ni firma), hasta 20 000 caracteres. */
const MAX_STORED = 20_000;
const MAX_ATTACHMENT = 25 * 1024 * 1024;
const sha = (s: string) => createHash('sha256').update(s).digest();
const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');
const token = (n = 32) => randomBytes(n).toString('base64url');
const sys = (k: string, p: Record<string, unknown> = {}) => JSON.stringify({ k, ...p });
const iso = (d: any) => (d ? new Date(d).toISOString() : null);
const env = (k: string, d = '') => process.env[k] ?? d;
const base = (k: string, d: string) => env(k, d).replace(/\/$/, '');
const request = (url: string, init: RequestInit = {}, ms = 20_000) => fetch(url, { ...init, signal: AbortSignal.timeout(ms) });

export const mailEnabled = () => process.env.MAIL_ENABLED === 'true';

// ---------- Caché en memoria (nunca en disco ni en la base) ----------
// La lista y el correo abierto se piden mucho seguido (volver a la pestaña, abrir la vista previa, compartir).
// Se guardan unos segundos en memoria del proceso, por persona. Desconectar o responder invalida lo de esa persona.
const listCache = new ByteLru<{ body: Buffer }>(300, 16 * 1024 * 1024, 60_000);
const msgCache = new ByteLru<{ body: Buffer }>(300, 24 * 1024 * 1024, 5 * 60_000);
const userGen = new Map<string, number>();
const genOf = (userId: string) => userGen.get(userId) ?? 0;
const bumpUser = (userId: string) => userGen.set(userId, genOf(userId) + 1);
async function cached<T>(lru: ByteLru<{ body: Buffer }>, key: string, load: () => Promise<T>): Promise<T> {
  const v = await lru.through(key, async () => ({ body: Buffer.from(JSON.stringify(await load())) }));
  return JSON.parse(v.body.toString('utf8')) as T;
}

// ---------- Limpieza del cuerpo ----------
/** Encabezados de respuesta citada («El jue, … escribió:», «On … wrote:», «-----Mensaje original-----», bloque «De: … Enviado:» de Outlook). */
const QUOTE_HEAD = [
  /^\s*(El|On|Le|Am|Il)\s.{4,200}(escribió|wrote|a écrit|schrieb|ha scritto)\s*:\s*$/im,
  /^\s*-{2,}\s*(Mensaje original|Original Message|Forwarded message|Mensaje reenviado)\s*-{2,}/im,
  /^\s*_{10,}\s*$/m,
  /^\s*(De|From)\s*:.+\n\s*(Enviado|Sent|Fecha|Date)\s*:/im,
];
/** Deja solo lo nuevo del correo: corta el historial citado y la firma. Si cortar lo deja casi vacío, no corta. */
export function cleanBody(text: string): { text: string; trimmed: boolean } {
  let t = text.replace(/\r\n?/g, '\n');
  let cut = t.length;
  for (const re of QUOTE_HEAD) { const m = re.exec(t); if (m && m.index < cut) cut = m.index; }
  // Bloque final de líneas «> …».
  const q = /(\n>.*)+\s*$/.exec(t); if (q && q.index < cut) cut = q.index;
  const sig = /\n-- ?\n/.exec(t); if (sig && sig.index < cut) cut = sig.index;
  let out = t.slice(0, cut).trim();
  if (out.replace(/\s/g, '').length < 3) out = t.trim();
  const trimmed = out.length < t.trim().length;
  if (out.length > MAX_STORED) return { text: `${out.slice(0, MAX_STORED - 1)}…`, trimmed: true };
  return { text: out, trimmed };
}
const OFF_REASON = 'El correo en el chat se activa pronto: estamos terminando los permisos con Google y Microsoft.';

// ---------- Cifrado de tokens ----------
const KEY = createHash('sha256').update(`chaggu:mail:${process.env.MAIL_TOKEN_KEY ?? config.jwtSecret}`).digest();
function seal(v: string | null | undefined): Buffer | null {
  if (!v) return null;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([c.update(v, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}
function open(b: Buffer | null): string | null {
  if (!b) return null;
  const d = createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

// ---------- Texto ----------
const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+|#39);/gi, (m, e: string) => {
      if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
/** «Jorge Ramírez <jorge@x.co>» → { name, email }. */
export function parseAddress(raw: string | null | undefined): MailAddressDTO | null {
  if (!raw) return null;
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1]!.trim() || null, email: m[2]!.trim().toLowerCase() };
  const e = raw.trim().toLowerCase();
  return e.includes('@') ? { name: null, email: e } : null;
}
/** Lista separada por comas, sin partir comas dentro de comillas. */
export function parseAddressList(raw: string | null | undefined): MailAddressDTO[] {
  if (!raw) return [];
  const out: string[] = []; let cur = ''; let q = false;
  for (const ch of raw) { if (ch === '"') q = !q; if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; }
  out.push(cur);
  return out.map(parseAddress).filter((x): x is MailAddressDTO => !!x);
}
const fmtAddress = (a: MailAddressDTO) => (a.name ? `${encodeHeader(a.name)} <${a.email}>` : a.email);
function encodeHeader(v: string) {
  // RFC 2047 para nombres y asuntos con tildes.
  return /^[\x20-\x7e]*$/.test(v) ? (/[",<>@]/.test(v) ? `"${v.replace(/"/g, '')}"` : v) : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}
const reSubject = (s: string) => (/^\s*(re|rv|aw)\s*:/i.test(s) ? s : `Re: ${s}`);

// ---------- Proveedores ----------
interface Tokens { access: string; refresh: string | null; expiresIn: number; email: string | null; scope: string }
interface Full extends MailMessageDTO { internetId: string | null; references: string | null; html?: string | null }
interface ReplyOut { to: MailAddressDTO[]; cc: MailAddressDTO[]; subject: string; body: string; files: { name: string; contentType: string; bytes: Buffer }[] }
interface Provider {
  label: 'Gmail' | 'Outlook';
  configured(): boolean;
  authorize(state: string, verifier: string): string;
  exchange(code: string, verifier: string): Promise<Tokens>;
  refresh(refresh: string): Promise<Tokens>;
  revoke?(t: string): Promise<void>;
  list(at: string, q: z.infer<typeof MailListQuery>): Promise<{ items: MailListItemDTO[]; nextPage: string | null }>;
  get(at: string, id: string): Promise<Full>;
  attachment(at: string, messageId: string, attachmentId: string): Promise<{ bytes: Buffer }>;
  reply(at: string, original: { externalId: string; threadId: string | null; internetId: string | null; references: string | null }, out: ReplyOut): Promise<void>;
  /** El HTML del correo, si lo tiene (Gmail ya lo trae en get). */
  html?(at: string, id: string): Promise<string | null>;
  /** Sin leer en Recibidos › Principal (Gmail) o Prioritarios (Outlook), hasta UNREAD_CAP. Una sola petición barata. */
  unread(at: string): Promise<number>;
}
const UNREAD_CAP = 100;
class ProviderError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }

async function form(url: string, body: Record<string, string>) {
  const res = await request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ProviderError(res.status, json?.error ?? 'token_failed', json?.error_description ?? `HTTP ${res.status}`);
  return json;
}
async function api(at: string, url: string, init: RequestInit = {}): Promise<any> {
  const res = await request(url, { ...init, headers: { authorization: `Bearer ${at}`, ...(init.headers ?? {}) } });
  if (res.status === 202 || res.status === 204) return {};
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ProviderError(res.status, j?.error?.code ?? j?.error?.status ?? 'provider_failed', `El proveedor respondió HTTP ${res.status}`);
  return j;
}
function emailFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  try { const p = JSON.parse(Buffer.from(idToken.split('.')[1]!, 'base64url').toString()); return (p.email ?? p.preferred_username ?? null)?.toLowerCase() ?? null; } catch { return null; }
}
const toTokens = (j: any, prev: string | null = null): Tokens => ({
  access: j.access_token, refresh: j.refresh_token ?? prev, expiresIn: Number(j.expires_in ?? 3600), email: emailFromIdToken(j.id_token), scope: j.scope ?? '',
});
const ssoRedirect = (p: MailProvider) => `${config.apiPublicOrigin}/api/v1/auth/${p}/callback`;
const truthy = (v: string | undefined) => v === '1' || v === 'true';
const ymd = (s: string) => s.replace(/-/g, '/');
const nextDay = (s: string) => new Date(Date.parse(`${s}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const quoteQ = (s: string) => (/\s/.test(s) ? `"${s.replace(/"/g, '')}"` : s.replace(/"/g, ''));

// Gmail: leer, enviar y borradores. gmail.readonly es un permiso restringido (verificación + CASA fuera de xertify.co).
export const GOOGLE_MAIL_SCOPE = 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.compose';
export const MS_MAIL_SCOPE = 'openid email offline_access https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send';
const gApi = () => base('MAIL_GOOGLE_API', 'https://gmail.googleapis.com/gmail/v1');
const msApi = () => base('MAIL_MS_API', 'https://graph.microsoft.com/v1.0');

/** Consulta de Gmail a partir de los filtros (misma sintaxis que el buscador de Gmail). */
export function gmailQuery(q: z.infer<typeof MailListQuery>): string {
  const parts: string[] = [];
  if (q.box === 'inbox') parts.push('in:inbox'); else if (q.box === 'sent') parts.push('in:sent');
  if (q.box === 'inbox' && q.category && q.category !== 'any') parts.push(`category:${q.category === 'focused' ? 'primary' : q.category === 'other' ? 'promotions' : q.category}`);
  if (q.q) parts.push(q.q);
  if (q.from) parts.push(`from:${quoteQ(q.from)}`);
  if (q.to) parts.push(`to:${quoteQ(q.to)}`);
  if (q.after) parts.push(`after:${ymd(q.after)}`);
  if (q.before) parts.push(`before:${ymd(nextDay(q.before))}`);
  if (truthy(q.attachments)) parts.push('has:attachment');
  if (truthy(q.unread)) parts.push('is:unread');
  if (q.label) parts.push(`label:${quoteQ(q.label)}`);
  return parts.join(' ');
}

type GPart = { mimeType?: string; filename?: string; headers?: { name: string; value: string }[]; body?: { data?: string; attachmentId?: string; size?: number }; parts?: GPart[]; partId?: string };
const gHeader = (p: GPart | undefined, n: string) => p?.headers?.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? null;
const b64u = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
function gWalk(p: GPart, acc: { plain: string[]; html: string[]; files: MailAttachmentInfoDTO[] }) {
  if (p.filename && p.body?.attachmentId) {
    acc.files.push({ id: p.body.attachmentId, name: p.filename, size: p.body.size ?? 0, contentType: p.mimeType ?? 'application/octet-stream' });
  } else if (p.mimeType === 'text/plain' && p.body?.data) acc.plain.push(b64u(p.body.data).toString('utf8'));
  else if (p.mimeType === 'text/html' && p.body?.data) acc.html.push(b64u(p.body.data).toString('utf8'));
  for (const c of p.parts ?? []) gWalk(c, acc);
}
function gItem(m: any): MailListItemDTO {
  const labels: string[] = m.labelIds ?? [];
  return {
    provider: 'google', id: m.id, threadId: m.threadId ?? null, from: parseAddress(gHeader(m.payload, 'From')), to: parseAddressList(gHeader(m.payload, 'To')),
    subject: gHeader(m.payload, 'Subject') ?? '', snippet: htmlToText(m.snippet ?? ''), date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : iso(gHeader(m.payload, 'Date')),
    unread: labels.includes('UNREAD'), hasAttachments: m.payload?.mimeType === 'multipart/mixed' || !!m.payload?.parts?.some((p: GPart) => p.filename),
    box: labels.includes('SENT') && !labels.includes('INBOX') ? 'sent' : 'inbox',
  };
}
/**
 * Lote de Gmail (multipart/mixed): hasta 100 GET en una sola petición HTTP. Devuelve el JSON de cada parte en el
 * mismo orden, o null si esa parte no fue 200.
 */
async function gmailBatch(at: string, paths: string[]): Promise<(any | null)[]> {
  if (!paths.length) return [];
  const b = `batch_${token(12)}`;
  const body = paths.map((p, k) => `--${b}\r\nContent-Type: application/http\r\nContent-ID: <i${k}>\r\n\r\nGET ${p}\r\n`).join('') + `--${b}--`;
  const res = await request(base('MAIL_GOOGLE_BATCH', 'https://gmail.googleapis.com/batch/gmail/v1'), {
    method: 'POST', headers: { authorization: `Bearer ${at}`, 'content-type': `multipart/mixed; boundary=${b}` }, body,
  });
  if (res.status === 401) throw new ProviderError(401, 'unauthorized', 'HTTP 401');
  if (!res.ok) throw new ProviderError(res.status, 'batch_failed', `HTTP ${res.status}`);
  const rb = /boundary="?([^";]+)"?/i.exec(res.headers.get('content-type') ?? '')?.[1];
  if (!rb) throw new ProviderError(502, 'batch_failed', 'Lote sin boundary');
  const out: (any | null)[] = new Array(paths.length).fill(null);
  for (const part of (await res.text()).split(`--${rb}`)) {
    const id = /Content-ID:\s*<?response-i(\d+)>?/i.exec(part)?.[1];
    const status = /HTTP\/[\d.]+\s+(\d{3})/.exec(part)?.[1];
    if (id == null || status !== '200') continue;
    const json = part.slice(part.indexOf('{'), part.lastIndexOf('}') + 1);
    try { out[Number(id)] = JSON.parse(json); } catch {}
  }
  return out;
}
/** Pide varios en paralelo, de a pocos (Gmail limita las ráfagas por usuario). */
async function inBatches<T, R>(list: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(list.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k]!); } }));
  return out;
}
function mime(out: ReplyOut, headers: Record<string, string | null>): string {
  const b = `chaggu_${token(12)}`;
  const head = Object.entries({
    To: out.to.map(fmtAddress).join(', '), ...(out.cc.length ? { Cc: out.cc.map(fmtAddress).join(', ') } : {}),
    Subject: encodeHeader(out.subject), 'MIME-Version': '1.0', ...headers,
  }).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  const text = Buffer.from(out.body, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  if (!out.files.length) return [...head, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', text].join('\r\n');
  const parts = [`--${b}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', text];
  for (const f of out.files) {
    const name = encodeHeader(f.name);
    parts.push(`--${b}`, `Content-Type: ${f.contentType}; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`, 'Content-Transfer-Encoding: base64', '',
      f.bytes.toString('base64').replace(/.{76}/g, '$&\r\n'));
  }
  parts.push(`--${b}--`);
  return [...head, `Content-Type: multipart/mixed; boundary="${b}"`, '', ...parts].join('\r\n');
}

/** Prioritarios u Otros en Outlook (solo en Recibidos). */
const outlookClass = (q: z.infer<typeof MailListQuery>) => (q.box !== 'inbox' || !q.category || q.category === 'any' ? null : q.category === 'primary' || q.category === 'focused' ? 'focused' : 'other');
/** Outlook: KQL para $search (texto, persona, fechas, adjuntos, categoría); $filter cuando no hay texto. */
export function graphListUrl(q: z.infer<typeof MailListQuery>): string {
  const folder = q.box === 'inbox' ? '/me/mailFolders/inbox/messages' : q.box === 'sent' ? '/me/mailFolders/sentitems/messages' : '/me/messages';
  const p = new URLSearchParams({ $top: String(PAGE), $select: 'id,conversationId,subject,bodyPreview,from,toRecipients,receivedDateTime,sentDateTime,isRead,hasAttachments,inferenceClassification' });
  if (q.q || q.from || q.to || q.label) {
    const k: string[] = [];
    if (q.q) k.push(q.q.replace(/"/g, ''));
    if (q.from) k.push(`from:${quoteQ(q.from)}`);
    if (q.to) k.push(`to:${quoteQ(q.to)}`);
    if (q.label) k.push(`category:${quoteQ(q.label)}`);
    if (q.after) k.push(`received>=${q.after}`);
    if (q.before) k.push(`received<=${q.before}`);
    if (truthy(q.attachments)) k.push('hasattachments:true');
    p.set('$search', `"${k.join(' AND ').replace(/"/g, "'")}"`);
  } else {
    const f: string[] = [];
    if (q.after) f.push(`receivedDateTime ge ${q.after}T00:00:00Z`);
    if (q.before) f.push(`receivedDateTime lt ${nextDay(q.before)}T00:00:00Z`);
    if (truthy(q.attachments)) f.push('hasAttachments eq true');
    if (truthy(q.unread)) f.push('isRead eq false');
    const ic = outlookClass(q);
    if (ic) f.push(`inferenceClassification eq '${ic}'`);
    if (f.length) p.set('$filter', f.join(' and '));
    p.set('$orderby', 'receivedDateTime desc');
  }
  return `${msApi()}${folder}?${p}`;
}
const msAddr = (r: any): MailAddressDTO | null => (r?.emailAddress?.address ? { name: r.emailAddress.name || null, email: String(r.emailAddress.address).toLowerCase() } : null);
const msAddrs = (l: any[] | undefined) => (l ?? []).map(msAddr).filter((x): x is MailAddressDTO => !!x);
function msItem(m: any, box: 'inbox' | 'sent'): MailListItemDTO {
  return {
    provider: 'microsoft', id: m.id, threadId: m.conversationId ?? null, from: msAddr(m.from), to: msAddrs(m.toRecipients), subject: m.subject ?? '',
    snippet: flat(m.bodyPreview ?? ''), date: m.receivedDateTime ?? m.sentDateTime ?? null, unread: m.isRead === false, hasAttachments: !!m.hasAttachments, box,
  };
}
const msRecip = (a: MailAddressDTO) => ({ emailAddress: { address: a.email, ...(a.name ? { name: a.name } : {}) } });
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const PROVIDERS: Record<MailProvider, Provider> = {
  google: {
    label: 'Gmail',
    configured: () => !!(config.google.clientId && config.google.clientSecret),
    authorize: (state, verifier) => `${base('MAIL_GOOGLE_AUTH', 'https://accounts.google.com/o/oauth2/v2/auth')}?${new URLSearchParams({
      client_id: config.google.clientId, redirect_uri: ssoRedirect('google'), response_type: 'code', scope: GOOGLE_MAIL_SCOPE,
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state, code_challenge: s256(verifier), code_challenge_method: 'S256',
    })}`,
    exchange: async (code, verifier) => toTokens(await form(base('MAIL_GOOGLE_TOKEN', 'https://oauth2.googleapis.com/token'), {
      grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: ssoRedirect('google'), client_id: config.google.clientId, client_secret: config.google.clientSecret,
    })),
    refresh: async (refresh) => toTokens(await form(base('MAIL_GOOGLE_TOKEN', 'https://oauth2.googleapis.com/token'), {
      grant_type: 'refresh_token', refresh_token: refresh, client_id: config.google.clientId, client_secret: config.google.clientSecret,
    }), refresh),
    async revoke(t) { await request(`${base('MAIL_GOOGLE_REVOKE', 'https://oauth2.googleapis.com/revoke')}?token=${encodeURIComponent(t)}`, { method: 'POST' }).catch(() => {}); },
    async list(at, q) {
      const p = new URLSearchParams({ maxResults: String(PAGE), q: gmailQuery(q) });
      if (q.page) p.set('pageToken', q.page);
      const j = await api(at, `${gApi()}/users/me/messages?${p}`);
      const ids: string[] = (j.messages ?? []).map((m: any) => m.id);
      const meta = `format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date&fields=${encodeURIComponent('id,threadId,labelIds,snippet,internalDate,payload(mimeType,headers,parts(filename))')}`;
      // Una sola petición HTTP para los 50 (lote de Gmail); si el lote falla, de a 10 en paralelo.
      const one = async (id: string) => gItem(await api(at, `${gApi()}/users/me/messages/${encodeURIComponent(id)}?${meta}`));
      let items: MailListItemDTO[];
      try { items = (await gmailBatch(at, ids.map((id) => `/gmail/v1/users/me/messages/${encodeURIComponent(id)}?${meta}`))).map((m, k) => (m ? gItem(m) : null)) as MailListItemDTO[]; }
      catch { items = await inBatches(ids, 10, one); }
      // Lo que el lote no trajo (p. ej. 429 en un item) se pide suelto.
      for (let k = 0; k < ids.length; k++) if (!items[k]) items[k] = await one(ids[k]!);
      return { items, nextPage: j.nextPageToken ?? null };
    },
    async get(at, id) {
      const m = await api(at, `${gApi()}/users/me/messages/${encodeURIComponent(id)}?format=full`);
      const acc = { plain: [] as string[], html: [] as string[], files: [] as MailAttachmentInfoDTO[] };
      if (m.payload) gWalk(m.payload, acc);
      const body = acc.plain.length ? acc.plain.join('\n\n').trim() : htmlToText(acc.html.join('\n'));
      return {
        ...gItem(m), hasAttachments: acc.files.length > 0, cc: parseAddressList(gHeader(m.payload, 'Cc')), body: clip(body, MAX_BODY), attachments: acc.files, html: acc.html.length ? acc.html.join('\n') : null,
        internetId: gHeader(m.payload, 'Message-ID') ?? gHeader(m.payload, 'Message-Id'), references: gHeader(m.payload, 'References'),
      };
    },
    async attachment(at, messageId, attachmentId) {
      const j = await api(at, `${gApi()}/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
      return { bytes: b64u(j.data ?? '') };
    },
    async unread(at) {
      const p = new URLSearchParams({ maxResults: String(UNREAD_CAP), q: 'in:inbox category:primary is:unread', fields: 'messages(id)' });
      return ((await api(at, `${gApi()}/users/me/messages?${p}`)).messages ?? []).length;
    },
    async reply(at, o, out) {
      const raw = mime(out, { 'In-Reply-To': o.internetId, References: [o.references, o.internetId].filter(Boolean).join(' ') || null });
      await api(at, `${gApi()}/users/me/messages/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ raw: Buffer.from(raw, 'utf8').toString('base64url'), ...(o.threadId ? { threadId: o.threadId } : {}) }),
      });
    },
  },
  microsoft: {
    label: 'Outlook',
    configured: () => !!(config.microsoft.clientId && config.microsoft.clientSecret),
    authorize: (state, verifier) => `${base('MAIL_MS_AUTH', 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize')}?${new URLSearchParams({
      client_id: config.microsoft.clientId, redirect_uri: ssoRedirect('microsoft'), response_type: 'code', scope: MS_MAIL_SCOPE, prompt: 'select_account',
      state, code_challenge: s256(verifier), code_challenge_method: 'S256',
    })}`,
    exchange: async (code, verifier) => toTokens(await form(base('MAIL_MS_TOKEN', 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token'), {
      grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: ssoRedirect('microsoft'), client_id: config.microsoft.clientId, client_secret: config.microsoft.clientSecret, scope: MS_MAIL_SCOPE,
    })),
    refresh: async (refresh) => toTokens(await form(base('MAIL_MS_TOKEN', 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token'), {
      grant_type: 'refresh_token', refresh_token: refresh, client_id: config.microsoft.clientId, client_secret: config.microsoft.clientSecret, scope: MS_MAIL_SCOPE,
    }), refresh),
    async list(at, q) {
      // La página siguiente es la URL que da Graph: solo se sigue si es de Graph (nada de URLs arbitrarias).
      let url = graphListUrl(q);
      if (q.page) {
        if (!q.page.startsWith(`${msApi()}/`)) throw badRequest('Página inválida');
        url = q.page;
      }
      const j = await api(at, url, { headers: { ConsistencyLevel: 'eventual' } });
      let items = (j.value ?? []).map((m: any) => msItem(m, q.box === 'sent' ? 'sent' : 'inbox'));
      // Con $search Graph no deja filtrar por leído: se filtra aquí.
      const searching = !!(q.q || q.from || q.to || q.label);
      if (truthy(q.unread) && searching) items = items.filter((i: MailListItemDTO) => i.unread);
      const ic = outlookClass(q);
      if (ic && searching) {
        const cls = new Map<string, string>((j.value ?? []).map((m: any) => [m.id, m.inferenceClassification ?? 'focused']));
        items = items.filter((i: MailListItemDTO) => cls.get(i.id) === ic);
      }
      return { items, nextPage: j['@odata.nextLink'] ?? null };
    },
    async unread(at) {
      const p = new URLSearchParams({ $filter: "isRead eq false and inferenceClassification eq 'focused'", $top: '1', $count: 'true', $select: 'id' });
      const j = await api(at, `${msApi()}/me/mailFolders/inbox/messages?${p}`, { headers: { ConsistencyLevel: 'eventual' } });
      return Math.min(UNREAD_CAP, Number(j['@odata.count'] ?? 0));
    },
    async get(at, id) {
      const sel = 'id,conversationId,subject,bodyPreview,body,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,hasAttachments,internetMessageId';
      // Una sola petición: el correo y la lista de adjuntos (sin su contenido).
      const m = await api(at, `${msApi()}/me/messages/${encodeURIComponent(id)}?$select=${sel}&$expand=${encodeURIComponent('attachments($select=id,name,size,contentType,isInline)')}`, { headers: { prefer: 'outlook.body-content-type="text"' } });
      const files = m.hasAttachments
        ? ((Array.isArray(m.attachments) ? m.attachments : (await api(at, `${msApi()}/me/messages/${encodeURIComponent(id)}/attachments?$select=id,name,size,contentType,isInline`)).value) ?? [])
          .filter((a: any) => !a.isInline && a['@odata.type'] !== '#microsoft.graph.itemAttachment')
          .map((a: any) => ({ id: a.id, name: a.name ?? 'adjunto', size: Number(a.size ?? 0), contentType: a.contentType ?? 'application/octet-stream' }))
        : [];
      const raw = m.body?.content ?? '';
      // Aunque se pida texto, algunos buzones devuelven HTML: se limpia igual.
      const body = m.body?.contentType === 'html' || /<(p|div|br|html|body|table|span)\b/i.test(raw) ? htmlToText(raw) : String(raw).trim();
      return { ...msItem(m, 'inbox'), cc: msAddrs(m.ccRecipients), body: clip(body, MAX_BODY), attachments: files, internetId: m.internetMessageId ?? null, references: null };
    },
    async html(at, id) {
      const m = await api(at, `${msApi()}/me/messages/${encodeURIComponent(id)}?$select=body`);
      return m.body?.contentType === 'html' && m.body.content ? String(m.body.content) : null;
    },
    async attachment(at, messageId, attachmentId) {
      const res = await request(`${msApi()}/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`, { headers: { authorization: `Bearer ${at}` } }, 60_000);
      if (!res.ok) throw new ProviderError(res.status, 'attachment_failed', `Outlook respondió HTTP ${res.status}`);
      return { bytes: Buffer.from(await res.arrayBuffer()) };
    },
    async reply(at, o, out) {
      // Graph acepta adjuntos en línea hasta ~3 MB en total.
      const total = out.files.reduce((n, f) => n + f.bytes.length, 0);
      if (total > 3 * 1024 * 1024) throw new ApiError(413, 'attachments_too_large', 'Outlook solo deja adjuntar hasta 3 MB desde chaggu. Comparte el archivo como enlace.');
      await api(at, `${msApi()}/me/messages/${encodeURIComponent(o.externalId)}/reply`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            toRecipients: out.to.map(msRecip), ccRecipients: out.cc.map(msRecip),
            attachments: out.files.map((f) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: f.name, contentType: f.contentType, contentBytes: f.bytes.toString('base64') })),
          },
          comment: escapeHtml(out.body).replace(/\n/g, '<br>'),
        }),
      });
    },
  },
};
export const isMailProvider = (p: string): p is MailProvider => p === 'google' || p === 'microsoft';
const missing = (p: MailProvider) => (!mailEnabled() ? OFF_REASON : PROVIDERS[p].configured() ? null : `Falta configurar ${PROVIDERS[p].label} en el servidor`);

// ---------- Conexiones ----------
export async function listConnections(userId: string): Promise<MailConnectionDTO[]> {
  const { rows } = await pool.query('SELECT provider, account_email, status FROM mail_connections WHERE user_id = $1', [userId]);
  return (['google', 'microsoft'] as const).map((p) => {
    const r = rows.find((x) => x.provider === p);
    const why = missing(p);
    return { provider: p, label: PROVIDERS[p].label, available: !why, unavailableReason: why, status: r ? r.status : 'none', accountEmail: r?.account_email ?? null };
  });
}

export async function startConnect(userId: string, provider: MailProvider, opts: { platform: string; redirectScheme?: string | null; proofChallenge: string }) {
  const why = missing(provider);
  if (why) throw new ApiError(503, 'provider_unavailable', why);
  const state = `mail_${token(32)}`;
  const verifier = token(48);
  await pool.query(
    `INSERT INTO mail_flows (state_hash, user_id, provider, verifier, platform, native_scheme, proof_challenge, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(mins => $8))`,
    [sha(state), userId, provider, verifier, opts.platform, opts.redirectScheme ?? null, opts.proofChallenge, FLOW_TTL_MIN],
  );
  return { url: PROVIDERS[provider].authorize(state, verifier) };
}
export const isMailState = (state: string | undefined) => !!state && state.startsWith('mail_');

function backTo(platform: string, scheme: string | null, params: Record<string, string>) {
  const q = new URLSearchParams({ mail: '1', ...params });
  if (platform === 'web' || platform === 'desktop') return `${config.publicOrigin}/correo?${q}`;
  return `${scheme || 'chaggu'}://mail/connected?${q}`;
}

/** El callback nunca activa credenciales: entrega un recibo que solo canjea el cliente que tiene la prueba. */
export async function finishConnect(query: Record<string, string | undefined>, provider: MailProvider): Promise<string> {
  if (!mailEnabled()) return backTo('web', null, { error: 'disabled' });
  const { rows } = await pool.query('DELETE FROM mail_flows WHERE state_hash = $1 AND provider = $2 RETURNING *', [sha(query.state ?? ''), provider]);
  const flow = rows[0];
  if (!flow || new Date(flow.expires_at) < new Date()) return backTo('web', null, { error: 'expired' });
  const back = (p: Record<string, string>) => backTo(flow.platform, flow.native_scheme, { provider: flow.provider, ...p });
  if (query.error) return back({ error: query.error === 'access_denied' ? 'cancelled' : 'denied' });
  if (!query.code) return back({ error: 'no_code' });
  try {
    const tk = await PROVIDERS[provider].exchange(query.code, flow.verifier);
    if (!tk.access) return back({ error: 'failed' });
    const receipt = token(32);
    await pool.query('DELETE FROM mail_confirmations WHERE expires_at < now()');
    await pool.query(
      `INSERT INTO mail_confirmations (receipt_hash, user_id, provider, proof_challenge, tokens_enc, expires_at)
       VALUES ($1,$2,$3,$4,$5, now() + make_interval(secs => $6))`,
      [sha(receipt), flow.user_id, provider, flow.proof_challenge, seal(JSON.stringify(tk)), CONFIRM_TTL_SECONDS],
    );
    return back({ receipt });
  } catch {
    // Los errores del proveedor pueden traer códigos o credenciales: nunca se registran.
    return back({ error: 'failed' });
  }
}

export async function confirmConnect(userId: string, input: { receipt: string; proofVerifier: string }) {
  if (!mailEnabled()) throw new ApiError(503, 'provider_unavailable', OFF_REASON);
  return tx(async (c) => {
    const { rows } = await c.query(
      `DELETE FROM mail_confirmations WHERE receipt_hash = $1 AND user_id = $2 AND proof_challenge = $3 AND expires_at > now() RETURNING *`,
      [sha(input.receipt), userId, s256(input.proofVerifier)],
    );
    const p = rows[0];
    if (!p) throw new ApiError(409, 'mail_confirmation_invalid', 'La conexión venció o no pertenece a esta sesión. Conecta el correo de nuevo.');
    const tk: Tokens = JSON.parse(open(p.tokens_enc)!);
    await c.query(
      `INSERT INTO mail_connections (user_id, provider, account_email, scopes, access_token_enc, refresh_token_enc, expires_at, status, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(secs => $7), 'active', now())
       ON CONFLICT (user_id, provider) DO UPDATE SET account_email = EXCLUDED.account_email, scopes = EXCLUDED.scopes,
         access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc, expires_at = EXCLUDED.expires_at,
         status = 'active', updated_at = now(), generation = gen_random_uuid()`,
      [userId, p.provider, tk.email, tk.scope, seal(tk.access), seal(tk.refresh), Math.max(60, tk.expiresIn - 60)],
    );
    await audit(c, userId, 'mail.connected', { type: 'user', id: userId }, { provider: p.provider });
    return { ok: true as const, provider: p.provider as MailProvider };
  });
}

export async function disconnect(userId: string, provider: MailProvider) {
  bumpUser(userId);
  await pool.query('DELETE FROM mail_flows WHERE user_id = $1 AND provider = $2', [userId, provider]);
  await pool.query('DELETE FROM mail_confirmations WHERE user_id = $1 AND provider = $2', [userId, provider]);
  const { rows } = await pool.query('DELETE FROM mail_connections WHERE user_id = $1 AND provider = $2 RETURNING access_token_enc, refresh_token_enc', [userId, provider]);
  if (rows[0]) { const t = open(rows[0].refresh_token_enc) ?? open(rows[0].access_token_enc); if (t) await PROVIDERS[provider].revoke?.(t); }
  // Las respuestas programadas de esa cuenta ya no pueden salir.
  await pool.query(
    `UPDATE mail_replies r SET status = 'cancelled', error = 'Se desconectó el correo' FROM shared_emails e
      WHERE r.email_id = e.id AND r.status = 'queued' AND r.user_id = $1 AND e.provider = $2`, [userId, provider]);
  return { ok: true };
}

const reconnect = (p: MailProvider) => new ApiError(409, 'reconnect_required', `Vuelve a conectar ${PROVIDERS[p].label}: el permiso venció o se revocó`);
/** Token vigente; si venció se renueva con compare-and-swap. Si el proveedor lo rechaza, queda «reconectar». */
async function accessToken(userId: string, provider: MailProvider): Promise<{ access: string; email: string | null }> {
  const r = (await pool.query('SELECT * FROM mail_connections WHERE user_id = $1 AND provider = $2', [userId, provider])).rows[0];
  if (!r) throw new ApiError(409, 'not_connected', `Conecta tu ${PROVIDERS[provider].label} para ver tus correos`);
  if (r.status === 'reconnect') throw reconnect(provider);
  if (r.expires_at && new Date(r.expires_at).getTime() > Date.now() + 30_000) return { access: open(r.access_token_enc)!, email: r.account_email };
  const refresh = open(r.refresh_token_enc);
  const mark = () => pool.query("UPDATE mail_connections SET status = 'reconnect', updated_at = now() WHERE user_id = $1 AND provider = $2 AND generation = $3", [userId, provider, r.generation]);
  if (!refresh) { await mark(); throw reconnect(provider); }
  try {
    const tk = await PROVIDERS[provider].refresh(refresh);
    await pool.query(
      `UPDATE mail_connections SET access_token_enc = $4, refresh_token_enc = COALESCE($5, refresh_token_enc), expires_at = now() + make_interval(secs => $6),
         account_email = COALESCE($7, account_email), updated_at = now()
       WHERE user_id = $1 AND provider = $2 AND generation = $3`,
      [userId, provider, r.generation, seal(tk.access), seal(tk.refresh), Math.max(60, tk.expiresIn - 60), tk.email],
    );
    return { access: tk.access, email: tk.email ?? r.account_email };
  } catch (e) {
    if (e instanceof ProviderError && e.status >= 400 && e.status < 500) { await mark(); throw reconnect(provider); }
    throw new ApiError(502, 'provider_unreachable', `${PROVIDERS[provider].label} no respondió; inténtalo de nuevo`);
  }
}
/** Llama al proveedor; un 401 marca la conexión para reconectar. */
async function withProvider<T>(userId: string, provider: MailProvider, fn: (at: string, email: string | null) => Promise<T>): Promise<T> {
  if (!mailEnabled()) throw new ApiError(503, 'provider_unavailable', OFF_REASON);
  const { access, email } = await accessToken(userId, provider);
  try { return await fn(access, email); } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e instanceof ProviderError) {
      if (e.status === 401) { await pool.query("UPDATE mail_connections SET status = 'reconnect' WHERE user_id = $1 AND provider = $2", [userId, provider]); throw reconnect(provider); }
      if (e.status === 403) throw new ApiError(403, 'mail_forbidden', `${PROVIDERS[provider].label} no dio permiso para esto. Vuelve a conectar y acepta todos los permisos.`);
      if (e.status === 404) throw notFound('Correo');
      if (e.status === 429) throw new ApiError(429, 'provider_busy', `${PROVIDERS[provider].label} pidió esperar un momento. Inténtalo de nuevo.`);
      if (e.status === 400) throw badRequest(`${PROVIDERS[provider].label} no entendió la búsqueda. Prueba con menos filtros.`);
    }
    throw new ApiError(502, 'provider_unreachable', `${PROVIDERS[provider].label} no respondió; inténtalo de nuevo`);
  }
}

// ---------- Bandeja en vivo ----------
export async function listMail(userId: string, q: z.infer<typeof MailListQuery>, fresh = false): Promise<MailListDTO> {
  const key = `${userId}:${genOf(userId)}:${createHash('sha1').update(JSON.stringify(q)).digest('base64url')}`;
  const load = () => withProvider(userId, q.provider, async (at, email) => ({ ...(await PROVIDERS[q.provider].list(at, q)), accountEmail: email }));
  if (fresh || !mailEnabled()) { const r = await load(); listCache.set(key, { body: Buffer.from(JSON.stringify(r)) }); return r; }
  return cached(listCache, key, load);
}
/**
 * Sin leer para el riel de la web: suma de Gmail y Outlook conectados (cada uno hasta UNREAD_CAP).
 * Un proveedor caído o por reconectar cuenta 0 y no rompe al otro. Se guarda 60 s en memoria.
 */
const unreadCache = new Map<string, { at: number; n: number }>();
export async function unreadCount(userId: string): Promise<{ unread: number }> {
  if (!mailEnabled()) return { unread: 0 };
  const hit = unreadCache.get(userId);
  if (hit && Date.now() - hit.at < 60_000) return { unread: hit.n };
  const { rows } = await pool.query("SELECT provider FROM mail_connections WHERE user_id = $1 AND status = 'active'", [userId]);
  const each = await Promise.all(rows.map((r) => withProvider(userId, r.provider as MailProvider, (at) => PROVIDERS[r.provider as MailProvider].unread(at)).catch(() => 0)));
  const n = each.reduce((a, b) => a + b, 0);
  if (unreadCache.size > 5000) unreadCache.clear();
  unreadCache.set(userId, { at: Date.now(), n });
  return { unread: n };
}
/** El correo completo, en vivo; se guarda unos minutos en memoria (vista previa → compartir no pide dos veces). */
async function fullMail(userId: string, provider: MailProvider, id: string): Promise<Full> {
  if (!mailEnabled()) throw new ApiError(503, 'provider_unavailable', OFF_REASON);
  return cached(msgCache, `${userId}:${genOf(userId)}:${provider}:${id}`, () => withProvider(userId, provider, (at) => PROVIDERS[provider].get(at, id)));
}
export async function getMail(userId: string, provider: MailProvider, id: string): Promise<MailMessageDTO> {
  const { internetId: _i, references: _r, html: _h, ...m } = await fullMail(userId, provider, id);
  return m;
}

/** El HTML limpio de un correo de tu propio buzón (vista previa antes de llevarlo al chat); null si solo trae texto. */
export async function liveHtml(userId: string, provider: MailProvider, id: string): Promise<{ html: string | null }> {
  if (!mailEnabled()) throw new ApiError(503, 'provider_unavailable', OFF_REASON);
  const raw = provider === 'microsoft'
    ? await cached(msgCache, `${userId}:${genOf(userId)}:html:${id}`, () => withProvider(userId, 'microsoft', (at) => PROVIDERS.microsoft.html!(at, id)))
    : (await fullMail(userId, provider, id)).html ?? null;
  return { html: raw ? safeHtml(raw, imgProxyUrl) : null };
}

// ---------- Correo compartido ----------
/**
 * La tarjeta (resumen, sin cuerpo) o el correo completo (full). En vivo y en las tarjetas va sin cuerpo:
 * así los eventos del chat, que quedan guardados, no repiten el texto del correo en cada comentario.
 */
async function load(db: Db, id: string, viewerId?: string, full = false): Promise<SharedMailDTO> {
  const r = (await loadMany(db, [id], viewerId, full))[0];
  if (!r) throw notFound('Correo');
  return r;
}
async function loadMany(db: Db, ids: string[], viewerId?: string, full = false): Promise<SharedMailDTO[]> {
  const { rows } = await db.query(
    `SELECT e.id, e.conversation_id, e.shared_by, e.provider, e.account_email, e.external_id, e.direction, e.from_name, e.from_email, e.to_list, e.cc_list,
            e.subject, e.snippet, e.body_trimmed, ${full ? 'e.body_text,' : ''} e.sent_at, e.attachments, e.message_id, e.comment, e.status, e.replied_at, e.replied_by,
            e.issue_id, e.created_at, e.meta,
            (SELECT count(*) FROM shared_email_comments x WHERE x.email_id = e.id)::int AS comment_count,
            (SELECT json_agg(y ORDER BY y.created_at) FROM (SELECT * FROM shared_email_comments x WHERE x.email_id = e.id ORDER BY x.created_at DESC LIMIT 2) y) AS last_comments,
            (SELECT json_build_object('id', r.id, 'sendAt', r.send_at, 'userId', r.user_id) FROM mail_replies r WHERE r.email_id = e.id AND r.status = 'queued' LIMIT 1) AS queued
       FROM shared_emails e WHERE e.id = ANY($1::uuid[])`, [ids]);
  const byId = new Map(rows.map((r) => [r.id as string, r]));
  return ids.map((id) => byId.get(id)).filter(Boolean).map((r: any): SharedMailDTO => ({
    id: r.id, conversationId: r.conversation_id, sharedBy: r.shared_by, provider: r.provider, accountEmail: r.account_email, direction: r.direction,
    from: r.from_email || r.from_name ? { name: r.from_name, email: r.from_email ?? '' } : null, to: r.to_list, cc: r.cc_list, subject: r.subject, snippet: r.snippet, body: full ? r.body_text : '', full, trimmed: r.body_trimmed,
    sentAt: iso(r.sent_at), attachments: r.attachments, messageId: r.message_id, comment: r.comment, status: r.status, repliedAt: iso(r.replied_at), repliedBy: r.replied_by,
    scheduledReply: r.queued && (!viewerId || r.queued.userId === viewerId) ? { id: r.queued.id, sendAt: iso(r.queued.sendAt)! } : null,
    issueId: r.issue_id, commentCount: r.comment_count ?? 0,
    wa: r.provider === 'whatsapp' ? r.meta ?? null : null,
    webLink: viewerId && viewerId === r.shared_by && r.provider !== 'whatsapp' ? (r.provider === 'google'
      ? `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(r.account_email ?? '')}#all/${encodeURIComponent(r.external_id)}`
      : `https://outlook.office.com/mail/deeplink/read/${encodeURIComponent(r.external_id)}`) : null,
    lastComments: (r.last_comments ?? []).map(commentDTO), createdAt: iso(r.created_at)!,
  }));
}
const commentDTO = (r: any): SharedMailCommentDTO => ({ id: r.id, emailId: r.email_id, authorId: r.author_id, body: r.body, createdAt: iso(r.created_at)! });
/** En vivo va igual para todos: la respuesta programada solo la ve su dueño al pedir la tarjeta. */
const publish = async (c: Tx, id: string) => { const email = await load(c, id); await appendEvent(c, email.conversationId, { type: 'mail.updated', conversationId: email.conversationId, email: { ...email, scheduledReply: null, webLink: null } }); return email; };

/** Leer: miembro de la conversación que ya estaba cuando se compartió (historial visible). */
async function readable(db: Db, userId: string, id: string, need: 'read' | 'post' = 'read', lock = false) {
  const e = (await db.query(`SELECT e.*, m.seq FROM shared_emails e LEFT JOIN messages m ON m.id = e.message_id WHERE e.id = $1 ${lock ? 'FOR UPDATE OF e' : ''}`, [id])).rows[0];
  if (!e) throw notFound('Correo');
  const a = await conversationAccess(db, userId, e.conversation_id, need, lock);
  if (e.seq != null && e.seq <= a.historyFromSeq) throw notFound('Correo');
  return e;
}

/** Llevar un correo a uno o varios chats (hasta 10). Se pide al proveedor una sola vez; cada chat tiene su tarjeta e hilo. */
export async function shareMail(userId: string, input: z.infer<typeof ShareMailInput>) {
  const targets = [...new Set(input.conversationIds ?? (input.conversationId ? [input.conversationId] : []))];
  for (const cid of targets) {
    const a = await conversationAccess(pool, userId, cid, 'post');
    if (a.workspaceRole === 'guest') throw forbidden('Las personas invitadas de fuera no pueden traer correos a este chat');
  }
  const full = await fullMail(userId, input.provider, input.messageId);
  const clean = cleanBody(full.body);
  const conn = (await pool.query('SELECT account_email FROM mail_connections WHERE user_id = $1 AND provider = $2', [userId, input.provider])).rows[0];
  const mine = conn?.account_email?.toLowerCase() ?? null;
  const direction = full.box === 'sent' || (!!mine && full.from?.email === mine) ? 'out' : 'in';
  const emails: SharedMailDTO[] = [];
  for (const cid of targets) {
    emails.push(await tx(async (c) => {
      const a = await conversationAccess(c, userId, cid, 'post', true);
      // El tema solo aplica al chat desde el que se compartió.
      const topicId = input.topicId && cid === (input.conversationId ?? targets[0]) ? input.topicId : null;
      if (topicId) {
        const { rowCount } = await c.query('SELECT 1 FROM conversation_topics WHERE id = $1 AND conversation_id = $2 AND archived_at IS NULL', [topicId, cid]);
        if (!rowCount) throw badRequest('Ese tema no está activo en esta conversación');
      }
      const ins = await c.query(
        `INSERT INTO shared_emails (conversation_id, shared_by, provider, account_email, external_id, thread_id, internet_id, direction, from_name, from_email,
           to_list, cc_list, subject, snippet, body_text, body_trimmed, sent_at, attachments, comment)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$19,$16,$17,$18) RETURNING id`,
        [cid, userId, input.provider, mine, full.id, full.threadId, [full.internetId, full.references].filter(Boolean).length ? JSON.stringify({ id: full.internetId, refs: full.references }) : null,
          direction, full.from?.name ?? null, full.from?.email ?? null, JSON.stringify(full.to), JSON.stringify(full.cc), clip(full.subject, 500),
          clip(flat(clean.text || full.snippet), 300), clean.text, full.date, JSON.stringify(full.attachments), input.comment || null, clean.trimmed],
      );
      const id: string = ins.rows[0].id;
      const m = await appendMessage(c, {
        conversationId: cid, authorId: userId, kind: 'system', topicId,
        body: sys('mail.shared', { emailId: id, provider: input.provider, subject: clip(full.subject, 200), from: full.from?.name ?? full.from?.email ?? null, ...(input.comment ? { comment: clip(input.comment, 4000) } : {}) }),
      });
      await c.query('UPDATE shared_emails SET message_id = $2 WHERE id = $1', [id, m.id]);
      await audit(c, userId, 'mail.shared', { type: 'conversation', id: cid, workspaceId: a.workspaceId }, { provider: input.provider, attachments: full.attachments.length, chats: targets.length });
      return publish(c, id);
    }));
  }
  // Un solo chat (clientes anteriores): la tarjeta; varios: la lista.
  return input.conversationIds ? { emails } : emails[0]!;
}

export async function getShared(userId: string, id: string, full = false) {
  await readable(pool, userId, id);
  return load(pool, id, userId, full);
}
/** Tarjetas de un chat en una sola petición (resumen, sin cuerpo). Las que no puedes ver no vuelven. */
export async function getSharedMany(userId: string, ids: string[]) {
  const { rows } = await pool.query(
    `SELECT e.id FROM shared_emails e
       JOIN conversation_memberships cm ON cm.conversation_id = e.conversation_id AND cm.user_id = $2 AND cm.removed_at IS NULL
       LEFT JOIN messages m ON m.id = e.message_id
      WHERE e.id = ANY($1::uuid[]) AND (m.seq IS NULL OR m.seq > cm.history_from_seq)`, [ids, userId]);
  const ok = new Set(rows.map((r) => r.id as string));
  return { emails: await loadMany(pool, ids.filter((id) => ok.has(id)), userId) };
}
/** El correo tal como está en el buzón (con historial citado y firma), en vivo y sin guardarlo. */
export async function original(userId: string, id: string) {
  const e = await readable(pool, userId, id);
  if (e.provider === 'whatsapp') return { body: e.body_text as string };
  try {
    const m = await fullMail(e.shared_by, e.provider, e.external_id);
    return { body: m.body };
  } catch (err: any) {
    if (e.shared_by !== userId && ['not_connected', 'reconnect_required', 'mail_forbidden'].includes(err?.code)) {
      throw new ApiError(409, 'original_unavailable', 'El correo completo no está disponible: quien lo compartió desconectó su correo.');
    }
    throw err;
  }
}

/**
 * El HTML del correo para verlo con su diseño, en vivo como el original. Se quitan scripts, formularios, marcos,
 * atributos on* y enlaces javascript:; además la web lo pinta en un iframe con sandbox sin scripts.
 */
export async function html(userId: string, id: string) {
  const e = await readable(pool, userId, id);
  if (e.provider === 'whatsapp') return { html: null };
  try {
    const raw = e.provider === 'microsoft'
      ? await cached(msgCache, `${e.shared_by}:${genOf(e.shared_by)}:html:${e.external_id}`, () => withProvider(e.shared_by, 'microsoft', (at) => PROVIDERS.microsoft.html!(at, e.external_id)))
      : (await fullMail(e.shared_by, e.provider, e.external_id)).html ?? null;
    return { html: raw ? safeHtml(raw, imgProxyUrl) : null };
  } catch (err: any) {
    if (e.shared_by !== userId && ['not_connected', 'reconnect_required', 'mail_forbidden'].includes(err?.code)) {
      throw new ApiError(409, 'original_unavailable', 'El correo completo no está disponible: quien lo compartió desconectó su correo.');
    }
    throw err;
  }
}
// ---------- Proxy de imágenes del correo ----------
// URL firmada (sin sesión: un <img> no manda el token): /api/v1/mail/img/<url en base64url>.<firma>.
const imgSig = (url: string) => createHmac('sha256', config.jwtSecret).update(`mail-img:${url}`).digest('base64url').slice(0, 22);
export const imgProxyUrl = (url: string) => `/api/v1/mail/img/${Buffer.from(url).toString('base64url')}.${imgSig(url)}`;
const MAX_IMG = 3 * 1024 * 1024;
export async function proxyImage(token: string): Promise<{ body: Buffer; contentType: string } | null> {
  const [b, sig] = token.split('.');
  if (!b || !sig) return null;
  const url = Buffer.from(b, 'base64url').toString('utf8');
  const want = imgSig(url);
  if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  const got = await safeGet(url, 'image/*', MAX_IMG).catch(() => null);
  if (!got || got.status !== 200 || got.body.length >= MAX_IMG) return null;
  const kind = sniffImage(got.body);
  return kind ? { body: got.body, contentType: kind.type } : null;
}

export async function listComments(userId: string, id: string) {
  await readable(pool, userId, id);
  const { rows } = await pool.query('SELECT * FROM shared_email_comments WHERE email_id = $1 ORDER BY created_at LIMIT 500', [id]);
  return { comments: rows.map(commentDTO) };
}

/** Comentar al equipo: quien puede escribir en el chat. Jorge (el remitente) nunca ve esto. */
export async function comment(userId: string, id: string, body: string) {
  return tx(async (c) => {
    const e = await readable(c, userId, id, 'post', true);
    const ins = await c.query('INSERT INTO shared_email_comments (email_id, author_id, body) VALUES ($1,$2,$3) RETURNING *', [id, userId, body]);
    await c.query('UPDATE shared_emails SET updated_at = now() WHERE id = $1', [id]);
    const actorName = (await c.query('SELECT name FROM users WHERE id = $1', [userId])).rows[0]?.name ?? '';
    await bumpCommentNotice(c, { kind: 'mail', conversationId: e.conversation_id, itemId: id, title: e.subject || '(sin asunto)', actorId: userId, actorName, body, extra: { provider: e.provider } });
    const email = await publish(c, id);
    return { comment: commentDTO(ins.rows[0]), email };
  });
}

/** Adjunto bajo demanda: se baja del buzón de quien compartió el correo y se entrega sin guardarlo. */
export async function fetchAttachment(userId: string, id: string, attachmentId: string) {
  const e = await readable(pool, userId, id);
  if (e.provider === 'whatsapp') throw notFound('Adjunto');
  const info = (e.attachments as MailAttachmentInfoDTO[]).find((x) => x.id === attachmentId);
  if (!info) throw notFound('Adjunto');
  if (info.size > MAX_ATTACHMENT) throw new ApiError(413, 'attachment_too_large', 'Este adjunto pesa más de 25 MB. Ábrelo desde el correo.');
  try {
    const { bytes } = await withProvider(e.shared_by, e.provider, (at) => PROVIDERS[e.provider as MailProvider].attachment(at, e.external_id, attachmentId));
    return { bytes, name: info.name, contentType: info.contentType || 'application/octet-stream' };
  } catch (err: any) {
    if (e.shared_by !== userId && ['not_connected', 'reconnect_required', 'mail_forbidden'].includes(err?.code)) {
      const name = (await pool.query('SELECT name FROM users WHERE id = $1', [e.shared_by])).rows[0]?.name?.split(' ')[0] ?? '';
      throw new ApiError(409, 'attachment_unavailable', `El adjunto no está disponible: ${name} desconectó su correo. Pídeselo a ${name}.`);
    }
    throw err;
  }
}

// ---------- Responder (ya o programado) ----------
function recipients(e: any, mine: string | null, cc?: string[]) {
  const from: MailAddressDTO | null = e.from_email ? { name: e.from_name, email: e.from_email } : null;
  const toList: MailAddressDTO[] = e.to_list ?? [];
  // Respondo a un correo que yo mandé: sigo con los mismos destinatarios.
  const to = e.direction === 'out' || (mine && from?.email === mine) ? toList : from ? [from] : toList;
  const skip = new Set([mine, ...to.map((x) => x.email)].filter(Boolean));
  const others = cc === undefined
    ? [...toList, ...(e.cc_list ?? [])].filter((x: MailAddressDTO) => !skip.has(x.email))
    : cc.map((x) => ({ name: null, email: x.toLowerCase() })).filter((x) => !skip.has(x.email));
  const seen = new Set<string>();
  return { to, cc: others.filter((x: MailAddressDTO) => (seen.has(x.email) ? false : (seen.add(x.email), true))) };
}

export async function reply(userId: string, id: string, input: z.infer<typeof MailReplyInput>) {
  const when = input.sendAt ? new Date(input.sendAt) : null;
  if (when && when.getTime() < Date.now() - 60_000) throw badRequest('La hora de envío ya pasó');
  if (when && when.getTime() > Date.now() + 90 * 86_400_000) throw badRequest('Se puede programar hasta 90 días');
  const row = await tx(async (c) => {
    const e = await readable(c, userId, id, 'post', true);
    if (e.provider === 'whatsapp') throw badRequest('Los mensajes de WhatsApp se responden en WhatsApp');
    if (e.shared_by !== userId) throw forbidden('Solo quien trajo el correo puede responderlo: sale de su buzón');
    for (const aid of input.attachmentIds ?? []) {
      const ok = await c.query('SELECT 1 FROM attachments WHERE id = $1 AND conversation_id = $2 AND message_id IS NOT NULL', [aid, e.conversation_id]);
      if (!ok.rowCount) throw badRequest('Solo se pueden adjuntar archivos de este chat');
    }
    const ins = await c.query(
      `INSERT INTO mail_replies (email_id, user_id, body, cc, attachment_ids, notify_chat, send_at)
       VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7, now())) ON CONFLICT DO NOTHING RETURNING *`,
      [id, userId, input.body, input.cc === undefined ? null : JSON.stringify(input.cc), JSON.stringify(input.attachmentIds ?? []), input.notifyChat, when],
    );
    if (!ins.rows[0]) throw new ApiError(409, 'reply_pending', 'Ya hay una respuesta en camino o programada para este correo. Cancélala para escribir otra.');
    if (when) { await c.query("UPDATE shared_emails SET status = 'scheduled', updated_at = now() WHERE id = $1", [id]); await publish(c, id); }
    return ins.rows[0];
  });
  if (!when) await sendReply(row.id);
  bumpUser(userId); // la carpeta Enviados cambió
  return load(pool, id, userId);
}

export async function cancelReply(userId: string, id: string) {
  return tx(async (c) => {
    await readable(c, userId, id, 'read', true);
    const r = await c.query("UPDATE mail_replies SET status = 'cancelled' WHERE email_id = $1 AND user_id = $2 AND status = 'queued' RETURNING id", [id, userId]);
    if (!r.rowCount) throw notFound('Respuesta programada');
    await c.query("UPDATE shared_emails SET status = CASE WHEN replied_at IS NULL THEN 'pending' ELSE 'replied' END, updated_at = now() WHERE id = $1", [id]);
    await publish(c, id);
    return load(c, id, userId);
  });
}

/** Envía una respuesta (ya o programada). Toma la fila con queued → sending para no mandar dos veces. */
async function sendReply(replyId: string) {
  const claimed = (await pool.query("UPDATE mail_replies SET status = 'sending', attempts = attempts + 1 WHERE id = $1 AND status = 'queued' RETURNING *", [replyId])).rows[0];
  if (!claimed) return;
  const e = (await pool.query('SELECT * FROM shared_emails WHERE id = $1', [claimed.email_id])).rows[0];
  const fail = async (msg: string, retry: boolean) => {
    await pool.query(`UPDATE mail_replies SET status = $2, error = $3, send_at = CASE WHEN $2 = 'queued' THEN now() + interval '2 minutes' ELSE send_at END WHERE id = $1`,
      [replyId, retry ? 'queued' : 'failed', msg]);
    if (!retry && e) await tx(async (c) => {
      await c.query("UPDATE shared_emails SET status = CASE WHEN replied_at IS NULL THEN 'pending' ELSE 'replied' END WHERE id = $1", [e.id]);
      await appendMessage(c, { conversationId: e.conversation_id, authorId: claimed.user_id, kind: 'system', body: sys('mail.reply_failed', { emailId: e.id, subject: e.subject, error: clip(msg, 200) }) });
      await publish(c, e.id);
    });
  };
  if (!e) return fail('El correo ya no está', false);
  try {
    const files: ReplyOut['files'] = [];
    for (const aid of claimed.attachment_ids as string[]) {
      const f = (await pool.query('SELECT name, content_type, s3_key FROM attachments WHERE id = $1 AND conversation_id = $2', [aid, e.conversation_id])).rows[0];
      if (!f) continue;
      files.push({ name: f.name, contentType: f.content_type, bytes: (await getObject(f.s3_key)).body });
    }
    if (files.reduce((n, f) => n + f.bytes.length, 0) > MAX_ATTACHMENT) throw new ApiError(413, 'attachments_too_large', 'Los adjuntos pesan más de 25 MB');
    const refs = e.internet_id ? JSON.parse(e.internet_id) : {};
    await withProvider(claimed.user_id, e.provider, async (at, mine) => {
      const { to, cc } = recipients(e, mine?.toLowerCase() ?? e.account_email, claimed.cc ?? undefined);
      if (!to.length) throw new ApiError(400, 'no_recipient', 'Este correo no tiene a quién responder');
      await PROVIDERS[e.provider as MailProvider].reply(at, { externalId: e.external_id, threadId: e.thread_id, internetId: refs.id ?? null, references: refs.refs ?? null },
        { to, cc, subject: reSubject(e.subject || ''), body: claimed.body, files });
    });
  } catch (err: any) {
    const retry = err?.code === 'provider_unreachable' || err?.code === 'provider_busy';
    return fail(err?.message ?? 'No se pudo enviar', retry && claimed.attempts < 5);
  }
  // Enviado: el texto se borra (queda en los Enviados de la persona).
  await tx(async (c) => {
    await c.query("UPDATE mail_replies SET status = 'sent', sent_at = now(), body = '', error = NULL WHERE id = $1", [replyId]);
    await c.query("UPDATE shared_emails SET status = 'replied', replied_at = now(), replied_by = $2, updated_at = now() WHERE id = $1", [e.id, claimed.user_id]);
    if (claimed.notify_chat) {
      const name = (await c.query('SELECT name FROM users WHERE id = $1', [claimed.user_id])).rows[0]?.name ?? '';
      await appendMessage(c, { conversationId: e.conversation_id, authorId: claimed.user_id, kind: 'system', body: sys('mail.replied', { emailId: e.id, subject: e.subject, byName: name }) });
    }
    await publish(c, e.id);
  });
  if (e.issue_id && e.close_issue_on_reply) {
    await updateIssue(claimed.user_id, e.issue_id, { status: 'done' }).catch(() => {});
  }
}

let lastPurge = 0;
/** Limpieza (cada hora, desde el worker): respuestas ya resueltas de hace más de 30 días y vuelos OAuth vencidos. */
async function purge() {
  if (Date.now() - lastPurge < 3600_000) return;
  lastPurge = Date.now();
  await pool.query("DELETE FROM mail_replies WHERE status IN ('sent','cancelled','failed') AND created_at < now() - interval '30 days'");
  await pool.query('DELETE FROM mail_flows WHERE expires_at < now()');
  await pool.query('DELETE FROM mail_confirmations WHERE expires_at < now()');
}
/** Lo llama el worker cada 15 s: respuestas programadas que ya tocan. */
export async function fireDueMailReplies(): Promise<number> {
  if (!mailEnabled()) return 0;
  await purge().catch((e) => console.error('[mail] limpieza', e?.message));
  const { rows } = await pool.query("SELECT id FROM mail_replies WHERE status = 'queued' AND send_at <= now() ORDER BY send_at LIMIT 20");
  for (const r of rows) await sendReply(r.id).catch((e) => console.error('[mail] respuesta programada', e?.message));
  // Un proceso que murió mientras enviaba: se da por fallido (no se reintenta a ciegas: pudo haber salido).
  await pool.query("UPDATE mail_replies SET status = 'failed', error = 'Se interrumpió el envío. Revisa tus Enviados antes de reintentar.' WHERE status = 'sending' AND send_at < now() - interval '10 minutes'");
  return rows.length;
}

// ---------- gg redacta ----------
export async function draftReply(userId: string, id: string, lang: 'es' | 'en' = 'es') {
  const e = await readable(pool, userId, id);
  if (e.provider === 'whatsapp') throw badRequest('Los mensajes de WhatsApp se responden en WhatsApp');
  if (e.shared_by !== userId) throw forbidden('Solo quien trajo el correo puede responderlo');
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new ApiError(503, 'assistant_unavailable', 'gg no está disponible en este momento');
  const { rows: cs } = await pool.query(
    `SELECT u.name, x.body FROM shared_email_comments x JOIN users u ON u.id = x.author_id WHERE x.email_id = $1 ORDER BY x.created_at LIMIT 60`, [id]);
  const me = (await pool.query('SELECT name FROM users WHERE id = $1', [userId])).rows[0]?.name ?? '';
  const url = (process.env.DEEPSEEK_URL || 'https://api.deepseek.com').replace(/\/$/, '');
  const prompt = [
    `Correo de ${e.from_name ?? e.from_email ?? ''} <${e.from_email ?? ''}>. Asunto: ${e.subject}`,
    clip(e.body_text, 8000),
    e.comment ? `Lo que escribió ${me} al compartirlo con su equipo: ${e.comment}` : '',
    cs.length ? `Lo que dijo el equipo:\n${cs.map((c) => `- ${c.name}: ${c.body}`).join('\n')}` : 'El equipo no ha comentado.',
  ].filter(Boolean).join('\n\n');
  const res = await request(`${url}/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat', temperature: 0.4,
      messages: [
        { role: 'system', content: `Eres gg, el asistente de chaggu. Redacta la respuesta de ${me} a este correo, en ${lang === 'en' ? 'inglés' : 'el idioma del correo'}, usando lo que decidió el equipo. Tono profesional y cercano, breve. Sin asunto, sin firma de empresa inventada, sin datos que no estén en el hilo. Termina con «Saludos, ${me.split(' ')[0]}». Devuelve solo el texto del correo.` },
        { role: 'user', content: prompt },
      ],
    }),
  }, 45_000);
  const j: any = await res.json().catch(() => ({}));
  const body = j?.choices?.[0]?.message?.content?.trim();
  if (!res.ok || !body) throw new ApiError(502, 'assistant_failed', 'gg no pudo redactar ahora. Escríbelo tú o inténtalo de nuevo.');
  return { body: clip(body, 20000) };
}

// ---------- Tarea desde el correo ----------
export async function createTask(userId: string, id: string, input: z.infer<typeof MailTaskInput>) {
  return tx(async (c) => {
    const e = await readable(c, userId, id, 'post', true);
    if (e.issue_id) throw new ApiError(409, 'task_exists', 'Este correo ya tiene una tarea');
    const issue = await createIssue(userId, e.conversation_id, { title: input.title, ownerId: input.ownerId, dueDate: input.dueDate, originMessageId: e.message_id ?? undefined }, c);
    await c.query('UPDATE shared_emails SET issue_id = $2, close_issue_on_reply = $3, updated_at = now() WHERE id = $1', [id, issue.id, input.closeOnReply]);
    await publish(c, id);
    return { issue, email: await load(c, id, userId) };
  });
}

// ---------- WhatsApp: «Comentar en chaggu» ----------
export async function shareWhatsApp(userId: string, input: z.infer<typeof ShareWaInput>) {
  const acc = (await pool.query('SELECT id, kind, label FROM wa_accounts WHERE id = $1 AND user_id = $2 AND removed_at IS NULL', [input.accountId, userId])).rows[0];
  if (!acc) throw notFound('Cuenta de WhatsApp');
  const m = (await pool.query('SELECT * FROM wa_messages WHERE account_id = $1 AND chat_jid = $2 AND id = $3', [input.accountId, input.jid, input.messageId])).rows[0];
  if (!m) throw notFound('Mensaje de WhatsApp');
  const chat = (await pool.query('SELECT name, is_group FROM wa_chats WHERE account_id = $1 AND jid = $2', [input.accountId, input.jid])).rows[0];
  const me = (await pool.query('SELECT name FROM users WHERE id = $1', [userId])).rows[0]?.name ?? null;
  const targets = [...new Set(input.conversationIds ?? (input.conversationId ? [input.conversationId] : []))];
  for (const cid of targets) await conversationAccess(pool, userId, cid, 'post');
  const author = m.from_me ? me : m.author_name ?? null;
  const text = clip(String(m.body ?? ''), 2000);
  const meta = { chatName: chat?.name ?? null, isGroup: !!chat?.is_group, accountKind: acc.kind, accountId: acc.id, jid: input.jid };
  const messages: MessageDTO[] = [];
  const emails: SharedMailDTO[] = [];
  for (const cid of targets) {
    await tx(async (c) => {
      const a = await conversationAccess(c, userId, cid, 'post', true);
      // Mismo registro que un correo compartido: hilo de comentarios y tarea. Solo guarda este mensaje.
      const ins = await c.query(
        `INSERT INTO shared_emails (conversation_id, shared_by, provider, account_email, external_id, thread_id, direction, from_name, subject, snippet, body_text, sent_at, comment, meta)
         VALUES ($1,$2,'whatsapp',NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [cid, userId, m.id, input.jid, m.from_me ? 'out' : 'in', author, clip(chat?.name ?? 'WhatsApp', 500), clip(flat(text), 300), text, m.sent_at, input.comment || null, JSON.stringify(meta)],
      );
      const id: string = ins.rows[0].id;
      const msg = await appendMessage(c, {
        conversationId: cid, authorId: userId, kind: 'system',
        body: sys('wa.shared', {
          emailId: id, accountId: acc.id, jid: input.jid, waMessageId: m.id, accountKind: acc.kind, chatName: chat?.name ?? null, isGroup: !!chat?.is_group,
          author, fromMe: m.from_me, text, sentAt: iso(m.sent_at), ...(input.comment ? { comment: clip(input.comment, 4000) } : {}),
        }),
      });
      await c.query('UPDATE shared_emails SET message_id = $2 WHERE id = $1', [id, msg.id]);
      await audit(c, userId, 'wa.shared', { type: 'conversation', id: cid, workspaceId: a.workspaceId }, { chats: targets.length });
      messages.push(msg);
      emails.push(await publish(c, id));
    });
  }
  return { message: messages[0]!, messages, emails };
}


// ---------- Reenviar una tarjeta ----------
/**
 * Reenviar un correo o WhatsApp ya compartido a otros chats (sin volver a pedirlo al buzón). La copia conserva el
 * dueño del buzón (shared_by: de ahí salen los adjuntos y solo él responde el correo); la tarjeta la publica quien reenvía.
 */
export async function forwardShared(userId: string, id: string, input: z.infer<typeof ForwardSharedInput>) {
  const e = await readable(pool, userId, id);
  const targets = [...new Set(input.conversationIds)].filter((cid) => cid !== e.conversation_id);
  if (!targets.length) throw badRequest('Elige otro chat');
  for (const cid of targets) await conversationAccess(pool, userId, cid, 'post');
  const src = (await pool.query('SELECT body FROM messages WHERE id = $1', [e.message_id])).rows[0];
  let payload: any = {};
  try { payload = JSON.parse(src?.body ?? '{}'); } catch {}
  const emails: SharedMailDTO[] = [];
  for (const cid of targets) {
    emails.push(await tx(async (c) => {
      const a = await conversationAccess(c, userId, cid, 'post', true);
      const ins = await c.query(
        `INSERT INTO shared_emails (conversation_id, shared_by, provider, account_email, external_id, thread_id, internet_id, direction, from_name, from_email,
           to_list, cc_list, subject, snippet, body_text, body_trimmed, sent_at, attachments, comment, meta, status, replied_at, replied_by)
         SELECT $2, shared_by, provider, account_email, external_id, thread_id, internet_id, direction, from_name, from_email,
           to_list, cc_list, subject, snippet, body_text, body_trimmed, sent_at, attachments, $3, meta,
           CASE WHEN status = 'replied' THEN 'replied' ELSE 'pending' END, replied_at, replied_by
           FROM shared_emails WHERE id = $1 RETURNING id`,
        [id, cid, input.comment || null],
      );
      const nid: string = ins.rows[0].id;
      const { comment: _old, ...rest } = payload;
      const k = e.provider === 'whatsapp' ? 'wa.shared' : 'mail.shared';
      const m = await appendMessage(c, {
        conversationId: cid, authorId: userId, kind: 'system',
        body: sys(k, { ...rest, emailId: nid, forwardedFrom: e.conversation_id, ...(input.comment ? { comment: clip(input.comment, 4000) } : {}) }),
      });
      await c.query('UPDATE shared_emails SET message_id = $2 WHERE id = $1', [nid, m.id]);
      await audit(c, userId, 'mail.forwarded', { type: 'conversation', id: cid, workspaceId: a.workspaceId }, { provider: e.provider });
      return publish(c, nid);
    }));
  }
  return { emails };
}
