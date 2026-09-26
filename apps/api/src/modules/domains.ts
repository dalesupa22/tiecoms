import { resolveTxt } from 'node:dns/promises';
import type { OrgDomainDTO } from '@tiecoms/contracts';
import { audit, pool, tx, type Db } from '../db.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { randomToken } from '../security.ts';

/** Correos personales: nadie puede reclamar estos dominios como empresa. */
const PUBLIC_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'outlook.es', 'hotmail.com', 'hotmail.es', 'live.com', 'live.com.mx', 'msn.com',
  'yahoo.com', 'yahoo.es', 'yahoo.com.mx', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com',
  'pm.me', 'gmx.com', 'gmx.net', 'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'qq.com', '163.com', 'tutanota.com', 'hey.com',
  'fastmail.com', 'yopmail.com', 'mailinator.com', 'example.com',
]);

export const TXT_PREFIX = 'tiecoms-verification=';

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

export function isPublicDomain(domain: string): boolean {
  return PUBLIC_DOMAINS.has(domain.toLowerCase());
}

export function normalizeDomain(input: string): string {
  const d = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').replace(/\.$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) || d.length > 253) throw badRequest('Dominio inválido');
  return d;
}

/** Empresa que ya controla el dominio (confirmado por Google/Microsoft o por DNS). */
export async function claimedBy(db: Db, domain: string): Promise<{ orgId: string; orgName: string; joinPolicy: string; status: string } | null> {
  const { rows } = await db.query(
    `SELECT d.org_id, d.status, o.name, o.join_policy FROM org_domains d JOIN organizations o ON o.id = d.org_id
      WHERE d.domain = $1 AND d.status IN ('idp','dns')`,
    [domain],
  );
  const r = rows[0];
  return r ? { orgId: r.org_id, orgName: r.name, joinPolicy: r.join_policy, status: r.status } : null;
}

async function requireOrgAdmin(db: Db, userId: string, orgId: string) {
  const { rows } = await db.query('SELECT role FROM organization_memberships WHERE org_id = $1 AND user_id = $2', [orgId, userId]);
  if (!rows[0]) throw notFound('Empresa');
  if (!['owner', 'admin'].includes(rows[0].role)) throw forbidden('Solo quien administra la empresa puede gestionar sus dominios');
}

function toDTO(r: any): OrgDomainDTO {
  return {
    domain: r.domain, status: r.status, txtName: r.domain, txtValue: TXT_PREFIX + r.token,
    verifiedAt: r.verified_at ? new Date(r.verified_at).toISOString() : null,
    lastCheckedAt: r.last_checked_at ? new Date(r.last_checked_at).toISOString() : null,
  };
}

export async function listDomains(userId: string, orgId: string): Promise<OrgDomainDTO[]> {
  await requireOrgAdmin(pool, userId, orgId);
  const { rows } = await pool.query('SELECT * FROM org_domains WHERE org_id = $1 ORDER BY created_at', [orgId]);
  return rows.map(toDTO);
}

/** Reclama un dominio: queda pendiente hasta que aparezca el TXT. */
export async function addDomain(userId: string, orgId: string, input: string): Promise<OrgDomainDTO> {
  const domain = normalizeDomain(input);
  if (isPublicDomain(domain)) throw badRequest('Ese es un dominio de correo público; no se puede reclamar como empresa');
  return tx(async (c) => {
    await requireOrgAdmin(c, userId, orgId);
    const owner = await claimedBy(c, domain);
    if (owner && owner.orgId !== orgId) throw conflict(`El dominio ${domain} ya pertenece a otra empresa en TieComs`);
    const { rows } = await c.query(
      `INSERT INTO org_domains (org_id, domain, token, created_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (org_id, domain) DO UPDATE SET domain = EXCLUDED.domain RETURNING *`,
      [orgId, domain, randomToken(18), userId],
    );
    await audit(c, userId, 'org_domain.added', { type: 'organization', id: orgId }, { domain });
    return toDTO(rows[0]);
  });
}

/** Busca el registro TXT y, si está, marca el dominio como verificado por DNS. */
export async function verifyDomain(userId: string, orgId: string, input: string, lookup = resolveTxt): Promise<OrgDomainDTO> {
  const domain = normalizeDomain(input);
  await requireOrgAdmin(pool, userId, orgId);
  const { rows } = await pool.query('SELECT * FROM org_domains WHERE org_id = $1 AND domain = $2', [orgId, domain]);
  const row = rows[0];
  if (!row) throw notFound('Dominio');
  if (row.status === 'dns') return toDTO(row);
  let found = false;
  try {
    const records = await lookup(domain);
    found = records.some((parts) => parts.join('').trim() === TXT_PREFIX + row.token);
  } catch { /* NXDOMAIN o sin TXT: sigue pendiente */ }
  return tx(async (c) => {
    if (!found) {
      const r = await c.query('UPDATE org_domains SET last_checked_at = now() WHERE org_id = $1 AND domain = $2 RETURNING *', [orgId, domain]);
      return toDTO(r.rows[0]);
    }
    // El DNS manda: si otra empresa lo tenía solo por proveedor de identidad, lo pierde.
    await c.query("UPDATE org_domains SET status = 'pending', verified_at = NULL WHERE domain = $1 AND org_id <> $2 AND status IN ('idp','dns')", [domain, orgId]);
    const r = await c.query(
      "UPDATE org_domains SET status = 'dns', verified_at = now(), last_checked_at = now() WHERE org_id = $1 AND domain = $2 RETURNING *",
      [orgId, domain],
    );
    await audit(c, userId, 'org_domain.verified', { type: 'organization', id: orgId }, { domain, method: 'dns' });
    return toDTO(r.rows[0]);
  });
}

/** Nivel de verificación visible para otras empresas. */
export async function orgVerification(db: Db, orgIds: string[]): Promise<Map<string, { level: 'none' | 'idp' | 'dns'; domain: string | null }>> {
  const out = new Map<string, { level: 'none' | 'idp' | 'dns'; domain: string | null }>();
  if (!orgIds.length) return out;
  const { rows } = await db.query(
    `SELECT DISTINCT ON (org_id) org_id, domain, status FROM org_domains
      WHERE org_id = ANY($1) AND status IN ('idp','dns') ORDER BY org_id, (status = 'dns') DESC, verified_at`,
    [orgIds],
  );
  for (const r of rows) out.set(r.org_id, { level: r.status, domain: r.domain });
  return out;
}

/**
 * Entrada automática por dominio: con 'auto', quien inicia sesión con Google Workspace o Microsoft Entra de un
 * dominio verificado de la empresa queda en ella sin invitación. Solo owner/admin, y solo con dominio verificado.
 */
export async function setJoinPolicy(userId: string, orgId: string, joinPolicy: 'invite' | 'auto') {
  const role = await pool.query('SELECT role FROM organization_memberships WHERE org_id = $1 AND user_id = $2', [orgId, userId]);
  if (!role.rows[0]) throw notFound('Empresa');
  if (!['owner', 'admin'].includes(role.rows[0].role)) throw forbidden('Solo quien administra la empresa cambia esto');
  if (joinPolicy === 'auto') {
    const v = await pool.query("SELECT 1 FROM org_domains WHERE org_id = $1 AND status IN ('idp','dns')", [orgId]);
    if (!v.rowCount) throw badRequest('Primero verifica el dominio de la empresa');
  }
  await tx(async (c) => {
    await c.query('UPDATE organizations SET join_policy = $2 WHERE id = $1', [orgId, joinPolicy]);
    await audit(c, userId, 'org.join_policy', { type: 'organization', id: orgId }, { joinPolicy });
  });
  return { joinPolicy };
}
