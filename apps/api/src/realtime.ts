import type { Server as HttpServer } from 'node:http';
import pg from 'pg';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/postgres-adapter';
import { SOCKET_EVENTS, SendMessageInput } from '@tiecoms/contracts';
import { config, pgSsl } from './config.ts';
import { pool } from './db.ts';
import { ApiError } from './errors.ts';
import { sessionActive } from './modules/auth.ts';
import { sendMessage } from './modules/messages.ts';
import { verifyAccess } from './security.ts';

const BATCH = 200;

export function createRealtime(httpServer: HttpServer) {
  const io = new Server(httpServer, {
    path: '/api/socket.io',
    // WebSocket primero; long-polling como respaldo para redes corporativas.
    transports: ['websocket', 'polling'],
    cors: { origin: [config.publicOrigin, ...config.extraOrigins], credentials: true },
    pingInterval: 20_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 64 * 1024,
  });
  // Reparte emisiones entre nodos vía PostgreSQL: escalar a N instancias no requiere Redis.
  // Pool propio y pequeño: el LISTEN del adaptador nunca compite con las peticiones.
  const adapterPool = new pg.Pool({ connectionString: config.databaseUrl, ssl: pgSsl(), max: 2, application_name: 'tiecoms-sio-adapter' });
  adapterPool.on('error', (e) => console.error('[sio-adapter] pool', e.message));
  io.adapter(createAdapter(adapterPool, { tableName: 'socket_io_attachments', channelPrefix: 'tiecoms_sio', errorHandler: (e) => console.error('[sio-adapter]', e.message) }));

  io.use(async (socket, next) => {
    try {
      const token = String(socket.handshake.auth?.token ?? '');
      const claims = await verifyAccess(token);
      if (!(await sessionActive(claims.sid))) return next(new Error('unauthorized'));
      socket.data.userId = claims.sub;
      socket.data.sessionId = claims.sid;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', async (socket) => {
    const userId: string = socket.data.userId;
    socket.join([`user:${userId}`, `session:${socket.data.sessionId}`]);
    // Reautoriza al conectar: nunca restaura salas antiguas sin comprobar acceso.
    let rows: { conversation_id: string }[];
    try {
      ({ rows } = await pool.query(
      `SELECT m.conversation_id FROM conversation_memberships m JOIN conversations c ON c.id = m.conversation_id
         LEFT JOIN workspace_memberships wm ON wm.workspace_id = c.workspace_id AND wm.user_id = m.user_id
        WHERE m.user_id = $1 AND m.removed_at IS NULL AND c.archived_at IS NULL
          AND (c.workspace_id IS NULL OR (wm.revoked_at IS NULL AND (wm.expires_at IS NULL OR wm.expires_at > now())))`,
      [userId],
      ));
    } catch (e: any) {
      console.error('[socket] no pude cargar salas', e.message);
      socket.disconnect(true);
      return;
    }
    socket.join(rows.map((r) => `conv:${r.conversation_id}`));
    socket.emit('ready', { rooms: rows.length });

    socket.on(SOCKET_EVENTS.send, async (raw: unknown, ack?: (r: unknown) => void) => {
      try {
        const { conversationId, ...rest } = (raw ?? {}) as { conversationId: string };
        const input = SendMessageInput.parse(rest);
        const out = await sendMessage(userId, String(conversationId), input);
        ack?.({ ok: true, message: out.message, duplicate: out.duplicate });
      } catch (e: any) {
        const code = e instanceof ApiError ? e.code : e?.name === 'ZodError' ? 'bad_request' : 'internal';
        ack?.({ ok: false, error: { code, message: e instanceof ApiError ? e.message : 'No se pudo enviar' } });
      }
    });

    let lastTyping = 0;
    socket.on(SOCKET_EVENTS.typing, (raw: { conversationId?: string }) => {
      const room = `conv:${raw?.conversationId}`;
      const now = Date.now();
      // Efímero: se descarta bajo presión y nunca se persiste.
      if (!socket.rooms.has(room) || now - lastTyping < 2000) return;
      lastTyping = now;
      socket.volatile.to(room).emit(SOCKET_EVENTS.typing, { conversationId: raw.conversationId, userId });
    });
  });

  // ---------- Despachador del outbox ----------
  async function publish(topic: string, p: any) {
    switch (topic) {
      case 'conv.event':
        io.to(`conv:${p.conversationId}`).emit(SOCKET_EVENTS.conversationEvent, p);
        break;
      case 'account.event':
        io.to((p.userIds as string[]).map((u) => `user:${u}`)).emit(SOCKET_EVENTS.accountEvent, p.event);
        break;
      case 'rooms.join':
        io.in((p.userIds as string[]).map((u) => `user:${u}`)).socketsJoin(`conv:${p.conversationId}`);
        break;
      case 'rooms.leave':
        io.in((p.userIds as string[]).map((u) => `user:${u}`)).socketsLeave(`conv:${p.conversationId}`);
        break;
      case 'session.revoke':
        io.in(`session:${p.sessionId}`).disconnectSockets(true);
        break;
      default:
        console.warn('[outbox] tópico desconocido', topic);
    }
  }

  async function batch(): Promise<number> {
    let c: pg.PoolClient | null = null;
    try {
      c = await pool.connect();
      await c.query('BEGIN');
      // SKIP LOCKED: varias instancias del API pueden despachar sin pisarse.
      const { rows } = await c.query(
        'SELECT id, topic, payload FROM outbox WHERE dispatched_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED',
        [BATCH],
      );
      for (const r of rows) await publish(r.topic, r.payload);
      if (rows.length) await c.query('UPDATE outbox SET dispatched_at = now(), attempts = attempts + 1 WHERE id = ANY($1)', [rows.map((r) => r.id)]);
      await c.query('COMMIT');
      return rows.length;
    } catch (e: any) {
      await c?.query('ROLLBACK').catch(() => {});
      console.error('[outbox] fallo al despachar', e.message);
      return 0;
    } finally {
      c?.release();
    }
  }

  let running = false;
  let again = false;
  async function drain() {
    if (running) { again = true; return; }
    running = true;
    try {
      do { again = false; if ((await batch()) === BATCH) again = true; } while (again);
    } finally { running = false; }
  }

  let listener: pg.Client | null = null;
  let stopped = false;
  async function listen() {
    if (stopped) return;
    listener = new pg.Client({ connectionString: config.databaseUrl, ssl: pgSsl(), application_name: 'tiecoms-outbox-listen' });
    listener.on('notification', () => void drain());
    listener.on('error', (e) => {
      console.error('[outbox] LISTEN perdió conexión', e.message);
      listener?.end().catch(() => {});
      setTimeout(listen, 2000);
    });
    try {
      await listener.connect();
      await listener.query('LISTEN tiecoms_outbox');
      void drain();
    } catch (e: any) {
      console.error('[outbox] no pude escuchar', e.message);
      setTimeout(listen, 2000);
    }
  }
  void listen();
  // Barrido de respaldo: NOTIFY es solo un despertador.
  const sweep = setInterval(() => void drain(), 2000);

  return {
    io,
    async close() {
      stopped = true;
      clearInterval(sweep);
      await listener?.end().catch(() => {});
      await new Promise<void>((r) => io.close(() => r()));
      await adapterPool.end().catch(() => {});
    },
  };
}
