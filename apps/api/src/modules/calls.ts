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
import type { ActiveCallDTO, CallDTO, CallHistoryItemDTO, CallJoinDTO, CallKind, CallLinkDTO, CallTranscriptDTO, CallTranscriptSegmentDTO, GuestCallPreviewDTO, GuestCallStateDTO, GuestJoinDTO, InstantCallDTO } from '@tiecoms/contracts';
import { EMAIL_SHAPE, LEGACY_DEVICE_KEY, callUserId, guestExternalId } from '@tiecoms/contracts';
import type { z } from 'zod';
import type { CallTranscriptInput } from '@tiecoms/contracts';
import { conversationAccess } from '../access.ts';
import { config } from '../config.ts';
import { randomToken, sha256 } from '../security.ts';
import { pool, tx, type Db, type Tx, enqueueOutbox } from '../db.ts';
import { ApiError, badRequest, notFound } from '../errors.ts';
import { appendEvent, appendMessage, sendMessage } from './messages.ts';
import { getSummarizer } from './voice-providers.ts';
import { reachable, scopeChanged } from './workspaces.ts';
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
/**
 * «Nueva llamada» (POST /calls/instant): quien la pide queda dentro con esta fila provisional, sin
 * attendee, hasta que su cliente entra con el flujo normal (y la fila se borra). Si no entra, el worker la saca a
 * los 75 s y la llamada se cierra (el enlace muere con ella). No aparece en myDevices.
 */
const INSTANT_DEVICE_KEY = 'instant';

// ---------- Quién ve la llamada (huddle) ----------
/**
 * Como los huddles de Slack (pedido de Danny, 29-sep-2026): la llamada es de la empresa de quien la empezó. En un
 * chat con gente de otras empresas, a ellos no les suena, no la ven en curso ni en el historial, salvo que alguien
 * los agregue (＋ Agregar) o entren. En un chat directo la ven los dos. `c` es la fila de calls; `$u` el usuario.
 */
const seesCallSql = (u: string, c = 'c') => `(
  ${c}.started_by = ${u}
  OR EXISTS (SELECT 1 FROM conversations d WHERE d.id = ${c}.conversation_id AND d.kind = 'direct')
  OR EXISTS (SELECT 1 FROM organization_memberships a JOIN organization_memberships b ON b.org_id = a.org_id WHERE a.user_id = ${c}.started_by AND b.user_id = ${u})
  OR EXISTS (SELECT 1 FROM call_participants p WHERE p.call_id = ${c}.id AND p.user_id = ${u})
  OR EXISTS (SELECT 1 FROM call_invites i WHERE i.call_id = ${c}.id AND i.user_id = ${u})
  OR EXISTS (SELECT 1 FROM call_rings g WHERE g.call_id = ${c}.id AND g.user_id = ${u}))`;

async function seesCall(db: Db, userId: string, callId: string) {
  const r = await db.query(`SELECT 1 FROM calls c WHERE c.id = $1 AND ${seesCallSql('$2')}`, [callId, userId]);
  return !!r.rowCount;
}

/** Miembros del chat que ven la llamada y si queda alguien por fuera (chat con otras empresas). */
async function callAudience(db: Db, callId: string): Promise<{ members: string[]; mixed: boolean }> {
  const { rows } = await db.query(
    `SELECT m.user_id, ${seesCallSql('m.user_id')} AS sees FROM calls c
       JOIN conversation_memberships m ON m.conversation_id = c.conversation_id AND m.removed_at IS NULL
      WHERE c.id = $1`,
    [callId],
  );
  return { members: rows.filter((r) => r.sees).map((r) => r.user_id), mixed: rows.some((r) => !r.sees) };
}

/** Mensaje de sistema de la llamada en el chat. En un chat con otras empresas no se deja: lo verían todos. */
async function callNote(c: Tx, callId: string, msg: Parameters<typeof appendMessage>[1]) {
  if ((await callAudience(c, callId)).mixed) return null;
  return appendMessage(c, msg);
}

// ---------- Lectura ----------
/** viewerId: agrega myDevices (solo sus dispositivos dentro de la llamada). */
async function callDTO(db: Db, id: string, viewerId?: string): Promise<CallDTO> {
  const { rows } = await db.query(
    `SELECT c.*,
            COALESCE((SELECT array_agg(x.user_id ORDER BY x.first) FROM (SELECT p.user_id, min(p.first_joined_at) AS first FROM call_participants p
                       WHERE p.call_id = c.id AND p.left_at IS NULL GROUP BY p.user_id) x), '{}') AS active,
            CASE WHEN $2::uuid IS NULL THEN NULL ELSE COALESCE((SELECT jsonb_agg(jsonb_build_object('deviceKey', p.device_key, 'platform', COALESCE(p.platform, 'web'), 'label', COALESCE(p.label, ''))
                       ORDER BY p.joined_at) FROM call_participants p WHERE p.call_id = c.id AND p.user_id = $2 AND p.left_at IS NULL AND p.device_key <> '${INSTANT_DEVICE_KEY}'), '[]'::jsonb) END AS my_devices,
            EXISTS (SELECT 1 FROM call_transcript_segments s WHERE s.call_id = c.id) AS has_transcript,
            ARRAY(SELECT i.user_id FROM call_invites i WHERE i.call_id = c.id ORDER BY i.created_at) AS invited,
            (SELECT jsonb_agg(jsonb_build_object('userId', g.user_id, 'at', to_char(g.rung_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                    'joined', EXISTS (SELECT 1 FROM call_participants p WHERE p.call_id = c.id AND p.user_id = g.user_id AND p.joined_at >= g.rung_at - interval '5 seconds'))
                    ORDER BY g.rung_at) FROM call_rings g WHERE g.call_id = c.id) AS rings,
            (SELECT jsonb_object_agg(u.id, u.name) FROM users u
              WHERE u.id IN (SELECT p.user_id FROM call_participants p WHERE p.call_id = c.id UNION SELECT i.user_id FROM call_invites i WHERE i.call_id = c.id
                             UNION SELECT g.user_id FROM call_rings g WHERE g.call_id = c.id)) AS names,
            (SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', q.id, 'name', q.name, 'email', q.email)) ORDER BY q.joined_at) FROM call_guests q
              WHERE q.call_id = c.id AND q.left_at IS NULL) AS guests
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
    ...(r.guests?.length ? { guests: r.guests } : {}),
  };
}

async function publish(c: Tx, conversationId: string, callId: string) {
  const call = await callDTO(c, callId);
  const { rows } = await c.query('SELECT DISTINCT user_id FROM call_participants WHERE call_id = $1', [callId]);
  const aud = await callAudience(c, callId);
  if (!aud.mixed) await appendEvent(c, conversationId, { type: 'call.updated', conversationId, call });
  else {
    // Chat con otras empresas: el evento de la conversación lo verían todos; va solo a la empresa, por su cuenta.
    const been = new Set(rows.map((r) => r.user_id));
    const ids = aud.members.filter((id) => !been.has(id));
    if (ids.length) await enqueueOutbox(c, 'account.event', { userIds: ids, event: { type: 'call.updated', call } });
  }
  // Los agregados que no están en el chat no escuchan la conversación: les llega por su cuenta.
  if (call.invitedUserIds?.length) await enqueueOutbox(c, 'account.event', { userIds: call.invitedUserIds, event: { type: 'call.updated', call } });
  // 1.7.1: a quien estuvo alguna vez en la llamada, por su cuenta, la misma llamada con SUS dispositivos (myDevices).
  for (const r of rows) {
    await enqueueOutbox(c, 'account.event', { userIds: [r.user_id], event: { type: 'call.updated', call: await callDTO(c, callId, r.user_id) } });
  }
  return call;
}

/** GET /calls/active: llamadas sin terminar de mis conversaciones (solo las de mi empresa) y a las que me agregaron, con su título. */
export async function activeCalls(userId: string): Promise<{ calls: ActiveCallDTO[] }> {
  const { rows } = await pool.query(
    `SELECT c.id, cv.name AS title FROM calls c JOIN conversations cv ON cv.id = c.conversation_id AND cv.archived_at IS NULL
      WHERE c.ended_at IS NULL AND (
        (EXISTS (SELECT 1 FROM conversation_memberships cm
                  LEFT JOIN workspace_memberships wm ON wm.workspace_id = cv.workspace_id AND wm.user_id = cm.user_id
                 WHERE cm.conversation_id = c.conversation_id AND cm.user_id = $1 AND cm.removed_at IS NULL
                   AND (cv.workspace_id IS NULL OR (wm.user_id IS NOT NULL AND wm.revoked_at IS NULL AND (wm.expires_at IS NULL OR wm.expires_at > now()))))
         AND ${seesCallSql('$1')})
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
  const { rows } = await pool.query(`SELECT id FROM calls c WHERE conversation_id = $1 AND ended_at IS NULL AND ${seesCallSql('$2')}`, [conversationId, userId]);
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
  // Llamada de otra empresa en un chat compartido: para mí no existe (huddle).
  if (!(await seesCall(db, userId, callId))) throw notFound('Llamada');
  return call;
}

/** Historial: llamadas donde estuve o de conversaciones mías dentro de mi historial visible. */
export async function history(userId: string, q: { before?: string; limit: number }): Promise<{ calls: CallHistoryItemDTO[]; hasMore: boolean }> {
  const { rows } = await pool.query(
    `SELECT c.id, c.started_at,
            ARRAY(SELECT p.user_id FROM call_participants p WHERE p.call_id = c.id ORDER BY p.first_joined_at) AS participant_ids,
            CASE WHEN c.ended_at IS NOT NULL THEN extract(epoch FROM c.ended_at - c.started_at)::int END AS secs,
            c.summary IS NOT NULL AS has_summary, cv.name AS title, cv.is_meeting,
            EXISTS (SELECT 1 FROM call_ringees r WHERE r.call_id = c.id AND r.user_id = $1 AND ${MISSED_SQL}) AS missed
       FROM calls c
       LEFT JOIN conversation_memberships cm ON cm.conversation_id = c.conversation_id AND cm.user_id = $1 AND cm.removed_at IS NULL
       JOIN conversations cv ON cv.id = c.conversation_id AND cv.archived_at IS NULL
       LEFT JOIN messages m ON m.id = c.message_id
      WHERE ($2::timestamptz IS NULL OR c.started_at < $2)
        AND (EXISTS (SELECT 1 FROM call_participants p WHERE p.call_id = c.id AND p.user_id = $1)
             OR EXISTS (SELECT 1 FROM call_ringees r WHERE r.call_id = c.id AND r.user_id = $1)
             OR (cm.user_id IS NOT NULL AND (m.seq IS NULL OR m.seq > cm.history_from_seq) AND ${seesCallSql('$1')}))
      ORDER BY c.started_at DESC LIMIT $3`,
    [userId, q.before ?? null, q.limit + 1],
  );
  const page = rows.slice(0, q.limit);
  const calls = await Promise.all(page.map(async (r) => ({
    call: await callDTO(pool, r.id), participantIds: r.participant_ids, durationSec: r.secs, hasSummary: r.has_summary,
    ...(r.missed ? { missed: true } : {}), title: r.title ?? null, ...(r.is_meeting ? { meeting: true } : {}),
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
      const cur = await c.query(`SELECT id, ${seesCallSql('$2')} AS sees FROM calls c WHERE conversation_id = $1 AND ended_at IS NULL`, [conversationId, userId]);
      if (cur.rows[0] && !cur.rows[0].sees) throw new ApiError(409, 'call_busy', 'Hay otra llamada en curso en este chat');
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
    if (device.key !== INSTANT_DEVICE_KEY) await c.query('DELETE FROM call_participants WHERE call_id = $1 AND user_id = $2 AND device_key = $3', [callId, userId, INSTANT_DEVICE_KEY]);
    await c.query(
      `INSERT INTO call_participants (call_id, user_id, attendee_id, device_key, platform, label) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (call_id, user_id, device_key) DO UPDATE SET attendee_id = $3, platform = $5, label = $6, joined_at = now(), last_seen_at = now(), left_at = NULL`,
      [callId, userId, attendee.AttendeeId, device.key, platform, label],
    );
    // Mis otros dispositivos dejan de sonar (ignoran el aviso si deviceKey es el suyo).
    await enqueueOutbox(c, 'account.event', { userIds: [userId], event: { type: 'call.answered', callId, conversationId: row.conversation_id, deviceKey: device.key, platform, label } });
    if (created) {
      const msg = await callNote(c, callId, { conversationId: row.conversation_id, authorId: userId, kind: 'system', body: sys('call.started', { kind: row.kind, callId }) });
      await c.query('UPDATE calls SET message_id = $2 WHERE id = $1', [callId, msg?.id ?? null]);
    }
    const dto = await publish(c, row.conversation_id, callId);
    if (created) await ring(c, dto, userId);
    return callDTO(c, callId, userId);
  });
  return { call, meeting: { Meeting: row.meeting }, attendee: { Attendee: attendee } };
}

/**
 * Aviso «te están llamando» a los demás miembros de la empresa de quien llama (o al otro en un directo). A quien
 * tiene No molestar no le suena, pero le queda como perdida.
 */
async function ring(c: Tx, call: CallDTO, callerId: string) {
  const { rows: all } = await c.query(
    `SELECT m.user_id, (u.dnd_until IS NOT NULL AND u.dnd_until > now()) AS dnd FROM conversation_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.conversation_id = $1 AND m.removed_at IS NULL AND m.user_id <> $2 AND u.disabled_at IS NULL
        AND (EXISTS (SELECT 1 FROM conversations d WHERE d.id = m.conversation_id AND d.kind = 'direct')
             OR EXISTS (SELECT 1 FROM organization_memberships a JOIN organization_memberships b ON b.org_id = a.org_id WHERE a.user_id = $2 AND b.user_id = m.user_id))`,
    [call.conversationId, callerId],
  );
  await markRung(c, call.id, all.filter((r) => r.dnd).map((r) => r.user_id));
  const rows = all.filter((r) => !r.dnd);
  if (!rows.length) return;
  const info = (await c.query(
    'SELECT (SELECT name FROM users WHERE id = $2) AS caller, (SELECT name FROM conversations WHERE id = $1) AS title',
    [call.conversationId, callerId],
  )).rows[0];
  await ringUsers(c, call, rows.map((r) => r.user_id), info.caller ?? '', info.title ?? null);
}

/** Quedan anotados para las perdidas. Volver a sonar renueva la hora y borra un rechazo anterior. */
async function markRung(c: Tx, callId: string, userIds: string[]) {
  if (!userIds.length) return;
  await c.query(
    `INSERT INTO call_ringees (call_id, user_id) SELECT $1, unnest($2::uuid[])
     ON CONFLICT (call_id, user_id) DO UPDATE SET rung_at = now(), declined_at = NULL`,
    [callId, userIds],
  );
}

/** Aviso en vivo (socket) y push de llamada entrante (para la app cerrada). */
async function ringUsers(c: Tx, call: CallDTO, userIds: string[], callerName: string, title: string | null, again = false) {
  if (!userIds.length) return;
  await markRung(c, call.id, userIds);
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
  await tx(async (c) => {
    // Rechazada no es perdida.
    await c.query('UPDATE call_ringees SET declined_at = now() WHERE call_id = $1 AND user_id = $2', [callId, userId]);
    await enqueueOutbox(c, 'account.event', { userIds: [userId], event: { type: 'call.declined', callId, conversationId: call.conversation_id } });
  });
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
    await c.query('UPDATE call_guests SET left_at = now() WHERE call_id = $1 AND left_at IS NULL', [callId]);
    await c.query('UPDATE call_links SET revoked_at = now() WHERE call_id = $1 AND revoked_at IS NULL', [callId]);
    await callNote(c, callId, { conversationId: call.conversation_id, authorId: call.started_by, kind: 'system', body: sys('call.ended', { callId, durationSec: call.secs }) });
    const seg = await c.query('SELECT 1 FROM call_transcript_segments WHERE call_id = $1 LIMIT 1', [callId]);
    if (seg.rowCount) {
      const m = await callNote(c, callId, { conversationId: call.conversation_id, authorId: call.started_by, kind: 'system', body: sys('call.transcript', { callId }) });
      await c.query('UPDATE calls SET transcript_message_id = $2 WHERE id = $1', [callId, m?.id ?? null]);
      if (call.ai_summary) await c.query("INSERT INTO jobs (kind, payload, max_attempts, dedupe_key) VALUES ('call.summary', $1, 3, $2) ON CONFLICT (dedupe_key) DO NOTHING", [JSON.stringify({ callId }), `call-summary:${callId}`]);
    }
    await publish(c, call.conversation_id, callId);
    await announceMissed(c, callId);
  });
}

// ---------- Perdidas ----------
const MISSED_SQL = `c.ended_at IS NOT NULL AND r.declined_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM call_participants p WHERE p.call_id = c.id AND p.user_id = r.user_id)`;

/** Al colgar: a quienes les sonó y no entraron, el aviso en vivo (el número rojo) y un push «Llamada perdida». */
async function announceMissed(c: Tx, callId: string) {
  const { rows } = await c.query(`SELECT r.user_id FROM call_ringees r JOIN calls c ON c.id = r.call_id WHERE r.call_id = $1 AND ${MISSED_SQL}`, [callId]);
  if (!rows.length) return;
  const userIds = rows.map((r) => r.user_id);
  const counts = await missedCounts(c, userIds);
  for (const id of userIds) await enqueueOutbox(c, 'account.event', { userIds: [id], event: { type: 'calls.missed', callId, missedCalls: counts.get(id) ?? 0 } });
  await c.query(
    "INSERT INTO jobs (kind, payload, max_attempts, dedupe_key) VALUES ('push.call_missed', $1, 1, $2) ON CONFLICT (dedupe_key) DO NOTHING",
    [JSON.stringify({ callId, userIds }), `push-call-missed:${callId}`],
  );
}

async function missedCounts(db: Db, userIds: string[]) {
  const { rows } = await db.query(
    `SELECT r.user_id, count(*)::int AS n FROM call_ringees r JOIN calls c ON c.id = r.call_id JOIN users u ON u.id = r.user_id
      WHERE r.user_id = ANY($1) AND ${MISSED_SQL} AND (u.calls_seen_at IS NULL OR r.rung_at > u.calls_seen_at)
      GROUP BY r.user_id`,
    [userIds],
  );
  return new Map<string, number>(rows.map((r) => [r.user_id, r.n]));
}

/** Para el bootstrap: perdidas desde la última vez que abrí Llamadas. */
export async function missedCount(userId: string): Promise<number> {
  if (!callsEnabled()) return 0;
  return (await missedCounts(pool, [userId])).get(userId) ?? 0;
}

/** POST /calls/seen: abrí la pestaña Llamadas; el número rojo se quita en todos mis dispositivos. */
export async function markCallsSeen(userId: string) {
  await tx(async (c) => {
    await c.query('UPDATE users SET calls_seen_at = now() WHERE id = $1', [userId]);
    await enqueueOutbox(c, 'account.event', { userIds: [userId], event: { type: 'calls.missed', callId: null, missedCalls: 0 } });
  });
  return { missedCalls: 0 };
}

/** Worker: saca a quien dejó de latir y cierra las llamadas que quedaron vacías. */
export async function reapCalls(): Promise<number> {
  const stale = await pool.query(
    `UPDATE call_participants p SET left_at = now() FROM calls c
      WHERE c.id = p.call_id AND c.ended_at IS NULL AND p.left_at IS NULL AND p.last_seen_at < now() - make_interval(secs => $1)
      RETURNING c.id, c.conversation_id`,
    [STALE_SECONDS],
  );
  const staleGuests = await pool.query(
    `UPDATE call_guests q SET left_at = now() FROM calls c
      WHERE c.id = q.call_id AND c.ended_at IS NULL AND q.left_at IS NULL AND q.last_seen_at < now() - make_interval(secs => $1)
      RETURNING c.id, c.conversation_id`,
    [GUEST_STALE_SECONDS],
  );
  // Los invitados no sostienen la llamada: sin nadie de chaggu dentro, se cierra (y se les corta).
  const empty = await pool.query(
    `SELECT c.id FROM calls c WHERE c.ended_at IS NULL AND c.started_at < now() - interval '1 minute'
        AND NOT EXISTS (SELECT 1 FROM call_participants p WHERE p.call_id = c.id AND p.left_at IS NULL)`,
  );
  const ended = new Set(empty.rows.map((r) => r.id));
  for (const id of ended) await finish(id);
  // Los que siguen con gente pero perdieron a alguien: avisar quién quedó.
  const touched = new Map([...stale.rows, ...staleGuests.rows].filter((r) => !ended.has(r.id)).map((r) => [r.id, r.conversation_id]));
  for (const [id, conv] of touched) await tx((c) => publish(c, conv, id));
  return ended.size + touched.size;
}

// ---------- Invitados por enlace (docs/LLAMADAS.md › Invitados por enlace) ----------
/** Invitados a la vez en una llamada. */
export const MAX_GUESTS = 10;
/** El invitado late cada 15 s (así también se entera de quién entra); a los 45 s sin latir sale. */
const GUEST_STALE_SECONDS = 45;

/**
 * POST /calls/:id/link: un enlace nuevo para que terceros entren con su nombre, sin cuenta. Lo pide alguien que
 * está dentro de la llamada. Vale mientras la llamada siga abierta (o hasta quitarlo con DELETE).
 */
export async function createLink(userId: string, callId: string): Promise<CallLinkDTO> {
  requireEnabled();
  const call = await callFor(pool, userId, callId, 'post');
  if (call.ended_at) throw new ApiError(409, 'call_ended', 'La llamada ya terminó');
  const inside = await pool.query('SELECT 1 FROM call_participants WHERE call_id = $1 AND user_id = $2 AND left_at IS NULL LIMIT 1', [callId, userId]);
  if (!inside.rowCount) throw new ApiError(409, 'not_in_call', 'Entra a la llamada para compartir el enlace');
  return insertLink(pool, userId, callId);
}

async function insertLink(db: Db, userId: string, callId: string): Promise<CallLinkDTO> {
  const token = randomToken(18);
  await db.query('INSERT INTO call_links (call_id, token_hash, created_by) VALUES ($1,$2,$3)', [callId, sha256(token), userId]);
  return { token, url: `${config.publicOrigin}/llamada/${token}` };
}

/**
 * POST /calls/instant: «Nueva llamada» (docs/LLAMADAS.md › Nueva llamada). Sin elegir chat:
 * - crea una conversación de reunión (kind 'multi', fuera de los espacios, solo con quien la pide, is_meeting) con
 *   nombre = title o «Llamada de <nombre>»;
 * - abre la llamada ya iniciada (reunión en Chime) con quien la pide dentro (fila provisional 'instant') hasta que
 *   su cliente entra con el flujo normal, POST /conversations/:id/call, desde su dispositivo;
 * - y crea de una vez el enlace para invitados.
 * No le suena a nadie. La conversación no sale en la bandeja mientras no tenga mensajes de personas (bootstrap).
 */
export async function instantCall(userId: string, input: { title?: string; video?: boolean }): Promise<InstantCallDTO> {
  requireEnabled();
  const kind: CallKind = input.video ? 'video' : 'audio';
  const { conversationId, callId } = await tx(async (c) => {
    const me = (await c.query('SELECT name FROM users WHERE id = $1', [userId])).rows[0];
    const name = input.title?.replace(/[\u0000-\u001f\u007f]/g, '').trim() || `Llamada de ${me?.name ?? 'chaggu'}`.slice(0, 80);
    const conv = await c.query("INSERT INTO conversations (kind, name, created_by, is_meeting) VALUES ('multi', $1, $2, true) RETURNING id", [name, userId]);
    const conversationId: string = conv.rows[0].id;
    await c.query('INSERT INTO conversation_memberships (conversation_id, user_id, can_manage, added_by) VALUES ($1,$2,true,$2)', [conversationId, userId]);
    const call = await c.query('INSERT INTO calls (conversation_id, started_by, kind) VALUES ($1,$2,$3) RETURNING id', [conversationId, userId, kind]);
    await scopeChanged(c, [userId], 'chat.created', { conversationId });
    return { conversationId, callId: call.rows[0].id as string };
  });
  try {
    const m = await getProvider().create(callId);
    return await tx(async (c) => {
      await c.query('UPDATE calls SET external_id = $2, media_region = $3, meeting = $4 WHERE id = $1', [callId, m.externalId, m.mediaRegion, JSON.stringify(m.meeting)]);
      await c.query("INSERT INTO call_participants (call_id, user_id, device_key, platform, label) VALUES ($1,$2,$3,'web','')", [callId, userId, INSTANT_DEVICE_KEY]);
      const msg = await callNote(c, callId, { conversationId, authorId: userId, kind: 'system', body: sys('call.started', { kind, callId }) });
      await c.query('UPDATE calls SET message_id = $2 WHERE id = $1', [callId, msg?.id ?? null]);
      await publish(c, conversationId, callId);
      const link = await insertLink(c, userId, callId);
      return { call: await callDTO(c, callId, userId), conversationId, link };
    });
  } catch (e) {
    // Sin reunión no hay llamada: se cierra para no dejarla colgada.
    await finish(callId).catch(() => {});
    if (e instanceof MeetingGone) throw new ApiError(503, 'call_unavailable', 'No se pudo abrir la llamada, intenta de nuevo');
    throw e;
  }
}

/** DELETE /calls/:id/link: los enlaces dejan de servir. Quien ya entró sigue dentro (se le puede sacar colgando para todos). */
export async function revokeLinks(userId: string, callId: string) {
  await callFor(pool, userId, callId, 'post');
  await pool.query('UPDATE call_links SET revoked_at = now() WHERE call_id = $1 AND revoked_at IS NULL', [callId]);
  return { ok: true };
}

async function linkRow(token: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw notFound('Enlace');
  const { rows } = await pool.query(
    `SELECT l.id AS link_id, l.revoked_at, c.id AS call_id, c.kind, c.ended_at, c.external_id, c.meeting, c.conversation_id,
            cv.kind AS conv_kind, cv.name AS conv_name, u.name AS host_name,
            (SELECT o.name FROM organization_memberships om JOIN organizations o ON o.id = om.org_id WHERE om.user_id = c.started_by ORDER BY om.joined_at LIMIT 1) AS org_name,
            EXISTS (SELECT 1 FROM call_participants p WHERE p.call_id = c.id AND p.left_at IS NULL) AS live
       FROM call_links l JOIN calls c ON c.id = l.call_id JOIN conversations cv ON cv.id = c.conversation_id JOIN users u ON u.id = c.started_by
      WHERE l.token_hash = $1`,
    [sha256(token)],
  );
  if (!rows[0]) throw notFound('Enlace');
  return rows[0];
}

/** GET /call-links/:token (público): lo mínimo para la pantalla «Entrar a la llamada». Un chat directo no muestra su nombre. */
export async function previewLink(token: string): Promise<GuestCallPreviewDTO> {
  requireEnabled();
  const r = await linkRow(token);
  // El enlace solo vive durante la llamada.
  if (r.ended_at) throw new ApiError(410, 'call_ended', 'Esta llamada ya terminó');
  return {
    title: r.conv_kind === 'direct' ? null : r.conv_name ?? null, hostName: r.host_name, orgName: r.org_name ?? null,
    kind: r.kind, active: !r.revoked_at && !r.ended_at && r.live && !!r.external_id,
  };
}

async function guestState(db: Db, callId: string): Promise<GuestCallStateDTO> {
  const call = await callDTO(db, callId);
  const guests = call.guests ?? [];
  const names: Record<string, string> = {};
  for (const id of call.activeUserIds) if (call.names?.[id]) names[id] = call.names[id]!;
  for (const g of guests) names[guestExternalId(g.id)] = g.name;
  // API público: el correo de los invitados nunca sale de aquí.
  return { callId, kind: call.kind, active: !call.endedAt, transcribing: call.transcribing, activeUserIds: call.activeUserIds, guests: guests.map((g) => ({ id: g.id, name: g.name })), names };
}

/**
 * Cuerpo de POST /call-links/:token/join: nombre y correo (desde el 30-sep-2026). Sin correo, 400 email_required;
 * con forma inválida, 400 invalid_email. El correo se guarda en minúsculas.
 */
export function guestJoinInput(body: unknown): { name: string; email: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) throw new ApiError(400, 'name_required', 'Escribe tu nombre');
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  if (!email) throw new ApiError(400, 'email_required', 'Escribe tu correo');
  if (email.length > 254 || !EMAIL_SHAPE.test(email)) throw new ApiError(400, 'invalid_email', 'Ese correo no parece válido');
  return { name: name.slice(0, 60), email };
}

/** POST /call-links/:token/join (público): entra un invitado con su nombre y su correo. */
export async function guestJoin(token: string, input: { name: string; email: string }): Promise<GuestJoinDTO> {
  requireEnabled();
  const { name, email } = input;
  const r = await linkRow(token);
  // Terminada: 410 (el enlace solo vive durante la llamada). Quitado con la llamada abierta: 410 link_revoked.
  if (r.ended_at) throw new ApiError(410, 'call_ended', 'Esta llamada ya terminó');
  if (r.revoked_at) throw new ApiError(410, 'link_revoked', 'Este enlace ya no sirve. Pide uno nuevo.');
  if (!r.live || !r.external_id) throw new ApiError(409, 'call_not_live', 'No hay nadie en la llamada ahora');
  const n = await pool.query('SELECT count(*)::int AS n FROM call_guests WHERE call_id = $1 AND left_at IS NULL', [r.call_id]);
  if (n.rows[0].n >= MAX_GUESTS) throw new ApiError(409, 'call_full', 'La llamada ya tiene el máximo de invitados');
  const secret = randomToken(24);
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) || 'Invitado';
  const ins = await pool.query('INSERT INTO call_guests (call_id, link_id, name, secret_hash, email) VALUES ($1,$2,$3,$4,$5) RETURNING id', [r.call_id, r.link_id, clean, sha256(secret), email]);
  const guestId = ins.rows[0].id as string;
  let attendee: Attendee;
  try { attendee = await getProvider().attendee(r.external_id, guestExternalId(guestId)); }
  catch (e) {
    await pool.query('UPDATE call_guests SET left_at = now() WHERE id = $1', [guestId]);
    if (e instanceof MeetingGone) { await finish(r.call_id); throw new ApiError(409, 'call_ended', 'La llamada ya terminó'); }
    throw e;
  }
  const call = await tx(async (c) => {
    await c.query('UPDATE call_guests SET attendee_id = $2 WHERE id = $1', [guestId, attendee.AttendeeId]);
    await publish(c, r.conversation_id, r.call_id);
    return guestState(c, r.call_id);
  });
  return { guestId, secret, call, meeting: { Meeting: r.meeting }, attendee: { Attendee: attendee } };
}

async function guestRow(guestId: string, secret: string) {
  const { rows } = await pool.query(
    'SELECT q.*, c.conversation_id, c.ended_at FROM call_guests q JOIN calls c ON c.id = q.call_id WHERE q.id = $1 AND q.secret_hash = $2',
    [guestId, sha256(secret)],
  );
  if (!rows[0]) throw new ApiError(404, 'not_found', 'Invitado no encontrado');
  return rows[0];
}

/** POST /call-guests/:id/heartbeat (público, con el secreto): sigue dentro y recibe quién está. */
export async function guestHeartbeat(guestId: string, secret: string): Promise<GuestCallStateDTO> {
  const g = await guestRow(guestId, secret);
  if (g.left_at || g.ended_at) throw new ApiError(409, 'not_in_call', 'Ya no estás en esa llamada');
  await pool.query('UPDATE call_guests SET last_seen_at = now() WHERE id = $1', [guestId]);
  return guestState(pool, g.call_id);
}

export async function guestLeave(guestId: string, secret: string) {
  const g = await guestRow(guestId, secret);
  if (!g.left_at) await tx(async (c) => {
    await c.query('UPDATE call_guests SET left_at = now() WHERE id = $1', [guestId]);
    if (!g.ended_at) await publish(c, g.conversation_id, g.call_id);
  });
  return { ok: true };
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
    await callNote(c, callId, { conversationId: call.conversation_id, authorId: userId, kind: 'system', body: sys(on ? 'call.transcription.on' : 'call.transcription.off', { name, callId }) });
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
      const m = await callNote(c, callId, { conversationId: call.conversation_id, authorId: cur.rows[0].started_by, kind: 'system', body: sys('call.transcript', { callId }) });
      await c.query('UPDATE calls SET transcript_message_id = $2 WHERE id = $1', [callId, m?.id ?? null]);
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
        const m = await callNote(c, callId, { conversationId: call.conversation_id, authorId: cur.rows[0].started_by, kind: 'system', body: sys('call.transcript', { callId }) });
        await c.query('UPDATE calls SET transcript_message_id = $2 WHERE id = $1', [callId, m?.id ?? null]);
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
