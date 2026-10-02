import { locale } from '../i18n.ts';
import { openMenuAt } from '../menu.tsx';

export interface PaneSizing {
  rows: 1 | 2;
  columns: 1 | 2;
  set: (rows: 1 | 2, columns: 1 | 2) => void;
  /** Alto completo en la primera, la del medio o la última columna (los que estaban ahí ceden su lugar). */
  place?: (where: 'left' | 'center' | 'right') => void;
}

/** Size is chosen on the panel itself, without translating a global preset. */
export function PaneSizeControl({ size }: { size?: PaneSizing }) {
  if (!size) return null;
  const en = locale().startsWith('en');
  const choices: { rows: 1 | 2; columns: 1 | 2; label: string; icon: string }[] = [
    { rows: 1, columns: 1, label: en ? '1 column · 1 row' : '1 columna · 1 fila', icon: '□' },
    { rows: 2, columns: 1, label: en ? '2 rows · Full height' : '2 filas · Alto completo', icon: '▯' },
    { rows: 1, columns: 2, label: en ? '2 columns · Double width' : '2 columnas · Doble ancho', icon: '▭' },
    { rows: 2, columns: 2, label: en ? '2 columns · 2 rows' : '2 columnas · 2 filas', icon: '▣' },
  ];
  const places: { where: 'left' | 'center' | 'right'; label: string; icon: string }[] = [
    { where: 'left', label: en ? 'Full height on the left' : 'Alto completo a la izquierda', icon: '⇤' },
    { where: 'center', label: en ? 'Full height in the center' : 'Alto completo al centro', icon: '↔' },
    { where: 'right', label: en ? 'Full height on the right' : 'Alto completo a la derecha', icon: '⇥' },
  ];
  const label = en ? 'Panel size' : 'Tamaño del panel';
  return <button className="pane-size-control" type="button" aria-label={label} aria-haspopup="menu"
    title={`${label}: ${size.columns} ${en ? 'columns' : 'columnas'} × ${size.rows} ${en ? 'rows' : 'filas'}`}
    onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openMenuAt(r.left, r.bottom + 4, [...choices.map((choice) => ({
      label: choice.label, icon: choice.rows === size.rows && choice.columns === size.columns ? '✓' : choice.icon,
      onSelect: () => size.set(choice.rows, choice.columns),
    })), ...(size.place ? places.map((p) => ({ label: p.label, icon: p.icon, onSelect: () => size.place!(p.where) })) : [])]); }}><span aria-hidden>▦</span> {en ? 'Size' : 'Tamaño'}</button>;
}
