/**
 * Lista de lectura (docs/LECTURA.md): enlaces de un chat de WhatsApp marcado con 📚, «Resúmeme todo» que los marca
 * leídos, el MCP y el aislamiento entre personas.
 * API (API_URL) con DEEPSEEK_URL=http://127.0.0.1:59482 y DEEPSEEK_API_KEY=x, y la misma base (DATABASE_URL).
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.ts';
import { storeMessages, upsertChats, type MsgRow, type Session } from '../src/modules/wa-sync.ts';
import { scanWaReading } from '../src/modules/reading.ts';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 8);
const DAD = '573001234000@s.whatsapp.net';
let fake: Server;
let prompts: string[] = [];

async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}
async function signup(name: string) {
  const r = await call('/api/v1/auth/signup', { body: { name, orgName: `${name} SAS ${run}`, email: `${name.toLowerCase()}.lec.${run}@example.com`, password: 'clave-segura-123', device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' } } });
  expect(r.status).toBe(200);
  return { token: r.json.accessToken as string, id: r.json.user.id as string };
}
const tool = async (token: string, name: string, args: unknown = {}) =>
  (await call('/api/mcp', { token, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } })).json.result as { isError?: boolean; structuredContent?: any };

let danny: Awaited<ReturnType<typeof signup>>, eva: typeof danny, account: string;

beforeAll(async () => {
  fake = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body);
      const sys = String(j.messages?.[0]?.content ?? ''); const user = String(j.messages?.[1]?.content ?? '');
      prompts.push(user);
      const content = sys.includes('digest')
        ? JSON.stringify({ digest: `Economía\n• Resumen general de ${user.split('\n').length} líneas\nLo más importante: leer el de inflación` })
        : JSON.stringify({ summary: `Resumen de: ${user.match(/Título: (.*)/)?.[1] ?? 'sin título'}`, topic: 'Economía' });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: {} }));
    });
  });
  await new Promise<void>((r) => fake.listen(59482, '127.0.0.1', r));
  danny = await signup('Dan');
  eva = await signup('Eva');
  account = (await call('/api/v1/whatsapp/accounts', { token: danny.token, body: { label: 'Personal', kind: 'personal' } })).json.id;
  await pool.query(`UPDATE wa_accounts SET status='connected', privacy_synced_at=now(), lease_owner='fixture', lease_until=now()+interval '1 hour' WHERE id=$1`, [account]);
  const s: Session = { id: account, userId: danny.id, kind: 'personal', pairPhone: null, sock: null, stopping: false, retries: 0, registered: true, me: null, notifyTimer: null };
  await upsertChats(s, [{ jid: DAD, name: 'Papá', isGroup: false }]);
  const m = (body: string, opts: Partial<MsgRow> = {}): MsgRow => ({ chat: DAD, id: randomUUID().slice(0, 16), fromMe: false, authorJid: DAD, authorName: 'Papá', kind: 'text', body, sentAt: new Date(Date.now() - 3600_000), ...opts });
  await storeMessages(s, [
    m(`Mira esto https://example.invalid/inflacion-${run} y esto https://example.invalid/salud-${run}`),
    m(`Otra vez el mismo https://example.invalid/inflacion-${run}`),
    m(`Yo mandé uno https://example.invalid/mio-${run}`, { fromMe: true, authorJid: null, authorName: null }),
    m('Sin enlaces, solo un saludo'),
  ], true);
});
afterAll(async () => { await new Promise<void>((r) => fake.close(() => r())); await pool.end(); });

describe('lista de lectura', () => {
  it('marcar el chat con 📚 trae sus enlaces (sin repetir y sin los míos)', async () => {
    const r = await call(`/api/v1/whatsapp/chats/${account}/${encodeURIComponent(DAD)}`, { method: 'PATCH', token: danny.token, body: { readingList: true } });
    expect(r.status).toBe(200);
    expect(r.json.readingList).toBe(true);
    const list = (await call('/api/v1/reading?source=whatsapp', { token: danny.token })).json.items;
    expect(list.map((x: any) => x.url).sort()).toEqual([`https://example.invalid/inflacion-${run}`, `https://example.invalid/salud-${run}`]);
    expect(list[0].from).toBe('Papá');
    // Un enlace nuevo que llega después entra con el escaneo del worker.
    const s: Session = { id: account, userId: danny.id, kind: 'personal', pairPhone: null, sock: null, stopping: false, retries: 0, registered: true, me: null, notifyTimer: null };
    await storeMessages(s, [{ chat: DAD, id: randomUUID().slice(0, 16), fromMe: false, authorJid: DAD, authorName: 'Papá', kind: 'text', body: `Y este video https://youtu.be/aircAruvnKk?x=${run}`, sentAt: new Date() }], true);
    await scanWaReading(account, DAD);
    expect((await call('/api/v1/reading?source=whatsapp', { token: danny.token })).json.items).toHaveLength(3);
    // Eva no ve nada de Danny.
    expect((await call('/api/v1/reading', { token: eva.token })).json.items).toHaveLength(0);
  });

  it('«Resúmeme todo» resume, arma el resumen general y marca leídos', async () => {
    const ids = (await call('/api/v1/reading?source=whatsapp', { token: danny.token })).json.items
      .filter((x: any) => x.url.includes('example.invalid')).map((x: any) => x.id);
    // Sin vista previa (dominio inexistente) se le da título a mano, como si la hubiera traído el worker.
    await pool.query(`UPDATE reading_items SET preview = jsonb_build_object('title', 'Nota sobre ' || split_part(url, '/', 4), 'url', url) WHERE user_id = $1`, [danny.id]);
    const d = (await call('/api/v1/reading/digest', { token: danny.token, body: { ids } })).json;
    expect(d.digest).toContain('Lo más importante');
    expect(d.items.every((x: any) => x.summary?.startsWith('Resumen de: Nota sobre'))).toBe(true);
    expect(d.items.every((x: any) => x.markedRead)).toBe(true);
    const pending = (await call('/api/v1/reading?source=whatsapp', { token: danny.token })).json.items.map((x: any) => x.url);
    expect(pending.some((u: string) => u.includes('example.invalid'))).toBe(false);
    // Eva no puede resumir ni marcar los de Danny.
    const e = await call('/api/v1/reading/digest', { token: eva.token, body: { ids } });
    expect(e.json.items ?? []).toHaveLength(0);
  });

  it('por el MCP: listar, resumir sin marcar, marcar y agregar a mano', async () => {
    const t = (await call('/api/v1/me/mcp-tokens', { token: danny.token, body: { name: 'ChatGPT' } })).json.token;
    await call('/api/v1/reading/state', { method: 'PUT', token: danny.token, body: { ids: (await call('/api/v1/reading?state=all&source=whatsapp', { token: danny.token })).json.items.map((x: any) => x.id), seen: false } });
    const l = (await tool(t, 'list_reading', { source: 'whatsapp' })).structuredContent;
    expect(l.items.length).toBeGreaterThanOrEqual(2);
    const ids = l.items.filter((x: any) => x.url.includes('example.invalid')).map((x: any) => x.id);
    const s = (await tool(t, 'summarize_reading', { ids, mark_read: false })).structuredContent;
    expect(s.items.every((x: any) => !x.markedRead)).toBe(true);
    expect((await tool(t, 'list_reading', { source: 'whatsapp' })).structuredContent.items.length).toBe(l.items.length);
    await tool(t, 'mark_reading', { ids, read: true });
    expect((await tool(t, 'list_reading', { source: 'whatsapp' })).structuredContent.items.length).toBe(l.items.length - ids.length);
    const add = (await tool(t, 'add_to_reading', { url: `https://example.invalid/manual-${run}` })).structuredContent;
    expect(add.id).toMatch(/^r:/);
    // Un token sin el permiso «reading» no ve la lista.
    const t2 = (await call('/api/v1/me/mcp-tokens', { token: danny.token, body: { name: 'Solo WA', scopes: ['whatsapp:read'] } })).json.token;
    expect((await tool(t2, 'list_reading')).structuredContent.error.code).toBe('forbidden_scope');
    // Eva no puede marcar el chat del papá de Danny.
    const te = (await call('/api/v1/me/mcp-tokens', { token: eva.token, body: { name: 'Eva IA' } })).json.token;
    expect((await tool(te, 'set_whatsapp_reading', { chat: `${account}|${DAD}`, on: false })).isError).toBe(true);
  });
});
