/**
 * La cuadrícula: hasta 4 paneles abiertos a la vez (pedido de Danny, 30-sep-2026). Un panel es un chat de chaggu,
 * un correo de tu buzón o una conversación de WhatsApp (claves en grid-keys.ts). Se llevan ahí arrastrando una fila,
 * con el botón Fijar o desde la bandeja que sube al arrastrar cuando la cuadrícula no se ve (Tray.tsx).
 * - En /c/:id el chat del URL es el activo; en /cuadricula el activo es el último que tocaste.
 * - Un panel fijado nunca se reemplaza solo: con la cuadrícula llena cede otro.
 * - Todo queda guardado en este navegador para volver a encontrarlo igual.
 * - En pantallas angostas solo se ve el activo.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { navigate } from './router.ts';
import { MAX_PANES_DEFAULT, isChatKey, placeInto, replaceIndex } from './grid-keys.ts';

export const MAX_PANES = MAX_PANES_DEFAULT;
/** Desde qué ancho de ventana hay paneles (la app de Mac abre en ~1000 px: con 1100 no aparecían). */
export const SPLIT_MEDIA = '(min-width: 860px)';
export const splitAvailable = () => typeof matchMedia !== 'undefined' && matchMedia(SPLIT_MEDIA).matches;
/** ¿La ventana es lo bastante ancha para paneles? (en pantallas angostas no hay cuadrícula: solo el activo). */
export function useWide() {
  const [wide, setWide] = useState(() => typeof matchMedia === 'undefined' || matchMedia(SPLIT_MEDIA).matches);
  useEffect(() => {
    const m = matchMedia(SPLIT_MEDIA);
    const on = () => setWide(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return wide;
}
/** Tipos del arrastre (dataTransfer): una conversación de chaggu, un correo, una conversación de WhatsApp y un mensaje de WhatsApp. */
export const DRAG_TYPE = 'application/x-chaggu-conversation';
export const DRAG_MAIL = 'application/x-chaggu-mail';
export const DRAG_WA = 'application/x-chaggu-wa';
export const DRAG_WAMSG = 'application/x-chaggu-wamsg';
export type DragKind = 'chat' | 'mail' | 'wa' | 'wamsg';
const DRAG_KINDS: [string, DragKind][] = [[DRAG_TYPE, 'chat'], [DRAG_MAIL, 'mail'], [DRAG_WA, 'wa'], [DRAG_WAMSG, 'wamsg']];
/** Qué se está arrastrando (por los tipos del dataTransfer, que sí se ven mientras se arrastra). */
export function dragKindOf(types: readonly string[] | DOMStringList): DragKind | null {
  const list = Array.from(types as ArrayLike<string>);
  return DRAG_KINDS.find(([type]) => list.includes(type))?.[1] ?? null;
}
export const dragType = (k: DragKind) => DRAG_KINDS.find(([, kind]) => kind === k)![0];
/** Lo que se puede soltar en un cuadrito (todo menos un mensaje suelto) y lo que se puede llevar a un chat (correo y mensaje). */
export const fitsSlot = (k: DragKind | null) => k === 'chat' || k === 'mail' || k === 'wa';
export const fitsChat = (k: DragKind | null) => k === 'mail' || k === 'wamsg';

const KEY = 'chaggu:split';
const PIN_KEY = 'chaggu:split-pinned';
const META_KEY = 'chaggu:split-meta';
const SIDE_KEY = 'chaggu:grid-side';

function read<T>(key: string, fallback: T): T { try { const v = JSON.parse(localStorage.getItem(key) ?? 'null'); return v ?? fallback; } catch { return fallback; } }
function write(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sin almacenamiento */ } }

function load(): string[] { const v = read<unknown>(KEY, []); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX_PANES) : []; }
let panes: string[] = load();
let pinned: Set<string> = new Set(read<string[]>(PIN_KEY, []).filter((k) => typeof k === 'string'));
export interface PaneMeta { title: string; sub?: string }
let metas: Record<string, PaneMeta> = read<Record<string, PaneMeta>>(META_KEY, {});
let activeKey: string | null = null;
let gridSide = read<boolean>(SIDE_KEY, false) === true;
let pulse = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

function set(next: string[]) {
  panes = next.slice(0, MAX_PANES);
  // Lo que ya no está en la cuadrícula deja de estar fijado y de guardar su nombre.
  pinned = new Set([...pinned].filter((k) => panes.includes(k)));
  metas = Object.fromEntries(Object.entries(metas).filter(([k]) => panes.includes(k)));
  if (activeKey && !panes.includes(activeKey)) activeKey = null;
  write(KEY, panes); write(PIN_KEY, [...pinned]); write(META_KEY, metas);
  emit();
}
export const usePanes = () => useSyncExternalStore(subscribe, () => panes);
export const currentPanes = () => panes;
export const usePinned = () => useSyncExternalStore(subscribe, () => pinned);
export const isPinned = (key: string) => pinned.has(key);
export const useMetas = () => useSyncExternalStore(subscribe, () => metas);
export const useActiveKey = () => useSyncExternalStore(subscribe, () => activeKey);
export const usePulse = () => useSyncExternalStore(subscribe, () => pulse);
/** Nombre de un panel que no es un chat de chaggu (para la bandeja, el riel y el título mientras carga). */
export function rememberMeta(key: string, meta: PaneMeta) {
  if (metas[key]?.title === meta.title && metas[key]?.sub === meta.sub) return;
  metas = { ...metas, [key]: meta }; write(META_KEY, metas); emit();
}

export function togglePin(key: string): boolean {
  if (!panes.includes(key)) return false;
  const next = new Set(pinned);
  if (next.has(key)) next.delete(key); else next.add(key);
  pinned = next; write(PIN_KEY, [...pinned]); emit();
  return pinned.has(key);
}

/** La conversación del URL (/c/:id), si se está viendo una. */
function routeChatId(): string | null {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  const m = /^\/c\/([^/?#]+)/.exec(location.pathname.slice(base.length));
  return m ? decodeURIComponent(m[1]!) : null;
}

/**
 * Los paneles a mostrar con `active` (el del URL) adentro: si no estaba, reemplaza al activo anterior
 * (o se agrega si no había paneles). Así tocar un chat en la lista cambia el panel que tienes enfocado.
 */
let lastActive: string | null = null;
export function syncActive(active: string) {
  activeKey = active;
  if (panes.length === 0 || panes.includes(active)) { lastActive = active; emit(); return; }
  const at = lastActive ? panes.indexOf(lastActive) : -1;
  const next = [...panes];
  // Un panel fijado no cede su lugar al chat que abres: ese entra en otro hueco (o reemplaza al último sin fijar).
  if (at >= 0 && !pinned.has(lastActive!)) next[at] = active;
  else if (next.length < MAX_PANES) next.unshift(active);
  else { const r = replaceIndex(next, pinned); if (r >= 0) next[r] = active; else { lastActive = active; emit(); return; } }
  lastActive = active;
  set([...new Set(next)]);
}

export type OpenResult = 'opened' | 'focused' | 'blocked';
/**
 * Abre `key` en paralelo junto a `active` (la conversación que se está viendo). Con 4 abiertos, reemplaza a
 * `replace` (el panel donde se soltó) o al último sin fijar. Si ya estaba abierta, la enfoca; si todos los paneles
 * están fijados, no hace nada y devuelve 'blocked'.
 */
export function openBeside(key: string, active: string | null, replace?: string | null): OpenResult {
  const base = panes.length ? [...panes] : active ? [active] : [];
  if (base.includes(key)) { focusPane(key); return 'focused'; }
  if (base.length < MAX_PANES) base.push(key);
  else {
    const at = replaceIndex(base, pinned, replace ?? null);
    if (at < 0) return 'blocked';
    base[at] = key;
  }
  set(base);
  activeKey = key;
  if (!active && isChatKey(key)) navigate(`/c/${key}`);
  emit();
  return 'opened';
}

/**
 * Fija `key` en el cuadrito `index` (0–3) con su nombre: un hueco libre lo agrega al final, uno ocupado lo reemplaza.
 * Devuelve el lugar (0–3) o -1 si ese cuadrito es de un panel fijado o la cuadrícula está llena.
 */
export function pinAt(key: string, index: number, meta?: PaneMeta): number {
  const r = placeInto(panes, key, index, pinned, MAX_PANES);
  if (!r) return -1;
  if (r.replaced) pinned.delete(r.replaced);
  if (r.panes !== panes) set(r.panes);
  pinned = new Set(pinned).add(key);
  if (meta) metas = { ...metas, [key]: meta };
  activeKey = key; lastActive = key;
  write(PIN_KEY, [...pinned]); write(META_KEY, metas);
  pulse++;
  emit();
  return r.at;
}

/** Cierra un panel; si era el activo, el activo pasa al vecino. Con uno solo y sin nada fijado, vuelve a la vista normal. */
export function closePane(key: string, active: string | null) {
  const at = panes.indexOf(key);
  const next = panes.filter((x) => x !== key);
  const keep = next.length > 1 || next.some((k) => !isChatKey(k) || pinned.has(k));
  set(keep ? next : []);
  if (key === (active ?? activeKey)) {
    const to = next[Math.min(Math.max(0, at - 1), next.length - 1)];
    if (to) focusPane(to);
  }
}

/** Deja solo esta conversación (⤢). */
export function onlyPane(key: string) {
  if (isChatKey(key)) { set([]); navigate(`/c/${key}`, true); return; }
  set([key]); activeKey = key; emit();
}

/** Enfocar un panel sin recargar. Un chat cambia el URL solo si ya estás en /c/:id; en la cuadrícula solo se marca. */
export function focusPane(key: string) {
  lastActive = key; activeKey = key;
  if (isChatKey(key) && routeChatId()) navigate(`/c/${key}`, true);
  emit();
}

/** ¿La conversación está a la vista en algún panel? (para no avisar de lo que ya se está leyendo). */
export const isOpenInPanes = (id: string) => panes.includes(id);

// ---------- Cuadrícula al lado de WhatsApp y Correo ----------
export const useGridSide = () => useSyncExternalStore(subscribe, () => gridSide);
export function setGridSide(on: boolean) { gridSide = on; write(SIDE_KEY, on); emit(); }

// ---------- Arrastre en curso (para la bandeja) ----------
let dragging: DragKind | null = null;
export const useDragging = () => useSyncExternalStore(subscribe, () => dragging);
export function setDragging(k: DragKind | null) { if (dragging !== k) { dragging = k; emit(); } }

// ---------- De dónde vengo (el «← Volver» de la cuadrícula) ----------
let back: string | null = null;
export const useBack = () => useSyncExternalStore(subscribe, () => back);
export function rememberBack(path: string | null) { back = path; emit(); }

// ---------- Tamaño de los paneles (se arrastran las divisiones) ----------
/** Fracción del ancho para la columna izquierda y del alto para la fila de arriba (0,2–0,8). */
const SIZE_KEY = 'chaggu:split-size';
let sizes: { col: number; row: number } = (() => {
  try { const v = JSON.parse(localStorage.getItem(SIZE_KEY) ?? 'null'); if (v && v.col > 0 && v.row > 0) return v; } catch { /* */ }
  return { col: 0.5, row: 0.5 };
})();
const sizeListeners = new Set<() => void>();
export const useSplitSizes = () => useSyncExternalStore((l) => { sizeListeners.add(l); return () => { sizeListeners.delete(l); }; }, () => sizes);
export function setSplitSize(p: Partial<{ col: number; row: number }>, persist = false) {
  const clamp = (x: number) => Math.min(0.8, Math.max(0.2, x));
  sizes = { col: clamp(p.col ?? sizes.col), row: clamp(p.row ?? sizes.row) };
  sizeListeners.forEach((l) => l());
  if (persist) { try { localStorage.setItem(SIZE_KEY, JSON.stringify(sizes)); } catch { /* */ } }
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
