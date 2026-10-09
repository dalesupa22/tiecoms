/**
 * Un solo estado para leer una tarea (pedido de Danny 8-oct) con nombres claros (9-oct): junta status + revisión +
 * responsables + reserva y dice quién tiene la tarea y qué falta. Lo comparten la web y el MCP para que las personas
 * y los agentes lean lo mismo. No cambia datos.
 */
import type { IssueDTO } from './index.ts';

export type TaskState = 'waiting' | 'assigned' | 'processing' | 'blocked' | 'returned' | 'deploying' | 'review' | 'human' | 'done' | 'cancelled';
export const TASK_STATES: TaskState[] = ['waiting', 'assigned', 'processing', 'blocked', 'returned', 'deploying', 'review', 'human', 'done', 'cancelled'];

type StateIssue = Pick<IssueDTO, 'status' | 'review' | 'claimedBy' | 'assigneeIds' | 'ownerId' | 'reviewBy' | 'reviewRequestedBy'>;
const assigneesOf = (i: Pick<IssueDTO, 'assigneeIds' | 'ownerId'>) => i.assigneeIds ?? (i.ownerId ? [i.ownerId] : []);

export function taskState(i: StateIssue): TaskState {
  if (i.status === 'cancelled') return 'cancelled';
  if (i.status === 'done' || i.review === 'approved') return 'done';
  if (i.review === 'pending') return 'review';
  if (i.review === 'human') return 'human';
  // Aprobada para desplegar: se sigue viendo así mientras la IA despliega (no «Procesando»).
  if (i.review === 'deploy') return 'deploying';
  // Mientras alguien la tiene tomada se ve «Procesando», también si venía devuelta.
  if (i.claimedBy) return 'processing';
  if (i.review === 'changes') return 'returned';
  if (i.status === 'waiting') return 'blocked';
  if (i.status === 'in_progress') return 'processing';
  return assigneesOf(i).length ? 'assigned' : 'waiting';
}

/** Quién es cada persona de la tarea (agente IA o persona) y su nombre corto para el estado. */
export type TaskPersonLookup = (userId: string) => { kind: string; name: string } | null | undefined;

/**
 * Nombre claro del estado: dice si la tiene la IA («La IA está trabajando», «Corrección pedida a la IA») y quién revisa
 * («Revisión de Lorena»). Sin `i`/`who`, el nombre genérico (filtros).
 */
export function taskStateLabel(s: TaskState, lang: 'es' | 'en', i?: StateIssue, who?: TaskPersonLookup): string {
  const L = (es: string, en: string) => (lang === 'en' ? en : es);
  const people = i && who ? assigneesOf(i).map((u) => who(u)).filter((p): p is { kind: string; name: string } => !!p) : [];
  const ai = people.some((p) => p.kind === 'agent');
  const isAgent = (u: string | null | undefined) => !!(u && who?.(u)?.kind === 'agent');
  const solvedByAi = isAgent(i?.reviewRequestedBy) || (s === 'human' && isAgent(i?.reviewBy));
  if (s === 'deploying') return i?.claimedBy && ai ? L('La IA está desplegando', 'The AI is deploying') : ai ? L('Aprobada · la IA despliega', 'Approved · the AI deploys') : L('Aprobada · por desplegar', 'Approved · to deploy');
  if (s === 'processing' && i?.claimedBy) return ai ? L('La IA está trabajando', 'The AI is working') : L('Procesando', 'Processing');
  if (s === 'processing' && ai) return L('La IA está trabajando', 'The AI is working');
  if (s === 'assigned' && ai) return L('Asignada a la IA · por empezar', 'Given to the AI · not started');
  if (s === 'blocked' && ai) return L('La IA pregunta · falta respuesta', 'The AI asks · needs an answer');
  if (s === 'returned' && (ai || solvedByAi)) return L('Corrección pedida a la IA', 'Fix requested from the AI');
  if (s === 'review' && people.length && !ai) return `${L('Revisión de', 'Review by')} ${people.map((p) => p.name.split(' ')[0]).join(', ')}`;
  if (s === 'human' && solvedByAi) return L('La IA no pudo · la toma una persona', 'The AI couldn’t · a person takes it');
  return ({
    waiting: L('Sin asignar · decide una persona', 'Unassigned · a person decides'), assigned: L('Asignada · por empezar', 'Assigned · not started'), processing: L('En proceso', 'In progress'),
    blocked: L('Esperando respuesta', 'Waiting for reply'), returned: L('Corrección pedida', 'Fix requested'), review: L('Por revisar', 'To review'),
    deploying: L('Aprobada · por desplegar', 'Approved · to deploy'), human: L('Necesita una persona', 'Needs a person'), done: L('Completada', 'Completed'), cancelled: L('Descartada', 'Dropped'),
  } as Record<TaskState, string>)[s];
}
