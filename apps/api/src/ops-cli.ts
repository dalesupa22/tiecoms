/**
 * Operaciones reservadas a administradores con acceso SSH (sin ruta pública). Usan las mismas funciones del API,
 * a nombre de la persona indicada con --as, y dejan auditoría como cualquier acción suya.
 *
 *   node ops.js members <dominio>                         personas y empresas con ese dominio de correo (solo lectura)
 *   node ops.js groups <correo>                           grupos donde está esa persona (solo lectura)
 *   node ops.js create-group <correo> "<nombre>" [correos,de,miembros] ["<empresa>"]   grupo de «Tu organización» de esa empresa
 *   node ops.js create-integration <correo> <conversationId> "<nombre>" [urlDeSalida]
 *   node ops.js import-events <correo> <conversationId> < eventos.json   agenda sin convocatorias ni avisos (idempotente)
 *   node ops.js purge-integration-issues <integrationId> <externalId,...>  borra esos asuntos y sus avisos del chat
 *   node ops.js booking-page <correo dueño> <slug> "<título>" <collective|round_robin> <minutos> <correos,de,anfitriones> ["<descripción>" ["<empresa>" ["<título en>" ["<descripción en>"]]]]   página de citas (docs/CITAS.md; idempotente por slug)
 *   node ops.js booking-status                              páginas de citas y si cada anfitrión tiene calendario conectado (solo lectura)
 *   node ops.js app-version <ios|android> <versión> <build> [minBuild] ["notas es"] ["notas en"]   última versión publicada (docs/ACTUALIZAR.md)
 *   node ops.js app-version <mac|windows> <versión> [url de descarga]     escritorio: el build sale de la versión (0.3.0 → 300)
 *   node ops.js app-version <ios|android>                  muestra la registrada
 *   node ops.js create-agent <correo dueño> "<nombre>" <conversationId,...> ["<empresa>"] ["<cargo>"]
 *       agente miembro (users.kind='agent', docs/AGENTES.md): entra a la empresa y a esos grupos; idempotente por nombre
 *       dentro de la empresa. Si es nuevo imprime su token MCP (`chgmcp_`) UNA vez.
 *   node ops.js agent-token <correo dueño> "<nombre>" ["<empresa>"]   token MCP nuevo para un agente existente (rotar)
 *   node ops.js agents                                     agentes miembro, su empresa, dueño y grupos (solo lectura)
 *       imprime el JSON con el token (y el secreto de salida) UNA vez: redirígelo a un archivo protegido.
 */
import { BookingPageInput, CreateGroupInput, CreateIntegrationInput } from '@tiecoms/contracts';
import { createGroup } from './modules/groups.ts';
import { createIntegration } from './modules/integrations.ts';
import { importEvents } from './modules/calendar.ts';
import { appendEvent, toMessageDTO } from './modules/messages.ts';
import { CreateEventInput } from '@tiecoms/contracts';
import { audit, enqueueOutbox, pool, tx } from './db.ts';
import { createPage, myPages, updatePage } from './modules/booking.ts';
import { addMembers } from './modules/workspaces.ts';
import { createToken } from './modules/mcp.ts';
import { AddMembersInput } from '@tiecoms/contracts';

async function userId(email: string): Promise<string> {
  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1 AND disabled_at IS NULL', [email]);
  if (!rows[0]) throw new Error(`No existe una cuenta activa con ${email}`);
  return rows[0].id;
}

const [command, a, b, c, d] = process.argv.slice(2);

async function orgOf(uid: string, name: string): Promise<string> {
  const { rows } = await pool.query('SELECT o.id FROM organizations o JOIN organization_memberships om ON om.org_id = o.id AND om.user_id = $1 WHERE o.name = $2', [uid, name]);
  if (rows.length !== 1) throw new Error(`La persona no está en una única empresa llamada «${name}»`);
  return rows[0].id;
}

// Agente miembro: una cuenta kind='agent' sin correo ni contraseña, de una empresa, con dueño (auditoría
// 'agent.created' con actor = dueño). Habla por el MCP con su propio token: ve y escribe solo lo que su membresía permite.
async function findAgent(orgId: string, name: string): Promise<string | null> {
  const { rows } = await pool.query(
    "SELECT u.id FROM users u JOIN organization_memberships om ON om.user_id = u.id AND om.org_id = $1 WHERE u.kind = 'agent' AND u.disabled_at IS NULL AND lower(u.name) = lower($2)",
    [orgId, name],
  );
  return rows[0]?.id ?? null;
}
async function ownerOrg(owner: string, company?: string): Promise<string> {
  if (company) return orgOf(owner, company);
  const { rows } = await pool.query('SELECT primary_org_id FROM users WHERE id = $1', [owner]);
  if (!rows[0]?.primary_org_id) throw new Error('El dueño no tiene empresa principal: indica la empresa');
  return rows[0].primary_org_id;
}
try {
  if (command === 'members' && a) {
    const { rows } = await pool.query(
      `SELECT u.email, u.name, o.name AS org, om.role FROM users u
         LEFT JOIN organization_memberships om ON om.user_id = u.id LEFT JOIN organizations o ON o.id = om.org_id
        WHERE u.email ILIKE $1 AND u.disabled_at IS NULL ORDER BY o.name, u.email`,
      [`%@${a}`],
    );
    console.log(JSON.stringify(rows, null, 1));
  } else if (command === 'groups' && a) {
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.kind, w.name AS workspace, w.is_org_home, m.can_manage FROM conversation_memberships m
         JOIN conversations c ON c.id = m.conversation_id AND c.archived_at IS NULL AND c.kind IN ('group','internal')
         JOIN workspaces w ON w.id = c.workspace_id
        WHERE m.user_id = $1 AND m.removed_at IS NULL ORDER BY c.created_at`,
      [await userId(a)],
    );
    console.log(JSON.stringify(rows, null, 1));
  } else if (command === 'create-group' && a && b) {
    const me = await userId(a);
    const members = c ? await Promise.all(c.split(',').filter(Boolean).map((e) => userId(e.trim()))) : [];
    const orgId = d ? await orgOf(me, d) : undefined;
    const r = await createGroup(me, CreateGroupInput.parse({ name: b, target: { kind: 'org', ...(orgId ? { orgId } : {}) }, memberIds: members }));
    console.log(JSON.stringify(r));
  } else if (command === 'create-integration' && a && b && c) {
    const r = await createIntegration(await userId(a), b, CreateIntegrationInput.parse({ name: c, outgoingUrl: d || null }));
    console.log(JSON.stringify(r));
  } else if (command === 'import-events' && a && b) {
    const chunks: Buffer[] = [];
    for await (const ch of process.stdin) chunks.push(ch as Buffer);
    const items = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown[]).map((x) => CreateEventInput.parse(x));
    const r = await importEvents(await userId(a), b, items);
    console.log(JSON.stringify(r.map((e) => ({ id: e.id, title: e.title, startsAt: e.startsAt }))));
  } else if (command === 'purge-integration-issues' && a && b) {
    const ext = b.split(',').map((x) => x.trim()).filter(Boolean);
    const r = await tx(async (cx) => {
      const issues = (await cx.query('SELECT id, conversation_id FROM issues WHERE integration_id = $1 AND external_id = ANY($2)', [a, ext])).rows;
      if (!issues.length) return { issues: 0, messages: 0 };
      const ids = issues.map((i) => i.id as string);
      const conv = issues[0].conversation_id as string;
      await cx.query('SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE', [conv]);
      // Avisos de sistema «Abrió/Cerró el asunto…» de esos asuntos: se borran como un mensaje eliminado.
      const msgs = (await cx.query(
        `UPDATE messages SET body = '', deleted_at = now() WHERE conversation_id = $1 AND kind = 'system' AND deleted_at IS NULL
            AND body LIKE '{%' AND (body::jsonb ->> 'issueId') = ANY($2) RETURNING *`, [conv, ids])).rows;
      for (const m of msgs) await appendEvent(cx, conv, { type: 'message.updated', conversationId: conv, message: toMessageDTO(m) }, m.id);
      const members = (await cx.query('SELECT user_id FROM conversation_memberships WHERE conversation_id = $1 AND removed_at IS NULL', [conv])).rows.map((x) => x.user_id);
      await cx.query('DELETE FROM issues WHERE id = ANY($1)', [ids]);
      for (const id of ids) await enqueueOutbox(cx, 'account.event', { userIds: members, event: { type: 'issue.hidden', issueId: id, conversationId: conv } });
      return { issues: ids.length, messages: msgs.length };
    });
    console.log(JSON.stringify(r));
  } else if (command === 'booking-page' && a && b && c) {
    // Horario de atención por defecto: lunes a viernes, 9:00-12:00 y 14:00-17:00 (hora de Bogotá). Se cambia después en la app.
    const [, , , , mode, minutes, hostList, description, orgName, titleEn, descriptionEn] = process.argv.slice(2);
    const hours: Record<string, [string, string][]> = Object.fromEntries([1, 2, 3, 4, 5].map((d) => [String(d), [['09:00', '12:00'], ['14:00', '17:00']] as [string, string][]]));
    const owner = await userId(a);
    const hostIds = await Promise.all((hostList ?? a).split(',').filter(Boolean).map((e) => userId(e.trim())));
    const existing = (await myPages(owner)).find((p) => p.slug === b);
    const input = { slug: b, title: c, titleEn: titleEn || null, description: description ?? '', descriptionEn: descriptionEn || null, mode: mode as 'collective' | 'round_robin', durationMin: Number(minutes ?? 30), hours, hostIds };
    const orgId = orgName ? await orgOf(owner, orgName) : undefined;
    const r = existing ? await updatePage(owner, existing.id, input) : await createPage(owner, BookingPageInput.parse(input), orgId);
    if (orgId) await pool.query('UPDATE booking_pages SET org_id = $2 WHERE id = $1', [r.id, orgId]);
    console.log(JSON.stringify({ id: r.id, url: r.url, mode: r.mode, hosts: r.hostsStatus.map((h) => ({ email: h.email, calendar: h.calendar })), ready: r.ready }, null, 1));
  } else if (command === 'booking-status') {
    const { rows } = await pool.query('SELECT DISTINCT owner_id FROM booking_pages');
    const out = [];
    for (const r of rows) for (const p of await myPages(r.owner_id)) out.push({ slug: p.slug, url: p.url, mode: p.mode, ready: p.ready, upcoming: p.upcoming, hosts: p.hostsStatus.map((h) => `${h.email}: ${h.calendar}`) });
    console.log(JSON.stringify(out, null, 1));
  } else if (command === 'app-version' && (a === 'mac' || a === 'windows')) {
    if (b) {
      const m = b.match(/^(\d+)\.(\d+)\.(\d+)$/);
      if (!m || Number(m[2]) > 99 || Number(m[3]) > 99) throw new Error('versión como 0.3.0 (menor y parche ≤ 99)');
      const build = Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
      if (c && !/^https:\/\//.test(c)) throw new Error('la url de descarga debe ser https://');
      await pool.query('UPDATE app_releases SET latest_version = $2, latest_build = $3, url = COALESCE($4, url), updated_at = now() WHERE platform = $1', [a, b, build, c ?? null]);
    }
    const { rows } = await pool.query('SELECT * FROM app_releases WHERE platform = $1', [a]);
    console.log(JSON.stringify(rows[0], null, 1));
  } else if (command === 'app-version' && (a === 'ios' || a === 'android')) {
    // Tras publicar una build: las apps con un build menor muestran «Actualización disponible» hasta instalarla.
    if (b && c) {
      const build = Number(c), min = d === undefined || d === '' ? null : Number(d);
      if (!Number.isInteger(build) || build <= 0 || (min !== null && (!Number.isInteger(min) || min < 0 || min > build))) throw new Error('build y minBuild deben ser enteros (minBuild ≤ build)');
      const [notesEs, notesEn] = process.argv.slice(7);
      await pool.query(
        `UPDATE app_releases SET latest_version = $2, latest_build = $3, min_build = COALESCE($4, min_build),
           notes_es = COALESCE($5, notes_es), notes_en = COALESCE($6, notes_en), updated_at = now() WHERE platform = $1`,
        [a, b, build, min, notesEs ?? null, notesEn ?? null],
      );
    }
    const { rows } = await pool.query('SELECT * FROM app_releases WHERE platform = $1', [a]);
    console.log(JSON.stringify(rows[0], null, 1));
  } else if (command === 'create-agent' && a && b && c) {
    const owner = await userId(a);
    const orgId = await ownerOrg(owner, d);
    const title = process.argv[7] || 'Agente';
    let agent = await findAgent(orgId, b);
    const isNew = !agent;
    if (!agent) {
      agent = await tx(async (cx) => {
        const id = (await cx.query("INSERT INTO users (kind, name, primary_org_id) VALUES ('agent', $1, $2) RETURNING id", [b, orgId])).rows[0].id as string;
        await cx.query("INSERT INTO organization_memberships (org_id, user_id, role, title, area) VALUES ($1,$2,'member',$3,'Agentes')", [orgId, id, title]);
        await audit(cx, owner, 'agent.created', { type: 'user', id }, { orgId, name: b });
        return id;
      });
    }
    // Cada grupo lo suma alguien que lo pueda administrar: el dueño, o si no, quien creó el grupo (queda en el aviso del chat).
    const groups: Record<string, unknown> = {};
    for (const conv of c.split(',').map((x) => x.trim()).filter(Boolean)) {
      const creator = (await pool.query('SELECT created_by FROM conversations WHERE id = $1', [conv])).rows[0]?.created_by as string | undefined;
      let r: unknown;
      for (const actor of [owner, creator].filter((x, i, l): x is string => !!x && l.indexOf(x) === i)) {
        try { r = await addMembers(actor, conv, AddMembersInput.parse({ userIds: [agent], history: 'now' })); break; }
        catch (e: any) { r = { error: e?.message ?? String(e) }; }
      }
      groups[conv] = r;
    }
    const token = isNew ? await createToken(agent, `Agente ${b}`) : null;
    console.log(JSON.stringify({ agentId: agent, name: b, orgId, isNew, groups, ...(token ? { mcpToken: token.token, endpoint: 'https://app.chaggu.com/api/mcp' } : {}) }, null, 1));
  } else if (command === 'agent-token' && a && b) {
    const owner = await userId(a);
    const agent = await findAgent(await ownerOrg(owner, c), b);
    if (!agent) throw new Error(`No hay un agente «${b}» en esa empresa`);
    const token = await createToken(agent, `Agente ${b}`);
    console.log(JSON.stringify({ agentId: agent, mcpToken: token.token, endpoint: 'https://app.chaggu.com/api/mcp' }, null, 1));
  } else if (command === 'agents') {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, o.name AS org, om.title, ow.email AS owner,
              (SELECT array_agg(cv.name ORDER BY cv.name) FROM conversation_memberships m JOIN conversations cv ON cv.id = m.conversation_id
                WHERE m.user_id = u.id AND m.removed_at IS NULL AND cv.archived_at IS NULL) AS groups,
              (SELECT max(t.last_used_at) FROM mcp_tokens t WHERE t.user_id = u.id AND t.revoked_at IS NULL) AS last_used_at
         FROM users u JOIN organization_memberships om ON om.user_id = u.id JOIN organizations o ON o.id = om.org_id
         LEFT JOIN audit_events al ON al.target_id = u.id AND al.action = 'agent.created' LEFT JOIN users ow ON ow.id = al.actor_id
        WHERE u.kind = 'agent' AND u.disabled_at IS NULL ORDER BY o.name, u.name`,
    );
    console.log(JSON.stringify(rows, null, 1));
  } else {
    throw new Error('Uso: ops.js members <dominio> | groups <correo> | create-group <correo> "<nombre>" [correos] | create-integration <correo> <conversationId> "<nombre>" [url]');
  }
} catch (e: any) {
  console.error(e?.message ?? 'Error');
  process.exitCode = 1;
} finally { await pool.end(); }
