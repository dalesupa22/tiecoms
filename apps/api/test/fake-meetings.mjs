// PROVEEDOR FALSO (MOCK) de Google Calendar/Meet, Microsoft Graph/Teams y Zoom para pruebas locales.
// No habla con ningún proveedor real: probar con esto NO demuestra que OAuth o la creación real funcionen.
//   node test/fake-meetings.mjs 59300
// En el entorno del API (además de GOOGLE_/MICROSOFT_CLIENT_ID y _SECRET de mentira, y ZOOM_CLIENT_ID/_SECRET):
//   MEETINGS_GOOGLE_AUTH=http://localhost:59300/google/auth  MEETINGS_GOOGLE_TOKEN=http://localhost:59300/google/token  MEETINGS_GOOGLE_API=http://localhost:59300/google/api
//   MEETINGS_MS_AUTH=http://localhost:59300/ms/auth          MEETINGS_MS_TOKEN=http://localhost:59300/ms/token          MEETINGS_MS_API=http://localhost:59300/ms/api
//   MEETINGS_ZOOM_AUTH=http://localhost:59300/zoom/auth      MEETINGS_ZOOM_TOKEN=http://localhost:59300/zoom/token      MEETINGS_ZOOM_API=http://localhost:59300/zoom/api
// /…/auth redirige al redirect_uri con ?code=…&state=… (como si la persona aceptara). Con ?deny=1, error=access_denied.
// POST /control { msNoTeams?: bool, revokeAll?: bool, failNext?: 'google'|'microsoft'|'zoom' } cambia el comportamiento.
// GET /stats cuenta eventos creados por proveedor (para comprobar que un reintento no duplica).
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const port = Number(process.argv[2] ?? 59300);
const state = { msNoTeams: false, revokeAll: false, failNext: null, created: { google: 0, microsoft: 0, zoom: 0 }, byKey: new Map(), events: new Map() };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const idToken = (email) => `${b64({ alg: 'none' })}.${b64({ email, preferred_username: email })}.`;

async function body(req) {
  let d = ''; for await (const c of req) d += c;
  if ((req.headers['content-type'] ?? '').includes('json')) { try { return JSON.parse(d || '{}'); } catch { return {}; } }
  return Object.fromEntries(new URLSearchParams(d));
}
const send = (res, status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
const tokens = (p) => ({ access_token: `at-${p}-${randomUUID()}`, refresh_token: `rt-${p}-${randomUUID()}`, expires_in: 3600, scope: 'mock', id_token: idToken(`mock.${p}@example.com`) });

http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${port}`);
  const [, prov, kind, ...rest] = u.pathname.split('/');
  if (u.pathname === '/stats') return send(res, 200, state.created);
  if (u.pathname === '/control') { Object.assign(state, await body(req)); return send(res, 200, { ok: true }); }
  if (kind === 'auth') {
    const to = new URL(u.searchParams.get('redirect_uri'));
    to.searchParams.set('state', u.searchParams.get('state') ?? '');
    if (u.searchParams.get('deny')) to.searchParams.set('error', 'access_denied'); else to.searchParams.set('code', `code-${prov}-${randomUUID()}`);
    res.writeHead(302, { location: to.toString() }); return res.end();
  }
  if (kind === 'token') {
    const f = await body(req);
    if (state.revokeAll && f.grant_type === 'refresh_token') return send(res, 400, { error: 'invalid_grant', error_description: 'Token revocado (mock)' });
    return send(res, 200, tokens(prov));
  }
  if (kind === 'api') {
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer at-') || state.revokeAll) return send(res, 401, { error: { code: 'unauthorized', message: 'Token inválido (mock)' } });
    if (state.failNext === prov) { state.failNext = null; return send(res, 503, { error: { message: 'Caído (mock)' } }); }
    const b = req.method === 'POST' ? await body(req) : {};
    if (prov === 'google') {
      if (req.method === 'GET') { const ev = state.events.get(rest.at(-1)); return ev ? send(res, 200, ev) : send(res, 404, {}); }
      const key = `g:${b.conferenceData?.createRequest?.requestId}`;
      if (state.byKey.has(key)) return send(res, 200, state.byKey.get(key));
      const id = randomUUID();
      const ev = { id, summary: b.summary, start: b.start, end: b.end, hangoutLink: `https://meet.google.com/mock-${id.slice(0, 4)}-${id.slice(4, 8)}`, conferenceData: { entryPoints: [{ entryPointType: 'video', uri: `https://meet.google.com/mock-${id.slice(0, 4)}-${id.slice(4, 8)}` }] } };
      state.byKey.set(key, ev); state.events.set(id, ev); state.created.google++;
      return send(res, 200, ev);
    }
    if (prov === 'ms') {
      const key = `m:${b.transactionId}`;
      if (state.byKey.has(key)) return send(res, 201, state.byKey.get(key));
      const id = randomUUID();
      const ev = { id, subject: b.subject, onlineMeeting: state.msNoTeams ? null : { joinUrl: `https://teams.microsoft.com/l/meetup-join/mock-${id}` } };
      state.byKey.set(key, ev); state.created.microsoft++;
      return send(res, 201, ev);
    }
    if (prov === 'zoom') {
      const id = Math.floor(Math.random() * 1e10);
      state.created.zoom++;
      return send(res, 201, { id, join_url: `https://zoom.us/j/${id}?mock=1`, topic: b.topic });
    }
  }
  send(res, 404, { error: 'not found' });
}).listen(port, () => console.log(`[fake-meetings MOCK] http://localhost:${port}`));
