#!/usr/bin/env node
/** Demo: reuniones con invitados y un mensaje fijado sobre los datos de seed-demo.mjs. */
import { randomUUID } from 'node:crypto';
const API = process.env.API_URL ?? 'http://localhost:3020';
const PASSWORD = process.env.DEMO_PASSWORD;
const DOMAIN = process.env.DEMO_DOMAIN ?? 'demo.tiecoms.com';
async function call(path, { token, body, method } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, { method: method ?? (body ? 'POST' : 'GET'), headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}
const login = async (u) => (await call('/auth/login', { body: { email: `${u}@${DOMAIN}`, password: PASSWORD, device: { deviceId: randomUUID(), name: 'Carga de demo', platform: 'agent' } } })).accessToken;
/** Día relativo a hoy, a la hora indicada en Bogotá (UTC-5). */
const bogota = (days, h, m = 0) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); d.setUTCHours(h + 5, m, 0, 0); return d.toISOString(); };
const [danny, mateo] = await Promise.all([login('danny'), login('mateo')]);
const b = await call('/bootstrap', { token: danny });
const ws1 = b.workspaces.find((w) => w.name.startsWith('Lanzamiento'));
const g1 = b.conversations.find((c) => c.workspaceId === ws1.id && c.name === 'General');
const existing = await call(`/events?from=${bogota(-30, 0)}&to=${bogota(60, 0)}`, { token: danny });
if (existing.events.length) { console.error('La agenda de demo ya existe.'); process.exit(2); }
await call(`/conversations/${g1.id}/events`, { token: danny, body: { title: 'Revisión semanal con Estudio Norte', description: 'Avance de la integración y de la carga masiva.', location: 'https://meet.google.com/', startsAt: bogota(1, 10), endsAt: bogota(1, 11), timezone: 'America/Bogota' } });
const dec = b.conversations.find((c) => c.name === 'Decisión · fecha de salida');
if (dec) await call(`/conversations/${dec.id}/events`, { token: danny, body: { title: 'Decisión de la fecha de salida', location: 'Sala 3 · Estudio Norte', startsAt: bogota(2, 15, 30), endsAt: bogota(2, 16, 15), timezone: 'America/Bogota' } });
const bm = await call('/bootstrap', { token: mateo });
const g2 = bm.conversations.find((c) => c.name === 'General' && bm.workspaces.find((w) => w.id === c.workspaceId)?.name.startsWith('Entrega'));
await call(`/conversations/${g2.id}/events`, { token: mateo, body: { title: 'Seguimiento de entregas · Nexo', location: 'https://teams.microsoft.com/', startsAt: bogota(0, 16), endsAt: bogota(0, 16, 45), timezone: 'America/Bogota' } });
const msgs = await call(`/conversations/${g1.id}/messages?limit=50`, { token: danny });
const toPin = msgs.messages.find((m) => m.kind === 'text' && m.body.includes('plantilla final'));
if (toPin) await call(`/messages/${toPin.id}/pin`, { method: 'POST', token: danny });
console.log('Agenda de demo lista.');
