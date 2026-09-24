#!/usr/bin/env node
/**
 * Fixture de pruebas para las apps nativas: dos personas de empresas distintas
 * (A y B) que comparten un espacio y su grupo general. Contraseñas aleatorias,
 * solo contra la base de pruebas. Escribe el resultado en FIXTURE_OUT (JSON).
 *
 *   API_URL=http://localhost:3021 FIXTURE_OUT=/tmp/fx.json node scripts/mobile-fixture.mjs
 */
import { randomUUID, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const API = process.env.API_URL ?? 'http://localhost:3021';
if (/app\.tiecoms\.com/.test(API)) { console.error('Este fixture es solo para la base de pruebas'); process.exit(1); }
const tag = process.env.FIXTURE_TAG ?? randomBytes(3).toString('hex');
const password = randomBytes(12).toString('base64url');

async function call(path, { token, body } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}
const device = () => ({ deviceId: randomUUID(), name: 'Fixture móvil', platform: 'agent' });

const a = await call('/auth/signup', { body: { name: `Ana Móvil ${tag}`, email: `ana.${tag}@qa.tiecoms.test`, password, orgName: `QA Móvil A ${tag}`, device: device() } });
const b = await call('/auth/signup', { body: { name: `Beto Bot ${tag}`, email: `beto.${tag}@qa.tiecoms.test`, password, orgName: `QA Móvil B ${tag}`, device: device() } });
const ws = await call('/workspaces', { token: a.accessToken, body: { name: `Pruebas móviles ${tag}`, department: 'QA' } });
const inv = await call(`/workspaces/${ws.id}/invitations`, { token: a.accessToken, body: { email: b.user.email, role: 'member', conversationIds: [ws.generalConversationId] } });
await call(`/invitations/${inv.token}/accept`, { token: b.accessToken, body: {} });
await call(`/conversations/${ws.generalConversationId}/messages`, { token: b.accessToken, body: { clientMessageId: randomUUID(), body: 'Hola desde la empresa B 👋' } });

const out = {
  apiUrl: API, password, workspaceId: ws.id, conversationId: ws.generalConversationId,
  a: { email: a.user.email, id: a.user.id, name: a.user.name },
  b: { email: b.user.email, id: b.user.id, name: b.user.name },
};
if (process.env.FIXTURE_OUT) writeFileSync(process.env.FIXTURE_OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
