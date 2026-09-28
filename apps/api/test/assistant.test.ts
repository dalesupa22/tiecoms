import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Asistente: skills y, sobre todo, AISLAMIENTO entre usuarios.
 * Un DeepSeek falso («atacante») obedece el guion que va en el mensaje del usuario: así probamos
 * qué pasa si el modelo intenta usar ids de otra persona, y vemos exactamente qué datos recibió.
 *   API con DEEPSEEK_URL=http://127.0.0.1:59081 y DEEPSEEK_API_KEY=x:
 *   API_URL=http://localhost:3081 npx vitest run test/assistant.test.ts
 */
const API = process.env.API_URL ?? 'http://localhost:3081';
const FAKE_PORT = Number(process.env.FAKE_DEEPSEEK_PORT ?? 59081);
const run = randomUUID().slice(0, 8);
interface Actor { token: string; id: string; orgId: string }

async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function signup(name: string, orgInviteToken?: string): Promise<Actor> {
  const res = await fetch(`${API}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({
    name, email: `${name.toLowerCase()}.ai.${run}@example.com`, password: 'clave-segura-123', ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }),
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'ios' },
  }) });
  const j: any = await res.json();
  expect(res.status).toBe(200);
  return { token: j.accessToken, id: j.user.id, orgId: j.user.primaryOrgId };
}
const send = (a: Actor, conv: string, body: string) => call(`/conversations/${conv}/messages`, { token: a.token, body: { clientMessageId: randomUUID(), body } });
const msgs = async (a: Actor, conv: string) => (await call(`/conversations/${conv}/messages?limit=50`, { token: a.token })).json.messages as any[];

// ---------- DeepSeek falso ----------
/** Cada petición que recibió el falso (para revisar qué vio el modelo). */
const seen: any[] = [];
let fake: Server;
function fakeReply(body: any) {
  const msgs: any[] = body.messages;
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  const script = JSON.parse(lastUser.content.replace(/^GUION /, '')) as { tool: string; args: any }[];
  const lastIdx = msgs.lastIndexOf(lastUser);
  const toolsDone = msgs.slice(lastIdx).some((m) => m.role === 'tool');
  if (!toolsDone && script.length) {
    return { role: 'assistant', content: '', tool_calls: script.map((s, i) => ({ id: `c${i}`, type: 'function', function: { name: s.tool, arguments: JSON.stringify(s.args) } })) };
  }
  // Segunda vuelta: devuelve lo que le contestaron las herramientas, tal cual.
  return { role: 'assistant', content: JSON.stringify(msgs.slice(lastIdx).filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content))) };
}
const ask = (a: Actor, script: { tool: string; args: any }[]) =>
  call('/assistant/turn', { token: a.token, body: { aiConsent: true, messages: [{ role: 'user', content: `GUION ${JSON.stringify(script)}` }], timezone: 'America/Bogota' } });
const toolOut = (r: { json: any }) => JSON.parse(r.json.reply) as any[];

let ana: Actor, beto: Actor, eva: Actor;
let anaBeto: string, evaSecret: string;
const SECRET = `clave-secreta-de-eva-${run}`;

beforeAll(async () => {
  fake = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      seen.push(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: fakeReply(body) }], usage: {} }));
    });
  });
  await new Promise<void>((r) => fake.listen(FAKE_PORT, '127.0.0.1', r));

  ana = await signup('Ana');
  beto = await signup('Beto', (await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: {} })).json.token);
  // Eva: otra empresa, sin nada en común con Ana.
  eva = await signup('Eva');
  const evaMate = await signup('Evamate', (await call(`/organizations/${eva.orgId}/invitations`, { token: eva.token, body: {} })).json.token);
  anaBeto = (await call('/chats', { token: ana.token, body: { userIds: [beto.id] } })).json.id;
  evaSecret = (await call('/chats', { token: eva.token, body: { userIds: [evaMate.id], name: `Secreto ${run}` } })).json.id;
  await send(beto, anaBeto, '¿Me confirmas la reunión del jueves?');
  await send(evaMate, evaSecret, SECRET);
});
afterAll(async () => { await new Promise((r) => fake.close(r)); });

describe('asistente: aislamiento entre usuarios', () => {
  it('sin permiso explícito no envía el directorio ni mensajes a DeepSeek', async () => {
    seen.length = 0;
    for (const aiConsent of [undefined, false]) {
      const r = await call('/assistant/turn', { token: ana.token, body: { aiConsent, messages: [{ role: 'user', content: 'GUION []' }] } });
      expect(r.status).toBe(403);
      expect(r.json.error.code).toBe('ai_consent_required');
    }
    expect(seen).toHaveLength(0);
  });

  it('sin permiso explícito no transcribe audio con Inworld', async () => {
    const r = await fetch(`${API}/api/v1/assistant/transcribe?lang=es`, {
      method: 'POST', headers: { authorization: `Bearer ${ana.token}`, 'content-type': 'application/octet-stream', 'x-file-type': 'audio/wav' },
      body: Buffer.from('audio-sin-consentimiento'),
    });
    expect(r.status).toBe(403);
    expect((await r.json() as any).error.code).toBe('ai_consent_required');
  });

  it('el directorio y el reporte de Ana no contienen nada de Eva', async () => {
    seen.length = 0;
    const r = await ask(ana, [{ tool: 'reporte', args: {} }]);
    expect(r.status).toBe(200);
    const everything = JSON.stringify(seen) + r.json.reply;
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(evaSecret);
    expect(everything).not.toContain(eva.id);
    expect(everything).not.toContain(`Secreto ${run}`);
    // Pero sí lo suyo.
    expect(toolOut(r)[0].chatsSinLeer.some((c: any) => c.ultimos.join(' ').includes('reunión del jueves'))).toBe(true);
  });

  it('aunque el modelo use ids de Eva, no lee ni escribe nada suyo', async () => {
    const r = await ask(ana, [
      { tool: 'leer_conversacion', args: { conversationId: evaSecret } },
      { tool: 'enviar_mensaje', args: { conversationId: evaSecret, texto: 'hola intrusa' } },
      { tool: 'enviar_mensaje', args: { personId: eva.id, texto: 'hola' } },
      { tool: 'crear_asunto', args: { conversationId: evaSecret, titulo: 'Tarea intrusa' } },
      { tool: 'crear_grupo', args: { nombre: 'Robo', personIds: [eva.id] } },
      { tool: 'crear_evento', args: { titulo: 'Intrusa', inicio: new Date(Date.now() + 86_400_000).toISOString(), invitadosIds: [eva.id] } },
    ]);
    expect(r.status).toBe(200);
    const outs = toolOut(r);
    expect(outs.every((o) => typeof o.error === 'string')).toBe(true);
    expect(r.json.actions).toEqual([]);
    expect(JSON.stringify(r.json)).not.toContain(SECRET);
    expect((await msgs(eva, evaSecret)).map((m) => m.body).join(' ')).not.toContain('intrusa');
  });

  it('un token de Ana no le sirve a Eva, ni uno alterado', async () => {
    const r = await ask(ana, [{ tool: 'enviar_mensaje', args: { personId: beto.id, texto: 'Sí, el jueves a las 3' } }]);
    const token = r.json.actions[0].token as string;
    expect((await call('/assistant/run', { token: eva.token, body: { token } })).status).toBe(403);
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), u: eva.id })).toString('base64url');
    expect((await call('/assistant/run', { token: eva.token, body: { token: `${forged}.${sig}` } })).status).toBe(400);
    expect((await msgs(beto, anaBeto)).some((m) => m.body === 'Sí, el jueves a las 3')).toBe(false);
  });

  it('sin sesión no hay asistente', async () => {
    expect((await call('/assistant/turn', { body: { messages: [{ role: 'user', content: 'hola' }] } })).status).toBe(401);
  });
});

describe('asistente: skills', () => {
  it('responde a varios por separado solo al confirmar, y el deshacer borra', async () => {
    const r = await ask(ana, [
      { tool: 'enviar_mensaje', args: { personId: beto.id, texto: 'Confirmado el jueves' } },
      { tool: 'enviar_mensaje', args: { conversationId: anaBeto, texto: 'Y te mando la factura' } },
    ]);
    expect(r.json.actions.map((a: any) => a.status)).toEqual(['pending', 'pending']);
    expect((await msgs(beto, anaBeto)).some((m) => m.body === 'Confirmado el jueves')).toBe(false);
    const ok = await call('/assistant/run', { token: ana.token, body: { token: r.json.actions[0].token } });
    expect(ok.status).toBe(200);
    // Confirmar dos veces no duplica.
    await call('/assistant/run', { token: ana.token, body: { token: r.json.actions[0].token } });
    const edited = await call('/assistant/run', { token: ana.token, body: { token: r.json.actions[1].token, text: 'Te mando la factura hoy' } });
    const bodies = (await msgs(beto, anaBeto)).filter((m) => !m.deletedAt).map((m) => m.body);
    expect(bodies.filter((b) => b === 'Confirmado el jueves')).toHaveLength(1);
    expect(bodies).toContain('Te mando la factura hoy');
    expect((await call('/assistant/run', { token: ana.token, body: { token: edited.json.undoToken } })).status).toBe(200);
    expect((await msgs(beto, anaBeto)).filter((m) => !m.deletedAt).map((m) => m.body)).not.toContain('Te mando la factura hoy');
  });

  it('crea, asigna y completa asuntos (con deshacer)', async () => {
    const c = await ask(ana, [{ tool: 'crear_asunto', args: { conversationId: anaBeto, titulo: 'Revisar contrato', responsableId: beto.id, fecha: '2030-01-10' } }]);
    const asuntoId = toolOut(c)[0].asuntoId;
    expect(c.json.actions[0]).toMatchObject({ kind: 'create_issue', status: 'done' });
    const list = toolOut(await ask(ana, [{ tool: 'listar_asuntos', args: { alcance: 'asigne' } }]))[0];
    expect(list.some((i: any) => i.asuntoId === asuntoId && i.responsable === 'Beto')).toBe(true);
    const d = await ask(ana, [{ tool: 'actualizar_asunto', args: { asuntoId, estado: 'done' } }]);
    expect((await call(`/issues/${asuntoId}`, { token: ana.token })).json.issue.status).toBe('done');
    await call('/assistant/run', { token: ana.token, body: { token: d.json.actions[0].undoToken } });
    expect((await call(`/issues/${asuntoId}`, { token: ana.token })).json.issue.status).toBe('open');
  });

  it('crea una reunión y la cancela solo al confirmar, con aviso', async () => {
    const start = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const c = await ask(ana, [{ tool: 'crear_evento', args: { titulo: 'Reunión jueves', inicio: start, invitadosIds: [beto.id] } }]);
    const eventoId = toolOut(c)[0].eventoId;
    expect(eventoId).toBeTruthy();
    const x = await ask(ana, [{ tool: 'cancelar_evento', args: { eventoId, aviso: 'Se cancela, lo movemos' } }]);
    expect(x.json.actions[0].status).toBe('pending');
    expect((await call(`/events/${eventoId}`, { token: ana.token })).json.cancelledAt).toBeNull();
    await call('/assistant/run', { token: ana.token, body: { token: x.json.actions[0].token } });
    expect((await call(`/events/${eventoId}`, { token: ana.token })).json.cancelledAt).not.toBeNull();
    expect((await msgs(beto, anaBeto)).map((m) => m.body)).toContain('Se cancela, lo movemos');
  });

  it('crea un grupo con personas del directorio al confirmar', async () => {
    const r = await ask(ana, [{ tool: 'crear_grupo', args: { nombre: `Equipo ${run}`, personIds: [beto.id] } }]);
    const ok = await call('/assistant/run', { token: ana.token, body: { token: r.json.actions[0].token } });
    expect(ok.status).toBe(200);
    const boot = (await call('/bootstrap', { token: beto.token })).json;
    expect(boot.conversations.some((c: any) => c.name === `Equipo ${run}`)).toBe(true);
  });

  it('marca como leído todo y el deshacer lo devuelve', async () => {
    await send(beto, anaBeto, 'otro mensaje sin leer');
    const unread = async () => (await call('/bootstrap', { token: ana.token })).json.conversations.find((c: any) => c.id === anaBeto).unread;
    expect(await unread()).toBeGreaterThan(0);
    const r = await ask(ana, [{ tool: 'marcar_leido', args: { todas: true } }]);
    expect(r.json.actions[0]).toMatchObject({ kind: 'mark_read', status: 'done' });
    expect(await unread()).toBe(0);
    await call('/assistant/run', { token: ana.token, body: { token: r.json.actions[0].undoToken } });
    expect(await unread()).toBeGreaterThan(0);
  });
});
