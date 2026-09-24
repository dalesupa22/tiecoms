import { audit, enqueueOutbox, pool, tx } from '../db.ts';
import { badRequest, forbidden, unauthorized } from '../errors.ts';
import { verifyPassword } from '../security.ts';

/**
 * Eliminar la cuenta (lo exigen App Store y Google Play). Los mensajes en
 * espacios compartidos son registro de las empresas y se conservan, pero ya no
 * muestran con una cuenta anonimizada: se borran nombre, correo, contraseña, identidades
 * de Google/Microsoft, WhatsApp vinculado, preferencias y recordatorios, y la
 * persona sale de todas sus empresas, espacios y conversaciones.
 */
export async function deleteAccount(userId: string, input: { confirmEmail: string; password?: string }) {
  const { rows } = await pool.query("SELECT email, password_hash FROM users WHERE id = $1 AND kind = 'human' AND disabled_at IS NULL", [userId]);
  const u = rows[0];
  if (!u) throw unauthorized();
  if (String(u.email).toLowerCase() !== input.confirmEmail) throw badRequest('Escribe tu correo para confirmar');
  // Con contraseña se vuelve a pedir; las cuentas solo de Google/Microsoft confirman con el correo.
  if (u.password_hash && !(await verifyPassword(input.password ?? '', u.password_hash))) throw forbidden('Contraseña incorrecta');

  const waIds = await tx(async (c) => {
    // Empresas donde era la única persona dueña: la administración pasa a quien lleve más tiempo.
    const owned = await c.query(
      `SELECT om.org_id FROM organization_memberships om WHERE om.user_id = $1 AND om.role = 'owner'
          AND NOT EXISTS (SELECT 1 FROM organization_memberships o WHERE o.org_id = om.org_id AND o.user_id <> $1 AND o.role = 'owner')`,
      [userId],
    );
    for (const { org_id } of owned.rows) {
      const heir = await c.query(
        `SELECT user_id FROM organization_memberships WHERE org_id = $1 AND user_id <> $2
          ORDER BY (role = 'admin') DESC, joined_at LIMIT 1`,
        [org_id, userId],
      );
      if (heir.rows[0]) {
        await c.query("UPDATE organization_memberships SET role = 'owner' WHERE org_id = $1 AND user_id = $2", [org_id, heir.rows[0].user_id]);
        await audit(c, userId, 'org.owner_transferred', { type: 'organization', id: org_id }, { to: heir.rows[0].user_id, reason: 'account_deleted' });
      }
    }

    // A quién avisar para que recargue su alcance (colegas y participantes).
    const peers = await c.query(
      `SELECT DISTINCT o.user_id FROM conversation_memberships mine
         JOIN conversation_memberships o ON o.conversation_id = mine.conversation_id AND o.removed_at IS NULL
        WHERE mine.user_id = $1 AND mine.removed_at IS NULL AND o.user_id <> $1
       UNION SELECT o.user_id FROM organization_memberships mine JOIN organization_memberships o ON o.org_id = mine.org_id
        WHERE mine.user_id = $1 AND o.user_id <> $1`,
      [userId],
    );
    const convs = await c.query('UPDATE conversation_memberships SET removed_at = now() WHERE user_id = $1 AND removed_at IS NULL RETURNING conversation_id', [userId]);
    for (const r of convs.rows) await enqueueOutbox(c, 'rooms.leave', { conversationId: r.conversation_id, userIds: [userId] });
    await c.query('UPDATE workspace_memberships SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
    await c.query('DELETE FROM organization_memberships WHERE user_id = $1', [userId]);
    await c.query('UPDATE invitations SET revoked_at = now() WHERE invited_by = $1 AND accepted_at IS NULL AND revoked_at IS NULL', [userId]);
    await c.query('UPDATE org_invitations SET revoked_at = now() WHERE invited_by = $1 AND accepted_at IS NULL AND revoked_at IS NULL', [userId]);
    await c.query('DELETE FROM user_identities WHERE user_id = $1', [userId]);
    await c.query('DELETE FROM sso_codes WHERE user_id = $1', [userId]);
    await c.query('DELETE FROM reminders WHERE user_id = $1', [userId]);
    await c.query('DELETE FROM conversation_prefs WHERE user_id = $1', [userId]);
    await c.query('DELETE FROM workspace_prefs WHERE user_id = $1', [userId]);
    await c.query('DELETE FROM read_cursors WHERE user_id = $1', [userId]);
    await c.query('DELETE FROM user_blocks WHERE blocker_id = $1 OR blocked_id = $1', [userId]);
    await c.query('DELETE FROM push_subscriptions WHERE session_id IN (SELECT id FROM sessions WHERE user_id = $1)', [userId]);
    // Los archivos personales y las fotos dejan de servirse inmediatamente. El worker
    // borra S3 con reintentos durables; los archivos compartidos del espacio permanecen.
    const personalFiles = await c.query(
      `UPDATE files SET deleted_at = COALESCE(deleted_at, now()), name = NULL, updated_at = now()
        WHERE owner_id = $1 AND (purpose = 'avatar' OR (purpose = 'document' AND workspace_id IS NULL))
        RETURNING id, s3_key`, [userId],
    );
    for (const file of personalFiles.rows) {
      await c.query(
        `INSERT INTO jobs (kind, payload, dedupe_key) VALUES ('account.delete_file', $1, $2)
          ON CONFLICT (dedupe_key) DO NOTHING`,
        [JSON.stringify({ fileId: file.id, key: file.s3_key }), `delete-file:${file.id}`],
      );
    }
    await c.query('DELETE FROM folders WHERE owner_id = $1 AND workspace_id IS NULL', [userId]);
    const wa = await c.query('UPDATE wa_accounts SET removed_at = now(), updated_at = now() WHERE user_id = $1 AND removed_at IS NULL RETURNING id', [userId]);

    const sessions = await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id', [userId]);
    for (const s of sessions.rows) await enqueueOutbox(c, 'session.revoke', { sessionId: s.id });

    await c.query(
      `UPDATE users SET name = 'Cuenta eliminada', email = 'deleted+' || id || '@deleted.tiecoms.invalid',
              password_hash = NULL, avatar_file_id = NULL, primary_org_id = NULL, email_verified_at = NULL, disabled_at = now() WHERE id = $1`,
      [userId],
    );
    if (peers.rows.length) {
      await enqueueOutbox(c, 'account.event', { userIds: peers.rows.map((r) => r.user_id), event: { type: 'scope.changed', reason: 'account.deleted' } });
    }
    await audit(c, userId, 'account.deleted', { type: 'user', id: userId }, { conversations: convs.rowCount, whatsapp: wa.rowCount });
    return wa.rows.map((r) => r.id as string);
  });
  // El puente de WhatsApp cierra esas sesiones y borra sus credenciales.
  for (const id of waIds) await pool.query("SELECT pg_notify('tiecoms_wa', $1)", [id]);
  return { ok: true };
}
