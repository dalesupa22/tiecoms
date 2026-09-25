/**
 * Notas de voz: transcripción (job voice.transcribe), variante reproducible AAC y reintento manual.
 * Al terminar actualiza messages.attachments y emite message.updated (sin push).
 */
import { conversationAccess } from '../access.ts';
import { pool, tx, type Tx } from '../db.ts';
import { ApiError, badRequest, notFound } from '../errors.ts';
import { getObject, putObject } from '../storage.ts';
import { readable, toDTO } from './attachments.ts';
import { appendEvent, toMessageDTO } from './messages.ts';
import { PCM_RATE, PLAYABLE, chunkPcm, getSummarizer, getTranscriber, toAac, toPcm16, waveformFromPcm } from './voice-providers.ts';

const SUMMARY_AFTER_MS = 45_000;
const LOCALE: Record<string, string> = { es: 'es-CO', en: 'en-US' };

/** Vuelve a escribir los adjuntos del mensaje (orden de envío) y avisa a la conversación. */
export async function refreshMessage(c: Tx, messageId: string) {
  const { rows } = await c.query('SELECT * FROM attachments WHERE message_id = $1 AND deleted_at IS NULL ORDER BY position', [messageId]);
  const up = await c.query('UPDATE messages SET attachments = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING *', [messageId, JSON.stringify(rows.map(toDTO))]);
  if (!up.rows[0]) return;
  const message = toMessageDTO(up.rows[0]);
  await appendEvent(c, message.conversationId, { type: 'message.updated', conversationId: message.conversationId, message }, messageId);
}

async function save(attachmentId: string, patch: { transcript?: object; waveform?: number[] | null; playKey?: string; playType?: string }) {
  await tx(async (c) => {
    const { rows } = await c.query(
      `UPDATE attachments SET transcript = COALESCE(transcript, '{}'::jsonb) || COALESCE($2::jsonb, '{}'::jsonb),
              waveform = CASE WHEN $3::jsonb IS NULL THEN waveform ELSE $3::jsonb END,
              play_key = COALESCE($4, play_key), play_type = COALESCE($5, play_type)
        WHERE id = $1 RETURNING message_id`,
      [attachmentId, patch.transcript ? JSON.stringify(patch.transcript) : null, patch.waveform ? JSON.stringify(patch.waveform) : null, patch.playKey ?? null, patch.playType ?? null],
    );
    if (rows[0]?.message_id) await refreshMessage(c, rows[0].message_id);
  });
}

/** Idioma preferido del autor: el de sus dispositivos con push o el que mandó al subir; español por defecto. */
async function authorLang(a: any): Promise<'es' | 'en'> {
  const { rows } = await pool.query(
    `SELECT ps.lang FROM push_subscriptions ps JOIN sessions s ON s.id = ps.session_id
      WHERE s.user_id = $1 AND s.revoked_at IS NULL ORDER BY ps.updated_at DESC LIMIT 1`,
    [a.owner_id],
  );
  const l = rows[0]?.lang ?? a.transcript?.requestedLanguage;
  return l === 'en' ? 'en' : 'es';
}

/** Job del worker. Nunca lanza: los fallos quedan en transcript.status = 'failed' (reintento manual). */
export async function transcribeAttachment(attachmentId: string) {
  const { rows } = await pool.query("SELECT * FROM attachments WHERE id = $1 AND kind = 'voice' AND deleted_at IS NULL", [attachmentId]);
  const a = rows[0];
  if (!a) return;
  const transcriber = getTranscriber();
  if (!transcriber) { await save(a.id, { transcript: { status: 'disabled' } }); return; }
  try {
    const original = (await getObject(a.s3_key)).body;
    // Variante reproducible (webm/ogg no suenan en todas partes). Si falla, la nota sigue con el original.
    let playKey: string | undefined;
    if (!PLAYABLE.has(a.content_type) && !a.play_key) {
      try {
        const aac = await toAac(original);
        playKey = `${a.s3_key}.m4a`;
        await putObject(playKey, aac, 'audio/mp4');
      } catch (e: any) { console.error('[voice] sin variante AAC', e?.message); }
    }
    const pcm = await toPcm16(original);
    const lang = await authorLang(a);
    const parts: string[] = [];
    let detected: string | null = null;
    for (const chunk of chunkPcm(pcm)) {
      const r = await transcriber.transcribe(chunk, PCM_RATE, LOCALE[lang]!);
      if (r.text) parts.push(r.text);
      detected ??= r.language;
    }
    const text = parts.join(' ').replace(/\s+/g, ' ').trim();
    const durationMs = a.duration_ms ?? Math.round((pcm.length / 2 / PCM_RATE) * 1000);
    let summary: string | null = null, suggestedIssue: string | null = null;
    const summarizer = getSummarizer();
    if (summarizer && text.split(/\s+/).length >= 6) {
      try { ({ summary, suggestedIssue } = await summarizer.summarize(text, { language: lang, wantSummary: durationMs > SUMMARY_AFTER_MS })); }
      catch (e: any) { console.error('[voice] resumen', e?.message); }
    }
    if (a.duration_ms == null) await pool.query('UPDATE attachments SET duration_ms = $2 WHERE id = $1', [a.id, durationMs]);
    await save(a.id, {
      transcript: { status: 'done', text, language: detected ?? LOCALE[lang], summary, suggestedIssue, provider: transcriber.name, error: null },
      waveform: a.waveform?.length ? null : waveformFromPcm(pcm), playKey, playType: playKey ? 'audio/mp4' : undefined,
    });
  } catch (e: any) {
    console.error(`[voice] transcripción ${a.id} falló`, e?.message);
    await save(a.id, { transcript: { status: 'failed', error: String(e?.message ?? e).slice(0, 300) } });
  }
}

/** Reintento manual: el autor o cualquiera que pueda escribir en la conversación. */
export async function retryTranscription(userId: string, attachmentId: string) {
  const a = await readable(userId, attachmentId);
  if (a.kind !== 'voice') throw badRequest('Solo las notas de voz se transcriben');
  if (!a.message_id) throw badRequest('Envía la nota antes de transcribirla');
  await conversationAccess(pool, userId, a.conversation_id, 'post');
  if (!getTranscriber()) throw new ApiError(503, 'transcription_disabled', 'La transcripción no está configurada en el servidor');
  if (a.transcript?.status === 'pending') return toDTO(a);
  await tx(async (c) => {
    await c.query(`UPDATE attachments SET transcript = COALESCE(transcript, '{}'::jsonb) || '{"status":"pending"}'::jsonb WHERE id = $1`, [a.id]);
    await c.query("INSERT INTO jobs (kind, payload, max_attempts) VALUES ('voice.transcribe', $1, 1)", [JSON.stringify({ attachmentId: a.id })]);
    await refreshMessage(c, a.message_id);
  });
  const { rows } = await pool.query('SELECT * FROM attachments WHERE id = $1', [a.id]);
  if (!rows[0]) throw notFound('Adjunto');
  return toDTO(rows[0]);
}
