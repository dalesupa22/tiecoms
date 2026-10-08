#!/usr/bin/env node
/**
 * Runner de agentes IA del tablero (CH-IA-03, llamada con Lorena 7-oct). Corre en la máquina que resuelve (repos,
 * servidores, skills) y trabaja las tarjetas asignadas a cada agente con Claude Code (`claude -p`) o Codex (`codex exec`):
 *
 * - Webhook: Chaggu avisa al instante (task.assigned, task.changes_requested, task.commented, task.approved y lo que
 *   escriben en el chat de la tarea). Ruta POST /hook/<agente>, firma x-chaggu-signature con el secreto del agente.
 * - Cron: cada pollMinutes revisa por el MCP las tarjetas de cada agente (red de seguridad si un aviso no llegó o no
 *   hay URL pública). Solo arranca el modelo si hay trabajo.
 * - Cada tarjeta: claim_task (reserva; si otro la tiene, se salta), open_task_chat con quien revisa, y el modelo la
 *   resuelve, carga la evidencia y la deja por revisar. Si la corrida falla, comenta y suelta la reserva.
 *
 *   RUNNER_CONFIG=~/.config/chaggu/agentes.json node scripts/agentes-ia-runner.mjs
 *
 * Config (ejemplo en scripts/agentes-ia-runner.example.json): tokens y secretos van en variables de entorno
 * (tokenEnv / secretEnv), nunca en el archivo.
 *
 * Aislamiento: el modelo solo ve el MCP del agente (servidor «chaggu_agente» con el token del agente). Claude corre con
 * --strict-mcp-config y Codex con un CODEX_HOME propio por agente, así nunca usa la sesión de Chaggu de la persona
 * dueña de la máquina. Tras MAX_ATTEMPTS corridas sin terminar, la tarjeta pasa a intervención humana.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cfg = JSON.parse(fs.readFileSync(process.env.RUNNER_CONFIG ?? path.join(os.homedir(), '.config/chaggu/agentes.json'), 'utf8'));
const MCP = cfg.mcpUrl;
const POLL_MS = (cfg.pollMinutes ?? 10) * 60_000;
const MAX = cfg.maxConcurrent ?? 2;
const RUN_TIMEOUT = (cfg.runTimeoutMinutes ?? 40) * 60_000;
const REVIEWER = cfg.reviewer ?? 'Lorena Tapias';
const ONCE = process.argv.includes('--once');
const RUNNER_HOME = cfg.home ?? path.join(os.homedir(), '.config/chaggu/runner');
const MAX_ATTEMPTS = cfg.maxAttempts ?? 2;
const attempts = new Map(); // agente:tarea → corridas seguidas sin dejarla por revisar
const SERVER = 'chaggu_agente'; // una pasada del cron y salir (útil para probar o para crontab)

const slug = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const agents = cfg.agents.map((a) => ({
  ...a, slug: slug(a.name), token: process.env[a.tokenEnv], secret: a.secretEnv ? process.env[a.secretEnv] : null, id: null,
}));
for (const a of agents) if (!a.token) { console.error(`Falta ${a.tokenEnv} para ${a.name}`); process.exit(1); }
const log = (...x) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...x);

async function tool(agent, name, args) {
  const res = await fetch(MCP, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${agent.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${name}: ${j.error.message}`);
  if (j.result?.isError) { const e = new Error(`${name}: ${j.result.content?.[0]?.text}`); e.code = j.result.structuredContent?.error?.code; throw e; }
  return j.result.structuredContent;
}

function verify(secret, raw, header) {
  const m = /^t=(\d+),v1=([0-9a-f]+)$/.exec(header ?? '');
  if (!secret || !m || Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return false;
  const want = createHmac('sha256', secret).update(`${m[1]}.${raw}`).digest('hex');
  return want.length === m[2].length && timingSafeEqual(Buffer.from(want), Buffer.from(m[2]));
}

// ---------- Cola: una corrida por tarjeta a la vez, como máximo MAX en paralelo ----------
const queue = [];
const running = new Set();
const later = new Map(); // avisos que llegaron mientras el agente trabajaba esa tarjeta: se atienden al terminar
const RANK = { work: 0, approved: 1, chat: 2, comment: 2, changes: 3 }; // el aviso más informativo gana
const merge = (a, b) => (!a ? b : RANK[b.kind] >= RANK[a.kind] ? b : a);
function enqueue(agent, taskId, trigger) {
  const key = `${agent.slug}:${taskId}`;
  if (running.has(key)) { later.set(key, { agent, taskId, trigger: merge(later.get(key)?.trigger, trigger) }); log('·', agent.name, 'atenderá al terminar', taskId, trigger.kind); return; }
  const prev = queue.find((j) => j.key === key);
  if (prev) { prev.trigger = merge(prev.trigger, trigger); return; }
  // Un respiro para juntar avisos del mismo cambio (p. ej. «asignada» + «devuelta» al devolverla).
  queue.push({ key, agent, taskId, trigger, at: Date.now() + 1500 });
  setTimeout(pump, 1600);
}
function pump() {
  for (let i = 0; i < queue.length && running.size < MAX;) {
    const job = queue[i];
    if (job.at > Date.now()) { i++; continue; }
    queue.splice(i, 1);
    running.add(job.key);
    runJob(job).catch((e) => log('✗', job.agent.name, job.taskId, e.message)).finally(() => {
      running.delete(job.key);
      const next = later.get(job.key);
      if (next) { later.delete(job.key); enqueue(next.agent, next.taskId, next.trigger); }
      pump();
    });
  }
}

// ---------- Prompt y motor ----------
function prompt(agent, task, chatId, trigger) {
  const why = {
    work: 'Te asignaron esta tarjeta y está pendiente.',
    changes: `La revisión pidió corrección: «${trigger.note ?? ''}».${trigger.files?.length ? ` Adjuntó: ${trigger.files.join(', ')}: ábrelos con read_task_attachment.` : ''}`,
    comment: `Te escribieron en la tarjeta: «${trigger.text ?? ''}».${trigger.files?.length ? ` Adjuntó: ${trigger.files.join(', ')}: ábrelos con read_task_attachment.` : ''}${trigger.waiting ? ' La tarjeta estaba esperando tu pregunta: si esto la responde, continúa.' : ''}`,
    chat: `Te escribieron en el chat de la tarea: «${trigger.text ?? ''}».${trigger.waiting ? ' La tarjeta estaba esperando tu pregunta: si esto la responde, continúa.' : ''}`,
  }[trigger.kind];
  return [
    agent.instructions ?? `Eres ${agent.name}, un agente que resuelve tickets en Chaggu.`,
    '',
    `TAREA (${task.ticket ? `ticket #${task.ticket}` : 'tarea'}): ${task.title}`,
    `id: ${task.id} · chat de la tarea: ${chatId} · quien revisa: ${REVIEWER}`,
    ...(task.meta ? [`Datos del ticket: ${Object.entries(task.meta).filter(([k]) => !/adjuntos/i.test(k)).map(([k, v]) => `${k}: ${v}`).join(' · ')}`] : []),
    ...(ticketEmail(task) ? [`CUENTA DEL CLIENTE: usa SIEMPRE la cuenta del correo del ticket (${ticketEmail(task)}). Ubica la cuenta/emisor por ese correo, nunca por el nombre de la empresa; si ese correo no tiene cuenta o hay varias, pregunta (paso 7) antes de tocar nada.`] : []),
    `Por qué te despertaron: ${why}`,
    '',
    `Trabaja así, con las herramientas del MCP «${SERVER}» (eres ${agent.name} en Chaggu):`,
    '1. Lee la tarea completa con get_task (comentarios, archivos y datos del cliente) y abre con read_task_attachment las capturas y archivos que necesites (las imágenes las ves).',
    trigger.kind === 'comment' || trigger.kind === 'chat'
      ? `2. Si es la respuesta a una pregunta tuya o te piden cambios, avisa en el chat ${chatId} que continúas y sigue con los pasos 3-6. Si solo te preguntan algo, respóndelo con send_message en el chat (o comment_task) y termina.`
      : `2. Cuenta en el chat de la tarea (send_message chat=${chatId}) que la tomaste y tu plan en una o dos líneas.`,
    '3. Resuélvela con tus herramientas. No le escribas al cliente directamente y no cierres la tarea.',
    '4. Evidencia: sube capturas, registros o un informe .md con upload_task_attachment y publica UN comment_task con attachment_ids que diga qué pidió el cliente, qué encontraste, qué hiciste y cómo verificarlo.',
    `5. Déjala por revisar: update_task review="pending" assignees=["${REVIEWER}"] con un review_note corto.`,
    `6. Si necesita a una persona (credenciales, firma, trámite manual, decisión de negocio): explícalo con comment_task y update_task review="human" assignees=["${REVIEWER}"].`,
    `7. Si te falta un dato para seguir (algo que el ticket no dice y no puedes averiguar), NO adivines: pregunta concretamente en el chat de la tarea (send_message chat=${chatId}, mencionando a ${REVIEWER}) y en comment_task, deja update_task status="waiting" SIN cambiar los responsables (la tarjeta sigue contigo) y termina. Cuando te respondan te volverán a despertar.`,
    'Si algo falla, explícalo en la tarea antes de terminar.',
  ].join('\n');
}

/** Correo del ticket (regla de Danny 8-oct: la cuenta a usar es siempre la de ese correo). */
const ticketEmail = (task) => Object.entries(task.meta ?? {}).find(([k]) => /^(correo|email|e-mail)$/i.test(k.trim()))?.[1] ?? null;

function runEngine(agent, text) {
  return new Promise((resolve) => {
    const env = { ...process.env, CHAGGU_AGENT_TOKEN: agent.token };
    let cmd; let args; let tmp = null;
    if (agent.engine === 'codex') {
      // CODEX_HOME propio: solo el MCP del agente (aprobado para escribir) + la sesión de Codex de la máquina.
      const home = path.join(RUNNER_HOME, `codex-${agent.slug}`);
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      const auth = path.join(home, 'auth.json');
      if (!fs.existsSync(auth)) fs.symlinkSync(agent.codexAuth ?? path.join(os.homedir(), '.codex/auth.json'), auth);
      fs.writeFileSync(path.join(home, 'config.toml'), [
        `[mcp_servers.${SERVER}]`, `url = ${JSON.stringify(MCP)}`, 'bearer_token_env_var = "CHAGGU_AGENT_TOKEN"', 'default_tools_approval_mode = "approve"',
        ...(agent.codexConfig ? ['', agent.codexConfig] : []), '',
      ].join('\n'), { mode: 0o600 });
      env.CODEX_HOME = home;
      cmd = agent.bin ?? 'codex';
      args = ['exec', '--skip-git-repo-check', '-C', agent.cwd ?? process.cwd(), ...(agent.args ?? []), text];
    } else {
      // El token no se escribe a disco: la config usa ${CHAGGU_AGENT_TOKEN} y Claude Code lo expande del entorno.
      tmp = path.join(os.tmpdir(), `chaggu-mcp-${randomUUID()}.json`);
      fs.writeFileSync(tmp, JSON.stringify({ mcpServers: { [SERVER]: { type: 'http', url: MCP, headers: { Authorization: 'Bearer ${CHAGGU_AGENT_TOKEN}' } } } }), { mode: 0o600 });
      cmd = agent.bin ?? 'claude';
      args = ['-p', text, '--mcp-config', tmp, '--strict-mcp-config', '--allowedTools', `mcp__${SERVER}`, ...(agent.args ?? [])];
    }
    const child = spawn(cmd, args, { cwd: agent.cwd ?? process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out = (out + d).slice(-4000); });
    child.stderr.on('data', (d) => { out = (out + d).slice(-4000); });
    const timer = setTimeout(() => child.kill('SIGTERM'), RUN_TIMEOUT);
    child.on('close', (code) => { clearTimeout(timer); if (tmp) fs.rmSync(tmp, { force: true }); resolve({ code, out }); });
    child.on('error', (e) => { clearTimeout(timer); if (tmp) fs.rmSync(tmp, { force: true }); resolve({ code: -1, out: e.message }); });
  });
}

async function runJob({ agent, taskId, trigger: first }) {
  let trigger = first;
  if (trigger.kind === 'approved') {
    // Sin modelo: Lorena aprobó → se entrega (la integración del ticket avisa al cliente con el cambio de estado).
    await tool(agent, 'comment_task', { id: taskId, text: '✅ Aprobado. Entregado al cliente.' });
    await tool(agent, 'update_task', { id: taskId, status: 'done' });
    log('✅', agent.name, 'entregó', taskId);
    return;
  }
  // El aviso pudo quedar viejo (p. ej. el cron la encoló mientras otra corrida la terminaba): si ya está por revisar,
  // con una persona, esperando respuesta o cerrada, no se vuelve a tomar.
  if (trigger.kind === 'work') {
    const now = (await tool(agent, 'get_task', { id: taskId })).task;
    if (['pending', 'human', 'approved'].includes(now.review) || ['done', 'cancelled', 'waiting'].includes(now.status)) {
      log('·', agent.name, 'salta', taskId, `ya está ${now.review ?? now.status}`);
      return;
    }
  }
  let task;
  try { task = (await tool(agent, 'claim_task', { id: taskId, minutes: Math.ceil(RUN_TIMEOUT / 60_000) + 5 })).task; }
  catch (e) { if (e.code === 'task_claimed' || e.code === 'task_in_review' || e.code === 'bad_request') { log('·', agent.name, 'salta', taskId, e.message); return; } throw e; }
  // Si la tarjeta viene devuelta, el prompt lo dice aunque el aviso haya sido solo «asignada» (p. ej. por el cron).
  if (trigger.kind === 'work' && task.review === 'changes') trigger = { kind: 'changes', note: 'La revisión la devolvió: lee el último comentario de revisión (y sus capturas) con get_task.' };
  const chat = (await tool(agent, 'open_task_chat', { id: taskId, people: [REVIEWER] })).chat;
  log('🤖', agent.name, 'toma', task.ticket ? `#${task.ticket}` : '', task.title, `(${trigger.kind}, ${agent.engine ?? 'claude'})`);
  const r = await runEngine(agent, prompt(agent, task, chat, trigger));
  const after = (await tool(agent, 'get_task', { id: taskId })).task;
  const key = `${agent.slug}:${taskId}`;
  if (after.review === 'pending' || after.review === 'human' || ['done', 'cancelled', 'waiting'].includes(after.status)) {
    attempts.delete(key);
    log(after.status === 'waiting' ? '❓' : '👀', agent.name, after.status === 'waiting' ? 'preguntó y espera respuesta' : 'terminó', taskId, after.review ?? after.status);
    if (after.claimedBy) await tool(agent, 'release_task', { id: taskId }).catch(() => {});
    return;
  }
  // No la dejó por revisar: o solo respondió una pregunta, o falló. Si falló, que se note en la tarea.
  if (trigger.kind === 'work' || trigger.kind === 'changes') {
    const n = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, n);
    if (n >= MAX_ATTEMPTS) {
      attempts.delete(key);
      await tool(agent, 'comment_task', { id: taskId, text: `🙋 ${agent.name} lo intentó ${n} veces sin dejarla lista. Pasa a una persona.\n\n${r.out.slice(-600)}` }).catch(() => {});
      await tool(agent, 'update_task', { id: taskId, review: 'human', assignees: [REVIEWER], review_note: 'El agente no pudo terminarla: necesita a una persona.' }).catch(() => {});
      log('🙋', agent.name, 'pasa a persona', taskId);
      return;
    }
  }
  if (r.code !== 0) await tool(agent, 'comment_task', { id: taskId, text: `⚠️ ${agent.name} no pudo terminar esta corrida (código ${r.code}). Queda libre para reintentar o para una persona.\n\n${r.out.slice(-800)}` }).catch(() => {});
  await tool(agent, 'release_task', { id: taskId }).catch(() => {});
  log(r.code === 0 ? '💬' : '⚠️', agent.name, 'soltó', taskId, `código ${r.code}`);
}

// ---------- Cron: tarjetas del agente que esperan trabajo ----------
async function poll() {
  for (const a of agents) {
    try {
      const r = await tool(a, 'list_tasks', { mine: true, limit: 50 });
      for (const t of r.tasks ?? []) {
        // «waiting»: preguntó y espera. Si después de su pregunta alguien escribió en la tarjeta, ya le respondieron.
        if (t.status === 'waiting' && !t.claimedBy) {
          const act = (await tool(a, 'get_task', { id: t.id })).activity ?? [];
          const lastComment = [...act].reverse().find((x) => x.kind === 'comment');
          const mine = (by) => !by || by === a.name || by.endsWith('(tú)');
          if (lastComment && !mine(lastComment.by)) enqueue(a, t.id, { kind: 'comment', text: lastComment.text, waiting: true });
          continue;
        }
        const open = !['done', 'cancelled', 'waiting'].includes(t.status);
        const waiting = !t.review || t.review === 'changes';
        const free = !t.claimedBy || t.claimedBy.endsWith('(tú)');
        if (open && waiting && free) enqueue(a, t.id, t.review === 'changes' ? { kind: 'changes', note: 'Revisa los comentarios de la revisión en la tarea.' } : { kind: 'work' });
        if (t.review === 'approved' && open) enqueue(a, t.id, { kind: 'approved' });
      }
    } catch (e) { log('✗ cron', a.name, e.message); }
  }
}

// ---------- Webhook ----------
function onEvent(agent, ev) {
  const files = (ev.attachments ?? []).map((x) => x.name);
  switch (ev.type) {
    case 'task.assigned': return enqueue(agent, ev.task.id, { kind: 'work' });
    case 'task.changes_requested': return enqueue(agent, ev.task.id, { kind: 'changes', note: ev.note, files });
    case 'task.commented': return enqueue(agent, ev.task.id, { kind: 'comment', text: ev.comment?.body, files, waiting: ev.task.status === 'waiting' });
    case 'task.approved': return enqueue(agent, ev.task.id, { kind: 'approved' });
    case 'message.created': case 'message.mention': case 'message.reply':
      if (ev.conversation?.taskId) return enqueue(agent, ev.conversation.taskId, { kind: 'chat', text: ev.message?.body });
      return undefined;
    default: return undefined; // task.created: la persona elige a qué agente asignarlo
  }
}

if (!ONCE) {
  http.createServer((req, res) => {
    const m = /^\/hook\/([a-z0-9-]+)$/.exec(req.url ?? '');
    const agent = m && agents.find((a) => a.slug === m[1]);
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (req.method !== 'POST' || !agent || !verify(agent.secret, raw, req.headers['x-chaggu-signature'])) { res.statusCode = 401; return res.end(); }
      res.end('ok'); // responder rápido; el trabajo sigue aparte
      try { onEvent(agent, JSON.parse(raw)); } catch (e) { log('✗ webhook', e.message); }
    });
  }).listen(cfg.port ?? 14190, cfg.host ?? '127.0.0.1', () => log(`runner escuchando en :${cfg.port ?? 14190} · ${agents.map((a) => `${a.name} → /hook/${a.slug} (${a.engine ?? 'claude'})`).join(' · ')}`));
  setInterval(() => void poll(), POLL_MS);
}
await poll();
if (ONCE) {
  const wait = () => new Promise((r) => { const t = setInterval(() => { if (!queue.length && !running.size) { clearInterval(t); r(); } }, 500); });
  await wait();
}
