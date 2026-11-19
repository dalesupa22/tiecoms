/** CH038: cuándo suena el tono de «llamando» (sin dependencias de la app, para probarlo solo). */
import type { CallDTO } from '@tiecoms/contracts';
import type { CallView } from './call.ts';

/** Lo mismo que suena del otro lado (Calls: 45 s). */
export const RINGBACK_MAX_MS = 45_000;

const others = (c: CallDTO, meId: string) => [...c.activeUserIds, ...(c.guests ?? []).map((g) => `guest:${g.id}`)].filter((id) => id !== meId);

/** ¿Suena el tono de llamando? Solo para quien empezó la llamada (no salas ni invitados) y mientras nadie más entra. */
export function shouldRingback(v: CallView | null, meId: string | null | undefined, now: number): boolean {
  if (!v || !meId || v.guest || v.phase === 'ended' || v.error) return false;
  const c = v.call;
  if (c.startedBy !== meId || c.roomId) return false;
  if (others(c, meId).length > 0) return false;
  const started = Date.parse(c.startedAt);
  return !Number.isFinite(started) || now - started < RINGBACK_MAX_MS;
}
