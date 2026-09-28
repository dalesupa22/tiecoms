#!/usr/bin/env node
/**
 * Actividad de prueba para el equipo real de Xertify (danny@, cesar@ y alicia@xertify.co):
 * una relación nueva con Nexo Logística, mensajes en los grupos compartidos y chats
 * directos desde las cuentas de demo de otras empresas. Se corre una sola vez.
 *   API_URL=https://app.chaggu.com DEMO_PASSWORD='...' DANNY_ID=… CESAR_ID=… ALICIA_ID=… node scripts/seed-xertify-equipo.mjs
 */
import { randomUUID } from 'node:crypto';

const API = process.env.API_URL ?? 'http://localhost:3020';
const PASSWORD = process.env.DEMO_PASSWORD;
const DOMAIN = process.env.DEMO_DOMAIN ?? 'demo.tiecoms.com';
if (!PASSWORD) { console.error('Falta DEMO_PASSWORD'); process.exit(1); }

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function login(u) {
  const r = await call('/auth/login', { body: { email: `${u}@${DOMAIN}`, password: PASSWORD, device: { deviceId: randomUUID(), name: 'Actividad de prueba', platform: 'agent' } } });
  await sleep(400);
  return { token: r.accessToken, id: r.user.id, name: r.user.name };
}
const say = async (who, conv, body) => { const m = (await call(`/conversations/${conv}/messages`, { token: who.token, body: { clientMessageId: randomUUID(), body } })).message; await sleep(250); return m; };

const demoDanny = await login('danny');
const L = await login('laura'), A = await login('ana'), M = await login('mateo'), C = await login('carlos'), U = await login('lucia');

const boot = await call('/bootstrap', { token: demoDanny.token });
// Ids del equipo real (users.id). Las personas del bootstrap no traen el correo.
const realDanny = process.env.DANNY_ID, cesar = process.env.CESAR_ID, alicia = process.env.ALICIA_ID;
if (!realDanny || !cesar || !alicia) { console.error('Faltan DANNY_ID, CESAR_ID y ALICIA_ID'); process.exit(1); }
for (const id of [realDanny, cesar, alicia]) if (!boot.people.some((p) => p.id === id)) throw new Error(`La demo de Xertify no ve a ${id}`);
const equipo = [realDanny, cesar, alicia];

// 1) Relación nueva con Nexo Logística (espacio + grupo + invitación con código)
if (boot.conversations.some((c) => c.name === 'Operación · Nexo Logística')) { console.error('Esta actividad ya se cargó.'); process.exit(2); }
console.log('Relación con Nexo Logística');
const nexo = await call('/groups', { token: demoDanny.token, body: {
  name: 'Operación · Nexo Logística', target: { kind: 'company', companyName: 'Nexo Logística' },
  memberIds: [L.id, ...equipo], inviteEmails: [`carlos@${DOMAIN}`, `lucia@${DOMAIN}`], shareLink: true,
} });
await call(`/invitations/${nexo.inviteCode}/accept`, { token: C.token, body: {} });
await call(`/invitations/${nexo.inviteCode}/accept`, { token: U.token, body: {} });
await say(C, nexo.conversationId, 'Hola equipo Xertify 👋 Soy Carlos, de Nexo Logística. Por aquí coordinamos las entregas de las credenciales impresas.');
await say(U, nexo.conversationId, 'Yo soy Lucía, llevo las rutas. César, Alicia: ¿nos confirman la dirección de entrega de la sede norte?');
await say(L, nexo.conversationId, 'Bienvenidos. César y Alicia van a llevar esta cuenta con nosotros.');
await say(C, nexo.conversationId, 'Perfecto. El primer despacho sale el martes antes de las 10 a. m.');

// 2) Grupos del espacio con Estudio Norte
const b2 = await call('/bootstrap', { token: demoDanny.token });
const ws = b2.workspaces.find((w) => w.name.startsWith('Lanzamiento'));
const g = (name) => b2.conversations.find((c) => c.workspaceId === ws.id && c.name === name)?.id;
console.log('Mensajes en Lanzamiento · Estudio Norte');
await say(A, g('General'), 'Bienvenidos César y Alicia al espacio del lanzamiento 🎉 Aquí está todo lo que hemos hablado con Xertify.');
await say(M, g('General'), 'Les dejo el resumen: la campaña sale el 3 de octubre y falta cerrar la revisión del contrato.');
await say(L, g('General'), 'Gracias, Mateo. Alicia, ¿te encargas de revisar los textos de la landing?');
await say(A, g('Revisión del contrato'), 'César, cuando puedas revisa la cláusula 4 (tiempos de entrega). Nosotros ya firmamos lo demás.');
await say(M, g('Comité directivo'), 'Danny, para el comité del jueves necesitamos la fecha final de salida.');

// 3) Chats directos y un chat grupal
console.log('Chats directos');
const dm = async (from, to, lines) => { const d = await call('/directs', { token: from.token, body: { userId: to } }); const id = d.id; for (const t of lines) await say(from, id, t); return id; };
await dm(A, cesar, ['Hola César, soy Ana de Estudio Norte. ¿Tienes 10 minutos mañana para lo del contrato?']);
await dm(M, alicia, ['Alicia, te paso los textos de la landing apenas los tenga aprobados 🙌']);
await dm(C, cesar, ['César, ¿el martes hay alguien en recepción para recibir el despacho?']);
await dm(L, realDanny, ['Danny, ya quedaron César y Alicia en los grupos con Estudio Norte y Nexo.']);
const chat = await call('/chats', { token: L.token, body: { userIds: [cesar, alicia, A.id], name: 'Textos de la campaña' } });
const chatId = chat.id ?? chat.conversation?.id;
await say(L, chatId, 'Armé este chat para cerrar los textos de la campaña con Ana.');
await say(A, chatId, 'Genial. Les comparto el borrador en un rato.');
console.log('Listo');
