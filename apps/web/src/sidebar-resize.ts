/** Sidebar widths are preferences in unzoomed CSS pixels, separate from inbox state. */
export type SidebarProvider = 'whatsapp' | 'mail';
export const SIDEBAR_WIDTH_KEY = 'chaggu:provider-sidebar-width:v1';
export const DEFAULT_SIDEBAR_WIDTH = 272;
export interface SidebarBounds { min: number; max: number; zoom: number }
type WidthPreferences = Partial<Record<SidebarProvider, number>>;
type WidthStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function sidebarBounds(shellWidth: number, railWidth: number, uiZoom: number): SidebarBounds {
  const zoom = Number.isFinite(uiZoom) && uiZoom > 0 ? uiZoom : 1;
  const available = Math.max(0, shellWidth - railWidth);
  // Keep at least 38% for the workspace, including at large text sizes.
  const max = Math.max(0, Math.min(720 * zoom, available * .62, available - Math.min(320 * zoom, available * .5)));
  return { min: Math.min(240 * zoom, max), max, zoom };
}
export function clampSidebarWidth(width: number, bounds: SidebarBounds): number {
  const value = Number.isFinite(width) ? width : DEFAULT_SIDEBAR_WIDTH * bounds.zoom;
  return Math.max(bounds.min, Math.min(bounds.max, value));
}
function readPreferences(storage: WidthStorage): WidthPreferences {
  try {
    const value: unknown = JSON.parse(storage.getItem(SIDEBAR_WIDTH_KEY) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result: WidthPreferences = {};
    for (const key of ['whatsapp', 'mail'] as const) {
      const width = (value as Record<string, unknown>)[key];
      if (typeof width === 'number' && Number.isFinite(width) && width >= 120 && width <= 1440) result[key] = width;
    }
    return result;
  } catch { return {}; }
}
export function readSidebarWidth(storage: WidthStorage, provider: SidebarProvider): number {
  return readPreferences(storage)[provider] ?? DEFAULT_SIDEBAR_WIDTH;
}
export function saveSidebarWidth(storage: WidthStorage, provider: SidebarProvider, width: number): void {
  if (!Number.isFinite(width) || width < 120 || width > 1440) return;
  try { storage.setItem(SIDEBAR_WIDTH_KEY, JSON.stringify({ ...readPreferences(storage), [provider]: width })); } catch { /* Storage may be disabled; the gesture still works. */ }
}

/** One gesture: preview freely, persist once on completion, or restore on cancellation. */
export function sidebarWidthGesture(initial: number, preview: (width: number) => void, commit: (width: number) => void) {
  let current = initial, finished = false;
  return {
    update(width: number) { if (!finished && Number.isFinite(width)) { current = width; preview(width); } },
    finish() { if (finished) return; finished = true; if (current !== initial) commit(current); },
    cancel() { if (finished) return; finished = true; preview(initial); },
  };
}
