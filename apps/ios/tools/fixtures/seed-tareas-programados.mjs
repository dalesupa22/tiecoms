// 1.6.4 (21): sobre un fixture de Grupos, siembra mensajes programados, modo sueño y tareas derivadas.
// Solo contra un API local con las migraciones 025–027:
//   node apps/ios/tools/fixtures/seed-tareas-programados.mjs /tmp/fx.json
// Agrega al JSON: dmBrunoId, scheduledId, parentIssueId, taskIds, sideId.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const path = process.argv[2];
const fx = JSON.parse(readFileSync(path, 'utf8'));
const API = fx.apiUrl;
if (!/localhost|127\.0\.0\.1/.test(API)) throw new Error('solo pruebas');
async function call(p, { token, body, method } = {}) {
  const res = await fetch(`${API}/api/v1${p}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${p} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}
const login = (email) => call('/auth/login', { body: { email, password: fx.password, device: { deviceId: randomUUID(), name: 'Fixture tareas', platform: 'agent' } } });
const a = await login(fx.a.email);
const b = await login(fx.b.email);
const tz = 'America/Bogota';

// Bruno descansa ahora (ventana alrededor de la hora actual en Bogotá) para ver el aviso a quien le escribe.
const hm = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
const now = Date.now();
await call('/me/sleep', { token: b.accessToken, method: 'PUT', body: { on: true, start: hm(new Date(now - 3600_000)), end: hm(new Date(now + 3 * 3600_000)), tz, tzAuto: false } });

// Directo Ana–Bruno y un mensaje programado para mañana a las 8:00.
const boot = await call('/bootstrap', { token: a.accessToken });
const dm = boot.conversations.find((c) => c.kind === 'direct' && c.memberIds.includes(fx.b.id));
const tomorrow8 = new Date(now + 86400_000); tomorrow8.setUTCHours(13, 0, 0, 0); // 8:00 en Bogotá
const sched = await call(`/conversations/${dm.id}/scheduled`, { token: a.accessToken, body: { body: 'Bruno, te dejo el informe de la cohorte para cuando llegues.', sendAt: tomorrow8.toISOString() } });
await call(`/conversations/${fx.generalId ?? dm.id}/scheduled`, { token: a.accessToken, body: { body: 'Recordatorio: mentoría el jueves a las 4.', sendAt: new Date(now + 2 * 86400_000).toISOString() } });

// Tareas del asunto «Cerrar facturación de septiembre» (Pagos): una de todo el chat, una solo de Xertify y una privada.
const list = await call(`/issues?conversationId=${fx.pagosId}`, { token: a.accessToken });
const parent = (list.issues ?? list.items).find((i) => i.title.startsWith('Cerrar facturación'));
const t1 = await call(`/issues/${parent.id}/children`, { token: a.accessToken, body: { title: 'Revisar notas crédito', ownerId: fx.a.id, visibility: 'all' } });
const t2 = await call(`/issues/${parent.id}/children`, { token: a.accessToken, body: { title: 'Cuadrar con contabilidad', ownerId: fx.c.id, visibility: 'org' } });
const t3 = await call(`/issues/${parent.id}/children`, { token: a.accessToken, body: { title: 'Validar retención con Bruno', ownerId: fx.b.id, visibility: 'private' } });
await call(`/issues/${t1.id}`, { token: a.accessToken, method: 'PATCH', body: { status: 'done' } });

// Sidechat desde el asunto con Carlos y una tarea que vive ahí.
const side = await call(`/conversations/${fx.pagosId}/side`, { token: a.accessToken, body: { issueId: parent.id, userIds: [fx.c.id], question: '¿Cerramos hoy la facturación?' } });
await call(`/issues/${parent.id}/children`, { token: a.accessToken, body: { title: 'Enviar reporte a gerencia', ownerId: fx.c.id, visibility: 'all', conversationId: side.id } });

Object.assign(fx, { dmBrunoId: dm.id, scheduledId: sched.id, parentIssueId: parent.id, taskIds: [t1.id, t2.id, t3.id], sideId: side.id });
writeFileSync(path, JSON.stringify(fx, null, 2));
console.log(JSON.stringify({ dm: dm.id, sched: sched.id, parent: parent.id, side: side.id }));
