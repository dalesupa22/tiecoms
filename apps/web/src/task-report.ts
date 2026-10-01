import type { IssueDTO, IssueStatus } from '@tiecoms/contracts';

export function taskAssignees(i: Pick<IssueDTO, 'ownerId' | 'assigneeIds'>): string[] {
  return i.assigneeIds ?? (i.ownerId ? [i.ownerId] : []);
}
export function assignedTo(i: Pick<IssueDTO, 'ownerId' | 'assigneeIds'>, userId: string) {
  return taskAssignees(i).includes(userId);
}
/** Informe completo como base; el caché en vivo actualiza cambios y elimina accesos revocados. */
export function mergeTaskSnapshot(complete: IssueDTO[], live: Record<string, IssueDTO>, removedIds: Set<string>): IssueDTO[] {
  const merged = new Map(complete.map((i) => [i.id, i]));
  for (const i of Object.values(live)) { const previous = merged.get(i.id); if (!previous || i.updatedAt >= previous.updatedAt) merged.set(i.id, i); }
  for (const id of removedIds) merged.delete(id);
  return [...merged.values()];
}
export function taskStats(tasks: IssueDTO[], today: string) {
  const active = tasks.filter((i) => i.status !== 'done' && i.status !== 'cancelled');
  return { total: tasks.length, pending: active.length, completed: tasks.filter((i) => i.status === 'done').length,
    overdue: active.filter((i) => !!i.dueDate && i.dueDate < today).length,
    today: active.filter((i) => i.dueDate === today).length,
    inProgress: active.filter((i) => i.status === 'in_progress').length,
    waiting: active.filter((i) => i.status === 'waiting').length,
    important: active.filter((i) => (!!i.dueDate && i.dueDate < today) || Math.floor((Date.parse(`${today}T12:00:00`) - Date.parse(i.statusSince)) / 86_400_000) >= 2).length,
  };
}
export type ReportRow = { id: string; title: string; status: IssueStatus; responsible: string; conversation: string; dueDate: string; completedAt: string; updatedAt: string; parent: string; attachments: number };
export type TaskReport = { title: string; scope: string; generatedAt: string; lang: 'es' | 'en'; rows: ReportRow[]; stats: ReturnType<typeof taskStats> };
export function buildTaskReport(tasks: IssueDTO[], options: {
  title: string; scope: string; generatedAt: string; today: string; lang: 'es' | 'en';
  userId?: string; personName: (id: string) => string; conversationName: (id: string | null) => string;
}): TaskReport {
  const assigned = tasks.filter((i) => taskAssignees(i).length && (!options.userId || assignedTo(i, options.userId)));
  const parents = new Map(tasks.map((i) => [i.id, i.title]));
  return { title: options.title, scope: options.scope, generatedAt: options.generatedAt, lang: options.lang, stats: taskStats(assigned, options.today), rows: assigned.map((i) => ({
    id: i.id, title: i.title, status: i.status, responsible: taskAssignees(i).map(options.personName).join(', '),
    conversation: options.conversationName(i.conversationId), dueDate: i.dueDate ?? '', completedAt: i.closedAt ?? '',
    updatedAt: i.updatedAt, parent: i.parentIssueId ? parents.get(i.parentIssueId) ?? '' : '', attachments: i.attachments?.length ?? 0,
  })) };
}
export const reportStatus = (s: IssueStatus, lang: 'es' | 'en') => ({ open: ['Pendiente', 'Open'], in_progress: ['En curso', 'In progress'], waiting: ['Esperando', 'Waiting'], done: ['Completada', 'Completed'], cancelled: ['Cancelada', 'Cancelled'] }[s][lang === 'en' ? 1 : 0]);
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
/** Neutraliza fórmulas de hojas de cálculo además de escapar comillas, delimitadores y saltos. */
export const csvCell = (s: unknown) => `"${(/^[\s]*[=+\-@]/.test(String(s)) ? `'${s}` : String(s)).replace(/"/g, '""')}"`;
export function taskReportCsv(report: TaskReport) {
  const en = report.lang === 'en';
  const headers = en ? ['Task', 'Status', 'Responsible', 'Chat', 'Due date', 'Completed at', 'Updated at', 'Parent task', 'Attachments', 'Task ID'] : ['Tarea', 'Estado', 'Responsables', 'Chat', 'Fecha límite', 'Completada el', 'Actualizada el', 'Tarea principal', 'Adjuntos', 'ID de tarea'];
  return '\ufeff' + [headers, ...report.rows.map((r) => [r.title, reportStatus(r.status, report.lang), r.responsible, r.conversation, r.dueDate, r.completedAt, r.updatedAt, r.parent, r.attachments, r.id])].map((r) => r.map(csvCell).join(',')).join('\r\n');
}
/** Plantilla común lista para imprimir o guardar como PDF; todos los textos de usuarios se escapan. */
export function taskReportHtml(report: TaskReport) {
  const en = report.lang === 'en';
  const columns = en ? ['Task / parent', 'Responsible', 'Chat', 'Status', 'Due date'] : ['Tarea / principal', 'Responsables', 'Chat', 'Estado', 'Fecha límite'];
  const metrics = [[en ? 'Assigned' : 'Asignadas', report.stats.total], [en ? 'Pending' : 'Pendientes', report.stats.pending], [en ? 'Completed' : 'Completadas', report.stats.completed], [en ? 'Overdue' : 'Vencidas', report.stats.overdue]];
  return `<!doctype html><html lang="${report.lang}"><head><meta charset="utf-8"><title>${esc(report.title)}</title><style>
    @page{size:A4 landscape;margin:15mm}*{box-sizing:border-box}body{font:12px/1.5 system-ui,sans-serif;color:#203236;margin:0;background:white}.brand{font-weight:900;font-size:24px;color:#117568}header{display:flex;justify-content:space-between;gap:24px;border-bottom:3px solid #117568;padding-bottom:18px}h1{font-size:26px;margin:4px 0}p{margin:2px 0;color:#52686e}.metrics{display:flex;gap:12px;margin:22px 0}.metric{border:1px solid #cddfdc;border-radius:8px;flex:1;padding:12px}.metric strong{display:block;font-size:25px;color:#117568}table{width:100%;border-collapse:collapse}thead{display:table-header-group}th{text-align:left;background:#eef5f3;padding:9px;border-bottom:2px solid #b5cbc5}td{padding:10px 9px;border-bottom:1px solid #dce7e3;vertical-align:top;overflow-wrap:anywhere}tr{break-inside:avoid}td:first-child{width:35%}.sub{font-size:10px;color:#687b80}.status{font-weight:600}.empty{padding:40px;text-align:center}footer{margin-top:18px;border-top:1px solid #dce7e3;padding-top:8px;color:#52686e;font-size:10px}.print-actions{margin:20px 0}button{padding:10px 18px;border:0;border-radius:8px;background:#117568;color:white;font:inherit;cursor:pointer}@media print{.print-actions{display:none}}
  </style></head><body><header><div><div class="brand">chaggu</div><h1>${esc(report.title)}</h1><p>${esc(report.scope)}</p></div><div><p>${en ? 'Generated' : 'Generado'}: ${esc(report.generatedAt)}</p><p>${en ? 'Task activity report' : 'Informe de actividad de tareas'}</p></div></header><div class="metrics">${metrics.map(([label, n]) => `<div class="metric"><strong>${n}</strong>${label}</div>`).join('')}</div><table><thead><tr>${columns.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${report.rows.map((r) => `<tr><td><b>${esc(r.title)}</b>${r.parent ? `<div class="sub">↳ ${esc(r.parent)}</div>` : ''}${r.attachments ? `<div class="sub">${r.attachments} ${en ? 'attachments' : 'adjuntos'}</div>` : ''}</td><td>${esc(r.responsible)}</td><td>${esc(r.conversation)}</td><td class="status">${esc(reportStatus(r.status, report.lang))}</td><td>${esc(r.dueDate || '—')}</td></tr>`).join('')}</tbody></table>${!report.rows.length ? `<div class="empty">${en ? 'No assigned tasks in this scope.' : 'No hay tareas asignadas en este alcance.'}</div>` : ''}<footer>Chaggu · ${en ? 'Common team report template. Contains only tasks visible to the person exporting.' : 'Modelo común de informe para el equipo. Incluye solo tareas visibles para quien exporta.'}</footer><div class="print-actions"><button onclick="window.print()">${en ? 'Print / Save as PDF' : 'Imprimir / Guardar como PDF'}</button></div></body></html>`;
}
