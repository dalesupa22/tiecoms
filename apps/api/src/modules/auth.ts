import type { AuthResult, DeviceInfo, LoginInput, OrgRole, SignupInput, UserDTO } from '@tiecoms/contracts';
import { config } from '../config.ts';
import { audit, enqueueOutbox, pool, tx, type Db, type Tx } from '../db.ts';
import { ApiError, badRequest, conflict, forbidden, notFound, unauthorized } from '../errors.ts';
import type { MailLang } from '../mail.ts';
import { hashPassword, orgLook, randomToken, sha256, signAccess, verifyPassword } from '../security.ts';
import { claimedBy, emailDomain, isPublicDomain } from './domains.ts';
import { deliverInvitation, prepareInvitationFor } from './invitations.ts';

/** Ventana en la que el refresh anterior sigue sirviendo (dos pestañas refrescando a la vez). */
const ROTATION_GRACE_MS = 30_000;

export async function loadUser(db: Db, userId: string): Promise<UserDTO> {
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.email, u.kind, u.primary_org_id, u.avatar_file_id, om.title, om.area
       FROM users u LEFT JOIN organization_memberships om ON om.user_id = u.id AND om.org_id = u.primary_org_id
      WHERE u.id = $1 AND u.disabled_at IS NULL`,
    [userId],
  );
  const r = rows[0];
  if (!r) throw unauthorized();
  return { id: r.id, name: r.name, email: r.email, kind: r.kind, title: r.title, area: r.area, primaryOrgId: r.primary_org_id, avatarUrl: r.avatar_file_id ? `/api/v1/avatars/${r.avatar_file_id}` : null };
}

export async function createSession(c: Tx, userId: string, device: DeviceInfo) {
  const refreshToken = randomToken(32);
  const { rows } = await c.query(
    `INSERT INTO sessions (user_id, device_id, device_name, platform, contract, refresh_hash, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(days => $7)) RETURNING id`,
    [userId, device.deviceId, device.name, device.platform, device.contract, sha256(refreshToken), config.refreshTtlDays],
  );
  return { sessionId: rows[0].id as string, refreshToken };
}

export async function result(c: Db, userId: string, sessionId: string, refreshToken: string): Promise<AuthResult> {
  const access = await signAccess(userId, sessionId);
  return { accessToken: access.token, accessExpiresAt: access.expiresAt, refreshToken, sessionId, user: await loadUser(c, userId) };
}

export interface DomainProof { provider: 'google' | 'microsoft'; tenant: string }

/**
 * Decide a qué empresa entra una persona nueva: la de su invitación, la que ya
 * verificó su dominio, o una empresa nueva. Con `proof` el dominio del correo lo
 * garantiza Google Workspace o Microsoft Entra; sin él (registro con contraseña)
 * nunca se entra sola a una empresa ajena.
 */
export async function placeNewUser(c: Tx, email: string, opts: { orgInviteToken?: string; orgName?: string; fallbackOrgName: string; proof?: DomainProof | null }) {
  if (opts.orgInviteToken) {
    // Se une a una empresa existente: la invitación es de un solo uso y puede exigir un correo.
    const { rows } = await c.query('SELECT * FROM org_invitations WHERE token_hash = $1 FOR UPDATE', [sha256(opts.orgInviteToken)]);
    const inv = rows[0];
    if (!inv) throw notFound('Invitación');
    if (inv.accepted_at || inv.revoked_at || new Date(inv.expires_at) < new Date()) throw conflict('La invitación ya no es válida');
    if (inv.email && String(inv.email).toLowerCase() !== email) throw forbidden('Esta invitación es para otro correo');
    return { orgId: inv.org_id as string, role: inv.role as OrgRole, inviteId: inv.id as string, via: 'invite' as const };
  }
  const domain = emailDomain(email);
  const corporate = !isPublicDomain(domain);
  if (corporate) {
    const owner = await claimedBy(c, domain);
    if (owner) {
      if (owner.joinPolicy === 'auto' && opts.proof) return { orgId: owner.orgId, role: 'member' as OrgRole, inviteId: null, via: 'domain' as const };
      throw new ApiError(409, 'domain_claimed', `${owner.orgName} ya está en TieComs con el dominio ${domain}. Pide a su administrador que te invite.`, { orgName: owner.orgName, domain });
    }
  }
  const name = (opts.orgName ?? opts.fallbackOrgName).trim().slice(0, 120);
  if (name.length < 2) throw badRequest('Falta el nombre de la empresa');
  const look = orgLook(name);
  const org = await c.query(
    'INSERT INTO organizations (name, mark, color_bg, color_fg, ms_tenant_id, google_hd) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [name, look.mark, look.bg, look.fg, opts.proof?.provider === 'microsoft' ? opts.proof.tenant : null, opts.proof?.provider === 'google' ? opts.proof.tenant : null],
  );
  const orgId: string = org.rows[0].id;
  if (corporate) {
    // Con prueba del proveedor el dominio queda confirmado; si no, pendiente del TXT.
    // SAVEPOINT: si otra empresa lo confirma a la vez, el índice único lo impide sin abortar la transacción.
    await c.query('SAVEPOINT claim_domain');
    try {
      await c.query(
        `INSERT INTO org_domains (org_id, domain, status, token, idp_provider, idp_tenant, verified_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [orgId, domain, opts.proof ? 'idp' : 'pending', randomToken(18), opts.proof?.provider ?? null, opts.proof?.tenant ?? null, opts.proof ? new Date() : null],
      );
      await c.query('RELEASE SAVEPOINT claim_domain');
    } catch (e: any) {
      if (e?.code !== '23505') throw e;
      throw new ApiError(409, 'domain_claimed', `Otra empresa acaba de registrar el dominio ${domain}. Pide a su administrador que te invite.`, { domain });
    }
  }
  return { orgId, role: 'owner' as OrgRole, inviteId: null, via: 'created' as const };
}

/** Crea la persona dentro de la empresa elegida y avisa a los colegas si se unió a una existente. */
export async function insertUser(c: Tx, u: { email: string; name: string; passwordHash: string | null; title?: string | null; emailVerified: boolean },
  place: Awaited<ReturnType<typeof placeNewUser>>): Promise<string> {
  const r = await c.query(
    'INSERT INTO users (email, name, password_hash, primary_org_id, email_verified_at) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [u.email, u.name, u.passwordHash, place.orgId, u.emailVerified ? new Date() : null],
  );
  const userId: string = r.rows[0].id;
  await c.query('INSERT INTO organization_memberships (org_id, user_id, role, title) VALUES ($1,$2,$3,$4)', [place.orgId, userId, place.role, u.title ?? null]);
  if (place.inviteId) await c.query('UPDATE org_invitations SET accepted_by = $2, accepted_at = now() WHERE id = $1', [place.inviteId, userId]);
  if (place.via !== 'created') {
    // Los colegas ven a la persona nueva en su directorio.
    const mates = await c.query('SELECT user_id FROM organization_memberships WHERE org_id = $1', [place.orgId]);
    await enqueueOutbox(c, 'account.event', { userIds: mates.rows.map((m) => m.user_id), event: { type: 'scope.changed', reason: 'org.member_joined' } });
  }
  return userId;
}

export async function signup(input: SignupInput): Promise<AuthResult> {
  const passwordHash = await hashPassword(input.password);
  try {
    return await tx(async (c) => {
      const place = await placeNewUser(c, input.email, { orgInviteToken: input.orgInviteToken, orgName: input.orgName, fallbackOrgName: '' });
      const userId = await insertUser(c, { email: input.email, name: input.name, passwordHash, title: input.title, emailVerified: false }, place);
      const s = await createSession(c, userId, input.device);
      await audit(c, userId, place.inviteId ? 'auth.signup_joined_org' : 'auth.signup', { type: 'organization', id: place.orgId });
      return result(c, userId, s.sessionId, s.refreshToken);
    });
  } catch (e: any) {
    if (e?.code === '23505') throw conflict('Ya existe una cuenta con ese correo');
    throw e;
  }
}

/** Invitar a un colega a mi empresa. Solo dueños y administradores. */
export async function createOrgInvitation(userId: string, orgId: string, input: { email?: string; role: 'member' | 'admin'; expiresInDays: number; lang?: MailLang }) {
  const inv = await tx(async (c) => {
    const { rows } = await c.query('SELECT role FROM organization_memberships WHERE org_id = $1 AND user_id = $2', [orgId, userId]);
    if (!rows[0]) throw notFound('Empresa');
    if (!['owner', 'admin'].includes(rows[0].role)) throw forbidden('Solo quien administra la empresa puede invitar colegas');
    if (input.email) await prepareInvitationFor(c, 'org', orgId, input.email);
    const token = randomToken(24);
    const r = await c.query(
      `INSERT INTO org_invitations (token_hash, org_id, invited_by, email, role, expires_at, lang)
       VALUES ($1,$2,$3,$4,$5, now() + make_interval(days => $6), $7) RETURNING id, expires_at`,
      [sha256(token), orgId, userId, input.email ?? null, input.role, input.expiresInDays, input.lang ?? 'es'],
    );
    await audit(c, userId, 'org_invitation.created', { type: 'organization', id: orgId }, { email: input.email ?? null, role: input.role });
    return { id: r.rows[0].id as string, token, expiresAt: r.rows[0].expires_at as Date };
  });
  const mail = input.email ? await deliverInvitation('org', inv.id, inv.token) : null;
  return { ...inv, emailSent: mail?.status === 'sent', emailStatus: mail?.status ?? null };
}

export async function previewOrgInvitation(token: string) {
  const { rows } = await pool.query(
    `SELECT i.email, i.expires_at, i.accepted_at, i.revoked_at, o.name AS org_name, u.name AS inviter
       FROM org_invitations i JOIN organizations o ON o.id = i.org_id JOIN users u ON u.id = i.invited_by WHERE i.token_hash = $1`,
    [sha256(token)],
  );
  const r = rows[0];
  if (!r) throw notFound('Invitación');
  return {
    orgName: r.org_name, invitedByName: r.inviter, email: r.email, expiresAt: new Date(r.expires_at).toISOString(),
    valid: !r.accepted_at && !r.revoked_at && new Date(r.expires_at) > new Date(),
  };
}

export async function login(input: LoginInput): Promise<AuthResult> {
  const { rows } = await pool.query("SELECT id, password_hash FROM users WHERE email = $1 AND kind = 'human' AND disabled_at IS NULL", [input.email]);
  const ok = await verifyPassword(input.password, rows[0]?.password_hash ?? null);
  if (!ok || !rows[0]) throw unauthorized('Correo o contraseña incorrectos');
  const userId: string = rows[0].id;
  return tx(async (c) => {
    const s = await createSession(c, userId, input.device);
    await audit(c, userId, 'auth.login', { type: 'session', id: s.sessionId }, { platform: input.device.platform });
    return result(c, userId, s.sessionId, s.refreshToken);
  });
}

export async function refresh(refreshToken: string): Promise<AuthResult> {
  const h = sha256(refreshToken);
  return tx(async (c) => {
    const { rows } = await c.query(
      `SELECT id, user_id, refresh_hash, prev_refresh_hash, rotated_at, expires_at, revoked_at FROM sessions
        WHERE refresh_hash = $1 OR prev_refresh_hash = $1 FOR UPDATE`,
      [h],
    );
    const s = rows[0];
    if (!s || s.revoked_at || new Date(s.expires_at) < new Date()) throw unauthorized();
    const isPrevious = Buffer.compare(s.refresh_hash, h) !== 0;
    if (isPrevious) {
      const graceOk = s.rotated_at && Date.now() - new Date(s.rotated_at).getTime() < ROTATION_GRACE_MS;
      if (!graceOk) {
        // Reuso de un refresh ya rotado fuera de la ventana: posible robo. Se revoca la sesión.
        await c.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [s.id]);
        await enqueueOutbox(c, 'session.revoke', { sessionId: s.id });
        await audit(c, s.user_id, 'auth.refresh_reuse', { type: 'session', id: s.id });
        throw unauthorized();
      }
    }
    const next = randomToken(32);
    await c.query(
      `UPDATE sessions SET prev_refresh_hash = $2, refresh_hash = $3, rotated_at = now(), last_seen_at = now(),
              expires_at = now() + make_interval(days => $4) WHERE id = $1`,
      [s.id, isPrevious ? s.prev_refresh_hash : s.refresh_hash, sha256(next), config.refreshTtlDays],
    );
    return result(c, s.user_id, s.id, next);
  });
}

export async function revokeSession(userId: string, sessionId: string) {
  await tx(async (c) => {
    const r = await c.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [sessionId, userId]);
    if (r.rowCount) {
      // Un dispositivo sin sesión no debe seguir recibiendo notificaciones.
      await c.query('DELETE FROM push_subscriptions WHERE session_id = $1', [sessionId]);
      await enqueueOutbox(c, 'session.revoke', { sessionId });
      await audit(c, userId, 'auth.session_revoked', { type: 'session', id: sessionId });
    }
  });
}

export async function listSessions(userId: string) {
  const { rows } = await pool.query(
    `SELECT id, device_name, platform, created_at, last_seen_at FROM sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`,
    [userId],
  );
  return rows.map((r) => ({ id: r.id, deviceName: r.device_name, platform: r.platform, createdAt: r.created_at, lastSeenAt: r.last_seen_at }));
}

/** Comprobación barata usada por sockets: la sesión sigue viva. */
export async function sessionActive(sessionId: string): Promise<boolean> {
  const { rowCount } = await pool.query('SELECT 1 FROM sessions WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()', [sessionId]);
  return (rowCount ?? 0) > 0;
}
