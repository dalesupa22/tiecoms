/** Usa solo la base local del API: prueba el envío interno usado por el puente de WhatsApp. */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

const localDb = process.env.DATABASE_URL && ['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname);
it.runIf(localDb)('una cuenta suspendida no publica por el puente interno aunque conserve membresías', async () => {
  const { pool } = await import('../src/db.ts');
  const { sendMessage } = await import('../src/modules/messages.ts');
  const API = process.env.API_URL ?? 'http://localhost:3044';
  if (!['localhost', '127.0.0.1'].includes(new URL(API).hostname)) throw new Error('Esta prueba requiere API local');
  const password = 'local-regression-password-123', email = `background.${randomUUID()}@example.com`;
  const signup = await fetch(`${API}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.2.45' }, body: JSON.stringify({ name: 'Cuenta puente de prueba', email, password, orgName: 'Organización prueba puente', device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' } }) });
  expect(signup.status).toBe(200);
  const account = await signup.json() as any;
  let successor: string | undefined;
  try {
    const ws = await fetch(`${API}/api/v1/workspaces`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${account.accessToken}` }, body: JSON.stringify({ name: 'Grupo prueba de suspensión' }) });
    expect(ws.status).toBe(200);
    const { generalConversationId } = await ws.json() as any;
    await expect(sendMessage(account.user.id, generalConversationId, { body: 'Antes de suspender', clientMessageId: randomUUID() })).resolves.toHaveProperty('message');
    await pool.query('UPDATE users SET disabled_at = now() WHERE id = $1', [account.user.id]);
    await expect(sendMessage(account.user.id, generalConversationId, { body: 'No debe publicarse', clientMessageId: randomUUID() })).rejects.toMatchObject({ status: 404 });
    expect((await pool.query("SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND body = 'No debe publicarse'", [generalConversationId])).rows[0].n).toBe(0);
    // La única persona dueña activa puede borrar su cuenta aunque quede una dueña
    // suspendida: la sucesión debe elegir a la persona activa, no a esa dueña.
    const disabled = (await pool.query("INSERT INTO users (email, name, disabled_at) VALUES ($1, 'Dueña suspendida de prueba', now()) RETURNING id", [`disabled.${randomUUID()}@example.com`])).rows[0].id;
    successor = (await pool.query("INSERT INTO users (email, name) VALUES ($1, 'Sucesora activa de prueba') RETURNING id", [`successor.${randomUUID()}@example.com`])).rows[0].id;
    await pool.query("INSERT INTO organization_memberships (org_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')", [account.user.primaryOrgId, disabled, successor]);
  } finally {
    await pool.query('UPDATE users SET disabled_at = NULL WHERE id = $1', [account.user.id]);
    const deletion = await fetch(`${API}/api/v1/account`, { method: 'DELETE', headers: { 'content-type': 'application/json', authorization: `Bearer ${account.accessToken}` }, body: JSON.stringify({ confirmEmail: email, password }) });
    expect(deletion.status).toBe(200);
    if (successor) expect((await pool.query('SELECT role FROM organization_memberships WHERE user_id = $1 AND org_id = $2', [successor, account.user.primaryOrgId])).rows[0].role).toBe('owner');
    await pool.end();
  }
});
