import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import {
  AcceptInvitationInput, AddMembersInput, API_VERSION, CONTRACT_VERSION, CreateConversationInput, CreateDirectInput, CreateGroupInput, JoinPolicyInput,
  CreateEventInput, CreateInvitationInput, CreateIssueInput, CreateChildIssueInput, CreatePersonalIssueInput, CreateOrgInvitationInput, CreateReminderInput, CreateScheduledInput, UpdateScheduledInput, CreateWorkspaceInput, ConversationPrefsInput, DeriveInput, EditMessageInput, IssueCommentInput, MarkUnreadInput, ReturnResultInput, RsvpInput, UpdateEventInput, UpdateIssueInput, WorkspacePrefsInput, EventsQuery, LoginInput, MarkReadInput, MarkTreeReadInput, MIN_CLIENT_CONTRACT, PageQuery,
  RefreshInput, SendMessageInput, CreateTopicInput, UpdateTopicInput, SetMessageTopicInput, SignupInput, SsoExchangeInput, AddDomainInput, DeleteAccountInput, type AuthResult,
  UpdateProfileInput, DndInput, MeetingProvider, MeetingConnectInput, MeetingConfirmInput, CreateMeetingInput, SleepInput, CreateChatInput, CreateFolderInput, UpdateFolderInput, UpdateFileInput, UploadFileQuery, CreateWaAccountInput, UpdateWaAccountInput, RelinkWaAccountInput, WaChatsQuery, UpdateWaChatInput, WaMessagesQuery,
  SideConversationInput, PushTokenInput, ReactInput, LinksQuery, SavedLinksQuery, LinkStateInput, ReactionActionsInput,
  SignPdfInput, MAX_SIGNATURE_BYTES, SigningHistoryQuery,
  CreateIntegrationInput, IncomingWebhookInput, IntegrationCommentInput, IntegrationCreateIssueInput, IntegrationUpdateIssueInput,
  ChatSearchQuery, EventCommentInput,
  SetAdminInput, UpdateIntegrationInput, StartCallInput, CallDeviceInput, SoundsInput, CallTranscriptionInput, CallTranscriptInput, CallHistoryQuery, CallShareInput, CallInviteInput,
} from '@tiecoms/contracts';
import { config } from './config.ts';
import { pool } from './db.ts';
import { ApiError, notFound, unauthorized } from './errors.ts';
import * as auth from './modules/auth.ts';
import * as sso from './modules/sso.ts';
import * as domains from './modules/domains.ts';
import { deleteAccount } from './modules/account.ts';
import { bootstrap } from './modules/bootstrap.ts';
import { listEvents, listMessages, markRead, markTreeRead, sendMessage } from './modules/messages.ts';
import * as ws from './modules/workspaces.ts';
import * as groups from './modules/groups.ts';
import * as invitations from './modules/invitations.ts';
import * as issues from './modules/issues.ts';
import * as cal from './modules/calendar.ts';
import * as prefs from './modules/prefs.ts';
import * as reminders from './modules/reminders.ts';
import * as meetings from './modules/meetings.ts';
import * as scheduled from './modules/scheduled.ts';
import * as wa from './modules/whatsapp.ts';
import * as profile from './modules/profile.ts';
import * as drive from './modules/drive.ts';
import * as safety from './modules/safety.ts';
import * as push from './modules/push.ts';
import * as attachments from './modules/attachments.ts';
import * as voice from './modules/voice.ts';
import * as calls from './modules/calls.ts';
import * as assistant from './modules/assistant.ts';
import * as signatures from './modules/signatures.ts';
import * as mentions from './modules/mentions.ts';
import { readPreviewImage } from './modules/link-preview.ts';
import * as reactions from './modules/reactions.ts';
import * as links from './modules/links.ts';
import * as topics from './modules/topics.ts';
import * as integrations from './modules/integrations.ts';
import { openViewOnce, fetchOnce } from './modules/view-once.ts';
import { searchConversation } from './modules/chat-search.ts';
import { getObject } from './storage.ts';
import { deleteMessage, editMessage, listPins, markUnread, setPin } from './modules/messages.ts';
import { z } from 'zod';
import { verifyAccess } from './security.ts';
import { ByteLru } from './lru.ts';

const REFRESH_COOKIE = 'tc_rt';
/** Fotos de perfil y miniaturas de enlaces en memoria (inmutables por id). */
export const imageCache = new ByteLru<{ body: Buffer; contentType: string }>(200, 20 * 1024 * 1024);
const COOKIE_PATH = '/api/v1/auth';
import { safeRequestPath } from './log-safety.ts';

const SSO_COOKIE = 'tc_sso';

declare module 'fastify' {
  interface FastifyRequest { userId: string; sessionId: string }
}

export async function buildHttp() {
  const app = Fastify({
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
    logger: {
      level: config.env === 'production' ? 'info' : 'debug', redact: ['req.headers.authorization', 'req.headers.cookie'],
      // OAuth codes/state/receipts and other URL credentials must never enter access logs.
      serializers: { req: (req) => ({ method: req.method, url: safeRequestPath(req.url), hostname: req.hostname, remoteAddress: req.ip }) },
    },
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

  // Avoid Fastify's default not-found log message, which embeds a raw credential-bearing URL.
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'not_found', message: 'Ruta no encontrada' } }));

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
  // Adjunto de una sola vista: URL firmada de 60 s (sin Bearer) que solo entrega POST /messages/:id/open.
  app.get<{ Querystring: { t?: string } }>('/api/v1/once', async (req, reply) => {
    const f = await fetchOnce(String(req.query.t ?? ''));
    return reply.header('content-type', f.contentType).header('content-disposition', 'inline').header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff').header('content-security-policy', "default-src 'none'; sandbox").send(f.body);
  });
  app.get('/api/v1/meta', async () => ({ apiVersion: API_VERSION, contract: CONTRACT_VERSION, minClientContract: MIN_CLIENT_CONTRACT }));
  // «Actualización disponible» (docs/ACTUALIZAR.md): público, las apps lo piden al abrir y al volver al frente.
  app.get<{ Querystring: { platform?: string; lang?: string } }>('/api/v1/app-version', async (req, reply) => {
    const q = z.object({ platform: z.enum(['ios', 'android']), lang: z.string().max(10).optional() }).parse(req.query);
    const { rows } = await pool.query('SELECT * FROM app_releases WHERE platform = $1', [q.platform]);
    const r = rows[0];
    if (!r) throw notFound('Versión');
    reply.header('cache-control', 'no-store');
    return {
      platform: r.platform, latestVersion: r.latest_version, latestBuild: r.latest_build, minBuild: r.min_build, url: r.url,
      notes: (q.lang?.startsWith('en') ? r.notes_en : r.notes_es) ?? null,
    };
  });

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
    // Conectar Meet/Teams vuelve por esta misma redirect URI registrada: el state lo distingue del login.
    if (meetings.isMeetingState(req.query.state)) {
      reply.header('cache-control', 'no-store'); reply.header('referrer-policy', 'no-referrer');
      return reply.redirect(await meetings.finishConnect(req.query, MeetingProvider.parse(req.params.provider)), 302);
    }
    const target = await sso.callback(sso.parseProvider(req.params.provider), req.query, req.cookies[SSO_COOKIE]);
    reply.clearCookie(SSO_COOKIE, { path: COOKIE_PATH });
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');
    return reply.redirect(target, 302);
  });
  app.get<{ Querystring: Record<string, string | undefined> }>('/api/v1/meetings/zoom/callback', authLimit, async (req, reply) => {
    reply.header('cache-control', 'no-store'); reply.header('referrer-policy', 'no-referrer');
    return reply.redirect(await meetings.finishConnect(req.query, 'zoom'), 302);
  });
  app.post('/api/v1/auth/sso/exchange', authLimit, async (req, reply) => sendAuth(req, reply, await sso.exchange(SsoExchangeInput.parse(req.body))));

  // ---------- Integraciones (token del grupo, sin sesión) ----------
  // Webhook entrante con el formato de Slack: el token en Authorization o, para quien solo acepta una URL, en la ruta.
  const hookLimit = { config: { rateLimit: { max: 120, timeWindow: '1 minute', keyGenerator: (r: FastifyRequest) => `hook:${(r.params as any)?.id ?? r.ip}` } } };
  const bearer = (req: FastifyRequest) => { const h = req.headers.authorization; return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined; };
  const idemKey = (req: FastifyRequest) => { const k = req.headers['idempotency-key']; return typeof k === 'string' && k ? k : undefined; };
  const hook = async (req: FastifyRequest<{ Params: { id: string; token?: string } }>) => {
    const id = z.uuid().safeParse(req.params.id);
    if (!id.success) throw unauthorized('Token de integración inválido');
    const integ = await integrations.authenticate(req.params.token ?? bearer(req), id.data);
    return integrations.postMessage(integ, IncomingWebhookInput.parse(req.body ?? {}), idemKey(req));
  };
  app.post<{ Params: { id: string } }>('/api/hooks/:id', hookLimit, hook);
  app.post<{ Params: { id: string; token: string } }>('/api/hooks/:id/:token', hookLimit, hook);

  app.register(async (api) => {
    api.addHook('onRequest', async (req) => { (req as any).integration = await integrations.authenticate(bearer(req)); });
    const integ = (req: FastifyRequest) => (req as any).integration as integrations.IntegrationAuth;
    const limit = { config: { rateLimit: { max: 300, timeWindow: '1 minute', keyGenerator: (r: FastifyRequest) => `integ:${bearer(r)?.slice(-12) ?? r.ip}` } } };
    api.get('/api/integration/v1/me', limit, async (req) => integrations.describe(integ(req)));
    api.post('/api/integration/v1/messages', limit, async (req) => integrations.postMessage(integ(req), IncomingWebhookInput.parse(req.body ?? {}), idemKey(req)));
    api.post('/api/integration/v1/issues', limit, async (req) => integrations.createIssue(integ(req), IntegrationCreateIssueInput.parse(req.body)));
    api.get<{ Querystring: { externalId?: string } }>('/api/integration/v1/issues', limit, async (req) =>
      integrations.findIssue(integ(req), z.string().min(1).max(120).parse(req.query.externalId)));
    api.get<{ Params: { id: string } }>('/api/integration/v1/issues/:id', limit, async (req) => integrations.getIssue(integ(req), z.uuid().parse(req.params.id)));
    api.patch<{ Params: { id: string } }>('/api/integration/v1/issues/:id', limit, async (req) =>
      integrations.updateIssue(integ(req), z.uuid().parse(req.params.id), IntegrationUpdateIssueInput.parse(req.body)));
    api.post<{ Params: { id: string } }>('/api/integration/v1/issues/:id/comments', limit, async (req) =>
      integrations.commentIssue(integ(req), z.uuid().parse(req.params.id), IntegrationCommentInput.parse(req.body), idemKey(req)));
  });

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
    // «No molestar» general: { until: ISO | null } → { dndUntil }.
    priv.put('/api/v1/me/sounds', async (req) => prefs.setSounds(req.userId, SoundsInput.parse(req.body ?? {})));
    priv.put('/api/v1/me/dnd', async (req) => prefs.setDnd(req.userId, DndInput.parse(req.body ?? {}).until));
    // Modo sueño: horario diario sin sonidos { on?, start?, end?, tz?, tzAuto? } → { sleep }.
    priv.put('/api/v1/me/sleep', async (req) => prefs.setSleep(req.userId, SleepInput.parse(req.body ?? {})));
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
    // Firmar PDFs: firmas guardadas (PNG crudo, solo su dueño) y estampado en el servidor.
    priv.get('/api/v1/me/signatures', async (req) => ({ signatures: await signatures.listSignatures(req.userId) }));
    priv.post('/api/v1/me/signatures', { bodyLimit: MAX_SIGNATURE_BYTES, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
      if (!Buffer.isBuffer(req.body)) throw new ApiError(415, 'bad_request', 'Sube la firma como image/png');
      return signatures.createSignature(req.userId, req.body, String(req.headers['x-signature-kind'] ?? ''), String(req.headers['x-signature-source'] ?? ''));
    });
    priv.get<{ Params: { id: string } }>('/api/v1/me/signatures/:id/image', async (req, reply) => {
      const png = await signatures.signatureImage(req.userId, z.uuid().parse(req.params.id));
      return reply.header('content-type', 'image/png').header('cache-control', 'private, max-age=31536000, immutable')
        .header('x-content-type-options', 'nosniff').header('content-security-policy', "default-src 'none'; sandbox").send(png);
    });
    priv.delete<{ Params: { id: string } }>('/api/v1/me/signatures/:id', async (req) => signatures.deleteSignature(req.userId, z.uuid().parse(req.params.id)));
    priv.get('/api/v1/me/signings', async (req) => signatures.listSignings(req.userId, SigningHistoryQuery.parse(req.query)));
    priv.get<{ Params: { id: string } }>('/api/v1/attachments/:id/sign-info', async (req) => signatures.signInfo(req.userId, z.uuid().parse(req.params.id)));
    priv.post<{ Params: { id: string } }>('/api/v1/attachments/:id/sign', { bodyLimit: 256 * 1024, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
      const input = SignPdfInput.parse(req.body);
      const out = await signatures.signPdf(req.userId, z.uuid().parse(req.params.id), input, {
        ip: req.ip ?? null, userAgent: String(req.headers['user-agent'] ?? '') || null,
        lang: /^\s*en\b/i.test(String(req.headers['accept-language'] ?? '')) ? 'en' : 'es',
      });
      return reply.status(out.duplicate ? 200 : 201).send(out);
    });
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
    priv.post('/api/v1/groups', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => groups.createGroup(req.userId, CreateGroupInput.parse(req.body)));
    priv.get<{ Params: { id: string } }>('/api/v1/organizations/:id/oversight', async (req) => groups.listOversight(req.userId, z.uuid().parse(req.params.id)));
    priv.post<{ Params: { id: string } }>('/api/v1/conversations/:id/archive', async (req) => groups.archiveGroup(req.userId, z.uuid().parse(req.params.id)));
    priv.put<{ Params: { id: string } }>('/api/v1/organizations/:id/join-policy', async (req) => domains.setJoinPolicy(req.userId, z.uuid().parse(req.params.id), JoinPolicyInput.parse(req.body).joinPolicy));
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

    // Asistente: todo corre con req.userId (ver modules/assistant.ts, «Aislamiento»).
    priv.post('/api/v1/assistant/turn', { config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: (r: FastifyRequest) => r.userId ?? r.ip } } }, async (req) => assistant.turn(req.userId, req.body));
    priv.post<{ Querystring: { lang?: string } }>('/api/v1/assistant/transcribe', { config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: (r: FastifyRequest) => r.userId ?? r.ip } } },
      async (req) => assistant.transcribe(req.userId, req.body, req.headers['x-file-type'] as string | undefined, req.query.lang, req.headers['x-ai-consent'] === '1'));
    priv.post('/api/v1/assistant/run', { config: { rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: (r: FastifyRequest) => r.userId ?? r.ip } } }, async (req) => assistant.run(req.userId, req.body));
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
    priv.post<{ Params: { id: string } }>('/api/v1/conversations/:id/read-tree', async (req) => markTreeRead(req.userId, req.params.id, MarkTreeReadInput.parse(req.body).items));
    priv.post<{ Params: { id: string } }>('/api/v1/conversations/:id/members', async (req) => ws.addMembers(req.userId, req.params.id, AddMembersInput.parse(req.body)));
    // Preferencias personales, no leído, mensajes
    priv.put<{ Params: { id: string } }>('/api/v1/conversations/:id/prefs', async (req) => prefs.setConversationPrefs(req.userId, req.params.id, ConversationPrefsInput.parse(req.body)));
    priv.put<{ Params: { id: string } }>('/api/v1/workspaces/:id/prefs', async (req) => prefs.setWorkspacePrefs(req.userId, req.params.id, WorkspacePrefsInput.parse(req.body).pinned));
    priv.post<{ Params: { id: string } }>('/api/v1/conversations/:id/unread', async (req) => markUnread(req.userId, req.params.id, MarkUnreadInput.parse(req.body).seq));
    priv.patch<{ Params: { id: string } }>('/api/v1/messages/:id', async (req) => { const e = EditMessageInput.parse(req.body); return editMessage(req.userId, req.params.id, e.body, e.mentions, e.refs); });
    // Tanda 1.7: buscar dentro del chat y abrir un mensaje de una sola vista (una vez por persona).
    priv.get<{ Params: { id: string } }>('/api/v1/conversations/:id/search', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) =>
      searchConversation(req.userId, z.uuid().parse(req.params.id), ChatSearchQuery.parse(req.query)));
    priv.post<{ Params: { id: string } }>('/api/v1/messages/:id/open', async (req) => openViewOnce(req.userId, z.uuid().parse(req.params.id)));
    // Bandeja «Menciones»: before = createdAt del último que ya tienes.
    priv.get<{ Querystring: { before?: string; limit?: string } }>('/api/v1/mentions', async (req) => {
      const q = z.object({ before: z.iso.datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
      return mentions.listMentions(req.userId, q.before, q.limit);
    });
    priv.delete<{ Params: { id: string } }>('/api/v1/messages/:id', async (req) => deleteMessage(req.userId, req.params.id));
    priv.post<{ Params: { id: string } }>('/api/v1/messages/:id/pin', async (req) => setPin(req.userId, req.params.id, true));
    priv.delete<{ Params: { id: string } }>('/api/v1/messages/:id/pin', async (req) => setPin(req.userId, req.params.id, false));
    priv.get<{ Params: { id: string } }>('/api/v1/conversations/:id/pins', async (req) => ({ messages: await listPins(req.userId, req.params.id) }));
    // Temas (docs/TEMAS.md): banderitas del chat y etiqueta de cada mensaje.
    priv.get<{ Params: { id: string } }>('/api/v1/conversations/:id/topics', async (req) => ({ topics: await topics.listTopics(req.userId, req.params.id) }));
    priv.post<{ Params: { id: string } }>('/api/v1/conversations/:id/topics', async (req) => topics.createTopic(req.userId, req.params.id, CreateTopicInput.parse(req.body)));
    priv.patch<{ Params: { id: string } }>('/api/v1/topics/:id', async (req) => topics.updateTopic(req.userId, z.uuid().parse(req.params.id), UpdateTopicInput.parse(req.body)));
    priv.delete<{ Params: { id: string } }>('/api/v1/topics/:id', async (req) => topics.deleteTopic(req.userId, z.uuid().parse(req.params.id)));
    priv.put<{ Params: { id: string } }>('/api/v1/messages/:id/topic', async (req) => topics.setMessageTopic(req.userId, z.uuid().parse(req.params.id), SetMessageTopicInput.parse(req.body).topicId));
    // Reacciones: el emoji va en la ruta (URL-encoded). No suben no leídos; llegan a todos con message.updated.
    priv.put<{ Params: { id: string; emoji: string } }>('/api/v1/messages/:id/reactions/:emoji', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) =>
      reactions.react(req.userId, z.uuid().parse(req.params.id), req.params.emoji, true, ReactInput.parse(req.body ?? {})));
    priv.delete<{ Params: { id: string; emoji: string } }>('/api/v1/messages/:id/reactions/:emoji', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) =>
      reactions.react(req.userId, z.uuid().parse(req.params.id), req.params.emoji, false));
    priv.put<{ Params: { id: string } }>('/api/v1/organizations/:id/reaction-actions', async (req) =>
      reactions.setReactionActions(req.userId, z.uuid().parse(req.params.id), ReactionActionsInput.parse(req.body).reactionActions));
    // Enlaces: biblioteca del chat, «Ver después» personal y resumen con IA bajo pedido.
    priv.get<{ Params: { id: string } }>('/api/v1/conversations/:id/links', async (req) => links.listLinks(req.userId, z.uuid().parse(req.params.id), LinksQuery.parse(req.query)));
    priv.get('/api/v1/links/saved', async (req) => links.listSaved(req.userId, SavedLinksQuery.parse(req.query)));
    priv.put<{ Params: { id: string } }>('/api/v1/links/:id/state', async (req) => links.setLinkState(req.userId, z.uuid().parse(req.params.id), LinkStateInput.parse(req.body)));
    priv.post<{ Params: { id: string } }>('/api/v1/links/:id/summary', { config: { rateLimit: { hook: 'preHandler', max: 20, timeWindow: '1 minute', keyGenerator: (req) => req.userId } } }, async (req) => {
      const lang = z.object({ lang: z.enum(['es', 'en']).optional() }).parse(req.body ?? {}).lang
        ?? (/^\s*en\b/i.test(String(req.headers['accept-language'] ?? '')) ? 'en' : 'es');
      return links.summarizeLink(req.userId, z.uuid().parse(req.params.id), lang);
    });
    // Recordatorios
    // Mensajes programados: solo los ve quien los escribió.
    priv.get<{ Querystring: { conversationId?: string } }>('/api/v1/scheduled', async (req) => ({ scheduled: await scheduled.listScheduled(req.userId, req.query.conversationId) }));
    priv.post<{ Params: { id: string } }>('/api/v1/conversations/:id/scheduled', async (req) => scheduled.createScheduled(req.userId, req.params.id, CreateScheduledInput.parse(req.body)));
    priv.patch<{ Params: { id: string } }>('/api/v1/scheduled/:id', async (req) => scheduled.updateScheduled(req.userId, req.params.id, UpdateScheduledInput.parse(req.body)));
    priv.delete<{ Params: { id: string } }>('/api/v1/scheduled/:id', async (req) => scheduled.cancelScheduled(req.userId, req.params.id));
    priv.post<{ Params: { id: string } }>('/api/v1/scheduled/:id/send', async (req) => scheduled.sendScheduledNow(req.userId, req.params.id));
    // Llamadas de voz y video (Amazon Chime SDK) con transcripción que se prende y apaga.
    const callLimit = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
    priv.get<{ Params: { id: string } }>('/api/v1/conversations/:id/call', async (req) => ({ call: await calls.activeCall(req.userId, z.uuid().parse(req.params.id)) }));
    priv.post<{ Params: { id: string } }>('/api/v1/conversations/:id/call', callLimit, async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const b = StartCallInput.parse(req.body ?? {});
      return calls.startOrJoin(req.userId, z.uuid().parse(req.params.id), b.kind, calls.deviceOf(req.sessionId, b.deviceKey));
    });
    priv.post<{ Params: { id: string } }>('/api/v1/calls/:id/join', callLimit, async (req, reply) => { reply.header('cache-control', 'no-store'); return calls.join(req.userId, z.uuid().parse(req.params.id), calls.deviceOf(req.sessionId, CallDeviceInput.parse(req.body ?? {}).deviceKey)); });
    priv.post<{ Params: { id: string } }>('/api/v1/calls/:id/invite', callLimit, async (req) => calls.invite(req.userId, z.uuid().parse(req.params.id), CallInviteInput.parse(req.body).userIds));
    priv.post<{ Params: { id: string } }>('/api/v1/calls/:id/heartbeat', async (req) => calls.heartbeat(req.userId, z.uuid().parse(req.params.id), CallDeviceInput.parse(req.body ?? {}).deviceKey));
    priv.post<{ Params: { id: string } }>('/api/v1/calls/:id/leave', async (req) => calls.leave(req.userId, z.uuid().parse(req.params.id), CallDeviceInput.parse(req.body ?? {}).deviceKey));
    priv.post<{ Params: { id: string } }>('/api/v1/calls/:id/decline', callLimit, async (req) => calls.decline(req.userId, z.uuid().parse(req.params.id)));
    priv.get('/api/v1/calls/active', async (req) => calls.activeCalls(req.userId));
    priv.post<{ Params: { id: string } }>('/api/v1/calls/:id/end', async (req) => calls.endForAll(req.userId, z.uuid().parse(req.params.id)));
    priv.post<{ Params: { id: string } }>('/api/v1/calls/:id/transcription', callLimit, async (req) => {
      const b = CallTranscriptionInput.parse(req.body);
      return calls.setTranscription(req.userId, z.uuid().parse(req.params.id), b.on, b.aiSummary);
    });
    priv.post<{ Params: { id: string } }>('/api/v1/calls/:id/transcript', { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (req) =>
      calls.addSegments(req.userId, z.uuid().parse(req.params.id), CallTranscriptInput.parse(req.body)));
    priv.post<{ Params: { id: string } }>('/api/v1/calls/:id/audio', { bodyLimit: calls.MAX_CALL_AUDIO_BYTES, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
      if (!Buffer.isBuffer(req.body)) throw new ApiError(415, 'bad_request', 'Sube el audio como application/octet-stream');
      return calls.addAudio(req.userId, z.uuid().parse(req.params.id), {
        body: req.body, type: String(req.headers['x-file-type'] ?? ''), segId: String(req.headers['x-seg-id'] ?? ''),
        offsetMs: Math.max(0, Number(req.headers['x-offset-ms']) || 0), durationMs: Math.max(0, Number(req.headers['x-duration-ms']) || 0),
      });
    });
    priv.get<{ Params: { id: string } }>('/api/v1/calls/:id/transcript', async (req) => calls.transcript(req.userId, z.uuid().parse(req.params.id)));
    priv.get('/api/v1/calls', async (req) => calls.history(req.userId, CallHistoryQuery.parse(req.query)));
    priv.post<{ Params: { id: string } }>('/api/v1/calls/:id/share', callLimit, async (req) => calls.share(req.userId, z.uuid().parse(req.params.id), CallShareInput.parse(req.body)));
    // Reuniones con Meet, Teams o Zoom (cuenta de cada persona).
    priv.get('/api/v1/meetings/connections', async (req) => ({ connections: await meetings.listConnections(req.userId) }));
    priv.post('/api/v1/meetings/connect/confirm', async (req, reply) => { reply.header('cache-control', 'no-store'); return meetings.confirmConnect(req.userId, MeetingConfirmInput.parse(req.body)); });
    priv.post<{ Params: { provider: string } }>('/api/v1/meetings/connect/:provider', async (req) => {
      const p = MeetingProvider.parse(req.params.provider);
      const b = MeetingConnectInput.parse(req.body ?? {});
      return meetings.startConnect(req.userId, p, { platform: b.platform, redirectScheme: b.redirectScheme, proofChallenge: b.proofChallenge });
    });
    priv.delete<{ Params: { provider: string } }>('/api/v1/meetings/connections/:provider', async (req) => meetings.disconnect(req.userId, MeetingProvider.parse(req.params.provider)));
    priv.post('/api/v1/meetings', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => meetings.createMeeting(req.userId, CreateMeetingInput.parse(req.body)));
    priv.get<{ Params: { id: string } }>('/api/v1/meetings/:id', async (req) => meetings.getMeeting(req.userId, req.params.id));
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
    priv.get<{ Params: { id: string } }>('/api/v1/events/:id/comments', async (req) => cal.listEventComments(req.userId, z.uuid().parse(req.params.id)));
    priv.post<{ Params: { id: string } }>('/api/v1/events/:id/comments', async (req, reply) =>
      reply.status(201).send(await cal.commentEvent(req.userId, z.uuid().parse(req.params.id), EventCommentInput.parse(req.body).body)));
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
      // Los asuntos personales (conversationId null) solo van a clientes que los entienden.
      issues: await issues.listIssues(req.userId, { workspaceId: req.query.workspaceId, conversationId: req.query.conversationId, mine: req.query.mine === '1', open: req.query.open === '1',
        personal: String(req.headers['x-tiecoms-contract'] ?? '') >= '2026-09-28' }),
    }));
    priv.post('/api/v1/issues', async (req) => issues.createPersonalIssue(req.userId, CreatePersonalIssueInput.parse(req.body)));
    priv.post<{ Params: { id: string } }>('/api/v1/conversations/:id/issues', async (req) => issues.createIssue(req.userId, req.params.id, CreateIssueInput.parse(req.body)));
    priv.get<{ Params: { id: string } }>('/api/v1/issues/:id', async (req) => issues.getIssue(req.userId, req.params.id));
    priv.patch<{ Params: { id: string } }>('/api/v1/issues/:id', async (req) => issues.updateIssue(req.userId, req.params.id, UpdateIssueInput.parse(req.body)));
    priv.post<{ Params: { id: string } }>('/api/v1/issues/:id/children', async (req) => issues.createChildIssue(req.userId, req.params.id, CreateChildIssueInput.parse(req.body)));
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

    // Admins de grupo (como WhatsApp).
    priv.put<{ Params: { id: string; userId: string } }>('/api/v1/conversations/:id/members/:userId/admin', async (req) =>
      ws.setMemberAdmin(req.userId, z.uuid().parse(req.params.id), z.uuid().parse(req.params.userId), SetAdminInput.parse(req.body).admin));
    // Integraciones del grupo (las configura quien administra el espacio o la empresa).
    priv.get<{ Params: { id: string } }>('/api/v1/conversations/:id/integrations', async (req) => integrations.listIntegrations(req.userId, z.uuid().parse(req.params.id)));
    priv.post<{ Params: { id: string } }>('/api/v1/conversations/:id/integrations', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) =>
      integrations.createIntegration(req.userId, z.uuid().parse(req.params.id), CreateIntegrationInput.parse(req.body)));
    priv.patch<{ Params: { id: string } }>('/api/v1/integrations/:id', async (req) => integrations.updateIntegration(req.userId, z.uuid().parse(req.params.id), UpdateIntegrationInput.parse(req.body)));
    priv.post<{ Params: { id: string } }>('/api/v1/integrations/:id/rotate', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) =>
      integrations.rotateToken(req.userId, z.uuid().parse(req.params.id)));
    priv.delete<{ Params: { id: string } }>('/api/v1/integrations/:id', async (req) => integrations.revokeIntegration(req.userId, z.uuid().parse(req.params.id)));

    priv.delete<{ Params: { id: string; userId: string } }>('/api/v1/conversations/:id/members/:userId', async (req) => {
      await ws.removeMember(req.userId, req.params.id, req.params.userId);
      return { ok: true };
    });
  });

  // Foto de perfil: el id cambia en cada subida, así que se puede cachear para siempre.
  // En memoria (LRU 200 / 20 MB): cada foto iba a S3 en cada petición (p50 ≈ 96 ms).
  app.get<{ Params: { id: string } }>('/api/v1/avatars/:id', async (req, reply) => {
    const id = z.uuid().parse(req.params.id);
    const f = await imageCache.through(`a:${id}`, () => profile.readAvatar(id));
    return reply.header('content-type', f.contentType).header('cache-control', 'public, max-age=31536000, immutable').send(f.body);
  });

  // Miniatura de una vista previa de enlace (guardada en S3 por el worker).
  app.get<{ Params: { id: string } }>('/api/v1/previews/:id', async (req, reply) => {
    const id = z.uuid().parse(req.params.id);
    const f = await imageCache.through(`p:${id}`, async () => {
      const key = await readPreviewImage(id);
      return key ? getObject(key) : { body: Buffer.alloc(0), contentType: '' };
    });
    if (!f.body.length) return reply.status(404).send({ error: { code: 'not_found', message: 'No encontrada' } });
    return reply.header('content-type', f.contentType).header('cache-control', 'public, max-age=31536000, immutable').send(f.body);
  });

  app.get<{ Params: { token: string } }>('/api/v1/org-invitations/:token', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => auth.previewOrgInvitation(req.params.token));

  // Vista previa pública de invitación (requiere el token; no expone datos del espacio más allá del nombre).
  app.get<{ Params: { token: string } }>('/api/v1/invitations/:token', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => ws.previewInvitation(req.params.token));

  return app;
}
