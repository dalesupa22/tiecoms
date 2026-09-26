/**
 * Guardado de lo que llega de WhatsApp (credenciales cifradas, contactos, chats,
 * mensajes) y reenvío a TieComs de los chats vinculados. Lo usa src/wa-bridge.ts.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  BufferJSON, getContentType, initAuthCreds, isJidGroup, jidNormalizedUser, normalizeMessageContent, proto, toNumber,
  type AuthenticationCreds, type Chat, type Contact, type GroupMetadata, type SignalDataSet, type SignalDataTypeMap, type WAMessage, type WASocket,
} from 'baileys';
import { config } from '../config.ts';
import { enqueueOutbox, pool, tx } from '../db.ts';
import { sendMessage } from './messages.ts';
import { externalReaction } from './reactions.ts';
import { suggestCategory } from './wa-organize.ts';

// ---------- Cifrado de credenciales ----------
const KEY = createHash('sha256').update(`tiecoms-wa-store:${process.env.WA_STORE_KEY ?? config.jwtSecret}`).digest();

function seal(value: unknown): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([c.update(JSON.stringify(value, BufferJSON.replacer), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}
function open(buf: Buffer): any {
  const d = createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'), BufferJSON.reviver);
}

export async function dbAuthState(accountId: string) {
  const { rows } = await pool.query("SELECT value FROM wa_auth WHERE account_id = $1 AND key = 'creds'", [accountId]);
  const creds: AuthenticationCreds = rows[0] ? open(rows[0].value) : initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
          const out: { [id: string]: SignalDataTypeMap[T] } = {};
          if (!ids.length) return out;
          const r = await pool.query('SELECT key, value FROM wa_auth WHERE account_id = $1 AND key = ANY($2)', [accountId, ids.map((id) => `${type}:${id}`)]);
          for (const row of r.rows) {
            let v = open(row.value);
            if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
            out[row.key.slice(type.length + 1)] = v;
          }
          return out;
        },
        async set(data: SignalDataSet) {
          const up: [string, Buffer][] = [];
          const del: string[] = [];
          for (const type in data) {
            for (const [id, v] of Object.entries((data as any)[type] ?? {})) {
              if (v) up.push([`${type}:${id}`, seal(v)]); else del.push(`${type}:${id}`);
            }
          }
          if (up.length) {
            await pool.query(
              `INSERT INTO wa_auth (account_id, key, value) SELECT $1, k, v FROM unnest($2::text[], $3::bytea[]) AS t(k, v)
               ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value`,
              [accountId, up.map((x) => x[0]), up.map((x) => x[1])],
            );
          }
          if (del.length) await pool.query('DELETE FROM wa_auth WHERE account_id = $1 AND key = ANY($2)', [accountId, del]);
        },
      },
    },
    async saveCreds() {
      await pool.query(
        `INSERT INTO wa_auth (account_id, key, value) VALUES ($1, 'creds', $2)
         ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value`,
        [accountId, seal(creds)],
      );
    },
  };
}

// ---------- Contenido de los mensajes ----------
export function describe(msg: WAMessage): { kind: string; body: string } | null {
  const c = normalizeMessageContent(msg.message);
  if (!c) return null;
  const type = getContentType(c);
  const cap = (s?: string | null) => (s ? ` ${s}` : '');
  switch (type) {
    case 'conversation': return c.conversation ? { kind: 'text', body: c.conversation } : null;
    case 'extendedTextMessage': return c.extendedTextMessage?.text ? { kind: 'text', body: c.extendedTextMessage.text } : null;
    case 'imageMessage': return { kind: 'image', body: `📷${cap(c.imageMessage?.caption) || ' Foto'}` };
    case 'videoMessage': return { kind: 'video', body: `🎥${cap(c.videoMessage?.caption) || ' Video'}` };
    case 'audioMessage': return { kind: 'audio', body: c.audioMessage?.ptt ? '🎤 Nota de voz' : '🎵 Audio' };
    case 'documentMessage': return { kind: 'document', body: `📄 ${c.documentMessage?.fileName ?? 'Documento'}${c.documentMessage?.caption ? ` — ${c.documentMessage.caption}` : ''}` };
    case 'documentWithCaptionMessage': return describe({ ...msg, message: c.documentWithCaptionMessage?.message } as WAMessage);
    case 'stickerMessage': return { kind: 'sticker', body: '💟 Sticker' };
    case 'locationMessage': return { kind: 'location', body: `📍 ${c.locationMessage?.name ?? c.locationMessage?.address ?? 'Ubicación'}` };
    case 'liveLocationMessage': return { kind: 'location', body: '📍 Ubicación en tiempo real' };
    case 'contactMessage': return { kind: 'contact', body: `👤 ${c.contactMessage?.displayName ?? 'Contacto'}` };
    case 'contactsArrayMessage': return { kind: 'contact', body: `👤 ${c.contactsArrayMessage?.contacts?.length ?? ''} contactos` };
    case 'pollCreationMessage': case 'pollCreationMessageV2': case 'pollCreationMessageV3': {
      const p = c.pollCreationMessage ?? c.pollCreationMessageV2 ?? c.pollCreationMessageV3;
      return { kind: 'poll', body: `📊 ${p?.name ?? 'Encuesta'}${p?.options?.length ? `\n${p.options.map((o) => `• ${o.optionName}`).join('\n')}` : ''}` };
    }
    case 'eventMessage': return { kind: 'event', body: `📅 ${c.eventMessage?.name ?? 'Evento'}` };
    case 'buttonsResponseMessage': return { kind: 'text', body: c.buttonsResponseMessage?.selectedDisplayText ?? '' };
    case 'listResponseMessage': return { kind: 'text', body: c.listResponseMessage?.title ?? '' };
    case 'templateMessage': return { kind: 'text', body: c.templateMessage?.hydratedTemplate?.hydratedContentText ?? '' };
    default: return null; // reacciones, protocolo, cifrado pendiente, etc.
  }
}

export const skipJid = (jid?: string | null) => !jid || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast');
export const tsOf = (t: WAMessage['messageTimestamp']) => new Date(toNumber(t as any) * 1000);

// ---------- Sesión ----------
export interface Session {
  id: string;
  userId: string;
  kind: 'personal' | 'business';
  pairPhone: string | null;
  sock: WASocket | null;
  stopping: boolean;
  retries: number;
  registered: boolean;
  me: string | null;
  notifyTimer: NodeJS.Timeout | null;
}
export async function setStatus(id: string, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  await pool.query(
    `UPDATE wa_accounts SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
    [id, ...keys.map((k) => fields[k])],
  );
}

/** Avisa a los dispositivos del dueño que hay novedades (agrupado cada 2 s). */
export function notifyOwner(s: Session) {
  if (s.notifyTimer) return;
  s.notifyTimer = setTimeout(() => {
    s.notifyTimer = null;
    void tx((c) => enqueueOutbox(c, 'account.event', { userIds: [s.userId], event: { type: 'whatsapp.updated', accountId: s.id } })).catch(() => {});
  }, 2000);
}

export async function upsertContacts(s: Session, contacts: Partial<Contact>[]) {
  const rows: [string, string][] = [];
  for (const ct of contacts) {
    const name = ct.name || ct.verifiedName || ct.notify;
    if (!name) continue;
    // El mismo contacto puede llegar como número (@s.whatsapp.net) o como LID: se guarda con ambos.
    for (const jid of new Set([ct.id, ct.phoneNumber, ct.lid].filter(Boolean) as string[])) rows.push([jidNormalizedUser(jid), name]);
  }
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500);
    await pool.query(
      `INSERT INTO wa_contacts (account_id, jid, name) SELECT $1, j, n FROM unnest($2::text[], $3::text[]) AS t(j, n)
       ON CONFLICT (account_id, jid) DO UPDATE SET name = EXCLUDED.name`,
      [s.id, part.map((r) => r[0]), part.map((r) => r[1])],
    );
  }
}

export interface ChatRow { jid: string; name: string | null; isGroup: boolean; participants?: number | null; description?: string | null; lastAt?: Date | null; unread?: number | null; archived?: boolean | null }

export async function upsertChats(s: Session, chats: ChatRow[]) {
  const list = chats.filter((c) => !skipJid(c.jid));
  for (let i = 0; i < list.length; i += 300) {
    const part = list.slice(i, i + 300);
    const params = [s.id, part.map((c) => c.jid), part.map((c) => c.name), part.map((c) => c.isGroup), part.map((c) => c.participants ?? null),
      part.map((c) => c.description ?? null), part.map((c) => c.lastAt ?? null), part.map((c) => c.unread ?? null), part.map((c) => c.archived ?? null),
      part.map((c) => suggestCategory(c.name, { isGroup: c.isGroup, accountKind: s.kind }))];
    const src = `unnest($2::text[], $3::text[], $4::boolean[], $5::int[], $6::text[], $7::timestamptz[], $8::int[], $9::boolean[], $10::text[])
                   AS t(jid, name, is_group, participants, description, last_at, unread, archived, category)`;
    // Nuevos con sus valores por defecto; luego se actualiza solo lo que vino (un null no borra lo que ya había).
    await pool.query(
      `INSERT INTO wa_chats (account_id, jid, is_group, category) SELECT $1, t.jid, t.is_group, t.category FROM ${src}
       ON CONFLICT (account_id, jid) DO NOTHING`,
      params,
    );
    await pool.query(
      `UPDATE wa_chats c SET
         name = COALESCE(t.name, c.name),
         is_group = t.is_group OR c.is_group,
         participants = COALESCE(t.participants, c.participants),
         description = COALESCE(t.description, c.description),
         last_message_at = GREATEST(t.last_at, c.last_message_at),
         unread = COALESCE(t.unread, c.unread),
         wa_archived = COALESCE(t.archived, c.wa_archived),
         category = CASE WHEN c.category_manual OR t.name IS NULL THEN c.category ELSE t.category END,
         updated_at = now()
        FROM ${src}
       WHERE c.account_id = $1 AND c.jid = t.jid`,
      params,
    );
  }
}

export function chatFromWa(c: Partial<Chat>): ChatRow | null {
  if (!c.id) return null;
  const jid = jidNormalizedUser(c.id) || c.id;
  const ts = c.conversationTimestamp ? toNumber(c.conversationTimestamp as any) : 0;
  return {
    jid, name: c.name ?? (c as any).subject ?? null, isGroup: !!isJidGroup(jid),
    lastAt: ts ? new Date(ts * 1000) : null,
    unread: typeof c.unreadCount === 'number' ? Math.max(0, c.unreadCount) : null,
    archived: typeof c.archived === 'boolean' ? c.archived : null,
  };
}

export function groupRow(g: GroupMetadata): ChatRow {
  return { jid: g.id, name: g.subject || null, isGroup: true, participants: g.size ?? g.participants?.length ?? null, description: g.desc ?? null };
}

export interface MsgRow { chat: string; id: string; fromMe: boolean; authorJid: string | null; authorName: string | null; kind: string; body: string; sentAt: Date }

export function msgRow(s: Session, m: WAMessage): MsgRow | null {
  const chat = m.key.remoteJid ? jidNormalizedUser(m.key.remoteJid) || m.key.remoteJid : null;
  if (!chat || skipJid(chat) || !m.key.id) return null;
  const d = describe(m);
  if (!d || !d.body.trim()) return null;
  const fromMe = !!m.key.fromMe;
  const author = fromMe ? s.me : (isJidGroup(chat) ? (m.key.participant ?? (m.key as any).participantAlt ?? null) : chat);
  return {
    chat, id: m.key.id, fromMe, authorJid: author ? jidNormalizedUser(author) : null,
    authorName: fromMe ? null : (m.pushName ?? null), kind: d.kind, body: d.body.slice(0, 8000), sentAt: tsOf(m.messageTimestamp),
  };
}

export async function storeMessages(s: Session, rows: MsgRow[], live: boolean) {
  if (!rows.length) return [] as MsgRow[];
  const inserted: MsgRow[] = [];
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500);
    const r = await pool.query(
      `INSERT INTO wa_messages (account_id, chat_jid, id, from_me, author_jid, author_name, kind, body, sent_at)
       SELECT $1, * FROM unnest($2::text[], $3::text[], $4::boolean[], $5::text[], $6::text[], $7::text[], $8::text[], $9::timestamptz[])
       ON CONFLICT DO NOTHING RETURNING chat_jid, id`,
      [s.id, part.map((m) => m.chat), part.map((m) => m.id), part.map((m) => m.fromMe), part.map((m) => m.authorJid),
        part.map((m) => m.authorName), part.map((m) => m.kind), part.map((m) => m.body), part.map((m) => m.sentAt)],
    );
    const got = new Set(r.rows.map((x) => `${x.chat_jid}|${x.id}`));
    inserted.push(...part.filter((m) => got.has(`${m.chat}|${m.id}`)));
  }
  // Último mensaje por chat: vista previa, orden y no leídos.
  const latest = new Map<string, { m: MsgRow; unread: number }>();
  for (const m of inserted) {
    const cur = latest.get(m.chat);
    const add = live && !m.fromMe ? 1 : 0;
    if (!cur) latest.set(m.chat, { m, unread: add });
    else { cur.unread += add; if (m.sentAt > cur.m.sentAt) cur.m = m; }
  }
  const newChats: ChatRow[] = [];
  for (const [jid, { m, unread }] of latest) {
    const preview = `${m.fromMe ? 'Tú: ' : m.authorName && isJidGroup(jid) ? `${m.authorName}: ` : ''}${m.body}`.slice(0, 160);
    const r = await pool.query(
      `UPDATE wa_chats SET
          last_preview = CASE WHEN last_message_at IS NULL OR $3 >= last_message_at OR last_preview IS NULL THEN $4 ELSE last_preview END,
          last_message_at = GREATEST(last_message_at, $3),
          unread = CASE WHEN $6 AND $5 = 0 AND $7 THEN 0 ELSE unread + $5 END,
          updated_at = now()
        WHERE account_id = $1 AND jid = $2`,
      [s.id, jid, m.sentAt, preview, unread, live, m.fromMe],
    );
    if (!r.rowCount) newChats.push({ jid, name: isJidGroup(jid) ? null : m.authorName, isGroup: !!isJidGroup(jid), lastAt: m.sentAt, unread });
  }
  if (newChats.length) {
    await upsertChats(s, newChats);
    for (const c of newChats) {
      await pool.query('UPDATE wa_chats SET last_preview = $3 WHERE account_id = $1 AND jid = $2', [s.id, c.jid, latest.get(c.jid)!.m.body.slice(0, 160)]);
      // Grupo nuevo: se pide su nombre y tamaño.
      if (c.isGroup && s.sock) void s.sock.groupMetadata(c.jid).then((g) => upsertChats(s, [groupRow(g)])).catch(() => {});
    }
  }
  return inserted;
}

/** Chats vinculados a una conversación de TieComs: los mensajes nuevos llegan allí como reenviados de WhatsApp. */
export async function bridgeToTieComs(s: Session, rows: MsgRow[]) {
  if (!rows.length) return;
  const { rows: links } = await pool.query(
    `SELECT jid, linked_conversation_id, linked_since, name FROM wa_chats WHERE account_id = $1 AND jid = ANY($2) AND linked_conversation_id IS NOT NULL`,
    [s.id, [...new Set(rows.map((r) => r.chat))]],
  );
  if (!links.length) return;
  const byJid = new Map(links.map((l) => [l.jid, l]));
  const { rows: me } = await pool.query('SELECT push_name FROM wa_accounts WHERE id = $1', [s.id]);
  for (const m of rows.sort((a, b) => +a.sentAt - +b.sentAt)) {
    const l = byJid.get(m.chat);
    if (!l || m.sentAt < new Date(l.linked_since)) continue;
    const author = m.fromMe ? (me[0]?.push_name ?? 'Yo') : (m.authorName ?? m.authorJid?.split('@')[0] ?? null);
    const clientMessageId = bridgedClientId(s.id, m.chat, m.id);
    try {
      await sendMessage(s.userId, l.linked_conversation_id, {
        clientMessageId, body: m.body,
        forwarded: { source: 'whatsapp', author: author?.slice(0, 120) ?? null, sentAt: m.sentAt.toISOString() },
      });
    } catch (e: any) {
      // Sin permiso para publicar allí (salió de la conversación, se archivó): se desvincula.
      if (e?.status === 403 || e?.status === 404) {
        await pool.query('UPDATE wa_chats SET linked_conversation_id = NULL, linked_since = NULL WHERE account_id = $1 AND jid = $2', [s.id, m.chat]);
        byJid.delete(m.chat);
      } else console.error(`[wa] no pude reenviar ${m.id} a TieComs`, e?.message);
    }
  }
}

/** Después del historial: se clasifican de nuevo los chats sin nombre propio usando el nombre del contacto. */
export async function organizeAccount(s: Session) {
  const { rows } = await pool.query(
    `SELECT c.jid, COALESCE(c.name, ct.name) AS name, c.is_group, c.category FROM wa_chats c
       LEFT JOIN wa_contacts ct ON ct.account_id = c.account_id AND ct.jid = c.jid
      WHERE c.account_id = $1 AND NOT c.category_manual`,
    [s.id],
  );
  for (const r of rows) {
    const cat = suggestCategory(r.name, { isGroup: r.is_group, accountKind: s.kind });
    if (cat !== r.category) await pool.query('UPDATE wa_chats SET category = $3 WHERE account_id = $1 AND jid = $2', [s.id, r.jid, cat]);
  }
}

/** id de TieComs del mensaje reenviado desde WhatsApp (mismo clientMessageId que bridgeToTieComs). */
const bridgedClientId = (accountId: string, chat: string, id: string) => `wa-${createHash('sha256').update(`${accountId}|${chat}|${id}`).digest('hex').slice(0, 40)}`;

/**
 * Reacción de WhatsApp (reactionMessage): se guarda en el mensaje de WhatsApp y, si el chat está vinculado,
 * en el mensaje reenviado a TieComs como reacción externa («Laura · WhatsApp»). Texto vacío = la quitó.
 */
export async function storeReaction(s: Session, m: WAMessage) {
  const r = m.message?.reactionMessage;
  const target = r?.key;
  const rawChat = target?.remoteJid ?? m.key.remoteJid;
  const chat = rawChat ? jidNormalizedUser(rawChat) || rawChat : null;
  if (!r || !target?.id || !chat || skipJid(chat)) return;
  const reactorRaw = m.key.fromMe ? s.me : (isJidGroup(chat) ? (m.key.participant ?? (m.key as any).participantAlt ?? null) : chat);
  if (!reactorRaw) return;
  const reactor = jidNormalizedUser(reactorRaw) || reactorRaw;
  const emoji = (r.text ?? '').trim() || null;
  let name = m.key.fromMe ? null : m.pushName ?? null;
  if (m.key.fromMe) name = (await pool.query('SELECT push_name FROM wa_accounts WHERE id = $1', [s.id])).rows[0]?.push_name ?? 'Yo';
  if (!name) name = (await pool.query('SELECT name FROM wa_contacts WHERE account_id = $1 AND jid = $2', [s.id, reactor])).rows[0]?.name ?? reactor.split('@')[0]!;
  const up = await pool.query(
    `UPDATE wa_messages SET reactions = NULLIF(CASE WHEN $4::text IS NULL THEN COALESCE(reactions, '{}'::jsonb) - $5
                                               ELSE COALESCE(reactions, '{}'::jsonb) || jsonb_build_object($5, jsonb_build_object('emoji', $4::text, 'name', $6::text)) END, '{}'::jsonb)
      WHERE account_id = $1 AND chat_jid = $2 AND id = $3`,
    [s.id, chat, target.id, emoji, reactor, name],
  );
  if (up.rowCount) notifyOwner(s);
  const tc = await pool.query('SELECT id FROM messages WHERE author_id = $1 AND client_message_id = $2', [s.userId, bridgedClientId(s.id, chat, target.id)]);
  if (tc.rows[0]) await externalReaction(tc.rows[0].id, `wa:${reactor}`, emoji, name!);
}
