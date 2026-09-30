/**
 * Salas abiertas (proveedor falso: CALLS_ENABLED=true CALLS_PROVIDER=fake). Un enlace permanente: cualquiera entra con
 * su nombre aunque el dueño no esté; la sala se abre al entrar el primero y se cierra al salir el último; el enlace sigue.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.ts';
import { reapCalls } from '../src/modules/calls.ts';

const API = process.env.API_URL ?? 'http://127.0.0.1:3288';
const run = randomUUID().slice(0, 8);
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'x-forwarded-for': ip(), ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

describe('salas abiertas', () => {
  let owner: { token: string; id: string }, room: any;
  beforeAll(async () => {
    const r = await call('/auth/signup', { body: { name: 'Dueña', email: `duena.sala.${run}@example.com`, password: 'clave-segura-123', orgName: `Sala SAS ${run}`, device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' } } });
    owner = { token: r.json.accessToken, id: r.json.user.id };
  });

  it('crea el enlace, y cualquiera entra sin cuenta aunque la dueña no esté', async () => {
    const c = await call('/rooms', { token: owner.token, body: { title: 'Demo abierta' } });
    expect(c.status).toBe(200);
    room = c.json;
    expect(room.code).toMatch(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
    expect(room.url).toContain(`/sala/${room.code}`);
    const pre = await call(`/rooms/${room.code}`);
    expect(pre.json).toMatchObject({ title: 'Demo abierta', hostName: 'Dueña', active: true, live: false });
    const j = await call(`/rooms/${room.code}/join`, { body: { name: 'Invitado uno' } });
    expect(j.status).toBe(200);
    expect(j.json.guestId).toBeTruthy();
    expect((await call(`/rooms/${room.code}`)).json.live).toBe(true);
    const j2 = await call(`/rooms/${room.code}/join`, { body: { name: 'Invitado dos' } });
    expect(j2.json.call.callId).toBe(j.json.call.callId); // la misma llamada
    expect(j2.json.call.guests.map((g: any) => g.name).sort()).toEqual(['Invitado dos', 'Invitado uno']);
    expect((await call('/rooms', { token: owner.token })).json.rooms[0]).toMatchObject({ live: true, guests: 2 });
    // La dueña entra desde la app y ve a los invitados.
    const enter = await call(`/rooms/${room.id}/enter`, { token: owner.token, body: {} });
    expect(enter.status).toBe(200);
    expect(enter.json.call.id).toBe(j.json.call.callId);
    expect(enter.json.call.guests.length).toBe(2);
    // gg le había avisado que alguien entró.
    const gg = await pool.query(
      `SELECT m.body FROM messages m JOIN conversation_memberships cm ON cm.conversation_id = m.conversation_id
        WHERE cm.user_id = $1 AND m.author_id = '0a9a9a9a-0000-4000-8000-000000000066' AND m.body LIKE '%entró a tu sala%'`, [owner.id]);
    expect(gg.rows.length).toBe(1);
    expect(gg.rows[0].body).toContain(room.url);
    // Solo ella la ve/entra/borra.
    expect((await call(`/rooms/${room.id}/enter`, { body: {} })).status).toBe(401);
  });

  it('la llamada sigue mientras quede alguien, sea o no de chaggu; al salir todos se cierra y el enlace sigue sirviendo', async () => {
    const callId = (await call(`/rooms/${room.id}/enter`, { token: owner.token, body: {} })).json.call.id;
    // La dueña cuelga: los dos invitados siguen, así que la llamada no termina.
    await call(`/calls/${callId}/leave`, { token: owner.token, body: {} });
    expect((await call(`/rooms/${room.code}`)).json.live).toBe(true);
    expect((await pool.query('SELECT ended_at FROM calls WHERE id = $1', [callId])).rows[0].ended_at).toBeNull();
    // Todos salen: el worker la cierra (1 minuto de gracia desde que empezó).
    await pool.query('UPDATE call_guests SET left_at = now() WHERE call_id = $1', [callId]);
    await pool.query("UPDATE calls SET started_at = now() - interval '5 minutes' WHERE id = $1", [callId]);
    await reapCalls();
    expect((await pool.query('SELECT ended_at FROM calls WHERE id = $1', [callId])).rows[0].ended_at).not.toBeNull();
    expect((await call(`/rooms/${room.code}`)).json.live).toBe(false);
    // El enlace sirve otra vez: abre una llamada nueva.
    const again = await call(`/rooms/${room.code}/join`, { body: { name: 'Tarde' } });
    expect(again.status).toBe(200);
    expect(again.json.call.callId).not.toBe(callId);
  });

  it('un código inválido o una sala borrada no sirve', async () => {
    expect((await call('/rooms/zzz-zzzz-zzz')).status).toBe(404);
    expect((await call('/rooms/nada')).status).toBe(404);
    expect((await call(`/rooms/${room.id}`, { token: owner.token, method: 'DELETE' })).json).toEqual({ ok: true });
    expect((await call(`/rooms/${room.code}`)).status).toBe(410);
    expect((await call(`/rooms/${room.code}/join`, { body: { name: 'X' } })).status).toBe(410);
    expect((await call('/rooms', { token: owner.token })).json.rooms.length).toBe(0);
  });
});
