import { describe, expect, it } from 'vitest';
import type { ConversationDTO } from '@tiecoms/contracts';
import { bucketOf, companyGroupLabel, compareConversations, withSeparators } from '../src/home-order.ts';
import { firstUnread } from '../src/chat-nav.ts';

// Orden único de la bandeja, separadores, etiqueta «Empresa · Grupo» y primer no leído (docs/GRUPOS.md, 27-sep-2026).
const conv = (c: Partial<ConversationDTO> & { id: string }): ConversationDTO => ({
  workspaceId: null, kind: 'group', level: null, name: null, internalOrgId: null, memberIds: [], lastMessageSeq: 0, lastEventSeq: 0,
  lastMessageAt: null, lastMessagePreview: null, lastReadSeq: 0, unread: 0, canPost: true, canManage: false, historyFromSeq: 0,
  parentId: null, parentMessageId: null, parentMessageSeq: null, deriveKind: null, deriveReason: null, returnedAt: null, openIssues: 0, pinnedAt: null, mutedUntil: null, ...c,
});
const future = new Date(Date.now() + 86400000).toISOString();
const ids = (xs: ConversationDTO[]) => xs.map((x) => x.id);

describe('orden de la bandeja', () => {
  const list = [
    conv({ id: 'old', lastMessageAt: '2026-09-20T10:00:00Z' }),
    conv({ id: 'new', lastMessageAt: '2026-09-26T10:00:00Z' }),
    conv({ id: 'unread', unread: 3, lastMessageAt: '2026-09-21T10:00:00Z' }),
    conv({ id: 'mention', unread: 1, unreadMentions: 1, lastMessageAt: '2026-09-19T10:00:00Z' }),
    conv({ id: 'mutedMention', unread: 2, unreadMentions: 1, mutedUntil: future, lastMessageAt: '2026-09-18T10:00:00Z' }),
    conv({ id: 'muted', unread: 5, mutedUntil: future, lastMessageAt: '2026-09-25T10:00:00Z' }),
    conv({ id: 'pinOld', pinnedAt: '2026-09-01T00:00:00Z', lastMessageAt: '2026-09-10T10:00:00Z' }),
    conv({ id: 'pinUnread', pinnedAt: '2026-09-02T00:00:00Z', unread: 1, lastMessageAt: '2026-09-11T10:00:00Z' }),
  ];
  it('fijadas primero; luego menciones, no leídos y actividad', () => {
    expect(ids([...list].sort(compareConversations))).toEqual(['pinUnread', 'pinOld', 'mention', 'mutedMention', 'unread', 'new', 'muted', 'old']);
  });
  it('una fijada leída va arriba de una mención sin leer', () => {
    const a = conv({ id: 'a', pinnedAt: '2026-09-01T00:00:00Z' });
    const b = conv({ id: 'b', unread: 4, unreadMentions: 2, lastMessageAt: '2026-09-26T10:00:00Z' });
    expect(ids([b, a].sort(compareConversations))).toEqual(['a', 'b']);
  });
  it('la actividad prefiere el último mensaje de una persona y desempata por id', () => {
    const a = conv({ id: 'a', lastMessageAt: '2026-09-26T10:00:00Z', lastHumanPreview: { messageId: 'm', seq: 1, authorId: 'x', body: '', attachments: null, createdAt: '2026-09-01T00:00:00Z' } });
    const b = conv({ id: 'b', lastMessageAt: '2026-09-02T00:00:00Z' });
    const c = conv({ id: 'c', lastMessageAt: '2026-09-02T00:00:00Z' });
    expect(ids([a, c, b].sort(compareConversations))).toEqual(['b', 'c', 'a']);
  });
  it('separadores Fijados · Sin leer · Recientes; los bloques vacíos no salen', () => {
    const blocks = withSeparators([...list].sort(compareConversations), (c) => c);
    expect(blocks.map((b) => [b.bucket, ids(b.items)])).toEqual([
      ['pinned', ['pinUnread', 'pinOld']], ['unread', ['mention', 'mutedMention', 'unread']], ['recent', ['new', 'muted', 'old']],
    ]);
    expect(withSeparators([conv({ id: 'x' })], (c) => c).map((b) => b.bucket)).toEqual(['recent']);
    expect(bucketOf(conv({ id: 'm', unread: 3, mutedUntil: future }))).toBe('recent');
  });
});

describe('etiqueta «Empresa · Grupo»', () => {
  it('pone la empresa delante', () => expect(companyGroupLabel('Ongoing', 'Mentoría 2')).toBe('Ongoing · Mentoría 2'));
  it('no la repite si el nombre ya empieza por ella (sin importar mayúsculas ni tildes)', () => {
    expect(companyGroupLabel('Nestlé', 'Nestle proveedores')).toBe('Nestle proveedores');
    expect(companyGroupLabel('Xertify', 'xertify · General')).toBe('xertify · General');
  });
  it('sin empresa queda el grupo', () => expect(companyGroupLabel(null, 'General')).toBe('General'));
});

describe('primer no leído al abrir un chat', () => {
  const msgs = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ({ seq: from + i }));
  it('sin no leídos abre al final', () => expect(firstUnread(msgs(1, 10), 10, 0, false)).toBeNull());
  it('el primero después de lo leído', () => expect(firstUnread(msgs(1, 50), 42, 8, true)).toEqual({ seq: 43 }));
  it('si no está cargado pide páginas antiguas', () => expect(firstUnread(msgs(51, 100), 20, 80, true)).toBe('older'));
  it('sin más historia, el primero cargado', () => expect(firstUnread(msgs(31, 100), 20, 80, false)).toEqual({ seq: 31 }));
  it('con huecos de seq (mensajes ocultos) toma el siguiente que exista', () => expect(firstUnread([{ seq: 5 }, { seq: 9 }, { seq: 12 }], 6, 6, false)).toEqual({ seq: 9 }));
  it('sin lo leído usa los últimos `unread` mensajes', () => expect(firstUnread(msgs(1, 20), null, 3, true)).toEqual({ seq: 18 }));
});
