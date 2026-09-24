import type { AuthResult, DeviceInfo, LoginInput, SignupInput, UserDTO } from '@tiecoms/contracts';
import { config } from '../config.ts';
import { audit, enqueueOutbox, pool, tx, type Db, type Tx } from '../db.ts';
import { conflict, unauthorized } from '../errors.ts';
import { hashPassword, orgLook, randomToken, sha256, signAccess, verifyPassword } from '../security.ts';

/** Ventana en la que el refresh anterior sigue sirviendo (dos pestañas refrescando a la vez). */
const ROTATION_GRACE_MS = 30_000;

export async function loadUser(db: Db, userId: string): Promise<UserDTO> {
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.email, u.kind, u.primary_org_id, om.title, om.area
       FROM users u LEFT JOIN organization_memberships om ON om.user_id = u.id AND om.org_id = u.primary_org_id
      WHERE u.id = $1 AND u.disabled_at IS NULL`,
    [userId],
  );
  const r = rows[0];
  if (!r) throw unauthorized();
  return { id: r.id, name: r.name, email: r.email, kind: r.kind, title: r.title, area: r.area, primaryOrgId: r.primary_org_id };
}

async function createSession(c: Tx, userId: string, device: DeviceInfo) {
  const refreshToken = randomToken(32);
  const { rows } = await c.query(
    `INSERT INTO sessions (user_id, device_id, device_name, platform, contract, refresh_hash, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(days => $7)) RETURNING id`,
    [userId, device.deviceId, device.name, device.platform, device.contract, sha256(refreshToken), config.refreshTtlDays],
  );
  return { sessionId: rows[0].id as string, refreshToken };
}

async function result(c: Db, userId: string, sessionId: string, refreshToken: string): Promise<AuthResult> {
  const access = await signAccess(userId, sessionId);
  return { accessToken: access.token, accessExpiresAt: access.expiresAt, refreshToken, sessionId, user: await loadUser(c, userId) };
}

export async function signup(input: SignupInput): Promise<AuthResult> {
  const passwordHash = await hashPassword(input.password);
  try {
    return await tx(async (c) => {
      const look = orgLook(input.orgName);
      const org = await c.query(
        'INSERT INTO organizations (name, mark, color_bg, color_fg) VALUES ($1,$2,$3,$4) RETURNING id',
        [input.orgName, look.mark, look.bg, look.fg],
      );
      const orgId: string = org.rows[0].id;
      const u = await c.query(
        'INSERT INTO users (email, name, password_hash, primary_org_id) VALUES ($1,$2,$3,$4) RETURNING id',
        [input.email, input.name, passwordHash, orgId],
      );
      const userId: string = u.rows[0].id;
      await c.query(
        "INSERT INTO organization_memberships (org_id, user_id, role, title) VALUES ($1,$2,'owner',$3)",
        [orgId, userId, input.title ?? null],
      );
      const s = await createSession(c, userId, input.device);
      await audit(c, userId, 'auth.signup', { type: 'organization', id: orgId });
      return result(c, userId, s.sessionId, s.refreshToken);
    });
  } catch (e: any) {
    if (e?.code === '23505') throw conflict('Ya existe una cuenta con ese correo');
    throw e;
  }
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
