/**
 * Operaciones reservadas a administradores con acceso SSH (sin ruta pública). Usan las mismas funciones del API,
 * a nombre de la persona indicada con --as, y dejan auditoría como cualquier acción suya.
 *
 *   node ops.js members <dominio>                         personas y empresas con ese dominio de correo (solo lectura)
 *   node ops.js groups <correo>                           grupos donde está esa persona (solo lectura)
 *   node ops.js create-group <correo> "<nombre>" [correos,de,miembros]   grupo de «Tu organización»
 *   node ops.js create-integration <correo> <conversationId> "<nombre>" [urlDeSalida]
 *       imprime el JSON con el token (y el secreto de salida) UNA vez: redirígelo a un archivo protegido.
 */
import { CreateGroupInput, CreateIntegrationInput } from '@tiecoms/contracts';
import { pool } from './db.ts';
import { createGroup } from './modules/groups.ts';
import { createIntegration } from './modules/integrations.ts';

async function userId(email: string): Promise<string> {
  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1 AND disabled_at IS NULL', [email]);
  if (!rows[0]) throw new Error(`No existe una cuenta activa con ${email}`);
  return rows[0].id;
}

const [command, a, b, c, d] = process.argv.slice(2);
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
    const members = c ? await Promise.all(c.split(',').map((e) => userId(e.trim()))) : [];
    const r = await createGroup(me, CreateGroupInput.parse({ name: b, target: { kind: 'org' }, memberIds: members }));
    console.log(JSON.stringify(r));
  } else if (command === 'create-integration' && a && b && c) {
    const r = await createIntegration(await userId(a), b, CreateIntegrationInput.parse({ name: c, outgoingUrl: d || null }));
    console.log(JSON.stringify(r));
  } else {
    throw new Error('Uso: ops.js members <dominio> | groups <correo> | create-group <correo> "<nombre>" [correos] | create-integration <correo> <conversationId> "<nombre>" [url]');
  }
} catch (e: any) {
  console.error(e?.message ?? 'Error');
  process.exitCode = 1;
} finally { await pool.end(); }
