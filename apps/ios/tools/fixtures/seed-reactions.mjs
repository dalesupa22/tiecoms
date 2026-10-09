// Sonda: ¿el API de pruebas :3050 tiene reacciones? Siembra reacciones en el chat de la relación (solo pruebas).
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const fx = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const API = fx.apiUrl; if (!/localhost/.test(API)) throw new Error('solo pruebas');
async function call(path, { token, body, method } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, { method: method ?? (body ? 'POST' : 'GET'), headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}
const login = (email) => call('/auth/login', { body: { email, password: fx.password, device: { deviceId: randomUUID(), name: 'probe', platform: 'agent' } } });
const a = await login(fx.a.email), b = await login(fx.b.email);
const say = (t, conv, body) => call(`/conversations/${conv}/messages`, { token: t, body: { clientMessageId: randomUUID(), body } });
const m1 = await say(a.accessToken, fx.generalId, 'Listo, quedó el acta de la mentoría 📄');
const m2 = await say(b.accessToken, fx.generalId, '🎉🎉');
const m3 = await say(b.accessToken, fx.generalId, 'Gracias, Ana 🙏 ¿Lo revisamos el viernes? 👀');
const r = (t, m, e) => call(`/messages/${m.message.id}/reactions/${encodeURIComponent(e)}`, { token: t, method: 'PUT', body: {} });
await r(b.accessToken, m1, '👍'); await r(b.accessToken, m1, '❤️'); await r(a.accessToken, m2, '😂'); await r(b.accessToken, m2, '😂'); await r(a.accessToken, m3, '👀');
console.log('ok', m1.message.id);
