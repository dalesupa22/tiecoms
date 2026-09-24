import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent as RMouseEvent, type TouchEvent as RTouchEvent } from 'react';

/**
 * Menú contextual global (clic derecho, tecla de menú o pulsación larga en táctil)
 * y avisos breves. Un solo menú abierto a la vez; se cierra con Esc, clic fuera,
 * scroll o cambio de tamaño.
 */
export interface MenuItem {
  label?: string;
  icon?: string;
  onSelect?: () => void;
  items?: MenuItem[];
  danger?: boolean;
  disabled?: boolean;
  divider?: boolean;
  hint?: string;
}

interface MenuState { x: number; y: number; items: MenuItem[] }
let menu: MenuState | null = null;
const menuListeners = new Set<() => void>();
const emitMenu = () => menuListeners.forEach((l) => l());

export function openMenuAt(x: number, y: number, items: MenuItem[]) {
  menu = { x, y, items: items.filter((i) => i.divider || i.label) };
  emitMenu();
}
export function closeMenu() { if (menu) { menu = null; emitMenu(); } }

/** Manejador listo para onContextMenu. */
export function contextHandler(build: () => MenuItem[]) {
  return (e: RMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Con teclado (Shift+F10 o tecla de menú) el evento llega sin coordenadas.
    const x = e.clientX || r.left + 16, y = e.clientY || r.top + r.height / 2;
    openMenuAt(x, y, build());
  };
}

/** Pulsación larga en táctil (iOS no dispara contextmenu). */
export function longPress(build: () => MenuItem[], ms = 480) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start = { x: 0, y: 0 };
  const cancel = () => { if (timer) clearTimeout(timer); timer = null; };
  return {
    onTouchStart: (e: RTouchEvent) => {
      const t = e.touches[0]!;
      start = { x: t.clientX, y: t.clientY };
      cancel();
      timer = setTimeout(() => { timer = null; navigator.vibrate?.(10); openMenuAt(start.x, start.y, build()); }, ms);
    },
    onTouchMove: (e: RTouchEvent) => {
      const t = e.touches[0]!;
      if (Math.abs(t.clientX - start.x) > 10 || Math.abs(t.clientY - start.y) > 10) cancel();
    },
    onTouchEnd: cancel,
  };
}

/** Clic derecho + pulsación larga en un solo objeto para esparcir en el elemento. */
export function menuProps(build: () => MenuItem[]) {
  return { onContextMenu: contextHandler(build), ...longPress(build) };
}

function MenuList({ items, x, y, depth, onDone }: { items: MenuItem[]; x: number; y: number; depth: number; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [active, setActive] = useState(-1);
  const [sub, setSub] = useState<{ i: number; x: number; y: number } | null>(null);
  const enabled = items.map((it, i) => (!it.divider && !it.disabled ? i : -1)).filter((i) => i >= 0);

  useLayoutEffect(() => {
    const el = ref.current!;
    const w = el.offsetWidth, h = el.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    setPos({ x: Math.max(6, Math.min(x, vw - w - 6)), y: Math.max(6, Math.min(y, vh - h - 6)) });
    if (depth === 0) el.focus();
  }, [x, y, depth]);

  const openSub = (i: number) => {
    const row = ref.current?.querySelector<HTMLElement>(`[data-mi="${i}"]`);
    if (!row) return;
    const r = row.getBoundingClientRect();
    const right = r.right + 220 < window.innerWidth;
    setSub({ i, x: right ? r.right - 4 : r.left - 216, y: r.top - 6 });
  };
  const choose = (it: MenuItem, i: number) => {
    if (it.disabled || it.divider) return;
    if (it.items) { openSub(i); return; }
    onDone();
    it.onSelect?.();
  };
  const onKey = (e: React.KeyboardEvent) => {
    const at = enabled.indexOf(active);
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(enabled[(at + 1) % enabled.length] ?? -1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(enabled[(at - 1 + enabled.length) % enabled.length] ?? -1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const it = items[active]; if (it) choose(it, active); }
    else if (e.key === 'ArrowRight' && items[active]?.items) { e.preventDefault(); openSub(active); }
    else if (e.key === 'ArrowLeft' && depth > 0) { e.preventDefault(); onDone(); }
    else if (e.key === 'Escape') { e.preventDefault(); onDone(); }
  };

  return (
    <>
      <div ref={ref} className="ctx-menu" role="menu" tabIndex={-1} style={{ left: pos.x, top: pos.y }} onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()}>
        {items.map((it, i) => it.divider
          ? <div key={i} className="ctx-sep" role="separator" />
          : (
            <button key={i} data-mi={i} type="button" role="menuitem" aria-haspopup={it.items ? 'menu' : undefined} disabled={it.disabled}
              className={`ctx-item${it.danger ? ' is-danger' : ''}${active === i ? ' is-active' : ''}`}
              onMouseEnter={() => { setActive(i); if (it.items) openSub(i); else setSub(null); }}
              onClick={() => choose(it, i)}>
              <span className="ctx-ico">{it.icon ?? ''}</span>
              <span className="grow">{it.label}</span>
              {it.hint && <span className="ctx-hint">{it.hint}</span>}
              {it.items && <span className="ctx-hint">›</span>}
            </button>
          ))}
      </div>
      {sub && items[sub.i]?.items && (
        <MenuList items={items[sub.i]!.items!} x={sub.x} y={sub.y} depth={depth + 1} onDone={() => { setSub(null); if (depth === 0) onDone(); }} />
      )}
    </>
  );
}

export function MenuHost() {
  const m = useSyncExternalStore((l) => { menuListeners.add(l); return () => menuListeners.delete(l); }, () => menu);
  useEffect(() => {
    if (!m) return;
    const close = (e: Event) => { if (!(e.target as HTMLElement)?.closest?.('.ctx-menu')) closeMenu(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu(); };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', esc);
    window.addEventListener('resize', closeMenu);
    // Solo el desplazamiento hecho por la persona cierra el menú (no el scroll automático por mensajes nuevos).
    const userScroll = (e: Event) => { if (!(e.target as HTMLElement)?.closest?.('.ctx-menu')) closeMenu(); };
    window.addEventListener('wheel', userScroll, { capture: true, passive: true });
    window.addEventListener('touchmove', userScroll, { capture: true, passive: true });
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', esc);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('wheel', userScroll, true);
      window.removeEventListener('touchmove', userScroll, true);
    };
  }, [m]);
  if (!m) return null;
  return <MenuList items={m.items} x={m.x} y={m.y} depth={0} onDone={closeMenu} />;
}

// ---------- Avisos breves ----------
interface Toast { id: number; text: string; action?: { label: string; run: () => void } }
let toasts: Toast[] = [];
const toastListeners = new Set<() => void>();
let nextToast = 1;
export function toast(text: string, action?: Toast['action'], ms = 3200) {
  const id = nextToast++;
  toasts = [...toasts.slice(-2), { id, text, action }];
  toastListeners.forEach((l) => l());
  setTimeout(() => { toasts = toasts.filter((x) => x.id !== id); toastListeners.forEach((l) => l()); }, ms);
}
export function ToastHost() {
  const list = useSyncExternalStore((l) => { toastListeners.add(l); return () => toastListeners.delete(l); }, () => toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((x) => (
        <div key={x.id} className="toast">
          <span>{x.text}</span>
          {x.action && <button onClick={() => { x.action!.run(); toasts = toasts.filter((y) => y.id !== x.id); toastListeners.forEach((l) => l()); }}>{x.action.label}</button>}
        </div>
      ))}
    </div>
  );
}

export async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}
