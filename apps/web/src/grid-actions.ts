/**
 * Lo que se hace con lo que se arrastra a la cuadrícula. Dos acciones grandes (Danny, 30-sep-2026):
 *  1) Llevar un correo o un mensaje de WhatsApp a un chat → queda como tarjeta en ese chat.
 *  2) Llevar un correo o una conversación de WhatsApp (o un chat) a un cuadrito → panel fijado en la cuadrícula.
 * Las usan la cuadrícula (Split.tsx), la bandeja (Tray.tsx) y los botones Fijar.
 */
import { client } from './app-client.ts';
import { errorText, t } from './i18n.ts';
import { toast } from './menu.tsx';
import { navigate } from './router.ts';
import { type MailProviderKey, mailKey, waKey } from './grid-keys.ts';
import { DRAG_MAIL, DRAG_TYPE, DRAG_WA, DRAG_WAMSG, type DragKind, MAX_PANES, currentPanes, dragType, openBeside, pinAt, rememberMeta } from './split.ts';

export interface MailDrag { provider: MailProviderKey; id: string; subject: string; from: string }
export interface WaDrag { accountId: string; jid: string; name: string; isGroup: boolean }
export interface WaMsgDrag { accountId: string; jid: string; messageId: string; chatName: string; text: string }
export type DragPayload = { kind: 'chat'; id: string } | ({ kind: 'mail' } & MailDrag) | ({ kind: 'wa' } & WaDrag) | ({ kind: 'wamsg' } & WaMsgDrag);

/** Pone lo que se arrastra en el dataTransfer, con el tipo que dice qué es (así la bandeja lo sabe mientras se arrastra). */
export function setDrag(e: { dataTransfer: DataTransfer | null }, kind: DragKind, payload: object, label: string) {
  const dt = e.dataTransfer; if (!dt) return;
  dt.setData(dragType(kind), kind === 'chat' ? (payload as { id: string }).id : JSON.stringify(payload));
  dt.setData('text/plain', label);
  dt.effectAllowed = 'copyMove';
}
export function readDrag(dt: DataTransfer, kind: DragKind): DragPayload | null {
  const raw = dt.getData(dragType(kind));
  if (!raw) return null;
  if (kind === 'chat') return { kind, id: raw };
  try { return { kind, ...JSON.parse(raw) } as DragPayload; } catch { return null; }
}

/** La clave y el nombre del panel que sería esto en la cuadrícula (los mensajes sueltos no son un panel). */
export function paneOf(p: DragPayload): { key: string; title: string; sub?: string } | null {
  if (p.kind === 'chat') return { key: p.id, title: '' };
  if (p.kind === 'mail') return { key: mailKey(p.provider, p.id), title: p.subject || t('mail.noSubject'), sub: p.from };
  if (p.kind === 'wa') return { key: waKey(p.accountId, p.jid), title: p.name, sub: 'WhatsApp' };
  return null;
}

/** Acción 1: a un chat. Correo o mensaje de WhatsApp como tarjeta en ese chat. */
export async function shareToChat(p: DragPayload, conversationId: string, chatName: string): Promise<boolean> {
  try {
    if (p.kind === 'mail') await client.shareMail({ provider: p.provider, messageId: p.id, conversationIds: [conversationId] });
    else if (p.kind === 'wamsg') await client.shareWhatsApp({ accountId: p.accountId, jid: p.jid, messageId: p.messageId, conversationIds: [conversationId] });
    else return false;
    toast(t('grid.sharedTo', { name: chatName }), { label: t('lin.open'), run: () => navigate(`/c/${conversationId}`) });
    return true;
  } catch (e) { toast(errorText(e)); return false; }
}

/** Acción 2 desde la cuadrícula a la vista: abre al lado (o reemplaza el panel donde se soltó). */
export function openInGrid(p: DragPayload, active: string | null, replace: string | null): boolean {
  const pane = paneOf(p); if (!pane) return false;
  if (p.kind !== 'chat') rememberMeta(pane.key, { title: pane.title, sub: pane.sub });
  const r = openBeside(pane.key, active, replace);
  if (r === 'blocked') toast(t('grid.allPinned'));
  return r !== 'blocked';
}

/** Acción 2 desde la bandeja o el botón Fijar: queda fijado en el cuadrito elegido. Devuelve el lugar (0–3) o -1. */
export function pinToSlot(p: DragPayload, index: number, chatTitle?: string): number {
  const pane = paneOf(p); if (!pane) return -1;
  const at = pinAt(pane.key, index, p.kind === 'chat' ? undefined : { title: pane.title, sub: pane.sub });
  if (at < 0) { toast(currentPanes().length >= MAX_PANES ? t('grid.slotPinned') : t('grid.allPinned')); return -1; }
  const name = p.kind === 'chat' ? chatTitle ?? '' : pane.title;
  toast(t('grid.pinnedAt', { name, n: at + 1 }), { label: t('grid.see'), run: () => navigate('/cuadricula') });
  return at;
}
