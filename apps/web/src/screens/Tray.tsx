/**
 * La cuadrícula te sigue (Danny, 30-sep-2026). En WhatsApp y Correo la cuadrícula no se ve, pero tienes que poder soltar ahí:
 *  · Bandeja: al arrastrar un correo, un mensaje de WhatsApp, una conversación o un chat, sube desde abajo con dos zonas.
 *    1 · Llevar a un chat (correo o mensaje) · 2 · Llevar a un cuadrito (correo, conversación o chat; queda fijado).
 *  · Botón Fijar: lo mismo sin arrastrar, eligiendo el cuadrito en un mini mapa.
 *  · El riel muestra la cuadrícula en vivo (Rail.tsx) y se puede poner al lado de la página (Shell.tsx).
 */
import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react';
import type { BootstrapDTO } from '@tiecoms/contracts';
import { useClient } from '../app-client.ts';
import { t } from '../i18n.ts';
import { openDialog } from '../actions.tsx';
import { ConvAvatar, Modal, conversationTitle } from '../ui.tsx';
import { activityOf } from '../home-order.ts';
import { parseKey } from '../grid-keys.ts';
import { BASE, navigate } from '../router.ts';
import { type DragPayload, paneOf, pinToSlot, readDrag, shareToChat } from '../grid-actions.ts';
import {
  MAX_PANES, type DragKind, dragKindOf, fitsChat, fitsSlot, setDragging, setGridSide, splitAvailable, togglePin, useDragging, useGridSide, useMetas, usePanes, usePinned, useWide, rememberBack,
} from '../split.ts';
import { CLASSIC_PANES, TASKS_KEY, TASKS_SLOT, slots, splitMain } from '../grid-keys.ts';
import { ProviderIcon, WaIcon } from './Mail.tsx';

/** Lo que dice un cuadrito: qué es y cómo se llama. */
function useSlotLabels() {
  const d = useClient((s) => s.data);
  const metas = useMetas();
  return (key: string): { title: string; icon: ReactNode } => {
    const ref = parseKey(key);
    if (ref.kind === 'chat') {
      const c = d?.conversations.find((x) => x.id === ref.id);
      return { title: c && d ? conversationTitle(d, c) : '…', icon: c ? <ConvAvatar c={c} size={18} /> : null };
    }
    if (ref.kind === 'mail') return { title: metas[key]?.title ?? t('mail.title'), icon: <ProviderIcon provider={ref.provider} size={18} /> };
    if (ref.kind === 'tasks') return { title: t('nav.issues'), icon: <span aria-hidden>☑</span> };
    if (ref.kind === 'agenda') return { title: t('nav.agenda'), icon: <span aria-hidden>▦</span> };
    if (ref.kind === 'trazo') return { title: t('nav.trazo'), icon: <span aria-hidden>⑂</span> };
    if (ref.kind === 'calls') return { title: t('nav.calls'), icon: <span aria-hidden>☎</span> };
    if (ref.kind === 'inbox') return { title: t('nav.mail'), icon: <ProviderIcon provider="google" size={18} /> };
    if (ref.kind === 'wachats') return { title: `WhatsApp · ${t('grid.allChats')}`, icon: <WaIcon size={18} /> };
    return { title: metas[key]?.title ?? 'WhatsApp', icon: <WaIcon size={18} /> };
  };
}

/** Los 4 cuaditos en pequeño: como mapa de la cuadrícula. `onPick` los vuelve botones; `drop` los vuelve destino de soltar. */
export function SlotMap({ onPick, drop, over }: { onPick?: (i: number) => void; drop?: { onOver: (i: number, e: DragEvent) => void; onDrop: (i: number, e: DragEvent) => void; onLeave: () => void }; over?: number | null }) {
  const panes = usePanes();
  const pinned = usePinned();
  const label = useSlotLabels();
  const tasksOpen = splitMain(panes).tasks;
  const tasksCls = `slot slot-tall ${tasksOpen ? 'is-full' : ''} ${tasksOpen && pinned.has(TASKS_KEY) ? 'is-pinned' : ''} ${over === TASKS_SLOT ? 'is-over' : ''}`;
  const tasksInner = <><span className="slot-what"><span aria-hidden>☑</span><b>{t('nav.issues')}</b></span><span className="slot-free">{tasksOpen ? (pinned.has(TASKS_KEY) ? `📌 ${t('grid.pinned')}` : '') : `＋ ${t('grid.free')}`}</span></>;
  // 4 cuaditos; con más paneles abiertos, los que hay más uno libre (hasta 8), en dos filas.
  const shown = Math.min(MAX_PANES, Math.max(CLASSIC_PANES, splitMain(panes).main.length + 1));
  const cols = Math.ceil(shown / 2);
  const tasksCol = cols > 2 ? { gridColumn: cols + 1 } : undefined;
  return (
    <div className="slot-map" style={cols > 2 ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr)) minmax(0, .62fr)` } : undefined}>
      {onPick
        ? <button type="button" className={tasksCls} style={tasksCol} title={t('grid.tasksSlot')} onClick={() => onPick(TASKS_SLOT)}>{tasksInner}</button>
        : <div className={tasksCls} style={tasksCol} title={t('grid.tasksSlot')} onDragOver={drop ? (e) => drop.onOver(TASKS_SLOT, e) : undefined} onDrop={drop ? (e) => drop.onDrop(TASKS_SLOT, e) : undefined} onDragLeave={drop?.onLeave}>{tasksInner}</div>}
      {slots(panes, shown).map((key, i) => {
        const on = over === i;
        const inner = key ? (
          <>
            <span className="slot-n">{i + 1}</span>
            <span className="slot-what">{label(key).icon}<b>{label(key).title}</b></span>
            {pinned.has(key) && <span className="slot-pin" aria-label={t('grid.pinned')}>📌</span>}
          </>
        ) : <><span className="slot-n">{i + 1}</span><span className="slot-free">＋ {t('grid.free')}</span></>;
        const cls = `slot ${key ? 'is-full' : ''} ${key && pinned.has(key) ? 'is-pinned' : ''} ${on ? 'is-over' : ''}`;
        const dis = !!key && pinned.has(key);
        return onPick
          ? <button key={i} type="button" className={cls} disabled={dis} onClick={() => onPick(i)}>{inner}</button>
          : <div key={i} className={cls} onDragOver={drop ? (e) => drop.onOver(i, e) : undefined} onDrop={drop ? (e) => drop.onDrop(i, e) : undefined} onDragLeave={drop?.onLeave}>{inner}</div>;
      })}
    </div>
  );
}

/** El mini mapa para elegir en qué cuadrito se fija algo (botón Fijar). */
export function openSlotPicker(p: DragPayload, name: string) {
  openDialog((close) => (
    <Modal title={t('grid.pickTitle', { name: name.length > 40 ? `${name.slice(0, 39)}…` : name })} onClose={close}>
      <p className="small muted" style={{ margin: 0 }}>{t('grid.pickHelp')}</p>
      <SlotMap onPick={(i) => { close(); pinToSlot(p, i, name); }} />
    </Modal>
  ));
}

/** Botón «Fijar» de una fila o de un panel: lleva eso a un cuadrito de la cuadrícula; si ya está, lo fija o lo suelta. */
export function PinToGrid({ payload, name, className = '' }: { payload: DragPayload; name: string; className?: string }) {
  const panes = usePanes();
  const pinned = usePinned();
  const wide = useWide();
  const pane = paneOf(payload);
  if (!wide || !splitAvailable() || !pane) return null;
  const inGrid = panes.includes(pane.key);
  const on = inGrid && pinned.has(pane.key);
  return (
    <button type="button" className={`pin-btn ${on ? 'is-on' : ''} ${className}`} aria-pressed={on} title={on ? t('grid.unpin') : t('grid.pinHint')}
      onClick={(e) => { e.stopPropagation(); if (inGrid) togglePin(pane.key); else openSlotPicker(payload, name); }}
      draggable={false}>
      <span aria-hidden>📌</span><span className="pin-lbl">{on ? t('grid.pinned') : t('grid.pin')}</span>
    </button>
  );
}

/** Los 4 cuadritos en vivo, como ícono 2×2 (riel y estado vacío). */
export function GridGlyph({ big }: { big?: boolean }) {
  const panes = usePanes();
  const pinned = usePinned();
  const tasksOpen = splitMain(panes).tasks;
  return <span className={`grid-glyph ${big ? 'big' : ''}`} aria-hidden>{slots(panes, CLASSIC_PANES).map((k, i) => <i key={i} className={k ? (pinned.has(k) ? 'is-pinned' : 'is-on') : ''} />)}<i className={`tall ${tasksOpen ? (pinned.has(TASKS_KEY) ? 'is-pinned' : 'is-on') : ''}`} /></span>;
}

/** Los chats a mano para la zona 1: fijados primero y luego los más recientes. */
function chatChoices(d: BootstrapDTO) {
  return d.conversations
    .filter((c) => c.canPost !== false && c.deriveKind !== 'side' && !c.parentId)
    .sort((a, b) => Number(!!b.pinnedAt) - Number(!!a.pinnedAt) || activityOf(b).localeCompare(activityOf(a)))
    .slice(0, 8);
}

/**
 * La bandeja. `gridVisible` dice si la cuadrícula ya está a la vista (en /c, /cuadricula o al lado): ahí no hace falta.
 */
export function DragTray({ gridVisible }: { gridVisible: boolean }) {
  const d = useClient((s) => s.data);
  const dragging = useDragging();
  const wide = useWide();
  const [over, setOver] = useState<string | null>(null);
  // Qué se está arrastrando, por los tipos del dataTransfer. Se avisa un instante después para no mover el DOM en pleno dragstart.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    const end = () => { generation++; clearTimeout(timer); setDragging(null); setOver(null); };
    const start = (e: globalThis.DragEvent) => {
      end(); const k = e.dataTransfer ? dragKindOf(e.dataTransfer.types) : null;
      const token = generation;
      if (k) timer = setTimeout(() => { if (!e.defaultPrevented && token === generation) setDragging(k); }, 0);
    };
    // Capture observes even stopped drops; defer teardown until the target consumed its payload.
    // Con queueMicrotask la bandeja se cerraba ENTRE escuchadores del mismo drop (la microtarea corre al vaciarse la pila),
    // React la desmontaba antes de entregar el drop a la fila y el mensaje no se compartía (2-oct-2026). setTimeout espera
    // a que termine todo el evento.
    const drop = () => { const token = generation; setTimeout(() => { if (token === generation) end(); }, 0); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') end(); };
    const visibility = () => { if (document.hidden) end(); };
    document.addEventListener('dragstart', start);
    document.addEventListener('dragend', end);
    document.addEventListener('drop', drop, true);
    document.addEventListener('keydown', key);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('blur', end); window.addEventListener('popstate', end); window.addEventListener('chaggu:navigate', end);
    return () => {
      document.removeEventListener('dragstart', start); document.removeEventListener('dragend', end); document.removeEventListener('drop', drop, true);
      document.removeEventListener('keydown', key); document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('blur', end); window.removeEventListener('popstate', end); window.removeEventListener('chaggu:navigate', end); end();
    };
  }, []);
  const chats = useMemo(() => (d ? chatChoices(d) : []), [d]);
  if (!d || !dragging || gridVisible || !wide) return null;
  const toChat = fitsChat(dragging), toSlot = fitsSlot(dragging);

  const accept = (ok: boolean, id: string, e: DragEvent) => { if (!ok) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (over !== id) setOver(id); };
  const take = (kind: DragKind | null, dt: DataTransfer) => (kind ? readDrag(dt, kind) : null);
  const dropChat = (cid: string, e: DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setOver(null);
    const p = take(dragKindOf(e.dataTransfer.types), e.dataTransfer); if (!p) return;
    const c = d.conversations.find((x) => x.id === cid);
    void shareToChat(p, cid, c ? conversationTitle(d, c) : '');
  };
  const dropSlot = (i: number, e: DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setOver(null);
    const p = take(dragKindOf(e.dataTransfer.types), e.dataTransfer); if (!p) return;
    const conversation = p.kind === 'chat' ? d.conversations.find((x) => x.id === p.id) : null;
    const name = conversation ? conversationTitle(d, conversation) : '';
    if (pinToSlot(p, i, name) >= 0) {
      rememberBack(location.pathname.slice(BASE.length) || '/');
      setDragging(null);
      navigate('/cuadricula');
    }
  };
  return (
    <div className="tray" role="region" aria-label={t('tray.title')}>
      <button className="tray-close icon-btn" aria-label={t('common.close')} onClick={() => { setDragging(null); setOver(null); }}>×</button>
      <div className={`tray-zone ${toChat ? '' : 'is-off'}`} data-off={t(dragging === 'section' ? 'tray.noChatSection' : 'tray.noChat')}>
        <h3><span className="tray-n">1</span>{t('grid.toChat')}</h3>
        <div className="tray-chats">
          {chats.map((c) => (
            <div key={c.id} className={`tray-chat ${over === `c:${c.id}` ? 'is-over' : ''}`}
              onDragOver={(e) => accept(toChat, `c:${c.id}`, e)} onDragLeave={() => setOver(null)} onDrop={(e) => dropChat(c.id, e)}>
              <ConvAvatar c={c} size={22} /><b className="ellipsis">{conversationTitle(d, c)}</b>
            </div>
          ))}
        </div>
      </div>
      <div className={`tray-zone ${toSlot ? '' : 'is-off'}`} data-off={t('tray.noSlot')}>
        <h3><span className="tray-n">2</span>{t('grid.toSlot')}</h3>
        <SlotMap over={over?.startsWith('s:') ? +over.slice(2) : null}
          drop={{ onOver: (i, e) => accept(toSlot, `s:${i}`, e), onDrop: dropSlot, onLeave: () => setOver(null) }} />
      </div>
    </div>
  );
}

/** «Cuadrícula al lado»: parte la pantalla para ver WhatsApp o Correo y la cuadrícula a la vez. */
export function GridSideButton() {
  const on = useGridSide();
  const wide = useWide();
  if (!wide) return null;
  return (
    <button className={`btn small ${on ? 'primary' : ''}`} aria-pressed={on} onClick={() => setGridSide(!on)} title={t(on ? 'grid.sideOff' : 'grid.side')}>
      <GridGlyph /> {t(on ? 'grid.sideOff' : 'grid.side')}
    </button>
  );
}
