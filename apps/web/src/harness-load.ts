/**
 * Carga pesada para medir memoria (docs/MEMORIA.md): /harness.html?carga=50 monta 50 chats con 100 mensajes cada uno
 * (5.000), fotos (con y sin miniatura), tarjetas de correo y un «servidor» en memoria que pagina mensajes y eventos
 * igual que el API. window.__live(...) simula eventos en vivo (mensajes, «escribiendo…», leídos) por el camino real
 * del cliente. Solo en el arnés (no entra al build de la app).
 */
import type { BootstrapDTO, ConversationDTO, MessageDTO, SharedMailDTO } from '@tiecoms/contracts';
import type { TieComsClient } from '@tiecoms/client-core';

const PER_CHAT = 100;
const H = 3600_000;

type Store = { messages: MessageDTO[]; events: { type: 'message.created'; conversationId: string; eventSeq: number; message: MessageDTO }[]; seq: number };

const WORDS = 'listo revisar contrato plantilla cliente factura reunión viernes lanzamiento firma certificado equipo soporte despliegue cronograma entrega propuesta pago acta diseño portal integración prueba envío'.split(' ');
const sentence = (i: number, n: number) => Array.from({ length: n }, (_, k) => WORDS[(i * 7 + k * 3) % WORDS.length]).join(' ');

async function makeJpeg(w: number, h: number, quality: number) {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d')!;
  // Ruido de colores: la compresión no lo reduce a casi nada (como una foto real).
  const img = g.createImageData(w, h);
  let x = 1234567;
  for (let i = 0; i < img.data.length; i += 4) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    img.data[i] = x & 255; img.data[i + 1] = (x >> 8) & 255; img.data[i + 2] = (x >> 16) & 255; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer());
}

export async function installLoad(client: TieComsClient, chats = 50) {
  const c = client as any;
  const base: BootstrapDTO = c.getState().data;
  const now = Date.now();
  const people = [...base.people];
  for (let i = 0; i < 26; i++) people.push({ id: `p${i}`, name: `Persona ${i}`, kind: 'human', orgId: i % 2 ? 'norte' : 'xertify', title: 'Equipo', area: null, guest: false, guestUntil: null } as any);
  const ids = people.map((p) => p.id);
  const store = new Map<string, Store>();
  const mails = new Map<string, SharedMailDTO>();
  const conversations: ConversationDTO[] = [];
  let attN = 0;
  const att = (cid: string, i: number) => {
    const id = `${cid}-a${++attN}`;
    // Una de cada tres sin miniatura (subida desde un cliente viejo): ahí la burbuja pedía la foto original.
    return { id, name: `foto-${i}.jpg`, contentType: 'image/jpeg', sizeBytes: 1_400_000, width: 2400, height: 1800, url: `/api/v1/attachments/${id}`, thumbUrl: attN % 3 === 0 ? null : `/api/v1/attachments/${id}/thumb` };
  };
  for (let k = 0; k < chats; k++) {
    const cid = `carga-${String(k).padStart(2, '0')}`;
    const s: Store = { messages: [], events: [], seq: 0 };
    for (let i = 1; i <= PER_CHAT; i++) {
      const author = ids[(k + i) % ids.length]!;
      const extra: Partial<MessageDTO> = {};
      let body = `${sentence(i + k, 6 + ((i * 5) % 30))}.`;
      if (i % 9 === 0) body += ` Detalle en https://docs.example.com/${cid}/${i} y *importante* _revisar_ \`codigo\``;
      if (i % 10 === 0) extra.attachments = Array.from({ length: 1 + (i % 4) }, (_, j) => att(cid, j)) as any;
      let kind: MessageDTO['kind'] = 'text';
      if (i === 40 || i === 80) {
        const emailId = `${cid}-mail${i}`;
        const text = `${sentence(i, 60)}\n\n`.repeat(8);
        mails.set(emailId, { id: emailId, conversationId: cid, sharedBy: author, provider: 'gmail', accountEmail: 'danny@xertify.co', direction: 'in', from: { name: 'Proveedor', email: 'factura@example.com' }, to: [], cc: [], subject: `Factura ${i}`, snippet: text.slice(0, 300), body: text, full: true, sentAt: new Date(now - (PER_CHAT - i) * H).toISOString(), attachments: [], messageId: `${cid}-m${i}`, comment: 'Revisar', status: 'pending', repliedAt: null, repliedBy: null, scheduledReply: null, issueId: null, commentCount: 0, lastComments: [], createdAt: new Date(now - (PER_CHAT - i) * H).toISOString() } as any);
        body = JSON.stringify({ k: 'mail.shared', emailId, comment: 'Revisar' });
        kind = 'system';
      }
      const m: MessageDTO = { id: `${cid}-m${i}`, conversationId: cid, seq: i, authorId: author, clientMessageId: null, kind, body, replyTo: null, mergedFrom: null, forwarded: null, createdAt: new Date(now - (PER_CHAT - i) * 20 * 60_000 - k * 60_000).toISOString(), editedAt: null, deletedAt: null, ...extra };
      s.messages.push(m);
      s.events.push({ type: 'message.created', conversationId: cid, eventSeq: i, message: m });
    }
    s.seq = PER_CHAT;
    store.set(cid, s);
    const last = s.messages[s.messages.length - 1]!;
    conversations.push({
      id: cid, workspaceId: 'ws1', kind: 'group', level: 'operativo', name: `Chat de carga ${k}`, internalOrgId: null, memberIds: ['danny', ...ids.slice(0, 8)],
      lastMessageSeq: PER_CHAT, lastEventSeq: PER_CHAT, lastMessageAt: last.createdAt, lastMessagePreview: last.body.slice(0, 140), lastReadSeq: k % 3 ? PER_CHAT : PER_CHAT - 5,
      unread: k % 3 ? 0 : 5, canPost: true, canManage: true, historyFromSeq: 0, parentId: null, parentMessageId: null, parentMessageSeq: null, deriveKind: null, deriveReason: null,
      returnedAt: null, openIssues: 0, pinnedAt: k < 3 ? new Date(now - k * H).toISOString() : null, mutedUntil: null,
    } as ConversationDTO);
  }
  const data: BootstrapDTO = { ...base, people: people as any, conversations: [...conversations, ...base.conversations].sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '')) };
  c.set({ data, conversations: {}, mails: {} });

  // Fotos: una original grande y una miniatura; cada descarga es un Blob nuevo (como en la red).
  const full = await makeJpeg(2400, 1800, 0.8);
  const thumb = await makeJpeg(480, 360, 0.7);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  c.fetchBlob = async (path: string) => { await wait(15); return new Blob([(path.endsWith('/thumb') ? thumb : full).slice()], { type: 'image/jpeg' }); };

  const prev = c.request.bind(c);
  c.request = async (path: string, init: any = {}) => {
    const u = new URL(path, 'http://x');
    const p = u.pathname;
    let m = /^\/conversations\/([^/]+)\/messages$/.exec(p);
    if (m && store.has(m[1]!) && !init.method) {
      await wait(40);
      const s = store.get(m[1]!)!;
      const limit = Number(u.searchParams.get('limit') ?? 50);
      const before = Number(u.searchParams.get('before') ?? 0);
      const list = before ? s.messages.filter((x) => x.seq < before) : s.messages;
      const page = list.slice(-limit);
      return { messages: page, hasMore: list.length > page.length, lastEventSeq: s.seq };
    }
    m = /^\/conversations\/([^/]+)\/events$/.exec(p);
    if (m && store.has(m[1]!)) {
      await wait(25);
      const s = store.get(m[1]!)!;
      const after = Number(u.searchParams.get('after') ?? 0);
      const limit = Number(u.searchParams.get('limit') ?? 200);
      return { events: s.events.filter((e) => e.eventSeq > after).slice(0, limit), resetRequired: false };
    }
    if (/^\/conversations\/carga-[^/]+\/topics$/.test(p)) return { topics: [] };
    if (/^\/conversations\/carga-[^/]+\/pins$/.test(p)) return { messages: [] };
    if (p === '/issues') return { issues: [] };
    if (p === '/reminders') return { reminders: [] };
    if (p === '/scheduled') return { scheduled: [] };
    if (p === '/mail/shared') { await wait(20); return { emails: (u.searchParams.get('ids') ?? '').split(',').map((id) => mails.get(id)).filter(Boolean) }; }
    m = /^\/mail\/shared\/([^/]+)$/.exec(p);
    if (m && mails.has(m[1]!)) return mails.get(m[1]!);
    m = /^\/mail\/shared\/([^/]+)\/html$/.exec(p);
    if (m) return { html: `<div>${'<p>Contenido del correo con <b>diseño</b> y tablas.</p>'.repeat(800)}</div>` };
    return prev(path, init);
  };

  /** Eventos en vivo por el camino real del cliente (onConversationEvent, onTyping, onAccountEvent). */
  const live = (o: { messages?: number; typing?: number; reads?: number } = {}) => {
    const keys = [...store.keys()];
    for (let i = 0; i < (o.messages ?? 0); i++) {
      const cid = keys[(i * 7) % keys.length]!;
      const s = store.get(cid)!;
      const seq = ++s.seq;
      const msg: MessageDTO = { id: `${cid}-live${seq}`, conversationId: cid, seq, authorId: ids[(i % (ids.length - 1)) + 1]!, clientMessageId: null, kind: 'text', body: `${sentence(seq, 12)} https://example.com/l/${seq}`, replyTo: null, mergedFrom: null, forwarded: null, createdAt: new Date().toISOString(), editedAt: null, deletedAt: null };
      s.messages.push(msg);
      const e = { type: 'message.created' as const, conversationId: cid, eventSeq: seq, message: msg };
      s.events.push(e);
      c.onConversationEvent(e);
    }
    for (let i = 0; i < (o.typing ?? 0); i++) c.onTyping({ conversationId: keys[i % keys.length]!, userId: ids[(i % (ids.length - 1)) + 1]! });
    for (let i = 0; i < (o.reads ?? 0); i++) {
      const cid = keys[i % keys.length]!;
      c.onAccountEvent({ type: 'read.updated', conversationId: cid, seq: store.get(cid)!.seq });
    }
  };
  Object.assign(window, { __live: live, __loadChats: conversations.map((x) => x.id) });
}
