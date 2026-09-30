#!/usr/bin/env node
/**
 * Datos para medir la fluidez de Android (1.7.1): sobre el fixture de mobile-fixture.mjs (FIXTURE),
 * 200 mensajes en el grupo general (cortos, con enlaces, con menciones y algunos muy largos) y 20 grupos
 * más con actividad para la lista. Solo contra un API de pruebas local.
 *
 *   FIXTURE=/tmp/fx.json node scripts/android-bench-fixture.mjs
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const fx = JSON.parse(readFileSync(process.env.FIXTURE, 'utf8'));
const API = fx.apiUrl;
if (!/localhost|127\.0\.0\.1|10\.0\.2\.2/.test(API)) { console.error('Solo contra un API local de pruebas'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(path, { token, body } = {}) {
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${API}/api/v1${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) { await sleep(15_000); continue; }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(json)}`);
    return json;
  }
  throw new Error(`${path} → 429`);
}
const login = (email) => call('/auth/login', { body: { email, password: fx.password, device: { deviceId: randomUUID(), name: 'Bench', platform: 'agent' } } });
const a = await login(fx.a.email);
const b = await login(fx.b.email);
const long = Array.from({ length: 70 }, (_, i) => `Línea ${i + 1} de un mensaje muy largo para medir el desplazamiento con texto que ocupa varias filas.`).join('\n');
for (let i = 1; i <= 200; i++) {
  const who = i % 2 ? b : a;
  const body = i % 50 === 25 ? long
    : i % 7 === 0 ? `Mira https://example.com/doc/${i} y dime`
    : i % 11 === 0 ? `Mensaje ${i}: ${'palabras de relleno '.repeat(12)}`
    : `Mensaje ${i} 👋`;
  await call(`/conversations/${fx.conversationId}/messages`, { token: who.accessToken, body: { clientMessageId: randomUUID(), body } });
  await sleep(550);
}
for (let g = 1; g <= 20; g++) {
  const r = await call('/groups', { token: a.accessToken, body: { name: `Grupo de medición ${g}`, target: { kind: 'workspace', workspaceId: fx.workspaceId }, memberIds: [fx.b.id] } });
  await call(`/conversations/${r.conversationId}/messages`, { token: g % 2 ? b.accessToken : a.accessToken, body: { clientMessageId: randomUUID(), body: `Actividad del grupo ${g}` } });
  await sleep(2100);
}
console.log('listo');
