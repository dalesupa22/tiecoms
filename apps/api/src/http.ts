import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import {
  AcceptInvitationInput, AddMembersInput, API_VERSION, CONTRACT_VERSION, CreateConversationInput, CreateDirectInput,
  CreateInvitationInput, CreateIssueInput, CreateOrgInvitationInput, CreateWorkspaceInput, DeriveInput, IssueCommentInput, ReturnResultInput, UpdateIssueInput, EventsQuery, LoginInput, MarkReadInput, MIN_CLIENT_CONTRACT, PageQuery,
  RefreshInput, SendMessageInput, SignupInput, type AuthResult,
} from '@tiecoms/contracts';
import { config } from './config.ts';
import { pool } from './db.ts';
import { ApiError, unauthorized } from './errors.ts';
import * as auth from './modules/auth.ts';
import { bootstrap } from './modules/bootstrap.ts';
import { listEvents, listMessages, markRead, sendMessage } from './modules/messages.ts';
import * as ws from './modules/workspaces.ts';
import * as issues from './modules/issues.ts';
import { verifyAccess } from './security.ts';

const REFRESH_COOKIE = 'tc_rt';
const COOKIE_PATH = '/api/v1/auth';

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
    allowedHeaders: ['authorization', 'content-type', 'x-tiecoms-client', 'x-tiecoms-contract'],
    methods: ['GET', 'POST', 'DELETE', 'PATCH'],
    maxAge: 600,
  });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute', keyGenerator: (r) => r.ip });

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

  // ---------- Rutas autenticadas ----------
  app.register(async (priv) => {
    priv.addHook('onRequest', async (req) => {
      const h = req.headers.authorization;
      if (!h?.startsWith('Bearer ')) throw unauthorized();
      const claims = await verifyAccess(h.slice(7));
      req.userId = claims.sub;
      req.sessionId = claims.sid;
    });

    priv.post('/api/v1/auth/logout', async (req, reply) => {
      await auth.revokeSession(req.userId, req.sessionId);
      reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
      return { ok: true };
    });
    priv.get('/api/v1/sessions', async (req) => ({ sessions: await auth.listSessions(req.userId), current: req.sessionId }));
    priv.delete<{ Params: { id: string } }>('/api/v1/sessions/:id', async (req) => {
      await auth.revokeSession(req.userId, req.params.id);
      return { ok: true };
    });

    priv.get('/api/v1/bootstrap', async (req) => bootstrap(req.userId));
    priv.post<{ Params: { id: string } }>('/api/v1/organizations/:id/invitations', async (req) =>
      auth.createOrgInvitation(req.userId, req.params.id, CreateOrgInvitationInput.parse(req.body ?? {})));

    priv.post('/api/v1/workspaces', async (req) => ws.createWorkspace(req.userId, CreateWorkspaceInput.parse(req.body)));
    priv.post<{ Params: { id: string } }>('/api/v1/workspaces/:id/conversations', async (req) =>
      ws.createConversation(req.userId, req.params.id, CreateConversationInput.parse(req.body)));
    priv.post<{ Params: { id: string } }>('/api/v1/workspaces/:id/invitations', async (req) =>
      ws.createInvitation(req.userId, req.params.id, CreateInvitationInput.parse(req.body)));

    priv.post<{ Params: { token: string } }>('/api/v1/invitations/:token/accept', async (req) =>
      ws.acceptInvitation(req.userId, req.params.token, AcceptInvitationInput.parse(req.body ?? {})));

    priv.post('/api/v1/directs', async (req) => ws.getOrCreateDirect(req.userId, CreateDirectInput.parse(req.body).userId));

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
    // Bifurcaciones
    priv.post<{ Params: { id: string } }>('/api/v1/conversations/:id/derive', async (req) => ws.deriveConversation(req.userId, req.params.id, DeriveInput.parse(req.body)));
    priv.post<{ Params: { id: string } }>('/api/v1/conversations/:id/return', async (req) => ws.returnResult(req.userId, req.params.id, ReturnResultInput.parse(req.body).summary));
    // Asuntos
    priv.get<{ Querystring: { workspaceId?: string; conversationId?: string; mine?: string; open?: string } }>('/api/v1/issues', async (req) => ({
      issues: await issues.listIssues(req.userId, { workspaceId: req.query.workspaceId, conversationId: req.query.conversationId, mine: req.query.mine === '1', open: req.query.open === '1' }),
    }));
    priv.post<{ Params: { id: string } }>('/api/v1/conversations/:id/issues', async (req) => issues.createIssue(req.userId, req.params.id, CreateIssueInput.parse(req.body)));
    priv.get<{ Params: { id: string } }>('/api/v1/issues/:id', async (req) => issues.getIssue(req.userId, req.params.id));
    priv.patch<{ Params: { id: string } }>('/api/v1/issues/:id', async (req) => issues.updateIssue(req.userId, req.params.id, UpdateIssueInput.parse(req.body)));
    priv.post<{ Params: { id: string } }>('/api/v1/issues/:id/comments', async (req) => issues.commentIssue(req.userId, req.params.id, IssueCommentInput.parse(req.body).body));

    priv.delete<{ Params: { id: string; userId: string } }>('/api/v1/conversations/:id/members/:userId', async (req) => {
      await ws.removeMember(req.userId, req.params.id, req.params.userId);
      return { ok: true };
    });
  });

  app.get<{ Params: { token: string } }>('/api/v1/org-invitations/:token', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => auth.previewOrgInvitation(req.params.token));

  // Vista previa pública de invitación (requiere el token; no expone datos del espacio más allá del nombre).
  app.get<{ Params: { token: string } }>('/api/v1/invitations/:token', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => ws.previewInvitation(req.params.token));

  return app;
}
