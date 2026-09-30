import { describe, expect, it } from 'vitest';
import type { BootstrapDTO, ConversationDTO, PersonDTO, WorkspaceDTO } from '@tiecoms/contracts';
import { addCandidates, cachedLink, filterPeople, fold, inviteCall, inviteOptions, isEmail, linkKey, pendingForGroup, rememberLink } from '../src/add-invite.ts';

// «Agregar al grupo» con invitar (docs/GRUPOS.md, 28-sep-2026).
const person = (id: string, name: string, orgId: string | null, extra: Partial<PersonDTO> = {}): PersonDTO =>
  ({ id, name, kind: 'human', orgId, title: null, area: null, guest: false, guestUntil: null, ...extra });
const ws = (id: string, extra: Partial<WorkspaceDTO>): WorkspaceDTO => ({
  id, name: id, department: null, glyph: null, owningOrgId: 'xertify', organizationIds: ['xertify'], memberIds: ['me'], myRole: 'member',
  createdAt: '2026-09-01T00:00:00Z', pinnedAt: null, ...extra,
});
const conv = (id: string, workspaceId: string | null, extra: Partial<ConversationDTO> = {}) =>
  ({ id, workspaceId, kind: 'group', name: id, internalOrgId: null, memberIds: ['me'], ...extra }) as ConversationDTO;

const d = {
  me: { id: 'me', primaryOrgId: 'xertify' },
  organizations: [
    { id: 'xertify', name: 'Xertify', myRole: 'member' },
    { id: 'uniandes', name: 'Uniandes' },
    { id: 'nestle', name: 'Nestlé' },
  ],
  workspaces: [
    ws('home', { isOrgHome: true, memberIds: ['me', 'ana'] }),
    ws('rel', { organizationIds: ['xertify', 'uniandes'], memberIds: ['me', 'ana', 'uri'] }),
    ws('pend', { counterpartName: 'Bancolombia' }),
    ws('guestws', { owningOrgId: 'nestle', organizationIds: ['nestle'], myRole: 'guest', memberIds: [] }),
  ],
  conversations: [],
  people: [
    person('me', 'Yo', 'xertify'), person('ana', 'Ana', 'xertify'), person('jose', 'José Pérez', 'xertify', { title: 'Ventas' }),
    person('uri', 'Úrsula', 'uniandes'), person('mentor', 'Marta', null, { guest: true }), person('bot', 'Bot', 'xertify', { kind: 'agent' }),
  ],
} as unknown as BootstrapDTO;

describe('Agregar al grupo', () => {
  it('fold e isEmail', () => {
    expect(fold('  JOSÉ Ñandú ')).toBe('jose nandu');
    expect(isEmail('ana@acme.co')).toBe(true);
    expect(isEmail('ana@acme')).toBe(false);
    expect(isEmail('ana acme.co')).toBe(false);
  });

  it('candidatos: los del espacio y mis colegas que no están; sin agentes ni quien ya está', () => {
    const home = addCandidates(d, conv('g', 'home', { memberIds: ['me', 'ana'] }));
    expect(home.map((p) => p.id)).toEqual(['jose']); // José no está en el espacio casa, pero es colega
    const rel = addCandidates(d, conv('g', 'rel'));
    expect(rel.map((p) => p.id).sort()).toEqual(['ana', 'jose', 'uri']);
    const internal = addCandidates(d, conv('g', 'rel', { kind: 'internal', internalOrgId: 'xertify' }));
    expect(internal.map((p) => p.id).sort()).toEqual(['ana', 'jose']);
    expect(addCandidates(d, conv('m', null, { kind: 'multi' })).map((p) => p.id).sort()).toEqual(['ana', 'jose', 'mentor', 'uri']);
  });

  it('buscar acepta tildes, mayúsculas, cargo y empresa', () => {
    const all = addCandidates(d, conv('g', 'rel'));
    const org = (id: string | null) => d.organizations.find((o) => o.id === id)?.name;
    expect(filterPeople(all, 'jose', org).map((p) => p.id)).toEqual(['jose']);
    expect(filterPeople(all, 'URSULA', org).map((p) => p.id)).toEqual(['uri']);
    expect(filterPeople(all, 'ventas', org).map((p) => p.id)).toEqual(['jose']);
    expect(filterPeople(all, 'uniandes', org).map((p) => p.id)).toEqual(['uri']);
    expect(filterPeople(all, 'nadie@acme.co', org)).toEqual([]);
  });

  it('tipos de persona y el elegido por defecto', () => {
    const home = inviteOptions(d, conv('g', 'home'));
    expect(home.kinds.map((k) => k.key)).toEqual(['mine', 'guest']);
    expect(home.initial).toBe('mine');
    const rel = inviteOptions(d, conv('g', 'rel'));
    expect(rel.kinds.map((k) => k.key)).toEqual(['mine', 'org:uniandes', 'guest']);
    expect(rel.initial).toBe('org:uniandes');
    const pend = inviteOptions(d, conv('g', 'pend'));
    expect(pend.kinds.map((k) => [k.key, 'name' in k ? k.name : ''])).toEqual([['mine', 'Xertify'], ['pending', 'Bancolombia'], ['guest', '']]);
    expect(pend.initial).toBe('pending');
    // Dos empresas con el mismo nombre: un solo chip.
    const twin = { ...d, organizations: [...d.organizations, { id: 'uniandes2', name: 'UNIANDES' }],
      workspaces: [ws('rel2', { organizationIds: ['xertify', 'uniandes', 'uniandes2'] })] } as unknown as BootstrapDTO;
    expect(inviteOptions(twin, conv('g', 'rel2')).kinds.map((k) => k.key)).toEqual(['mine', 'org:uniandes', 'guest']);
    const internal = inviteOptions(d, conv('g', 'rel', { kind: 'internal', internalOrgId: 'xertify' }));
    expect(internal.kinds.map((k) => k.key)).toEqual(['mine']);
    // Un tercero no puede invitar; un chat sin espacio tampoco tiene esta sección.
    expect(inviteOptions(d, conv('g', 'guestws'))).toMatchObject({ canInvite: false, kinds: [] });
    expect(inviteOptions(d, conv('m', null, { kind: 'multi' })).canInvite).toBe(false);
  });

  it('cada tipo usa su endpoint', () => {
    const rel = inviteOptions(d, conv('g', 'rel'));
    const [mine, other, guest] = rel.kinds;
    expect(inviteCall(mine!, 'rel', 'g', 'now', 'es', { email: ' Carla@Acme.co ' })).toEqual({
      scope: 'organizations', id: 'xertify', body: { conversationIds: ['g'], workspaceId: 'rel', history: 'now', lang: 'es', email: 'carla@acme.co' },
    });
    expect(inviteCall(other!, 'rel', 'g', 'all', 'en', { link: true })).toEqual({
      scope: 'workspaces', id: 'rel', body: { role: 'member', conversationIds: ['g'], history: 'all', lang: 'en', multiUse: true, expiresInDays: 14 },
    });
    expect(inviteCall(guest!, 'rel', 'g', 'now', 'es', { link: true }).body).toMatchObject({ role: 'guest' });
  });

  it('el enlace se reutiliza en la sesión mientras esté vigente', () => {
    const now = Date.parse('2026-09-28T12:00:00Z');
    const key = linkKey('org:uniandes', 'g', 'now');
    expect(key).toBe(linkKey('pending', 'g', 'now')); // la misma invitación de espacio (member)
    expect(key).not.toBe(linkKey('guest', 'g', 'now'));
    expect(cachedLink(key, now)).toBeNull();
    rememberLink(key, { url: 'u', code: 'K7QM-4XPA', expiresAt: '2026-10-12T12:00:00Z' });
    expect(cachedLink(key, now)?.code).toBe('K7QM-4XPA');
    expect(cachedLink(key, Date.parse('2026-10-12T11:30:00Z'))).toBeNull(); // a punto de vencer: se crea otro
  });

  it('pendientes del grupo: de la empresa y del espacio, las nuevas primero', () => {
    const inv = (id: string, createdAt: string, conversationIds?: string[]) => ({ id, email: `${id}@x.co`, createdAt, conversationIds }) as any;
    const r = pendingForGroup('g', [
      { scope: 'workspaces', id: 'rel', items: [inv('a', '2026-09-27', ['g']), inv('b', '2026-09-28', ['otro']), inv('viejo', '2026-09-28')] },
      { scope: 'organizations', id: 'xertify', items: [inv('c', '2026-09-28', ['g'])] },
    ]);
    expect(r.map((x) => [x.id, x.scope])).toEqual([['c', 'organizations'], ['a', 'workspaces']]);
  });
});
