/**
 * Claves de los paneles de la cuadrícula (split.ts). Un chat de chaggu conserva su id a secas (así lo guardado
 * antes sigue valiendo); un correo y una conversación de WhatsApp llevan prefijo:
 *   mail:<google|microsoft>:<id del correo>      wa:<cuenta>:<jid>
 * Puro y sin navegador, para poder probarlo.
 */
export const MAX_PANES_DEFAULT = 4;
export type MailProviderKey = 'google' | 'microsoft';
/** Las secciones enteras que también caben en un cuadrito: la lista de tareas, la bandeja de correo y todas las conversaciones de WhatsApp. */
export type Section = 'tasks' | 'inbox' | 'wachats' | 'agenda' | 'trazo' | 'calls';
export const SECTIONS: Section[] = ['tasks', 'inbox', 'wachats', 'agenda', 'trazo', 'calls'];
export type PaneRef =
  | { kind: 'chat'; id: string }
  | { kind: 'mail'; provider: MailProviderKey; id: string }
  | { kind: 'wa'; accountId: string; jid: string }
  | { kind: Section };

export const mailKey = (provider: MailProviderKey, id: string) => `mail:${provider}:${id}`;
export const waKey = (accountId: string, jid: string) => `wa:${accountId}:${jid}`;
export const sectionKey = (section: Section) => `${section}:`;

export function parseKey(key: string): PaneRef {
  const section = SECTIONS.find((s) => key === `${s}:`);
  if (section) return { kind: section };
  if (key.startsWith('mail:')) {
    const rest = key.slice(5), at = rest.indexOf(':');
    const provider = rest.slice(0, at);
    if (at > 0 && (provider === 'google' || provider === 'microsoft') && rest.length > at + 1) return { kind: 'mail', provider, id: rest.slice(at + 1) };
  }
  if (key.startsWith('wa:')) {
    const rest = key.slice(3), at = rest.indexOf(':');
    if (at > 0 && rest.length > at + 1) return { kind: 'wa', accountId: rest.slice(0, at), jid: rest.slice(at + 1) };
  }
  return { kind: 'chat', id: key };
}
export const isChatKey = (key: string) => parseKey(key).kind === 'chat';

/**
 * Tareas vive en su propia columna, a la derecha y de arriba a abajo (la tercera columna): no gasta uno de los 4 cuaditos.
 * Si está abierta, su clave va siempre al final de la lista guardada.
 */
export const TASKS_KEY = sectionKey('tasks');
/** En el mapa de cuaditos, la columna de Tareas es el número 5 (los 4 cuaditos son 0–3). */
export const TASKS_SLOT = 4;
export function splitMain(panes: string[]): { main: string[]; tasks: boolean } {
  const main = panes.filter((k) => k !== TASKS_KEY);
  return { main, tasks: main.length !== panes.length };
}
/** Los 4 cuaditos en orden: hueco i → la clave que lo ocupa, o null si está libre (Tareas no cuenta: tiene su columna). */
export function slots(panes: string[], max: number): (string | null)[] {
  const { main } = splitMain(panes);
  return Array.from({ length: max }, (_, i) => main[i] ?? null);
}

/**
 * Qué panel cede su lugar cuando la cuadrícula está llena: el pedido (`prefer`) si no está fijado; si no, el último sin fijar
 * (el primero de atrás hacia adelante). -1 si todos están fijados.
 */
export function replaceIndex(panes: string[], pinned: ReadonlySet<string>, prefer?: string | null): number {
  if (prefer) { const at = panes.indexOf(prefer); if (at >= 0 && !pinned.has(prefer)) return at; if (at >= 0) return -1; }
  for (let i = panes.length - 1; i >= 0; i--) if (!pinned.has(panes[i]!)) return i;
  return -1;
}

/**
 * Coloca `key` en el hueco `index` de la cuadrícula. Si ya estaba, intercambia su lugar con el destino. Un hueco libre (o más allá del
 * último) agrega al final; uno ocupado reemplaza, salvo que esté fijado. Devuelve los paneles nuevos y el lugar, o null si
 * el hueco es de un panel fijado.
 */
export function placeInto(panes: string[], key: string, index: number, pinned: ReadonlySet<string>, max: number): { panes: string[]; at: number; replaced: string | null } | null {
  if (!Number.isInteger(index) || index < 0 || index >= max) return null;
  const ex = panes.indexOf(key);
  if (ex >= 0) {
    if (index >= panes.length) return { panes: [...panes.filter((p) => p !== key), key], at: panes.length - 1, replaced: null };
    const at = index;
    if (at === ex) return { panes, at, replaced: null };
    if (pinned.has(panes[at]!)) return null;
    const next = [...panes];
    [next[ex], next[at]] = [next[at]!, key];
    return { panes: next, at, replaced: null };
  }
  const next = [...panes];
  if (index < next.length) {
    if (pinned.has(next[index]!)) return null;
    const replaced = next[index]!;
    next[index] = key;
    return { panes: next, at: index, replaced };
  }
  if (next.length >= max) return null;
  next.push(key);
  return { panes: next, at: next.length - 1, replaced: null };
}

/**
 * Como placeInto pero con la columna de Tareas aparte: Tareas se agrega (o se queda) en su columna sin gastar un cuadrito; lo demás
 * va a los 4 cuaditos y Tareas, si estaba, sigue al final.
 */
export function placeIntoGrid(panes: string[], key: string, index: number, pinned: ReadonlySet<string>, max: number): { panes: string[]; at: number; replaced: string | null } | null {
  const { main, tasks } = splitMain(panes);
  if (key === TASKS_KEY) return tasks ? { panes, at: panes.length - 1, replaced: null } : { panes: [...main, TASKS_KEY], at: main.length, replaced: null };
  const r = placeInto(main, key, index, pinned, max);
  if (!r) return null;
  return { panes: tasks ? [...r.panes, TASKS_KEY] : r.panes, at: r.at, replaced: r.replaced };
}
