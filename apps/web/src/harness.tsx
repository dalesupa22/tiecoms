/**
 * Arnés solo para desarrollo (vite dev, no entra al build): monta la app con un
 * estado ficticio para revisar pantallas sin backend ni sesión. /harness.html?to=/c/general
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { BootstrapDTO, ConversationDTO, IssueDTO, MessageDTO, TopicDTO } from '@tiecoms/contracts';
import { showMessageBubble } from './bubbles.tsx';
import { App } from './App.tsx';
import { openDialog } from './actions.tsx';
import { IssueDrawer } from './screens/Issues.tsx';
import { client } from './app-client.ts';
import { setLang } from './i18n.ts';
import { initTheme, setThemePreference } from './theme.ts';
import './styles.css';

const q = new URLSearchParams(location.search);
if (q.get('lang') === 'en' || q.get('lang') === 'es') setLang(q.get('lang') as 'en' | 'es');
initTheme();
const qt = q.get('theme');
if (qt === 'dark' || qt === 'light' || qt === 'system') setThemePreference(qt);
const H = 3600_000, D = 24 * H, now = Date.now();
const iso = (ms: number) => new Date(now - ms).toISOString();
const org = (id: string, name: string, mark: string, bg: string, fg: string, mine = false) => ({ id, name, mark, colorBg: bg, colorFg: fg, ...(mine ? { myRole: 'owner' as const } : {}) });
const person = (id: string, name: string, orgId: string | null, title: string, guest = false) => ({ id, name, kind: 'human' as const, orgId, title, area: null, guest, guestUntil: guest ? iso(-20 * D) : null });
const conv = (c: Partial<ConversationDTO> & { id: string }): ConversationDTO => ({
  workspaceId: 'ws1', kind: 'group', level: 'operativo', name: null, internalOrgId: null, memberIds: [], lastMessageSeq: 0, lastEventSeq: 0,
  lastMessageAt: iso(2 * H), lastMessagePreview: null, lastReadSeq: 0, unread: 0, canPost: true, canManage: true, historyFromSeq: 0,
  parentId: null, parentMessageId: null, parentMessageSeq: null, deriveKind: null, deriveReason: null, returnedAt: null, openIssues: 0, pinnedAt: null, mutedUntil: null, ...c,
});
const att = (id: string, name: string, contentType: string, sizeBytes: number) => ({ id, name, contentType, sizeBytes, width: 1200, height: 900, url: `/api/v1/attachments/${id}`, thumbUrl: null });
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
  msg('general', 'laura', 'Les dejo la guía de marca https://www.chaggu.com/', 100 * 60_000, { linkPreview: { url: 'https://www.chaggu.com/', title: 'chaggu · Una sola red entre las empresas con las que trabajas', description: 'Conversaciones, asuntos y archivos entre equipos de distintas empresas, cada quien con su alcance.', siteName: 'chaggu', imageUrl: '/chaggu-logo.svg' } }),
  msg('general', 'ana', 'Mañana llego a las 8 con el diseñador.', 90 * 60_000, { forwarded: { source: 'whatsapp', author: 'Pedro (Estudio Norte)', sentAt: '24/9/26 07:41' } }),
  msg('general', 'mateo', 'Fotos de la visita de hoy', 60 * 60_000, { attachments: [1, 2, 3, 4, 5, 6].map((i) => att(`f${i}`, `visita-${i}.jpg`, 'image/jpeg', 820_000)) }),
  msg('general', 'mateo', '@Danny Suárez ¿puedes revisar con @Laura Gómez la plantilla?', 50 * 60_000, { mentions: [{ userId: 'danny', start: 0, length: 13 }, { userId: 'laura', start: 34, length: 12 }] }),
  msg('general', 'ana', '', 45 * 60_000, { attachments: [{ ...att('v1', 'nota-de-voz.m4a', 'audio/mp4', 31_000), kind: 'voice', durationMs: 52_000, waveform: Array.from({ length: 48 }, (_, i) => 0.2 + 0.8 * Math.abs(Math.sin(i / 3))), transcript: { status: 'done', text: 'Hola Danny, el jueves te mando el contrato revisado con los cambios de la cláusula cuatro.', language: 'es-CO', summary: 'Ana confirma a Danny que el jueves le envía el contrato revisado.', suggestedIssue: 'Enviar el contrato revisado el jueves' } }] }),
  msg('general', 'laura', '', 40 * 60_000, { attachments: [att('p1', 'Contrato marco v3.pdf', 'application/pdf', 1_240_000), att('x1', 'Cronograma.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 48_000), att('c1', 'sync-entidades.ts', 'application/octet-stream', 1_200), att('c2', 'notas-levantamiento.md', 'text/markdown', 640)] }),
  // Reacciones y enlaces (docs/REACCIONES_ENLACES.md)
  msg('general', 'ana', 'Miren esta charla sobre firma digital https://www.youtube.com/watch?v=abc123', 30 * 60_000, {
    linkPreviews: [{ url: 'https://www.youtube.com/watch?v=abc123', title: 'Firma electrónica en Colombia: lo que cambia en 2026', description: 'Una charla de 20 minutos sobre validez jurídica, OTP y certificados.', siteName: 'YouTube', imageUrl: '/chaggu-logo.svg', kind: 'video', provider: 'youtube', author: 'Legal Tech Bogotá', durationSec: 1234, linkId: 'l1' }],
    reactions: [{ emoji: '👍', userIds: ['laura', 'mateo'] }, { emoji: '👀', userIds: ['danny'] }, { emoji: '🔥', userIds: [], external: [{ name: 'Pedro', source: 'whatsapp' }] }],
  }),
  msg('general', 'mateo', 'https://www.tiktok.com/@legaltech/video/1', 20 * 60_000, { linkPreviews: [{ url: 'https://www.tiktok.com/@legaltech/video/1', title: 'Así se firma un contrato en 30 segundos', description: null, siteName: 'TikTok', imageUrl: '/chaggu-logo.svg', kind: 'short', provider: 'tiktok', author: 'legaltech', linkId: 'l2' }] }),
  msg('general', 'mateo', 'https://www.instagram.com/reel/C1abc/', 19 * 60_000, { linkPreviews: [{ url: 'https://www.instagram.com/reel/C1abc/', title: 'Reel: detrás de cámaras del lanzamiento', description: null, siteName: 'Instagram', imageUrl: null, kind: 'short', provider: 'instagram', author: 'estudionorte', linkId: 'l3' }] }),
  msg('general', 'mateo', 'y este https://blog.example.com/guia-microcredenciales', 18 * 60_000, { linkPreviews: [{ url: 'https://blog.example.com/guia-microcredenciales', title: 'Guía práctica de microcredenciales', description: 'Cómo diseñar rutas apilables.', siteName: 'Blog Example', imageUrl: null, kind: 'article', provider: null, linkId: 'l4' }] }),
  msg('general', 'laura', '🎉🙌', 10 * 60_000, { reactions: [{ emoji: '❤️', userIds: ['danny', 'ana'] }] }),
  msg('general', 'danny', 'Pendientes para el *viernes*:\n- Validar la _plantilla_ con Ana\n- Subir el `cronograma.xlsx`\n- ~Llamar a Mateo~ ya quedó\n1. Primero la firma\n2. Luego el envío', 8 * 60_000),
  msg('general', 'danny', JSON.stringify({ k: 'mail.shared', emailId: 'em1', comment: 'De que es este cobro?' }), 5 * 60_000, { kind: 'system' }),
];
const BANCO = 'header-logo [http://bancolombia-email-wsuite.s3.amazonaws.com/templates/60712c2057ad717760ad6b6c/img/header.png]\n\nHola DANNY SUAREZ,\n\nTe informamos que realizaste una compra por $189.900 en AMAZON WEB SERVICES con tu tarjeta *4521 el 30/09/2026 a las 05:58.\n\nSi no reconoces esta transacción comunícate con nosotros.\nVer detalle [https://www.bancolombia.com/personas/alertas-y-notificaciones?id=98231].\n\nfooter_img [https://bancolombia-email-wsuite.s3.amazonaws.com/templates/x/img/footer.png]\nBancolombia S.A. · Este correo es informativo, por favor no lo respondas.';
const mails = { em1: { id: 'em1', conversationId: 'general', sharedBy: 'danny', provider: 'gmail', accountEmail: 'danny@xertify.co', direction: 'in', from: { name: 'Alertas y Notificaciones', email: 'alertasynotificaciones@an.notificacionesbancolombia.com' }, to: [], cc: [], subject: 'Alertas y Notificaciones', snippet: BANCO.slice(0, 300), body: BANCO, full: true, sentAt: iso(60 * 60_000), attachments: [], messageId: 'general-m99', comment: 'De que es este cobro?', status: 'pending', repliedAt: null, repliedBy: null, scheduledReply: null, issueId: null, commentCount: 0, lastComments: [], createdAt: iso(5 * 60_000) } };
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
// Temas (docs/TEMAS.md): orden guardado Diseño, Pagos, Legal, Marketing; lo leído llega hasta el 8.
// Sin leer: 9 Legal, 10 sin tema, 11 Marketing, 12 Legal → fila General, Todo, Legal, Marketing, Diseño, Pagos.
const TP = ['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-00000000000d'];
const topicsTemas: TopicDTO[] = [
  { id: TP[0]!, conversationId: 'temas', name: 'Diseño', color: 'violet', icon: '🎯', position: 0, archivedAt: null, createdBy: 'danny', createdAt: iso(4 * D) },
  { id: TP[1]!, conversationId: 'temas', name: 'Pagos', color: 'green', icon: '💰', position: 1, archivedAt: null, createdBy: 'danny', createdAt: iso(4 * D) },
  { id: TP[2]!, conversationId: 'temas', name: 'Legal', color: 'orange', icon: '⚖️', position: 2, archivedAt: null, createdBy: 'laura', createdAt: iso(3 * D) },
  { id: TP[3]!, conversationId: 'temas', name: 'Marketing', color: 'blue', icon: '📣', position: 3, archivedAt: null, createdBy: 'mateo', createdAt: iso(2 * D) },
];
seq = 0;
const tm = [
  msg('temas', 'mateo', 'Arrancamos el lanzamiento con Estudio Norte.', 2 * D),
  msg('temas', 'ana', 'La portada va en tonos violeta.', 2 * D - H, { topicId: TP[0] }),
  msg('temas', 'danny', 'Perfecto, la reviso hoy.', 2 * D - 2 * H, { topicId: TP[0] }),
  msg('temas', 'laura', 'Factura de septiembre enviada.', 30 * H, { topicId: TP[1] }),
  msg('temas', 'mateo', '¿Quién confirma el comité del jueves?', 26 * H),
  msg('temas', 'ana', 'El pago de la primera cuota entra el viernes.', 24 * H, { topicId: TP[1] }),
  msg('temas', 'danny', 'Yo confirmo el comité.', 20 * H),
  msg('temas', 'laura', 'Subí el contrato marco v3.', 10 * H, { topicId: TP[2] }),
  msg('temas', 'ana', 'La cláusula 4 necesita otra vuelta con el abogado.', 3 * H, { topicId: TP[2] }),
  msg('temas', 'mateo', 'Mañana llego a las 8 con el diseñador.', 2 * H),
  msg('temas', 'mateo', 'El reel del lanzamiento sale el lunes.', 90 * 60_000, { topicId: TP[3] }),
  msg('temas', 'laura', 'El abogado aprobó la cláusula 4 con un cambio.', 30 * 60_000, { topicId: TP[2] }),
];

const data: BootstrapDTO = {
  contract: 'dev', serverTime: new Date().toISOString(), features: { mail: true } as never,
  me: { id: 'danny', name: 'Danny Suárez', kind: 'human', title: 'Líder técnico', area: null, primaryOrgId: 'xertify', email: 'danny@demo.tiecoms.com' },
  organizations: [org('xertify', 'Xertify', 'X', '#dcd0f2', '#3b2a5a', true), org('norte', 'Estudio Norte', 'EN', '#e8d5a8', '#4a3a14')],
  workspaces: [{ id: 'ws1', name: 'Lanzamiento · Estudio Norte', department: 'Portal de certificados', glyph: null, owningOrgId: 'xertify', organizationIds: ['xertify', 'norte'], memberIds: ['danny', 'laura', 'mateo', 'ana'], myRole: 'lead', createdAt: iso(4 * D), pinnedAt: null },
    { id: 'wsx', name: 'Xertify', department: null, glyph: null, owningOrgId: 'xertify', organizationIds: ['xertify'], memberIds: ['danny', 'laura'], myRole: 'lead', createdAt: iso(9 * D), pinnedAt: null, isOrgHome: true }],
  conversations: [
    conv({ id: 'general', name: 'General', pinnedAt: iso(D), memberIds: ['danny', 'laura', 'mateo', 'ana'], lastMessageSeq: g.length, lastEventSeq: g.length, lastReadSeq: g.length - 1, unread: 1, unreadMentions: 1, lastMessagePreview: g[g.length - 1]!.body, openIssues: 2, linkCount: 6 }),
    conv({ id: 'diag', name: 'Diagnóstico · notificaciones duplicadas', kind: 'internal', level: null, internalOrgId: 'xertify', memberIds: ['danny', 'laura'], parentId: 'general', parentMessageId: 'general-m4', parentMessageSeq: 4, deriveKind: 'internal', deriveReason: 'Ana necesita saber si es el job o un reenvío', returnedAt: iso(5 * H), lastMessageSeq: dg.length, lastEventSeq: dg.length, lastReadSeq: dg.length }),
    conv({ id: 'dec', name: 'Decisión · fecha de salida', level: 'directivo', memberIds: ['danny', 'mateo'], parentId: 'general', parentMessageId: 'general-m2', parentMessageSeq: 2, deriveKind: 'directive', lastMessageSeq: 0 }),
    conv({ id: 'multi1', kind: 'multi', workspaceId: null, level: null, name: 'Equipo mixto', avatarUrl: '/chaggu-logo.svg', memberIds: ['danny', 'mateo', 'ana', 'laura'], unread: 2, lastMessagePreview: '¿Nos vemos el jueves?' }),
    conv({ id: 'side1', kind: 'multi', workspaceId: null, level: null, name: 'Sidechat · Veo notificaciones duplicadas en las…', memberIds: ['danny', 'laura'], parentId: 'general', parentMessageId: 'general-m4', parentMessageSeq: 4, deriveKind: 'side', lastMessageSeq: sd.length, lastEventSeq: sd.length, lastReadSeq: sd.length - 1, unread: 1, lastMessagePreview: sd[2]!.body }),
    conv({ id: 'dm-ana', kind: 'direct', workspaceId: null, level: null, memberIds: ['danny', 'ana'], lastMessageSeq: dm.length, lastEventSeq: dm.length, lastReadSeq: dm.length, lastMessagePreview: dm[1]!.body }),
    // Empresa bajo el nombre (1.7.1): uno ya empieza por la empresa y no la repite; directo con alguien de otra empresa.
    conv({ id: 'xflow', workspaceId: 'wsx', name: 'Xertify - Xertiflow', memberIds: ['danny', 'laura'], lastMessageAt: iso(3 * H), lastMessagePreview: 'Subí la versión 2 del flujo.' }),
    conv({ id: 'pagos', workspaceId: 'wsx', name: 'Pagos', memberIds: ['danny', 'laura'], lastMessageAt: iso(26 * H), lastMessagePreview: 'Factura de septiembre lista.' }),
    conv({ id: 'dm-mateo', kind: 'direct', workspaceId: null, level: null, memberIds: ['danny', 'mateo'], lastMessageAt: iso(4 * H), lastMessagePreview: 'Nos vemos el viernes.' }),
    conv({ id: 'temas', name: 'Lanzamiento con temas', memberIds: ['danny', 'laura', 'mateo', 'ana'], lastMessageSeq: tm.length, lastEventSeq: tm.length, lastReadSeq: 8, unread: 4, lastMessageAt: iso(30 * 60_000), lastMessagePreview: tm[tm.length - 1]!.body }),
    conv({ id: 'internal', name: 'Equipo interno', kind: 'internal', level: null, internalOrgId: 'xertify', memberIds: ['danny', 'laura'] }),
  ],
  people: [person('danny', 'Danny Suárez', 'xertify', 'Líder técnico'), person('laura', 'Laura Gómez', 'xertify', 'Soporte'), person('mateo', 'Mateo Rivas', 'norte', 'Director de proyectos'), { ...person('ana', 'Ana Torres', 'norte', 'Coordinadora'), sleep: { start: `${String((new Date().getHours() + 23) % 24).padStart(2, '0')}:00`, end: `${String((new Date().getHours() + 7) % 24).padStart(2, '0')}:00`, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } }],
};
const issue = (i: Partial<IssueDTO> & { id: string; title: string }): IssueDTO => ({
  workspaceId: 'ws1', conversationId: 'general', originMessageId: null, originMessageSeq: null, status: 'open', waitingOnOrgId: null, ownerId: 'danny', requestedBy: null,
  dueDate: null, createdBy: 'danny', createdAt: iso(3 * D), updatedAt: iso(H), statusSince: iso(H), closedAt: null, commentCount: 0, ...i,
});
const issues: Record<string, IssueDTO> = {
  i1: issue({ id: 'i1', title: 'Plantilla final de certificados', status: 'waiting', waitingOnOrgId: 'norte', ownerId: 'ana', requestedBy: 'danny', originMessageId: 'general-m3', originMessageSeq: 3, statusSince: iso(4 * D), dueDate: new Date(now - D).toISOString().slice(0, 10) }),
  i2: issue({ id: 'i2', title: 'Prueba de carga con 500 registros', status: 'in_progress', ownerId: 'danny', dueDate: new Date(now + 2 * D).toISOString().slice(0, 10), commentCount: 2 }),
  i3: issue({ id: 'i3', title: 'Confirmar fecha con dirección', status: 'done', ownerId: 'mateo', closedAt: iso(D) }),
  i4: issue({ id: 'i4', title: 'Revisar logs del envío', status: 'open', ownerId: 'danny', parentIssueId: 'i1', visibility: 'org', visibleOrgId: 'xertify', viewerIds: ['danny'] }),
  i5: issue({ id: 'i5', title: 'Ajustar la plantilla', status: 'done', ownerId: 'laura', parentIssueId: 'i1', visibility: 'org', visibleOrgId: 'xertify', viewerIds: ['danny', 'laura'], closedAt: iso(H) }),
  i6: issue({ id: 'i6', title: 'Responderle a Ana', status: 'in_progress', ownerId: 'laura', parentIssueId: 'i1' }),
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
  status: 'ready', connection: 'online', data, issues, events, reminders, mails,
  scheduled: [
    { id: 's1', conversationId: 'general', body: 'Ana, ¿ya revisaste la cláusula 4 del contrato? Necesito respuesta antes del comité.', mentions: [], replyTo: null, sendAt: new Date(Date.now() + 14 * H).toISOString(), status: 'pending', messageId: null, error: null, createdAt: iso(H), sentAt: null },
    { id: 's2', conversationId: 'general', body: 'Recordatorio: mañana cerramos la plantilla final.', mentions: [], replyTo: null, sendAt: new Date(Date.now() + 38 * H).toISOString(), status: 'pending', messageId: null, error: null, createdAt: iso(H), sentAt: null },
  ], pins: { general: ['general-m3'] },
  conversations: {
    general: { messages: g, lastEventSeq: g.length, hasMore: false, loaded: true, loading: false },
    diag: { messages: dg, lastEventSeq: dg.length, hasMore: false, loaded: true, loading: false },
    dec: { messages: [], lastEventSeq: 0, hasMore: false, loaded: true, loading: false },
    side1: { messages: sd, lastEventSeq: sd.length, hasMore: false, loaded: true, loading: false },
    temas: { messages: tm, lastEventSeq: tm.length, hasMore: false, loaded: true, loading: false },
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
  waChat('573005550001@s.whatsapp.net', 'Carla Rojas', 'clientes', { isGroup: false, participants: null, unread: 1, lastPreview: '¿Nos vemos mañana a las 10?', lastMessageAt: iso(10 * 60_000) }),
];
// WhatsApp en la bandeja (docs/WA-BANDEJA-GG-CHAT.md): uno fijado y otro sin leer en Grupos, uno en DMs.
Object.assign(waChats[0]!, { inboxPlace: 'groups', inboxPinnedAt: iso(D), accountStatus: 'connected' });
Object.assign(waChats[1]!, { inboxPlace: 'groups', inboxPinnedAt: null, accountStatus: 'connected' });
Object.assign(waChats[7]!, { inboxPlace: 'dms', inboxPinnedAt: null, accountStatus: q.get('waoff') ? 'logged_out' : 'connected' });
data.waInbox = waChats.filter((c: any) => c.inboxPlace) as any;
data.mailPins = [{ provider: 'google', threadKey: 'th-coop', messageId: 'm-coop', subject: 'Propuesta Coopcentral', from: { name: 'Jorge Pérez', email: 'jorge@coopcentral.com' }, date: iso(3 * H), mainPinnedAt: iso(H), mailPinnedAt: null }];
// «gg de este chat» sin backend: un hilo por fuente y respuestas fijas (?consent=0 para ver el permiso).
if (q.get('consent') !== '0') data.me.aiConsent = true;
const ggThreads: Record<string, any[]> = {};
const ggMsg = (role: 'user' | 'gg', body: string, extra: any = null, quoted: any = null) => ({ id: `gs-${Math.random().toString(36).slice(2)}`, role, body, extra, quoted, createdAt: new Date().toISOString() });
const ggConsent = () => { if (!client.getState().data?.me.aiConsent) throw Object.assign(new Error('Autoriza el uso de IA'), { status: 403, code: 'ai_consent_required' }); };
const waMsgs = [
  { id: 'a', fromMe: false, author: 'Laura Gómez', kind: 'text', body: '¿Quién revisa el PR de firmas?', sentAt: iso(3 * H) },
  { id: 'b', fromMe: true, author: null, kind: 'text', body: 'Yo lo miro después del almuerzo', sentAt: iso(2 * H) },
  { id: 'c', fromMe: false, author: 'Carlos', kind: 'image', body: '📷 Captura del error', sentAt: iso(H) },
  { id: 'd', fromMe: false, author: 'Laura Gómez', kind: 'text', body: 'El despliegue quedó listo ✅', sentAt: iso(20 * 60_000) },
];
(client as any).listMentions = async () => ({ hasMore: false, mentions: g.filter((m) => m.mentions?.some((x) => x.userId === 'danny')).map((m) => ({ message: m, conversationId: 'general', all: false, read: false, createdAt: m.createdAt })) });
const SAMPLE_CODE: Record<string, string> = {
  c1: `// Sincroniza las entidades de la cuenta con cada flujo\nimport { db } from './db';\n\ninterface Entidad { id: string; nombre: string; flujo?: string }\n\nexport async function sincronizar(cuenta: string): Promise<number> {\n  const entidades: Entidad[] = await db.entidades(cuenta);\n  let cambios = 0;\n  for (const e of entidades) {\n    if (!e.flujo) continue; // sin flujo, no se toca\n    cambios += await db.actualizar(e.id, { nombre: e.nombre.trim() });\n  }\n  return cambios;\n}\n`,
  c2: `# Levantamiento homologaciones\n\n- **Responsable:** Santiago\n- Entidades en la cuenta de Alonso\n\n## Pendientes\n\n1. Cargar en PROD\n2. Revisar \`id: asignaturas\`\n\n> Se actualiza de acuerdo a cada flujo.\n`,
};
(client as any).fetchBlob = async (path: string) => { const id = path.split('/').pop()!; return SAMPLE_CODE[id] ? new Blob([SAMPLE_CODE[id]!], { type: 'text/plain' }) : (await fetch('/chaggu-logo.svg')).blob(); };
// Subidas simuladas: devuelven un AttachmentDTO y el envío queda en cola (sin backend).
(client as any).uploadAttachment = async (_c: string, f: File, name: string) => { await new Promise((r) => setTimeout(r, 300)); return att(`up-${Date.now()}`, name, f.type || 'application/octet-stream', f.size); };
(client as any).uploadAttachmentThumb = async (id: string) => att(id, 'thumb', 'image/jpeg', 1);
// Correo de ejemplo (cuadrícula): lista, correo completo con su diseño y llevarlo a un chat.
const mailAddr = (name: string, email: string) => ({ name, email });
const mailItem = (id: string, name: string, email: string, subject: string, snippet: string, ago: number) => ({ provider: 'google' as const, id, threadId: id, from: mailAddr(name, email), to: [mailAddr('Danny', 'danny@xertify.co')], subject, snippet, date: iso(ago), unread: ago < H, hasAttachments: false, box: 'inbox' as const });
const mailItems = [
  mailItem('m1', 'Alertas y Notificaciones', 'alertas@bancolombia.com.co', 'Todo salió bien con tus movimientos', 'Compraste USD1.464,75 en DLC*INNOVATION EXPER con tu T.Cred *5307', 20 * 60_000),
  mailItem('m2', 'ANDI Seccional', 'boletin@andi.com.co', 'Boletín #342 · El agua de Bogotá', 'Cundinamarca y Boyacá: les compartimos nuestro Boletín #342', 2 * H),
  mailItem('m3', 'Gemini', 'gemini-notes@google.com', 'Notes: “Workshop de microcredenciales”', 'Notes from “Workshop”. The content was sent to invited guests.', 3 * H),
];
const mailHtml: Record<string, string> = {
  m1: '<div style="background:#2b2b2b;color:#fff;padding:14px 16px;font-weight:700">Bancolombia</div><div style="background:#2b2b2b;color:#fff;padding:2px 16px 18px"><small style="color:#f2c200;font-weight:700">¡Listo!</small><h2 style="margin:4px 0 0;font-size:19px">Todo salió bien con tus movimientos</h2></div><div style="padding:14px 16px"><p>Hola Danny,</p><p>Compraste <b>USD 1.464,75</b> en DLC*INNOVATION EXPER con tu T.Cred *5307.</p><p style="background:#fff8d6;padding:9px 11px;border-radius:8px">Tu seguridad es nuestra prioridad.</p></div>',
  m2: '<div style="background:#1b4f9c;color:#fff;padding:14px 16px"><small>Boletín #342</small><h2 style="margin:2px 0 0">El agua de Bogotá</h2></div><div style="padding:14px 16px"><p>Cundinamarca y Boyacá: les compartimos nuestro Boletín #342.</p></div>',
};
(client as any).mailConnections = async () => [{ provider: 'google', label: 'Gmail', available: true, unavailableReason: null, status: 'active', accountEmail: 'danny@xertify.co' }];
(client as any).mailUnread = async () => 3;
(client as any).listMail = async () => ({ items: mailItems, nextPage: null, accountEmail: 'danny@xertify.co' });
(client as any).getMail = async (_p: string, id: string) => ({ ...mailItems.find((m) => m.id === id)!, cc: [], body: mailItems.find((m) => m.id === id)!.snippet + '\n\n(texto plano del correo)', attachments: [] });
(client as any).liveMailHtml = async (_p: string, id: string) => ({ html: mailHtml[id] ?? null });
(window as any).__shared = [];
(client as any).shareMail = async (input: unknown) => { (window as any).__shared.push(['mail', input]); return {}; };
(client as any).shareWhatsApp = async (input: unknown) => { (window as any).__shared.push(['wa', input]); return {}; };
(waAccounts as any[]).forEach((a) => { a.sendEnabled = false; });
(client as any).replyLiveMail = async (p: string, id: string, input: unknown) => { (window as any).__shared.push(['mail-reply', p, id, input]); return { ok: true, to: [] }; };
(client as any).sendWhatsApp = async (a: string, j: string, text: string) => { (window as any).__shared.push(['wa-send', a, j, text]); return { id: 'o1', status: 'sent' }; };
// GIFs y memes de ejemplo (sin backend): cuadros de colores como imágenes.
const gifImg = (bg: string, label: string, w = 300, h = 220) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${bg}"/><text x="50%" y="50%" font-size="34" font-family="sans-serif" fill="#fff" text-anchor="middle" dominant-baseline="middle">${label}</text></svg>`)}`;
const gifItems = [['#3b6ea8', 'gato', 300, 220], ['#a8553b', 'perro', 300, 300], ['#3ba87a', 'baile', 300, 180], ['#7a3ba8', 'aplauso', 300, 260], ['#a83b6e', 'risa', 300, 200], ['#a89a3b', 'ok', 300, 240]].map(([bg, label, w, h], i) => ({
  id: `openverse:${i}`, provider: 'openverse', title: String(label), previewUrl: gifImg(String(bg), String(label), Number(w), Number(h)), url: gifImg(String(bg), String(label), Number(w), Number(h)),
  width: Number(w), height: Number(h), attribution: `GIF: «${label}» · Ana · CC BY-SA 4.0 · Wikimedia Commons (vía Openverse)`, sourceUrl: null,
}));
const memeItems = [['#444', 'Drake', 2], ['#555', 'Distracted', 3], ['#666', 'Success Kid', 2], ['#777', 'Two Buttons', 2]].map(([bg, label, boxes], i) => ({
  id: `memegen:${i}`, provider: 'memegen', title: String(label), previewUrl: gifImg(String(bg), String(label), 400, 400), url: gifImg(String(bg), String(label), 400, 400), width: 400, height: 400, attribution: null, sourceUrl: null, boxCount: Number(boxes),
}));
(client as any).request = async (path: string, init: any = {}) => {
  if (path.startsWith('/gifs/search') || path.startsWith('/gifs/trending')) return { provider: 'openverse', items: gifItems, next: null, poweredBy: { label: 'Wikimedia Commons · Openverse', url: 'https://openverse.org' } };
  if (path.startsWith('/memes/templates')) return { provider: 'memegen', items: memeItems, next: null, poweredBy: { label: 'memegen.link · código abierto', url: 'https://memegen.link' } };
  if (/^\/conversations\/[^/]+\/gifs$/.test(path) && init.method === 'POST') return { attachment: att(`gif-${Date.now()}`, 'gato.gif', 'image/gif', 90_000), attribution: 'GIF: «gato» · Ana · CC BY-SA 4.0 · Wikimedia Commons (vía Openverse)' };
  if (/^\/attachments\/[^/]+\/link$/.test(path) && init.method === 'POST') { const id = path.split('/')[2]; const a = g.flatMap((m) => m.attachments ?? []).find((x) => x.id === id); return { url: `${location.origin}/archivo/demo-${id}-token-0123456789`, name: a?.name ?? 'archivo', expiresAt: new Date(now + 7 * D).toISOString() }; }
  if (path.startsWith('/file-links/') && init.method === 'DELETE') return { ok: true };
  if (path === '/mail/pins' && init.method === 'PUT') {
    const j = init.json; const list = [...((client.getState().data as any)?.mailPins ?? [])];
    const at = list.findIndex((p: any) => p.provider === j.provider && p.threadKey === j.threadKey);
    const prev = at >= 0 ? list[at] : { provider: j.provider, threadKey: j.threadKey, mainPinnedAt: null, mailPinnedAt: null };
    const now = new Date().toISOString();
    const next = { ...prev, messageId: j.messageId, subject: j.subject, from: j.from ?? null, date: j.date ?? null,
      mainPinnedAt: j.main === undefined ? prev.mainPinnedAt : j.main ? prev.mainPinnedAt ?? now : null, mailPinnedAt: j.mail === undefined ? prev.mailPinnedAt : j.mail ? prev.mailPinnedAt ?? now : null };
    if (at >= 0) list[at] = next; else list.unshift(next);
    return { pins: list.filter((p: any) => p.mainPinnedAt || p.mailPinnedAt) };
  }
  if (/^\/whatsapp\/accounts\/[^/]+$/.test(path) && init.method === 'PATCH') { const a = (waAccounts as any[]).find((x) => path.endsWith(x.id))!; Object.assign(a, init.json); return a; }
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
    const c = waChats.find((x) => x.jid === jid)! as any;
    const { inboxPlace, inboxPinned, ...rest } = init.json;
    Object.assign(c, rest, rest.category !== undefined ? { categoryManual: rest.category !== null } : {});
    // Igual que el API: 'auto' según sea grupo; fijar sin mover lo mueve; sacar también desfija.
    if (inboxPlace !== undefined) c.inboxPlace = inboxPlace === 'auto' ? (c.isGroup ? 'groups' : 'dms') : inboxPlace;
    if (inboxPinned === true) { c.inboxPinnedAt ??= new Date().toISOString(); c.inboxPlace ??= c.isGroup ? 'groups' : 'dms'; }
    if (inboxPinned === false) c.inboxPinnedAt = null;
    if (!c.inboxPlace) { c.inboxPlace = null; c.inboxPinnedAt = null; }
    c.accountStatus ??= 'connected';
    return { ...c };
  }
  if (path === '/whatsapp/organize') return { reviewed: 7, changed: 0 };
  if (path === '/gg/side/pending/refresh') return { source: init.json.source, pending: 2, recalculated: false };
  if (path.startsWith('/gg/side/pending')) { const src = decodeURIComponent(path.split('sources=')[1] ?? ''); return Object.fromEntries(src.split(',').map((x) => [x, 2])); }
  if (path.startsWith('/gg/side?')) { const src = decodeURIComponent(path.split('source=')[1]!); return { session: 1, messages: ggThreads[src] ?? [], pending: 2 }; }
  if (path === '/gg/side/open') { ggConsent(); const m = ggMsg('gg', 'Leí este chat. Hay 2 cosas que esperan algo de ti:', { pending: [{ text: 'Mateo pregunta si la integración queda para el viernes' }, { text: 'Confirmar el formato de los certificados con Ana' }], followUps: ['¿Qué acordamos?', 'Resúmeme'] }); (ggThreads[init.json.source] ??= []).push(m); return { message: m }; }
  if (path === '/gg/side/new') { ggThreads[init.json.source] = []; return { session: 2 }; }
  if (path === '/gg/side' && init.method === 'POST') { ggConsent(); await new Promise((r) => setTimeout(r, 500)); const th = (ggThreads[init.json.source] ??= []); th.push(ggMsg('user', init.json.text)); const m = ggMsg('gg', 'Acordaron tener la integración el viernes; falta validar el formato con Ana.', { followUps: ['¿Quién valida el formato?', '¿Para cuándo?', 'Responder por mí'] }); th.push(m); return { message: m }; }
  if (path === '/gg/side/reply-for-me') {
    ggConsent(); await new Promise((r) => setTimeout(r, 500));
    const drafts = [{ style: 'short', text: 'Sí, queda para el viernes.' }, { style: 'warm', text: '¡Claro, Mateo! El viernes la tenemos lista; hoy valido el formato con Ana.' }, { style: 'action', text: 'Queda para el viernes. Me anoto validar el formato con Ana mañana.', action: { kind: 'task', title: 'Validar formato con Ana', assigneeName: 'Danny', due: new Date(now + D).toISOString().slice(0, 10) } }];
    (ggThreads[init.json.source] ??= []).push(ggMsg('gg', 'Te propongo estas respuestas. Elige una y edítala antes de enviar.', { drafts }));
    return { drafts };
  }
  if (path === '/gg/side/suggest') {
    ggConsent(); await new Promise((r) => setTimeout(r, 400));
    const ids = init.json.messageIds;
    const suggestions = [
      { id: 's1', kind: 'task', title: 'Crear tarea: validar formato con Ana', params: { assigneeName: 'Danny', due: new Date(now + D).toISOString().slice(0, 10) }, forMessageIds: ids },
      { id: 's2', kind: 'reply', title: 'Responder por mí', draft: 'Sí, el viernes queda lista.', forMessageIds: ids },
      { id: 's3', kind: 'reminder', title: 'Recordatorio: revisar la integración', params: { due: new Date(now + D).toISOString().slice(0, 10) }, forMessageIds: ids },
      { id: 's4', kind: 'summary', title: 'Resumir', forMessageIds: ids },
    ];
    (ggThreads[init.json.source] ??= []).push(ggMsg('gg', `Esto puedo hacer con estos ${ids.length} mensajes:`, { suggestions }));
    return { suggestions };
  }
  if (path === '/blocks') return { userIds: [] };
  // Temas: llegan tarde a propósito (?lento=ms), como en un teléfono con mala señal; así se prueba que abrir en el
  // tema del mensaje no depende de que ya estén cargados.
  if (path === '/conversations/temas/topics') { await new Promise((r) => setTimeout(r, Number(q.get('lento') ?? 400))); return { topics: topicsTemas }; }
  if (path === '/conversations/temas/topics/order') {
    const ids: string[] = init.json.ids;
    topicsTemas.forEach((x) => { if (ids.includes(x.id)) x.position = ids.indexOf(x.id); });
    topicsTemas.sort((a, b) => a.position - b.position);
    return { topics: topicsTemas.map((x) => ({ ...x })) };
  }
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
// Nightly regression fixtures are deliberately isolated from production and real recipients.
if (q.has('nightly')) {
  Object.assign(mails.em1,{from:{name:'Equipo de pruebas',email:'qa@example.test'},accountEmail:'tester@example.test',subject:'Solicitud de revisión de prueba',snippet:'Revisa el adjunto de prueba.',body:'Este correo contiene datos sintéticos para validar el flujo de revisión.',comment:'¿Puedes revisar esta solicitud?'});
  for(const message of g) if(message.kind==='system' && message.body.includes('mail.shared')) message.body=JSON.stringify({k:'mail.shared',emailId:'em1',comment:'¿Puedes revisar esta solicitud?'});
  for(const mail of mailItems) {mail.from={name:'Equipo de pruebas',email:'qa@example.test'};mail.to=[{name:'Persona de prueba',email:'tester@example.test'}];mail.subject='Solicitud de revisión de prueba';mail.snippet='Mensaje sintético para la prueba de correo lateral.';mailHtml[mail.id]='<p>Correo sintético de prueba. No contiene información de clientes.</p>';}
  const mark=document.createElement('div'); mark.textContent='QA local · datos sintéticos'; mark.style.cssText='position:fixed;bottom:0;left:75px;z-index:9999;font:10px sans-serif;padding:3px 6px;background:#fff9;color:#333;pointer-events:none';document.body.appendChild(mark);
  (client as any).issueDetail=async(id:string)=>{await new Promise(resolve=>setTimeout(resolve,180));const row=client.getState().issues[id] ?? {...issues.i2,id,title:'Tarea cargada después de abrir'};(client as any).set({issues:{...client.getState().issues,[id]:row}});return {issue:row,events:[]};};
  (window as any).__openLateIssue=()=>openDialog(close=><IssueDrawer id='fixture-late' onClose={close}/>);

  seq = Math.max(...g.map((m) => m.seq));
  data.people.find((p) => p.id === 'laura')!.availability = { mode: 'focus', until: new Date(Date.now()+3600000).toISOString(), silent: true, revision: 1 };
  g.push(msg('general','laura','**Prueba de lectura completa**\n- Primero\n- Segundo\n\n```typescript\nconst mensaje = "hola";\nconsole.log(mensaje);\n```\n' + ('Un párrafo de prueba largo que conserva toda su información.\n\n').repeat(75) + 'FIN DEL MENSAJE LARGO',0));
  const conv = data.conversations.find((c) => c.id === 'general')!; conv.lastMessageSeq = g.length;
  let prefs = { sections: [], conversations: {}, issues: { view: 'board', grouping: 'group' } };
  const original = client.request.bind(client);
  (window as any).__requests = [];
  (client as any).request = async (path: string, init: any = {}) => {
    (window as any).__requests.push({path,method:init.method ?? 'GET'});
    if (path === '/me/personal-preferences') { if (init.json) prefs = {...prefs,...init.json,issues:{...prefs.issues,...init.json.issues}}; return prefs; }
    if (path === '/gg/calendar/slots') return { status:'ready',provider:'google',checkedAt:new Date().toISOString(),timezone:init.json.timezone,slots:[{startsAt:init.json.from,endsAt:new Date(Date.parse(init.json.from)+3600000).toISOString()}] };
    return original(path,init);
  };
  (client as any).loadIssues = async () => Object.values(client.getState().issues);
  (client as any).updateIssue = async (id: string, patch: any) => { const next = {...client.getState().issues[id], ...patch}; (client as any).set({ issues: {...client.getState().issues,[id]:next} }); return next; };
  ggThreads['c:general'] = [ggMsg('gg','Archivo «Certificados_Embolizacion_' + 'muy_largo_'.repeat(25) + '»\n' + 'Contenido de prueba que debe permanecer dentro del panel. '.repeat(20),{followUps:['¿Quieres revisar este mensaje muy largo con nombres sin espacios?','¿Ver disponibilidad?']})];
}
// Para las pruebas en el navegador: el cliente y la burbuja de mensaje nuevo.
Object.assign(window, { __client: client, __bubble: showMessageBubble });
history.replaceState(null, '', q.get('to') ?? '/');
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
