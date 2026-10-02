import type { WaChatDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { errorText, t } from '../i18n.ts';
import { toast, type MenuItem } from '../menu.tsx';
import { captureWaPrivacy, guardWaMenu, useWaPrivacy, waMenuProps } from '../wa-privacy-ui.tsx';
import { navigate } from '../router.ts';
import { setDrag } from '../grid-actions.ts';
import { initials, timeLabel } from '../ui.tsx';
import { waKey } from '../home-order.ts';
import { WaIcon } from './Mail.tsx';

/**
 * WhatsApp en la bandeja (docs/WA-BANDEJA-GG-CHAT.md): un chat de WhatsApp «movido a mi lista principal» vive en
 * Grupos o en DMs junto a las conversaciones de chaggu, con el mismo orden (Fijados · Sin leer · Recientes).
 * Es personal: cada cuenta de WhatsApp es de una sola persona.
 */
export const waChatPath = (w: Pick<WaChatDTO, 'accountId' | 'jid'>) => `/whatsapp/${w.accountId}/${encodeURIComponent(w.jid)}`;
const suggested = (w: Pick<WaChatDTO, 'isGroup'>) => (w.isGroup ? 'groups' : 'dms');

async function setInbox(w: Pick<WaChatDTO, 'accountId' | 'jid'>, patch: { inboxPlace?: 'groups' | 'dms' | 'auto' | null; inboxPinned?: boolean }, done?: string) {
  const valid = captureWaPrivacy(w.accountId, w.jid);
  if (!valid()) return null;
  try {
    const up = await client.setWaInbox(w.accountId, w.jid, patch);
    if (!valid()) return null;
    if (done) toast(done);
    return up;
  } catch (e) { if (valid()) toast(errorText(e)); return null; }
}

/** «📌 Fijar en WhatsApp» (arriba en la pantalla WhatsApp): independiente del fijado en la pantalla principal (2-oct-2026). */
async function setWaPinned(w: Pick<WaChatDTO, 'accountId' | 'jid'>, pinned: boolean) {
  const valid = captureWaPrivacy(w.accountId, w.jid);
  if (!valid()) return null;
  try {
    const up = await client.request<WaChatDTO>(`/whatsapp/chats/${w.accountId}/${encodeURIComponent(w.jid)}`, { method: 'PATCH', json: { pinned } });
    return valid() ? up : null;
  } catch (e) { if (valid()) toast(errorText(e)); return null; }
}
const waPinItem = (w: WaChatDTO, onChanged?: (c: WaChatDTO) => void): MenuItem => ({
  label: w.pinned ? t('wa.unpin') : t('wa.pin').replace(/^📌\s*/, ''), icon: '📌', onSelect: () => void setWaPinned(w, !w.pinned).then((up) => { if (up) onChanged?.(up); }),
});

/** Menú de la fila en Grupos/DMs: fijar o quitar, pasar a la otra sección y sacar de la lista principal. */
export function waInboxMenu(w: WaChatDTO): MenuItem[] {
  const pinned = !!w.inboxPinnedAt;
  return guardWaMenu(w, [
    { label: pinned ? t('wa.inboxUnpin') : t('wa.inboxPin'), icon: '📌', onSelect: () => void setInbox(w, { inboxPinned: !pinned }) },
    waPinItem(w),
    w.inboxPlace === 'groups'
      ? { label: t('wa.moveDms'), icon: '✉', onSelect: () => void setInbox(w, { inboxPlace: 'dms' }) }
      : { label: t('wa.moveGroups'), icon: '👥', onSelect: () => void setInbox(w, { inboxPlace: 'groups' }) },
    { divider: true },
    { label: t('wa.openInWa'), icon: '✆', onSelect: () => navigate('/whatsapp') },
    { label: t('wa.removeFromInbox'), icon: '⤺', danger: true, onSelect: () => void setInbox(w, { inboxPlace: null }, t('wa.removedToast')) },
  ]);
}

/**
 * En la pantalla WhatsApp (fila y detalle): «Mover a mi lista principal» con el submenú A Grupos / A DMs (marcada
 * la sugerida) y «📌 Fijar arriba»; si ya está, «Sacar de mi lista principal». onChanged recibe la fila nueva.
 */
export function waMainListMenu(w: WaChatDTO, onChanged?: (c: WaChatDTO) => void): MenuItem[] {
  const run = (patch: Parameters<typeof setInbox>[1], done?: string) => {
    const valid = captureWaPrivacy(w.accountId, w.jid);
    return () => { if (valid()) void setInbox(w, patch, done).then((up) => { if (up && valid()) onChanged?.(up); }); };
  };
  const sug = suggested(w);
  const place = (p: 'groups' | 'dms'): MenuItem => ({
    label: `${p === 'groups' ? t('wa.toGroups') : t('wa.toDms')}${p === sug ? ` · ${t('wa.suggested2')}` : ''}`,
    icon: w.inboxPlace === p ? '✓' : p === sug ? '★' : undefined, onSelect: run({ inboxPlace: p }, t('wa.movedToast')),
  });
  return guardWaMenu(w, [
    { label: t('wa.moveToInbox'), icon: '⤴', items: [place(sug), place(sug === 'groups' ? 'dms' : 'groups')] },
    w.inboxPinnedAt
      ? { label: t('wa.inboxUnpin'), icon: '📌', onSelect: run({ inboxPinned: false }) }
      : { label: t('wa.pinTop'), icon: '📌', onSelect: run({ inboxPinned: true }, t('wa.movedToast')) },
    waPinItem(w, onChanged),
    ...(w.inboxPlace ? [{ label: t('wa.removeFromInbox'), icon: '⤺', danger: true, onSelect: run({ inboxPlace: null }, t('wa.removedToast')) }] : []),
  ]);
}

/** Avatar con el logo verde de WhatsApp pequeño en la esquina inferior derecha. */
export function WaAvatar({ w, size = 32 }: { w: Pick<WaChatDTO, 'name' | 'isGroup'>; size?: number }) {
  return (
    <span className="wa-inbox-av" style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }} aria-hidden>
      {w.isGroup ? '👥' : initials(w.name)}
      <span className="wa-inbox-badge"><WaIcon size={Math.max(12, Math.round(size * 0.45))} /></span>
    </span>
  );
}

/** Fila de WhatsApp en Grupos, DMs y Todo/Hoy. Se abre en /whatsapp/:accountId/:jid y se arrastra a la cuadrícula. */
export function WaRow({ w, active, preview = true }: { w: WaChatDTO; active: boolean; preview?: boolean }) {
  const visible = useWaPrivacy(() => {}, w);
  if (!visible) return null;
  const off = !!w.accountStatus && w.accountStatus !== 'connected';
  const sub = off ? t('wa.disconnected') : `WhatsApp · ${w.accountLabel}`;
  const pin = w.inboxPinnedAt ? <span className="conv-pin" title={t('side.pinned')} aria-label={t('side.pinned')}>📌</span> : null;
  const count = w.unread > 0 ? <span className="pill wa-pill">{w.unread}</span> : null;
  return (
    <button className={`side-conv wa-inbox-row ${preview ? 'has-preview' : ''} ${active ? 'active' : ''} ${w.unread ? 'unread' : ''} ${off ? 'is-off' : ''}`}
      data-wa={waKey(w)} onClick={() => { if (!client.isWaChatVisible(w.accountId, w.jid)) return; client.markWaInboxRead(w.accountId, w.jid); navigate(waChatPath(w)); }}
      draggable onDragStart={(e) => setDrag(e, 'wa', { accountId: w.accountId, jid: w.jid, name: w.name, isGroup: w.isGroup }, w.name)}
      {...waMenuProps(w, () => waInboxMenu(w))}>
      <WaAvatar w={w} size={preview ? 32 : 22} />
      {preview ? (
        <span className="conv-lines">
          <span className="conv-line">
            <span className="grow ellipsis conv-title">{w.name}</span>
            {pin}
            <span className="conv-time">{timeLabel(w.lastMessageAt)}</span>
          </span>
          <span className="conv-org ellipsis">{sub}</span>
          <span className="conv-line">
            <span className="grow ellipsis conv-sub">{off ? '' : w.lastPreview ?? ''}</span>
            {count}
          </span>
        </span>
      ) : <>
        <span className="grow conv-lines">
          <span className="ellipsis">{w.name}</span>
          <span className="conv-org ellipsis">{sub}</span>
        </span>
        {pin}{count}
      </>}
    </button>
  );
}

/** La fila de la bandeja de un chat (si está), para saber qué ofrecer en su menú. */
export function useWaInboxRow(accountId: string, jid: string) {
  return useClient((s) => client.isWaChatVisible(accountId, jid) ? s.data?.waInbox?.find((x) => x.accountId === accountId && x.jid === jid) ?? null : null);
}
