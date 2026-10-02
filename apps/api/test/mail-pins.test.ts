/** Pines de conversaciones de correo (mail-pins.ts): principal y Correo, independientes, por persona. Necesita el API (API_URL). */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3097';
const run = randomUUID().slice(0, 8);
async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, { method: opts.method ?? (opts.body ? 'POST' : 'GET'), headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  let json: any = {}; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function signup(name: string) {
  const res = await fetch(`${API}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({
    name, email: `${name.toLowerCase()}.mp.${run}@example.com`, password: 'clave-segura-123', orgName: `${name} SAS ${run}`, device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' } }) });
  return ((await res.json()) as any).accessToken as string;
}
const pin = (token: string, extra: object) => call('/mail/pins', { method: 'PUT', token, body: { provider: 'google', threadKey: 'th-1', messageId: 'm-1', subject: 'Propuesta Coopcentral', from: { name: 'Jorge', email: 'Jorge@Coopcentral.com' }, date: '2026-10-02T15:00:00.000Z', ...extra } });

describe('pines de correo', () => {
  it('principal y Correo son independientes, se ven en bootstrap y la fila se borra sin pines', async () => {
    const a = await signup('Ana'), b = await signup('Beto');
    let r = await pin(a, { main: true });
    expect(r.status).toBe(200);
    expect(r.json.pins).toHaveLength(1);
    expect(r.json.pins[0]).toMatchObject({ provider: 'google', threadKey: 'th-1', messageId: 'm-1', subject: 'Propuesta Coopcentral', from: { name: 'Jorge', email: 'jorge@coopcentral.com' }, mailPinnedAt: null });
    const main1 = r.json.pins[0].mainPinnedAt; expect(main1).toBeTruthy();
    r = await pin(a, { mail: true, messageId: 'm-2' });
    expect(r.json.pins[0]).toMatchObject({ mainPinnedAt: main1, messageId: 'm-2' });
    expect(r.json.pins[0].mailPinnedAt).toBeTruthy();
    expect((await call('/bootstrap', { token: a })).json.mailPins).toHaveLength(1);
    // Es de cada persona.
    expect((await call('/mail/pins', { token: b })).json.pins).toEqual([]);
    r = await pin(a, { main: false });
    expect(r.json.pins[0]).toMatchObject({ mainPinnedAt: null });
    r = await pin(a, { mail: false });
    expect(r.json.pins).toEqual([]);
    expect((await call('/mail/pins', { method: 'PUT', token: a, body: { provider: 'yahoo', threadKey: 'x', messageId: 'y' } })).status).toBe(400);
    expect((await call('/mail/pins', { token: undefined })).status).toBe(401);
  });
});
