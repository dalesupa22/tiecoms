/**
 * Llamadas de voz y video dentro de una conversación, con Amazon Chime SDK (docs/LLAMADAS.md).
 * - Una llamada activa por conversación. Quien toca «Llamar» la crea; los demás entran a la misma.
 * - La reunión de Chime se crea con ClientRequestToken = id de la llamada: dos personas que llaman a la vez
 *   terminan en la misma reunión. Nunca hay llamadas de red dentro de una transacción.
 * - Presencia por latido (cada 30 s). El worker saca a quien dejó de latir y cierra la llamada vacía.
 * - Transcripción en vivo (Amazon Transcribe vía Chime), se prende y apaga durante la llamada; los clientes
 *   mandan las frases finales que reciben del SDK y aquí se guardan deduplicadas por resultId.
 * Costos (28-sep-2026): Chime US$0.0017 por persona-minuto; Transcribe US$0.01 por minuto de llamada transcrita.
 * CALLS_PROVIDER=fake usa un proveedor en memoria (pruebas y desarrollo sin AWS).
 */
import { randomUUID } from 'node:crypto';
import {
  ChimeSDKMeetingsClient, CreateAttendeeCommand, CreateMeetingCommand, DeleteMeetingCommand, GetMeetingCommand,
  StartMeetingTranscriptionCommand, StopMeetingTranscriptionCommand,
} from '@aws-sdk/client-chime-sdk-meetings';
import type { CallDTO, CallHistoryItemDTO, CallJoinDTO, CallKind, CallTranscriptDTO } from '@tiecoms/contracts';
import type { z } from 'zod';
import type { CallTranscriptInput } from '@tiecoms/contracts';
import { conversationAccess } from '../access.ts';
import { pool, tx, type Db, type Tx, enqueueOutbox } from '../db.ts';
import { ApiError, badRequest, notFound } from '../errors.ts';
import { appendEvent, appendMessage, sendMessage } from './messages.ts';
import { getSummarizer } from './voice-providers.ts';

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
  attendee(externalId: string, userId: string): Promise<Attendee>;
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
  async attendee(externalId: string, userId: string) {
    try {
      const out = await this.client.send(new CreateAttendeeCommand({ MeetingId: externalId, ExternalUserId: userId }));
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
  async attendee(externalId: string, userId: string) {
    if (!this.meetings.has(externalId)) throw new MeetingGone();
    return { AttendeeId: `att-${randomUUID()}`, ExternalUserId: userId, JoinToken: `tok-${randomUUID()}` };
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

// ---------- Lectura ----------
async function callDTO(db: Db, id: string): Promise<CallDTO> {
  const { rows } = await db.query(
    `SELECT c.*,
            COALESCE((SELECT array_agg(p.user_id ORDER BY p.first_joined_at) FROM call_participants p
                       WHERE p.call_id = c.id AND p.left_at IS NULL), '{}') AS active,
            EXISTS (SELECT 1 FROM call_transcript_segments s WHERE s.call_id = c.id) AS has_transcript
       FROM calls c WHERE c.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) throw notFound('Llamada');
  return {
    id: r.id, conversationId: r.conversation_id, kind: r.kind, startedBy: r.started_by,
    startedAt: new Date(r.started_at).toISOString(), endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null,
    activeUserIds: r.active, transcribing: r.transcribing, hasTranscript: r.has_transcript,
  };
}

async function publish(c: Tx, conversationId: string, callId: string) {
  const call = await callDTO(c, callId);
  await appendEvent(c, conversationId, { type: 'call.updated', conversationId, call });
  return call;
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
  const a = await conversationAccess(db, userId, call.conversation_id, need);
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
       JOIN conversation_memberships cm ON cm.conversation_id = c.conversation_id AND cm.user_id = $1 AND cm.removed_at IS NULL
       JOIN conversations cv ON cv.id = c.conversation_id AND cv.archived_at IS NULL
       LEFT JOIN messages m ON m.id = c.message_id
      WHERE ($2::timestamptz IS NULL OR c.started_at < $2)
        AND (EXISTS (SELECT 1 FROM call_participants p WHERE p.call_id = c.id AND p.user_id = $1) OR m.seq IS NULL OR m.seq > cm.history_from_seq)
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
export async function startOrJoin(userId: string, conversationId: string, kind: CallKind): Promise<CallJoinDTO> {
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
      return await joinCall(userId, callId, created);
    } catch (e) {
      if (!(e instanceof MeetingGone)) throw e;
      // Chime ya cerró esa reunión: se da por terminada y se abre una nueva.
      await finish(callId);
    }
  }
  throw new ApiError(503, 'call_unavailable', 'No se pudo abrir la llamada, intenta de nuevo');
}

/** Entrar a una llamada concreta (desde el aviso de «te están llamando»). */
export async function join(userId: string, callId: string): Promise<CallJoinDTO> {
  requireEnabled();
  const call = await callFor(pool, userId, callId, 'post');
  if (call.ended_at) throw new ApiError(409, 'call_ended', 'La llamada ya terminó');
  try {
    return await joinCall(userId, callId, false);
  } catch (e) {
    if (!(e instanceof MeetingGone)) throw e;
    await finish(callId);
    return startOrJoin(userId, call.conversation_id, call.kind);
  }
}

async function joinCall(userId: string, callId: string, created: boolean): Promise<CallJoinDTO> {
  let row = (await pool.query('SELECT * FROM calls WHERE id = $1', [callId])).rows[0];
  if (!row.meeting) {
    // Idempotente en Chime (ClientRequestToken): si dos entran a la vez, ambos reciben la misma reunión.
    const m = await getProvider().create(callId);
    await pool.query('UPDATE calls SET external_id = $2, media_region = $3, meeting = $4 WHERE id = $1 AND meeting IS NULL',
      [callId, m.externalId, m.mediaRegion, JSON.stringify(m.meeting)]);
    row = (await pool.query('SELECT * FROM calls WHERE id = $1', [callId])).rows[0];
  }
  const attendee = await getProvider().attendee(row.external_id, userId);
  const call = await tx(async (c) => {
    await c.query(
      `INSERT INTO call_participants (call_id, user_id, attendee_id) VALUES ($1,$2,$3)
       ON CONFLICT (call_id, user_id) DO UPDATE SET attendee_id = $3, joined_at = now(), last_seen_at = now(), left_at = NULL`,
      [callId, userId, attendee.AttendeeId],
    );
    if (created) {
      const msg = await appendMessage(c, { conversationId: row.conversation_id, authorId: userId, kind: 'system', body: sys('call.started', { kind: row.kind, callId }) });
      await c.query('UPDATE calls SET message_id = $2 WHERE id = $1', [callId, msg.id]);
    }
    const dto = await publish(c, row.conversation_id, callId);
    if (created) await ring(c, dto, userId);
    return dto;
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
  await enqueueOutbox(c, 'account.event', {
    userIds: rows.map((r) => r.user_id),
    event: { type: 'call.ringing', call, conversationTitle: info.title ?? null, callerName: info.caller ?? '' },
  });
}

// ---------- Latido / salir / terminar ----------
export async function heartbeat(userId: string, callId: string) {
  const { rowCount } = await pool.query(
    `UPDATE call_participants p SET last_seen_at = now() FROM calls c
      WHERE p.call_id = $1 AND p.user_id = $2 AND p.left_at IS NULL AND c.id = p.call_id AND c.ended_at IS NULL`,
    [callId, userId],
  );
  if (!rowCount) throw new ApiError(409, 'not_in_call', 'Ya no estás en esa llamada');
  return { ok: true };
}

export async function leave(userId: string, callId: string) {
  const call = await callFor(pool, userId, callId, 'read');
  const empty = await tx(async (c) => {
    const r = await c.query('UPDATE call_participants SET left_at = now() WHERE call_id = $1 AND user_id = $2 AND left_at IS NULL', [callId, userId]);
    if (!r.rowCount || call.ended_at) return false;
    const left = await c.query('SELECT 1 FROM call_participants WHERE call_id = $1 AND left_at IS NULL LIMIT 1', [callId]);
    if (left.rowCount) { await publish(c, call.conversation_id, callId); return false; }
    return true;
  });
  if (empty) await finish(callId);
  return { call: await callDTO(pool, callId) };
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
  try {
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
    const speaker = (s.externalUserId && byUser.has(s.externalUserId) ? s.externalUserId : s.attendeeId ? byAttendee.get(s.attendeeId) : null) ?? null;
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
