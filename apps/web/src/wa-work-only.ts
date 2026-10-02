/**
 * «💼 Solo trabajo» (pedido de Danny, 2-oct-2026): esconde el ruido de WhatsApp (familia, amigos, comunidad, otros).
 * Se ven los chats de Trabajo y Clientes, y los que la persona fijó (en WhatsApp o en la pantalla principal).
 * Es una preferencia de este navegador; la pantalla WhatsApp, el panel y las filas de Grupos/DMs la respetan.
 */
import { useSyncExternalStore } from 'react';
import type { WaCategory, WaChatDTO } from '@tiecoms/contracts';

const KEY = 'chaggu:wa-work-only';
export const WORK_CATEGORIES: readonly WaCategory[] = ['trabajo', 'clientes'];
let on = (() => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } })();
const listeners = new Set<() => void>();
export const useWorkOnly = () => useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => on);
export function setWorkOnly(v: boolean) {
  on = v; try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* sin almacenamiento */ }
  listeners.forEach((l) => l());
}
/** ¿Se ve este chat con «Solo trabajo» activo? */
export const isWorkChat = (c: Pick<WaChatDTO, 'category' | 'pinned' | 'inboxPinnedAt'>) => WORK_CATEGORIES.includes(c.category) || c.pinned || !!c.inboxPinnedAt;
export const workFilter = <T extends Pick<WaChatDTO, 'category' | 'pinned' | 'inboxPinnedAt'>>(list: readonly T[], active: boolean) => (active ? list.filter(isWorkChat) : [...list]);
