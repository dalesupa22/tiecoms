/**
 * Columnas de las tareas por grupo (docs/TAREAS-CAMPOS.md): texto, lista desplegable (p. ej. «Tipo»: Bug,
 * Funcionalidad nueva, Mejora), número o casilla. Las define quien administra el grupo.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { IssueFieldValue, TaskColumnDTO, TaskColumnType } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { errorText } from '../i18n.ts';
import { Modal, conversationTitle } from '../ui.tsx';
import { taskText } from './TaskReports.tsx';

type Entry = { columns: TaskColumnDTO[]; canEdit: boolean };
const cache = new Map<string, Entry>();
const loading = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => { version++; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };

function ensure(id: string) {
  if (cache.has(id) || loading.has(id)) return;
  loading.add(id);
  client.taskColumns(id).then((r) => { cache.set(id, r); }).catch(() => { cache.set(id, { columns: [], canEdit: false }); })
    .finally(() => { loading.delete(id); emit(); });
}

/** Columnas definidas de varios grupos, unidas por nombre (la primera definición gana). */
export function useTaskColumns(conversationIds: (string | null | undefined)[]) {
  useSyncExternalStore(subscribe, () => version);
  const ids = [...new Set(conversationIds.filter((x): x is string => !!x))];
  useEffect(() => { ids.forEach(ensure); }, [ids.join(',')]);
  const out: TaskColumnDTO[] = [];
  for (const id of ids) for (const c of cache.get(id)?.columns ?? []) if (!out.some((x) => x.name.toLowerCase() === c.name.toLowerCase())) out.push(c);
  return out;
}
export const columnsOf = (conversationId: string | null | undefined) => (conversationId ? cache.get(conversationId) : undefined);

const TYPES: [TaskColumnType, string][] = [
  ['select', taskText('Lista desplegable', 'Dropdown')], ['text', taskText('Texto', 'Text')],
  ['number', taskText('Número', 'Number')], ['checkbox', taskText('Casilla sí/no', 'Checkbox')],
];

/** Control para el valor de un campo según el tipo de su columna. */
export function FieldControl({ column, value, disabled, onChange }: { column: TaskColumnDTO; value: IssueFieldValue | undefined; disabled?: boolean; onChange: (v: IssueFieldValue | null) => void }) {
  if (column.type === 'select') {
    return (
      <select className="input issue-field-select" value={value === undefined ? '' : String(value)} disabled={disabled} aria-label={column.name}
        onClick={(e) => e.stopPropagation()} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">—</option>
        {(column.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        {value !== undefined && !(column.options ?? []).includes(String(value)) && <option value={String(value)}>{String(value)}</option>}
      </select>
    );
  }
  if (column.type === 'checkbox') {
    return <input type="checkbox" checked={value === true} disabled={disabled} aria-label={column.name} onClick={(e) => e.stopPropagation()} onChange={(e) => onChange(e.target.checked)} />;
  }
  return (
    <input key={String(value ?? '')} className="input issue-field-input" type={column.type === 'number' ? 'number' : 'text'} defaultValue={value === undefined ? '' : String(value)} disabled={disabled} aria-label={column.name}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v === String(value ?? '')) return; onChange(v === '' ? null : column.type === 'number' ? Number(v) : v); }} />
  );
}

/** Editor de las columnas de un grupo. Sin grupo fijo, se elige entre los que administro. */
export function TaskColumnsDialog({ conversationId, onClose }: { conversationId?: string | null; onClose: () => void }) {
  const d = useClient((s) => s.data)!;
  const groups = d.conversations.filter((c) => c.canManage && c.kind !== 'direct');
  const [conv, setConv] = useState(conversationId ?? groups[0]?.id ?? '');
  const [rows, setRows] = useState<{ name: string; type: TaskColumnType; options: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!conv) return;
    setRows(null); setError(null);
    client.taskColumns(conv).then((r) => {
      cache.set(conv, r); emit();
      setRows(r.columns.length ? r.columns.map((c) => ({ name: c.name, type: c.type, options: (c.options ?? []).join(', ') }))
        : [{ name: taskText('Tipo', 'Type'), type: 'select', options: taskText('Bug, Funcionalidad nueva, Mejora', 'Bug, New feature, Improvement') }]);
    }).catch((e) => setError(errorText(e)));
  }, [conv]);
  const set = (k: number, patch: Partial<NonNullable<typeof rows>[number]>) => setRows((r) => r!.map((x, j) => (j === k ? { ...x, ...patch } : x)));
  const save = async () => {
    if (!rows) return;
    setSaving(true); setError(null);
    try {
      const columns: TaskColumnDTO[] = rows.filter((r) => r.name.trim()).map((r) => ({
        name: r.name.trim(), type: r.type,
        ...(r.type === 'select' ? { options: r.options.split(/[,\n]/).map((o) => o.trim()).filter(Boolean) } : {}),
      }));
      const r = await client.setTaskColumns(conv, columns);
      cache.set(conv, r); emit(); onClose();
    } catch (e) { setError(errorText(e)); } finally { setSaving(false); }
  };
  const current = d.conversations.find((c) => c.id === conv);
  return (
    <Modal title={taskText('Columnas de las tareas', 'Task columns')} onClose={onClose}>
      {!conversationId && (groups.length
        ? <label className="small muted">{taskText('Grupo', 'Group')} <select className="input" value={conv} onChange={(e) => setConv(e.target.value)}>{groups.map((c) => <option key={c.id} value={c.id}>{conversationTitle(d, c)}</option>)}</select></label>
        : <p className="muted">{taskText('No administras ningún grupo.', 'You don’t manage any group.')}</p>)}
      {conversationId && current && <p className="small muted">{conversationTitle(d, current)}</p>}
      <p className="hint">{taskText('Las listas desplegables solo aceptan sus opciones (también por webhook y por el MCP). Separa las opciones con comas.', 'Dropdowns only accept their options (also via webhook and MCP). Separate options with commas.')}</p>
      {rows === null && !error && <div className="muted">…</div>}
      {rows && <div className="task-columns-edit">
        {rows.map((r, k) => (
          <div key={k} className="task-column-row">
            <input className="input" placeholder={taskText('Nombre de la columna', 'Column name')} maxLength={60} value={r.name} onChange={(e) => set(k, { name: e.target.value })} />
            <select className="input" value={r.type} onChange={(e) => set(k, { type: e.target.value as TaskColumnType })}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            {r.type === 'select' && <input className="input task-column-options" placeholder={taskText('Opciones: Bug, Mejora…', 'Options: Bug, Improvement…')} value={r.options} onChange={(e) => set(k, { options: e.target.value })} />}
            <button className="link-btn muted issue-field-x" aria-label={taskText('Quitar columna', 'Remove column')} onClick={() => setRows(rows.filter((_, j) => j !== k))}>×</button>
          </div>
        ))}
        <button className="btn small" disabled={rows.length >= 30} onClick={() => setRows([...rows, { name: '', type: 'select', options: '' }])}>＋ {taskText('Agregar columna', 'Add column')}</button>
      </div>}
      {error && <div className="error">{error}</div>}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button className="btn ghost" onClick={onClose}>{taskText('Cancelar', 'Cancel')}</button>
        <button className="btn primary" disabled={!rows || saving || !conv} onClick={() => void save()}>{taskText('Guardar', 'Save')}</button>
      </div>
    </Modal>
  );
}
