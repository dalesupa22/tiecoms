/**
 * Paneles de la cuadrícula que no son un chat de chaggu: un correo de tu buzón (con su diseño) y una conversación de
 * WhatsApp (sus mensajes). Del correo se lleva el correo entero a un chat; de WhatsApp, cada mensaje con su asa ⠿.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { MailMessageDTO, MailProvider, WaMessageDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { errorText, locale, t } from '../i18n.ts';
import { openDialog } from '../actions.tsx';
import { Modal } from '../ui.tsx';
import { rememberMeta, useMetas } from '../split.ts';
import { setDrag } from '../grid-actions.ts';
import { MailHtml, MailMeta, ProviderIcon, ShareStep, WaIcon, WaShareDialog, kb, liveHtmlOf, previewOf } from './Mail.tsx';
import { navigate } from '../router.ts';
import { toast } from '../menu.tsx';

export interface PaneFrame { active: boolean; count: number; pinned: boolean; onClose: () => void; onOnly: () => void; onPin: () => void }

/** Cabecera común de un panel: qué es, cómo se llama, fijar, dejar solo este y cerrar. */
function PaneHead({ icon, title, sub, frame }: { icon: ReactNode; title: string; sub?: string; frame: PaneFrame }) {
  return (
    <div className="pane-head">
      <span className="pane-ico" aria-hidden>{icon}</span>
      <div className="pane-title"><b className="ellipsis">{title}</b>{sub && <span className="small muted ellipsis">{sub}</span>}</div>
      <button className={`icon-btn head-keep ${frame.pinned ? 'is-on' : ''}`} aria-pressed={frame.pinned} aria-label={t(frame.pinned ? 'grid.unpin' : 'grid.pin')} title={t(frame.pinned ? 'grid.unpin' : 'grid.pin')} onClick={frame.onPin}>📌</button>
      {frame.count > 1 && <button className="icon-btn head-keep" aria-label={t('split.only')} title={t('split.only')} onClick={frame.onOnly}>⤢</button>}
      <button className="icon-btn head-keep" aria-label={t('split.close')} title={t('split.close')} onClick={frame.onClose}>×</button>
    </div>
  );
}

export function MailPane({ paneKey, provider, id, frame }: { paneKey: string; provider: MailProvider; id: string; frame: PaneFrame }) {
  const metas = useMetas();
  const [m, setM] = useState<MailMessageDTO | null>(null);
  const [html, setHtml] = useState<string | null | undefined>(undefined);
  const [asText, setAsText] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    previewOf(provider, id).then((r) => { if (!live) return; setM(r); rememberMeta(paneKey, { title: r.subject || t('mail.noSubject'), sub: r.from ? r.from.name || r.from.email : undefined }); }).catch((e) => live && setError(errorText(e)));
    liveHtmlOf(provider, id).then((h) => live && setHtml(h)).catch(() => live && setHtml(null));
    return () => { live = false; };
  }, [provider, id]);
  const meta = metas[paneKey];
  const title = m?.subject || meta?.title || t('mail.noSubject');
  const share = () => m && openDialog((close) => (
    <Modal title={t('mail.shareTitle')} onClose={close}><ShareStep provider={provider} item={m} onBack={close} onDone={(cid) => { close(); navigate(`/c/${cid}`); }} /></Modal>
  ));
  return (
    <div className={`pane-typed ${frame.active ? 'is-active' : ''}`}>
      <PaneHead icon={<ProviderIcon provider={provider} size={20} />} title={title} sub={m?.from ? (m.from.name || m.from.email) : meta?.sub} frame={frame} />
      <div className="pane-scroll">
        {error && <div className="error">{error}</div>}
        {!m && !error && <div className="hint">{t('common.loading')}</div>}
        {m && <MailMeta from={m.from} to={m.to} cc={m.cc} date={m.date} provider={provider} />}
        {m && (html && !asText ? <MailHtml html={html} /> : <div className="mail-body" aria-busy={html === undefined}>{m.body || t('mail.noBody')}</div>)}
        {m && html && <button className="link-btn" style={{ alignSelf: 'flex-start' }} onClick={() => setAsText((v) => !v)}>{asText ? t('mail.asDesign') : t('mail.asText')}</button>}
        {!!m?.attachments.length && <div className="att-chips">{m.attachments.map((a) => <span key={a.id} className="file-chip">📎 {a.name} · {kb(a.size)}</span>)}</div>}
        {m && (
          <div className="grid-carry" draggable title={t('grid.carryMailHint')}
            onDragStart={(e) => setDrag(e, 'mail', { provider, id, subject: m.subject, from: m.from ? m.from.name || m.from.email : '' }, m.subject)}>
            <span className="grip" aria-hidden>⠿</span>
            <button className="btn small" onClick={share}>{t('mail.bring')}</button>
            <span className="small muted">{t('grid.carryMailHint')}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function WaPane({ paneKey, accountId, jid, frame }: { paneKey: string; accountId: string; jid: string; frame: PaneFrame }) {
  const metas = useMetas();
  const d = useClient((s) => s.data)!;
  const revision = useClient((s) => s.waRevision);
  const mailOn = d.features?.mail === true;
  const [messages, setMessages] = useState<WaMessageDTO[] | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const isGroup = jid.endsWith('@g.us');
  const meta = metas[paneKey];
  const name = meta?.title ?? jid.split('@')[0]!;
  useEffect(() => {
    let live = true;
    client.request<{ messages: WaMessageDTO[] }>(`/whatsapp/chats/${accountId}/${encodeURIComponent(jid)}/messages?limit=80`)
      .then((r) => live && setMessages(r.messages)).catch((e) => { if (live) { setMessages([]); toast(errorText(e)); } });
    return () => { live = false; };
  }, [accountId, jid, revision]);
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [messages]);
  return (
    <div className={`pane-typed ${frame.active ? 'is-active' : ''}`}>
      <PaneHead icon={<WaIcon size={20} />} title={name} sub={meta?.sub ?? 'WhatsApp'} frame={frame} />
      <div className="wa-msgs pane-wa" ref={box}>
        {messages === null && <div className="hint">{t('common.loading')}</div>}
        {messages?.length === 0 && <div className="hint">{t('wa.noMessages')}</div>}
        {messages?.map((m) => {
          const bring = () => openDialog((close) => <WaShareDialog accountId={accountId} jid={jid} chatName={name} isGroup={isGroup} message={m} onClose={close} />);
          return (
            <div key={m.id} className={`wa-msg ${m.fromMe ? 'me' : ''}`}>
              {!m.fromMe && isGroup && <div className={m.author ? 'wa-author' : 'wa-author unknown'}>{m.author ?? t('wa.someone')}</div>}
              <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.body}</div>
              <div className="wa-time">{new Date(m.sentAt).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
              {mailOn && (
                <span className="wa-grab" draggable title={t('grid.carryMsgHint')} aria-label={t('grid.carryMsgHint')}
                  onDragStart={(e) => {
                    setDrag(e, 'wamsg', { accountId, jid, messageId: m.id, chatName: name, text: m.body }, m.body.slice(0, 80));
                    const row = (e.currentTarget as HTMLElement).closest('.wa-msg'); if (row) e.dataTransfer.setDragImage(row, 12, 12);
                  }}
                  onClick={bring}>⠿</span>
              )}
            </div>
          );
        })}
      </div>
      <div className="pane-foot small muted">{t('grid.waFoot')}</div>
    </div>
  );
}
