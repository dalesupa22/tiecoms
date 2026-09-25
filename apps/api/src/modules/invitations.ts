/**
 * Entrega por correo de las invitaciones (a la empresa y a espacios) y su gestión:
 * pendientes, reenviar y revocar. Crear la invitación vive en auth.ts (empresa) y
 * workspaces.ts (espacio); aquí se envía el correo y se lleva su estado.
 */
import type { PendingInvitationDTO } from '@tiecoms/contracts';
import { workspaceAccess } from '../access.ts';
import { config } from '../config.ts';
import { audit, pool, tx, type Tx } from '../db.ts';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { invitationMail, trySendMail, type MailResult } from '../mail.ts';
import { randomToken, sha256 } from '../security.ts';

export type InvitationKind = 'org' | 'workspace';

const TABLE = { org: 'org_invitations', workspace: 'invitations' } as const;
const SCOPE = { org: 'org_id', workspace: 'workspace_id' } as const;
/** Vigencia al reenviar (la misma que al crear por defecto). */
const RESEND_DAYS = { org: 14, workspace: 7 } as const;
/** Entre dos envíos a la misma persona. */
const RESEND_COOLDOWN_S = Number(process.env.INVITE_RESEND_COOLDOWN_S ?? 60);

export const invitationUrl = (kind: InvitationKind, token: string) => kind === 'org'
  ? `${config.publicOrigin}/signup?org=${encodeURIComponent(token)}`
  : `${config.publicOrigin}/invite/${encodeURIComponent(token)}`;

/** Envía (o reenvía) el correo de una invitación con su enlace vigente y guarda el resultado. */
export async function deliverInvitation(kind: InvitationKind, invitationId: string, token: string): Promise<MailResult> {
  const target = kind === 'org'
    ? 'JOIN organizations t ON t.id = i.org_id'
    : 'JOIN workspaces t ON t.id = i.workspace_id';
  const { rows } = await pool.query(
    `SELECT i.email, i.lang, i.expires_at, u.name AS inviter_name, u.email AS inviter_email, t.name AS target_name
       FROM ${TABLE[kind]} i JOIN users u ON u.id = i.invited_by ${target} WHERE i.id = $1`,
    [invitationId],
  );
  const r = rows[0];
  if (!r?.email) return { status: 'skipped', error: 'no_email' };
  const result = await trySendMail(invitationMail({
    lang: r.lang, to: r.email, inviterName: r.inviter_name, inviterEmail: r.inviter_email, targetName: r.target_name,
    kind, url: invitationUrl(kind, token), expiresAt: new Date(r.expires_at),
  }));
  await pool.query(
    `UPDATE ${TABLE[kind]} SET email_status = $2, email_error = $3,
            email_sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE email_sent_at END,
            send_count = send_count + CASE WHEN $2 = 'sent' THEN 1 ELSE 0 END
      WHERE id = $1`,
    [invitationId, result.status, result.error ?? null],
  );
  return result;
}

/**
 * Antes de crear una invitación con correo: la persona no debe estar ya dentro, y
 * las invitaciones anteriores a ese correo que sigan pendientes se revocan (solo
 * vale el último enlace).
 */
export async function prepareInvitationFor(c: Tx, kind: InvitationKind, scopeId: string, email: string) {
  const member = kind === 'org'
    ? await c.query(
      `SELECT 1 FROM users u JOIN organization_memberships om ON om.user_id = u.id AND om.org_id = $1 WHERE u.email = $2`,
      [scopeId, email])
    : await c.query(
      `SELECT 1 FROM users u JOIN workspace_memberships wm ON wm.user_id = u.id AND wm.workspace_id = $1
        WHERE u.email = $2 AND wm.revoked_at IS NULL AND (wm.expires_at IS NULL OR wm.expires_at > now())`,
      [scopeId, email]);
  if (member.rows.length) {
    throw new ApiError(409, 'already_member', kind === 'org' ? `${email} ya es parte de tu empresa` : `${email} ya está en este espacio`);
  }
  await c.query(
    `UPDATE ${TABLE[kind]} SET revoked_at = now()
      WHERE ${SCOPE[kind]} = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [scopeId, email],
  );
}

/** Quién puede ver y gestionar las invitaciones de una empresa o un espacio. */
async function access(c: Tx | typeof pool, kind: InvitationKind, userId: string, scopeId: string) {
  if (kind === 'org') {
    const { rows } = await c.query('SELECT role FROM organization_memberships WHERE org_id = $1 AND user_id = $2', [scopeId, userId]);
    if (!rows[0]) throw notFound('Empresa');
    if (!['owner', 'admin'].includes(rows[0].role)) throw forbidden('Solo quien administra la empresa gestiona sus invitaciones');
    return { admin: true };
  }
  const a = await workspaceAccess(c, userId, scopeId, 'nonguest');
  return { admin: ['lead', 'admin'].includes(a.role) };
}

export async function listPendingInvitations(kind: InvitationKind, userId: string, scopeId: string): Promise<PendingInvitationDTO[]> {
  const { admin } = await access(pool, kind, userId, scopeId);
  const { rows } = await pool.query(
    `SELECT i.id, i.email, i.role, i.invited_by, u.name AS inviter_name, i.created_at, i.expires_at,
            i.email_status, i.email_error, i.email_sent_at, i.send_count
       FROM ${TABLE[kind]} i JOIN users u ON u.id = i.invited_by
      WHERE i.${SCOPE[kind]} = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.email IS NOT NULL
        AND i.expires_at > now() - interval '30 days'
      ORDER BY i.created_at DESC LIMIT 200`,
    [scopeId],
  );
  return rows.map((r) => ({
    id: r.id, email: r.email, role: r.role, invitedById: r.invited_by, invitedByName: r.inviter_name,
    createdAt: new Date(r.created_at).toISOString(), expiresAt: new Date(r.expires_at).toISOString(),
    expired: new Date(r.expires_at) < new Date(),
    emailStatus: r.email_status, emailSentAt: r.email_sent_at ? new Date(r.email_sent_at).toISOString() : null,
    sendCount: r.send_count, canManage: admin || r.invited_by === userId,
  }));
}

async function lockManageable(c: Tx, kind: InvitationKind, userId: string, scopeId: string, invitationId: string) {
  const { admin } = await access(c, kind, userId, scopeId);
  const { rows } = await c.query(`SELECT * FROM ${TABLE[kind]} WHERE id = $1 AND ${SCOPE[kind]} = $2 FOR UPDATE`, [invitationId, scopeId]);
  const inv = rows[0];
  if (!inv) throw notFound('Invitación');
  if (!admin && inv.invited_by !== userId) throw forbidden('Solo quien envió la invitación o quien administra puede cambiarla');
  if (inv.accepted_at) throw conflict('Esa invitación ya fue aceptada');
  if (inv.revoked_at) throw conflict('Esa invitación fue revocada');
  return inv;
}

/**
 * Reenvía el correo con un enlace nuevo (el anterior deja de servir) y renueva la
 * vigencia, también si ya había vencido.
 */
export async function resendInvitation(kind: InvitationKind, userId: string, scopeId: string, invitationId: string) {
  const token = randomToken(24);
  await tx(async (c) => {
    const inv = await lockManageable(c, kind, userId, scopeId, invitationId);
    if (!inv.email) throw badRequest('Esta invitación no tiene correo');
    if (inv.email_sent_at && Date.now() - new Date(inv.email_sent_at).getTime() < RESEND_COOLDOWN_S * 1000) {
      throw new ApiError(429, 'resend_too_soon', 'Acabamos de enviarla; espera un minuto antes de reenviar');
    }
    await c.query(
      `UPDATE ${TABLE[kind]} SET token_hash = $2, expires_at = GREATEST(expires_at, now() + make_interval(days => $3)) WHERE id = $1`,
      [invitationId, sha256(token), RESEND_DAYS[kind]],
    );
    await audit(c, userId, `${kind === 'org' ? 'org_invitation' : 'invitation'}.resent`,
      kind === 'org' ? { type: 'organization', id: scopeId } : { type: 'invitation', id: invitationId, workspaceId: scopeId }, { email: inv.email });
  });
  const mail = await deliverInvitation(kind, invitationId, token);
  return { token, emailSent: mail.status === 'sent', emailStatus: mail.status };
}

export async function revokeInvitation(kind: InvitationKind, userId: string, scopeId: string, invitationId: string) {
  await tx(async (c) => {
    const inv = await lockManageable(c, kind, userId, scopeId, invitationId);
    await c.query(`UPDATE ${TABLE[kind]} SET revoked_at = now() WHERE id = $1`, [invitationId]);
    await audit(c, userId, `${kind === 'org' ? 'org_invitation' : 'invitation'}.revoked`,
      kind === 'org' ? { type: 'organization', id: scopeId } : { type: 'invitation', id: invitationId, workspaceId: scopeId }, { email: inv.email });
  });
  return { ok: true };
}
