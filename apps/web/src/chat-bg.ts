/**
 * Fondo de cada chat (docs/PANELES.md · «Fondos»): 8 tonos suaves y 4 patrones discretos, con contraste AA en claro
 * y oscuro (test/theme.test.ts). Con 2 o más paneles, cada chat sin fondo elegido recibe uno automático y estable
 * (derivado de su id) para distinguirlos sin configurar nada; con 1 panel se ve el fondo normal salvo que lo elijas.
 *
 * Se guarda por usuario y por chat en localStorage (`chaggu:chat-bg:v1` → { [userId]: { [conversationId]: bgId } },
 * con bgId = uno de CHAT_BGS o 'none'). Cuando haya API: PUT /me/chat-backgrounds con el mismo mapa.
 */
import { useSyncExternalStore } from 'react';
import { client } from './app-client.ts';

import type { ChatBg } from './chat-bg-core.ts';
export * from './chat-bg-core.ts';

// ---------- Guardado (por usuario y chat) ----------
const KEY = 'chaggu:chat-bg:v1';
type Map_ = Record<string, Record<string, string>>;
let all: Map_ = (() => { try { const v = JSON.parse(localStorage.getItem(KEY) ?? '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } })();
const ls = new Set<() => void>();
const EMPTY: Record<string, string> = {};
/** Los fondos son de cada persona: se leen con el id de quien tiene la sesión. */
const who = () => client.getState().data?.me.id ?? '';
const mine = () => all[who()] ?? EMPTY;
export const useChatBgs = () => useSyncExternalStore((l) => { ls.add(l); return () => { ls.delete(l); }; }, mine);
export const chatBgChoice = (id: string) => mine()[id];
export function setChatBg(id: string, bg: string | null) {
  const cur = { ...mine() };
  if (bg === null) delete cur[id]; else cur[id] = bg;
  all = { ...all, [who()]: cur };
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* sin almacenamiento */ }
  ls.forEach((l) => l());
}
/** Clases y variables para pintar el fondo (en .conv y en el panel). */
export function bgClass(bg: ChatBg | null) { return bg ? `has-bg bg-t${bg.tone}${bg.pattern ? ` bg-${bg.pattern}` : ''}` : ''; }
