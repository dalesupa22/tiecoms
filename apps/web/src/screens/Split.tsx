/**
 * Área de paneles (docs/PANELES.md): hasta 8 cosas abiertas a la vez — chats, vistas y elementos sueltos —
 * acomodadas solas según el ancho (1 · 2 columnas · 3 columnas · 2×2 · 3+2 · 3×2 · 4+3 · 4×2 · 3+3+2).
 * - Arrastrar una fila (chat, WhatsApp, correo, tarea) o un ícono del riel: soltar en el centro de un panel lo
 *   reemplaza; en su borde izquierdo o derecho, lo abre al lado. Soltar un encabezado sobre otro los intercambia.
 * - Las divisiones se arrastran (doble clic: iguales). Cada panel tiene su número (⌘1…⌘8), color y 📌.
 * - Los paneles no se vuelven a montar al cambiar de disposición ni al agrandar uno (se posicionan en absoluto):
 *   no se pierde el scroll ni lo que estabas escribiendo.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { useClient } from '../app-client.ts';
import { t } from '../i18n.ts';
import { openMenuAt, type MenuItem } from '../menu.tsx';
import { openDialog } from '../actions.tsx';
import { Modal } from '../ui.tsx';
import { navigate } from '../router.ts';
import * as core from '../panes-core.ts';
import {
  DRAG_MOVE, MAX_PANES, PaneCtx, SPLIT_MEDIA, closePane, currentKey, deleteSpace, focusPane, isMoveDrag, isPaneDrag, keyToPath, movePane, onlyPane,
  openBeside, openSpace, persistSplitSizes, readPaneDrop, requestPaneFocus, resetSplitFractions, saveCurrentSpace, setCurrentMax, setLayoutMode,
  setPaneDescriber, setPaneMeta, setSplitFractions, swapPanes, syncActive, toggleMax, togglePin, useFlash, useLayoutMode, usePaneState, useRecentPanes,
  useSavedSpaces, useSplitSizes,
} from '../split.ts';
import { ConversationScreen } from './Conversation.tsx';
import { PaneBody, PaneHead, describePane, usePaneInfo, viewLabel } from './PaneItems.tsx';
import { ALT, MOD, SHIFT, paneTone, type PaneProps } from './PaneBits.tsx';
import { SplitPicker } from './SplitPicker.tsx';

/** En pantallas angostas (celular, ventana chica) no hay paneles: solo el activo. */
export function useWide() {
  const q = SPLIT_MEDIA;
  const [wide, setWide] = useState(() => typeof matchMedia === 'undefined' || matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const on = () => setWide(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return wide;
}

const GAP = 6;
const BAR_H = 34;
const isDesktopApp = typeof window !== 'undefined' && !!(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
type Zone = 'before' | 'after' | 'center';
/** Lo que se está arrastrando desde un encabezado (dataTransfer no se puede leer mientras se arrastra). */
let movingKey: string | null = null;

const KIND_ICON: Record<core.PaneKind, string> = { conv: '💬', view: '▦', wa: '🟢', mail: '✉', inbox: '✉', task: '◆' };

export function PaneArea({ active, search }: { active: string; search: string }) {
  const state = usePaneState();
  const wide = useWide();
  const convs = useClient((s) => s.data?.conversations);
  const mode = useLayoutMode();
  const sizes = useSplitSizes();
  const flash = useFlash();
  const root = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState(() => ({ w: Math.max(0, (typeof innerWidth === 'number' ? innerWidth : 1200) - 336), h: typeof innerHeight === 'number' ? innerHeight : 800 }));
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const r = e!.contentRect;
      setBox((b) => (Math.abs(b.w - r.width) < 1 && Math.abs(b.h - r.height) < 1 ? b : { w: r.width, h: r.height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { setPaneDescriber(describePane); }, []);
  // Antes de pintar: el panel del URL entra a los paneles (sin parpadeo ni montar dos veces el chat).
  useLayoutEffect(() => { syncActive(active); }, [active]);
  const gridH = Math.max(0, box.h - BAR_H);
  const max = core.maxPanesFor(box.w, gridH);
  useEffect(() => { setCurrentMax(max); }, [max]);

  const exists = (k: string) => core.paneKind(k) !== 'conv' || k === active || !!convs?.some((c) => c.id === k);
  const multiState = wide && state.panes.length > 1;
  const open = multiState ? state.panes.filter(exists) : [active];
  const list = multiState ? core.visiblePanes(open, active, max, state.pinned) : [active];
  const multi = list.length > 1;
  const pending = multi && !list.includes(active);
  const hidden = open.length - list.length;
  const maxed = multi && state.maximized && list.includes(state.maximized) ? state.maximized : null;
  const rows = maxed ? [1] : core.layoutFor(list.length, box.w, gridH, mode);
  const sig = core.layoutSig(rows);
  const saved = sizes[sig];
  const rowFr = saved?.rows?.length === rows.length ? saved.rows : core.equalFractions(rows.length);
  const colFr = (n: number) => (saved?.cols?.[n]?.length === n ? saved.cols[n]! : core.equalFractions(n));
  const full = list.length >= max;

  // ---------- Atajos ----------
  useEffect(() => {
    if (!multi) return;
    const k = (e: KeyboardEvent) => {
      if (document.querySelector('.overlay, .drawer-shade')) return;
      const mod = e.metaKey || e.ctrlKey;
      const digit = /^Digit([1-8])$/.exec(e.code);
      if (mod && digit && !e.shiftKey) {
        const to = list[Number(digit[1]) - 1];
        if (!to) return;
        e.preventDefault();
        if (maxed && to !== maxed) toggleMax(maxed);
        requestPaneFocus(to); focusPane(to);
        return;
      }
      if (mod && e.shiftKey && e.key === 'Enter') { e.preventDefault(); toggleMax(active); return; }
      if (mod && e.code === 'KeyW' && (e.altKey || (isDesktopApp && !e.shiftKey))) { e.preventDefault(); closePane(active); return; }
      if (mod && e.altKey && e.code === 'KeyP') { e.preventDefault(); togglePin(active); return; }
      if (e.key === 'Escape' && maxed && !e.defaultPrevented) {
        const el = e.target as HTMLElement | null;
        if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') && (el as HTMLInputElement).value) return;
        toggleMax(maxed);
      }
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [multi, list.join('|'), active, maxed]);

  // ---------- Soltar ----------
  const [drag, setDrag] = useState<{ over: string | null; zone: Zone | null; move: boolean } | null>(null);
  const onDragOver = (e: DragEvent) => {
    if (!wide || !isPaneDrag(e.dataTransfer)) return;
    e.preventDefault();
    const move = isMoveDrag(e.dataTransfer);
    e.dataTransfer.dropEffect = move ? 'move' : 'copy';
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-pane]');
    const over = cell?.dataset.pane ?? null;
    let zone: Zone | null = null;
    if (cell) {
      const r = cell.getBoundingClientRect();
      const x = (e.clientX - r.left) / Math.max(1, r.width);
      zone = x < 0.28 ? 'before' : x > 0.72 ? 'after' : 'center';
    }
    if (!drag || drag.over !== over || drag.zone !== zone || drag.move !== move) setDrag({ over, zone, move });
  };
  const onDragLeave = (e: DragEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setDrag(null);
  };
  const onDrop = (e: DragEvent) => {
    const got = readPaneDrop(e.dataTransfer);
    const where = drag;
    setDrag(null); movingKey = null;
    if (!got) return;
    e.preventDefault();
    const over = where?.over ?? null;
    const zone = where?.zone ?? null;
    if (got.move) {
      if (!over || over === got.key) return;
      if (zone === 'center') swapPanes(got.key, over);
      else movePane(got.key, state.panes.indexOf(over) + (zone === 'after' ? 1 : 0));
      return;
    }
    if (!multi) {
      // Un solo panel: en el centro se abre aquí; en un borde, al lado.
      if (zone === 'center' || !over) { if (got.meta) setPaneMeta(got.key, got.meta); navigate(keyToPath(got.key)); return; }
      openBeside(got.key, active, { at: zone === 'after' ? 1 : 0, meta: got.meta });
      return;
    }
    if (!over) { openBeside(got.key, active, { meta: got.meta }); return; }
    const idx = state.panes.indexOf(over);
    openBeside(got.key, active, zone === 'center' ? { target: over, meta: got.meta } : { target: over, at: idx + (zone === 'after' ? 1 : 0), meta: got.meta });
  };
  const zoneLabel = (over: string, zone: Zone, move: boolean) => {
    if (move) return over === movingKey ? '' : zone === 'center' ? t('split.zoneSwap') : t('split.zoneMove');
    if (!multi) return zone === 'center' ? t('split.zoneHere') : t('split.zoneBeside');
    const pinned = state.pinned.includes(over);
    if (zone === 'center') return pinned ? t('split.zonePinned') : t('split.zoneReplace');
    return full && !pinned ? t('split.zoneFull', { max }) : t('split.zoneBeside');
  };
  const dropProps = { onDragOver, onDragLeave, onDrop };

  if (!multi) {
    const kind = core.paneKind(active);
    return (
      <div ref={root} className={`split n1 ${drag ? 'is-dropping' : ''}`} {...dropProps}>
        <div className="split-cell is-active" data-pane={active}>
          <PaneCtx.Provider value={null}>
            {kind === 'conv' ? <ConversationScreen key={active + search} id={active} /> : <SoloPane k={active} />}
          </PaneCtx.Provider>
          {drag?.over && drag.zone && <DropZone zone={drag.zone} label={zoneLabel(active, drag.zone, drag.move)} />}
        </div>
      </div>
    );
  }

  // Posición de cada panel (en % del área, con el espacio entre ellos).
  const rects = new Map<string, CSSProperties>();
  const gutters: { key: string; dir: 'col' | 'row'; style: CSSProperties; row: number; at: number; count: number }[] = [];
  const shown = maxed ? [maxed] : list;
  let i = 0, top = 0;
  rows.forEach((count, r) => {
    const cols = colFr(count);
    const h = rowFr[r]!;
    let left = 0;
    for (let c = 0; c < count && i < shown.length; c++, i++) {
      const w = cols[c]!;
      const l = c > 0 ? GAP / 2 : 0, rr = c < count - 1 ? GAP / 2 : 0, tp = r > 0 ? GAP / 2 : 0, bt = r < rows.length - 1 ? GAP / 2 : 0;
      rects.set(shown[i]!, { left: `calc(${left * 100}% + ${l}px)`, top: `calc(${top * 100}% + ${tp}px)`, width: `calc(${w * 100}% - ${l + rr}px)`, height: `calc(${h * 100}% - ${tp + bt}px)` });
      left += w;
      if (c < count - 1) gutters.push({ key: `c${r}-${c}`, dir: 'col', row: r, at: c, count, style: { left: `calc(${left * 100}% - ${GAP / 2}px)`, top: `calc(${top * 100}% + ${r > 0 ? GAP / 2 : 0}px)`, height: `calc(${h * 100}% - ${GAP}px)` } });
    }
    top += h;
    if (r < rows.length - 1) gutters.push({ key: `r${r}`, dir: 'row', row: r, at: r, count, style: { top: `calc(${top * 100}% - ${GAP / 2}px)` } });
  });

  const startResize = (g: (typeof gutters)[number], e: React.PointerEvent<HTMLDivElement>) => {
    const grid = e.currentTarget.parentElement as HTMLElement;
    const size = grid.getBoundingClientRect();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX, y0 = e.clientY;
    const base = g.dir === 'col' ? colFr(g.count) : rowFr;
    document.body.classList.add(g.dir === 'col' ? 'is-resizing-col' : 'is-resizing-row');
    const moveEv = (ev: PointerEvent) => {
      const delta = g.dir === 'col' ? (ev.clientX - x0) / size.width : (ev.clientY - y0) / size.height;
      const next = core.resizeFractions(base, g.at, delta);
      setSplitFractions(sig, g.dir === 'col' ? { count: g.count, cols: next } : { rows: next });
    };
    const up = () => {
      el.removeEventListener('pointermove', moveEv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      document.body.classList.remove('is-resizing-col', 'is-resizing-row');
      persistSplitSizes();
    };
    el.addEventListener('pointermove', moveEv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    e.preventDefault();
  };

  const paneProps = (k: string, index: number): PaneProps => ({
    paneKey: k, index, active: k === active, count: list.length, pinned: state.pinned.includes(k), maximized: maxed === k,
    onClose: () => closePane(k, active), onOnly: () => onlyPane(k), onPin: () => togglePin(k), onMax: () => toggleMax(k),
    onHeadDragStart: (e) => { movingKey = k; e.dataTransfer.setData(DRAG_MOVE, k); e.dataTransfer.effectAllowed = 'move'; },
    onHeadDragEnd: () => { movingKey = null; setDrag(null); },
  });

  return (
    <div ref={root} className={`split is-multi n${list.length} ${maxed ? 'is-maxed' : ''} ${drag ? 'is-dropping' : ''}`} {...dropProps}>
      <PanesBar list={list} active={active} max={max} hidden={hidden} maxed={maxed} full={full} rows={rows} />
      <div className="split-grid">
        {!pending && list.map((k, n) => {
          const kind = core.paneKind(k);
          const pp = paneProps(k, n + 1);
          const style = rects.get(k);
          return (
            <div key={k} data-pane={k} data-kind={kind}
              className={`split-cell kind-${kind} ${k === active ? 'is-active' : ''} ${pp.pinned ? 'is-pinned' : ''} ${flash === k ? 'is-flash' : ''} ${drag?.over === k ? 'is-target' : ''} ${style ? '' : 'is-off'}`}
              style={{ ...paneTone(k), ...(style ?? {}) }}
              // Tocar un panel lo vuelve el activo (antes del clic, para que el clic siga funcionando adentro).
              onPointerDownCapture={() => { if (k !== active) focusPane(k); }}>
              <PaneCtx.Provider value={{ key: k, active: k === active }}>
                {kind === 'conv'
                  ? <ConversationScreen key={k} id={k} search={k === active ? search : ''} pane={pp} />
                  : <><PaneHead k={k} pane={pp} /><div className="pane-body"><PaneBody k={k} active={k === active} /></div></>}
              </PaneCtx.Provider>
              {drag?.over === k && drag.zone && <DropZone zone={drag.zone} label={zoneLabel(k, drag.zone, drag.move)} />}
            </div>
          );
        })}
        {!maxed && gutters.map((g) => (
          <div key={g.key} className={`split-handle is-${g.dir}`} role="separator" aria-orientation={g.dir === 'col' ? 'vertical' : 'horizontal'} title={t('split.resize')}
            style={g.style} onPointerDown={(e) => startResize(g, e)} onDoubleClick={() => resetSplitFractions(sig)} />
        ))}
      </div>
    </div>
  );
}

function DropZone({ zone, label }: { zone: Zone; label: string }) {
  if (!label) return null;
  return <div className={`split-zone zone-${zone}`} aria-hidden><span>{zone === 'before' ? '◧ ' : zone === 'after' ? '◨ ' : ''}{label}</span></div>;
}

/** Un solo panel que no es un chat (p. ej. /p/wa:… en una ventana angosta): su encabezado simple. */
function SoloPane({ k }: { k: string }) {
  const info = usePaneInfo(k);
  return (
    <div className="solo-pane" style={paneTone(k)}>
      <header className="pane-head is-solo">
        <button className="icon-btn only-mobile" aria-label={t('common.back')} onClick={() => (history.length > 1 ? history.back() : navigate('/'))}>‹</button>
        <span className="pane-ico">{info.icon}</span>
        <span className="pane-title grow"><b className="ellipsis">{info.title}</b>{info.sub && <span className="pane-sub ellipsis">{info.sub}</span>}</span>
        <button className="icon-btn only-desktop" title={t('split.add')} aria-label={t('split.add')} onClick={() => openDialog((close) => <SplitPicker activeId={k} onClose={close} />)}>⊞</button>
      </header>
      <div className="pane-body"><PaneBody k={k} active /></div>
    </div>
  );
}

// ---------- Barra de paneles: pestañas numeradas, ＋ Chat, ＋ Vista, disposición, espacios y atajos ----------
function PanesBar({ list, active, max, hidden, maxed, full, rows }: { list: string[]; active: string; max: number; hidden: number; maxed: string | null; full: boolean; rows: number[] }) {
  const mode = useLayoutMode();
  const spaces = useSavedSpaces();
  const recent = useRecentPanes();
  const d = useClient((s) => s.data);
  const mailOn = d?.features?.mail === true;
  const at = (e: React.MouseEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); return [r.left, r.bottom + 4] as const; };
  const views: core.ViewName[] = ['issues', 'agenda', ...(mailOn ? ['mail' as const] : []), 'whatsapp', 'today', 'files'];
  const addView = (e: React.MouseEvent) => {
    const recentItems: MenuItem[] = recent.filter((k) => !list.includes(k)).slice(0, 8).map((k) => ({ label: describePane(k), icon: KIND_ICON[core.paneKind(k)], onSelect: () => openBeside(k) }));
    openMenuAt(...at(e), [
      ...views.map((v) => ({ label: viewLabel(v), icon: '▦', hint: list.includes(core.viewKey(v)) ? '✓' : undefined, onSelect: () => openBeside(core.viewKey(v)) })),
      ...(recentItems.length ? [{ divider: true }, { label: t('split.recent'), disabled: true }, ...recentItems] : []),
    ]);
  };
  const layout = (e: React.MouseEvent) => openMenuAt(...at(e), [
    ...(['auto', 'columns', 'grid'] as const).map((m) => ({ label: t(m === 'auto' ? 'split.layoutAuto' : m === 'columns' ? 'split.layoutColumns' : 'split.layoutGrid'), icon: m === 'auto' ? '◫' : m === 'columns' ? '▥' : '▦', hint: mode === m ? '✓' : undefined, onSelect: () => setLayoutMode(m) })),
    { divider: true },
    { label: t('split.layoutEqual'), icon: '⇔', onSelect: () => resetSplitFractions(core.layoutSig(rows)) },
    { label: t('split.limit', { max }), disabled: true },
  ]);
  const spacesMenu = (e: React.MouseEvent) => openMenuAt(...at(e), [
    ...(spaces.length ? spaces.map((sp) => ({ label: sp.name, icon: '◩', hint: String(sp.panes.length), onSelect: () => openSpace(sp) })) : [{ label: t('split.noSpaces'), disabled: true }]),
    { divider: true },
    { label: t('split.saveSpace'), icon: '＋', onSelect: () => openDialog((close) => <SaveSpaceDialog n={list.length} onClose={close} />) },
    ...(spaces.length ? [{ label: t('split.deleteSpace'), icon: '🗑', items: spaces.map((sp) => ({ label: sp.name, danger: true, onSelect: () => deleteSpace(sp.name) })) }] : []),
    { divider: true },
    { label: t('split.closeAll'), icon: '▢', onSelect: () => onlyPane(active) },
  ]);
  const note = hidden > 0 ? t('split.hidden', { n: hidden, max }) : full && max < MAX_PANES ? t('split.limit', { max }) : null;
  return (
    <div className="panes-bar" role="toolbar" aria-label={t('split.bar')}>
      <div className="panes-tabs" role="tablist">
        {list.map((k, n) => <PaneTab key={k} k={k} n={n + 1} active={k === active} dim={!!maxed && k !== maxed} />)}
      </div>
      {note && <span className="panes-note" title={t('split.limitHelp', { max })}>{note}</span>}
      <span className="grow" />
      <button className="panes-btn" title={t('split.add')} onClick={() => openDialog((close) => <SplitPicker activeId={active} onClose={close} />)}>＋ {t('split.addChat')}</button>
      <button className="panes-btn" aria-haspopup="menu" onClick={addView}>＋ {t('split.addView')} ▾</button>
      <button className="panes-btn icon" aria-haspopup="menu" title={t('split.layout')} aria-label={t('split.layout')} onClick={layout}>{rows.join('+')}</button>
      <button className="panes-btn icon" aria-haspopup="menu" title={t('split.spaces')} aria-label={t('split.spaces')} onClick={spacesMenu}>◩</button>
      <button className="panes-btn icon" title={t('split.keysTitle')} aria-label={t('split.keysTitle')} onClick={() => openDialog((close) => <KeysDialog onClose={close} />)}>⌨</button>
      {maxed && <button className="panes-btn is-restore" onClick={() => toggleMax(maxed)}>⤡ {t('split.restore', { n: list.length })}</button>}
    </div>
  );
}

function PaneTab({ k, n, active, dim }: { k: string; n: number; active: boolean; dim: boolean }) {
  const info = usePaneInfo(k);
  return (
    <button role="tab" aria-selected={active} className={`pane-tab ${active ? 'is-active' : ''} ${dim ? 'is-dim' : ''}`} style={paneTone(k)}
      title={`${info.kindLabel} · ${info.title} · ${MOD}${n}`} onClick={() => { requestPaneFocus(k); focusPane(k); }}
      draggable onDragStart={(e) => { movingKey = k; e.dataTransfer.setData(DRAG_MOVE, k); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => { movingKey = null; }}>
      <span className="pane-tab-n">{n}</span><span className="pane-tab-ico">{info.icon}</span><span className="ellipsis">{info.title}</span>
      {info.unread > 0 && <span className="pane-tab-dot" aria-label={t('split.unread', { n: info.unread })} />}
    </button>
  );
}

function SaveSpaceDialog({ n, onClose }: { n: number; onClose: () => void }) {
  const [name, setName] = useState('');
  const save = () => { if (!name.trim()) return; saveCurrentSpace(name); onClose(); };
  return (
    <Modal title={t('split.saveTitle')} onClose={onClose}>
      <p className="small muted" style={{ marginTop: 0 }}>{t('split.saveHelp', { n })}</p>
      <input className="input" autoFocus maxLength={60} placeholder={t('split.saveName')} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
      <div className="modal-actions"><button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" disabled={!name.trim()} onClick={save}>{t('split.saveBtn')}</button></div>
    </Modal>
  );
}

function KeysDialog({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    [`${MOD}1 … ${MOD}8`, t('split.kFocus')],
    [`${MOD}${SHIFT}↵`, t('split.kMax')],
    [isDesktopApp ? `${MOD}W` : `${MOD}${ALT}W`, t('split.kClose')],
    [`${MOD}${ALT}P`, t('split.kPin')],
    ['Esc', t('split.kEsc')],
    [`${MOD} + clic`, t('split.kOpen')],
    ['⠿', t('split.kDrag')],
  ];
  return (
    <Modal title={t('split.keysTitle')} onClose={onClose}>
      <table className="keys-table"><tbody>{rows.map(([k, v]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{v}</td></tr>)}</tbody></table>
      {!isDesktopApp && <p className="small muted">{t('split.kBrowser', { mod: MOD, alt: ALT })}</p>}
    </Modal>
  );
}

/** Para App.tsx: ¿esta ruta se pinta como área de paneles? (chats y /p/… siempre; las vistas si están abiertas en paralelo). */
export function usePaneRoute(key: string | null, isConvOrPane: boolean) {
  const panes = usePaneState().panes;
  const wide = useWide();
  if (!key) return false;
  return isConvOrPane || (wide && panes.length > 1 && panes.includes(key));
}
export { currentKey };
