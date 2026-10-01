/**
 * Notificaciones push: registro del token por sesión y envío desde el worker.
 * Reciben: participantes activos que no son el autor, sin la conversación silenciada,
 * sin «No molestar» activo, sin bloqueo con el autor, en todas sus sesiones activas con token.
 * Payload (APNs y FCM) en docs/PUSH.md.
 */
import type { PushData } from '@tiecoms/contracts';
import { pool, tx } from '../db.ts';
import { sendApns, sendFcm, type PushResult } from '../push-transport.ts';
import { safePushReason } from '../push-reason.ts';
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

interface Target { user_id: string; sub_id: string; provider: 'apns' | 'fcm'; token: string; environment: 'sandbox' | 'production'; lang: Lang; mentioned?: boolean }

/**
 * Sesiones con token de quien no tiene «No molestar» activo ni está en su modo sueño (horario de descanso): con dnd_until > now() no sale ningún push
 * (mensajes, menciones, reacciones, reuniones, avisos de reunión ni recordatorios). Todas las consultas
 * de destinatarios pasan por aquí.
 */
const ACTIVE_SESSION = `JOIN sessions s ON s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()
    AND (u.dnd_until IS NULL OR u.dnd_until <= now())
    AND NOT tiecoms_sleeping(u.sleep_on, u.sleep_start, u.sleep_end, u.sleep_tz)
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
function messageText(body: string, atts: any, lang: Lang, viewOnce = false) {
  const sum = summarize(atts);
  // Una sola vista: nunca el contenido (docs/TANDA-1.7.md §7).
  if (viewOnce) {
    const en = lang === 'en';
    if (sum?.voices) return en ? '① Voice note' : '① Nota de voz';
    if (sum?.images) return en ? '① Photo' : '① Foto';
    return en ? '① Message' : '① Mensaje';
  }
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

/**
 * Recibo de cada envío en el log del worker: qué pasó con cada aviso (aceptado por APNs/FCM, token inválido
 * borrado, falla o sin configurar). Sin token, sin cuerpo ni título: ids internos y el código del proveedor.
 * «Aceptado» = el proveedor devolvió 200; NO prueba que el teléfono lo haya mostrado.
 */
function logDelivery(t: Target, n: Note, r: PushResult, cleanup?: 'removed' | 'not_present' | 'failed') {
  const reason = r.ok ? undefined : safePushReason(r.error);
  const result = r.ok ? 'accepted' : r.invalidToken ? cleanup === 'removed' ? 'invalid_token_removed' : 'invalid_token'
    : reason === 'apns_not_configured' || reason === 'fcm_not_configured' ? 'not_configured' : 'failed';
  console.log(JSON.stringify({
    evt: 'push.delivery', result, type: n.data.type, messageId: n.data.messageId ?? null, conversationId: n.data.conversationId ?? null,
    user: t.user_id, sub: t.sub_id, provider: t.provider, env: t.environment, ...(reason ? { reason } : {}), ...(cleanup ? { cleanup } : {}),
  }));
}

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
    if (!r.ok && r.invalidToken) {
      // Provider rejection is known; removal is not known until the DB confirms it.
      try {
        const removed = await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [t.sub_id]);
        if (removed.rowCount) pushStats.removed++;
        logDelivery(t, n, r, removed.rowCount ? 'removed' : 'not_present');
      } catch (error) { logDelivery(t, n, r, 'failed'); throw error; }
      return;
    }
    logDelivery(t, n, r);
    if (r.ok) {
      pushStats.sent++;
      await pool.query('UPDATE push_subscriptions SET failures = 0, last_error = NULL WHERE id = $1 AND failures > 0', [t.sub_id]);
    } else if (r.error !== 'apns_not_configured' && r.error !== 'fcm_not_configured') {
      pushStats.failed++;
      const reason = safePushReason(r.error);
      await pool.query('UPDATE push_subscriptions SET failures = failures + 1, last_error = $2 WHERE id = $1', [t.sub_id, reason]);
      console.error(`[push] ${t.provider} falló: ${reason}`);
    }
  }));
}

/**
 * Título de un grupo en las notificaciones: «Empresa - Grupo» (p. ej. «Xertify - General»), con la misma regla que
 * el árbol de Grupos (placeWorkspace): invitado → la empresa anfitriona; si en el espacio hay otra empresa que no
 * es mía → esa; relación pendiente → su nombre; si no → la empresa dueña (Tu organización). Por persona, porque
 * cada lado ve a la otra empresa. Directos y chats sin espacio no llevan etiqueta (mapa vacío).
 */
export async function groupLabels(conversationId: string, userIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const c = (await pool.query(
    `SELECT c.name, c.workspace_id, w.owning_org_id, w.counterpart_name, o.name AS owning_name
       FROM conversations c JOIN workspaces w ON w.id = c.workspace_id JOIN organizations o ON o.id = w.owning_org_id
      WHERE c.id = $1 AND c.kind <> 'direct'`,
    [conversationId],
  )).rows[0];
  if (!c || !userIds.length) return out;
  const orgs = (await pool.query(
    `SELECT wo.org_id, o.name FROM workspace_organizations wo JOIN organizations o ON o.id = wo.org_id
      WHERE wo.workspace_id = $1 AND wo.left_at IS NULL ORDER BY wo.joined_at, wo.org_id`,
    [c.workspace_id],
  )).rows as { org_id: string; name: string }[];
  const roles = new Map((await pool.query('SELECT user_id, role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = ANY($2)', [c.workspace_id, userIds]))
    .rows.map((r) => [r.user_id as string, r.role as string]));
  const mine = new Map<string, Set<string>>();
  for (const r of (await pool.query('SELECT user_id, org_id FROM organization_memberships WHERE user_id = ANY($1)', [userIds])).rows) {
    if (!mine.has(r.user_id)) mine.set(r.user_id, new Set());
    mine.get(r.user_id)!.add(r.org_id);
  }
  for (const u of new Set(userIds)) {
    const my = mine.get(u) ?? new Set<string>();
    const company = roles.get(u) === 'guest' ? c.owning_name
      : orgs.find((o) => !my.has(o.org_id))?.name ?? c.counterpart_name ?? c.owning_name;
    if (company && c.name) out.set(u, `${company} - ${c.name}`);
  }
  return out;
}

/** Mensaje de texto nuevo. */
export async function pushMessage(messageId: string) {
  const { rows } = await pool.query(
    `SELECT m.id, m.conversation_id, m.seq, m.author_id, m.body, m.attachments, m.deleted_at, m.kind, m.view_once, c.kind AS conv_kind, c.name AS conv_name,
            c.derive_kind, c.parent_conversation_id, c.parent_message_id,
            u.name AS author_name, u.avatar_file_id, o.name AS org_name
       FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN users u ON u.id = m.author_id
       LEFT JOIN organizations o ON o.id = u.primary_org_id WHERE m.id = $1`,
    [messageId],
  );
  const m = rows[0];
  if (!m || m.deleted_at || m.kind !== 'text') return 0;
  const { rows: targets } = await pool.query<Target>(
    `SELECT u.id AS user_id, ps.id AS sub_id, ps.provider, ps.token, ps.environment, ps.lang, (mm.user_id IS NOT NULL) AS mentioned
       FROM conversation_memberships cm
       JOIN conversations c ON c.id = cm.conversation_id AND c.archived_at IS NULL
       JOIN users u ON u.id = cm.user_id AND u.disabled_at IS NULL
       ${ACTIVE_SESSION}
       LEFT JOIN workspace_memberships wm ON wm.workspace_id = c.workspace_id AND wm.user_id = u.id
       LEFT JOIN conversation_prefs cp ON cp.conversation_id = c.id AND cp.user_id = u.id
       LEFT JOIN message_mentions mm ON mm.message_id = $4 AND mm.user_id = u.id
      WHERE cm.conversation_id = $1 AND cm.removed_at IS NULL AND cm.user_id <> $2 AND cm.history_from_seq < $3
        AND (c.workspace_id IS NULL OR (wm.user_id IS NOT NULL AND wm.revoked_at IS NULL AND (wm.expires_at IS NULL OR wm.expires_at > now())))
        -- Silenciada: solo pasa una mención, salvo el silencio «siempre» (más de un año).
        AND (cp.muted_until IS NULL OR cp.muted_until <= now() OR (mm.user_id IS NOT NULL AND cp.muted_until < now() + interval '366 days'))
        AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = u.id AND b.blocked_id = $2) OR (b.blocker_id = $2 AND b.blocked_id = u.id))`,
    [m.conversation_id, m.author_id, m.seq, m.id],
  );
  // Sin destinatarios: dejarlo dicho (sesión cerrada, sin token, silencio, DND o descanso), para no confundirlo con un envío.
  if (!targets.length) console.log(JSON.stringify({ evt: 'push.delivery', result: 'no_eligible_targets', type: 'message', messageId: m.id, conversationId: m.conversation_id }));
  const direct = m.conv_kind === 'direct';
  const avatar = m.avatar_file_id ? `/api/v1/avatars/${m.avatar_file_id}` : '';
  const labels = await groupLabels(m.conversation_id, targets.map((t) => t.user_id));
  const convTitle = (t: Target) => labels.get(t.user_id) ?? m.conv_name ?? null;
  // Mención: «Ana te mencionó» (subtitle = la conversación). Los demás reciben el push normal (o de sidechat).
  const mentionNote = (t: Target): Note => ({
    title: t.lang === 'en' ? `${m.author_name} mentioned you` : `${m.author_name} te mencionó`,
    subtitle: direct ? null : convTitle(t) || null,
    body: messageText(m.body, m.attachments, t.lang, m.view_once),
    threadId: m.conversation_id, category: 'TC_MESSAGE', collapseId: m.id,
    data: { type: 'mention', conversationId: m.conversation_id, messageId: m.id, authorId: m.author_id, authorName: m.author_name, authorAvatarUrl: avatar },
  });
  const mentionedTargets = targets.filter((t) => t.mentioned);
  if (mentionedTargets.length) await deliver(mentionedTargets, mentionNote);
  targets.splice(0, targets.length, ...targets.filter((t) => !t.mentioned));
  if (!targets.length) return mentionedTargets.length;
  if (m.derive_kind === 'side') {
    // Sidechat: «💬 Sidechat de Ana», «Sobre: «…»» y la pregunta; categoría TC_SIDE con Responder en línea.
    const excerpt = await sideExcerpt(m.conversation_id);
    const sideOf = { conversationId: m.parent_conversation_id, messageId: m.parent_message_id, excerpt };
    await deliver(targets, (t) => ({
      title: t.lang === 'en' ? `💬 Sidechat from ${m.author_name}` : `💬 Sidechat de ${m.author_name}`,
      subtitle: excerpt ? `${t.lang === 'en' ? 'About' : 'Sobre'}: «${excerpt}»` : null,
      body: messageText(m.body, m.attachments, t.lang, m.view_once),
      threadId: m.conversation_id, category: 'TC_SIDE', collapseId: m.id,
      data: { type: 'side', conversationId: m.conversation_id, messageId: m.id, authorId: m.author_id, authorName: m.author_name, authorAvatarUrl: avatar, sideOf },
    }));
    return targets.length;
  }
  await deliver(targets, (t) => ({
    title: direct ? m.author_name : convTitle(t) || m.author_name,
    subtitle: direct ? null : [m.author_name, m.org_name].filter(Boolean).join(' · '),
    body: messageText(m.body, m.attachments, t.lang, m.view_once),
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
  const labels = await groupLabels(r.conversation_id, [r.user_id]);
  await deliver(targets, (t) => ({
    title: t.lang === 'en' ? 'Reminder' : 'Recordatorio',
    subtitle: labels.get(t.user_id) ?? r.conv_name ?? null,
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
  const labels = await groupLabels(e.conversation_id, targets.map((t) => t.user_id));
  await deliver(targets, (t) => ({
    title: labels.get(t.user_id) || e.conv_name || e.organizer_name,
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
  const labels = await groupLabels(e.conversation_id, targets.map((t) => t.user_id));
  await deliver(targets, (t) => ({
    title: t.lang === 'en' ? `Starts in ${minutes} min: ${clip(e.title, 100)}` : `Empieza en ${minutes} min: ${clip(e.title, 100)}`,
    subtitle: e.conv_kind === 'direct' ? null : labels.get(t.user_id) ?? e.conv_name ?? null,
    body: new Intl.DateTimeFormat(t.lang === 'en' ? 'en-US' : 'es-CO', { hour: 'numeric', minute: '2-digit' }).format(new Date(e.starts_at)),
    threadId: e.conversation_id, category: 'TC_EVENT', collapseId: `event-soon-${e.id}`,
    data: { type: 'event', conversationId: e.conversation_id, eventId: e.id, minutes },
  }));
  return targets.length;
}

/**
 * Reacciones a mi mensaje: un solo aviso agrupado al autor («Ana y Beto reaccionaron 👍❤️ a «…»»).
 * No cambia el globo (no son mensajes) y respeta el silencio de la conversación y los bloqueos.
 */
export async function pushReaction(messageId: string) {
  const { rows } = await pool.query(
    `SELECT m.id, m.conversation_id, m.author_id, m.body, m.attachments, m.deleted_at, c.kind AS conv_kind, c.name AS conv_name
       FROM messages m JOIN conversations c ON c.id = m.conversation_id AND c.archived_at IS NULL WHERE m.id = $1`,
    [messageId],
  );
  const m = rows[0];
  if (!m || m.deleted_at || !m.author_id) return 0;
  const { recentReactions } = await import('./reactions.ts');
  const who = (await recentReactions(messageId)).filter((r) => r.user_id !== m.author_id);
  if (!who.length) return 0;
  const { rows: targets } = await pool.query<Target>(
    `SELECT u.id AS user_id, ps.id AS sub_id, ps.provider, ps.token, ps.environment, ps.lang
       FROM users u ${ACTIVE_SESSION}
       JOIN conversation_memberships cm ON cm.conversation_id = $2 AND cm.user_id = u.id AND cm.removed_at IS NULL
       LEFT JOIN conversation_prefs cp ON cp.conversation_id = $2 AND cp.user_id = u.id
      WHERE u.id = $1 AND u.disabled_at IS NULL AND (cp.muted_until IS NULL OR cp.muted_until <= now())
        AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = u.id AND b.blocked_id = ANY($3)) OR (b.blocked_id = u.id AND b.blocker_id = ANY($3)))`,
    [m.author_id, m.conversation_id, [...new Set(who.map((w) => w.user_id))]],
  );
  const names = [...new Set(who.map((w) => w.name.split(' ')[0]))];
  const emojis = [...new Set(who.map((w) => w.emoji))].slice(0, 5).join('');
  const labels = await groupLabels(m.conversation_id, targets.map((t) => t.user_id));
  await deliver(targets, (t) => {
    const en = t.lang === 'en';
    const people = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} ${en ? 'and' : 'y'} ${names[1]}`
      : `${names[0]} ${en ? `and ${names.length - 1} others` : `y ${names.length - 1} más`}`;
    return {
      title: `${people} ${en ? 'reacted' : names.length === 1 ? 'reaccionó' : 'reaccionaron'} ${emojis}`,
      subtitle: m.conv_kind === 'direct' ? null : labels.get(t.user_id) || m.conv_name || null,
      body: `«${messageText(m.body, m.attachments, t.lang)}»`,
      threadId: m.conversation_id, category: 'TC_MESSAGE', collapseId: `react-${m.id}`,
      data: { type: 'reaction', conversationId: m.conversation_id, messageId: m.id },
    };
  });
  return targets.length;
}

/** «Te asignaron una tarea»: al responsable nuevo (no a quien asignó), respetando No molestar y las noches. */
export async function pushIssueAssigned(issueId: string, ownerId: string, actorId: string) {
  const { rows } = await pool.query(
    `SELECT i.id, i.title, i.conversation_id, i.owner_id, i.assignee_ids, i.status, u.name AS actor_name,
            EXISTS (SELECT 1 FROM conversation_memberships cm WHERE cm.conversation_id = i.conversation_id AND cm.user_id = $2 AND cm.removed_at IS NULL) AS in_chat
       FROM issues i JOIN users u ON u.id = $3 WHERE i.id = $1`,
    [issueId, ownerId, actorId],
  );
  const r = rows[0];
  if (!r || (r.owner_id !== ownerId && !(r.assignee_ids ?? []).includes(ownerId)) || r.status === 'done' || r.status === 'cancelled') return 0;
  const { rows: targets } = await pool.query<Target>(
    `SELECT u.id AS user_id, ps.id AS sub_id, ps.provider, ps.token, ps.environment, ps.lang
       FROM users u ${ACTIVE_SESSION} WHERE u.id = $1 AND u.disabled_at IS NULL`,
    [ownerId],
  );
  // El nombre del grupo solo si la persona está en él (un tercero asignado no lo ve).
  const labels = r.in_chat ? await groupLabels(r.conversation_id, [ownerId]) : new Map<string, string>();
  await deliver(targets, (t) => ({
    title: t.lang === 'en' ? `${r.actor_name} assigned you a task` : `${r.actor_name} te asignó una tarea`,
    subtitle: labels.get(t.user_id) ?? null,
    body: clip(r.title, 180),
    threadId: r.in_chat ? r.conversation_id : `issue-${r.id}`, category: 'TC_ISSUE', collapseId: `issue-${r.id}`,
    data: { type: 'issue', issueId: r.id, conversationId: r.conversation_id, inChat: !!r.in_chat },
  }));
  return targets.length;
}

/** «No cumplimos» (tanda 1.7): la tarea venció. Al responsable, con la categoría de tarea. */
export async function pushIssueOverdue(issueId: string, ownerId: string, dueDate: string) {
  const { rows } = await pool.query(
    `SELECT i.id, i.title, i.conversation_id, i.owner_id, i.assignee_ids, i.status, to_char(i.due_date, 'YYYY-MM-DD') AS due,
            EXISTS (SELECT 1 FROM conversation_memberships cm WHERE cm.conversation_id = i.conversation_id AND cm.user_id = $2 AND cm.removed_at IS NULL) AS in_chat
       FROM issues i WHERE i.id = $1`,
    [issueId, ownerId],
  );
  const r = rows[0];
  if (!r || (r.owner_id !== ownerId && !(r.assignee_ids ?? []).includes(ownerId)) || r.status === 'done' || r.status === 'cancelled' || r.due !== dueDate) return 0;
  const { rows: targets } = await pool.query<Target>(
    `SELECT u.id AS user_id, ps.id AS sub_id, ps.provider, ps.token, ps.environment, ps.lang
       FROM users u ${ACTIVE_SESSION} WHERE u.id = $1 AND u.disabled_at IS NULL`,
    [ownerId],
  );
  const labels = r.in_chat && r.conversation_id ? await groupLabels(r.conversation_id, [ownerId]) : new Map<string, string>();
  await deliver(targets, (t) => ({
    title: t.lang === 'en' ? '😢 We missed it' : '😢 No cumplimos',
    subtitle: labels.get(t.user_id) ?? null,
    body: clip(t.lang === 'en' ? `${r.title} was due on ${r.due}` : `${r.title} venció el ${r.due}`, 180),
    threadId: r.in_chat ? r.conversation_id : `issue-${r.id}`, category: 'TC_ISSUE', collapseId: `issue-overdue-${r.id}`,
    data: { type: 'issue', issueId: r.id, conversationId: r.conversation_id ?? '', inChat: !!r.in_chat },
  }));
  return targets.length;
}

/**
 * Llamada entrante (docs/LLAMADAS.md): push para quien tiene la app cerrada. category TC_CALL y data.type 'call'
 * para que las apps muestren Contestar / Ahora no. No sale con «No molestar» ni en modo sueño (ACTIVE_SESSION).
 */
/**
 * «Llamada perdida»: mismo collapseId que el aviso entrante, así lo reemplaza. Va como tipo message (abre el chat)
 * para que las apps publicadas lo muestren. Sin push con No molestar ni en modo sueño (ACTIVE_SESSION).
 */
export async function pushCallMissed(p: { callId: string; userIds: string[] }) {
  if (!p.userIds?.length) return 0;
  const { rows } = await pool.query(
    `SELECT c.id, c.conversation_id, c.kind, u.name AS caller, cv.name AS title, cv.kind AS conv_kind
       FROM calls c JOIN users u ON u.id = c.started_by JOIN conversations cv ON cv.id = c.conversation_id WHERE c.id = $1`,
    [p.callId],
  );
  const call = rows[0];
  if (!call) return 0;
  const { rows: targets } = await pool.query<Target>(
    `SELECT u.id AS user_id, ps.id AS sub_id, ps.provider, ps.token, ps.environment, ps.lang
       FROM users u ${ACTIVE_SESSION} WHERE u.id = ANY($1) AND u.disabled_at IS NULL`,
    [p.userIds],
  );
  await deliver(targets, (t) => ({
    title: clip(call.caller ?? 'chaggu', 80),
    subtitle: call.conv_kind !== 'direct' && call.title ? clip(call.title, 80) : null,
    body: t.lang === 'en' ? (call.kind === 'video' ? '🎥 Missed video call' : '📞 Missed call') : (call.kind === 'video' ? '🎥 Videollamada perdida' : '📞 Llamada perdida'),
    threadId: call.conversation_id, category: 'TC_MESSAGE', collapseId: `call-${call.id}`,
    data: { type: 'message', callMissed: call.id, conversationId: call.conversation_id },
  }));
  return targets.length;
}

export async function pushCall(p: { callId: string; userIds: string[]; callerName: string; title: string | null }) {
  if (!p.userIds?.length) return 0;
  const { rows } = await pool.query('SELECT id, conversation_id, kind, ended_at FROM calls WHERE id = $1', [p.callId]);
  const call = rows[0];
  if (!call || call.ended_at) return 0;
  const { rows: targets } = await pool.query<Target>(
    `SELECT u.id AS user_id, ps.id AS sub_id, ps.provider, ps.token, ps.environment, ps.lang
       FROM users u ${ACTIVE_SESSION} WHERE u.id = ANY($1) AND u.disabled_at IS NULL`,
    [p.userIds],
  );
  await deliver(targets, (t) => ({
    title: clip(p.callerName, 80),
    subtitle: p.title ? clip(p.title, 80) : null,
    body: t.lang === 'en' ? (call.kind === 'video' ? '🎥 Video call' : '📞 Calling you') : (call.kind === 'video' ? '🎥 Videollamada' : '📞 Te está llamando'),
    threadId: call.conversation_id, category: 'TC_CALL', collapseId: `call-${call.id}`,
    data: { type: 'call', callId: call.id, conversationId: call.conversation_id, kind: call.kind },
  }));
  return targets.length;
}
