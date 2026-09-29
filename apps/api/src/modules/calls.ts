/**
 * Llamadas de voz y video dentro de una conversación, con Amazon Chime SDK (docs/LLAMADAS.md).
 * - Una llamada activa por conversación. Quien toca «Llamar» la crea; los demás entran a la misma.
 * - La reunión de Chime se crea con ClientRequestToken = id de la llamada: dos personas que llaman a la vez
 *   terminan en la misma reunión. Nunca hay llamadas de red dentro de una transacción.
 * - Presencia por latido (cada 30 s). El worker saca a quien dejó de latir y cierra la llamada vacía.
 * - Transcripción que se prende y apaga durante la llamada. Por defecto con Groq Whisper: cada cliente manda
 *   pedazos de su micrófono (addAudio). Con CALLS_STT=chime, Amazon Transcribe dentro de Chime (addSegments).
 * Costos (28-sep-2026): Chime US$0.0017 por persona-minuto; Groq ≈ US$0.04 por hora de audio con voz.
 * CALLS_PROVIDER=fake usa un proveedor en memoria (pruebas y desarrollo sin AWS).
 */
import { randomUUID } from 'node:crypto';
import {
  ChimeSDKMeetingsClient, CreateAttendeeCommand, CreateMeetingCommand, DeleteMeetingCommand, GetMeetingCommand,
  StartMeetingTranscriptionCommand, StopMeetingTranscriptionCommand,
} from '@aws-sdk/client-chime-sdk-meetings';
import type { ActiveCallDTO, CallDTO, CallHistoryItemDTO, CallJoinDTO, CallKind, CallTranscriptDTO, CallTranscriptSegmentDTO } from '@tiecoms/contracts';
import { LEGACY_DEVICE_KEY, callUserId } from '@tiecoms/contracts';
import type { z } from 'zod';
import type { CallTranscriptInput } from '@tiecoms/contracts';
import { conversationAccess } from '../access.ts';
import { pool, tx, type Db, type Tx, enqueueOutbox } from '../db.ts';
import { ApiError, badRequest, notFound } from '../errors.ts';
import { appendEvent, appendMessage, sendMessage } from './messages.ts';
import { getSummarizer } from './voice-providers.ts';
import { reachable } from './workspaces.ts';
import { sttConfigured, transcribeChunk } from './call-stt.ts';

/** CALLS_STT=chime vuelve a Amazon Transcribe dentro de Chime; por defecto, Groq Whisper por pedazos. */
const chimeStt = () => process.env.CALLS_STT === 'chime';

const sys = (k: string, p: Record<string, unknown> = {}) => JSON.stringify({ k, ...p });
/** Sin latido en este tiempo, la persona salió de la llamada. */
const STALE_SECONDS = 75;

export const callsEnabled = () => process.env.CALLS_ENABLED === 'true';
function requireEnabled() {
  if (!callsEnabled()) throw new ApiError(503, 'calls_disabled', 'Las llamadas todavía no están activas');
}

// ---------- Proveedor ----------
interface Attendee { AttendeeId: string; ExternalUserId: string; JoinToken: string }
interface CallProvider {
  create(callId: string): Promise<{ externalId: string; mediaRegion: string; meeting: Record<string, unknown> }>;
  /** externalUserId = "{userId}#{deviceKey}" (1.7.1) o solo userId (clientes 1.7.0). */
  attendee(externalId: string, externalUserId: string): Promise<Attendee>;
  end(externalId: string): Promise<void>;
  transcription(externalId: string, on: boolean): Promise<void>;
}
/** La reunión ya no existe en el proveedor (Chime la cierra a los 5 minutos sin nadie). */
class MeetingGone extends Error {}

class ChimeProvider implements CallProvider {
  private client = new ChimeSDKMeetingsClient({ region: process.env.CHIME_CONTROL_REGION ?? 'us-east-1' });
  private mediaRegion = process.env.CHIME_MEDIA_REGION ?? 'us-east-1';
  async create(callId: string) {
    const out = await this.client.send(new CreateMeetingCommand({
      ClientRequestToken: callId, ExternalMeetingId: callId, MediaRegion: this.mediaRegion,
    }));
    const m = out.Meeting!;
    return { externalId: m.MeetingId!, mediaRegion: m.MediaRegion!, meeting: m as unknown as Record<string, unknown> };
  }
  async attendee(externalId: string, externalUserId: string) {
    try {
      const out = await this.client.send(new CreateAttendeeCommand({ MeetingId: externalId, ExternalUserId: externalUserId }));
      const a = out.Attendee!;
      return { AttendeeId: a.AttendeeId!, ExternalUserId: a.ExternalUserId!, JoinToken: a.JoinToken! };
    } catch (e: any) {
      if (e?.name === 'NotFoundException') throw new MeetingGone();
      throw e;
    }
  }
  async end(externalId: string) {
    try { await this.client.send(new DeleteMeetingCommand({ MeetingId: externalId })); }
    catch (e: any) { if (e?.name !== 'NotFoundException') throw e; }
  }
  async transcription(externalId: string, on: boolean) {
    try {
      if (on) {
        await this.client.send(new StartMeetingTranscriptionCommand({
          MeetingId: externalId,
          TranscriptionConfiguration: {
            EngineTranscribeSettings: {
              // Español o inglés, lo detecta Transcribe; se prefiere español (Colombia).
              IdentifyLanguage: true,
              LanguageOptions: process.env.CALLS_TRANSCRIBE_LANGUAGES ?? 'es-US,en-US',
              PreferredLanguage: (process.env.CALLS_TRANSCRIBE_PREFERRED ?? 'es-US') as any,
              Region: (process.env.CALLS_TRANSCRIBE_REGION ?? 'auto') as any,
            },
          },
        }));
      } else {
        await this.client.send(new StopMeetingTranscriptionCommand({ MeetingId: externalId }));
      }
    } catch (e: any) {
      if (e?.name === 'NotFoundException') throw new MeetingGone();
      throw e;
    }
  }
  /** Para diagnóstico: ¿la reunión sigue viva? */
  async exists(externalId: string) {
    try { await this.client.send(new GetMeetingCommand({ MeetingId: externalId })); return true; }
    catch (e: any) { if (e?.name === 'NotFoundException') return false; throw e; }
  }
}

/** Proveedor en memoria: mismas formas que Chime, sin red. */
class FakeProvider implements CallProvider {
  private meetings = new Map<string, { transcribing: boolean }>();
  async create(callId: string) {
    const externalId = `fake-${callId}`;
    this.meetings.set(externalId, { transcribing: false });
    return {
      externalId, mediaRegion: 'us-east-1',
      meeting: { MeetingId: externalId, ExternalMeetingId: callId, MediaRegion: 'us-east-1', MediaPlacement: { AudioHostUrl: 'fake.invalid:3478', SignalingUrl: 'wss://fake.invalid/control', TurnControlUrl: 'https://fake.invalid/turn' } },
    };
  }
  async attendee(externalId: string, externalUserId: string) {
    if (!this.meetings.has(externalId)) throw new MeetingGone();
    return { AttendeeId: `att-${randomUUID()}`, ExternalUserId: externalUserId, JoinToken: `tok-${randomUUID()}` };
  }
  async end(externalId: string) { this.meetings.delete(externalId); }
  async transcription(externalId: string, on: boolean) {
    const m = this.meetings.get(externalId);
    if (!m) throw new MeetingGone();
    m.transcribing = on;
  }
}

let provider: CallProvider | null = null;
const getProvider = () => (provider ??= process.env.CALLS_PROVIDER === 'fake' ? new FakeProvider() : new ChimeProvider());

// ---------- Dispositivos (1.7.1) ----------
/** Desde qué dispositivo llega la petición: la llave que manda el cliente (o 'legacy') y la sesión para su nombre. */
export interface CallDevice { key: string; sessionId: string }
export const deviceOf = (sessionId: string, key?: string | null): CallDevice => ({ key: key || LEGACY_DEVICE_KEY, sessionId });
const externalUserIdOf = (userId: string, key: string) => (key === LEGACY_DEVICE_KEY ? userId : `${userId}#${key}`);

// ---------- Lectura ----------
/** viewerId: agrega myDevices (solo sus dispositivos dentro de la llamada). */
async function callDTO(db: Db, id: string, viewerId?: string): Promise<CallDTO> {
  const { rows } = await db.query(
    `SELECT c.*,
            COALESCE((SELECT array_agg(x.user_id ORDER BY x.first) FROM (SELECT p.user_id, min(p.first_joined_at) AS first FROM call_participants p
                       WHERE p.call_id = c.id AND p.left_at IS NULL GROUP BY p.user_id) x), '{}') AS active,
            CASE WHEN $2::uuid IS NULL THEN NULL ELSE COALESCE((SELECT jsonb_agg(jsonb_build_object('deviceKey', p.device_key, 'platform', COALESCE(p.platform, 'web'), 'label', COALESCE(p.label, ''))
                       ORDER BY p.joined_at) FROM call_participants p WHERE p.call_id = c.id AND p.user_id = $2 AND p.left_at IS NULL), '[]'::jsonb) END AS my_devices,
            EXISTS (SELECT 1 FROM call_transcript_segments s WHERE s.call_id = c.id) AS has_transcript,
            ARRAY(SELECT i.user_id FROM call_invites i WHERE i.call_id = c.id ORDER BY i.created_at) AS invited,
            (SELECT jsonb_agg(jsonb_build_object('userId', g.user_id, 'at', to_char(g.rung_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                    'joined', EXISTS (SELECT 1 FROM call_participants p WHERE p.call_id = c.id AND p.user_id = g.user_id AND p.joined_at >= g.rung_at - interval '5 seconds'))
                    ORDER BY g.rung_at) FROM call_rings g WHERE g.call_id = c.id) AS rings,
            (SELECT jsonb_object_agg(u.id, u.name) FROM users u
              WHERE u.id IN (SELECT p.user_id FROM call_participants p WHERE p.call_id = c.id UNION SELECT i.user_id FROM call_invites i WHERE i.call_id = c.id
                             UNION SELECT g.user_id FROM call_rings g WHERE g.call_id = c.id)) AS names
       FROM calls c WHERE c.id = $1`,
    [id, viewerId ?? null],
  );
  const r = rows[0];
  if (!r) throw notFound('Llamada');
  return {
    id: r.id, conversationId: r.conversation_id, kind: r.kind, startedBy: r.started_by,
    startedAt: new Date(r.started_at).toISOString(), endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null,
    activeUserIds: r.active, transcribing: r.transcribing, hasTranscript: r.has_transcript,
    ...(r.invited?.length ? { invitedUserIds: r.invited } : {}), names: r.names ?? {},
    ...(r.rings?.length ? { invited: r.rings } : {}),
    ...(viewerId ? { myDevices: r.my_devices ?? [] } : {}),
  };
}

async function publish(c: Tx, conversationId: string, callId: string) {
  const call = await callDTO(c, callId);
  await appendEvent(c, conversationId, { type: 'call.updated', conversationId, call });
  // Los agregados que no están en el chat no escuchan la conversación: les llega por su cuenta.
  if (call.invitedUserIds?.length) await enqueueOutbox(c, 'account.event', { userIds: call.invitedUserIds, event: { type: 'call.updated', call } });
  // 1.7.1: a quien estuvo alguna vez en la llamada, por su cuenta, la misma llamada con SUS dispositivos (myDevices).
  const { rows } = await c.query('SELECT DISTINCT user_id FROM call_participants WHERE call_id = $1', [callId]);
  for (const r of rows) {
    await enqueueOutbox(c, 'account.event', { userIds: [r.user_id], event: { type: 'call.updated', call: await callDTO(c, callId, r.user_id) } });
  }
  return call;
}

/** GET /calls/active: llamadas sin terminar de mis conversaciones y a las que me agregaron, con su título. */
export async function activeCalls(userId: string): Promise<{ calls: ActiveCallDTO[] }> {
  const { rows } = await pool.query(
    `SELECT c.id, cv.name AS title FROM calls c JOIN conversations cv ON cv.id = c.conversation_id AND cv.archived_at IS NULL
      WHERE c.ended_at IS NULL AND (
        EXISTS (SELECT 1 FROM conversation_memberships cm
                  LEFT JOIN workspace_memberships wm ON wm.workspace_id = cv.workspace_id AND wm.user_id = cm.user_id
                 WHERE cm.conversation_id = c.conversation_id AND cm.user_id = $1 AND cm.removed_at IS NULL
                   AND (cv.workspace_id IS NULL OR (wm.user_id IS NOT NULL AND wm.revoked_at IS NULL AND (wm.expires_at IS NULL OR wm.expires_at > now()))))
        OR EXISTS (SELECT 1 FROM call_invites i WHERE i.call_id = c.id AND i.user_id = $1))
      ORDER BY c.started_at DESC LIMIT 50`,
    [userId],
  );
  return { calls: await Promise.all(rows.map(async (r) => ({ call: await callDTO(pool, r.id, userId), title: r.title ?? null }))) };
}

/** Para el bootstrap: la llamada en la que estoy desde algún dispositivo (o null). */
export async function myActiveCall(userId: string): Promise<CallDTO | null> {
  if (!callsEnabled()) return null;
  const { rows } = await pool.query(
    `SELECT p.call_id FROM call_participants p JOIN calls c ON c.id = p.call_id AND c.ended_at IS NULL
      WHERE p.user_id = $1 AND p.left_at IS NULL ORDER BY p.joined_at DESC LIMIT 1`,
    [userId],
  );
  return rows[0] ? callDTO(pool, rows[0].call_id, userId) : null;
}

/** La llamada activa de la conversación, si hay (para pintar «Unirse»). */
export async function activeCall(userId: string, conversationId: string): Promise<CallDTO | null> {
  await conversationAccess(pool, userId, conversationId, 'read');
  const { rows } = await pool.query('SELECT id FROM calls WHERE conversation_id = $1 AND ended_at IS NULL', [conversationId]);
  return rows[0] ? callDTO(pool, rows[0].id) : null;
}

/**
 * Llamada de una conversación a la que tengo acceso. Para leer una terminada hace falta haber estado en ella
 * o que su mensaje caiga dentro de mi historial visible (quien entra después sin historial no la ve).
 */
async function callFor(db: Db, userId: string, callId: string, need: 'read' | 'post') {
  const { rows } = await db.query(
    `SELECT c.*, m.seq AS message_seq, EXISTS (SELECT 1 FROM call_participants p WHERE p.call_id = c.id AND p.user_id = $2) AS was_in
       FROM calls c LEFT JOIN messages m ON m.id = c.message_id WHERE c.id = $1`,
    [callId, userId],
  );
  const call = rows[0];
  if (!call) throw notFound('Llamada');
  let a;
  try { a = await conversationAccess(db, userId, call.conversation_id, need); }
  catch (e) {
    // Agregado a la llamada sin estar en el chat: acceso a esta llamada, no a la conversación.
    const inv = await db.query('SELECT 1 FROM call_invites WHERE call_id = $1 AND user_id = $2', [callId, userId]);
    if (inv.rowCount) return { ...call, invited: true };
    throw e;
  }
  if (!call.was_in && call.message_seq != null && Number(call.message_seq) <= a.historyFromSeq) throw notFound('Llamada');
  return call;
}

/** Historial: llamadas donde estuve o de conversaciones mías dentro de mi historial visible. */
export async function history(userId: string, q: { before?: string; limit: number }): Promise<{ calls: CallHistoryItemDTO[]; hasMore: boolean }> {
  const { rows } = await pool.query(
    `SELECT c.id, c.started_at,
            ARRAY(SELECT p.user_id FROM call_participants p WHERE p.call_id = c.id ORDER BY p.first_joined_at) AS participant_ids,
            CASE WHEN c.ended_at IS NOT NULL THEN extract(epoch FROM c.ended_at - c.started_at)::int END AS secs,
            c.summary IS NOT NULL AS has_summary
       FROM calls c
       LEFT JOIN conversation_memberships cm ON cm.conversation_id = c.conversation_id AND cm.user_id = $1 AND cm.removed_at IS NULL
       JOIN conversations cv ON cv.id = c.conversation_id AND cv.archived_at IS NULL
       LEFT JOIN messages m ON m.id = c.message_id
      WHERE ($2::timestamptz IS NULL OR c.started_at < $2)
        AND (EXISTS (SELECT 1 FROM call_participants p WHERE p.call_id = c.id AND p.user_id = $1)
             OR (cm.user_id IS NOT NULL AND (m.seq IS NULL OR m.seq > cm.history_from_seq)))
      ORDER BY c.started_at DESC LIMIT $3`,
    [userId, q.before ?? null, q.limit + 1],
  );
  const page = rows.slice(0, q.limit);
  const calls = await Promise.all(page.map(async (r) => ({
    call: await callDTO(pool, r.id), participantIds: r.participant_ids, durationSec: r.secs, hasSummary: r.has_summary,
  })));
  return { calls, hasMore: rows.length > q.limit };
}

// ---------- Empezar / entrar ----------
/** Empieza la llamada o entra a la que está en curso. Devuelve lo que el SDK necesita para conectarse. */
export async function startOrJoin(userId: string, conversationId: string, kind: CallKind, device: CallDevice = deviceOf('', null)): Promise<CallJoinDTO> {
  requireEnabled();
  for (let attempt = 0; attempt < 2; attempt++) {
    const { callId, created } = await tx(async (c) => {
      const a = await conversationAccess(c, userId, conversationId, 'post', true);
      if (!a.canPost) throw new ApiError(403, 'forbidden', 'No puedes llamar en esta conversación');
      const cur = await c.query('SELECT id FROM calls WHERE conversation_id = $1 AND ended_at IS NULL', [conversationId]);
      if (cur.rows[0]) return { callId: cur.rows[0].id as string, created: false };
      const ins = await c.query('INSERT INTO calls (conversation_id, started_by, kind) VALUES ($1,$2,$3) RETURNING id', [conversationId, userId, kind]);
      return { callId: ins.rows[0].id as string, created: true };
    });
    try {
      return await joinCall(userId, callId, created, device);
    } catch (e) {
      if (!(e instanceof MeetingGone)) throw e;
      // Chime ya cerró esa reunión: se da por terminada y se abre una nueva.
      await finish(callId);
    }
  }
  throw new ApiError(503, 'call_unavailable', 'No se pudo abrir la llamada, intenta de nuevo');
}

/** Entrar a una llamada concreta (desde el aviso de «te están llamando»). */
export async function join(userId: string, callId: string, device: CallDevice = deviceOf('', null)): Promise<CallJoinDTO> {
  requireEnabled();
  const call = await callFor(pool, userId, callId, 'post');
  if (call.ended_at) throw new ApiError(409, 'call_ended', 'La llamada ya terminó');
  try {
    return await joinCall(userId, callId, false, device);
  } catch (e) {
    if (!(e instanceof MeetingGone)) throw e;
    await finish(callId);
    return startOrJoin(userId, call.conversation_id, call.kind, device);
  }
}

async function joinCall(userId: string, callId: string, created: boolean, device: CallDevice): Promise<CallJoinDTO> {
  let row = (await pool.query('SELECT * FROM calls WHERE id = $1', [callId])).rows[0];
  if (!row.meeting) {
    // Idempotente en Chime (ClientRequestToken): si dos entran a la vez, ambos reciben la misma reunión.
    const m = await getProvider().create(callId);
    await pool.query('UPDATE calls SET external_id = $2, media_region = $3, meeting = $4 WHERE id = $1 AND meeting IS NULL',
      [callId, m.externalId, m.mediaRegion, JSON.stringify(m.meeting)]);
    row = (await pool.query('SELECT * FROM calls WHERE id = $1', [callId])).rows[0];
  }
  // Un attendee por dispositivo: la misma persona puede estar desde dos sin que Chime saque al primero.
  const attendee = await getProvider().attendee(row.external_id, externalUserIdOf(userId, device.key));
  const call = await tx(async (c) => {
    const ses = device.sessionId ? (await c.query('SELECT platform, device_name FROM sessions WHERE id = $1', [device.sessionId])).rows[0] : null;
    const platform = ses?.platform ?? 'web', label = ses?.device_name ?? '';
    await c.query(
      `INSERT INTO call_participants (call_id, user_id, attendee_id, device_key, platform, label) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (call_id, user_id, device_key) DO UPDATE SET attendee_id = $3, platform = $5, label = $6, joined_at = now(), last_seen_at = now(), left_at = NULL`,
      [callId, userId, attendee.AttendeeId, device.key, platform, label],
    );
    // Mis otros dispositivos dejan de sonar (ignoran el aviso si deviceKey es el suyo).
    await enqueueOutbox(c, 'account.event', { userIds: [userId], event: { type: 'call.answered', callId, conversationId: row.conversation_id, deviceKey: device.key, platform, label } });
    if (created) {
      const msg = await appendMessage(c, { conversationId: row.conversation_id, authorId: userId, kind: 'system', body: sys('call.started', { kind: row.kind, callId }) });
      await c.query('UPDATE calls SET message_id = $2 WHERE id = $1', [callId, msg.id]);
    }
    const dto = await publish(c, row.conversation_id, callId);
    if (created) await ring(c, dto, userId);
    return callDTO(c, callId, userId);
  });
  return { call, meeting: { Meeting: row.meeting }, attendee: { Attendee: attendee } };
}

/** Aviso «te están llamando» a los demás miembros (sin quien llama y sin quien tiene No molestar). */
async function ring(c: Tx, call: CallDTO, callerId: string) {
  const { rows } = await c.query(
    `SELECT m.user_id FROM conversation_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.conversation_id = $1 AND m.removed_at IS NULL AND m.user_id <> $2 AND u.disabled_at IS NULL
        AND (u.dnd_until IS NULL OR u.dnd_until <= now())`,
    [call.conversationId, callerId],
  );
  if (!rows.length) return;
  const info = (await c.query(
    'SELECT (SELECT name FROM users WHERE id = $2) AS caller, (SELECT name FROM conversations WHERE id = $1) AS title',
    [call.conversationId, callerId],
  )).rows[0];
  await ringUsers(c, call, rows.map((r) => r.user_id), info.caller ?? '', info.title ?? null);
}

/** Aviso en vivo (socket) y push de llamada entrante (para la app cerrada). */
async function ringUsers(c: Tx, call: CallDTO, userIds: string[], callerName: string, title: string | null, again = false) {
  if (!userIds.length) return;
  await enqueueOutbox(c, 'account.event', { userIds, event: { type: 'call.ringing', call, conversationTitle: title, callerName } });
  await c.query(
    "INSERT INTO jobs (kind, payload, max_attempts, dedupe_key) VALUES ('push.call', $1, 1, $2) ON CONFLICT (dedupe_key) DO NOTHING",
    [JSON.stringify({ callId: call.id, userIds, callerName, title }), `push-call:${call.id}:${again ? `${Date.now()}:` : ''}${userIds.slice().sort().join(',').slice(0, 160)}`],
  );
}

/**
 * Agregar personas a la llamada en curso. Quien agrega tiene que estar dentro; solo se suma a gente con la que
 * comparte empresa o espacio. A los que están en el chat solo les vuelve a sonar; a los demás se les da acceso
 * a esta llamada (call_invites), no a la conversación.
 */
export async function invite(userId: string, callId: string, userIds: string[]) {
  requireEnabled();
  const call = await callFor(pool, userId, callId, 'read');
  if (call.ended_at) throw new ApiError(409, 'call_ended', 'La llamada ya terminó');
  const inCall = await pool.query('SELECT 1 FROM call_participants WHERE call_id = $1 AND user_id = $2 AND left_at IS NULL', [callId, userId]);
  if (!inCall.rowCount) throw new ApiError(409, 'not_in_call', 'Entra a la llamada para agregar personas');
  const ids = [...new Set(userIds.filter((x) => x !== userId))];
  return tx(async (c) => {
    const ok = await reachable(c, userId, ids);
    if (ok.length !== ids.length) throw new ApiError(403, 'forbidden', 'Solo puedes agregar personas con las que compartes un espacio o tu empresa');
    const members = new Set((await c.query(
      'SELECT user_id FROM conversation_memberships WHERE conversation_id = $1 AND removed_at IS NULL AND user_id = ANY($2)', [call.conversation_id, ids],
    )).rows.map((r) => r.user_id));
    for (const id of ids) if (!members.has(id)) {
      await c.query('INSERT INTO call_invites (call_id, user_id, invited_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [callId, id, userId]);
    }
    // «Llamando…» / «No contestó» / «Volver a llamar»: volver a invitar renueva la hora y vuelve a sonar.
    for (const id of ids) {
      await c.query('INSERT INTO call_rings (call_id, user_id, rung_by) VALUES ($1,$2,$3) ON CONFLICT (call_id, user_id) DO UPDATE SET rung_at = now(), rung_by = $3', [callId, id, userId]);
    }
    const info = (await c.query('SELECT (SELECT name FROM users WHERE id = $2) AS caller, (SELECT name FROM conversations WHERE id = $1) AS title', [call.conversation_id, userId])).rows[0];
    const dto = await publish(c, call.conversation_id, callId);
    await ringUsers(c, dto, ids, info.caller ?? '', info.title ?? null, true);
    return { call: dto };
  });
}

// ---------- Latido / salir / terminar ----------
export async function heartbeat(userId: string, callId: string, deviceKey: string = LEGACY_DEVICE_KEY) {
  // Latido por dispositivo. Un cliente 1.7.0 ('legacy') mantiene vivas sus filas sin llave propia.
  const { rowCount } = await pool.query(
    `UPDATE call_participants p SET last_seen_at = now() FROM calls c
      WHERE p.call_id = $1 AND p.user_id = $2 AND p.device_key = $3 AND p.left_at IS NULL AND c.id = p.call_id AND c.ended_at IS NULL`,
    [callId, userId, deviceKey],
  );
  if (!rowCount) throw new ApiError(409, 'not_in_call', 'Ya no estás en esa llamada');
  return { ok: true };
}

/** Sale un dispositivo mío (el propio al colgar, u otro con «Pasar aquí»). Sin deviceKey: 'legacy' (clientes 1.7.0). */
export async function leave(userId: string, callId: string, deviceKey: string = LEGACY_DEVICE_KEY) {
  const call = await callFor(pool, userId, callId, 'read');
  const empty = await tx(async (c) => {
    const r = await c.query('UPDATE call_participants SET left_at = now() WHERE call_id = $1 AND user_id = $2 AND device_key = $3 AND left_at IS NULL', [callId, userId, deviceKey]);
    if (!r.rowCount || call.ended_at) return false;
    const left = await c.query('SELECT 1 FROM call_participants WHERE call_id = $1 AND left_at IS NULL LIMIT 1', [callId]);
    if (left.rowCount) { await publish(c, call.conversation_id, callId); return false; }
    return true;
  });
  if (empty) await finish(callId);
  return { call: await callDTO(pool, callId, userId) };
}

/** Rechazar en un dispositivo: todos los míos dejan de sonar. Para los demás no cambia nada. */
export async function decline(userId: string, callId: string) {
  const call = await callFor(pool, userId, callId, 'read');
  await tx((c) => enqueueOutbox(c, 'account.event', { userIds: [userId], event: { type: 'call.declined', callId, conversationId: call.conversation_id } }));
  return { ok: true };
}

/** Colgar para todos (cualquiera que pueda escribir en la conversación). */
export async function endForAll(userId: string, callId: string) {
  await callFor(pool, userId, callId, 'post');
  await finish(callId);
  return { call: await callDTO(pool, callId) };
}

/**
 * Cierra la llamada: borra la reunión en Chime (fuera de la transacción), marca el fin, deja el mensaje
 * con la duración y, si hubo transcripción, el mensaje para leerla (y el resumen en cola).
 */
async function finish(callId: string) {
  const row = (await pool.query('SELECT external_id, ended_at FROM calls WHERE id = $1', [callId])).rows[0];
  if (!row || row.ended_at) return;
  if (row.external_id) await getProvider().end(row.external_id).catch((e) => console.warn('[calls] no pude cerrar la reunión', e?.message));
  await tx(async (c) => {
    const r = await c.query(
      `UPDATE calls SET ended_at = now(), transcription_stopped_at = CASE WHEN transcribing THEN now() ELSE transcription_stopped_at END, transcribing = false WHERE id = $1 AND ended_at IS NULL
       RETURNING conversation_id, started_by, ai_summary, extract(epoch FROM now() - started_at)::int AS secs`,
      [callId],
    );
    const call = r.rows[0];
    if (!call) return;
    await c.query('UPDATE call_participants SET left_at = now() WHERE call_id = $1 AND left_at IS NULL', [callId]);
    await appendMessage(c, { conversationId: call.conversation_id, authorId: call.started_by, kind: 'system', body: sys('call.ended', { callId, durationSec: call.secs }) });
    const seg = await c.query('SELECT 1 FROM call_transcript_segments WHERE call_id = $1 LIMIT 1', [callId]);
    if (seg.rowCount) {
      const m = await appendMessage(c, { conversationId: call.conversation_id, authorId: call.started_by, kind: 'system', body: sys('call.transcript', { callId }) });
      await c.query('UPDATE calls SET transcript_message_id = $2 WHERE id = $1', [callId, m.id]);
      if (call.ai_summary) await c.query("INSERT INTO jobs (kind, payload, max_attempts, dedupe_key) VALUES ('call.summary', $1, 3, $2) ON CONFLICT (dedupe_key) DO NOTHING", [JSON.stringify({ callId }), `call-summary:${callId}`]);
    }
    await publish(c, call.conversation_id, callId);
  });
}

/** Worker: saca a quien dejó de latir y cierra las llamadas que quedaron vacías. */
export async function reapCalls(): Promise<number> {
  const stale = await pool.query(
    `UPDATE call_participants p SET left_at = now() FROM calls c
      WHERE c.id = p.call_id AND c.ended_at IS NULL AND p.left_at IS NULL AND p.last_seen_at < now() - make_interval(secs => $1)
      RETURNING c.id, c.conversation_id`,
    [STALE_SECONDS],
  );
  const empty = await pool.query(
    `SELECT c.id FROM calls c WHERE c.ended_at IS NULL AND c.started_at < now() - interval '1 minute'
        AND NOT EXISTS (SELECT 1 FROM call_participants p WHERE p.call_id = c.id AND p.left_at IS NULL)`,
  );
  const ended = new Set(empty.rows.map((r) => r.id));
  for (const id of ended) await finish(id);
  // Los que siguen con gente pero perdieron a alguien: avisar quién quedó.
  const touched = new Map(stale.rows.filter((r) => !ended.has(r.id)).map((r) => [r.id, r.conversation_id]));
  for (const [id, conv] of touched) await tx((c) => publish(c, conv, id));
  return ended.size + touched.size;
}

// ---------- Transcripción ----------
export async function setTranscription(userId: string, callId: string, on: boolean, aiSummary = false) {
  requireEnabled();
  const call = await callFor(pool, userId, callId, 'post');
  if (call.ended_at) throw new ApiError(409, 'call_ended', 'La llamada ya terminó');
  const inCall = await pool.query('SELECT 1 FROM call_participants WHERE call_id = $1 AND user_id = $2 AND left_at IS NULL', [callId, userId]);
  if (!inCall.rowCount) throw new ApiError(409, 'not_in_call', 'Entra a la llamada para cambiar la transcripción');
  if (call.transcribing === on) return { call: await callDTO(pool, callId) };
  if (on && !chimeStt() && !sttConfigured()) throw new ApiError(503, 'transcription_unavailable', 'La transcripción todavía no está configurada');
  // Con Groq (por defecto) cada cliente graba y manda su micrófono: aquí solo cambia el estado.
  if (chimeStt()) try {
    await getProvider().transcription(call.external_id, on);
  } catch (e) {
    if (e instanceof MeetingGone) { await finish(callId); throw new ApiError(409, 'call_ended', 'La llamada ya terminó'); }
    console.warn('[calls] transcripción', (e as any)?.name, (e as any)?.message);
    throw new ApiError(502, 'transcription_failed', on ? 'No se pudo iniciar la transcripción' : 'No se pudo detener la transcripción');
  }
  const dto = await tx(async (c) => {
    await c.query(`UPDATE calls SET transcribing = $2, ai_summary = ai_summary OR $3, transcription_stopped_at = CASE WHEN $2 THEN NULL ELSE now() END WHERE id = $1`, [callId, on, on && aiSummary]);
    const name = (await c.query('SELECT name FROM users WHERE id = $1', [userId])).rows[0]?.name ?? '';
    // Queda en el chat quién la prendió o la apagó: todos saben que se está transcribiendo.
    await appendMessage(c, { conversationId: call.conversation_id, authorId: userId, kind: 'system', body: sys(on ? 'call.transcription.on' : 'call.transcription.off', { name, callId }) });
    return publish(c, call.conversation_id, callId);
  });
  return { call: dto };
}

/** Frases finales que reportan los clientes. Solo quien está en la llamada y con la transcripción prendida. */
export async function addSegments(userId: string, callId: string, input: z.infer<typeof CallTranscriptInput>) {
  const call = await callFor(pool, userId, callId, 'post');
  const ok = await pool.query('SELECT 1 FROM call_participants WHERE call_id = $1 AND user_id = $2 AND left_at IS NULL', [callId, userId]);
  // Se acepta un margen tras apagar o colgar: las últimas frases llegan unos segundos después.
  const late = call.ended_at ? Date.now() - new Date(call.ended_at).getTime() < 30_000 : false;
  if (!ok.rowCount && !late) throw new ApiError(409, 'not_in_call', 'No estás en esa llamada');
  const justStopped = call.transcription_stopped_at && Date.now() - new Date(call.transcription_stopped_at).getTime() < 30_000;
  if (!call.transcribing && !late && !justStopped) throw badRequest('La transcripción está apagada');
  // externalUserId del SDK es el id de la persona (así se creó el attendee); se valida contra quienes entraron.
  const people = await pool.query(
    'SELECT p.user_id, p.attendee_id, u.name FROM call_participants p JOIN users u ON u.id = p.user_id WHERE p.call_id = $1',
    [callId],
  );
  const byUser = new Map(people.rows.map((r) => [r.user_id, r.name]));
  const byAttendee = new Map(people.rows.map((r) => [r.attendee_id, r.user_id]));
  let saved = 0;
  for (const s of input.segments) {
    const ext = s.externalUserId ? callUserId(s.externalUserId) : null;
    const speaker = (ext && byUser.has(ext) ? ext : s.attendeeId ? byAttendee.get(s.attendeeId) : null) ?? null;
    const r = await pool.query(
      `INSERT INTO call_transcript_segments (call_id, result_id, speaker_user_id, speaker_name, language, body, start_ms, end_ms, reported_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (call_id, result_id) DO NOTHING`,
      [callId, s.resultId, speaker, speaker ? byUser.get(speaker) : null, s.language ?? null, s.text, s.startMs, Math.max(s.endMs, s.startMs), userId],
    );
    saved += r.rowCount ?? 0;
  }
  // Frases que llegaron después de colgar y la llamada aún no tenía el mensaje de la transcripción.
  if (saved && call.ended_at && !call.transcript_message_id) {
    await tx(async (c) => {
      const cur = await c.query('SELECT transcript_message_id, started_by FROM calls WHERE id = $1 FOR UPDATE', [callId]);
      if (cur.rows[0].transcript_message_id) return;
      const m = await appendMessage(c, { conversationId: call.conversation_id, authorId: cur.rows[0].started_by, kind: 'system', body: sys('call.transcript', { callId }) });
      await c.query('UPDATE calls SET transcript_message_id = $2 WHERE id = $1', [callId, m.id]);
      if (call.ai_summary) await c.query("INSERT INTO jobs (kind, payload, max_attempts, dedupe_key) VALUES ('call.summary', $1, 3, $2) ON CONFLICT (dedupe_key) DO NOTHING", [JSON.stringify({ callId }), `call-summary:${callId}`]);
      await publish(c, call.conversation_id, callId);
    });
  }
  return { saved };
}

export async function transcript(userId: string, callId: string): Promise<CallTranscriptDTO> {
  const call = await callFor(pool, userId, callId, 'read');
  const { rows } = await pool.query(
    'SELECT * FROM call_transcript_segments WHERE call_id = $1 ORDER BY start_ms, created_at',
    [callId],
  );
  return {
    call: await callDTO(pool, callId),
    summary: call.summary ?? null,
    segments: rows.map((r) => ({
      resultId: r.result_id, speakerUserId: r.speaker_user_id, speakerName: r.speaker_name, language: r.language,
      text: r.body, startMs: Number(r.start_ms), endMs: Number(r.end_ms),
    })),
  };
}

/** Límite de un pedazo de audio de llamada (≈ 20 s de opus/aac pesan 40–120 KB). */
export const MAX_CALL_AUDIO_BYTES = 3 * 1024 * 1024;

async function activeParticipantIds(callId: string) {
  const { rows } = await pool.query('SELECT user_id FROM call_participants WHERE call_id = $1 AND left_at IS NULL', [callId]);
  return rows.map((r) => r.user_id as string);
}

/**
 * Un pedazo del micrófono de quien lo manda (docs/LLAMADAS.md › Transcripción): avisa «Procesando…» a la llamada,
 * lo transcribe con Groq, guarda las frases (speaker = quien lo mandó) y se las envía a quienes están dentro.
 * segId lo genera el cliente: reintentar el mismo pedazo no duplica frases.
 */
export async function addAudio(userId: string, callId: string, input: { body: Buffer; type: string; offsetMs: number; durationMs: number; segId: string }) {
  requireEnabled();
  const call = await callFor(pool, userId, callId, 'post');
  const inCall = await pool.query('SELECT 1 FROM call_participants WHERE call_id = $1 AND user_id = $2 AND left_at IS NULL', [callId, userId]);
  const late = call.ended_at ? Date.now() - new Date(call.ended_at).getTime() < 60_000 : false;
  if (!inCall.rowCount && !late) throw new ApiError(409, 'not_in_call', 'No estás en esa llamada');
  const justStopped = call.transcription_stopped_at && Date.now() - new Date(call.transcription_stopped_at).getTime() < 60_000;
  if (!call.transcribing && !late && !justStopped) throw badRequest('La transcripción está apagada');
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(input.segId)) throw badRequest('segId inválido');
  if (!/^audio\/(webm|ogg|mp4|m4a|x-m4a|aac|mpeg|wav)/.test(input.type)) throw badRequest('Formato de audio no soportado');
  if (!input.body.length || input.body.length > MAX_CALL_AUDIO_BYTES) throw badRequest('Pedazo de audio vacío o muy grande');
  const done = await pool.query('SELECT 1 FROM call_transcript_segments WHERE call_id = $1 AND result_id LIKE $2 LIMIT 1', [callId, `${input.segId}:%`]);
  if (done.rowCount) return { saved: 0, segments: [] };
  const me = (await pool.query('SELECT name FROM users WHERE id = $1', [userId])).rows[0]?.name ?? '';
  const people = await activeParticipantIds(callId);
  await tx((c) => enqueueOutbox(c, 'account.event', { userIds: people, event: { type: 'call.processing', callId, userId, segId: input.segId } }));
  // Pista de ortografía: nombres de la gente en la llamada y del chat.
  const names = (await pool.query(
    `SELECT string_agg(DISTINCT u.name, ', ') AS n FROM call_participants p JOIN users u ON u.id = p.user_id WHERE p.call_id = $1`, [callId],
  )).rows[0]?.n ?? '';
  const title = (await pool.query('SELECT name FROM conversations WHERE id = $1', [call.conversation_id])).rows[0]?.name ?? '';
  let result;
  try {
    result = await transcribeChunk(input.body, input.type, [process.env.CALLS_STT_VOCAB ?? 'Xertify, chaggu', names, title].filter(Boolean).join('. '));
  } catch (e: any) {
    console.warn('[calls] stt', e?.message);
    await tx((c) => enqueueOutbox(c, 'account.event', { userIds: people, event: { type: 'call.transcript', callId, segId: input.segId, userId, segments: [], failed: true } }));
    throw new ApiError(502, 'transcription_failed', 'No se pudo transcribir ese pedazo');
  }
  const saved: CallTranscriptSegmentDTO[] = [];
  for (const [i, sg] of result.segments.entries()) {
    const startMs = Math.max(0, Math.round(input.offsetMs + sg.start * 1000));
    const endMs = Math.max(startMs, Math.round(input.offsetMs + Math.min(sg.end * 1000, input.durationMs || sg.end * 1000)));
    const r = await pool.query(
      `INSERT INTO call_transcript_segments (call_id, result_id, speaker_user_id, speaker_name, language, body, start_ms, end_ms, reported_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$3) ON CONFLICT (call_id, result_id) DO NOTHING`,
      [callId, `${input.segId}:${i}`, userId, me, result.language, sg.text.slice(0, 4000), startMs, endMs],
    );
    if (r.rowCount) saved.push({ resultId: `${input.segId}:${i}`, speakerUserId: userId, speakerName: me, language: result.language, text: sg.text, startMs, endMs });
  }
  await tx(async (c) => {
    await enqueueOutbox(c, 'account.event', { userIds: people, event: { type: 'call.transcript', callId, segId: input.segId, userId, segments: saved } });
    // Llegó después de colgar y la llamada aún no tenía el mensaje «Ver transcripción».
    if (saved.length && call.ended_at) {
      const cur = await c.query('SELECT transcript_message_id, started_by FROM calls WHERE id = $1 FOR UPDATE', [callId]);
      if (!cur.rows[0].transcript_message_id) {
        const m = await appendMessage(c, { conversationId: call.conversation_id, authorId: cur.rows[0].started_by, kind: 'system', body: sys('call.transcript', { callId }) });
        await c.query('UPDATE calls SET transcript_message_id = $2 WHERE id = $1', [callId, m.id]);
        if (call.ai_summary) await c.query("INSERT INTO jobs (kind, payload, max_attempts, dedupe_key) VALUES ('call.summary', $1, 3, $2) ON CONFLICT (dedupe_key) DO NOTHING", [JSON.stringify({ callId }), `call-summary:${callId}`]);
        await publish(c, call.conversation_id, callId);
      }
    }
  });
  return { saved: saved.length, segments: saved };
}

/**
 * Compartir en otra conversación: sale como mensaje mío (texto), así queda claro quién lo llevó y a dónde.
 * Necesito poder leer la llamada y escribir en el destino. Una transcripción larga se corta al límite del mensaje.
 */
export async function share(userId: string, callId: string, input: { conversationId: string; what: 'summary' | 'transcript' | 'both' }) {
  const call = await callFor(pool, userId, callId, 'read');
  const t = await transcript(userId, callId);
  const when = new Date(call.started_at).toISOString().slice(0, 16).replace('T', ' ');
  const title = (await pool.query('SELECT name FROM conversations WHERE id = $1', [call.conversation_id])).rows[0]?.name;
  const parts = [`📞 Llamada${title ? ` en ${title}` : ''} · ${when} UTC`];
  if (input.what !== 'transcript') {
    if (!t.summary && input.what === 'summary') throw badRequest('Esa llamada no tiene resumen');
    if (t.summary) parts.push(`Resumen:\n${t.summary}`);
  }
  if (input.what !== 'summary') {
    if (!t.segments.length) throw badRequest('Esa llamada no tiene transcripción');
    const stamp = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
    parts.push(`Transcripción:\n${t.segments.map((s) => `[${stamp(s.startMs)}] ${s.speakerName ?? '?'}: ${s.text}`).join('\n')}`);
  }
  let body = parts.join('\n\n');
  const MAX = 8000;
  if (body.length > MAX) body = `${body.slice(0, MAX - 60).trimEnd()}\n… (transcripción completa en la llamada original)`;
  const { message } = await sendMessage(userId, input.conversationId, { clientMessageId: `call-share-${callId.slice(0, 8)}-${randomUUID().slice(0, 12)}`, body });
  return { message };
}

/** Worker: resumen de la transcripción con DeepSeek (solo si quien la prendió lo autorizó). */
export async function summarizeCall(callId: string) {
  const s = getSummarizer();
  if (!s?.complete) return;
  const call = (await pool.query('SELECT conversation_id, summary FROM calls WHERE id = $1', [callId])).rows[0];
  if (!call || call.summary) return;
  const { rows } = await pool.query('SELECT speaker_name, body FROM call_transcript_segments WHERE call_id = $1 ORDER BY start_ms', [callId]);
  if (!rows.length) return;
  const text = rows.map((r) => `${r.speaker_name ?? '?'}: ${r.body}`).join('\n').slice(-60_000);
  const out = await s.complete(
    'Resumes llamadas de trabajo en el idioma de la conversación. Responde JSON {"summary": "..."}: 3 a 8 viñetas con decisiones, pendientes (con responsable si se dijo) y fechas. Sin inventar nada que no esté en la transcripción.',
    text,
  );
  let summary: string | null = null;
  try { summary = String(JSON.parse(out).summary ?? '').trim() || null; } catch { summary = null; }
  if (!summary) return;
  await tx(async (c) => {
    await c.query('UPDATE calls SET summary = $2 WHERE id = $1', [callId, summary.slice(0, 8000)]);
    await publish(c, call.conversation_id, callId);
  });
}

/** Solo pruebas: reemplaza el proveedor. */
export function setCallProvider(p: CallProvider | null) { provider = p; }
