#!/usr/bin/env node
/**
 * Datos de demostración: 3 empresas, 6 personas, 1 tercero, 2 espacios entre
 * empresas, grupos (compartido, directivo, interno, con tercero) y directos.
 * Todo pasa por el API público, así que se aplican los mismos permisos que en uso real.
 *
 *   API_URL=https://app.chaggu.com DEMO_PASSWORD='...' node scripts/seed-demo.mjs
 *
 * No es idempotente a propósito: si la primera cuenta ya existe, se detiene.
 */
import { randomUUID } from 'node:crypto';

const API = process.env.API_URL ?? 'http://localhost:3020';
const PASSWORD = process.env.DEMO_PASSWORD;
const DOMAIN = process.env.DEMO_DOMAIN ?? 'demo.tiecoms.com';
if (!PASSWORD || PASSWORD.length < 10) { console.error('Define DEMO_PASSWORD (10+ caracteres)'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, { token, body, method } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}/api/v1${path}`, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), 'x-tiecoms-client': 'seed', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < 6) { await sleep(4000 * (attempt + 1)); continue; }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method ?? (body ? 'POST' : 'GET')} ${path} → ${res.status} ${JSON.stringify(json)}`);
    return json;
  }
}

const device = () => ({ deviceId: randomUUID(), name: 'Carga de demo', platform: 'agent' });
const email = (u) => `${u}@${DOMAIN}`;

async function signup(user, name, title, org) {
  const r = await call('/auth/signup', { body: { name, title, email: email(user), password: PASSWORD, device: device(), ...org } });
  console.log(`  ✓ ${name} <${email(user)}>`);
  return { token: r.accessToken, id: r.user.id, orgId: r.user.primaryOrgId, name };
}

async function colleague(owner, user, name, title) {
  const inv = await call(`/organizations/${owner.orgId}/invitations`, { token: owner.token, body: { email: email(user) } });
  return signup(user, name, title, { orgInviteToken: inv.token });
}

async function inviteAndAccept(inviter, workspaceId, guest, opts) {
  const inv = await call(`/workspaces/${workspaceId}/invitations`, { token: inviter.token, body: { email: email(guest.user), ...opts } });
  await call(`/invitations/${inv.token}/accept`, { token: guest.token, body: {} });
}

async function say(who, conversationId, text) {
  await call(`/conversations/${conversationId}/messages`, { token: who.token, body: { clientMessageId: randomUUID(), body: text } });
  await sleep(250); // orden natural y lejos de los límites de ritmo
}

// ¿Ya se sembró?
const probe = await fetch(`${API}/api/v1/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: email('danny'), password: PASSWORD, device: device() }),
});
if (probe.ok) { console.error(`Ya existen los datos de demo en ${API}. No se vuelve a sembrar.`); process.exit(2); }

console.log(`Sembrando demo en ${API}`);
console.log('Empresas y personas');
const danny = await signup('danny', 'Danny Suárez', 'Líder técnico', { orgName: 'Xertify' });
const laura = await colleague(danny, 'laura', 'Laura Gómez', 'Atención y soporte');
const mateo = await signup('mateo', 'Mateo Rivas', 'Director de proyectos', { orgName: 'Estudio Norte' });
const ana = await colleague(mateo, 'ana', 'Ana Torres', 'Coordinadora de lanzamiento');
const lucia = await signup('lucia', 'Lucía Méndez', 'Gerente de operaciones', { orgName: 'Nexo Logística' });
const carlos = await colleague(lucia, 'carlos', 'Carlos Ruiz', 'Coordinador de rutas');
const julian = await signup('julian', 'Julián Castro', 'Consultor legal independiente', { orgName: 'Castro Consultores' });
for (const [p, u] of [[danny, 'danny'], [laura, 'laura'], [mateo, 'mateo'], [ana, 'ana'], [lucia, 'lucia'], [carlos, 'carlos'], [julian, 'julian']]) p.user = u;

console.log('Espacio 1: Xertify × Estudio Norte');
const ws1 = await call('/workspaces', { token: danny.token, body: { name: 'Lanzamiento · Estudio Norte', department: 'Portal de certificados' } });
await inviteAndAccept(danny, ws1.id, mateo, { role: 'member', conversationIds: [ws1.generalConversationId] });
await inviteAndAccept(danny, ws1.id, ana, { role: 'member', conversationIds: [ws1.generalConversationId] });
await inviteAndAccept(danny, ws1.id, laura, { role: 'member', conversationIds: [ws1.generalConversationId] });
const boot1 = await call('/bootstrap', { token: danny.token });
const internal1 = boot1.conversations.find((c) => c.workspaceId === ws1.id && c.kind === 'internal').id;
await call(`/conversations/${internal1}/members`, { token: danny.token, body: { userIds: [laura.id], history: 'all' } });
const comite = await call(`/workspaces/${ws1.id}/conversations`, { token: danny.token, body: { name: 'Comité directivo', level: 'directivo', memberIds: [mateo.id] } });
const contrato = await call(`/workspaces/${ws1.id}/conversations`, { token: danny.token, body: { name: 'Revisión del contrato', memberIds: [ana.id] } });
const until = new Date(Date.now() + 30 * 86400_000).toISOString();
await inviteAndAccept(danny, ws1.id, julian, { role: 'guest', conversationIds: [contrato.id], accessUntil: until });

console.log('Espacio 2: Estudio Norte × Nexo Logística');
const ws2 = await call('/workspaces', { token: mateo.token, body: { name: 'Entrega · Nexo Logística', department: 'Distribución de kits' } });
await inviteAndAccept(mateo, ws2.id, lucia, { role: 'member', conversationIds: [ws2.generalConversationId] });
await inviteAndAccept(mateo, ws2.id, carlos, { role: 'member', conversationIds: [ws2.generalConversationId] });
await inviteAndAccept(mateo, ws2.id, ana, { role: 'member', conversationIds: [ws2.generalConversationId] });
const boot2 = await call('/bootstrap', { token: lucia.token });
const rutas = await call(`/workspaces/${ws2.id}/conversations`, { token: lucia.token, body: { name: 'Rutas y horarios', kind: 'internal', memberIds: [carlos.id] } });
void boot2;

console.log('Conversaciones');
const g1 = ws1.generalConversationId;
await say(mateo, g1, 'Hola equipo 👋 Arrancamos el lanzamiento del portal de certificados. ¿Podemos tener la integración lista para el viernes?');
await say(danny, g1, 'Hola Mateo. Sí: el API ya está en pruebas. Solo nos falta validar con Ana el formato final de los certificados.');
await say(ana, g1, 'Hoy en la tarde les comparto la plantilla final con los campos obligatorios.');
await say(laura, g1, 'Perfecto. Yo me encargo de las pruebas con los primeros 20 usuarios en cuanto llegue la plantilla.');
await say(mateo, g1, 'Excelente. Dejo la fecha de salida en el comité para confirmarla con dirección.');
await say(danny, internal1, 'Laura, ojo: Estudio Norte quiere salir el viernes. ¿Alcanzamos con la carga masiva?');
await say(laura, internal1, 'Sí, si la plantilla llega hoy. El jueves hago la prueba de carga con 500 registros.');
await say(danny, comite.id, 'Mateo, propongo salida el viernes 10:00 con plan de reversa listo. ¿Lo validas con tu dirección?');
await say(mateo, comite.id, 'De acuerdo. Lo presento mañana a primera hora y te confirmo por aquí.');
await say(danny, contrato.id, 'Julián, te sumamos para revisar la cláusula de tratamiento de datos antes de firmar.');
await say(julian, contrato.id, 'Con gusto. La 7.2 debe mencionar explícitamente la transferencia internacional. Mañana les envío una redacción sugerida.');
await say(ana, contrato.id, 'Gracias Julián, la esperamos para llevarla a firma el jueves.');

const g2 = ws2.generalConversationId;
await say(mateo, g2, 'Lucía, Carlos: necesitamos entregar 300 kits de bienvenida el jueves en Bogotá y Medellín.');
await say(lucia, g2, 'Recibido. Bogotá está confirmado; Medellín depende del cupo del camión de la mañana.');
await say(carlos, rutas.id, 'Lucía, el camión de Medellín tiene cupo a las 10:00 si movemos el pedido de la farmacia a la tarde.');
await say(lucia, rutas.id, 'Hazlo. Confirmo a Estudio Norte.');
await say(lucia, g2, 'Confirmado: Medellín sale el jueves a las 10:00. Carlos coordina la entrega.');
await say(ana, g2, '¡Genial! Les paso la lista de direcciones en una hora.');

const dm1 = await call('/directs', { token: danny.token, body: { userId: ana.id } });
await say(danny, dm1.id, 'Ana, ¿la plantilla trae el campo de firma digital o lo agregamos nosotros?');
await say(ana, dm1.id, 'Viene incluido. Te marco el campo en amarillo para que lo encuentres rápido.');
const dm2 = await call('/directs', { token: mateo.token, body: { userId: lucia.id } });
await say(mateo, dm2.id, 'Lucía, gracias por mover lo de Medellín. Te debo un café ☕');

console.log('\nListo. Cuentas de demo (misma contraseña):');
for (const u of ['danny', 'laura', 'mateo', 'ana', 'lucia', 'carlos', 'julian']) console.log(`  ${email(u)}`);
