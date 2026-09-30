// PROVEEDOR FALSO (MOCK) de Google Calendar/Meet, Microsoft Graph/Teams y Zoom para pruebas locales.
// No habla con ningún proveedor real: probar con esto NO demuestra que OAuth o la creación real funcionen.
//   node test/fake-meetings.mjs 59300
// En el entorno del API (además de GOOGLE_/MICROSOFT_CLIENT_ID y _SECRET de mentira, y ZOOM_CLIENT_ID/_SECRET):
//   MEETINGS_GOOGLE_AUTH=http://localhost:59300/google/auth  MEETINGS_GOOGLE_TOKEN=http://localhost:59300/google/token  MEETINGS_GOOGLE_API=http://localhost:59300/google/api
//   MEETINGS_MS_AUTH=http://localhost:59300/ms/auth          MEETINGS_MS_TOKEN=http://localhost:59300/ms/token          MEETINGS_MS_API=http://localhost:59300/ms/api
//   MEETINGS_ZOOM_AUTH=http://localhost:59300/zoom/auth      MEETINGS_ZOOM_TOKEN=http://localhost:59300/zoom/token      MEETINGS_ZOOM_API=http://localhost:59300/zoom/api
// For isolated tests set MEETINGS_GOOGLE_REVOKE=http://localhost:59300/google/revoke too.
// /…/auth redirige al redirect_uri con ?code=…&state=… (como si la persona aceptara). Con ?deny=1, error=access_denied.
// POST /control { msNoTeams?: bool, revokeAll?: bool, failNext?: 'google'|'microsoft'|'zoom' } cambia el comportamiento.
// GET /stats cuenta eventos creados por proveedor (para comprobar que un reintento no duplica).
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const port = Number(process.argv[2] ?? 59300);
const state = { msNoTeams: false, revokeAll: false, failNext: null, dropAfterCreate: null, googlePending: false, googleFailed: false, busy: [], delayRefresh: false, refreshFailure: false, created: { google: 0, microsoft: 0, zoom: 0 }, byKey: new Map(), events: new Map() };
const heldRefresh = [];
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
  if (u.pathname === '/stats') return send(res, 200, { ...state.created, patched: state.patched ?? 0, deleted: state.deleted ?? 0, refreshWaiting: heldRefresh.length });
  if (u.pathname === '/events') return send(res, 200, [...state.events.values()]);
  if (u.pathname === '/control') { Object.assign(state, await body(req)); if (!state.delayRefresh) while (heldRefresh.length) heldRefresh.shift()(); return send(res, 200, { ok: true }); }
  if (kind === 'auth') {
    const to = new URL(u.searchParams.get('redirect_uri'));
    to.searchParams.set('state', u.searchParams.get('state') ?? '');
    if (u.searchParams.get('deny')) to.searchParams.set('error', 'access_denied'); else to.searchParams.set('code', `code-${prov}-${randomUUID()}`);
    res.writeHead(302, { location: to.toString() }); return res.end();
  }
  if (kind === 'token') {
    const f = await body(req);
    if (f.grant_type === 'refresh_token') {
      const fail = state.refreshFailure;
      if (state.delayRefresh) await new Promise((resolve) => heldRefresh.push(resolve));
      if (fail) return send(res, 400, { error: 'invalid_grant', error_description: 'Delayed refresh rejection (mock)' });
    }
    if (state.revokeAll && f.grant_type === 'refresh_token') return send(res, 400, { error: 'invalid_grant', error_description: 'Token revocado (mock)' });
    return send(res, 200, tokens(prov));
  }
  if (kind === 'api') {
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer at-') || state.revokeAll) return send(res, 401, { error: { code: 'unauthorized', message: 'Token inválido (mock)' } });
    if (state.failNext === prov) { state.failNext = null; return send(res, 503, { error: { message: 'Caído (mock)' } }); }
    const b = req.method === 'POST' || req.method === 'PATCH' ? await body(req) : {};
    if (prov === 'google') {
      // Citas por enlace: listar la agenda (events.list), mover (PATCH) y cancelar (DELETE).
      if (req.method === 'GET' && rest.at(-1) === 'events') {
        const min = Date.parse(u.searchParams.get('timeMin')), max = Date.parse(u.searchParams.get('timeMax'));
        const items = [...state.events.values(), ...state.busy].filter((ev) => ev.status !== 'cancelled' && Date.parse(ev.start.dateTime) < max && Date.parse(ev.end.dateTime) > min);
        return send(res, 200, { items });
      }
      if (req.method === 'PATCH') { const ev = state.events.get(rest.at(-1)); if (!ev) return send(res, 404, {}); Object.assign(ev, { start: b.start ?? ev.start, end: b.end ?? ev.end }); state.patched = (state.patched ?? 0) + 1; return send(res, 200, ev); }
      if (req.method === 'DELETE') { const ev = state.events.get(rest.at(-1)); if (!ev) return send(res, 404, {}); ev.status = 'cancelled'; state.deleted = (state.deleted ?? 0) + 1; res.writeHead(204); return res.end(); }
      if (req.method === 'GET') { const ev = state.events.get(rest.at(-1)); return ev ? send(res, 200, state.googlePending || state.googleFailed ? { ...ev, hangoutLink: undefined, conferenceData: { createRequest: { status: { statusCode: state.googleFailed ? 'failure' : 'pending' } } } } : ev) : send(res, 404, {}); }
      const id = b.id ?? randomUUID();
      const key = `g:${id}`;
      if (state.events.has(id)) return send(res, 409, { error: { status: 'conflict' } });
      const ev = { id, summary: b.summary, start: b.start, end: b.end, attendees: b.attendees, location: b.location, conferenceData: b.conferenceData && { createRequest: b.conferenceData.createRequest }, hangoutLink: `https://meet.google.com/mock-${id.slice(0, 4)}-${id.slice(4, 8)}`, conferenceData: { entryPoints: [{ entryPointType: 'video', uri: `https://meet.google.com/mock-${id.slice(0, 4)}-${id.slice(4, 8)}` }] } };
      state.byKey.set(key, ev); state.events.set(id, ev); state.created.google++;
      if (state.dropAfterCreate === 'google') { state.dropAfterCreate = null; return res.destroy(); }
      return send(res, 200, state.googlePending || state.googleFailed ? { ...ev, hangoutLink: undefined, conferenceData: { createRequest: { status: { statusCode: state.googleFailed ? 'failure' : 'pending' } } } } : ev);
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
      if (state.dropAfterCreate === 'zoom') { state.dropAfterCreate = null; return res.destroy(); }
      return send(res, 201, { id, join_url: `https://zoom.us/j/${id}?mock=1`, topic: b.topic });
    }
  }
  send(res, 404, { error: 'not found' });
}).listen(port, '127.0.0.1', () => console.log(`[fake-meetings MOCK] http://localhost:${port}`));
