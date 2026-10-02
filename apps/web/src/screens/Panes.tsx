import { PaneSizeControl } from './PaneSizeControl.tsx';
import { waAccounts } from '../wa-requests.ts';
import { sortWaChats } from '../wa-chat-order.ts';
import { AttachmentsView } from './Attachments.tsx';
import { RichText } from './RichText.tsx';
/**
 * Paneles de la cuadrícula que no son un chat de chaggu:
 *  · un correo de tu buzón (con su diseño) y una conversación de WhatsApp (sus mensajes), los dos con respuesta directa;
 *  · secciones enteras: la lista de Tareas, la Bandeja de correo y Todas las conversaciones de WhatsApp (se abre una adentro).
 * Del correo se lleva el correo entero a un chat; de WhatsApp, cada mensaje con su asa ⠿.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { MailListItemDTO, MailMessageDTO, MailProvider, WaAccountDTO, WaChatDTO, WaMessageDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { errorText, locale, t } from '../i18n.ts';
import { openDialog } from '../actions.tsx';
import { Modal } from '../ui.tsx';
import { collapsePane, rememberMeta, useActiveKey, useMetas, useWide } from '../split.ts';
import { openInGrid, setDrag } from '../grid-actions.ts';
import { ConnectCards, MailBrowser, MailHtml, MailMeta, ProviderIcon, ShareStep, WaIcon, WaShareDialog, kb, liveHtmlOf, previewOf, useMailConnections } from './Mail.tsx';
import { setWaSend } from './WhatsApp.tsx';
import { IssuesBody, NewIssueDialog } from './Issues.tsx';
import { GgButton, GgSidePanel, ReplyForMe, SelectionBar, SuggestDialog, waSource, type GgHost, type Quote } from './GgSide.tsx';
import { WaAvatar, waInboxMenu, waMainListMenu, useWaInboxRow } from './WaInbox.tsx';
import { ReminderDialog } from '../actions.tsx';
import { isSelfChat } from '../ui.tsx';
import { BASE, navigate } from '../router.ts';
import { copyText, toast } from '../menu.tsx';
import { AgendaScreen } from './Calendar.tsx';
import { TrazoScreen } from './Lineage.tsx';
import { CallsScreen } from './Call.tsx';
import { captureWaPrivacy, openWaDialog, openWaMenuAt, showWaDialogUntilClosed, useWaPrivacy, waMenuProps, waPrivacySyncing, waPrivacyUnavailable } from '../wa-privacy-ui.tsx';
import { waPrivacyAffected } from '../wa-privacy.ts';
import './FileLinks.css';
import { isWorkChat, setWorkOnly, useWorkOnly } from '../wa-work-only.ts';
import { createFileLink, fileLinkDate, fileLinkText, isFileDrag, readFileDrag, revokeFileLink, type FileLink } from '../file-links.ts';

export function SectionPane({ kind, frame }: { kind: 'agenda' | 'trazo' | 'calls'; frame: PaneFrame }) {
  const label = kind === 'agenda' ? t('nav.agenda') : kind === 'trazo' ? t('nav.trazo') : t('nav.calls');
  return <div className="section-pane"><PaneHead icon={kind === 'agenda' ? '▦' : kind === 'trazo' ? '⑂' : '☎'} title={label} frame={frame} />
    <div className="section-pane-body">{kind === 'agenda' ? <AgendaScreen /> : kind === 'trazo' ? <TrazoScreen /> : <CallsScreen />}</div></div>;
}

export interface PaneFrame { size?: import('./PaneSizeControl.tsx').PaneSizing; visible?: boolean; presentation?: 'sidebar'; expanded?: boolean; active: boolean; count: number; pinned: boolean; onClose: () => void; onOnly: () => void; onPin: () => void; onTint: (anchor: HTMLElement) => void; onCollapse?: () => void }

/** Cabecera común de un panel: qué es, cómo se llama, fijar, dejar solo este y cerrar. */
function PaneHead({ icon, title, sub, frame, extra }: { icon: ReactNode; title: string; sub?: string; frame: PaneFrame; extra?: ReactNode }) {
  return (
    <div className="pane-head">
      <span className="pane-ico" aria-hidden>{icon}</span>
      <div className="pane-title"><b className="ellipsis">{title}</b>{sub && <span className="small muted ellipsis">{sub}</span>}</div>
      <div className="pane-head-actions">
      {extra}
      <PaneSizeControl size={frame.size} />
      {frame.presentation !== 'sidebar' && <button className="icon-btn head-keep" aria-label={t('tint.title')} title={t('tint.title')} onClick={(e) => frame.onTint(e.currentTarget)}>🎨</button>}
      {frame.presentation !== 'sidebar' && <button className={`icon-btn head-keep pane-pin-control ${frame.pinned ? 'is-on' : ''}`} aria-pressed={frame.pinned} aria-label={t(frame.pinned ? 'grid.unpin' : 'grid.pin')} title={t(frame.pinned ? 'grid.unpin' : 'grid.pin')} onClick={frame.onPin}><span aria-hidden>📌</span>{frame.pinned && <span className="pane-pin-label">{locale().startsWith('en') ? 'Pinned' : 'Fijado'}</span>}</button>}
      {frame.presentation === 'sidebar' && <button className="btn small" onClick={frame.onOnly}>{frame.expanded ? (locale().startsWith('en') ? '↙ Side panel' : '↙ Vista lateral') : (locale().startsWith('en') ? '⤢ Expand' : '⤢ Expandir')}</button>}
      {frame.presentation !== 'sidebar' && frame.onCollapse && <button className="icon-btn head-keep pane-collapse-control" aria-label={t('split.collapse')} title={t('split.collapse')} onClick={frame.onCollapse}>▁</button>}
      {frame.presentation !== 'sidebar' && frame.count > 1 && <button className="icon-btn head-keep" aria-label={t('split.only')} title={t('split.only')} onClick={frame.onOnly}>⤢</button>}
      <button className="icon-btn head-keep" aria-label={t('split.close')} title={t('split.close')} onClick={frame.onClose}>×</button>
      </div>
    </div>
  );
}

// ---------- Responder un correo, directo ----------
function MailReply({ provider, id, m }: { provider: MailProvider; id: string; m: MailMessageDTO }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const other = m.box === 'sent' ? m.to : m.from ? [m.from] : [];
  const names = other.map((a) => a.name || a.email).join(', ');
  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try { await client.replyLiveMail(provider, id, { body }); toast(t('grid.replySent')); setText(''); setOpen(false); }
    catch (e) { toast(errorText(e)); } finally { setBusy(false); }
  };
  if (!open) return <button className="btn small primary" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(true)}>{t('grid.replyOpen')}</button>;
  return (
    <div className="reply-box">
      {names && <div className="small muted">{t('grid.replyTo', { to: names })}</div>}
      <textarea className="input" autoFocus rows={5} maxLength={20000} placeholder={t('grid.replyPh')} value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void send(); }} />
      <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn small ghost" onClick={() => { setOpen(false); setText(''); }}>{t('common.cancel')}</button>
        <button className="btn small primary" disabled={!text.trim() || busy} onClick={() => void send()}>{busy ? t('grid.replySending') : t('grid.replySend')}</button>
      </div>
    </div>
  );
}

/** Un correo completo con su diseño, para llevarlo a un chat o responderlo. Lo usan el panel de correo y la bandeja. */
function MailView({ paneKey, provider, id, preserveWorkspace }: { preserveWorkspace?: boolean; paneKey?: string; provider: MailProvider; id: string }) {
  const [m, setM] = useState<MailMessageDTO | null>(null);
  const [html, setHtml] = useState<string | null | undefined>(undefined);
  const [asText, setAsText] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setM(null); setHtml(undefined); setError(null); setAsText(false);
    previewOf(provider, id).then((r) => { if (!live) return; setM(r); if (paneKey) rememberMeta(paneKey, { title: r.subject || t('mail.noSubject'), sub: r.from ? r.from.name || r.from.email : undefined }); }).catch((e) => live && setError(errorText(e)));
    liveHtmlOf(provider, id).then((h) => live && setHtml(h)).catch(() => live && setHtml(null));
    return () => { live = false; };
  }, [provider, id]);
  const share = () => m && openDialog((close) => (
    <Modal title={t('mail.shareTitle')} onClose={close}><ShareStep provider={provider} item={m} onBack={close} onDone={(cid) => { close(); if (!preserveWorkspace) navigate(`/c/${cid}`); }} /></Modal>
  ));
  return (
    <div className="mail-reader">
      {error && <div className="error">{error}</div>}
      {!m && !error && <div className="hint">{t('common.loading')}</div>}
      {m && <h4 className="pane-subject">{m.subject || t('mail.noSubject')}</h4>}
      {m && <MailMeta from={m.from} to={m.to} cc={m.cc} date={m.date} provider={provider} />}
      {m && (html && !asText ? <MailHtml html={html} /> : <div className="mail-body" aria-busy={html === undefined}>{m.body || t('mail.noBody')}</div>)}
      {m && html && <button className="link-btn" style={{ alignSelf: 'flex-start' }} onClick={() => setAsText((v) => !v)}>{asText ? t('mail.asDesign') : t('mail.asText')}</button>}
      {!!m?.attachments.length && <div className="att-chips">{m.attachments.map((a) => <span key={a.id} className="file-chip">📎 {a.name} · {kb(a.size)}</span>)}</div>}
      {m && <MailReply provider={provider} id={id} m={m} />}
      {m && (
        <div className="grid-carry" draggable title={t('grid.carryMailHint')}
          onDragStart={(e) => setDrag(e, 'mail', { provider, id, subject: m.subject, from: m.from ? m.from.name || m.from.email : '' }, m.subject)}>
          <span className="grip" aria-hidden>⠿</span>
          <button className="btn small" onClick={share}>{t('mail.bring')}</button>
          <span className="small muted">{t('grid.carryMailHint')}</span>
        </div>
      )}
    </div>
  );
}

export function MailPane({ paneKey, provider, id, frame }: { paneKey: string; provider: MailProvider; id: string; frame: PaneFrame }) {
  const meta = useMetas()[paneKey];
  return (
    <div className={`pane-typed ${frame.active ? 'is-active' : ''}`}>
      <PaneHead icon={<ProviderIcon provider={provider} size={20} />} title={meta?.title ?? t('mail.title')} sub={meta?.sub} frame={frame} />
      <div className="pane-scroll"><MailView paneKey={paneKey} provider={provider} id={id} /></div>
    </div>
  );
}

/** In the grid, read in this cell. The desktop sidebar keeps its inbox and opens a reader to the right. */
export function InboxPane({ frame }: { frame: PaneFrame }) {
  const { list, error, reload } = useMailConnections();
  const [open, setOpen] = useState<{ provider: MailProvider; item: MailListItemDTO } | null>(null);
  const wide = useWide();
  const activeKey = useActiveKey();
  const ready = !!list?.some((c) => c.status === 'active');
  const openMail = (provider: MailProvider, item: MailListItemDTO) => {
    if (frame.presentation === 'sidebar' && wide) {
      const opened = openInGrid({ kind: 'mail', provider, id: item.id, subject: item.subject, from: item.from?.name || item.from?.email || '' }, activeKey, null);
      if (!opened) return;
      collapsePane();
      if (frame.expanded) frame.onOnly();
      if (location.pathname !== `${BASE}/cuadricula`) navigate('/cuadricula');
      return;
    }
    setOpen({ provider, item });
  };
  return (
    <div className={`pane-typed ${frame.active ? 'is-active' : ''}`}>
      <PaneHead icon={<ProviderIcon provider="google" size={20} />} title={t('nav.mail')} sub={open ? open.item.subject || t('mail.noSubject') : undefined} frame={frame} />
      {open && (
        <div className="pane-scroll">
          <button className="link-btn" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(null)}>{t('grid.backInbox')}</button>
          <MailView preserveWorkspace={frame.presentation === 'sidebar'} provider={open.provider} id={open.item.id} />
        </div>
      )}
        <div className="pane-fill" hidden={!!open}>
          {error && <div className="error">{error}</div>}
          {!list && !error && <div className="hint">{t('common.loading')}</div>}
          {list && !ready && <><p className="muted" style={{ margin: 0 }}>{t('mail.intro')}</p><ConnectCards list={list} reload={() => void reload()} /></>}
          {list && ready && (
            <MailBrowser connections={list} inPane pickLabel={t('mail.bring')} onOpen={openMail}
              onPick={(provider, item) => openDialog((close) => (
                <Modal title={t('mail.shareTitle')} onClose={close}><ShareStep provider={provider} item={item} onBack={close} onDone={(cid) => { close(); if (frame.presentation !== 'sidebar') navigate(`/c/${cid}`); }} /></Modal>
              ))} />
          )}
        </div>
    </div>
  );
}

// ---------- WhatsApp: una conversación, con respuesta directa ----------
function useWaAccount(accountId: string) {
  const revision = useClient((s) => s.waRevision);
  const [acc, setAcc] = useState<WaAccountDTO | null | undefined>(undefined);
  const generation = useRef(0);
  useWaPrivacy((event) => { generation.current++; if (event.reset) setAcc((a) => a ? { ...a, privacyReady: false, chats: 0, groups: 0 } : a); }, { accountId });
  const load = useCallback(() => {
    const token = ++generation.current, valid = captureWaPrivacy();
    return waAccounts().then((accounts) => { if (token !== generation.current || !valid()) return; const a = accounts.find((x) => x.id === accountId); setAcc(a ? { ...a } : null); }).catch(() => { if (token === generation.current && valid()) setAcc(null); });
  }, [accountId]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load, revision]);
  return { acc, reload: () => waAccounts(true).then(() => load()) };
}

/** Responder el chat. Solo si la cuenta tiene «Responder desde chaggu»; si no, lo ofrece (con el aviso de lo que implica). */
function WaReply({ accountId, jid, onSent, draft, fileDraft }: { accountId: string; jid: string; onSent: () => void; draft?: { text: string; key: number } | null; fileDraft?: { link: FileLink; key: number } | null }) {
  const { acc, reload } = useWaAccount(accountId);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const visible = useWaPrivacy(() => { setText(''); setBusy(false); }, { accountId, jid });
  // Borrador de gg: cae en la caja para editarlo; nunca se envía solo.
  useEffect(() => { if (draft) setText(draft.text); }, [draft?.key]);
  // Un archivo de chaggu soltado aquí: su enlace cae en la caja (nunca se envía solo) y se puede quitar antes de enviar.
  const [links, setLinks] = useState<FileLink[]>([]);
  useEffect(() => {
    if (!fileDraft) return;
    const line = fileLinkText(fileDraft.link);
    if (acc && (!acc.sendEnabled || acc.status !== 'connected')) { void copyText(line).then(() => toast(t('flink.copied'))); return; }
    setText((x) => (x.trim() ? `${x.trimEnd()}\n` : '') + line);
    setLinks((l) => [...l, fileDraft.link]);
    toast(t('flink.ready'));
  }, [fileDraft?.key]);
  const dropLink = (l: FileLink) => {
    setText((x) => x.replace(fileLinkText(l), '').replace(/\n{2,}/g, '\n').trim());
    setLinks((list) => list.filter((y) => y.url !== l.url));
    void revokeFileLink(l.url).catch(() => {});
  };
  if (!acc || !visible || acc.privacyReady === false) return null;
  if (!acc.sendEnabled) {
    return (
      <div className="reply-off small muted">
        {t('grid.waReadOnly')}{' '}
        <button className="link-btn" onClick={() => void setWaSend(acc, true).then((ok) => { if (ok) void reload(); })}>{t('grid.waEnable')}</button>
      </div>
    );
  }
  if (acc.status !== 'connected') return <div className="reply-off small muted">{t('grid.waDisconnected')}</div>;
  const send = async () => {
    const body = text.trim();
    const valid = captureWaPrivacy(accountId, jid);
    if (!body || busy || !valid()) return;
    setBusy(true);
    try {
      const r = await client.sendWhatsApp(accountId, jid, body);
      if (!valid()) return;
      if (r.status === 'failed') toast(`${t('grid.waFailed')}: ${r.error ?? ''}`);
      else {
        // Enviado con enlaces: por si fue al chat equivocado, se pueden desactivar (en WhatsApp el mensaje queda, pero ya no abre).
        const sentLinks = links.filter((l) => body.includes(l.url));
        setText(''); setLinks([]);
        toast(t(r.status === 'sent' ? 'grid.waSent' : 'grid.waQueued'), sentLinks.length ? { label: t('flink.revoke'), run: () => void Promise.all(sentLinks.map((l) => revokeFileLink(l.url))).then(() => toast(t('flink.revoked'))).catch((e) => toast(errorText(e))) } : undefined, sentLinks.length ? 10_000 : undefined);
        onSent();
      }
    } catch (e) { if (valid()) toast(errorText(e)); } finally { if (valid()) setBusy(false); }
  };
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } };
  return (
    <>
    {links.length > 0 && <div className="flink-chips">{links.map((l) => (
      <div key={l.url} className="flink-chip small"><span aria-hidden>🔗</span><span className="grow">{t('flink.note', { name: l.name, date: fileLinkDate(l.expiresAt) })}</span><button className="link-btn" onClick={() => dropLink(l)}>{t('flink.undo')}</button></div>
    ))}</div>}
    <div className="reply-bar">
      <textarea className="input" rows={1} maxLength={4000} placeholder={t('grid.waReplyPh')} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={key} />
      <button className="btn small primary" disabled={!text.trim() || busy} onClick={() => void send()}>{busy ? t('grid.replySending') : t('grid.replySend')}</button>
    </div>
    </>
  );
}

/** Los mensajes de una conversación de WhatsApp (con el ⠿ de cada uno) y la caja para responder. */
/** Lo que «gg de este chat» le pide a la vista: citar, marcar varios y el borrador para la caja. */
interface WaGg { source: string; host: GgHost; selected: Set<string>; toggle: (m: WaMessageDTO) => void; ask: (m: WaMessageDTO) => void; draft: { text: string; key: number } | null; onSelectAsk: () => void; onClear: () => void }
function WaChatView({ accountId, jid, name, isGroup, gg, active = true }: { accountId: string; jid: string; name: string; isGroup: boolean; gg?: WaGg; active?: boolean }) {
  const d = useClient((s) => s.data)!;
  const revision = useClient((s) => s.waRevision);
  const mailOn = d.features?.mail === true;
  const [messages, setMessages] = useState<WaMessageDTO[] | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const loadGeneration = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const sentRefresh = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stickToBottom = useRef(true);
  const visible = useWaPrivacy(() => { loadGeneration.current++; setMessages(null); if (sentRefresh.current) clearTimeout(sentRefresh.current); }, { accountId, jid });
  const load = useCallback(() => {
    if (!activeRef.current) return;
    const valid = captureWaPrivacy(accountId, jid);
    if (!valid()) return;
    const token = ++loadGeneration.current;
    client.request<{ messages: WaMessageDTO[] }>(`/whatsapp/chats/${accountId}/${encodeURIComponent(jid)}/messages?limit=80`)
      .then((r) => { if (token === loadGeneration.current && activeRef.current && valid()) setMessages(r.messages); }).catch((e) => { if (token === loadGeneration.current && valid()) toast(errorText(e)); });
  }, [accountId, jid]);
  useEffect(() => { setMessages(null); stickToBottom.current = true; }, [load]);
  useEffect(() => { if (!active) return; const timer = setTimeout(load, 200); return () => { clearTimeout(timer); loadGeneration.current++; }; }, [load, revision, active]);
  useEffect(() => () => { if (sentRefresh.current) clearTimeout(sentRefresh.current); }, [active, accountId, jid]);
  useEffect(() => { if (stickToBottom.current) box.current?.scrollTo({ top: box.current.scrollHeight }); }, [messages]);
  const last = messages?.[messages.length - 1] ?? null;
  // Soltar aquí un archivo de chaggu (Attachments.tsx): se crea un enlace para verlo y cae en la caja de responder.
  const [fileDraft, setFileDraft] = useState<{ link: FileLink; key: number } | null>(null);
  const [fileOver, setFileOver] = useState(false);
  const fileDrop = {
    onDragOver: (e: React.DragEvent) => { if (!isFileDrag(e.dataTransfer.types)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; if (!fileOver) setFileOver(true); },
    onDragLeave: (e: React.DragEvent) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setFileOver(false); },
    onDrop: (e: React.DragEvent) => {
      if (!isFileDrag(e.dataTransfer.types)) return;
      e.preventDefault(); e.stopPropagation(); setFileOver(false);
      const f = readFileDrag(e.dataTransfer);
      const valid = captureWaPrivacy(accountId, jid);
      if (!f || !valid()) return;
      void createFileLink(f.attachmentId).then((link) => { if (valid()) setFileDraft({ link, key: Date.now() }); }).catch((err) => toast(errorText(err)));
    },
  };
  if (!visible) return null;
  return (
    <>
      <div className={`wa-msgs pane-wa ${fileOver ? 'is-file-over' : ''}`} ref={box} {...fileDrop} onScroll={(e) => { const el = e.currentTarget; stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        {messages === null && <div className="hint">{t('common.loading')}</div>}
        {messages?.length === 0 && <div className="hint">{t('wa.noMessages')}</div>}
        {messages?.map((m) => {
          const bring = () => openWaDialog({ accountId, jid }, (close) => <WaShareDialog accountId={accountId} jid={jid} chatName={name} isGroup={isGroup} message={m} onClose={close} />);
          return (
            <div key={m.id} className={`wa-msg ${m.fromMe ? 'me' : ''} ${gg?.selected.has(m.id) ? 'is-selected' : ''}`}
              // 2-oct-2026: se arrastra la burbuja entera (antes solo el ⠿, que casi no se encontraba). Copiar sigue en el menú.
              {...(mailOn ? { draggable: true, title: t('grid.carryMsgHint'), onDragStart: (e: React.DragEvent) => { setDrag(e, 'wamsg', { accountId, jid, messageId: m.id, chatName: name, text: m.body }, m.body.slice(0, 80)); e.dataTransfer.setDragImage(e.currentTarget as HTMLElement, 12, 12); } } : {})}
              {...waMenuProps({ accountId, jid }, () => [
                ...(mailOn ? [{ label: t('wa.bring'), icon: '⤴', onSelect: bring }] : []),
                { label: t('common.copy'), icon: '⧉', onSelect: () => void copyText(m.body).then(() => toast(t('common.copied'))) },
                ...(gg ? [{ divider: true }, { label: t('ggs.ask'), onSelect: () => gg.ask(m) }, { label: gg.selected.has(m.id) ? t('ggs.clearSel') : t('ggs.select'), icon: '◯', hint: t('ggs.selectHint'), onSelect: () => gg.toggle(m) }] : []),
              ])}
              {...(gg ? { onMouseDown: (e: React.MouseEvent) => { if (e.shiftKey) e.preventDefault(); }, onClickCapture: (e: React.MouseEvent) => { if (e.shiftKey) { e.preventDefault(); e.stopPropagation(); gg.toggle(m); } } } : {})}>
              {gg && <button className={`msg-sel wa-sel ${gg.selected.has(m.id) ? 'on' : ''}`} aria-pressed={gg.selected.has(m.id)} aria-label={t('ggs.select')} title={t('ggs.selectHint')} onClick={(e) => { e.stopPropagation(); gg.toggle(m); }}>{gg.selected.has(m.id) ? '✓' : ''}</button>}
              {!m.fromMe && isGroup && <div className={m.author ? 'wa-author' : 'wa-author unknown'}>{m.author ?? t('wa.someone')}</div>}
              <div><RichText text={m.body} /></div>
              {m.media?.attachment && <AttachmentsView list={[m.media.attachment]} />}
              {m.media && m.media.status !== 'ready' && <div className="small muted" role="status">{m.media.status === 'pending' ? (locale().startsWith('en') ? 'Preparing attachment…' : 'Preparando adjunto…') : (locale().startsWith('en') ? 'Attachment unavailable' : 'Adjunto no disponible')}{m.media.status === 'failed' && <button className="link-btn" onClick={() => void client.request(`/whatsapp/media/${accountId}/${encodeURIComponent(jid)}/${encodeURIComponent(m.id)}`, { method: 'POST', json: {} }).then(load).catch((e) => toast(errorText(e)))}>{locale().startsWith('en') ? 'Retry' : 'Reintentar'}</button>}</div>}
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
      {gg && <SelectionBar n={gg.selected.size} onAsk={gg.onSelectAsk} onClear={gg.onClear} />}
      {gg && last && !last.fromMe && <div className="row gg-compose-row"><span className="grow" /><ReplyForMe source={gg.source} host={gg.host} /></div>}
      {fileOver && <div className="flink-drop small" aria-hidden>🔗 {t('flink.dropHint')}</div>}
      <div className="flink-wrap" {...fileDrop}><WaReply accountId={accountId} jid={jid} onSent={() => { if (sentRefresh.current) clearTimeout(sentRefresh.current); sentRefresh.current = setTimeout(load, 1500); }} draft={gg?.draft} fileDraft={fileDraft} /></div>
      <div className="pane-foot small muted">{t('grid.waFoot')}</div>
    </>
  );
}

export function WaPane({ paneKey, accountId, jid, frame }: { paneKey: string; accountId: string; jid: string; frame: PaneFrame }) {
  const meta = useMetas()[paneKey];
  const name = meta?.title ?? jid.split('@')[0]!;
  return (
    <div className={`pane-typed ${frame.active ? 'is-active' : ''}`}>
      <WaGgChat active={frame.visible !== false} accountId={accountId} jid={jid} name={name} isGroup={jid.endsWith('@g.us')}
        head={(gg) => <PaneHead icon={<WaIcon size={20} />} title={name} sub={meta?.sub ?? 'WhatsApp'} frame={frame} extra={gg} />} />
    </div>
  );
}

/** «Tú» (notas para ti): ahí cuelgan los recordatorios de un chat de WhatsApp, que no es una conversación de chaggu. */
async function selfConversation() {
  const r = await client.request<{ id: string }>('/me/notes', { method: 'POST', json: {} });
  const find = () => client.getState().data?.conversations.find((c) => c.id === r.id || isSelfChat(client.getState().data!, c));
  if (!find()) await client.loadBootstrap();
  return find() ?? null;
}

/**
 * Un chat de WhatsApp con «gg de este chat»: el botón va en la cabecera (head), el panel a la derecha. Lo usan el
 * panel de la cuadrícula y la pantalla /whatsapp/:accountId/:jid. Fuente wa:<acc>:<jid>.
 */
function WaGgChat({ accountId, jid, name, isGroup, head, active = true }: { accountId: string; jid: string; name: string; isGroup: boolean; head: (gg: ReactNode) => ReactNode; active?: boolean }) {
  const source = waSource(accountId, jid);
  const { acc } = useWaAccount(accountId);
  const [open, setOpen] = useState(false);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [request, setRequest] = useState<{ key: number; kind: 'reply' | 'ask'; text?: string; ids?: string[] } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [suggestFor, setSuggestFor] = useState<string[] | null>(null);
  const [draft, setDraft] = useState<{ text: string; key: number } | null>(null);
  const closeGg = () => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); setOpen(false); setSelected(new Set()); setQuotes([]); setRequest(null); setSuggestFor(null); };
  const visible = useWaPrivacy(() => { closeGg(); setDraft(null); }, { accountId, jid });
  useEffect(() => { closeGg(); }, [source]);
  useEffect(() => { if (!active) closeGg(); }, [active]);
  useEffect(() => { if (!open) return; const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') closeGg(); }; window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape); }, [open]);
  const canSend = !!acc?.sendEnabled && acc.status === 'connected' && acc.privacyReady !== false;
  const hostValid = captureWaPrivacy(accountId, jid);
  const host: GgHost = {
    // Solo cae en la caja si la cuenta puede responder desde chaggu; si no, se copia para pegarlo en WhatsApp.
    useDraft: (text) => { if (!hostValid()) return; if (canSend) setDraft({ text, key: Date.now() }); else void copyText(text).then(() => { if (hostValid()) toast(t('wa.copiedDraft')); }); },
    task: (p) => { if (hostValid()) return showWaDialogUntilClosed({ accountId, jid }, (close) => <NewIssueDialog defaultTitle={p.title} defaultDue={p.due} onClose={close} />); },
    reminder: (p) => { if (!hostValid()) return; return selfConversation().then((conv) => { if (hostValid() && conv) return showWaDialogUntilClosed({ accountId, jid }, (close) => <ReminderDialog conv={conv} defaultNote={`${name}: ${p.title}`} defaultDate={p.due} onClose={close} />); }).catch((e) => { if (hostValid()) toast(errorText(e)); }); },
  };
  const ask = (m: WaMessageDTO) => { if (!hostValid()) return; setQuotes((q) => (q.some((x) => x.id === m.id) ? q : [...q, { id: m.id, author: m.fromMe ? t('common.youShort') : m.author ?? t('wa.someone'), text: m.body.slice(0, 1000) }])); setOpen(true); };
  const toggle = (m: WaMessageDTO) => { if (hostValid()) setSelected((x) => { const n = new Set(x); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; }); };
  const btn = <GgButton source={source} on={open} onClick={() => open ? closeGg() : setOpen(true)} />;
  if (!visible || !acc || acc.privacyReady === false) return <div className="hint" role="status">{visible || !client.isWaChatVisible(accountId) ? waPrivacySyncing() : waPrivacyUnavailable()}</div>;
  return (
    <>
      {head(btn)}
      <div className={`wa-gg-body ${open ? 'has-gg' : ''}`}>
        <div className="wa-gg-chat">
          <WaChatView active={active} accountId={accountId} jid={jid} name={name} isGroup={isGroup}
            gg={{ source, host, selected, toggle, ask, draft, onSelectAsk: () => setSuggestFor([...selected]), onClear: () => setSelected(new Set()) }} />
        </div>
        {open && <GgSidePanel source={source} chatName={name} quoted={quotes} onClearQuote={(id) => setQuotes((q) => (id ? q.filter((x) => x.id !== id) : []))}
          host={host} onClose={closeGg} request={request} />}
      </div>
      {suggestFor && <SuggestDialog source={source} messageIds={suggestFor} host={host}
        onAsk={(q, ids) => { setOpen(true); setRequest({ key: Date.now(), kind: 'ask', text: q, ids }); }}
        onClose={() => { setSuggestFor(null); setSelected(new Set()); }} />}
    </>
  );
}

/** Un chat de WhatsApp a pantalla completa (desde la fila de Grupos/DMs): /whatsapp/:accountId/:jid. */
export function WaChatScreen({ accountId, jid }: { accountId: string; jid: string }) {
  const row = useWaInboxRow(accountId, jid);
  const [fetched, setFetched] = useState<WaChatDTO | null>(null);
  const visible = useWaPrivacy(() => setFetched(null), { accountId, jid });
  const revision = useClient((s) => s.waRevision);
  useEffect(() => {
    let live = true; setFetched(null);
    if (row || !visible) return;
    const valid = captureWaPrivacy(accountId, jid);
    // Abierto por enlace y fuera de la bandeja: se busca en la lista de esa cuenta.
    client.request<{ chats: WaChatDTO[] }>(`/whatsapp/chats?accountId=${accountId}&limit=1000`).then((r) => { if (live && valid()) setFetched(r.chats.find((c) => c.jid === jid) ?? null); }).catch(() => {});
    return () => { live = false; };
  }, [accountId, jid, !!row, revision, visible]);
  const chat = row ?? (fetched?.accountId === accountId && fetched.jid === jid ? fetched : null);
  const name = chat?.name ?? jid.split('@')[0]!;
  const isGroup = chat?.isGroup ?? jid.endsWith('@g.us');
  const off = !!chat?.accountStatus && chat.accountStatus !== 'connected';
  if (!visible) return <div className="hint" role="status">{client.isWaChatVisible(accountId) ? waPrivacyUnavailable() : waPrivacySyncing()}</div>;
  return (
    <div className="pane-typed wa-chat-screen">
      <WaGgChat key={`${accountId}|${jid}`} accountId={accountId} jid={jid} name={name} isGroup={isGroup} head={(gg) => (
        <div className="pane-head conv-head">
          <button className="icon-btn" aria-label={t('common.back')} onClick={() => (history.length > 1 ? history.back() : navigate('/whatsapp'))}>‹</button>
          <WaAvatar w={{ name, isGroup }} size={30} />
          <div className="pane-title"><b className="ellipsis">{name}</b><span className="small muted ellipsis">{off ? t('wa.disconnected') : `WhatsApp${chat ? ` · ${chat.accountLabel}` : ''}`}</span></div>
          {gg}
          {chat && <button className="icon-btn" aria-label={t('menu.open')} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openWaMenuAt(chat, r.left, r.bottom + 4, chat.inboxPlace ? waInboxMenu(chat) : waMainListMenu(chat, setFetched)); }}>⋯</button>}
        </div>
      )} />
    </div>
  );
}

/** Todas las conversaciones de WhatsApp: la lista con búsqueda; al tocar una se abre ahí mismo, con «← Conversaciones» para volver. */
export function WaListPane({ frame }: { frame: PaneFrame }) {
  const revision = useClient((s) => s.waRevision);
  const [chats, setChats] = useState<WaChatDTO[] | null>(null);
  const [accounts, setAccounts] = useState<WaAccountDTO[] | null>(null);
  const [q, setQ] = useState('');
  const [groups, setGroups] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const [open, setOpen] = useState<WaChatDTO | null>(null);
  const [pinBusy, setPinBusy] = useState<string | null>(null);
  const active = frame.visible !== false && (frame.presentation !== 'sidebar' || frame.active);
  useWaPrivacy((event) => {
    generation.current++;
    setChats((old) => old?.filter((c) => !waPrivacyAffected(event, c)) ?? null);
    setOpen((old) => old && waPrivacyAffected(event, old) ? null : old);
    if (event.reset) setAccounts((old) => old?.map((a) => a.id === event.accountId ? { ...a, privacyReady: false, chats: 0, groups: 0 } : a) ?? null);
    setNext(null); setLoading(false); setPinBusy(null); setError(null);
  });
  useEffect(() => { if (!active) return; let live = true; const valid = captureWaPrivacy(); waAccounts().then((accounts) => { if (live && valid()) setAccounts(accounts); }).catch((e) => { if (live && valid()) setError(errorText(e)); }); return () => { live = false; }; }, [revision, active]);
  const loadPage = async (cursor?: string, token = generation.current) => {
    const valid = captureWaPrivacy(accountId || undefined);
    if (!valid()) return;
    setLoading(true); setError(null);
    const p = new URLSearchParams({ limit: '80' });
    if (groups) p.set('groups','1'); if (q.trim()) p.set('q',q.trim()); if (accountId) p.set('accountId',accountId); if (cursor) p.set('cursor',cursor);
    try {
      const r = await client.request<{ chats: WaChatDTO[]; next?: string | null }>(`/whatsapp/chats?${p}`);
      if (token !== generation.current || !valid()) return;
      const visible = r.chats.filter((c) => client.isWaChatVisible(c.accountId, c.jid));
      setChats((old) => sortWaChats(cursor ? [...new Map([...(old ?? []), ...visible].map((c) => [`${c.accountId}|${c.jid}`, c])).values()] : visible)); setNext(r.next ?? null);
    } catch (e) { if (token === generation.current && valid()) setError(errorText(e)); }
    finally { if (token === generation.current && valid()) setLoading(false); }
  };
  useEffect(() => {
    const token = ++generation.current; if (!active) return;
    const timer = setTimeout(() => void loadPage(undefined, token), q ? 250 : 120);
    return () => { clearTimeout(timer); generation.current++; };
  }, [q, groups, accountId, revision, active]);
  const connected = accounts?.some((a) => a.status === 'connected') ?? false;
  const privacySyncing = accounts?.some((a) => (!accountId || accountId === a.id) && a.privacyReady === false) ?? false;
  const workOnly = useWorkOnly();
  const visibleChats = chats?.filter((c) => client.isWaChatVisible(c.accountId, c.jid) && (!workOnly || isWorkChat(c))) ?? null;
  const visibleOpen = open && client.isWaChatVisible(open.accountId, open.jid) ? open : null;
  const toggleChatPin = async (chat: WaChatDTO) => {
    if (pinBusy) return;
    const valid = captureWaPrivacy(chat.accountId, chat.jid);
    if (!valid()) return;
    const token = generation.current;
    setPinBusy(`${chat.accountId}|${chat.jid}`);
    try {
      const updated = await client.request<WaChatDTO>(`/whatsapp/chats/${chat.accountId}/${encodeURIComponent(chat.jid)}`, { method: 'PATCH', json: { pinned: !chat.pinned } });
      if (!valid() || token !== generation.current) return;
      setChats((old) => old && sortWaChats(old.map((c) => c.accountId === updated.accountId && c.jid === updated.jid ? updated : c)));
      // Refresh the cursor once after changing the server sort key.
      generation.current++;
      void loadPage(undefined, generation.current);
    } catch (e) { if (valid()) toast(errorText(e)); }
    finally { if (valid() && token <= generation.current) setPinBusy(null); }
  };
  const when = (iso: string | null) => {
    if (!iso) return '';
    const x = new Date(iso);
    return x.toDateString() === new Date().toDateString() ? x.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) : x.toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
  };
  return (
    <div className={`pane-typed ${frame.active ? 'is-active' : ''}`}>
      <PaneHead icon={<WaIcon size={20} />} title="WhatsApp" sub={visibleOpen ? visibleOpen.name : (locale().startsWith('en') ? 'Recent conversations' : 'Conversaciones recientes')} frame={frame} />
      {visibleOpen && (
        <>
          <div className="pane-subbar"><button className="link-btn" onClick={() => setOpen(null)}>{t('grid.backChats')}</button><b className="ellipsis">{visibleOpen.name}</b></div>
          <WaGgChat active={active} key={`${visibleOpen.accountId}|${visibleOpen.jid}`} accountId={visibleOpen.accountId} jid={visibleOpen.jid} name={visibleOpen.name} isGroup={visibleOpen.isGroup} head={(gg) => <div className="pane-subbar"><span className="grow" />{gg}</div>} />
        </>
      )}
        <div className="pane-fill" hidden={!!visibleOpen}>
          {error && <div className="error" role="alert">{error}<button className="link-btn" onClick={() => void loadPage()}>{locale().startsWith('en') ? 'Retry' : 'Reintentar'}</button></div>}
          {accounts && accounts.length === 0 && (
            <div className="grid-empty-card" style={{ padding: 12 }}>
              <p>{t('grid.noWa')}</p>
              <button className="btn primary small" onClick={() => navigate('/whatsapp')}>{t('grid.connectWa')}</button>
            </div>
          )}
          {accounts && accounts.length > 0 && (
            <>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <input className="input grow" style={{ minWidth: 140 }} placeholder={t('grid.waSearch')} value={q} onChange={(e) => setQ(e.target.value)} />
                <div className="seg">
                  <button className={!groups ? 'on' : ''} onClick={() => setGroups(false)}>{t('grid.allKinds')}</button>
                  <button className={groups ? 'on' : ''} onClick={() => setGroups(true)}>{t('grid.groupsOnly')}</button>
                </div>
                <button className={`btn small wa-work-only ${workOnly ? 'is-on' : ''}`} aria-pressed={workOnly} title={t('wa.workOnlyHint')} onClick={() => setWorkOnly(!workOnly)}>{t('wa.workOnly')}</button>
              </div>
              {accounts.length > 1 && <select className="input" aria-label={locale().startsWith('en') ? 'Account' : 'Cuenta'} value={accountId} onChange={(e) => setAccountId(e.target.value)}><option value="">{locale().startsWith('en') ? 'All accounts' : 'Todas las cuentas'}</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select>}
              <div className="pane-list" aria-busy={loading}>
                {privacySyncing && <div className="hint" role="status">{waPrivacySyncing()}</div>}
                {visibleChats === null && !privacySyncing && <div className="hint">{t('common.loading')}</div>}
                {visibleChats?.length === 0 && !privacySyncing && <div className="empty">{connected ? t('grid.noChats') : t('wa.syncing')}</div>}
                {visibleChats?.map((c) => (
                  <div key={`${c.accountId}|${c.jid}`} className={`wa-row ${c.unread ? 'unread' : ''}`} role="button" tabIndex={0} draggable
                    onClick={() => { if (client.isWaChatVisible(c.accountId, c.jid)) setOpen(c); }} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); if (client.isWaChatVisible(c.accountId, c.jid)) setOpen(c); } }}
                    onDragStart={(e) => setDrag(e, 'wa', { accountId: c.accountId, jid: c.jid, name: c.name, isGroup: c.isGroup }, c.name)}>
                    <span className="wa-av" aria-hidden>{c.isGroup ? '👥' : '👤'}</span>
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="row" style={{ gap: 6 }}><b className="ellipsis grow">{c.pinned && <span aria-label={locale().startsWith('en') ? 'Pinned conversation' : 'Conversación fijada'}>📌 </span>}{c.name}</b><span className="small muted" title={c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleString(locale()) : ''}>{when(c.lastMessageAt)}</span></span>
                      <span className="small muted ellipsis" style={{ display: 'block' }}>{c.lastPreview ?? ''}</span>
                    </span>
                    {c.unread > 0 && <span className="pill">{c.unread}</span>}
                    <button className="icon-btn wa-list-pin" aria-pressed={c.pinned} disabled={pinBusy !== null} draggable={false}
                      aria-label={locale().startsWith('en') ? `${c.pinned ? 'Unpin' : 'Pin'} conversation: ${c.name}` : `${c.pinned ? 'Desfijar' : 'Fijar'} conversación: ${c.name}`}
                      title={t(c.pinned ? 'wa.unpin' : 'wa.pin')}
                      onClick={(e) => { e.stopPropagation(); void toggleChatPin(c); }}>📌</button>
                  </div>
                ))}
                {next && <button className="btn small" disabled={loading} onClick={() => void loadPage(next)}>{locale().startsWith('en') ? 'Load more' : 'Cargar más'}</button>}
              </div>
            </>
          )}
        </div>
    </div>
  );
}

/** Tareas: la misma lista de Tareas, con sus filtros, en un cuadrito. */
export function TasksPane({ frame }: { frame: PaneFrame }) {
  return (
    <div className={`pane-typed ${frame.active ? 'is-active' : ''}`}>
      <PaneHead icon={<span style={{ fontSize: 18 }}>☑</span>} title={t('nav.issues')} frame={frame} />
      <div className="pane-scroll"><IssuesBody /></div>
    </div>
  );
}
