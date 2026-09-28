import type { BootstrapDTO, ConversationDTO, OrganizationDTO, PersonDTO, WorkspaceDTO } from '@tiecoms/contracts';
import { activityOf, compareConversations } from './home-order.ts';

/**
 * Búsqueda rápida de Grupos, DMs y «Mensaje nuevo»: personas, grupos y chats a la vez, para escribirle a alguien
 * o entrar a un grupo sin pasar por su empresa. Una persona sin directo también sale: al elegirla se abre (POST /chats).
 * Módulo puro (mismas reglas que iOS, QuickSearch.swift): los títulos llegan desde la interfaz (dependen del idioma).
 */
export interface Namer { title: (c: ConversationDTO) => string; subtitle?: (c: ConversationDTO) => string }
export interface QuickResults { people: PersonDTO[]; groups: ConversationDTO[]; chats: ConversationDTO[] }

/** Sin tildes ni mayúsculas: «Ánalía» coincide con «ana». */
export const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const byName = (a: PersonDTO, b: PersonDTO) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const orgOf = (d: BootstrapDTO, id: string | null | undefined): OrganizationDTO | null => d.organizations.find((o) => o.id === id) ?? null;
const personOf = (d: BootstrapDTO, id: string | null | undefined) => d.people.find((p) => p.id === id) ?? null;
const wsOf = (d: BootstrapDTO, c: ConversationDTO) => d.workspaces.find((w) => w.id === c.workspaceId) ?? null;

/** Hilo de un chat (derivada que no es sidechat): vive en la barra de su chat, no en las listas. */
export const isThread = (c: ConversationDTO) => !!c.parentId && c.deriveKind !== 'side';
const isChat = (c: ConversationDTO) => c.kind === 'direct' || c.kind === 'multi';
/** Grupo de un espacio (group o internal); los sidechats van en DMs. */
const isGroupRow = (c: ConversationDTO) => !!c.workspaceId && (c.kind === 'group' || c.kind === 'internal') && c.deriveKind !== 'side';
/** En espacios donde soy tercero no creo asuntos. */
export const isGuestIn = (d: BootstrapDTO, c: ConversationDTO) => !!c.workspaceId && wsOf(d, c)?.myRole === 'guest';

/** La empresa de la otra parte de un espacio (o la dueña si todo es mío). */
function counterpartOf(d: BootstrapDTO, ws: WorkspaceDTO) {
  const mine = new Set(d.organizations.filter((o) => o.myRole).map((o) => o.id));
  return orgOf(d, ws.organizationIds.find((id) => !mine.has(id)) ?? ws.owningOrgId);
}

/** Personas de mis directos, de la conversación más reciente a la más vieja (fila «Recientes»). */
export function recentPeopleIds(d: BootstrapDTO): string[] {
  const seen = new Set<string>();
  return d.conversations.filter((c) => c.kind === 'direct' && !isThread(c))
    .sort((a, b) => activityOf(b).localeCompare(activityOf(a)))
    .map((c) => c.memberIds.find((m) => m !== d.me.id))
    .filter((id): id is string => !!id && personOf(d, id)?.kind === 'human' && !seen.has(id) && !!seen.add(id));
}

/** El directo que ya tengo con esa persona (si existe). */
export const directWith = (d: BootstrapDTO, personId: string) =>
  d.conversations.find((c) => c.kind === 'direct' && c.memberIds.includes(personId) && !isThread(c)) ?? null;

/** Personas (humanas, sin mí) cuyo nombre, cargo, área o empresa coincide; primero quien empieza con lo escrito, luego con quien ya hablo. */
export function searchPeople(d: BootstrapDTO, query: string, exclude: Iterable<string> = []): PersonDTO[] {
  const q = fold(query.trim());
  if (!q) return [];
  const skip = new Set(exclude);
  const rank = new Map(recentPeopleIds(d).map((id, i) => [id, i]));
  return d.people
    .filter((p) => p.kind === 'human' && p.id !== d.me.id && !skip.has(p.id))
    .filter((p) => [p.name, p.title, p.area, orgOf(d, p.orgId)?.name].some((x) => !!x && fold(x).includes(q)))
    .sort((a, b) => {
      // Ana antes que Mariana: empieza con lo escrito.
      const pa = fold(a.name).startsWith(q), pb = fold(b.name).startsWith(q);
      if (pa !== pb) return pa ? -1 : 1;
      const ra = rank.get(a.id) ?? Infinity, rb = rank.get(b.id) ?? Infinity;
      if (ra !== rb) return ra - rb;
      return byName(a, b);
    });
}

/** Grupos (con espacio, sin hilos) por nombre, espacio o empresa de la otra parte. */
export function searchGroups(d: BootstrapDTO, query: string, names: Namer): ConversationDTO[] {
  const q = fold(query.trim());
  if (!q) return [];
  return d.conversations.filter((c) => isGroupRow(c) && !isThread(c))
    .filter((c) => {
      const ws = wsOf(d, c);
      const hay = [names.title(c), ws?.name, ws?.counterpartName, ws ? counterpartOf(d, ws)?.name : null];
      return hay.some((x) => !!x && fold(x).includes(q));
    })
    .sort(compareConversations);
}

/** Directos y chats grupales (con sidechats, sin hilos) por título, subtítulo o nombre de quien participa. */
export function searchChats(d: BootstrapDTO, query: string, names: Namer): ConversationDTO[] {
  const q = fold(query.trim());
  if (!q) return [];
  return d.conversations.filter((c) => isChat(c) && !isThread(c))
    .filter((c) => [names.title(c), names.subtitle?.(c), ...c.memberIds.map((m) => personOf(d, m)?.name)].some((x) => !!x && fold(x).includes(q)))
    .sort(compareConversations);
}

/** Todo junto: quien ya tiene su directo entre los chats encontrados sale una sola vez (en Chats). */
export function quickSearch(d: BootstrapDTO, query: string, names: Namer): QuickResults {
  const chats = searchChats(d, query, names);
  const inChats = chats.filter((c) => c.kind === 'direct').flatMap((c) => c.memberIds);
  return { people: searchPeople(d, query, inChats), groups: searchGroups(d, query, names), chats };
}
export const isEmptyResults = (r: QuickResults) => !r.people.length && !r.groups.length && !r.chats.length;

/** Personas agrupadas por empresa para «Mensaje nuevo»: mi equipo primero, luego por nombre, al final terceros. */
export function peopleByOrg(d: BootstrapDTO, query: string, exclude: Iterable<string> = []) {
  const q = fold(query.trim());
  const skip = new Set([d.me.id, ...exclude]);
  const people = d.people.filter((p) => p.kind === 'human' && !skip.has(p.id))
    .filter((p) => !q || [p.name, p.title, p.area, orgOf(d, p.orgId)?.name].some((x) => !!x && fold(x).includes(q)))
    .sort(byName);
  const groups = new Map<string, PersonDTO[]>();
  for (const p of people) {
    const k = p.orgId && orgOf(d, p.orgId) ? p.orgId : 'guests';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(p);
  }
  const mine = d.me.primaryOrgId;
  return [...groups.entries()].map(([orgId, list]) => ({ orgId, org: orgOf(d, orgId), isMine: orgId === mine, people: list }))
    .sort((a, b) => {
      if (a.isMine !== b.isMine) return a.isMine ? -1 : 1;
      if ((a.orgId === 'guests') !== (b.orgId === 'guests')) return a.orgId === 'guests' ? 1 : -1;
      return (a.org?.name ?? '').localeCompare(b.org?.name ?? '', undefined, { sensitivity: 'base' });
    });
}

/** Dónde puedo crear un asunto desde «＋ Crear»: grupos y chats donde escribo y no soy tercero, el más reciente primero. */
export const issueDestinations = (d: BootstrapDTO) =>
  d.conversations.filter((c) => c.canPost && !isThread(c) && !isGuestIn(d, c)).sort(compareConversations);

/** «Grupo · Empresa» (o el nombre del chat) para el selector «Grupo o chat». */
export function destinationLabel(d: BootstrapDTO, c: ConversationDTO, title: string) {
  const ws = wsOf(d, c);
  if (!ws) return title;
  return `${title} · ${counterpartOf(d, ws)?.name ?? ws.counterpartName ?? ws.name}`;
}
