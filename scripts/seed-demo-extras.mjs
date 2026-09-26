#!/usr/bin/env node
/**
 * Complemento de la demo: asuntos y bifurcaciones sobre los datos de seed-demo.mjs.
 * Deriva un diagnóstico interno (y devuelve su resultado), abre una decisión
 * directiva y crea asuntos con responsables, fechas y estados.
 *   API_URL=https://app.chaggu.com DEMO_PASSWORD='...' node scripts/seed-demo-extras.mjs
 */
import { randomUUID } from 'node:crypto';

const API = process.env.API_URL ?? 'http://localhost:3020';
const PASSWORD = process.env.DEMO_PASSWORD;
const DOMAIN = process.env.DEMO_DOMAIN ?? 'demo.tiecoms.com';

async function call(path, { token, body, method } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}
const login = async (u) => {
  const r = await call('/auth/login', { body: { email: `${u}@${DOMAIN}`, password: PASSWORD, device: { deviceId: randomUUID(), name: 'Carga de demo', platform: 'agent' } } });
  return { token: r.accessToken, id: r.user.id };
};
const say = async (who, conv, body) => (await call(`/conversations/${conv}/messages`, { token: who.token, body: { clientMessageId: randomUUID(), body } })).message;
const day = (n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

const [danny, laura, mateo, ana, lucia, carlos] = await Promise.all(['danny', 'laura', 'mateo', 'ana', 'lucia', 'carlos'].map(login));
const boot = await call('/bootstrap', { token: danny.token });
if (boot.conversations.some((c) => c.parentId)) { console.error('Los extras ya se cargaron.'); process.exit(2); }
const ws1 = boot.workspaces.find((w) => w.name.startsWith('Lanzamiento'));
const g1 = boot.conversations.find((c) => c.workspaceId === ws1.id && c.name === 'General').id;
const norteOrg = (await call('/bootstrap', { token: mateo.token })).me.primaryOrgId;

console.log('Bifurcación 1: diagnóstico interno de Xertify');
const q = await say(ana, g1, 'Veo notificaciones duplicadas en las pruebas. ¿Es un reenvío manual o el job?');
const diag = await call(`/conversations/${g1}/derive`, { token: danny.token, body: { messageId: q.id, kind: 'internal', name: 'Diagnóstico · notificaciones duplicadas', reason: 'Ana necesita saber si es el job o un reenvío manual' } });
await say(danny, diag.id, 'Laura, ¿puedes revisar los logs del job de notificaciones?');
await say(laura, diag.id, 'Revisado: el job corre cada hora y reenvía a quien no ha firmado. Por eso se duplican.');
await say(danny, diag.id, 'Lo dejamos en una sola notificación diaria a las 10:00.');
await call(`/conversations/${diag.id}/return`, { token: danny.token, body: { summary: 'Era el job de notificaciones: reenviaba cada hora a quien no había firmado. Desde hoy queda una sola notificación diaria a las 10:00.' } });
await say(ana, g1, '¡Perfecto, gracias! Con eso cerramos el punto.');

console.log('Bifurcación 2: decisión directiva abierta');
const d0 = await say(mateo, g1, '¿Mantenemos la salida del viernes aunque la carga masiva termine el jueves en la noche?');
const dec = await call(`/conversations/${g1}/derive`, { token: danny.token, body: { messageId: d0.id, kind: 'directive', name: 'Decisión · fecha de salida', reason: 'Definir si se mantiene el viernes' } });
await say(danny, dec.id, 'Propongo mantener el viernes a las 10:00 con plan de reversa listo.');
await say(mateo, dec.id, 'Lo llevo mañana a dirección y confirmo aquí.');

console.log('Asuntos');
const m1 = await say(danny, g1, 'Ana, necesitamos la plantilla final de certificados para arrancar la carga.');
const i1 = await call(`/conversations/${g1}/issues`, { token: danny.token, body: { title: 'Plantilla final de certificados', originMessageId: m1.id, ownerId: ana.id, dueDate: day(-1) } });
await call(`/issues/${i1.id}`, { method: 'PATCH', token: ana.token, body: { status: 'waiting', waitingOnOrgId: norteOrg } });
await call(`/issues/${i1.id}/comments`, { token: ana.token, body: { body: 'Falta que diseño apruebe el logo; la envío apenas llegue.' } });
const i2 = await call(`/conversations/${g1}/issues`, { token: laura.token, body: { title: 'Prueba de carga con 500 registros', ownerId: laura.id, dueDate: day(2) } });
await call(`/issues/${i2.id}`, { method: 'PATCH', token: laura.token, body: { status: 'in_progress' } });
const i3 = await call(`/conversations/${dec.id}/issues`, { token: mateo.token, body: { title: 'Confirmar fecha con dirección', ownerId: mateo.id, dueDate: day(1) } });

const b2 = await call('/bootstrap', { token: mateo.token });
const ws2 = b2.workspaces.find((w) => w.name.startsWith('Entrega'));
const g2 = b2.conversations.find((c) => c.workspaceId === ws2.id && c.name === 'General').id;
const m2 = await say(lucia, g2, 'Ana, ¿nos compartes la lista de direcciones para los 300 kits?');
await call(`/conversations/${g2}/issues`, { token: lucia.token, body: { title: 'Lista de direcciones para 300 kits', originMessageId: m2.id, ownerId: ana.id, dueDate: day(0) } });
const i5 = await call(`/conversations/${g2}/issues`, { token: lucia.token, body: { title: 'Confirmar camión a Medellín', ownerId: carlos.id } });
await call(`/issues/${i5.id}`, { method: 'PATCH', token: carlos.token, body: { status: 'done' } });

console.log(`Listo. Asunto para simular un cuello de botella: ${i1.id}`);
void i3;
