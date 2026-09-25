/**
 * Arnés solo para desarrollo (vite dev, no entra al build): monta la app con un
 * estado ficticio para revisar pantallas sin backend ni sesión. /harness.html?to=/c/general
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { BootstrapDTO, ConversationDTO, IssueDTO, MessageDTO } from '@tiecoms/contracts';
import { App } from './App.tsx';
import { client } from './app-client.ts';
import { setLang } from './i18n.ts';
import './styles.css';

const q = new URLSearchParams(location.search);
if (q.get('lang') === 'en' || q.get('lang') === 'es') setLang(q.get('lang') as 'en' | 'es');
const H = 3600_000, D = 24 * H, now = Date.now();
const iso = (ms: number) => new Date(now - ms).toISOString();
const org = (id: string, name: string, mark: string, bg: string, fg: string, mine = false) => ({ id, name, mark, colorBg: bg, colorFg: fg, ...(mine ? { myRole: 'owner' as const } : {}) });
const person = (id: string, name: string, orgId: string | null, title: string, guest = false) => ({ id, name, kind: 'human' as const, orgId, title, area: null, guest, guestUntil: guest ? iso(-20 * D) : null });
const conv = (c: Partial<ConversationDTO> & { id: string }): ConversationDTO => ({
  workspaceId: 'ws1', kind: 'group', level: 'operativo', name: null, internalOrgId: null, memberIds: [], lastMessageSeq: 0, lastEventSeq: 0,
  lastMessageAt: iso(2 * H), lastMessagePreview: null, lastReadSeq: 0, unread: 0, canPost: true, canManage: true, historyFromSeq: 0,
  parentId: null, parentMessageId: null, parentMessageSeq: null, deriveKind: null, deriveReason: null, returnedAt: null, openIssues: 0, pinnedAt: null, mutedUntil: null, ...c,
});
let seq = 0;
const msg = (cid: string, a: string, body: string, ago: number, extra: Partial<MessageDTO> = {}): MessageDTO => ({
  id: `${cid}-m${++seq}`, conversationId: cid, seq, authorId: a, clientMessageId: null, kind: 'text', body, replyTo: null, mergedFrom: null, forwarded: null,
  createdAt: iso(ago), editedAt: null, deletedAt: null, ...extra,
});

seq = 0;
const g = [
  msg('general', 'system', JSON.stringify({ k: 'workspace.created', name: 'Lanzamiento · Estudio Norte' }), 3 * D, { kind: 'system', authorId: 'danny' }),
  msg('general', 'mateo', '¿Podemos tener la integración lista para el viernes?', 3 * D),
  msg('general', 'danny', 'Sí. Solo falta validar el formato de los certificados con Ana.', 3 * D - H),
  msg('general', 'ana', 'Veo notificaciones duplicadas en las pruebas, ¿es un reenvío manual o el job?', 2 * D),
  msg('general', 'danny', JSON.stringify({ k: 'derived.from', kind: 'internal', childId: 'diag' }), 2 * D - H, { kind: 'system' }),
  msg('general', 'danny', JSON.stringify({ k: 'issue.created', title: 'Plantilla final de certificados', issueId: 'i1' }), 2 * D - 2 * H, { kind: 'system' }),
  msg('general', 'danny', 'Era el job de las 10:00: reenviaba a quien no había firmado. Queda en una sola notificación diaria.', 5 * H, { mergedFrom: 'diag' }),
  msg('general', 'mateo', 'Perfecto, gracias. Seguimos con la salida del viernes.', 2 * H, { replyTo: 'general-m7' }),
  msg('general', 'laura', 'Les dejo la guía de marca https://www.tiecoms.com/', 100 * 60_000, { linkPreview: { url: 'https://www.tiecoms.com/', title: 'TieComs · Una sola red entre las empresas con las que trabajas', description: 'Conversaciones, asuntos y archivos entre equipos de distintas empresas, cada quien con su alcance.', siteName: 'TieComs', imageUrl: '/tiecoms-mark.svg' } }),
  msg('general', 'ana', 'Mañana llego a las 8 con el diseñador.', 90 * 60_000, { forwarded: { source: 'whatsapp', author: 'Pedro (Estudio Norte)', sentAt: '24/9/26 07:41' } }),
];
seq = 0;
const dg = [
  msg('diag', 'danny', JSON.stringify({ k: 'derived.here', parent: 'General', excerpt: 'Veo notificaciones duplicadas en las pruebas' }), 2 * D - H, { kind: 'system' }),
  msg('diag', 'laura', 'Revisé los logs: el job corre cada hora y reenvía a quien no ha firmado.', 30 * H),
  msg('diag', 'danny', 'Era el job de las 10:00: reenviaba a quien no había firmado. Queda en una sola notificación diaria.', 6 * H),
  msg('diag', 'danny', JSON.stringify({ k: 'returned' }), 5 * H, { kind: 'system' }),
];
seq = 0;
const sd = [
  msg('side1', 'danny', JSON.stringify({ k: 'side.started', excerpt: 'Veo notificaciones duplicadas en las pruebas, ¿es un reenvío manual o el job?', authorName: 'Ana Torres', parentName: null, messageId: 'general-m4' }), 2 * D - 30 * 60_000, { kind: 'system' }),
  msg('side1', 'danny', 'Laura, no tengo ni idea de dónde salen los duplicados, ¿me ayudas?', 2 * D - 29 * 60_000),
  msg('side1', 'laura', 'Es el job de las 10:00. Te paso el log.', 2 * D - 20 * 60_000),
];
seq = 0;
const dm = [
  msg('dm-ana', 'danny', 'Te cuento por aquí para no llenar el grupo: es el job de las 10.', 3 * H, { forwarded: { source: 'tiecoms', author: 'Ana Torres', sentAt: iso(2 * D), fromConversationId: 'general', messageId: 'general-m4', messageSeq: 4, excerpt: 'Veo notificaciones duplicadas en las pruebas, ¿es un reenvío manual o el job?' } }),
  msg('dm-ana', 'ana', '¡Gracias! Mucho más claro.', 2 * H),
];

const data: BootstrapDTO = {
  contract: 'dev', serverTime: new Date().toISOString(),
  me: { id: 'danny', name: 'Danny Suárez', kind: 'human', title: 'Líder técnico', area: null, primaryOrgId: 'xertify', email: 'danny@demo.tiecoms.com' },
  organizations: [org('xertify', 'Xertify', 'X', '#dcd0f2', '#3b2a5a', true), org('norte', 'Estudio Norte', 'EN', '#e8d5a8', '#4a3a14')],
  workspaces: [{ id: 'ws1', name: 'Lanzamiento · Estudio Norte', department: 'Portal de certificados', glyph: null, owningOrgId: 'xertify', organizationIds: ['xertify', 'norte'], memberIds: ['danny', 'laura', 'mateo', 'ana'], myRole: 'lead', createdAt: iso(4 * D), pinnedAt: null }],
  conversations: [
    conv({ id: 'general', name: 'General', pinnedAt: iso(D), memberIds: ['danny', 'laura', 'mateo', 'ana'], lastMessageSeq: g.length, lastEventSeq: g.length, lastReadSeq: g.length - 1, unread: 1, lastMessagePreview: g[g.length - 1]!.body, openIssues: 2 }),
    conv({ id: 'diag', name: 'Diagnóstico · notificaciones duplicadas', kind: 'internal', level: null, internalOrgId: 'xertify', memberIds: ['danny', 'laura'], parentId: 'general', parentMessageId: 'general-m4', parentMessageSeq: 4, deriveKind: 'internal', deriveReason: 'Ana necesita saber si es el job o un reenvío', returnedAt: iso(5 * H), lastMessageSeq: dg.length, lastEventSeq: dg.length, lastReadSeq: dg.length }),
    conv({ id: 'dec', name: 'Decisión · fecha de salida', level: 'directivo', memberIds: ['danny', 'mateo'], parentId: 'general', parentMessageId: 'general-m2', parentMessageSeq: 2, deriveKind: 'directive', lastMessageSeq: 0 }),
    conv({ id: 'multi1', kind: 'multi', workspaceId: null, level: null, name: 'Equipo mixto', avatarUrl: '/tiecoms-mark.svg', memberIds: ['danny', 'mateo', 'ana', 'laura'], unread: 2, lastMessagePreview: '¿Nos vemos el jueves?' }),
    conv({ id: 'side1', kind: 'multi', workspaceId: null, level: null, name: 'Consulta · Veo notificaciones duplicadas en las…', memberIds: ['danny', 'laura'], parentId: 'general', parentMessageId: 'general-m4', parentMessageSeq: 4, deriveKind: 'side', lastMessageSeq: sd.length, lastEventSeq: sd.length, lastReadSeq: sd.length - 1, unread: 1, lastMessagePreview: sd[2]!.body }),
    conv({ id: 'dm-ana', kind: 'direct', workspaceId: null, level: null, memberIds: ['danny', 'ana'], lastMessageSeq: dm.length, lastEventSeq: dm.length, lastReadSeq: dm.length, lastMessagePreview: dm[1]!.body }),
    conv({ id: 'internal', name: 'Equipo interno', kind: 'internal', level: null, internalOrgId: 'xertify', memberIds: ['danny', 'laura'] }),
  ],
  people: [person('danny', 'Danny Suárez', 'xertify', 'Líder técnico'), person('laura', 'Laura Gómez', 'xertify', 'Soporte'), person('mateo', 'Mateo Rivas', 'norte', 'Director de proyectos'), person('ana', 'Ana Torres', 'norte', 'Coordinadora')],
};
const issue = (i: Partial<IssueDTO> & { id: string; title: string }): IssueDTO => ({
  workspaceId: 'ws1', conversationId: 'general', originMessageId: null, originMessageSeq: null, status: 'open', waitingOnOrgId: null, ownerId: 'danny', requestedBy: null,
  dueDate: null, createdBy: 'danny', createdAt: iso(3 * D), updatedAt: iso(H), statusSince: iso(H), closedAt: null, commentCount: 0, ...i,
});
const issues: Record<string, IssueDTO> = {
  i1: issue({ id: 'i1', title: 'Plantilla final de certificados', status: 'waiting', waitingOnOrgId: 'norte', ownerId: 'ana', requestedBy: 'danny', originMessageId: 'general-m3', originMessageSeq: 3, statusSince: iso(4 * D), dueDate: new Date(now - D).toISOString().slice(0, 10) }),
  i2: issue({ id: 'i2', title: 'Prueba de carga con 500 registros', status: 'in_progress', ownerId: 'danny', dueDate: new Date(now + 2 * D).toISOString().slice(0, 10), commentCount: 2 }),
  i3: issue({ id: 'i3', title: 'Confirmar fecha con dirección', status: 'done', ownerId: 'mateo', closedAt: iso(D) }),
};

const at = (h: number, m = 0, dayOffset = 0) => { const x = new Date(); x.setDate(x.getDate() + dayOffset); x.setHours(h, m, 0, 0); return x.toISOString(); };
const events = {
  e1: { id: 'e1', workspaceId: 'ws1', conversationId: 'general', originMessageId: null, title: 'Revisión semanal con Estudio Norte', description: 'Avance de la integración', location: 'https://meet.google.com/abc-defg-hij', startsAt: at(10), endsAt: at(11), timezone: 'America/Bogota', organizerId: 'danny', invitees: [{ userId: 'danny', rsvp: 'yes' as const }, { userId: 'mateo', rsvp: 'maybe' as const }, { userId: 'ana', rsvp: 'pending' as const }], cancelledAt: null, updatedAt: iso(H) },
  e2: { id: 'e2', workspaceId: 'ws1', conversationId: 'dec', originMessageId: null, title: 'Decisión fecha de salida', description: null, location: 'Sala 3, Edificio SD', startsAt: at(15, 30, 1), endsAt: at(16, 30, 1), timezone: 'America/Bogota', organizerId: 'mateo', invitees: [{ userId: 'danny', rsvp: 'yes' as const }, { userId: 'mateo', rsvp: 'yes' as const }], cancelledAt: null, updatedAt: iso(H) },
};
const reminders = [
  { id: 'r1', conversationId: 'general', messageId: 'general-m3', messageSeq: 3, note: 'Confirmar formato con Ana', remindAt: iso(10 * 60_000), firedAt: iso(9 * 60_000), doneAt: null },
  { id: 'r2', conversationId: 'diag', messageId: null, messageSeq: null, note: null, remindAt: iso(-5 * H), firedAt: null, doneAt: null },
];
(client as any).set({
  status: 'ready', connection: 'online', data, issues, events, reminders, pins: { general: ['general-m3'] },
  conversations: {
    general: { messages: g, lastEventSeq: g.length, hasMore: false, loaded: true, loading: false },
    diag: { messages: dg, lastEventSeq: dg.length, hasMore: false, loaded: true, loading: false },
    dec: { messages: [], lastEventSeq: 0, hasMore: false, loaded: true, loading: false },
    side1: { messages: sd, lastEventSeq: sd.length, hasMore: false, loaded: true, loading: false },
    'dm-ana': { messages: dm, lastEventSeq: dm.length, hasMore: false, loaded: true, loading: false },
  },
});
// WhatsApp de ejemplo: la personal conectada y la Business esperando el QR.
const qrSvg = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21" shape-rendering="crispEdges"><rect width="21" height="21" fill="#fff"/>' + Array.from({ length: 180 }, (_, i) => `<rect x="${(i * 7) % 21}" y="${Math.floor((i * 7) / 21) % 21}" width="1" height="1"/>`).join('') + '<rect x="0" y="0" width="7" height="7" fill="none" stroke="#000"/><rect x="14" y="0" width="7" height="7" fill="none" stroke="#000"/><rect x="0" y="14" width="7" height="7" fill="none" stroke="#000"/></svg>')}`;
const waAccounts = [
  { id: 'wa1', label: 'Personal', kind: 'personal', status: 'connected', phone: '573001112233', pushName: 'Danny', platform: 'android', qr: null, pairingCode: null, lastError: null, connectedAt: iso(D), lastSyncAt: iso(60_000), chats: 214, groups: 38, createdAt: iso(D) },
  { id: 'wa2', label: 'Business', kind: 'business', status: q.get('wa') === 'code' ? 'qr' : 'qr', phone: null, pushName: null, platform: null, qr: qrSvg, pairingCode: q.get('wa') === 'code' ? 'K7Q2WX9M' : null, lastError: null, connectedAt: null, lastSyncAt: null, chats: 0, groups: 0, createdAt: iso(H) },
];
const waChat = (jid: string, name: string, category: string, extra: Record<string, unknown> = {}) => ({
  accountId: 'wa1', accountLabel: 'Personal', accountKind: 'personal', jid, name, isGroup: true, participants: 12, description: null,
  lastMessageAt: iso(3 * H), lastPreview: null, unread: 0, category, categoryManual: false, pinned: false, hidden: false, archivedInWhatsApp: false, linkedConversationId: null, ...extra,
});
const waChats = [
  waChat('g1@g.us', 'Equipo Xertify', 'trabajo', { unread: 4, lastPreview: 'Laura: el despliegue quedó listo', lastMessageAt: iso(20 * 60_000), participants: 9, pinned: true, linkedConversationId: 'internal' }),
  waChat('g2@g.us', 'Soporte UniAndes · credenciales', 'clientes', { unread: 2, lastPreview: 'Lorena: ¿ya se aplicó la recarga?', lastMessageAt: iso(45 * 60_000), participants: 14 }),
  waChat('g3@g.us', 'Familia Suárez ❤️', 'familia', { lastPreview: 'Mamá: 📷 Foto', lastMessageAt: iso(2 * H), participants: 11 }),
  waChat('g4@g.us', 'Los parceros ⚽', 'amigos', { unread: 17, lastPreview: 'Juan: ¿partido el sábado?', lastMessageAt: iso(3 * H), participants: 23 }),
  waChat('g5@g.us', 'Conjunto Torres del Parque', 'comunidad', { lastPreview: 'Administración: corte de agua mañana', lastMessageAt: iso(D), participants: 180 }),
  waChat('g6@g.us', 'Estudio Norte · lanzamiento', 'trabajo', { lastPreview: 'Mateo: seguimos el viernes', lastMessageAt: iso(26 * H), participants: 6 }),
  waChat('g7@g.us', 'Viaje Cartagena 2026', 'amigos', { lastPreview: 'Tú: reservé el hotel', lastMessageAt: iso(3 * D), participants: 5 }),
];
const waMsgs = [
  { id: 'a', fromMe: false, author: 'Laura Gómez', kind: 'text', body: '¿Quién revisa el PR de firmas?', sentAt: iso(3 * H) },
  { id: 'b', fromMe: true, author: null, kind: 'text', body: 'Yo lo miro después del almuerzo', sentAt: iso(2 * H) },
  { id: 'c', fromMe: false, author: 'Carlos', kind: 'image', body: '📷 Captura del error', sentAt: iso(H) },
  { id: 'd', fromMe: false, author: 'Laura Gómez', kind: 'text', body: 'El despliegue quedó listo ✅', sentAt: iso(20 * 60_000) },
];
(client as any).request = async (path: string, init: any = {}) => {
  if (path === '/whatsapp/accounts' && !init.method) return { accounts: waAccounts, max: 5 };
  if (path.startsWith('/whatsapp/chats?')) {
    const p = new URLSearchParams(path.split('?')[1]);
    const cat = p.get('category');
    const counts: Record<string, { total: number; unread: number }> = {};
    for (const c of waChats) { const k = counts[c.category] ??= { total: 0, unread: 0 }; k.total++; if (c.unread) k.unread++; }
    return { chats: waChats.filter((c) => !cat || c.category === cat), categories: counts };
  }
  if (/\/whatsapp\/chats\/.+\/messages/.test(path)) return { messages: waMsgs };
  if (path.startsWith('/whatsapp/chats/') && init.method === 'PATCH') {
    const jid = decodeURIComponent(path.split('/')[4]!);
    const c = waChats.find((x) => x.jid === jid)!;
    Object.assign(c, init.json, init.json.category !== undefined ? { categoryManual: init.json.category !== null } : {});
    return c;
  }
  if (path === '/whatsapp/organize') return { reviewed: 7, changed: 0 };
  if (path === '/blocks') return { userIds: [] };
  if (path.startsWith('/drive/tree')) {
    const ws = path.includes('workspaceId');
    const fo = (id: string, name: string, parentId: string | null) => ({ id, name, parentId, createdBy: 'danny', createdAt: iso(3 * D) });
    const fi = (id: string, name: string, folderId: string | null, contentType: string, size: number, by = 'danny') => ({ id, name, folderId, contentType, size, createdBy: by, createdAt: iso(2 * D), updatedAt: iso(D) });
    return ws
      ? { workspaceId: 'ws1', canManageAll: true, folders: [fo('w1', 'Entregables', null), fo('w2', 'Actas', null), fo('w3', 'Diseños', 'w1')],
          files: [fi('x1', 'Cronograma lanzamiento.xlsx', 'w1', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 48_000, 'mateo'), fi('x2', 'Acta 24-sep.pdf', 'w2', 'application/pdf', 320_000, 'ana'), fi('x3', 'Portada.png', 'w3', 'image/png', 1_900_000, 'laura')] }
      : { workspaceId: null, canManageAll: true, folders: [fo('f1', 'Contratos', null), fo('f2', '2026', 'f1'), fo('f3', 'Facturas', null)],
          files: [fi('a1', 'Propuesta Estudio Norte.pdf', null, 'application/pdf', 812_000), fi('a2', 'Contrato marco.docx', 'f2', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 96_000), fi('a3', 'Notas.txt', null, 'text/plain', 1_200)] };
  }
  throw new Error('arnés sin backend');
};
history.replaceState(null, '', q.get('to') ?? '/');
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
