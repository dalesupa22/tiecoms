/**
 * Conversaciones de correo fijadas (pedido de Danny, 2-oct-2026). Dos pines independientes, como WhatsApp:
 * «📌 Fijar en la pantalla principal» (bloque arriba en DMs y en Todo) y «📌 Fijar en Correo» (arriba en la bandeja).
 * API: GET/PUT /mail/pins y bootstrap.mailPins (mail-pins.ts). Se fija el hilo (threadId) o el correo si no tiene hilo.
 */
import type { MailListItemDTO, MailPinDTO, MailProvider } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { errorText, t } from '../i18n.ts';
import { menuProps, openMenuAt, toast, type MenuItem } from '../menu.tsx';
import { navigate } from '../router.ts';
import { openInGrid } from '../grid-actions.ts';
import { splitAvailable } from '../split.ts';
import { ProviderIcon } from './Mail.tsx';
import './MailPins.css';

const EMPTY: MailPinDTO[] = [];
/** Lo que se fija de un correo de la lista. */
export type Pinnable = Pick<MailListItemDTO, 'provider' | 'id' | 'threadId' | 'subject' | 'from' | 'date'>;
const keyOf = (m: Pinnable) => m.threadId || m.id;
export const usePins = () => useClient((s) => s.data?.mailPins ?? EMPTY);
export const pinOf = (pins: readonly MailPinDTO[], m: Pinnable) => pins.find((p) => p.provider === m.provider && p.threadKey === keyOf(m)) ?? null;

async function setPin(m: Pinnable, patch: { main?: boolean; mail?: boolean }) {
  try {
    await client.setMailPin({ provider: m.provider, threadKey: keyOf(m), messageId: m.id, subject: (m.subject ?? '').slice(0, 300), from: m.from ? { name: m.from.name ?? null, email: m.from.email } : null, date: m.date ?? null, ...patch });
  } catch (e) { toast(errorText(e)); }
}

/** Las dos opciones, con su estado. Sirve para el menú de la fila y del correo abierto. */
export function mailPinItems(m: Pinnable, pins: readonly MailPinDTO[]): MenuItem[] {
  const p = pinOf(pins, m);
  return [
    { label: p?.mainPinnedAt ? t('mail.unpinMain') : t('mail.pinMain'), icon: '📌', onSelect: () => void setPin(m, { main: !p?.mainPinnedAt }) },
    { label: p?.mailPinnedAt ? t('mail.unpinMail') : t('mail.pinMail'), icon: '📌', onSelect: () => void setPin(m, { mail: !p?.mailPinnedAt }) },
  ];
}

/** Botón 📌 de la fila: abre las dos opciones. Encendido si el correo está fijado en algún lado. */
export function MailPinButton({ m }: { m: Pinnable }) {
  const pins = usePins();
  const p = pinOf(pins, m);
  const on = !!(p?.mainPinnedAt || p?.mailPinnedAt);
  return <button className={`icon-btn mail-pin-btn ${on ? 'is-on' : ''}`} aria-pressed={on} title={t('mail.pinMail')} aria-label={t('mail.pinMail')}
    onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); openMenuAt(r.left, r.bottom + 4, mailPinItems(m, pins)); }}>📌</button>;
}

const asItem = (p: MailPinDTO): MailListItemDTO => ({ provider: p.provider, id: p.messageId, threadId: p.threadKey, from: p.from, to: [], subject: p.subject, snippet: '', date: p.date, unread: false, hasAttachments: false, box: 'inbox' });

/** Abrir un correo fijado desde la pantalla principal: en la cuadrícula si hay sitio; si no, en Correo. */
function openPinned(p: MailPinDTO) {
  if (splitAvailable() && openInGrid({ kind: 'mail', provider: p.provider, id: p.messageId, subject: p.subject, from: p.from?.name || p.from?.email || '' }, null, null)) { navigate('/cuadricula'); return; }
  navigate('/correo');
}

/**
 * Las filas fijadas. where='main': bloque de la pantalla principal (abre el correo). where='mail': sección «Fijados» de
 * la bandeja de un proveedor (onOpen abre ahí mismo).
 */
export function MailPinRows({ where, provider, onOpen }: { where: 'main' | 'mail'; provider?: MailProvider; onOpen?: (provider: MailProvider, item: MailListItemDTO) => void }) {
  const pins = usePins();
  const list = pins.filter((p) => (where === 'main' ? p.mainPinnedAt : p.mailPinnedAt) && (!provider || p.provider === provider));
  if (!list.length) return null;
  return (
    <div className={`mail-pins is-${where}`}>
      <div className="inbox-sep" role="separator">📌 {where === 'main' ? t('mail.pinnedMainTitle') : t('mail.pinnedSection')}</div>
      {list.map((p) => (
        <button key={`${p.provider}|${p.threadKey}`} className="nav-item conv-row mail-pin-row" onClick={() => (onOpen ? onOpen(p.provider, asItem(p)) : openPinned(p))}
          {...menuProps(() => mailPinItems(asItem(p), pins))}>
          <ProviderIcon provider={p.provider} size={18} />
          <span className="grow" style={{ minWidth: 0 }}>
            <b className="ellipsis" style={{ display: 'block' }}>{p.subject || t('mail.noSubject')}</b>
            {p.from && <span className="small muted ellipsis" style={{ display: 'block' }}>{p.from.name || p.from.email}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}
