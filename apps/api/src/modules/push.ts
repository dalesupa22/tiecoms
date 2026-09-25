/**
 * Notificaciones push: registro del token por sesión y envío desde el worker.
 * Reciben: participantes activos que no son el autor, sin la conversación silenciada,
 * sin bloqueo con el autor, en todas sus sesiones activas con token.
 * Payload (APNs y FCM) en docs/PUSH.md.
 */
import type { PushData } from '@tiecoms/contracts';
import { pool, tx } from '../db.ts';
import { sendApns, sendFcm, type PushResult } from '../push-transport.ts';
import { summarize, summaryText } from './attachments.ts';

type Lang = 'es' | 'en';

export async function registerToken(sessionId: string, input: { provider: 'apns' | 'fcm'; token: string; environment: 'sandbox' | 'production'; lang?: Lang }, acceptLanguage?: string) {
  const lang: Lang = input.lang ?? (/^\s*en\b/i.test(acceptLanguage ?? '') ? 'en' : 'es');
  await tx(async (c) => {
    // Un token por sesión: el anterior de esta sesión se reemplaza; si el token venía de
    // otra sesión (se volvió a iniciar sesión en el mismo teléfono), pasa a esta.
    await c.query('DELETE FROM push_subscriptions WHERE session_id = $1 AND NOT (provider = $2 AND token = $3)', [sessionId, input.provider, input.token]);
    await c.query(
      `INSERT INTO push_subscriptions (session_id, provider, token, environment, lang) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (provider, token) DO UPDATE SET session_id = EXCLUDED.session_id, environment = EXCLUDED.environment,
         lang = EXCLUDED.lang, updated_at = now(), failures = 0, last_error = NULL`,
      [sessionId, input.provider, input.token, input.environment, lang],
    );
  });
  return { ok: true };
}

export async function removeToken(sessionId: string) {
  await pool.query('DELETE FROM push_subscriptions WHERE session_id = $1', [sessionId]);
  return { ok: true };
}

interface Target { user_id: string; sub_id: string; provider: 'apns' | 'fcm'; token: string; environment: 'sandbox' | 'production'; lang: Lang }

const ACTIVE_SESSION = `JOIN sessions s ON s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()
  JOIN push_subscriptions ps ON ps.session_id = s.id AND ps.provider IN ('apns', 'fcm')`;

/** No leídos de cada persona (conversaciones que puede leer y no tiene silenciadas): el globo del ícono. */
async function badges(userIds: string[]): Promise<Map<string, number>> {
  if (!userIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT m.user_id, COALESCE(sum(GREATEST(0, c.last_message_seq - GREATEST(COALESCE(rc.last_read_seq, 0), m.history_from_seq))), 0)::int AS n
       FROM conversation_memberships m
       JOIN conversations c ON c.id = m.conversation_id AND c.archived_at IS NULL
       LEFT JOIN workspace_memberships wm ON wm.workspace_id = c.workspace_id AND wm.user_id = m.user_id
       LEFT JOIN read_cursors rc ON rc.conversation_id = c.id AND rc.user_id = m.user_id
       LEFT JOIN conversation_prefs cp ON cp.conversation_id = c.id AND cp.user_id = m.user_id
      WHERE m.user_id = ANY($1) AND m.removed_at IS NULL
        AND (c.workspace_id IS NULL OR (wm.user_id IS NOT NULL AND wm.revoked_at IS NULL AND (wm.expires_at IS NULL OR wm.expires_at > now())))
        AND (cp.muted_until IS NULL OR cp.muted_until <= now())
      GROUP BY m.user_id`,
    [userIds],
  );
  return new Map(rows.map((r) => [r.user_id as string, r.n as number]));
}

/** «📷 2 fotos · texto» o solo el texto (≤ 180). */
function messageText(body: string, atts: any, lang: Lang) {
  const sum = summarize(atts);
  const text = [sum ? summaryText(sum, lang) : '', body.replace(/\s+/g, ' ').trim()].filter(Boolean).join(' · ');
  return clip(text, 180) || (lang === 'en' ? 'New message' : 'Mensaje nuevo');
}

/** Extracto del mensaje ancla (≤ 60) tal como lo ven los miembros del sidechat (mensaje side.started). */
async function sideExcerpt(sideId: string): Promise<string | null> {
  const { rows } = await pool.query("SELECT body FROM messages WHERE conversation_id = $1 AND kind = 'system' ORDER BY seq LIMIT 1", [sideId]);
  try { const p = JSON.parse(rows[0]?.body ?? '{}'); return p.k === 'side.started' && p.excerpt ? clip(String(p.excerpt), 60) : null; } catch { return null; }
}

const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

interface Note { title: string; subtitle?: string | null; body: string; threadId: string; category: string; data: PushData; collapseId?: string }

/** aps para iOS (Communication Notifications los completa la Notification Service Extension). */
export function apnsPayload(n: Note, badge: number) {
  return {
    aps: {
      alert: { title: n.title, ...(n.subtitle ? { subtitle: n.subtitle } : {}), body: n.body },
      badge, sound: 'tc_notify.caf', 'thread-id': n.threadId, category: n.category, 'mutable-content': 1,
    },
    ...n.data,
  };
}

/** FCM: todos los valores de `data` son texto. */
export function fcmData(n: Note, badge: number): Record<string, string> {
  const out: Record<string, string> = { title: n.title, subtitle: n.subtitle ?? '', body: n.body, badge: String(badge), threadId: n.threadId, category: n.category };
  for (const [k, v] of Object.entries(n.data)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') {
      // FCM solo lleva texto: el objeto va como JSON y además aplanado (sideOf → sideOfConversationId…).
      out[k] = JSON.stringify(v);
      for (const [k2, v2] of Object.entries(v)) if (v2 !== undefined && v2 !== null) out[`${k}${k2[0]!.toUpperCase()}${k2.slice(1)}`] = String(v2);
    } else out[k] = String(v);
  }
  return out;
}

export const pushStats = { sent: 0, failed: 0, removed: 0 };

async function deliver(targets: Target[], note: (t: Target) => Note) {
  if (!targets.length) return;
  const counts = await badges([...new Set(targets.map((t) => t.user_id))]);
  await Promise.all(targets.map(async (t) => {
    const n = note(t);
    const badge = counts.get(t.user_id) ?? 0;
    let r: PushResult;
    try {
      r = t.provider === 'apns'
        ? await sendApns(t.token, t.environment, apnsPayload(n, badge), { collapseId: n.collapseId })
        : await sendFcm(t.token, fcmData(n, badge), { collapseKey: n.threadId });
    } catch (e: any) { r = { ok: false, invalidToken: false, error: String(e?.message ?? e) }; }
    if (r.ok) {
      pushStats.sent++;
      await pool.query('UPDATE push_subscriptions SET failures = 0, last_error = NULL WHERE id = $1 AND failures > 0', [t.sub_id]);
    } else if (r.invalidToken) {
      pushStats.removed++;
      await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [t.sub_id]);
    } else if (!r.error.endsWith('not_configured')) {
      pushStats.failed++;
      await pool.query('UPDATE push_subscriptions SET failures = failures + 1, last_error = $2 WHERE id = $1', [t.sub_id, r.error.slice(0, 500)]);
      console.error(`[push] ${t.provider} falló: ${r.error}`);
    }
  }));
}

/** Mensaje de texto nuevo. */
export async function pushMessage(messageId: string) {
  const { rows } = await pool.query(
    `SELECT m.id, m.conversation_id, m.seq, m.author_id, m.body, m.attachments, m.deleted_at, m.kind, c.kind AS conv_kind, c.name AS conv_name,
            c.derive_kind, c.parent_conversation_id, c.parent_message_id,
            u.name AS author_name, u.avatar_file_id, o.name AS org_name
       FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN users u ON u.id = m.author_id
       LEFT JOIN organizations o ON o.id = u.primary_org_id WHERE m.id = $1`,
    [messageId],
  );
  const m = rows[0];
  if (!m || m.deleted_at || m.kind !== 'text') return 0;
  const { rows: targets } = await pool.query<Target>(
    `SELECT u.id AS user_id, ps.id AS sub_id, ps.provider, ps.token, ps.environment, ps.lang
       FROM conversation_memberships cm
       JOIN conversations c ON c.id = cm.conversation_id AND c.archived_at IS NULL
       JOIN users u ON u.id = cm.user_id AND u.disabled_at IS NULL
       ${ACTIVE_SESSION}
       LEFT JOIN workspace_memberships wm ON wm.workspace_id = c.workspace_id AND wm.user_id = u.id
       LEFT JOIN conversation_prefs cp ON cp.conversation_id = c.id AND cp.user_id = u.id
      WHERE cm.conversation_id = $1 AND cm.removed_at IS NULL AND cm.user_id <> $2 AND cm.history_from_seq < $3
        AND (c.workspace_id IS NULL OR (wm.user_id IS NOT NULL AND wm.revoked_at IS NULL AND (wm.expires_at IS NULL OR wm.expires_at > now())))
        AND (cp.muted_until IS NULL OR cp.muted_until <= now())
        AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = u.id AND b.blocked_id = $2) OR (b.blocker_id = $2 AND b.blocked_id = u.id))`,
    [m.conversation_id, m.author_id, m.seq],
  );
  const direct = m.conv_kind === 'direct';
  const avatar = m.avatar_file_id ? `/api/v1/avatars/${m.avatar_file_id}` : '';
  if (m.derive_kind === 'side') {
    // Sidechat: «💬 Sidechat de Ana», «Sobre: «…»» y la pregunta; categoría TC_SIDE con Responder en línea.
    const excerpt = await sideExcerpt(m.conversation_id);
    const sideOf = { conversationId: m.parent_conversation_id, messageId: m.parent_message_id, excerpt };
    await deliver(targets, (t) => ({
      title: t.lang === 'en' ? `💬 Sidechat from ${m.author_name}` : `💬 Sidechat de ${m.author_name}`,
      subtitle: excerpt ? `${t.lang === 'en' ? 'About' : 'Sobre'}: «${excerpt}»` : null,
      body: messageText(m.body, m.attachments, t.lang),
      threadId: m.conversation_id, category: 'TC_SIDE', collapseId: m.id,
      data: { type: 'side', conversationId: m.conversation_id, messageId: m.id, authorId: m.author_id, authorName: m.author_name, authorAvatarUrl: avatar, sideOf },
    }));
    return targets.length;
  }
  await deliver(targets, (t) => ({
    title: direct ? m.author_name : m.conv_name || m.author_name,
    subtitle: direct ? null : [m.author_name, m.org_name].filter(Boolean).join(' · '),
    body: messageText(m.body, m.attachments, t.lang),
    threadId: m.conversation_id, category: 'TC_MESSAGE', collapseId: m.id,
    data: { type: 'message', conversationId: m.conversation_id, messageId: m.id, authorId: m.author_id, authorName: m.author_name, authorAvatarUrl: avatar },
  }));
  return targets.length;
}

/** Recordatorio vencido: solo a su dueño (es personal: suena aunque la conversación esté silenciada). */
export async function pushReminder(reminderId: string) {
  const { rows } = await pool.query(
    `SELECT r.id, r.user_id, r.conversation_id, r.note, r.message_id, m.body, m.deleted_at, c.name AS conv_name
       FROM reminders r JOIN conversations c ON c.id = r.conversation_id LEFT JOIN messages m ON m.id = r.message_id
      WHERE r.id = $1 AND r.done_at IS NULL`,
    [reminderId],
  );
  const r = rows[0];
  if (!r) return 0;
  const { rows: targets } = await pool.query<Target>(
    `SELECT u.id AS user_id, ps.id AS sub_id, ps.provider, ps.token, ps.environment, ps.lang
       FROM users u ${ACTIVE_SESSION} WHERE u.id = $1 AND u.disabled_at IS NULL`,
    [r.user_id],
  );
  const text = r.note || (r.body && !r.deleted_at ? clip(r.body, 180) : '');
  await deliver(targets, (t) => ({
    title: t.lang === 'en' ? 'Reminder' : 'Recordatorio',
    subtitle: r.conv_name ?? null,
    body: text || (t.lang === 'en' ? 'You asked to be reminded about this conversation' : 'Pediste que te recordara esta conversación'),
    threadId: r.conversation_id, category: 'TC_REMINDER', collapseId: `reminder-${r.id}`,
    data: { type: 'reminder', conversationId: r.conversation_id, reminderId: r.id, ...(r.message_id ? { messageId: r.message_id } : {}) },
  }));
  return targets.length;
}

/** Convocatoria a una reunión: a los invitados (no a quien organiza), respetando el silencio. */
export async function pushEvent(eventId: string) {
  const { rows } = await pool.query(
    `SELECT e.id, e.conversation_id, e.title, e.starts_at, e.timezone, e.organizer_id, e.cancelled_at, c.name AS conv_name, u.name AS organizer_name, u.avatar_file_id
       FROM calendar_events e JOIN conversations c ON c.id = e.conversation_id JOIN users u ON u.id = e.organizer_id WHERE e.id = $1`,
    [eventId],
  );
  const e = rows[0];
  if (!e || e.cancelled_at) return 0;
  const { rows: targets } = await pool.query<Target>(
    `SELECT u.id AS user_id, ps.id AS sub_id, ps.provider, ps.token, ps.environment, ps.lang
       FROM calendar_event_invitees i
       JOIN users u ON u.id = i.user_id AND u.disabled_at IS NULL
       JOIN conversation_memberships cm ON cm.conversation_id = $2 AND cm.user_id = u.id AND cm.removed_at IS NULL
       ${ACTIVE_SESSION}
       LEFT JOIN conversation_prefs cp ON cp.conversation_id = $2 AND cp.user_id = u.id
      WHERE i.event_id = $1 AND i.user_id <> $3 AND (cp.muted_until IS NULL OR cp.muted_until <= now())`,
    [e.id, e.conversation_id, e.organizer_id],
  );
  const when = (lang: Lang) => {
    try {
      return new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'es-CO', { timeZone: e.timezone, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(e.starts_at));
    } catch { return new Date(e.starts_at).toISOString(); }
  };
  await deliver(targets, (t) => ({
    title: e.conv_name || e.organizer_name,
    subtitle: e.organizer_name,
    body: `${t.lang === 'en' ? 'New meeting' : 'Nueva reunión'}: ${clip(e.title, 120)} · ${when(t.lang)}`,
    threadId: e.conversation_id, category: 'TC_EVENT', collapseId: `event-${e.id}`,
    data: { type: 'event', conversationId: e.conversation_id, eventId: e.id, authorId: e.organizer_id, authorName: e.organizer_name, authorAvatarUrl: e.avatar_file_id ? `/api/v1/avatars/${e.avatar_file_id}` : '' },
  }));
  return targets.length;
}

/** Aviso «Empieza en 10 min»: a los invitados que calculó el worker (no depende del silencio: es una cita). */
export async function pushEventSoon(eventId: string, userIds: string[], minutes: number) {
  if (!userIds?.length) return 0;
  const { rows } = await pool.query(
    `SELECT e.id, e.conversation_id, e.title, e.cancelled_at, e.starts_at, c.kind AS conv_kind, c.name AS conv_name
       FROM calendar_events e JOIN conversations c ON c.id = e.conversation_id WHERE e.id = $1`,
    [eventId],
  );
  const e = rows[0];
  if (!e || e.cancelled_at || new Date(e.starts_at).getTime() < Date.now() - 60_000) return 0;
  const { rows: targets } = await pool.query<Target>(
    `SELECT u.id AS user_id, ps.id AS sub_id, ps.provider, ps.token, ps.environment, ps.lang
       FROM users u ${ACTIVE_SESSION}
       JOIN conversation_memberships cm ON cm.conversation_id = $2 AND cm.user_id = u.id AND cm.removed_at IS NULL
      WHERE u.id = ANY($1) AND u.disabled_at IS NULL`,
    [userIds, e.conversation_id],
  );
  await deliver(targets, (t) => ({
    title: t.lang === 'en' ? `Starts in ${minutes} min: ${clip(e.title, 100)}` : `Empieza en ${minutes} min: ${clip(e.title, 100)}`,
    subtitle: e.conv_kind === 'direct' ? null : e.conv_name ?? null,
    body: new Intl.DateTimeFormat(t.lang === 'en' ? 'en-US' : 'es-CO', { hour: 'numeric', minute: '2-digit' }).format(new Date(e.starts_at)),
    threadId: e.conversation_id, category: 'TC_EVENT', collapseId: `event-soon-${e.id}`,
    data: { type: 'event', conversationId: e.conversation_id, eventId: e.id, minutes },
  }));
  return targets.length;
}
