/**
 * Área del chat con hasta 4 conversaciones en paralelo (split.ts). Se arrastra un chat de la lista y se
 * suelta aquí: con menos de 4 se abre al lado; con 4, reemplaza al panel donde se suelta.
 * 1 → pantalla completa · 2 → lado a lado · 3 → dos arriba y uno abajo · 4 → cuadrícula 2×2.
 */
import { useEffect, useState, type DragEvent } from 'react';
import { useClient } from '../app-client.ts';
import { t } from '../i18n.ts';
import { DRAG_TYPE, MAX_PANES, SPLIT_MEDIA, closePane, focusPane, onlyPane, openBeside, setSplitSize, syncActive, usePanes, useSplitSizes } from '../split.ts';
import { ConversationScreen } from './Conversation.tsx';

/** En pantallas angostas (celular, ventana chica) no hay paneles: solo el activo. */
function useWide() {
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

const isConvDrag = (e: DragEvent) => Array.from(e.dataTransfer.types).includes(DRAG_TYPE);

export function ConversationArea({ id, search }: { id: string; search: string }) {
  const panes = usePanes();
  const wide = useWide();
  const known = useClient((s) => s.data?.conversations);
  useEffect(() => { syncActive(id); }, [id]);
  const exists = (x: string) => x === id || !!known?.some((c) => c.id === x);
  const list = wide && panes.length > 1 ? panes.filter(exists) : [id];
  if (!list.includes(id)) list[0] = id;
  const [drop, setDrop] = useState<{ over: string | null } | null>(null);
  const full = list.length >= MAX_PANES;
  const sizes = useSplitSizes();

  const onDragOver = (e: DragEvent) => {
    if (!wide || !isConvDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-pane]');
    const over = cell?.dataset.pane ?? null;
    if (!drop || drop.over !== over) setDrop({ over });
  };
  const onDragLeave = (e: DragEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setDrop(null);
  };
  const onDrop = (e: DragEvent) => {
    const cid = e.dataTransfer.getData(DRAG_TYPE);
    setDrop(null);
    if (!cid || !isConvDrag(e)) return;
    e.preventDefault();
    openBeside(cid, id, full ? drop?.over ?? null : null);
  };
  const dropHint = drop && (full ? t('split.dropReplace') : t('split.dropAdd', { n: list.length + 1, max: MAX_PANES }));

  if (list.length === 1) {
    return (
      <div className={`split n1 ${drop ? 'is-dropping' : ''}`} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        <div className="split-cell is-active" data-pane={id}>
          <ConversationScreen key={id + search} id={id} />
        </div>
        {dropHint && <div className="split-drop" aria-hidden><span>⊞ {dropHint}</span></div>}
      </div>
    );
  }
  return (
    <div className={`split n${list.length} ${drop ? 'is-dropping' : ''}`} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
      style={{ gridTemplateColumns: `${sizes.col}fr ${1 - sizes.col}fr`, ...(list.length > 2 ? { gridTemplateRows: `${sizes.row}fr ${1 - sizes.row}fr` } : {}) }}>
      {list.map((x) => (
        <div key={x} data-pane={x} className={`split-cell ${x === id ? 'is-active' : ''} ${drop && full && drop.over === x ? 'is-target' : ''}`}
          // Tocar un panel lo vuelve el activo (antes del clic, para que el clic siga funcionando adentro).
          onPointerDownCapture={() => { if (x !== id) focusPane(x); }}>
          <ConversationScreen key={x} id={x} pane={{ active: x === id, count: list.length, onClose: () => closePane(x, id), onOnly: () => onlyPane(x) }} />
        </div>
      ))}
      {/* Divisiones que se arrastran para cambiar el tamaño (doble clic: mitad y mitad). */}
      <SplitHandle dir="col" at={sizes.col} />
      {list.length > 2 && <SplitHandle dir="row" at={sizes.row} />}
      {dropHint && <div className="split-drop" aria-hidden><span>⊞ {dropHint}</span></div>}
    </div>
  );
}

function SplitHandle({ dir, at }: { dir: 'col' | 'row'; at: number }) {
  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add(dir === 'col' ? 'is-resizing-col' : 'is-resizing-row');
    const move = (ev: PointerEvent) => setSplitSize(dir === 'col' ? { col: (ev.clientX - box.left) / box.width } : { row: (ev.clientY - box.top) / box.height });
    const up = () => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      document.body.classList.remove('is-resizing-col', 'is-resizing-row');
      setSplitSize({}, true);
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    e.preventDefault();
  };
  return <div className={`split-handle is-${dir}`} role="separator" aria-orientation={dir === 'col' ? 'vertical' : 'horizontal'} title={t('split.resize')}
    style={dir === 'col' ? { left: `calc(${at * 100}% - 5px)` } : { top: `calc(${at * 100}% - 5px)` }}
    onPointerDown={start} onDoubleClick={() => setSplitSize(dir === 'col' ? { col: 0.5 } : { row: 0.5 }, true)} />;
}
