#!/usr/bin/env node
/**
 * Agente de DEMOSTRACIÓN del flujo IA del tablero (llamada con Lorena, 7-oct). Recibe el webhook firmado de su agente
 * (task.created, task.assigned, task.changes_requested, task.commented, task.approved…) y trabaja la tarjeta por el MCP.
 * Un ticket que llega (task.created) solo se escucha: la persona elige a qué agente asignarlo (Xertify, Xertiflow…).
 * Asignado, el agente la toma, «la resuelve» (aquí con respuestas fijas), carga la evidencia, la deja por revisar a la persona que revisa
 * y, si le piden corrección, la retoma. No llama a ningún modelo: sirve para probar el circuito de punta a punta en local.
 *
 *   CHAGGU_MCP_URL=http://localhost:14100/api/mcp AGENT_TOKEN=... AGENT_SECRET=whsec_... REVIEWER="Lorena Tapias" \
 *     node scripts/agente-tablero-demo.mjs
 */
import http from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';

const MCP = process.env.CHAGGU_MCP_URL ?? 'http://localhost:3020/api/mcp';
const TOKEN = process.env.AGENT_TOKEN;
const SECRET = process.env.AGENT_SECRET;
const REVIEWER = process.env.REVIEWER ?? 'Lorena Tapias';
const PORT = Number(process.env.PORT ?? 14190);
const PACE = Number(process.env.PACE_MS ?? 2500); // pausa entre pasos para que se vea en el tablero
// Capturas de evidencia de ejemplo (PNG) por clave: envio-v1, envio-v2, flujo. Sin carpeta, solo sube el informe .md.
const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
if (!TOKEN || !SECRET) { console.error('Define AGENT_TOKEN y AGENT_SECRET'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function tool(name, args) {
  const res = await fetch(MCP, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = await res.json();
  if (j.error || j.result?.isError) throw new Error(`${name}: ${j.error?.message ?? j.result.content[0].text}`);
  return j.result.structuredContent;
}

function verify(raw, header) {
  const m = /^t=(\d+),v1=([0-9a-f]+)$/.exec(header ?? '');
  if (!m || Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return false;
  const want = createHmac('sha256', SECRET).update(`${m[1]}.${raw}`).digest('hex');
  return want.length === m[2].length && timingSafeEqual(Buffer.from(want), Buffer.from(m[2]));
}

/** «Resolver»: guion fijo por palabra clave. Un agente real llamaría aquí a su modelo y a sus herramientas. */
function solve(task, correction) {
  const t = task.title.toLowerCase();
  if (t.includes('flujo') || t.includes('excusa')) return {
    image: 'flujo',
    did: '- El caso estaba detenido en «Revisión del docente»: el docente asignado ya no está activo en la entidad de funcionarios.\n- Reasigné la tarea al coordinador del programa y el caso avanzó al paso de aprobación.',
    evidence: `# Evidencia\n\nTicket: ${task.externalId ? `#${task.externalId} ` : ''}${task.title}\n\n## Qué pidió el cliente\nEl flujo no avanza al paso de aprobación.\n\n## Qué encontré\nEl paso «Revisión del docente» apuntaba a un funcionario inactivo.\n\n## Qué hice\n- Reasigné la tarea al coordinador del programa.\n- Verifiqué que el caso quedó en «Aprobación».\n`,
  };
  if (t.includes('factura') || t.includes('radicar')) return { human: 'Radicar la factura exige entrar al portal del cliente con usuario y firma de Xertify: no lo hago yo. Queda para una persona.' };
  if (correction) return {
    image: 'envio-v2',
    did: `Corrección pedida: «${correction}».\n- Actualicé el correo en el perfil del estudiante (juan.perez@gmail.com).\n- Volví a reenviar el certificado y verifiqué que el enlace abre.`,
    evidence: `# Evidencia (corrección)\n\nTicket: ${task.externalId ? `#${task.externalId} ` : ''}${task.title}\n\n## Qué pidió la revisión\n${correction}\n\n## Qué hice\n- Perfil del estudiante: correo actualizado de juan.perez@gmial.com a juan.perez@gmail.com.\n- Reenvío del certificado: entregado (estado 250 OK del servidor de correo).\n- Enlace del certificado verificado: abre y muestra el código QR.\n`,
  };
  return {
    image: 'envio-v1',
    did: '- Encontré el envío: el correo del estudiante estaba mal escrito (juan.perez@gmial.com).\n- Reenvié el certificado al correo correcto y verifiqué la entrega.',
    evidence: `# Evidencia\n\nTicket: ${task.externalId ? `#${task.externalId} ` : ''}${task.title}\n\n## Qué pidió el cliente\nEl estudiante no recibió su certificado.\n\n## Qué encontré\nEl envío original rebotó: dirección juan.perez@gmial.com (dominio mal escrito).\n\n## Qué hice\n- Reenvié el certificado a juan.perez@gmail.com: entregado.\n- Enlace del certificado verificado.\n`,
  };
}

const upload = async (taskId, name, contentType, bytes) =>
  (await tool('upload_task_attachment', { id: taskId, name, content_type: contentType, data_base64: Buffer.from(bytes).toString('base64'), idempotency_key: randomUUID() })).attachment?.id;

async function work(ev, correction) {
  const task = ev.task;
  log('🤖 tomo', task.title);
  await tool('update_task', { id: task.id, status: 'in_progress', assignees: [ev.agent.id], ...(task.review ? { review: null } : {}) });
  const seen = (ev.attachments ?? []).map((a) => a.name).join(', ');
  await tool('comment_task', { id: task.id, text: correction ? `🤖 Retomo la tarjeta con tu corrección: «${correction}».${seen ? ` Revisé tu captura (${seen}).` : ''}` : '🤖 Tomé el ticket. Lo estoy revisando.' });
  await sleep(PACE * 2);
  const r = solve(task, correction);
  if (r.human) {
    await tool('comment_task', { id: task.id, text: `🙋 ${r.human}` });
    await tool('update_task', { id: task.id, review: 'human', assignees: [REVIEWER], review_note: 'Necesita intervención humana: asígnala a quien pueda hacerlo.' });
    log('🙋 intervención humana', task.title);
    return;
  }
  // La evidencia va dentro del comentario: la captura y el informe con lo que pidió el cliente y lo que se hizo.
  const base = `evidencia-${task.externalId ?? task.id.slice(0, 8)}${correction ? '-v2' : ''}`;
  const ids = [];
  const png = EVIDENCE_DIR && r.image ? `${EVIDENCE_DIR}/${r.image}.png` : null;
  if (png && fs.existsSync(png)) ids.push(await upload(task.id, `${base}.png`, 'image/png', fs.readFileSync(png)));
  ids.push(await upload(task.id, `${base}.md`, 'text/markdown', r.evidence));
  await tool('comment_task', { id: task.id, text: `🤖 Resuelto. Te dejo la evidencia:\n${r.did}`, attachment_ids: ids.filter(Boolean) });
  await sleep(PACE);
  await tool('update_task', { id: task.id, review: 'pending', assignees: [REVIEWER], review_note: 'Listo para revisar: si está bien, apruébalo y se le avisa al cliente.' });
  log('👀 por revisar', task.title);
}

async function handle(ev) {
  log('←', ev.type, ev.task?.title ?? '');
  switch (ev.type) {
    case 'task.created': return undefined; // llegó un ticket al grupo: espera a que se lo asignen
    case 'task.assigned': await sleep(PACE); return work(ev);
    case 'task.changes_requested': await sleep(PACE); return work(ev, ev.note ?? 'Revisa de nuevo');
    case 'task.approved':
      await tool('comment_task', { id: ev.task.id, text: '✅ Aprobado. Entregado al cliente y notificado.' });
      return tool('update_task', { id: ev.task.id, status: 'done' });
    case 'task.commented':
      // Responde sobre la misma tarea a lo que le escribe la persona.
      return tool('comment_task', { id: ev.task.id, text: `🤖 Recibido: «${ev.comment.body.slice(0, 200)}»${ev.attachments?.length ? ` y tu captura (${ev.attachments.map((a) => a.name).join(', ')})` : ''}. Si quieres que lo corrija, márcalo «Pedir corrección» y lo retomo.` });
    default: return undefined;
  }
}

http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    if (req.method !== 'POST' || !verify(raw, req.headers['x-chaggu-signature'])) { res.statusCode = 401; return res.end(); }
    res.end('ok'); // responder rápido: el trabajo sigue aparte
    const ev = JSON.parse(raw);
    if (ev.type?.startsWith('task.')) handle(ev).catch((e) => log('✗', e.message));
  });
}).listen(PORT, '127.0.0.1', () => log(`agente de demostración escuchando en :${PORT}`));
