import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import {
  AcceptInvitationInput, AddMembersInput, API_VERSION, CONTRACT_VERSION, CreateConversationInput, CreateDirectInput,
  CreateEventInput, CreateInvitationInput, CreateIssueInput, CreateOrgInvitationInput, CreateReminderInput, CreateWorkspaceInput, ConversationPrefsInput, DeriveInput, EditMessageInput, IssueCommentInput, MarkUnreadInput, ReturnResultInput, RsvpInput, UpdateEventInput, UpdateIssueInput, WorkspacePrefsInput, EventsQuery, LoginInput, MarkReadInput, MIN_CLIENT_CONTRACT, PageQuery,
  RefreshInput, SendMessageInput, SignupInput, SsoExchangeInput, AddDomainInput, DeleteAccountInput, type AuthResult,
  UpdateProfileInput, CreateChatInput, CreateFolderInput, UpdateFolderInput, UpdateFileInput, UploadFileQuery, CreateWaAccountInput, UpdateWaAccountInput, RelinkWaAccountInput, WaChatsQuery, UpdateWaChatInput, WaMessagesQuery,
  SideConversationInput, PushTokenInput,
} from '@tiecoms/contracts';
import { config } from './config.ts';
import { pool } from './db.ts';
import { ApiError, unauthorized } from './errors.ts';
import * as auth from './modules/auth.ts';
import * as sso from './modules/sso.ts';
import * as domains from './modules/domains.ts';
import { deleteAccount } from './modules/account.ts';
import { bootstrap } from './modules/bootstrap.ts';
import { listEvents, listMessages, markRead, sendMessage } from './modules/messages.ts';
import * as ws from './modules/workspaces.ts';
import * as invitations from './modules/invitations.ts';
import * as issues from './modules/issues.ts';
import * as cal from './modules/calendar.ts';
import * as prefs from './modules/prefs.ts';
import * as reminders from './modules/reminders.ts';
import * as wa from './modules/whatsapp.ts';
import * as profile from './modules/profile.ts';
import * as drive from './modules/drive.ts';
import * as safety from './modules/safety.ts';
import * as push from './modules/push.ts';
import * as attachments from './modules/attachments.ts';
import * as voice from './modules/voice.ts';
import * as mentions from './modules/mentions.ts';
import { readPreviewImage } from './modules/link-preview.ts';
import { getObject } from './storage.ts';
import { deleteMessage, editMessage, listPins, markUnread, setPin } from './modules/messages.ts';
import { z } from 'zod';
import { verifyAccess } from './security.ts';

const REFRESH_COOKIE = 'tc_rt';
const COOKIE_PATH = '/api/v1/auth';
const SSO_COOKIE = 'tc_sso';

declare module 'fastify' {
  interface FastifyRequest { userId: string; sessionId: string }
}

export async function buildHttp() {
  const app = Fastify({
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
    logger: { level: config.env === 'production' ? 'info' : 'debug', redact: ['req.headers.authorization', 'req.headers.cookie'] },
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(cookie);
  // La web va por el mismo origen; las apps de escritorio y móvil (WebView) llaman desde su origen local.
  await app.register(cors, {
    origin: [config.publicOrigin, ...config.extraOrigins],
    credentials: true,
    allowedHeaders: ['authorization', 'content-type', 'x-tiecoms-client', 'x-tiecoms-contract', 'x-file-type', 'x-file-name', 'x-voice-note', 'x-duration-ms', 'x-waveform', 'x-ai-consent'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    maxAge: 600,
  });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute', keyGenerator: (r) => r.ip });

  // Fotos de perfil: el cuerpo llega crudo (la imagen ya recortada en el cliente).
  // Archivos del árbol: siempre como octet-stream (el tipo real va en x-file-type), así un .json no se interpreta.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: drive.MAX_FILE_BYTES }, (_req, body, done) => done(null, body));
  app.addContentTypeParser(/^image\//, { parseAs: 'buffer', bodyLimit: profile.MAX_AVATAR_BYTES }, (_req, body, done) => done(null, body));

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'bad_request', message: 'Datos inválidos', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
    }
    if (err instanceof ApiError) return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    if (err.statusCode === 429) return reply.status(429).send({ error: { code: 'rate_limited', message: 'Demasiadas solicitudes, intenta en un momento' } });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: { code: 'bad_request', message: err.message } });
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'internal', message: 'Error interno' } });
  });

  // ---------- Salud ----------
  app.get('/api/health/live', async () => ({ ok: true }));
  app.get('/api/health/ready', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { ok: true, contract: CONTRACT_VERSION };
    } catch {
      return reply.status(503).send({ ok: false });
    }
  });
  app.get('/api/v1/meta', async () => ({ apiVersion: API_VERSION, contract: CONTRACT_VERSION, minClientContract: MIN_CLIENT_CONTRACT }));

  // ---------- Auth ----------
  const authLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  function sendAuth(req: FastifyRequest, reply: FastifyReply, r: AuthResult) {
    const web = req.body && (req.body as any).device?.platform === 'web' || req.headers['x-tiecoms-client'] === 'web';
    if (web && r.refreshToken) {
      reply.setCookie(REFRESH_COOKIE, r.refreshToken, {
        httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', path: COOKIE_PATH, maxAge: config.refreshTtlDays * 86400,
      });
      const { refreshToken: _omit, ...rest } = r;
      return rest;
    }
    return r;
  }

  app.post('/api/v1/auth/signup', authLimit, async (req, reply) => sendAuth(req, reply, await auth.signup(SignupInput.parse(req.body))));
  app.post('/api/v1/auth/login', authLimit, async (req, reply) => sendAuth(req, reply, await auth.login(LoginInput.parse(req.body))));
  app.post('/api/v1/auth/refresh', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = RefreshInput.parse(req.body ?? {});
    const fromCookie = req.cookies[REFRESH_COOKIE];
    // La cookie solo se acepta con el encabezado del cliente web (defensa CSRF adicional a SameSite).
    const token = body.refreshToken ?? (req.headers['x-tiecoms-client'] === 'web' ? fromCookie : undefined);
    if (!token) throw unauthorized();
    return sendAuth(req, reply, await auth.refresh(token));
  });

  // ---------- Google / Microsoft ----------
  // El navegador del sistema abre /start; la cookie ata el vuelo a ese navegador (Lax: vuelve en la navegación del proveedor).
  app.get<{ Params: { provider: string } }>('/api/v1/auth/:provider/start', authLimit, async (req, reply) => {
    const { url, state } = await sso.start(sso.parseProvider(req.params.provider), req.query);
    reply.setCookie(SSO_COOKIE, state, { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: COOKIE_PATH, maxAge: 600 });
    reply.header('cache-control', 'no-store');
    return reply.redirect(url, 302);
  });
  app.get<{ Params: { provider: string }; Querystring: Record<string, string | undefined> }>('/api/v1/auth/:provider/callback', authLimit, async (req, reply) => {
    const target = await sso.callback(sso.parseProvider(req.params.provider), req.query, req.cookies[SSO_COOKIE]);
    reply.clearCookie(SSO_COOKIE, { path: COOKIE_PATH });
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');
    return reply.redirect(target, 302);
  });
  app.post('/api/v1/auth/sso/exchange', authLimit, async (req, reply) => sendAuth(req, reply, await sso.exchange(SsoExchangeInput.parse(req.body))));

  // ---------- Rutas autenticadas ----------
  app.register(async (priv) => {
    priv.addHook('onRequest', async (req) => {
      const h = req.headers.authorization;
      if (!h?.startsWith('Bearer ')) throw unauthorized();
      const claims = await verifyAccess(h.slice(7));
      const active = await pool.query(
        `SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL`,
        [claims.sid, claims.sub],
      );
      if (!active.rowCount) throw unauthorized();
      req.userId = claims.sub;
      req.sessionId = claims.sid;
    });

    priv.post('/api/v1/auth/logout', async (req, reply) => {
      await auth.revokeSession(req.userId, req.sessionId);
      reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
      return { ok: true };
    });
    priv.delete('/api/v1/account', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
      const out = await deleteAccount(req.userId, DeleteAccountInput.parse(req.body ?? {}));
      reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
      return out;
    });
    priv.get('/api/v1/sessions', async (req) => ({ sessions: await auth.listSessions(req.userId), current: req.sessionId }));
    priv.delete<{ Params: { id: string } }>('/api/v1/sessions/:id', async (req) => {
      await auth.revokeSession(req.userId, req.params.id);
      return { ok: true };
    });

    priv.get('/api/v1/bootstrap', async (req) => bootstrap(req.userId));
    priv.get('/api/v1/blocks', async (req) => safety.listBlocks(req.userId));
    priv.put<{ Params: { id: string } }>('/api/v1/blocks/:id', async (req) => safety.setBlock(req.userId, z.uuid().parse(req.params.id), true));
    priv.delete<{ Params: { id: string } }>('/api/v1/blocks/:id', async (req) => safety.setBlock(req.userId, z.uuid().parse(req.params.id), false));
    priv.post('/api/v1/reports', { config: { rateLimit: { hook: 'preHandler', max: 10, timeWindow: '1 hour', keyGenerator: (req) => req.userId } } }, async (req) =>
      safety.report(req.userId, z.object({ userId: z.uuid().optional(), messageId: z.uuid().optional(), reason: z.string().trim().min(5).max(2000) }).parse(req.body)));
    // Perfil propio
    priv.patch('/api/v1/me', async (req) => profile.updateProfile(req.userId, UpdateProfileInput.parse(req.body)));
    priv.post('/api/v1/me/avatar', { bodyLimit: profile.MAX_AVATAR_BYTES, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
      async (req) => profile.setAvatar(req.userId, req.body as Buffer));
    priv.delete('/api/v1/me/avatar', async (req) => profile.removeAvatar(req.userId));
    // Foto de grupo (grupos e internos: quien administra; chats grupales y laterales: cualquier participante).
    priv.post<{ Params: { id: string } }>('/api/v1/conversations/:id/avatar', { bodyLimit: profile.MAX_AVATAR_BYTES, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
      async (req) => profile.setGroupAvatar(req.userId, z.uuid().parse(req.params.id), req.body as Buffer));
    priv.delete<{ Params: { id: string } }>('/api/v1/conversations/:id/avatar', async (req) => profile.removeGroupAvatar(req.userId, z.uuid().parse(req.params.id)));
    // Adjuntos de mensajes: se suben como octet-stream (nombre y tipo en cabeceras) y un mensaje los usa después.
    priv.post<{ Params: { id: string } }>('/api/v1/conversations/:id/attachments', { bodyLimit: attachments.MAX_UPLOAD_BYTES, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
      if (!Buffer.isBuffer(req.body)) throw new ApiError(415, 'bad_request', 'Sube el archivo como application/octet-stream');
      return attachments.upload(req.userId, z.uuid().parse(req.params.id), {
        body: req.body, name: String(req.headers['x-file-name'] ?? ''), type: String(req.headers['x-file-type'] ?? ''),
        // Nota de voz: x-voice-note: 1, x-duration-ms y x-waveform (≤ 64 valores 0–1 separados por comas).
        voice: req.headers['x-voice-note'] === '1', aiConsent: req.headers['x-ai-consent'] === '1', durationMs: req.headers['x-duration-ms'] as string | undefined, waveform: req.headers['x-waveform'] as string | undefined,
        lang: /^\s*en\b/i.test(String(req.headers['accept-language'] ?? '')) ? 'en' : 'es',
      });
    });
    priv.post<{ Params: { id: string } }>('/api/v1/attachments/:id/thumb', { bodyLimit: attachments.MAX_THUMB_BYTES, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
      if (!Buffer.isBuffer(req.body)) throw new ApiError(415, 'bad_request', 'Sube la miniatura como application/octet-stream');
      return attachments.uploadThumb(req.userId, z.uuid().parse(req.params.id), req.body);
    });
    priv.post<{ Params: { id: string } }>('/api/v1/attachments/:id/transcribe', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
      async (req) => voice.retryTranscription(req.userId, z.uuid().parse(req.params.id), z.object({ aiConsent: z.boolean().optional() }).parse(req.body ?? {}).aiConsent === true));
    for (const thumb of [false, true]) {
      priv.get<{ Params: { id: string }; Querystring: { download?: string; original?: string } }>(`/api/v1/attachments/:id${thumb ? '/thumb' : ''}`, async (req, reply) => {
        const f = await attachments.fetchFile(req.userId, z.uuid().parse(req.params.id), thumb, req.query.original === '1');
        const ascii = f.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
        const disp = f.inline && req.query.download !== '1' ? 'inline' : 'attachment';
        reply.header('content-type', f.contentType)
          .header('content-disposition', `${disp}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`)
          .header('cache-control', 'private, max-age=31536000, immutable')
          .header('x-content-type-options', 'nosniff')
          .header('content-security-policy', "default-src 'none'; sandbox")
          .header('accept-ranges', 'bytes');
        // Rango simple (bytes=a-b): los reproductores de video lo piden.
        const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
        if (range && (range[1] || range[2])) {
          const total = f.body.length;
          let start = range[1] ? Number(range[1]) : Math.max(0, total - Number(range[2]));
          let end = range[1] && range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
          if (start >= total || start > end) return reply.status(416).header('content-range', `bytes */${total}`).send();
          return reply.status(206).header('content-range', `bytes ${start}-${end}/${total}`).send(f.body.subarray(start, end + 1));
        }
        return reply.send(f.body);
      });
    }
    // Notificaciones push: un token por sesión.
    priv.put('/api/v1/push/token', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) =>
      push.registerToken(req.sessionId, PushTokenInput.parse(req.body), String(req.headers['accept-language'] ?? '')));
    priv.delete('/api/v1/push/token', async (req) => push.removeToken(req.sessionId));
    priv.get<{ Params: { id: string } }>('/api/v1/organizations/:id/domains', async (req) => ({ domains: await domains.listDomains(req.userId, req.params.id) }));
    priv.post<{ Params: { id: string } }>('/api/v1/organizations/:id/domains', async (req) =>
      domains.addDomain(req.userId, req.params.id, AddDomainInput.parse(req.body).domain));
    priv.post<{ Params: { id: string; domain: string } }>('/api/v1/organizations/:id/domains/:domain/verify', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
      async (req) => domains.verifyDomain(req.userId, req.params.id, req.params.domain));
    priv.post<{ Params: { id: string } }>('/api/v1/organizations/:id/invitations', async (req) =>
      auth.createOrgInvitation(req.userId, req.params.id, CreateOrgInvitationInput.parse(req.body ?? {})));

    priv.post('/api/v1/workspaces', async (req) => ws.createWorkspace(req.userId, CreateWorkspaceInput.parse(req.body)));
    priv.post<{ Params: { id: string } }>('/api/v1/workspaces/:id/conversations', async (req) =>
      ws.createConversation(req.userId, req.params.id, CreateConversationInput.parse(req.body)));
    priv.post<{ Params: { id: string } }>('/api/v1/workspaces/:id/invitations', async (req) =>
      ws.createInvitation(req.userId, req.params.id, CreateInvitationInput.parse(req.body)));

    // Pendientes con correo: listar, reenviar (enlace nuevo) y revocar. kind = organizations | workspaces.
    for (const [path, kind] of [['organizations', 'org'], ['workspaces', 'workspace']] as const) {
      priv.get<{ Params: { id: string } }>(`/api/v1/${path}/:id/invitations`, async (req) =>
        ({ invitations: await invitations.listPendingInvitations(kind, req.userId, req.params.id) }));
      priv.post<{ Params: { id: string; invId: string } }>(`/api/v1/${path}/:id/invitations/:invId/resend`, { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
        async (req) => invitations.resendInvitation(kind, req.userId, req.params.id, req.params.invId));
      priv.delete<{ Params: { id: string; invId: string } }>(`/api/v1/${path}/:id/invitations/:invId`, async (req) =>
        invitations.revokeInvitation(kind, req.userId, req.params.id, req.params.invId));
    }

    priv.post<{ Params: { token: string } }>('/api/v1/invitations/:token/accept', async (req) =>
      ws.acceptInvitation(req.userId, req.params.token, AcceptInvitationInput.parse(req.body ?? {})));

    priv.post('/api/v1/directs', async (req) => ws.getOrCreateDirect(req.userId, CreateDirectInput.parse(req.body).userId));
    priv.post('/api/v1/chats', async (req) => ws.createChat(req.userId, CreateChatInput.parse(req.body)));

    priv.get<{ Params: { id: string } }>('/api/v1/conversations/:id/messages', async (req) => {
      const q = PageQuery.parse(req.query);
      return listMessages(req.userId, req.params.id, q.before, q.limit);
    });
    priv.get<{ Params: { id: string } }>('/api/v1/conversations/:id/events', async (req) => {
      const q = EventsQuery.parse(req.query);
      return listEvents(req.userId, req.params.id, q.after, q.limit);
    });
    priv.post<{ Params: { id: string } }>('/api/v1/conversations/:id/messages', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
      const out = await sendMessage(req.userId, req.params.id, SendMessageInput.parse(req.body));
      return reply.status(out.duplicate ? 200 : 201).send(out);
    });
    priv.post<{ Params: { id: string } }>('/api/v1/conversations/:id/read', async (req) => markRead(req.userId, req.params.id, MarkReadInput.parse(req.body).seq));
    priv.post<{ Params: { id: string } }>('/api/v1/conversations/:id/members', async (req) => ws.addMembers(req.userId, req.params.id, AddMembersInput.parse(req.body)));
    // Preferencias personales, no leído, mensajes
    priv.put<{ Params: { id: string } }>('/api/v1/conversations/:id/prefs', async (req) => prefs.setConversationPrefs(req.userId, req.params.id, ConversationPrefsInput.parse(req.body)));
    priv.put<{ Params: { id: string } }>('/api/v1/workspaces/:id/prefs', async (req) => prefs.setWorkspacePrefs(req.userId, req.params.id, WorkspacePrefsInput.parse(req.body).pinned));
    priv.post<{ Params: { id: string } }>('/api/v1/conversations/:id/unread', async (req) => markUnread(req.userId, req.params.id, MarkUnreadInput.parse(req.body).seq));
    priv.patch<{ Params: { id: string } }>('/api/v1/messages/:id', async (req) => { const e = EditMessageInput.parse(req.body); return editMessage(req.userId, req.params.id, e.body, e.mentions); });
    // Bandeja «Menciones»: before = createdAt del último que ya tienes.
    priv.get<{ Querystring: { before?: string; limit?: string } }>('/api/v1/mentions', async (req) => {
      const q = z.object({ before: z.iso.datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
      return mentions.listMentions(req.userId, q.before, q.limit);
    });
    priv.delete<{ Params: { id: string } }>('/api/v1/messages/:id', async (req) => deleteMessage(req.userId, req.params.id));
    priv.post<{ Params: { id: string } }>('/api/v1/messages/:id/pin', async (req) => setPin(req.userId, req.params.id, true));
    priv.delete<{ Params: { id: string } }>('/api/v1/messages/:id/pin', async (req) => setPin(req.userId, req.params.id, false));
    priv.get<{ Params: { id: string } }>('/api/v1/conversations/:id/pins', async (req) => ({ messages: await listPins(req.userId, req.params.id) }));
    // Recordatorios
    priv.get('/api/v1/reminders', async (req) => ({ reminders: await reminders.listReminders(req.userId) }));
    priv.post('/api/v1/reminders', async (req) => reminders.createReminder(req.userId, CreateReminderInput.parse(req.body)));
    priv.post<{ Params: { id: string } }>('/api/v1/reminders/:id/done', async (req) => reminders.completeReminder(req.userId, req.params.id));
    priv.post<{ Params: { id: string } }>('/api/v1/reminders/:id/snooze', async (req) => reminders.completeReminder(req.userId, req.params.id, z.object({ until: z.iso.datetime() }).parse(req.body).until));
    // Calendario
    priv.get<{ Querystring: { from?: string; to?: string; conversationId?: string } }>('/api/v1/events', async (req) => {
      const q = z.object({ from: z.iso.datetime(), to: z.iso.datetime(), conversationId: z.uuid().optional() }).parse(req.query);
      return { events: await cal.listEvents(req.userId, q.from, q.to, q.conversationId) };
    });
    priv.post<{ Params: { id: string } }>('/api/v1/conversations/:id/events', async (req) => cal.createEvent(req.userId, req.params.id, CreateEventInput.parse(req.body)));
    priv.get<{ Params: { id: string } }>('/api/v1/events/:id', async (req) => cal.getEvent(req.userId, req.params.id));
    priv.patch<{ Params: { id: string } }>('/api/v1/events/:id', async (req) => cal.updateEvent(req.userId, req.params.id, UpdateEventInput.parse(req.body)));
    priv.delete<{ Params: { id: string } }>('/api/v1/events/:id', async (req) => cal.cancelEvent(req.userId, req.params.id));
    priv.post<{ Params: { id: string } }>('/api/v1/events/:id/rsvp', async (req) => cal.rsvp(req.userId, req.params.id, RsvpInput.parse(req.body).rsvp));

    // Bifurcaciones
    priv.post<{ Params: { id: string } }>('/api/v1/conversations/:id/derive', async (req) => ws.deriveConversation(req.userId, req.params.id, DeriveInput.parse(req.body)));
    priv.post<{ Params: { id: string } }>('/api/v1/conversations/:id/side', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
      async (req) => ws.createSideConversation(req.userId, z.uuid().parse(req.params.id), SideConversationInput.parse(req.body)));
    priv.post<{ Params: { id: string } }>('/api/v1/conversations/:id/return/suggest', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) =>
      ws.suggestSideReturn(req.userId, z.uuid().parse(req.params.id), /^\s*en\b/i.test(String(req.headers['accept-language'] ?? '')) ? 'en' : 'es', z.object({ aiConsent: z.boolean().optional() }).parse(req.body ?? {}).aiConsent === true));
    priv.post<{ Params: { id: string } }>('/api/v1/conversations/:id/return', async (req) => ws.returnResult(req.userId, req.params.id, ReturnResultInput.parse(req.body).summary));
    // Asuntos
    priv.get<{ Querystring: { workspaceId?: string; conversationId?: string; mine?: string; open?: string } }>('/api/v1/issues', async (req) => ({
      issues: await issues.listIssues(req.userId, { workspaceId: req.query.workspaceId, conversationId: req.query.conversationId, mine: req.query.mine === '1', open: req.query.open === '1' }),
    }));
    priv.post<{ Params: { id: string } }>('/api/v1/conversations/:id/issues', async (req) => issues.createIssue(req.userId, req.params.id, CreateIssueInput.parse(req.body)));
    priv.get<{ Params: { id: string } }>('/api/v1/issues/:id', async (req) => issues.getIssue(req.userId, req.params.id));
    priv.patch<{ Params: { id: string } }>('/api/v1/issues/:id', async (req) => issues.updateIssue(req.userId, req.params.id, UpdateIssueInput.parse(req.body)));
    priv.post<{ Params: { id: string } }>('/api/v1/issues/:id/comments', async (req) => issues.commentIssue(req.userId, req.params.id, IssueCommentInput.parse(req.body).body));

    // Archivos en árbol de carpetas («Mis archivos» o un espacio)
    priv.get<{ Querystring: { workspaceId?: string } }>('/api/v1/drive/tree', async (req) =>
      drive.tree(req.userId, req.query.workspaceId ? z.uuid().parse(req.query.workspaceId) : null));
    priv.post('/api/v1/drive/folders', async (req) => drive.createFolder(req.userId, CreateFolderInput.parse(req.body)));
    priv.patch<{ Params: { id: string } }>('/api/v1/drive/folders/:id', async (req) => drive.updateFolder(req.userId, z.uuid().parse(req.params.id), UpdateFolderInput.parse(req.body)));
    priv.delete<{ Params: { id: string } }>('/api/v1/drive/folders/:id', async (req) => drive.deleteFolder(req.userId, z.uuid().parse(req.params.id)));
    priv.post('/api/v1/drive/files', { bodyLimit: drive.MAX_FILE_BYTES, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
      const q = UploadFileQuery.parse(req.query);
      if (!Buffer.isBuffer(req.body)) throw new ApiError(415, 'bad_request', 'Sube el archivo como application/octet-stream');
      return drive.uploadFile(req.userId, {
        workspaceId: q.workspaceId ?? null, folderId: q.folderId ?? null, name: q.name,
        contentType: String(req.headers['x-file-type'] ?? 'application/octet-stream'), body: req.body,
      });
    });
    priv.patch<{ Params: { id: string } }>('/api/v1/drive/files/:id', async (req) => drive.updateFile(req.userId, z.uuid().parse(req.params.id), UpdateFileInput.parse(req.body)));
    priv.delete<{ Params: { id: string } }>('/api/v1/drive/files/:id', async (req) => drive.deleteFile(req.userId, z.uuid().parse(req.params.id)));
    priv.get<{ Params: { id: string } }>('/api/v1/drive/files/:id/link', async (req) => drive.downloadLink(req.userId, z.uuid().parse(req.params.id)));

    // Conectar WhatsApp (personal y Business): cuentas, chats y organización.
    priv.get('/api/v1/whatsapp/accounts', async (req) => ({ accounts: await wa.listAccounts(req.userId), max: wa.MAX_WA_ACCOUNTS }));
    priv.post('/api/v1/whatsapp/accounts', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => wa.createAccount(req.userId, CreateWaAccountInput.parse(req.body)));
    priv.patch<{ Params: { id: string } }>('/api/v1/whatsapp/accounts/:id', async (req) => wa.updateAccount(req.userId, req.params.id, UpdateWaAccountInput.parse(req.body)));
    priv.post<{ Params: { id: string } }>('/api/v1/whatsapp/accounts/:id/relink', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
      async (req) => wa.relinkAccount(req.userId, req.params.id, RelinkWaAccountInput.parse(req.body ?? {}).pairPhone));
    priv.delete<{ Params: { id: string } }>('/api/v1/whatsapp/accounts/:id', async (req) => wa.removeAccount(req.userId, req.params.id));
    priv.get('/api/v1/whatsapp/chats', async (req) => {
      const q = WaChatsQuery.parse(req.query);
      return wa.listChats(req.userId, { accountId: q.accountId, category: q.category, groups: q.groups === undefined ? undefined : q.groups === '1', search: q.q, hidden: q.hidden === '1', limit: q.limit });
    });
    priv.post('/api/v1/whatsapp/organize', async (req) => wa.reorganize(req.userId));
    priv.patch<{ Params: { accountId: string; jid: string } }>('/api/v1/whatsapp/chats/:accountId/:jid', async (req) =>
      wa.updateChat(req.userId, z.uuid().parse(req.params.accountId), req.params.jid, UpdateWaChatInput.parse(req.body)));
    priv.get<{ Params: { accountId: string; jid: string } }>('/api/v1/whatsapp/chats/:accountId/:jid/messages', async (req) => {
      const q = WaMessagesQuery.parse(req.query);
      return wa.listChatMessages(req.userId, z.uuid().parse(req.params.accountId), req.params.jid, q.before, q.limit);
    });

    priv.delete<{ Params: { id: string; userId: string } }>('/api/v1/conversations/:id/members/:userId', async (req) => {
      await ws.removeMember(req.userId, req.params.id, req.params.userId);
      return { ok: true };
    });
  });

  // Foto de perfil: el id cambia en cada subida, así que se puede cachear para siempre.
  app.get<{ Params: { id: string } }>('/api/v1/avatars/:id', async (req, reply) => {
    const f = await profile.readAvatar(z.uuid().parse(req.params.id));
    return reply.header('content-type', f.contentType).header('cache-control', 'public, max-age=31536000, immutable').send(f.body);
  });

  // Miniatura de una vista previa de enlace (guardada en S3 por el worker).
  app.get<{ Params: { id: string } }>('/api/v1/previews/:id', async (req, reply) => {
    const key = await readPreviewImage(z.uuid().parse(req.params.id));
    if (!key) return reply.status(404).send({ error: { code: 'not_found', message: 'No encontrada' } });
    const f = await getObject(key);
    return reply.header('content-type', f.contentType).header('cache-control', 'public, max-age=31536000, immutable').send(f.body);
  });

  app.get<{ Params: { token: string } }>('/api/v1/org-invitations/:token', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => auth.previewOrgInvitation(req.params.token));

  // Vista previa pública de invitación (requiere el token; no expone datos del espacio más allá del nombre).
  app.get<{ Params: { token: string } }>('/api/v1/invitations/:token', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => ws.previewInvitation(req.params.token));

  return app;
}
