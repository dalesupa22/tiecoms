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
  parentId: null, parentMessageId: null, parentMessageSeq: null, deriveKind: null, deriveReason: null, returnedAt: null, openIssues: 0, ...c,
});
let seq = 0;
const msg = (cid: string, a: string, body: string, ago: number, extra: Partial<MessageDTO> = {}): MessageDTO => ({
  id: `${cid}-m${++seq}`, conversationId: cid, seq, authorId: a, clientMessageId: null, kind: 'text', body, replyTo: null, mergedFrom: null,
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
  msg('general', 'mateo', 'Perfecto, gracias. Seguimos con la salida del viernes.', 2 * H),
];
seq = 0;
const dg = [
  msg('diag', 'danny', JSON.stringify({ k: 'derived.here', parent: 'General', excerpt: 'Veo notificaciones duplicadas en las pruebas' }), 2 * D - H, { kind: 'system' }),
  msg('diag', 'laura', 'Revisé los logs: el job corre cada hora y reenvía a quien no ha firmado.', 30 * H),
  msg('diag', 'danny', 'Era el job de las 10:00: reenviaba a quien no había firmado. Queda en una sola notificación diaria.', 6 * H),
  msg('diag', 'danny', JSON.stringify({ k: 'returned' }), 5 * H, { kind: 'system' }),
];

const data: BootstrapDTO = {
  contract: 'dev', serverTime: new Date().toISOString(),
  me: { id: 'danny', name: 'Danny Suárez', kind: 'human', title: 'Líder técnico', area: null, primaryOrgId: 'xertify', email: 'danny@demo.tiecoms.com' },
  organizations: [org('xertify', 'Xertify', 'X', '#dcd0f2', '#3b2a5a', true), org('norte', 'Estudio Norte', 'EN', '#e8d5a8', '#4a3a14')],
  workspaces: [{ id: 'ws1', name: 'Lanzamiento · Estudio Norte', department: 'Portal de certificados', glyph: null, owningOrgId: 'xertify', organizationIds: ['xertify', 'norte'], memberIds: ['danny', 'laura', 'mateo', 'ana'], myRole: 'lead', createdAt: iso(4 * D) }],
  conversations: [
    conv({ id: 'general', name: 'General', memberIds: ['danny', 'laura', 'mateo', 'ana'], lastMessageSeq: g.length, lastEventSeq: g.length, lastReadSeq: g.length - 1, unread: 1, lastMessagePreview: g[g.length - 1]!.body, openIssues: 2 }),
    conv({ id: 'diag', name: 'Diagnóstico · notificaciones duplicadas', kind: 'internal', level: null, internalOrgId: 'xertify', memberIds: ['danny', 'laura'], parentId: 'general', parentMessageId: 'general-m4', parentMessageSeq: 4, deriveKind: 'internal', deriveReason: 'Ana necesita saber si es el job o un reenvío', returnedAt: iso(5 * H), lastMessageSeq: dg.length, lastEventSeq: dg.length, lastReadSeq: dg.length }),
    conv({ id: 'dec', name: 'Decisión · fecha de salida', level: 'directivo', memberIds: ['danny', 'mateo'], parentId: 'general', parentMessageId: 'general-m2', parentMessageSeq: 2, deriveKind: 'directive', lastMessageSeq: 0 }),
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

(client as any).set({
  status: 'ready', connection: 'online', data, issues,
  conversations: {
    general: { messages: g, lastEventSeq: g.length, hasMore: false, loaded: true, loading: false },
    diag: { messages: dg, lastEventSeq: dg.length, hasMore: false, loaded: true, loading: false },
    dec: { messages: [], lastEventSeq: 0, hasMore: false, loaded: true, loading: false },
  },
});
(client as any).request = async () => { throw new Error('arnés sin backend'); };
history.replaceState(null, '', q.get('to') ?? '/');
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
