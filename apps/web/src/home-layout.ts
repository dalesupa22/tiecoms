/**
 * Pantalla «Hoy» personalizable (docs/HOY.md). Módulo puro: sin React ni cliente, para probarlo con vitest
 * y para que iOS/Android o el API puedan leer el mismo formato más adelante.
 *
 * Guardado por usuario en este dispositivo (localStorage, siempre en try/catch):
 *   chaggu:home:v1:<userId>        → HomeLayout (JSON)
 *   chaggu:home-guide:v1:<userId>  → GuideState (JSON)
 *   chaggu:home-note:v1:<userId>   → texto de la nota rápida
 */

// ---------- Bloques ----------
export const BLOCK_IDS = [
  'stats', 'guide', 'waiting', 'agenda', 'reminders', 'tasks', 'recent',
  'mentions', 'pinned', 'calls', 'mail', 'whatsapp', 'favorites', 'note',
] as const;
export type BlockId = (typeof BLOCK_IDS)[number];
export type BlockSize = 'narrow' | 'wide';
export interface BlockPref { id: BlockId; visible: boolean; size: BlockSize }
export type TemplateId = 'default' | 'focus' | 'manager' | 'support';
export const TEMPLATE_IDS: readonly TemplateId[] = ['default', 'focus', 'manager', 'support'];

export interface HomeLayout {
  v: 1;
  /** La plantilla de la que salió; 'custom' en cuanto la persona mueve algo. */
  template: TemplateId | 'custom';
  /** Todos los bloques, en orden; los ocultos conservan su lugar para cuando se vuelvan a mostrar. */
  blocks: BlockPref[];
  /** Las 4 tarjetas de números en una sola fila pequeña. */
  compactStats: boolean;
  /** Chats de «Accesos rápidos» (ids de conversación), en orden. Vacío = fijados y los más activos. */
  favorites: string[];
}

const isBlockId = (x: unknown): x is BlockId => typeof x === 'string' && (BLOCK_IDS as readonly string[]).includes(x);
const isTemplate = (x: unknown): x is TemplateId => typeof x === 'string' && (TEMPLATE_IDS as readonly string[]).includes(x);

/** Tamaño natural de cada bloque cuando una plantilla no dice otro. */
const NATURAL: Record<BlockId, BlockSize> = {
  stats: 'wide', guide: 'wide', waiting: 'narrow', agenda: 'narrow', reminders: 'narrow', tasks: 'narrow', recent: 'narrow',
  mentions: 'narrow', pinned: 'narrow', calls: 'narrow', mail: 'narrow', whatsapp: 'narrow', favorites: 'wide', note: 'narrow',
};

type Spec = { show: [BlockId, BlockSize?][]; compactStats: boolean };
/** Lo visible de cada plantilla, en orden. El resto va detrás, oculto, en el orden de BLOCK_IDS. */
const TEMPLATES: Record<TemplateId, Spec> = {
  // La pantalla de siempre (números, te esperan, agenda, recordatorios, tareas, actividad) + la guía.
  default: { show: [['stats'], ['guide'], ['waiting'], ['agenda'], ['reminders'], ['tasks'], ['recent']], compactStats: false },
  focus: { show: [['waiting'], ['tasks']], compactStats: true },
  manager: { show: [['stats'], ['mentions'], ['agenda']], compactStats: false },
  support: { show: [['mail'], ['whatsapp'], ['waiting']], compactStats: true },
};

export function templateLayout(id: TemplateId): HomeLayout {
  const spec = TEMPLATES[id];
  const shown = spec.show.map(([b, size]) => ({ id: b, visible: true, size: size ?? NATURAL[b] }));
  const rest = BLOCK_IDS.filter((b) => !spec.show.some(([x]) => x === b)).map((b) => ({ id: b, visible: false, size: NATURAL[b] }));
  return { v: 1, template: id, blocks: [...shown, ...rest], compactStats: spec.compactStats, favorites: [] };
}
export const defaultLayout = () => templateLayout('default');

/** Aplica una plantilla sin perder los favoritos elegidos. */
export const applyTemplate = (l: HomeLayout, id: TemplateId): HomeLayout => ({ ...templateLayout(id), favorites: l.favorites });

/**
 * Lee lo guardado con tolerancia: ids desconocidos fuera, repetidos fuera, bloques nuevos (de una versión
 * posterior de la app) al final ocultos, tamaños inválidos al natural. Cualquier otra cosa → por defecto.
 */
export function normalizeLayout(raw: unknown): HomeLayout {
  if (!raw || typeof raw !== 'object') return defaultLayout();
  const r = raw as Partial<HomeLayout> & { blocks?: unknown };
  if (r.v !== 1 || !Array.isArray(r.blocks)) return defaultLayout();
  const seen = new Set<BlockId>();
  const blocks: BlockPref[] = [];
  for (const b of r.blocks as Partial<BlockPref>[]) {
    if (!b || !isBlockId(b.id) || seen.has(b.id)) continue;
    seen.add(b.id);
    blocks.push({ id: b.id, visible: b.visible !== false, size: b.size === 'wide' || b.size === 'narrow' ? b.size : NATURAL[b.id] });
  }
  for (const id of BLOCK_IDS) if (!seen.has(id)) blocks.push({ id, visible: false, size: NATURAL[id] });
  return {
    v: 1,
    template: isTemplate(r.template) ? r.template : 'custom',
    blocks,
    compactStats: r.compactStats === true,
    favorites: Array.isArray(r.favorites) ? [...new Set(r.favorites.filter((x): x is string => typeof x === 'string'))].slice(0, 12) : [],
  };
}

const custom = (l: HomeLayout, blocks: BlockPref[]): HomeLayout => ({ ...l, template: 'custom', blocks });

export function setVisible(l: HomeLayout, id: BlockId, visible: boolean): HomeLayout {
  return custom(l, l.blocks.map((b) => (b.id === id ? { ...b, visible } : b)));
}
export function setSize(l: HomeLayout, id: BlockId, size: BlockSize): HomeLayout {
  return custom(l, l.blocks.map((b) => (b.id === id ? { ...b, size } : b)));
}
export const setCompactStats = (l: HomeLayout, compactStats: boolean): HomeLayout => ({ ...l, template: 'custom', compactStats });
export const setFavorites = (l: HomeLayout, favorites: string[]): HomeLayout => ({ ...l, favorites: [...new Set(favorites)].slice(0, 12) });

/**
 * Mueve un bloque visible `delta` puestos entre los visibles (flechas del teclado, ↑/↓ del modo edición).
 * Los ocultos no cuentan: saltar sobre ellos sería un paso «que no hace nada».
 */
export function moveBy(l: HomeLayout, id: BlockId, delta: number): HomeLayout {
  const vis = l.blocks.filter((b) => b.visible).map((b) => b.id);
  const at = vis.indexOf(id);
  if (at < 0) return l;
  const to = Math.max(0, Math.min(vis.length - 1, at + delta));
  if (to === at) return l;
  return moveTo(l, id, vis[to]!, delta > 0 ? 'after' : 'before');
}

/** Arrastrar y soltar: deja `id` antes o después de `target`. */
export function moveTo(l: HomeLayout, id: BlockId, target: BlockId, where: 'before' | 'after'): HomeLayout {
  if (id === target) return l;
  const moving = l.blocks.find((b) => b.id === id);
  if (!moving) return l;
  const rest = l.blocks.filter((b) => b.id !== id);
  const at = rest.findIndex((b) => b.id === target);
  if (at < 0) return l;
  rest.splice(where === 'after' ? at + 1 : at, 0, moving);
  return custom(l, rest);
}

export const visibleBlocks = (l: HomeLayout) => l.blocks.filter((b) => b.visible);

/**
 * Filas de la cuadrícula: un bloque ancho ocupa su propia fila completa; los angostos seguidos se reparten en
 * `cols` columnas (cada uno a la más corta según su peso estimado, empate a la izquierda). Así no quedan huecos
 * cuando un bloque es largo (Te esperan) y otro corto (Agenda), y el orden de lectura se conserva.
 */
export type GridRow = { kind: 'wide'; id: BlockId } | { kind: 'cols'; cols: BlockId[][] };
export function gridRows(blocks: BlockPref[], cols: number, weight: (id: BlockId) => number = () => 1): GridRow[] {
  const n = Math.max(1, Math.floor(cols));
  const rows: GridRow[] = [];
  let run: BlockId[] = [];
  const flush = () => {
    if (!run.length) return;
    const out: BlockId[][] = Array.from({ length: Math.min(n, run.length) }, () => []);
    const h = out.map(() => 0);
    for (const id of run) {
      let k = 0;
      for (let i = 1; i < h.length; i++) if (h[i]! < h[k]!) k = i;
      out[k]!.push(id); h[k]! += Math.max(0.1, weight(id));
    }
    rows.push({ kind: 'cols', cols: out });
    run = [];
  };
  for (const b of blocks) {
    if (!b.visible) continue;
    if (b.size === 'wide' || n === 1) { flush(); rows.push({ kind: 'wide', id: b.id }); } else run.push(b.id);
  }
  flush();
  return rows;
}

// ---------- Guardado ----------
export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
const safeStorage = (): KV | null => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };
export const layoutKey = (userId: string) => `chaggu:home:v1:${userId}`;
export const guideKey = (userId: string) => `chaggu:home-guide:v1:${userId}`;
export const noteKey = (userId: string) => `chaggu:home-note:v1:${userId}`;

export function loadLayout(userId: string, store: KV | null = safeStorage()): HomeLayout {
  try { const s = store?.getItem(layoutKey(userId)); return s ? normalizeLayout(JSON.parse(s)) : defaultLayout(); } catch { return defaultLayout(); }
}
export function saveLayout(userId: string, l: HomeLayout, store: KV | null = safeStorage()) {
  try { store?.setItem(layoutKey(userId), JSON.stringify(l)); } catch { /* sin almacenamiento */ }
}
export function resetLayout(userId: string, store: KV | null = safeStorage()): HomeLayout {
  try { store?.removeItem(layoutKey(userId)); } catch { /* sin almacenamiento */ }
  return defaultLayout();
}

// ---------- Guía «Qué puedes hacer en chaggu» ----------
export const GUIDE_IDS = ['call', 'panes', 'whatsapp', 'mail', 'task', 'topics', 'gg', 'invite', 'dark', 'shortcuts'] as const;
export type GuideId = (typeof GUIDE_IDS)[number];
const isGuideId = (x: unknown): x is GuideId => typeof x === 'string' && (GUIDE_IDS as readonly string[]).includes(x);
export interface GuideState {
  v: 1;
  /** Tarjetas cuyo botón tocó la persona (cuenta como descubierta cuando los datos no lo dicen). */
  touched: GuideId[];
  /** Tarjetas que descartó con ×. */
  dismissed: GuideId[];
}
export const emptyGuide = (): GuideState => ({ v: 1, touched: [], dismissed: [] });
export function normalizeGuide(raw: unknown): GuideState {
  if (!raw || typeof raw !== 'object') return emptyGuide();
  const r = raw as Partial<GuideState>;
  const list = (x: unknown) => (Array.isArray(x) ? [...new Set(x.filter(isGuideId))] : []);
  return { v: 1, touched: list(r.touched), dismissed: list(r.dismissed) };
}
export function loadGuide(userId: string, store: KV | null = safeStorage()): GuideState {
  try { const s = store?.getItem(guideKey(userId)); return s ? normalizeGuide(JSON.parse(s)) : emptyGuide(); } catch { return emptyGuide(); }
}
export function saveGuide(userId: string, g: GuideState, store: KV | null = safeStorage()) {
  try { store?.setItem(guideKey(userId), JSON.stringify(g)); } catch { /* sin almacenamiento */ }
}
const add = (xs: GuideId[], id: GuideId) => (xs.includes(id) ? xs : [...xs, id]);
export const touchGuide = (g: GuideState, id: GuideId): GuideState => ({ ...g, touched: add(g.touched, id) });
export const dismissGuide = (g: GuideState, id: GuideId): GuideState => ({ ...g, dismissed: add(g.dismissed, id) });
export const restoreDismissed = (g: GuideState): GuideState => ({ ...g, dismissed: [] });

/** Lo que dicen los datos del cliente: true = ya lo usó, false = no, undefined = no se puede saber. */
export type GuideSignals = Partial<Record<GuideId, boolean | undefined>>;
export interface GuideView {
  /** Primero lo que aún no ha usado (orden de valor de GUIDE_IDS), luego lo ya descubierto. Sin descartadas. */
  items: { id: GuideId; used: boolean }[];
  discovered: number;
  total: number;
  dismissed: number;
}
export function guideView(g: GuideState, signals: GuideSignals): GuideView {
  const used = (id: GuideId) => signals[id] === true || g.touched.includes(id);
  const live = GUIDE_IDS.filter((id) => !g.dismissed.includes(id));
  const items = [...live.filter((id) => !used(id)), ...live.filter(used)].map((id) => ({ id, used: used(id) }));
  return { items, discovered: GUIDE_IDS.filter(used).length, total: GUIDE_IDS.length, dismissed: g.dismissed.length };
}
