/**
 * Paneles en paralelo (docs/PANELES.md): hasta 8 cosas abiertas a la vez en la web y en la app de escritorio —
 * chats, vistas (Tareas, Agenda, Correo, WhatsApp, Hoy, Archivos) y elementos sueltos (un chat de WhatsApp, un
 * correo, una tarea). La lógica pura vive en panes-core.ts; aquí se guarda (localStorage, por dispositivo) y se
 * conecta con el URL:
 * - el panel activo es el del URL (/c/:id, /asuntos, /p/<clave>…); enfocar otro cambia el URL sin recargar;
 * - tocar un chat de la lista reemplaza al panel enfocado (como las pestañas de un editor), salvo que esté fijado;
 * - en pantallas angostas (celular) solo se ve el activo.
 */
import { createContext, useContext, useSyncExternalStore } from 'react';
import { navigate, parse, BASE, type Route } from './router.ts';
import * as core from './panes-core.ts';
import { toast } from './menu.tsx';
import { t } from './i18n.ts';

export { MAX_PANES } from './panes-core.ts';
/** Desde qué ancho de ventana hay paneles (la app de Mac abre en ~1000 px). */
export const SPLIT_MEDIA = '(min-width: 860px)';
export const splitAvailable = () => typeof matchMedia !== 'undefined' && matchMedia(SPLIT_MEDIA).matches;
/** Arrastre de una conversación de la lista (dataTransfer: su id). */
export const DRAG_TYPE = 'application/x-chaggu-conversation';
/** Arrastre de cualquier cosa que se abre como panel (dataTransfer: la clave; y su título en PANE_META_TYPE). */
export const DRAG_PANE = 'application/x-chaggu-pane';
const DRAG_META = 'application/x-chaggu-pane-meta';
/** Arrastre del encabezado de un panel ya abierto (para moverlo o intercambiarlo). */
export const DRAG_MOVE = 'application/x-chaggu-pane-move';

const KEY = 'chaggu:split';
const read = <T,>(k: string, fallback: T): T => { try { const v = localStorage.getItem(k); return v == null ? fallback : (JSON.parse(v) as T); } catch { return fallback; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } };

function store<T>(initial: T, persist?: (v: T) => void) {
  let value = initial;
  const ls = new Set<() => void>();
  return {
    get: () => value,
    set: (v: T) => { if (v === value) return; value = v; persist?.(v); ls.forEach((l) => l()); },
    subscribe: (l: () => void) => { ls.add(l); return () => { ls.delete(l); }; },
  };
}

// ---------- Estado de los paneles ----------
const panesStore = store<core.PanesState>(core.normalize(read(KEY, null)), (v) => write(KEY, v));
export const usePaneState = () => useSyncExternalStore(panesStore.subscribe, panesStore.get);
export const usePanes = () => useSyncExternalStore(panesStore.subscribe, () => panesStore.get().panes);
export const currentPanes = () => panesStore.get().panes;
export const isOpenInPanes = (key: string) => panesStore.get().panes.includes(key);
const setState = (s: core.PanesState) => panesStore.set(s);

/** Cuántos caben en el área de ahora (lo actualiza Split.tsx al medir). Antes de medir, una estimación. */
let currentMax = typeof window === 'undefined' ? core.MAX_PANES : core.maxPanesFor(Math.max(0, window.innerWidth - 340), window.innerHeight - 20);
export const setCurrentMax = (n: number) => { currentMax = n; };
export const paneLimit = () => currentMax;

// ---------- Títulos para avisos y encabezados de lo que no es un chat ----------
export interface PaneMeta { title: string; sub?: string; snap?: unknown }
const META_KEY = 'chaggu:split-meta';
const metaStore = store<Record<string, PaneMeta>>(read(META_KEY, {}), (v) => write(META_KEY, v));
export const usePaneMeta = (key: string) => useSyncExternalStore(metaStore.subscribe, () => metaStore.get()[key]);
export const paneMetaNow = (key: string) => metaStore.get()[key];
export function setPaneMeta(key: string, m: PaneMeta) {
  const cur = metaStore.get();
  if (JSON.stringify(cur[key]) === JSON.stringify(m)) return;
  // Solo se guarda lo de los paneles abiertos o recientes (máximo 40).
  const keep = Object.entries({ ...cur, [key]: m }).filter(([k]) => k === key || isOpenInPanes(k) || core.paneKind(k) !== 'conv').slice(-40);
  metaStore.set(Object.fromEntries(keep));
}
let describe: (key: string) => string = (k) => metaStore.get()[k]?.title ?? k;
/** Split.tsx registra cómo nombrar un panel (necesita los datos del cliente). */
export const setPaneDescriber = (f: (key: string) => string) => { describe = f; };

// ---------- URL ↔ panel ----------
const VIEW_PATH: Record<core.ViewName, string> = { issues: '/asuntos', agenda: '/agenda', mail: '/correo', whatsapp: '/whatsapp', today: '/', files: '/archivos' };
const ROUTE_VIEW: Partial<Record<Route['name'], core.ViewName>> = { issues: 'issues', agenda: 'agenda', mail: 'mail', whatsapp: 'whatsapp', today: 'today', files: 'files' };
export function keyToPath(key: string) {
  const k = core.paneKind(key);
  if (k === 'conv') return `/c/${key}`;
  if (k === 'view' && core.isView(key)) return VIEW_PATH[key.slice(2) as core.ViewName];
  return `/p/${encodeURIComponent(key)}`;
}
export function routeToKey(route: Route): string | null {
  if (route.name === 'conversation') return route.id;
  if (route.name === 'pane') return route.key;
  const v = ROUTE_VIEW[route.name];
  return v ? core.viewKey(v) : null;
}
/** La clave de lo que se ve ahora (null si la página no puede ser un panel, p. ej. Ajustes). */
export const currentKey = () => routeToKey(parse(location.pathname.slice(BASE.length) || '/'));

// ---------- Acciones ----------
let lastActive: string | null = null;
export function syncActive(active: string) {
  const s = panesStore.get();
  const next = core.syncActive(s, active, lastActive, currentMax);
  if (next !== s && next.panes !== s.panes) remember(active);
  setState(next);
  lastActive = active;
}

/**
 * Abrir `key` al lado de lo que se ve (o de `active`). Con 8 (o lo que quepa en esta ventana) reemplaza al no
 * fijado menos reciente y lo avisa. Devuelve false si ya estaba abierto (entonces solo lo enfoca).
 */
export function openBeside(key: string, active: string | null = currentKey(), opts: { target?: string | null; at?: number; meta?: PaneMeta } = {}) {
  if (opts.meta) setPaneMeta(key, opts.meta);
  if (!splitAvailable()) { navigate(keyToPath(key)); return true; }
  const r = core.openBeside(panesStore.get(), key, active, currentMax, opts);
  setState(r.state);
  remember(key);
  // Nunca dos veces lo mismo: si ya estaba abierto, se enfoca con un destello.
  if (r.already) { focusPane(key); flashPane(key); return false; }
  if (r.replaced) toast(t('split.replaced', { name: describe(r.replaced) }));
  // El nuevo queda enfocado: se ve de inmediato, el URL lo recuerda y se puede escribir de una.
  requestPaneFocus(key);
  focusPane(key);
  return true;
}

/** Cierra un panel; si era el activo, el activo pasa al vecino. Con uno solo, vuelve a la vista normal. */
export function closePane(key: string, active: string | null = currentKey()) {
  const before = panesStore.get();
  const r = core.closePane(before, key, active);
  setState(r.state);
  remember(key);
  // «Panel cerrado · Deshacer» por unos segundos: vuelve igual, en su lugar y con su fijado.
  toast(t('split.closed', { name: describe(key) }), { label: t('split.undo'), run: () => { setState(before); focusPane(key); } }, 5000);
  if (r.focus) { lastActive = r.focus; navigate(keyToPath(r.focus), true); }
}
/** Deja solo este panel. */
export function onlyPane(key: string) { setState(core.EMPTY); navigate(keyToPath(key), true); }
/** Enfocar un panel sin recargar: el URL pasa a ser el suyo. */
export function focusPane(key: string) { lastActive = key; navigate(keyToPath(key), true); }
/**
 * Pasar el cursor al compositor del panel (con ⌘1…⌘8 o al abrir uno nuevo). Con un clic no: el clic ya deja el
 * foco donde lo pusiste. Así lo que escribes siempre sale por el panel que ves enfocado.
 */
let focusIntent: string | null = null;
export const requestPaneFocus = (key: string) => { focusIntent = key; };
export const takePaneFocus = (key: string) => { if (focusIntent !== key) return false; focusIntent = null; return true; };
export const togglePin = (key: string) => setState(core.togglePin(panesStore.get(), key));
export const toggleMax = (key: string) => setState(core.toggleMax(panesStore.get(), key));
export const swapPanes = (a: string, b: string) => setState(core.swap(panesStore.get(), a, b));
export const movePane = (key: string, to: number) => setState(core.move(panesStore.get(), key, to));
export const closeAllPanes = (keep: string) => onlyPane(keep);

/** Dentro de un panel: las vistas lo usan para abrir lo que tocas como otro panel en vez de un diálogo. */
export const PaneCtx = createContext<{ key: string; active: boolean } | null>(null);
export const usePaneCtx = () => useContext(PaneCtx);

// ---------- Destello al enfocar algo que ya estaba abierto ----------
const flashStore = store<string | null>(null);
export const useFlash = () => useSyncExternalStore(flashStore.subscribe, flashStore.get);
let flashTimer: ReturnType<typeof setTimeout> | null = null;
export function flashPane(key: string) {
  flashStore.set(null);
  requestAnimationFrame(() => flashStore.set(key));
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => flashStore.set(null), 900);
}

// ---------- Recientes: lo último abierto en paneles (para volver a abrir un correo, un WhatsApp o un chat) ----------
const RECENT_KEY = 'chaggu:split-recent';
const recentStore = store<string[]>((() => { const v = read<unknown>(RECENT_KEY, []); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 12) : []; })(), (v) => write(RECENT_KEY, v));
export const useRecentPanes = () => useSyncExternalStore(recentStore.subscribe, recentStore.get);
function remember(key: string) { recentStore.set([key, ...recentStore.get().filter((x) => x !== key)].slice(0, 12)); }

// ---------- Arrastrar ----------
export function setPaneDrag(dt: DataTransfer, key: string, meta?: PaneMeta) {
  dt.setData(DRAG_PANE, key);
  if (meta) dt.setData(DRAG_META, JSON.stringify(meta));
  if (core.paneKind(key) === 'conv') dt.setData(DRAG_TYPE, key);
  try { dt.setData('text/uri-list', `${location.origin}${BASE}${keyToPath(key)}`); } catch { /* */ }
  dt.effectAllowed = 'copyMove';
}
export const isPaneDrag = (dt: DataTransfer) => { const ty = Array.from(dt.types); return ty.includes(DRAG_PANE) || ty.includes(DRAG_TYPE) || ty.includes(DRAG_MOVE); };
export const isMoveDrag = (dt: DataTransfer) => Array.from(dt.types).includes(DRAG_MOVE);
/** Lo que se soltó: la clave y su título (si lo trae). */
export function readPaneDrop(dt: DataTransfer): { key: string; move: boolean; meta?: PaneMeta } | null {
  const mv = dt.getData(DRAG_MOVE);
  if (mv) return { key: mv, move: true };
  const key = dt.getData(DRAG_PANE) || dt.getData(DRAG_TYPE);
  if (!key) return null;
  let meta: PaneMeta | undefined;
  try { const m = dt.getData(DRAG_META); if (m) meta = JSON.parse(m); } catch { /* */ }
  return { key, move: false, meta };
}
/** Props para que una fila (WhatsApp, correo, tarea…) se pueda arrastrar al área de paneles. */
export const paneDragProps = (key: string, meta?: PaneMeta) => ({
  draggable: true,
  onDragStart: (e: React.DragEvent) => { e.stopPropagation(); setPaneDrag(e.dataTransfer, key, meta); },
});
/** ¿Abrir en panel con este clic? (⌘/Ctrl + clic, como abrir en otra pestaña). */
export const wantsPane = (e: { metaKey: boolean; ctrlKey: boolean }) => (e.metaKey || e.ctrlKey) && splitAvailable();

// ---------- Disposición: modo y tamaños (por dispositivo) ----------
const MODE_KEY = 'chaggu:split-mode';
const modeStore = store<core.LayoutMode>((() => { const v = read<string>(MODE_KEY, 'auto'); return v === 'columns' || v === 'grid' ? v : 'auto'; })(), (v) => write(MODE_KEY, v));
export const useLayoutMode = () => useSyncExternalStore(modeStore.subscribe, modeStore.get);
export const setLayoutMode = modeStore.set;

type Sizes = Record<string, { rows?: number[]; cols?: Record<string, number[]> }>;
const SIZE_KEY = 'chaggu:split-sizes';
const sizeStore = store<Sizes>(read<Sizes>(SIZE_KEY, {}));
export const useSplitSizes = () => useSyncExternalStore(sizeStore.subscribe, sizeStore.get);
export function setSplitFractions(sig: string, part: { rows?: number[]; count?: number; cols?: number[] }, persist = false) {
  const cur = sizeStore.get();
  const prev = cur[sig] ?? {};
  const next = { ...prev, ...(part.rows ? { rows: part.rows } : {}), ...(part.cols && part.count ? { cols: { ...(prev.cols ?? {}), [part.count]: part.cols } } : {}) };
  sizeStore.set({ ...cur, [sig]: next });
  if (persist) write(SIZE_KEY, sizeStore.get());
}
export function resetSplitFractions(sig: string) { const cur = { ...sizeStore.get() }; delete cur[sig]; sizeStore.set(cur); write(SIZE_KEY, cur); }
export const persistSplitSizes = () => write(SIZE_KEY, sizeStore.get());

// ---------- Espacios de trabajo guardados ----------
const SPACES_KEY = 'chaggu:split-spaces';
const spacesStore = store<core.SavedSpace[]>((() => { const v = read<unknown>(SPACES_KEY, []); return Array.isArray(v) ? (v as core.SavedSpace[]).filter((x) => x && typeof x.name === 'string' && Array.isArray(x.panes)) : []; })(), (v) => write(SPACES_KEY, v));
export const useSavedSpaces = () => useSyncExternalStore(spacesStore.subscribe, spacesStore.get);
export function saveCurrentSpace(name: string) { spacesStore.set(core.saveSpace(spacesStore.get(), name, panesStore.get())); }
export function deleteSpace(name: string) { spacesStore.set(spacesStore.get().filter((x) => x.name !== name)); }
export function openSpace(sp: core.SavedSpace) {
  const s = core.restoreSpace(sp);
  if (!s.panes.length) return;
  setState(s);
  focusPane(s.panes[0]!);
}

// ---------- Zoom por conversación (A− / A+ o ⌘/Ctrl + rueda) ----------
const ZOOM_KEY = 'chaggu:conv-zoom';
export const ZOOM_MIN = 0.7, ZOOM_MAX = 1.6;
let zooms: Record<string, number> = (() => { try { return JSON.parse(localStorage.getItem(ZOOM_KEY) ?? '{}') ?? {}; } catch { return {}; } })();
const zoomListeners = new Set<() => void>();
export const useConvZoom = (id: string) => useSyncExternalStore((l) => { zoomListeners.add(l); return () => { zoomListeners.delete(l); }; }, () => zooms[id] ?? 1);
/** Zoom actual sin suscribirse (para los manejadores de eventos). */
export const convZoomNow = (id: string) => zooms[id] ?? 1;
export function setConvZoom(id: string, z: number) {
  const v = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 10) / 10;
  zooms = { ...zooms };
  if (v === 1) delete zooms[id]; else zooms[id] = v;
  zoomListeners.forEach((l) => l());
  try { localStorage.setItem(ZOOM_KEY, JSON.stringify(zooms)); } catch { /* */ }
}
