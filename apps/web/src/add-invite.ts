/**
 * Reglas puras del diálogo «Agregar al grupo» con invitar (docs/GRUPOS.md › «Invitar desde
 * «Agregar al grupo» (28-sep-2026)»). Sin React ni cliente, para probarlas y replicarlas en iOS y Android.
 */
import type { BootstrapDTO, ConversationDTO, PendingInvitationDTO, PersonDTO, WorkspaceDTO } from '@tiecoms/contracts';

/** Minúsculas y sin tildes, para buscar «jose» y encontrar «José». */
export const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(s.trim());

/**
 * Quién se puede sumar directo: en un chat grupal, cualquiera con quien comparto algo; en un grupo, las
 * personas del espacio y los colegas de mi empresa (el API los suma al espacio); en un interno, solo los
 * de esa empresa. Nunca quien ya está.
 */
export function addCandidates(d: BootstrapDTO, conv: ConversationDTO): PersonDTO[] {
  const inConv = new Set(conv.memberIds);
  const others = d.people.filter((p) => p.id !== d.me.id && !inConv.has(p.id) && p.kind === 'human');
  if (conv.kind === 'multi') return others;
  const ws = d.workspaces.find((w) => w.id === conv.workspaceId);
  if (!ws) return [];
  const inWs = new Set(ws.memberIds);
  const myOrg = myOrgIn(d, ws);
  let list = others.filter((p) => inWs.has(p.id) || (!!myOrg && p.orgId === myOrg && !p.guest));
  if (conv.kind === 'internal') list = list.filter((p) => p.orgId === conv.internalOrgId);
  return list;
}

/** Filtra por nombre, cargo, área o empresa, sin importar tildes ni mayúsculas. */
export function filterPeople(people: PersonDTO[], query: string, orgName: (id: string | null) => string | undefined): PersonDTO[] {
  const q = fold(query);
  if (!q) return people;
  return people.filter((p) => fold([p.name, p.title, p.area, orgName(p.orgId)].filter(Boolean).join(' ')).includes(q));
}

/** Mi empresa dentro de un espacio: la mía entre las del espacio (la principal si hay dos). Tercero: ninguna. */
export function myOrgIn(d: BootstrapDTO, ws: WorkspaceDTO): string | null {
  if (ws.myRole === 'guest') return null;
  const mine = new Set(d.organizations.filter((o) => o.myRole).map((o) => o.id));
  const here = [...ws.organizationIds, ws.owningOrgId].filter((id) => mine.has(id));
  return here.find((id) => id === d.me.primaryOrgId) ?? here[0] ?? null;
}

/** Tipo de persona a invitar. 'mine' = colega de mi empresa (invitación a la empresa con el grupo). */
export type InviteKind =
  | { key: 'mine'; orgId: string; name: string }
  | { key: string; kind: 'other'; orgId: string | null; name: string }
  | { key: 'guest' };

export interface InviteOptions {
  kinds: InviteKind[];
  /** Elegido al abrir: casa → mi empresa; relación → la contraparte; si no, tercero. */
  initial: string | null;
  /** false = soy tercero (o no hay espacio): no salen los botones, sale «Solo los miembros pueden invitar». */
  canInvite: boolean;
  workspaceId: string | null;
}

export function inviteOptions(d: BootstrapDTO, conv: ConversationDTO): InviteOptions {
  const ws = d.workspaces.find((w) => w.id === conv.workspaceId);
  if (!ws || (conv.kind !== 'group' && conv.kind !== 'internal')) return { kinds: [], initial: null, canInvite: false, workspaceId: null };
  if (ws.myRole === 'guest') return { kinds: [], initial: null, canInvite: false, workspaceId: ws.id };
  const kinds: InviteKind[] = [];
  const myOrg = myOrgIn(d, ws);
  const orgName = (id: string) => d.organizations.find((o) => o.id === id)?.name ?? '';
  if (myOrg) kinds.push({ key: 'mine', orgId: myOrg, name: orgName(myOrg) });
  // Un grupo interno es solo de mi empresa; en «Tu organización» la gente de fuera entra como tercero.
  if (conv.kind === 'group' && !ws.isOrgHome) {
    const mine = new Set(d.organizations.filter((o) => o.myRole).map((o) => o.id));
    const others = ws.organizationIds.filter((id) => !mine.has(id));
    // Un chip por empresa; dos empresas con el mismo nombre (p. ej. sin dominio verificado) se muestran una vez.
    const seen = new Set<string>();
    for (const id of others) {
      const name = orgName(id);
      if (seen.has(fold(name))) continue;
      seen.add(fold(name));
      kinds.push({ key: `org:${id}`, kind: 'other', orgId: id, name });
    }
    if (!others.length && ws.counterpartName) kinds.push({ key: 'pending', kind: 'other', orgId: null, name: ws.counterpartName });
  }
  if (conv.kind === 'group') kinds.push({ key: 'guest' });
  const other = kinds.find((k) => k.key !== 'mine' && k.key !== 'guest');
  const initial = ws.isOrgHome || conv.kind === 'internal' ? (myOrg ? 'mine' : 'guest') : other ? other.key : 'guest';
  return { kinds, initial: kinds.some((k) => k.key === initial) ? initial : kinds[0]?.key ?? null, canInvite: kinds.length > 0, workspaceId: ws.id };
}

/** Qué endpoint usa cada tipo. */
export type InviteCall =
  | { scope: 'organizations'; id: string; body: { conversationIds: string[]; workspaceId: string; history: 'now' | 'all'; lang: 'es' | 'en'; email?: string; multiUse?: boolean; expiresInDays?: number } }
  | { scope: 'workspaces'; id: string; body: { role: 'member' | 'guest'; conversationIds: string[]; history: 'now' | 'all'; lang: 'es' | 'en'; email?: string; multiUse?: boolean; expiresInDays?: number } };

export function inviteCall(kind: InviteKind, workspaceId: string, conversationId: string, history: 'now' | 'all', lang: 'es' | 'en', how: { email: string } | { link: true }): InviteCall {
  const extra = 'email' in how ? { email: how.email.trim().toLowerCase() } : { multiUse: true, expiresInDays: 14 };
  if (kind.key === 'mine') {
    return { scope: 'organizations', id: (kind as { orgId: string }).orgId, body: { conversationIds: [conversationId], workspaceId, history, lang, ...extra } };
  }
  return { scope: 'workspaces', id: workspaceId, body: { role: kind.key === 'guest' ? 'guest' : 'member', conversationIds: [conversationId], history, lang, ...extra } };
}

export interface CachedLink { url: string; code: string | null; expiresAt: string }
/** Enlaces creados en esta sesión, por tipo y grupo: «Copiar enlace» reutiliza el vigente. */
const links = new Map<string, CachedLink>();
export const linkKey = (kindKey: string, conversationId: string, history: 'now' | 'all') =>
  `${kindKey === 'mine' ? 'mine' : kindKey === 'guest' ? 'guest' : 'member'}:${conversationId}:${history}`;
export function cachedLink(key: string, now = Date.now()): CachedLink | null {
  const l = links.get(key);
  // Con una hora de margen, para no compartir uno que vence enseguida.
  if (!l || Date.parse(l.expiresAt) - now < 3600_000) { links.delete(key); return null; }
  return l;
}
export const rememberLink = (key: string, l: CachedLink) => { links.set(key, l); };

/** Pendientes de este grupo (de la empresa y del espacio), las más nuevas primero. */
export function pendingForGroup(conversationId: string, lists: { scope: 'organizations' | 'workspaces'; id: string; items: PendingInvitationDTO[] }[]) {
  return lists.flatMap((l) => l.items.filter((i) => i.conversationIds?.includes(conversationId)).map((inv) => ({ ...inv, scope: l.scope, scopeId: l.id })))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
