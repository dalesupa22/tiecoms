/**
 * Inicio de sesión con Google / Microsoft y dominios de empresa.
 * Las reglas de identidad corren siempre; el flujo completo necesita una base de
 * pruebas (DATABASE_URL de tiecoms_test) y un proveedor falso con llaves locales.
 *   npx vitest run test/sso.test.ts   (con --env-file o variables exportadas)
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgres://nadie:nada@127.0.0.1:1/ninguna';
process.env.JWT_SECRET ??= 'x'.repeat(40);
process.env.GOOGLE_CLIENT_ID ??= 'google-test-client';
process.env.GOOGLE_CLIENT_SECRET ??= 'google-test-secret';
process.env.MICROSOFT_CLIENT_ID ??= 'ms-test-client';
process.env.MICROSOFT_CLIENT_SECRET ??= 'ms-test-secret';

const sso = await import('../src/modules/sso.ts');
const domains = await import('../src/modules/domains.ts');
const { pool } = await import('../src/db.ts');

const MS_TID = '11111111-2222-3333-4444-555555555555';

describe('reglas de identidad', () => {
  const g = sso.providers.google;
  const ms = sso.providers.microsoft;

  it('Google Workspace prueba el dominio; Gmail no', () => {
    const ws = g.identity({ iss: 'https://accounts.google.com', sub: '1', email: 'Ana@Acme.co', email_verified: true, hd: 'acme.co', name: 'Ana' });
    expect(ws).toMatchObject({ email: 'ana@acme.co', emailVerified: true, domainProof: { provider: 'google', tenant: 'acme.co' } });
    const gmail = g.identity({ iss: 'https://accounts.google.com', sub: '2', email: 'ana@gmail.com', email_verified: true });
    expect(gmail.domainProof).toBeNull();
    const unverified = g.identity({ iss: 'accounts.google.com', sub: '3', email: 'x@acme.co', email_verified: false, hd: 'acme.co' });
    expect(unverified).toMatchObject({ emailVerified: false, domainProof: null });
    expect(() => g.identity({ iss: 'https://evil.example', sub: '4', email: 'a@b.co' })).toThrow();
  });

  it('Microsoft: emisor del propio tenant, sin cuentas personales, correo solo con xms_edov', () => {
    const base = { iss: `https://login.microsoftonline.com/${MS_TID}/v2.0`, tid: MS_TID, oid: 'o1', name: 'Luis' };
    const ok = ms.identity({ ...base, email: 'luis@nexo.co', xms_edov: true });
    expect(ok).toMatchObject({ subject: `${MS_TID}:o1`, emailVerified: true, domainProof: { provider: 'microsoft', tenant: MS_TID } });
    // nOAuth: el correo sin xms_edov no sirve para vincular ni reclamar.
    expect(ms.identity({ ...base, email: 'ceo@banco.com' })).toMatchObject({ emailVerified: false, domainProof: null });
    expect(ms.identity({ ...base, preferred_username: 'luis@nexo.co' }).emailVerified).toBe(false);
    expect(() => ms.identity({ ...base, iss: 'https://login.microsoftonline.com/otro/v2.0' })).toThrow();
    const consumer = '9188040d-6c67-4c5b-b112-36a304b66dad';
    expect(() => ms.identity({ ...base, tid: consumer, iss: `https://login.microsoftonline.com/${consumer}/v2.0`, email: 'a@outlook.com' })).toThrow(/personales/);
  });

  it('el canje acepta el cuerpo de las apps iOS/Android (code_verifier)', async () => {
    const { SsoExchangeInput } = await import('@tiecoms/contracts');
    const v = 'a'.repeat(64);
    const device = { deviceId: 'dispositivo-1', name: 'iPhone', platform: 'ios', contract: '2026-09-23' };
    expect(SsoExchangeInput.parse({ code: 'c'.repeat(43), code_verifier: v, device }).codeVerifier).toBe(v);
    expect(SsoExchangeInput.parse({ code: 'c'.repeat(43), codeVerifier: v, device }).codeVerifier).toBe(v);
    expect(() => SsoExchangeInput.parse({ code: 'c'.repeat(43), code_verifier: 'corto', device })).toThrow();
  });

  it('dominios', () => {
    expect(domains.normalizeDomain(' https://www.Acme.co/contacto ')).toBe('acme.co');
    expect(() => domains.normalizeDomain('no es dominio')).toThrow();
    expect(domains.isPublicDomain('gmail.com')).toBe(true);
    expect(domains.isPublicDomain('acme.co')).toBe(false);
  });
});

// ---------- Flujo completo contra la base de pruebas ----------
const dbUp = await pool.query('SELECT 1').then(() => true, () => false);
const describeDb = dbUp && /tiecoms_test/.test(process.env.DATABASE_URL!) ? describe : describe.skip;

describeDb('flujo SSO con la base de pruebas', () => {
  const run = randomUUID().slice(0, 8);
  const issued = new Map<string, Record<string, unknown>>(); // código del proveedor → claims
  let key: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    key = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' };
    for (const p of [sso.providers.google, sso.providers.microsoft]) {
      p.jwks = createLocalJWKSet({ keys: [jwk] });
      p.exchange = async (code) => {
        const claims = issued.get(code);
        if (!claims) throw new Error('código desconocido');
        return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuedAt().setExpirationTime('5m').sign(key);
      };
    }
  });

  const pkce = () => {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
  };

  /** Recorre start → proveedor → callback y devuelve lo que recibe el cliente. */
  async function roundTrip(provider: 'google' | 'microsoft', claims: Record<string, unknown>, extra: Record<string, string> = {}, platform = 'ios') {
    const { verifier, challenge } = pkce();
    const { url, state } = await sso.start(provider, { platform, code_challenge: challenge, code_challenge_method: 'S256', ...extra });
    const authorize = new URL(url);
    const idpCode = randomUUID();
    const aud = provider === 'google' ? process.env.GOOGLE_CLIENT_ID : process.env.MICROSOFT_CLIENT_ID;
    issued.set(idpCode, { ...claims, aud, nonce: authorize.searchParams.get('nonce') });
    const target = new URL(await sso.callback(provider, { code: idpCode, state }, state));
    return { target, verifier, platform };
  }

  const device = (platform: string) => ({ deviceId: randomUUID(), name: 'vitest', platform: platform as any, contract: '2026-09-23' });
  const google = (email: string, hd?: string) => ({ iss: 'https://accounts.google.com', sub: `g-${randomUUID()}`, email, email_verified: true, ...(hd ? { hd } : {}), name: 'Prueba SSO' });

  it('crea la cuenta y la empresa con dominio confirmado por Google Workspace', async () => {
    const domain = `acme-${run}.co`;
    const { target, verifier } = await roundTrip('google', google(`ana@${domain}`, domain), { org_name: `Acme ${run}` });
    expect(target.protocol).toBe('tiecoms:');
    const code = target.searchParams.get('code')!;
    const auth = await sso.exchange({ code, codeVerifier: verifier, device: device('ios') });
    expect(auth.user.email).toBe(`ana@${domain}`);
    expect(auth.refreshToken).toBeTruthy();
    const d = await pool.query('SELECT status FROM org_domains WHERE domain = $1', [domain]);
    expect(d.rows[0].status).toBe('idp');
    // Un solo uso.
    await expect(sso.exchange({ code, codeVerifier: verifier, device: device('ios') })).rejects.toThrow();
  });

  it('el código exige el verifier y la plataforma del cliente que empezó, y se quema al primer intento', async () => {
    const { target, verifier } = await roundTrip('google', google(`beto.${run}@gmail.com`));
    const code = target.searchParams.get('code')!;
    await expect(sso.exchange({ code, codeVerifier: pkce().verifier, device: device('ios') })).rejects.toThrow(/dispositivo/);
    await expect(sso.exchange({ code, codeVerifier: verifier, device: device('ios') })).rejects.toThrow(/ya no es válido/);
    const other = await roundTrip('google', google(`beto2.${run}@gmail.com`));
    await expect(sso.exchange({ code: other.target.searchParams.get('code')!, codeVerifier: other.verifier, device: device('android') })).rejects.toThrow(/plataforma/);
  });

  it('otra persona del mismo dominio no crea una empresa duplicada', async () => {
    const domain = `nexo-${run}.co`;
    const first = await roundTrip('google', google(`uno@${domain}`, domain));
    expect(first.target.searchParams.get('code')).toBeTruthy();
    const second = await roundTrip('google', google(`dos@${domain}`, domain), {}, 'web');
    expect(second.target.origin + second.target.pathname).toMatch(/\/auth\/sso$/);
    expect(second.target.searchParams.get('error')).toBe('domain_claimed');
    // Con unión automática, entra como miembro de esa empresa.
    await pool.query(`UPDATE organizations SET join_policy = 'auto' WHERE id = (SELECT org_id FROM org_domains WHERE domain = $1)`, [domain]);
    const third = await roundTrip('google', google(`tres@${domain}`, domain));
    const auth = await sso.exchange({ code: third.target.searchParams.get('code')!, codeVerifier: third.verifier, device: device('ios') });
    const firstOrg = await pool.query('SELECT org_id FROM org_domains WHERE domain = $1', [domain]);
    expect(auth.user.primaryOrgId).toBe(firstOrg.rows[0].org_id);
  });

  it('Microsoft sin dominio verificado no crea ni vincula cuentas', async () => {
    const claims = { iss: `https://login.microsoftonline.com/${MS_TID}/v2.0`, tid: MS_TID, oid: randomUUID(), email: `ceo@banco-${run}.com` };
    const r = await roundTrip('microsoft', claims);
    expect(r.target.searchParams.get('error')).toBe('sso_email_unverified');
    const ok = await roundTrip('microsoft', { ...claims, oid: randomUUID(), xms_edov: true });
    expect(ok.target.searchParams.get('code')).toBeTruthy();
  });

  it('la misma identidad vuelve a la misma cuenta', async () => {
    const claims = google(`carla.${run}@gmail.com`);
    const a = await roundTrip('google', claims);
    const b = await roundTrip('google', { ...claims, email: `carla.nuevo.${run}@gmail.com` });
    const ua = await sso.exchange({ code: a.target.searchParams.get('code')!, codeVerifier: a.verifier, device: device('ios') });
    const ub = await sso.exchange({ code: b.target.searchParams.get('code')!, codeVerifier: b.verifier, device: device('ios') });
    expect(ub.user.id).toBe(ua.user.id);
  });

  it('las apps nuevas vuelven a chaggu:// y las anteriores a tiecoms://', async () => {
    const nuevo = await roundTrip('google', google(`nuevo.${run}@gmail.com`), { redirect_scheme: 'chaggu' });
    expect(`${nuevo.target.protocol}//${nuevo.target.host}${nuevo.target.pathname}`).toBe('chaggu://auth/callback');
    expect(nuevo.target.searchParams.get('code')).toBeTruthy();
    const viejo = await roundTrip('google', google(`viejo.${run}@gmail.com`));
    expect(`${viejo.target.protocol}//${viejo.target.host}${viejo.target.pathname}`).toBe('tiecoms://auth/callback');
    const { challenge } = pkce();
    await expect(sso.start('google', { platform: 'ios', code_challenge: challenge, code_challenge_method: 'S256', redirect_scheme: 'https' })).rejects.toThrow();
  });

  it('el state debe volver al mismo navegador', async () => {
    const { challenge } = pkce();
    const { state } = await sso.start('google', { platform: 'ios', code_challenge: challenge, code_challenge_method: 'S256' });
    const target = new URL(await sso.callback('google', { code: 'x', state }, 'otra-cookie'));
    expect(target.searchParams.get('error')).toBe('sso_state');
  });

  it('rechaza next externo y PKCE que no sea S256', async () => {
    const { challenge } = pkce();
    await expect(sso.start('google', { platform: 'web', code_challenge: challenge, code_challenge_method: 'S256', next: '//evil.example' })).rejects.toThrow();
    await expect(sso.start('google', { platform: 'web', code_challenge: challenge, code_challenge_method: 'plain' })).rejects.toThrow();
  });
});
