/**
 * Lógica pura de los paneles en paralelo (docs/PANELES.md): qué se abre, dónde, qué se reemplaza y cómo se
 * acomodan. Sin DOM ni React para poder probarla con vitest (test/panes-core.test.ts); split.ts la guarda y la
 * conecta con el URL.
 *
 * Un panel es una clave de texto:
 *  - conversación de chaggu: su id tal cual (compatible con lo guardado antes del 30-sep-2026);
 *  - vista completa: `v:issues` · `v:agenda` · `v:mail` · `v:whatsapp` · `v:today` · `v:files`;
 *  - un elemento suelto: `wa:<cuenta>:<jid>` (chat de WhatsApp) · `mail:<id>` (correo traído a un chat) ·
 *    `inbox:<proveedor>:<id>` (correo de la bandeja en vivo) · `task:<id>` (asunto o tarea).
 */

export const MAX_PANES = 8;
/** Fecha local (AAAA-MM-DD), para saber si una tarea está vencida. */
export const localIsoDay = (x = new Date()) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
export const VIEWS = ['issues', 'agenda', 'mail', 'whatsapp', 'today', 'files'] as const;
export type ViewName = (typeof VIEWS)[number];
export type PaneKind = 'conv' | 'view' | 'wa' | 'mail' | 'inbox' | 'task';

export const viewKey = (v: ViewName) => `v:${v}`;
export const waKey = (accountId: string, jid: string) => `wa:${accountId}:${jid}`;
export const mailKey = (emailId: string) => `mail:${emailId}`;
export const inboxKey = (provider: string, id: string) => `inbox:${provider}:${id}`;
export const taskKey = (issueId: string) => `task:${issueId}`;

export function paneKind(key: string): PaneKind {
  if (key.startsWith('v:')) return 'view';
  if (key.startsWith('wa:')) return 'wa';
  if (key.startsWith('mail:')) return 'mail';
  if (key.startsWith('inbox:')) return 'inbox';
  if (key.startsWith('task:')) return 'task';
  return 'conv';
}
/** Partes de la clave después del prefijo: `wa:acc:123@g.us` → ['acc', '123@g.us'] (el jid puede traer «:»). */
export function keyParts(key: string): string[] {
  const k = paneKind(key);
  if (k === 'conv') return [key];
  const rest = key.slice(key.indexOf(':') + 1);
  if (k === 'wa' || k === 'inbox') { const i = rest.indexOf(':'); return i < 0 ? [rest] : [rest.slice(0, i), rest.slice(i + 1)]; }
  return [rest];
}
export const isView = (key: string): key is `v:${ViewName}` => key.startsWith('v:') && (VIEWS as readonly string[]).includes(key.slice(2));

// ---------- Estado ----------
export interface PanesState {
  /** En orden de pantalla (de izquierda a derecha y de arriba abajo). */
  panes: string[];
  /** Fijados: no se reemplazan al abrir otra cosa. */
  pinned: string[];
  /** Del más reciente al más viejo (el que se reemplaza primero es el último no fijado). */
  recent: string[];
  /** Un panel agrandado temporalmente (los demás siguen abiertos). */
  maximized: string | null;
}
export const EMPTY: PanesState = { panes: [], pinned: [], recent: [], maximized: null };

/** Limpia lo que venga de localStorage (o de una versión anterior que guardaba solo un arreglo de ids). */
export function normalize(raw: unknown): PanesState {
  const strs = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0))] : []);
  if (Array.isArray(raw)) { const panes = strs(raw).slice(0, MAX_PANES); return { ...EMPTY, panes, recent: panes }; }
  if (!raw || typeof raw !== 'object') return EMPTY;
  const o = raw as Record<string, unknown>;
  const panes = strs(o.panes).slice(0, MAX_PANES);
  const inPanes = (x: string) => panes.includes(x);
  const recent = [...strs(o.recent).filter(inPanes), ...panes.filter((x) => !strs(o.recent).includes(x))];
  const maximized = typeof o.maximized === 'string' && inPanes(o.maximized) ? o.maximized : null;
  return { panes, pinned: strs(o.pinned).filter(inPanes), recent, maximized };
}

const touch = (recent: string[], key: string) => [key, ...recent.filter((x) => x !== key)];
const clean = (s: PanesState): PanesState => {
  const has = (x: string) => s.panes.includes(x);
  return { panes: s.panes, pinned: s.pinned.filter(has), recent: s.recent.filter(has), maximized: s.maximized && has(s.maximized) ? s.maximized : null };
};

/**
 * El panel a reemplazar cuando ya no cabe otro: el no fijado usado hace más tiempo, evitando `keep` (el que se
 * está viendo). Si todos están fijados, el más viejo de todos (nunca se queda sin abrir lo que pediste).
 */
export function victim(s: PanesState, keep: (string | null)[] = []): string | null {
  const byAge = [...s.recent].reverse();
  const order = [...byAge, ...s.panes.filter((x) => !s.recent.includes(x))];
  const free = order.filter((x) => !s.pinned.includes(x));
  return free.find((x) => !keep.includes(x)) ?? free[0] ?? order.find((x) => !keep.includes(x)) ?? order[0] ?? null;
}

/**
 * El URL cambió a `active` (tocaste un chat en la lista, por ejemplo). Si ya está abierto, solo pasa a ser el
 * más reciente. Si no: reemplaza al panel que tenías enfocado, salvo que esté fijado; en ese caso se agrega al
 * lado o, sin espacio, reemplaza al no fijado menos reciente. Sin paneles no hace nada (vista normal).
 */
export function syncActive(s: PanesState, active: string, lastActive: string | null, max: number): PanesState {
  if (s.panes.length === 0) return s;
  if (s.panes.includes(active)) return s.recent[0] === active ? s : { ...s, recent: touch(s.recent, active) };
  const panes = [...s.panes];
  const at = lastActive ? panes.indexOf(lastActive) : -1;
  let out: string | null = null;
  if (at >= 0 && !s.pinned.includes(lastActive!)) { out = lastActive; panes[at] = active; }
  else if (panes.length < max) panes.push(active);
  else { out = victim(s, [lastActive]); panes[panes.indexOf(out!)] = active; }
  return clean({ ...s, panes, recent: touch(s.recent.filter((x) => x !== out), active), maximized: null });
}

export interface OpenResult { state: PanesState; replaced: string | null; already: boolean }
/**
 * Abrir `key` en paralelo con lo que se está viendo (`active`). Si lo que ves no estaba en los paneles (una
 * vista de página completa), entra primero. Con espacio se agrega (en `at` si se soltó en un lado de otro panel);
 * sin espacio reemplaza a `target` (donde se soltó) si no está fijado, o al no fijado menos reciente.
 */
export function openBeside(s: PanesState, key: string, active: string | null, max: number, opts: { target?: string | null; at?: number } = {}): OpenResult {
  if (s.panes.includes(key)) return { state: { ...s, recent: touch(s.recent, key) }, replaced: null, already: true };
  let base: PanesState = s;
  if (active && !s.panes.includes(active) && active !== key) {
    const panes = [...s.panes];
    let out: string | null = null;
    if (panes.length < max) panes.push(active);
    else { out = victim(s); panes[panes.indexOf(out!)] = active; }
    base = { ...s, panes, recent: touch(s.recent.filter((x) => x !== out), active) };
  }
  base = clean(base);
  const panes = [...base.panes];
  let replaced: string | null = null;
  if (opts.target && panes.includes(opts.target) && !base.pinned.includes(opts.target) && (panes.length >= max || opts.at === undefined)) {
    replaced = opts.target; panes[panes.indexOf(opts.target)] = key;
  } else if (panes.length < max) {
    const at = opts.at === undefined ? panes.length : Math.max(0, Math.min(panes.length, opts.at));
    panes.splice(at, 0, key);
  } else {
    replaced = victim(base, [active]); panes[panes.indexOf(replaced!)] = key;
  }
  const recent = touch(base.recent.filter((x) => x !== replaced), key);
  return { state: clean({ ...base, panes, recent, maximized: null }), replaced, already: false };
}

/** Cierra un panel. Devuelve a cuál pasar si era el activo (el vecino de la izquierda, o el siguiente). */
export function closePane(s: PanesState, key: string, active: string | null): { state: PanesState; focus: string | null } {
  const at = s.panes.indexOf(key);
  if (at < 0) return { state: s, focus: null };
  const panes = s.panes.filter((x) => x !== key);
  const state = panes.length > 1 ? clean({ ...s, panes }) : EMPTY;
  const focus = key === active ? panes[Math.min(Math.max(0, at - 1), panes.length - 1)] ?? null : null;
  return { state, focus };
}

export function togglePin(s: PanesState, key: string): PanesState {
  if (!s.panes.includes(key)) return s;
  return { ...s, pinned: s.pinned.includes(key) ? s.pinned.filter((x) => x !== key) : [...s.pinned, key] };
}
export function toggleMax(s: PanesState, key: string): PanesState {
  return { ...s, maximized: s.maximized === key || !s.panes.includes(key) ? null : key };
}
/** Intercambia dos paneles (soltar un encabezado sobre otro panel). */
export function swap(s: PanesState, a: string, b: string): PanesState {
  const i = s.panes.indexOf(a), j = s.panes.indexOf(b);
  if (i < 0 || j < 0 || i === j) return s;
  const panes = [...s.panes]; panes[i] = b; panes[j] = a;
  return { ...s, panes };
}
/** Mueve un panel a la posición `to` (soltar en el borde de otro panel). */
export function move(s: PanesState, key: string, to: number): PanesState {
  const i = s.panes.indexOf(key);
  if (i < 0) return s;
  const panes = s.panes.filter((x) => x !== key);
  const at = Math.max(0, Math.min(panes.length, to > i ? to - 1 : to));
  panes.splice(at, 0, key);
  return panes.every((x, k) => x === s.panes[k]) ? s : { ...s, panes };
}

/**
 * Los que se ven con el ancho de ahora: los primeros `max`, con el activo siempre adentro (si no cabía, toma el
 * lugar del último no fijado). Los demás siguen abiertos y vuelven al agrandar la ventana.
 */
export function visiblePanes(panes: string[], active: string | null, max: number, pinned: string[] = []): string[] {
  const out = panes.slice(0, Math.max(1, max));
  if (active && panes.includes(active) && !out.includes(active)) {
    let k = out.length - 1;
    while (k > 0 && pinned.includes(out[k]!)) k--;
    out[k] = active;
  }
  return out;
}

// ---------- Disposición según el tamaño del área ----------
export type LayoutMode = 'auto' | 'columns' | 'grid';
/** Mínimo legible de un panel en modo compacto, y el cómodo con el que se prefieren columnas. */
export const MIN_W = 310, MIN_H = 300, COMFY_W = 360, WIDE_COL_W = 480;
/** Candidatas por cantidad, en orden de preferencia: cada número es cuántos paneles van en esa fila. */
const CANDIDATES: Record<number, number[][]> = {
  1: [[1]],
  2: [[2]],
  3: [[3], [2, 1]],
  4: [[4], [2, 2]],
  5: [[5], [3, 2]],
  6: [[3, 3], [6], [2, 2, 2]],
  7: [[4, 3], [3, 2, 2], [7]],
  8: [[4, 4], [3, 3, 2], [8]],
};
function fits(rows: number[], w: number, h: number, n: number, mode: LayoutMode, comfy: boolean) {
  const cols = Math.max(...rows);
  const oneRow = rows.length === 1;
  if (mode === 'grid' && oneRow && n >= 3) return false;
  const minW = comfy ? (oneRow && n >= 4 && mode !== 'columns' ? WIDE_COL_W : COMFY_W) : MIN_W;
  return w / cols >= minW && h / rows.length >= MIN_H;
}
/** Filas de la disposición para `n` paneles en un área de `w`×`h`, o null si no caben legibles. */
export function layoutRows(n: number, w: number, h: number, mode: LayoutMode = 'auto'): number[] | null {
  if (n <= 1) return [1];
  const list = CANDIDATES[Math.min(n, MAX_PANES)]!;
  const ordered = mode === 'columns' ? [...list].sort((a, b) => a.length - b.length) : list;
  for (const comfy of [true, false]) {
    const hit = ordered.find((r) => fits(r, w, h, n, mode, comfy));
    if (hit) return hit;
  }
  return null;
}
/** Cuántos paneles caben legibles en el área (al menos 2 desde el ancho mínimo del modo en paralelo). */
export function maxPanesFor(w: number, h: number): number {
  for (let n = MAX_PANES; n > 2; n--) if (layoutRows(n, w, h)) return n;
  return 2;
}
/** Disposición final: si no hay una legible (ventana chica), la que menos filas use. */
export function layoutFor(n: number, w: number, h: number, mode: LayoutMode = 'auto'): number[] {
  return layoutRows(n, w, h, mode) ?? layoutRows(n, w, h, 'auto') ?? (n <= 2 ? [n] : [Math.ceil(n / 2), Math.floor(n / 2)]);
}
/** Nombre corto de la disposición para guardar tamaños («3-3», «2-1»). */
export const layoutSig = (rows: number[]) => rows.join('-');

/** Reparte fracciones al arrastrar la división entre `i` e `i+1`: la suma de los dos se mantiene. */
export function resizeFractions(fr: number[], i: number, delta: number, min = 0.12): number[] {
  const out = [...fr];
  const a = out[i]!, b = out[i + 1]!;
  const sum = a + b;
  const na = Math.min(sum - min, Math.max(min, a + delta));
  out[i] = na; out[i + 1] = sum - na;
  return out;
}
export const equalFractions = (n: number) => Array.from({ length: n }, () => 1 / n);

// ---------- Espacios de trabajo guardados ----------
export interface SavedSpace { name: string; panes: string[]; pinned: string[]; savedAt: string }
export function saveSpace(list: SavedSpace[], name: string, s: PanesState, now = new Date().toISOString()): SavedSpace[] {
  const n = name.trim().slice(0, 60);
  if (!n || s.panes.length < 2) return list;
  const item: SavedSpace = { name: n, panes: [...s.panes], pinned: [...s.pinned], savedAt: now };
  return [item, ...list.filter((x) => x.name.toLocaleLowerCase() !== n.toLocaleLowerCase())].slice(0, 12);
}
export function restoreSpace(sp: SavedSpace): PanesState {
  return normalize({ panes: sp.panes, pinned: sp.pinned, recent: sp.panes });
}
