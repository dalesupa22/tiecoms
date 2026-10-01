import { useEffect, useMemo, useRef, useState } from 'react';
import type { IssueDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { errorText, getLang, locale } from '../i18n.ts';
import { Modal, conversationTitle, personById } from '../ui.tsx';
import { assignedTo, buildTaskReport, taskReportCsv, taskReportHtml, taskStats, mergeTaskSnapshot } from '../task-report.ts';
import './task-improvements.css';

export const taskText = (es: string, en: string) => getLang() === 'en' ? en : es;
const dateToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
/** Hoy usa todas mis tareas, sin el límite de 500 de la lista, y aplica cambios en vivo. */
export function TodayTaskStats() {
  const me = useClient((s) => s.data?.me.id);
  const issues = useClient((s) => s.issues);
  const [snapshot, setSnapshot] = useState<{ userId: string; tasks: IssueDTO[] } | null>(null);
  const [statsError, setStatsError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const previousKnown = useRef(new Set(Object.keys(issues)));
  useEffect(() => {
    if (!me) return;
    let active = true; setStatsError(false);
    client.issueReport().then((tasks) => { if (active) setSnapshot({ userId: me, tasks }); }).catch(() => { if (active) setStatsError(true); });
    return () => { active = false; };
  }, [me, refresh]);
  useEffect(() => {
    const known = new Set(Object.keys(issues));
    const missing = [...previousKnown.current].filter((id) => !known.has(id));
    setRemovedIds((previous) => { const next = new Set(previous); let changed = false; for (const id of missing) { if (!next.has(id)) { next.add(id); changed = true; } } for (const id of known) if (next.delete(id)) changed = true; return changed ? next : previous; });
    previousKnown.current = known;
  }, [issues]);
  const complete = snapshot && snapshot.userId === me ? snapshot.tasks : [];
  const tasks = mergeTaskSnapshot(complete, issues, removedIds).filter((i) => !!me && assignedTo(i, me));
  const stats = taskStats(tasks, dateToday());
  const ready = !!me && !!snapshot && snapshot.userId === me;
  const donePercent = ready && stats.total ? Math.round(stats.completed * 100 / stats.total) : 0;
  const tiles = [[taskText('Pendientes', 'Pending'), stats.pending], [taskText('Importantes', 'Important'), stats.important], [taskText('Completadas', 'Completed'), stats.completed], [taskText('Vencidas', 'Overdue'), stats.overdue]];
  return <div className="task-today card">
    <div className="task-progress-chart" style={{ background: `conic-gradient(var(--accent, #159484) ${donePercent}%, var(--line, #dce7e3) 0)` }} role="img" aria-label={ready ? `${stats.completed} ${taskText('completadas de', 'completed of')} ${stats.total}` : taskText('Calculando estadísticas', 'Calculating statistics')}><span><b>{ready ? `${donePercent}%` : '…'}</b><small>{ready ? taskText('completado', 'completed') : taskText('calculando', 'calculating')}</small></span></div>
    <div className="task-stat-grid">{tiles.map(([label, n]) => <div className="task-stat" key={label}><b>{ready ? n : '—'}</b><span>{label}</span></div>)}</div>
    <div className="task-stat-note muted small">{ready && <>{stats.today} {taskText('para hoy', 'due today')} · {stats.inProgress} {taskText('en curso', 'in progress')} · {stats.waiting} {taskText('esperando', 'waiting')}<br />{taskText('Importantes: vencidas o sin cambios de estado durante 2 días.', 'Important: overdue or unchanged status for 2 days.')}</>}{statsError && <div role="alert" className="error">{taskText('No fue posible actualizar las estadísticas.', 'Could not refresh statistics.')} <button className="link-btn" onClick={() => setRefresh((n) => n + 1)}>{taskText('Reintentar', 'Retry')}</button></div>}</div>
  </div>;
}
function saveText(value: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function TaskReportButton() {
  const [tasks, setTasks] = useState<IssueDTO[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function open() {
    setBusy(true); setError(null);
    try { setTasks(await client.issueReport()); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return <><button className="btn small" disabled={busy} onClick={() => void open()}>⤓ {busy ? taskText('Preparando…', 'Preparing…') : taskText('Reporte', 'Report')}</button>{error && <span role="alert" className="error small">{error}</span>}{tasks && <TaskReportDialog tasks={tasks} onClose={() => setTasks(null)} />}</>;
}
function TaskReportDialog({ tasks, onClose }: { tasks: IssueDTO[]; onClose: () => void }) {
  const d = useClient((s) => s.data)!;
  const [scope, setScope] = useState<'mine' | 'team'>('mine');
  const [title, setTitle] = useState(taskText('Informe de tareas', 'Task report'));
  const [error, setError] = useState<string | null>(null);
  const generatedAt = useMemo(() => new Date().toLocaleString(locale()), []);
  const report = buildTaskReport(tasks, { title, scope: scope === 'mine' ? `${taskText('Responsable', 'Responsible')}: ${d.me.name}` : taskText('Todas las tareas asignadas que puedo ver', 'All assigned tasks visible to me'), generatedAt, today: dateToday(), lang: getLang(), userId: scope === 'mine' ? d.me.id : undefined,
    personName: (id) => personById(d, id)?.name ?? taskText('Participante', 'Participant'), conversationName: (id) => { const c = d.conversations.find((x) => x.id === id); return !id ? taskText('Personal', 'Personal') : c ? conversationTitle(d, c) : taskText('Compartida conmigo', 'Shared with me'); },
  });
  const baseName = `chaggu-tareas-${dateToday()}`;
  function print() {
    const w = window.open('', '_blank');
    if (!w) { setError(taskText('Permite abrir la ventana del reporte para imprimir o guardar como PDF.', 'Allow the report window to open to print or save as PDF.')); return; }
    w.opener = null; w.document.open(); w.document.write(taskReportHtml(report)); w.document.close(); w.focus();
  }
  return <Modal title={taskText('Exportar reporte', 'Export report')} onClose={onClose}>
    <div className="task-report-options">
      <label className="field"><span>{taskText('Título del informe', 'Report title')}</span><input className="input" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="field"><span>{taskText('Tareas asignadas', 'Assigned tasks')}</span><select className="input" value={scope} onChange={(e) => setScope(e.target.value as 'mine' | 'team')}><option value="mine">{taskText('Mis tareas', 'My tasks')}</option><option value="team">{taskText('Todas las que puedo ver', 'All visible to me')}</option></select></label>
      <div className="task-report-preview"><b className="task-report-brand">chaggu</b><h2>{title}</h2><p>{report.scope}</p><div className="task-stat-grid">{[[taskText('Asignadas', 'Assigned'), report.stats.total], [taskText('Pendientes', 'Pending'), report.stats.pending], [taskText('Completadas', 'Completed'), report.stats.completed], [taskText('Vencidas', 'Overdue'), report.stats.overdue]].map(([label, n]) => <div key={label} className="task-stat"><b>{n}</b><span>{label}</span></div>)}</div><small>{generatedAt}</small></div>
      <p className="hint">{taskText('Incluye tareas y subtareas abiertas, completadas y canceladas. Todos los responsables aparecen en el mismo modelo de informe para el equipo.', 'Includes open, completed and cancelled tasks and subtasks. All responsible people appear in the same team report template.')}</p>
      {error && <div role="alert" className="error">{error}</div>}
      <div className="modal-actions"><button className="btn" onClick={() => saveText(taskReportCsv(report), `${baseName}.csv`, 'text/csv;charset=utf-8')}>CSV</button><button className="btn primary" onClick={print}>{taskText('Imprimir / PDF', 'Print / PDF')}</button></div>
    </div>
  </Modal>;
}
