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
import { rememberMeta, useMetas } from '../split.ts';
import { setDrag } from '../grid-actions.ts';
import { ConnectCards, MailBrowser, MailHtml, MailMeta, ProviderIcon, ShareStep, WaIcon, WaShareDialog, kb, liveHtmlOf, previewOf, useMailConnections } from './Mail.tsx';
import { setWaSend } from './WhatsApp.tsx';
import { IssuesBody } from './Issues.tsx';
import { navigate } from '../router.ts';
import { toast } from '../menu.tsx';

export interface PaneFrame { active: boolean; count: number; pinned: boolean; onClose: () => void; onOnly: () => void; onPin: () => void; onTint: (anchor: HTMLElement) => void }

/** Cabecera común de un panel: qué es, cómo se llama, fijar, dejar solo este y cerrar. */
function PaneHead({ icon, title, sub, frame }: { icon: ReactNode; title: string; sub?: string; frame: PaneFrame }) {
  return (
    <div className="pane-head">
      <span className="pane-ico" aria-hidden>{icon}</span>
      <div className="pane-title"><b className="ellipsis">{title}</b>{sub && <span className="small muted ellipsis">{sub}</span>}</div>
      <button className="icon-btn head-keep" aria-label={t('tint.title')} title={t('tint.title')} onClick={(e) => frame.onTint(e.currentTarget)}>🎨</button>
      <button className={`icon-btn head-keep ${frame.pinned ? 'is-on' : ''}`} aria-pressed={frame.pinned} aria-label={t(frame.pinned ? 'grid.unpin' : 'grid.pin')} title={t(frame.pinned ? 'grid.unpin' : 'grid.pin')} onClick={frame.onPin}>📌</button>
      {frame.count > 1 && <button className="icon-btn head-keep" aria-label={t('split.only')} title={t('split.only')} onClick={frame.onOnly}>⤢</button>}
      <button className="icon-btn head-keep" aria-label={t('split.close')} title={t('split.close')} onClick={frame.onClose}>×</button>
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
function MailView({ paneKey, provider, id }: { paneKey?: string; provider: MailProvider; id: string }) {
  const [m, setM] = useState<MailMessageDTO | null>(null);
  const [html, setHtml] = useState<string | null | undefined>(undefined);
  const [asText, setAsText] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setM(null); setHtml(undefined); setError(null);
    previewOf(provider, id).then((r) => { if (!live) return; setM(r); if (paneKey) rememberMeta(paneKey, { title: r.subject || t('mail.noSubject'), sub: r.from ? r.from.name || r.from.email : undefined }); }).catch((e) => live && setError(errorText(e)));
    liveHtmlOf(provider, id).then((h) => live && setHtml(h)).catch(() => live && setHtml(null));
    return () => { live = false; };
  }, [provider, id]);
  const share = () => m && openDialog((close) => (
    <Modal title={t('mail.shareTitle')} onClose={close}><ShareStep provider={provider} item={m} onBack={close} onDone={(cid) => { close(); navigate(`/c/${cid}`); }} /></Modal>
  ));
  return (
    <>
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
    </>
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

/** La bandeja entera: la lista de tu correo con búsqueda y filtros; al tocar uno se abre ahí mismo, con «← Bandeja» para volver. */
export function InboxPane({ frame }: { frame: PaneFrame }) {
  const { list, error, reload } = useMailConnections();
  const [open, setOpen] = useState<{ provider: MailProvider; item: MailListItemDTO } | null>(null);
  const ready = !!list?.some((c) => c.status === 'active');
  return (
    <div className={`pane-typed ${frame.active ? 'is-active' : ''}`}>
      <PaneHead icon={<ProviderIcon provider="google" size={20} />} title={t('nav.mail')} sub={open ? open.item.subject || t('mail.noSubject') : undefined} frame={frame} />
      {open ? (
        <div className="pane-scroll">
          <button className="link-btn" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(null)}>{t('grid.backInbox')}</button>
          <MailView provider={open.provider} id={open.item.id} />
        </div>
      ) : (
        <div className="pane-fill">
          {error && <div className="error">{error}</div>}
          {!list && !error && <div className="hint">{t('common.loading')}</div>}
          {list && !ready && <><p className="muted" style={{ margin: 0 }}>{t('mail.intro')}</p><ConnectCards list={list} reload={() => void reload()} /></>}
          {list && ready && (
            <MailBrowser connections={list} inPane pickLabel={t('mail.bring')} onOpen={(provider, item) => setOpen({ provider, item })}
              onPick={(provider, item) => openDialog((close) => (
                <Modal title={t('mail.shareTitle')} onClose={close}><ShareStep provider={provider} item={item} onBack={close} onDone={(cid) => { close(); navigate(`/c/${cid}`); }} /></Modal>
              ))} />
          )}
        </div>
      )}
    </div>
  );
}

// ---------- WhatsApp: una conversación, con respuesta directa ----------
function useWaAccount(accountId: string) {
  const revision = useClient((s) => s.waRevision);
  const [acc, setAcc] = useState<WaAccountDTO | null | undefined>(undefined);
  const load = useCallback(() => client.request<{ accounts: WaAccountDTO[] }>('/whatsapp/accounts').then((r) => { const a = r.accounts.find((x) => x.id === accountId); setAcc(a ? { ...a } : null); }).catch(() => setAcc(null)), [accountId]);
  useEffect(() => { void load(); }, [load, revision]);
  return { acc, reload: load };
}

/** Responder el chat. Solo si la cuenta tiene «Responder desde chaggu»; si no, lo ofrece (con el aviso de lo que implica). */
function WaReply({ accountId, jid, onSent }: { accountId: string; jid: string; onSent: () => void }) {
  const { acc, reload } = useWaAccount(accountId);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  if (!acc) return null;
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
    if (!body || busy) return;
    setBusy(true);
    try {
      const r = await client.sendWhatsApp(accountId, jid, body);
      if (r.status === 'failed') toast(`${t('grid.waFailed')}: ${r.error ?? ''}`);
      else { setText(''); toast(t(r.status === 'sent' ? 'grid.waSent' : 'grid.waQueued')); onSent(); }
    } catch (e) { toast(errorText(e)); } finally { setBusy(false); }
  };
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } };
  return (
    <div className="reply-bar">
      <textarea className="input" rows={1} maxLength={4000} placeholder={t('grid.waReplyPh')} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={key} />
      <button className="btn small primary" disabled={!text.trim() || busy} onClick={() => void send()}>{busy ? t('grid.replySending') : t('grid.replySend')}</button>
    </div>
  );
}

/** Los mensajes de una conversación de WhatsApp (con el ⠿ de cada uno) y la caja para responder. */
function WaChatView({ accountId, jid, name, isGroup }: { accountId: string; jid: string; name: string; isGroup: boolean }) {
  const d = useClient((s) => s.data)!;
  const revision = useClient((s) => s.waRevision);
  const mailOn = d.features?.mail === true;
  const [messages, setMessages] = useState<WaMessageDTO[] | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const load = useCallback(() => {
    client.request<{ messages: WaMessageDTO[] }>(`/whatsapp/chats/${accountId}/${encodeURIComponent(jid)}/messages?limit=80`)
      .then((r) => setMessages(r.messages)).catch((e) => { setMessages([]); toast(errorText(e)); });
  }, [accountId, jid]);
  useEffect(() => { setMessages(null); load(); }, [load, revision]);
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [messages]);
  return (
    <>
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
      <WaReply accountId={accountId} jid={jid} onSent={() => window.setTimeout(load, 1500)} />
      <div className="pane-foot small muted">{t('grid.waFoot')}</div>
    </>
  );
}

export function WaPane({ paneKey, accountId, jid, frame }: { paneKey: string; accountId: string; jid: string; frame: PaneFrame }) {
  const meta = useMetas()[paneKey];
  const name = meta?.title ?? jid.split('@')[0]!;
  return (
    <div className={`pane-typed ${frame.active ? 'is-active' : ''}`}>
      <PaneHead icon={<WaIcon size={20} />} title={name} sub={meta?.sub ?? 'WhatsApp'} frame={frame} />
      <WaChatView accountId={accountId} jid={jid} name={name} isGroup={jid.endsWith('@g.us')} />
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
  const [open, setOpen] = useState<WaChatDTO | null>(null);
  useEffect(() => { client.request<{ accounts: WaAccountDTO[] }>('/whatsapp/accounts').then((r) => setAccounts(r.accounts)).catch(() => setAccounts([])); }, [revision]);
  useEffect(() => {
    const h = setTimeout(() => {
      const p = new URLSearchParams({ limit: '300' });
      if (groups) p.set('groups', '1');
      if (q.trim()) p.set('q', q.trim());
      client.request<{ chats: WaChatDTO[] }>(`/whatsapp/chats?${p}`).then((r) => setChats(r.chats)).catch(() => setChats([]));
    }, q ? 250 : 0);
    return () => clearTimeout(h);
  }, [q, groups, revision]);
  const connected = accounts?.some((a) => a.status === 'connected') ?? false;
  const when = (iso: string | null) => {
    if (!iso) return '';
    const x = new Date(iso);
    return x.toDateString() === new Date().toDateString() ? x.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) : x.toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
  };
  return (
    <div className={`pane-typed ${frame.active ? 'is-active' : ''}`}>
      <PaneHead icon={<WaIcon size={20} />} title="WhatsApp" sub={open ? open.name : t('grid.allChats')} frame={frame} />
      {open ? (
        <>
          <div className="pane-subbar"><button className="link-btn" onClick={() => setOpen(null)}>{t('grid.backChats')}</button><b className="ellipsis">{open.name}</b></div>
          <WaChatView accountId={open.accountId} jid={open.jid} name={open.name} isGroup={open.isGroup} />
        </>
      ) : (
        <div className="pane-fill">
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
              </div>
              <div className="pane-list">
                {chats === null && <div className="hint">{t('common.loading')}</div>}
                {chats?.length === 0 && <div className="empty">{connected ? t('grid.noChats') : t('wa.syncing')}</div>}
                {chats?.map((c) => (
                  <div key={`${c.accountId}|${c.jid}`} className={`wa-row ${c.unread ? 'unread' : ''}`} role="button" tabIndex={0} draggable
                    onClick={() => setOpen(c)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(c); }}
                    onDragStart={(e) => setDrag(e, 'wa', { accountId: c.accountId, jid: c.jid, name: c.name, isGroup: c.isGroup }, c.name)}>
                    <span className="wa-av" aria-hidden>{c.isGroup ? '👥' : '👤'}</span>
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="row" style={{ gap: 6 }}><b className="ellipsis grow">{c.name}</b><span className="small muted">{when(c.lastMessageAt)}</span></span>
                      <span className="small muted ellipsis" style={{ display: 'block' }}>{c.lastPreview ?? ''}</span>
                    </span>
                    {c.unread > 0 && <span className="pill">{c.unread}</span>}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
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
