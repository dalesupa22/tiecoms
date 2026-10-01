/**
 * Claves de los paneles de la cuadrícula (split.ts). Un chat de chaggu conserva su id a secas (así lo guardado
 * antes sigue valiendo); un correo y una conversación de WhatsApp llevan prefijo:
 *   mail:<google|microsoft>:<id del correo>      wa:<cuenta>:<jid>
 * Puro y sin navegador, para poder probarlo.
 */
export const MAX_PANES_DEFAULT = 4;
export type MailProviderKey = 'google' | 'microsoft';
/** Las secciones enteras que también caben en un cuadrito: la lista de tareas, la bandeja de correo y todas las conversaciones de WhatsApp. */
export type Section = 'tasks' | 'inbox' | 'wachats';
export const SECTIONS: Section[] = ['tasks', 'inbox', 'wachats'];
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

/** Los 4 cuaditos en orden: hueco i → la clave que lo ocupa, o null si está libre. */
export function slots(panes: string[], max: number): (string | null)[] {
  return Array.from({ length: max }, (_, i) => panes[i] ?? null);
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
 * Coloca `key` en el hueco `index` de la cuadrícula. Si ya estaba, se queda donde estaba. Un hueco libre (o más allá del
 * último) agrega al final; uno ocupado reemplaza, salvo que esté fijado. Devuelve los paneles nuevos y el lugar, o null si
 * el hueco es de un panel fijado.
 */
export function placeInto(panes: string[], key: string, index: number, pinned: ReadonlySet<string>, max: number): { panes: string[]; at: number; replaced: string | null } | null {
  const ex = panes.indexOf(key);
  if (ex >= 0) return { panes, at: ex, replaced: null };
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
