import { describe, expect, it } from 'vitest';
import type { BootstrapDTO, ConversationDTO } from '@tiecoms/contracts';
import { companyLine, companyOf, destinationLabel, directWith, issueDestinations, peopleByOrg, quickSearch, recentPeopleIds, searchChats, searchGroups, searchPeople, type Namer } from '../src/quick-search.ts';

// Búsqueda rápida (personas, grupos y chats), «Recientes» de Mensaje nuevo y destinos de «＋ Nuevo asunto».
// Mismo escenario que apps/ios/TieComsTests/QuickSearchTests.swift.
const conv = (c: Partial<ConversationDTO> & { id: string }): ConversationDTO => ({
  workspaceId: null, kind: 'group', level: null, name: null, internalOrgId: null, memberIds: [], lastMessageSeq: 0, lastEventSeq: 0,
  lastMessageAt: null, lastMessagePreview: null, lastReadSeq: 0, unread: 0, canPost: true, canManage: false, historyFromSeq: 0,
  parentId: null, parentMessageId: null, parentMessageSeq: null, deriveKind: null, deriveReason: null, returnedAt: null, openIssues: 0, pinnedAt: null, mutedUntil: null, ...c,
});
const ws = (id: string, name: string, owningOrgId: string, organizationIds: string[], myRole: 'member' | 'guest' = 'member', isOrgHome = false) =>
  ({ id, name, department: null, glyph: null, owningOrgId, organizationIds, memberIds: [], myRole, createdAt: '2026-09-01', pinnedAt: null, isOrgHome });
const org = (id: string, name: string, mine = false) => ({ id, name, mark: name[0]!, colorBg: '#eee', colorFg: '#111', ...(mine ? { myRole: 'owner' as const } : {}) });
const person = (id: string, name: string, orgId: string | null, extra: { title?: string; kind?: 'human' | 'agent' } = {}) =>
  ({ id, name, kind: extra.kind ?? 'human', orgId, title: extra.title ?? null, area: null, guest: false, guestUntil: null });

const d = {
  contract: 'test', serverTime: '',
  me: { id: 'me', name: 'Ana Ruiz', kind: 'human', title: null, area: null, primaryOrgId: 'oA', email: 'ana@x.co' },
  organizations: [org('oA', 'Xertify', true), org('oB', 'Ongoing'), org('oC', 'Acme')],
  workspaces: [ws('wHome', 'Xertify', 'oA', ['oA'], 'member', true), ws('wRel', 'Mentorías', 'oB', ['oB', 'oA']), ws('wGuest', 'Programa', 'oC', ['oC'], 'guest')],
  conversations: [
    conv({ id: 'g1', workspaceId: 'wHome', name: 'Pagos', memberIds: ['me', 'col'], lastMessageAt: '2026-09-25T10:00:00Z' }),
    conv({ id: 'r1', workspaceId: 'wRel', name: 'Mentoría 1', memberIds: ['me', 'bob'], lastMessageAt: '2026-09-25T09:00:00Z' }),
    conv({ id: 'th', workspaceId: 'wRel', name: 'Hilo · Pagos', parentId: 'r1', deriveKind: 'same', memberIds: ['me', 'bob'] }),
    conv({ id: 'x1', workspaceId: 'wGuest', name: 'Cohorte', memberIds: ['me'] }),
    conv({ id: 'ro', workspaceId: 'wHome', name: 'Anuncios', memberIds: ['me'], canPost: false }),
    conv({ id: 'd1', kind: 'direct', memberIds: ['me', 'bob'], lastMessageAt: '2026-09-20T11:00:00Z' }),
    conv({ id: 'd2', kind: 'direct', memberIds: ['me', 'col'], lastMessageAt: '2026-09-26T11:00:00Z' }),
    conv({ id: 'm1', kind: 'multi', name: 'Café', memberIds: ['me', 'bob', 'col'], lastMessageAt: '2026-09-21T11:00:00Z' }),
  ],
  people: [person('me', 'Ana Ruiz', 'oA'), person('col', 'Carla Pérez', 'oA', { title: 'Pagos' }), person('bob', 'Bob', 'oB'), person('mar', 'Mariana', 'oB'),
    person('ana2', 'Ánalía', 'oB'), person('bot', 'Asistente', 'oA', { kind: 'agent' })],
} as BootstrapDTO;
const names: Namer = { title: (c) => c.kind === 'direct' ? d.people.find((p) => p.id === c.memberIds.find((m) => m !== 'me'))?.name ?? '' : c.name ?? '' };
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe('búsqueda rápida', () => {
  it('personas sin directo también salen; nunca yo ni los agentes', () => {
    expect(ids(searchPeople(d, 'mariana'))).toEqual(['mar']);
    expect(searchPeople(d, 'ana').every((p) => p.id !== 'me')).toBe(true);
    expect(searchPeople(d, 'asist')).toEqual([]);
    expect(searchPeople(d, ' ')).toEqual([]);
  });

  it('por empresa y cargo, sin tildes; primero quien empieza con lo escrito', () => {
    // «ana»: Ánalía empieza con lo escrito (sin tildes) y va antes que Mariana, que solo lo contiene.
    expect(ids(searchPeople(d, 'ana'))).toEqual(['ana2', 'mar']);
    expect(new Set(ids(searchPeople(d, 'ONGOING')))).toEqual(new Set(['bob', 'mar', 'ana2']));
    expect(ids(searchPeople(d, 'pagos'))).toEqual(['col']);
    expect(searchPeople(d, 'ongoing', ['bob'])).toHaveLength(2);
  });

  it('con quien ya hablo va antes, luego por nombre', () => {
    // «o» (en Ongoing): Bob tiene directo y va primero; Ánalía y Mariana por nombre.
    expect(ids(searchPeople(d, 'ongoing'))).toEqual(['bob', 'ana2', 'mar']);
  });

  it('grupos por nombre o empresa de la otra parte, sin hilos ni chats', () => {
    expect(ids(searchGroups(d, 'pagos', names))).toEqual(['g1']);
    expect(ids(searchGroups(d, 'ongoing', names))).toEqual(['r1']);
    expect(searchGroups(d, 'café', names)).toEqual([]);
    expect(ids(searchChats(d, 'cafe', names))).toEqual(['m1']);
  });

  it('quien ya tiene su directo entre los chats encontrados no se repite en Personas', () => {
    const r = quickSearch(d, 'bob', names);
    expect(ids(r.chats)).toEqual(['m1', 'd1']);
    expect(r.people).toEqual([]);
    expect(ids(quickSearch(d, 'mariana', names).people)).toEqual(['mar']);
  });

  it('directo existente y «Recientes» (el más reciente primero)', () => {
    expect(directWith(d, 'bob')?.id).toBe('d1');
    expect(directWith(d, 'mar')).toBeNull();
    expect(recentPeopleIds(d)).toEqual(['col', 'bob']);
  });

  it('personas por empresa: mi equipo primero', () => {
    expect(peopleByOrg(d, '').map((g) => g.orgId)).toEqual(['oA', 'oB']);
    expect(ids(peopleByOrg(d, '')[0]!.people)).toEqual(['col']);
    expect(peopleByOrg(d, 'mari').flatMap((g) => ids(g.people))).toEqual(['mar']);
  });

  it('destinos de «Nuevo asunto»: sin terceros, sin solo lectura, sin hilos; el más reciente primero', () => {
    const list = ids(issueDestinations(d));
    expect(list).not.toContain('x1');
    expect(list).not.toContain('ro');
    expect(list).not.toContain('th');
    expect(list[0]).toBe('d2');
    expect(destinationLabel(d, d.conversations.find((c) => c.id === 'r1')!, 'Mentoría 1')).toBe('Mentoría 1 · Ongoing');
    expect(destinationLabel(d, d.conversations.find((c) => c.id === 'd2')!, 'Carla Pérez')).toBe('Carla Pérez');
  });
});

describe('empresa bajo el nombre', () => {
  const c = (id: string) => d.conversations.find((x) => x.id === id)!;
  it('grupos: la otra parte, la anfitriona si soy invitado o la mía', () => {
    expect(companyOf(d, c('r1'))).toBe('Ongoing');
    expect(companyOf(d, c('x1'))).toBe('Acme');
    expect(companyOf(d, c('g1'))).toBe('Xertify');
  });
  it('directo 1:1: la empresa de la otra persona; varias personas y sidechats: ninguna', () => {
    expect(companyOf(d, c('d1'))).toBe('Ongoing');
    expect(companyOf(d, c('m1'))).toBeNull();
    expect(companyOf(d, conv({ id: 's', kind: 'multi', deriveKind: 'side', parentId: 'r1', memberIds: ['me', 'bob'] }))).toBeNull();
  });
  it('no duplica si el nombre ya empieza por la empresa', () => {
    expect(companyLine(d, c('g1'), 'Xertify - Xertiflow')).toBeNull();
    expect(companyLine(d, c('r1'), 'Mentoría 1')).toBe('Ongoing');
  });
  it('la búsqueda por empresa sigue encontrando los grupos', () => {
    expect(ids(searchGroups(d, 'ongoing', names))).toEqual(['r1']);
  });
});
