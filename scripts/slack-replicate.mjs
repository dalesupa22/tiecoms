#!/usr/bin/env node
/**
 * Replica los canales de Slack de Xertify como espacios y grupos en TieComs.
 * Lee el plan de `.secrets/slack-plan.json` (canales y miembros, fuera de git).
 *
 *   node scripts/slack-replicate.mjs            # crea espacios y grupos solo contigo (idempotente)
 *   node scripts/slack-replicate.mjs --invite   # manda las invitaciones por correo (pide confirmar)
 *
 * API_URL (por defecto https://app.tiecoms.com), TIECOMS_EMAIL y la contraseña se piden por consola
 * (o TIECOMS_PASSWORD para pruebas locales). No copia mensajes de Slack.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const API = process.env.API_URL ?? 'https://app.tiecoms.com';
const SECRETS = new URL('../../tiecoms/.secrets/', import.meta.url);
const PLAN = process.env.SLACK_PLAN ?? new URL('slack-plan.json', SECRETS).pathname;
const OUT = process.env.SLACK_OUT ?? new URL('slack-created.json', SECRETS).pathname;
const invite = process.argv.includes('--invite');
const plan = JSON.parse(readFileSync(PLAN, 'utf8'));

function ask(q, hidden = false) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); };
  return new Promise((res) => rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); res(a.trim()); }));
}

let token;
async function call(path, { body, method } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}/api/v1${path}`, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < 6) { await new Promise((r) => setTimeout(r, 3000 * (attempt + 1))); continue; }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${path} → ${res.status} ${json?.error?.message ?? ''}`);
    return json;
  }
}

const email = process.env.TIECOMS_EMAIL ?? await ask('Tu correo de TieComs: ');
const password = process.env.TIECOMS_PASSWORD ?? await ask('Contraseña (no se muestra): ', true);
token = (await call('/auth/login', { body: { email, password, device: { deviceId: randomUUID(), name: 'Réplica de Slack', platform: 'agent' } } })).accessToken;
console.log(`Conectado a ${API} como ${email}`);

const boot = await call('/bootstrap');
const created = { spaces: [] };
for (const space of plan.spaces) {
  let ws = boot.workspaces.find((w) => w.name === space.name);
  let generalId;
  if (ws) {
    generalId = boot.conversations.find((c) => c.workspaceId === ws.id && c.name === 'General')?.id;
    console.log(`= ${space.name} (ya existía)`);
  } else {
    const r = await call('/workspaces', { body: { name: space.name, department: 'Réplica de Slack' } });
    ws = { id: r.id }; generalId = r.generalConversationId;
    console.log(`+ ${space.name}`);
  }
  const groups = [];
  for (const g of space.groups) {
    if (g.mapToGeneral) { groups.push({ ...g, id: generalId }); console.log(`   # General ← #${g.slack}`); continue; }
    const existing = boot.conversations.find((c) => c.workspaceId === ws.id && c.name === g.name);
    const id = existing?.id ?? (await call(`/workspaces/${ws.id}/conversations`, {
      body: { name: g.name, kind: 'group', level: g.directivo ? 'directivo' : 'operativo', memberIds: [] },
    })).id;
    groups.push({ ...g, id });
    console.log(`   ${existing ? '=' : '+'} #${g.name} (${g.members.length} personas en Slack)`);
  }
  created.spaces.push({ name: space.name, id: ws.id, generalId, groups });
}
writeFileSync(OUT, JSON.stringify(created, null, 1), { mode: 0o600 });
console.log(`Listo: ${created.spaces.length} espacios, ${created.spaces.reduce((n, s) => n + s.groups.length, 0)} grupos. Detalle en ${OUT}`);

if (invite) {
  const me = boot.me.email?.toLowerCase();
  // Una invitación por persona y espacio, con los grupos de Slack en los que estaba.
  const invites = [];
  for (const s of created.spaces) {
    const byPerson = new Map();
    for (const g of s.groups) for (const m of g.members) if (m.toLowerCase() !== me) byPerson.set(m, [...(byPerson.get(m) ?? [s.generalId]), g.id]);
    for (const [who, convs] of byPerson) invites.push({ workspaceId: s.id, space: s.name, email: who, conversationIds: [...new Set(convs)] });
  }
  const people = new Set(invites.map((i) => i.email));
  console.log(`\nSe enviarán ${invites.length} invitaciones por correo a ${people.size} personas:\n  ${[...people].join('\n  ')}`);
  if ((await ask('Escribe ENVIAR para mandarlas: ')) !== 'ENVIAR') { console.log('No se envió nada.'); process.exit(0); }
  for (const i of invites) {
    await call(`/workspaces/${i.workspaceId}/invitations`, { body: { email: i.email, role: 'member', conversationIds: i.conversationIds, expiresInDays: 14 } });
    console.log(`  ✉ ${i.email} → ${i.space}`);
  }
}
