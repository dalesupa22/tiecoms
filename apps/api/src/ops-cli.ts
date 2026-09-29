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
 *   node ops.js app-version <ios|android> <versión> <build> [minBuild] ["notas es"] ["notas en"]   última versión publicada (docs/ACTUALIZAR.md)
 *   node ops.js app-version <ios|android>                  muestra la registrada
 *       imprime el JSON con el token (y el secreto de salida) UNA vez: redirígelo a un archivo protegido.
 */
import { CreateGroupInput, CreateIntegrationInput } from '@tiecoms/contracts';
import { createGroup } from './modules/groups.ts';
import { createIntegration } from './modules/integrations.ts';
import { importEvents } from './modules/calendar.ts';
import { appendEvent, toMessageDTO } from './modules/messages.ts';
import { CreateEventInput } from '@tiecoms/contracts';
import { enqueueOutbox, pool, tx } from './db.ts';

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
  } else {
    throw new Error('Uso: ops.js members <dominio> | groups <correo> | create-group <correo> "<nombre>" [correos] | create-integration <correo> <conversationId> "<nombre>" [url]');
  }
} catch (e: any) {
  console.error(e?.message ?? 'Error');
  process.exitCode = 1;
} finally { await pool.end(); }
