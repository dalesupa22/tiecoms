import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { BootstrapDTO, ConversationDTO, IssueDTO, MessageDTO } from '@tiecoms/contracts';
import type { PendingMessage } from '@tiecoms/client-core';
import { client, useClient } from '../app-client.ts';
import { ForwardToChatsDialog, LinkPreviewCard, Linkify } from './Chats.tsx';
import { conversationMenu, forwardMenu, messageLink, openDialog, remindMenu } from '../actions.tsx';
import { errorText, locale, systemText, t, tn } from '../i18n.ts';
import { contextHandler, copyText, menuProps, openMenuAt, toast, type MenuItem } from '../menu.tsx';
import { navigate, queryParam } from '../router.ts';
import { Avatar, Modal, OrgMark, conversationSubtitle, conversationTitle, dayLabel, orgById, personById } from '../ui.tsx';
import { BringDialog } from './Bring.tsx';
import { ConversationAgenda, newEvent, openEvent } from './Calendar.tsx';
import { AddMembersDialog } from './Dialogs.tsx';
import { IssueDrawer, IssueRow, NewIssueDialog, isClosed } from './Issues.tsx';
import { DeriveDialog, LineageBar, MergedCard } from './Lineage.tsx';

type Row =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'msg'; key: string; m: MessageDTO; cont: boolean }
  | { kind: 'pending'; key: string; p: PendingMessage };

const draftKey = (id: string) => `tiecoms:draft:${id}`;
const excerpt = (s: string, n = 90) => s.replace(/\s+/g, ' ').trim().slice(0, n);

export function ConversationScreen({ id }: { id: string }) {
  const d = useClient((s) => s.data)!;
  const conv = d.conversations.find((c) => c.id === id);
  const local = useClient((s) => s.conversations[id]);
  const pendingAll = useClient((s) => s.pending);
  const typing = useClient((s) => s.typing[id]);
  const pinIds = useClient((s) => s.pins[id]);
  const allIssues = useClient((s) => s.issues);
  const [panel, setPanel] = useState(() => window.innerWidth > 1180);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deriving, setDeriving] = useState<MessageDTO | null>(null);
  const [newIssue, setNewIssue] = useState<{ origin?: MessageDTO } | null>(null);
  const [openIssue, setOpenIssue] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [replyTo, setReplyTo] = useState<MessageDTO | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [showPins, setShowPins] = useState(false);
  const [text, setText] = useState(() => { try { return localStorage.getItem(draftKey(id)) ?? ''; } catch { return ''; } });
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prevHeight = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);

  const jumpTo = (seq: number) => {
    atBottom.current = false;
    void client.ensureMessage(id, seq).then((found) => {
      if (!found) return;
      setHighlight(seq);
      requestAnimationFrame(() => document.getElementById(`msg-${id}-${seq}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
      setTimeout(() => setHighlight(null), 2800);
    });
  };

  useEffect(() => {
    // La pantalla se monta de nuevo por conversación (key={id}), así el borrador no se cruza.
    client.openConversation(id).catch((e) => setError(errorText(e)));
    client.loadIssues({ conversationId: id }).catch(() => {});
    client.loadPins(id).catch(() => {});
    // ?m=seq: salta a un mensaje (origen de un asunto, derivada, resultado devuelto, recordatorio o enlace copiado).
    const target = Number(queryParam('m'));
    if (target > 0) jumpTo(target);
  }, [id]);

  // Borrador local por conversación: sobrevive recargas y cambios de conversación.
  useEffect(() => { try { if (text) localStorage.setItem(draftKey(id), text); else localStorage.removeItem(draftKey(id)); } catch {} }, [id, text]);

  const pending = useMemo(() => pendingAll.filter((p) => p.conversationId === id), [pendingAll, id]);
  const byId = useMemo(() => new Map((local?.messages ?? []).map((m) => [m.id, m])), [local?.messages]);
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let lastDay = '';
    let prev: MessageDTO | null = null;
    for (const m of local?.messages ?? []) {
      const day = new Date(m.createdAt).toDateString();
      if (day !== lastDay) { out.push({ kind: 'day', key: `d${day}`, label: dayLabel(m.createdAt) }); lastDay = day; prev = null; }
      const cont = !!prev && prev.kind === 'text' && m.kind === 'text' && prev.authorId === m.authorId && !m.replyTo && !m.forwarded
        && Date.parse(m.createdAt) - Date.parse(prev.createdAt) < 5 * 60_000;
      out.push({ kind: 'msg', key: m.id, m, cont });
      prev = m;
    }
    const sentIds = new Set((local?.messages ?? []).map((m) => m.clientMessageId));
    for (const p of pending) if (!sentIds.has(p.clientMessageId)) out.push({ kind: 'pending', key: p.clientMessageId, p });
    return out;
  }, [local?.messages, pending]);

  // Mantiene la vista abajo al llegar mensajes, y la posición al cargar historial antiguo.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (atBottom.current) el.scrollTop = el.scrollHeight;
    else if (prevHeight.current && el.scrollHeight > prevHeight.current && el.scrollTop < 40) el.scrollTop += el.scrollHeight - prevHeight.current;
    prevHeight.current = el.scrollHeight;
  }, [rows.length]);

  useEffect(() => {
    if (conv && conv.unread > 0 && local?.loaded && document.visibilityState === 'visible' && atBottom.current) client.markRead(id);
  }, [conv?.lastMessageSeq, conv?.unread, local?.loaded, id]);

  if (!conv) return <div className="page"><div className="empty">{t('chat.notFound')}</div></div>;

  const onScroll = () => {
    const el = scroller.current!;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (atBottom.current && conv.unread) client.markRead(id);
    if (el.scrollTop < 120 && local?.hasMore && !local.loading) void client.loadOlder(id);
  };

  const send = () => {
    const body = text.trim();
    if (!body || !conv.canPost) return;
    atBottom.current = true;
    void client.send(id, body, replyTo?.id ?? null);
    setText('');
    setReplyTo(null);
    input.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter envía en escritorio; en móvil el teclado inserta salto de línea y se usa el botón.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia('(pointer: fine)').matches) { e.preventDefault(); send(); }
    if (e.key === 'Escape' && replyTo) setReplyTo(null);
    // Flecha arriba con el campo vacío: editar mi último mensaje (como en Slack).
    if (e.key === 'ArrowUp' && !text) {
      const mine = [...(local?.messages ?? [])].reverse().find((m) => m.authorId === d.me.id && m.kind === 'text' && !m.deletedAt);
      if (mine) { e.preventDefault(); setEditing({ id: mine.id, text: mine.body }); }
    }
  };
  const saveEdit = async () => {
    if (!editing) return;
    const body = editing.text.trim();
    const orig = byId.get(editing.id);
    setEditing(null);
    if (!body || body === orig?.body) return;
    try { await client.editMessage(editing.id, body); } catch (e) { toast(errorText(e)); }
  };

  const title = conversationTitle(d, conv);
  const openHere = Object.values(allIssues).filter((i: IssueDTO) => i.conversationId === id && !isClosed(i));
  const issueOf = (mid: string) => openHere.find((i) => i.originMessageId === mid);
  const canWork = conv.canPost && conv.kind !== 'direct' && !!conv.workspaceId;
  const myWsRole = d.workspaces.find((w) => w.id === conv.workspaceId)?.myRole;
  const ws = d.workspaces.find((w) => w.id === conv.workspaceId);
  const typers = (typing ?? []).filter((x) => x.until > Date.now()).map((x) => personById(d, x.userId)?.name.split(' ')[0]).filter(Boolean);
  const orgsHere = [...new Set(conv.memberIds.map((m) => personById(d, m)?.orgId).filter(Boolean))].map((o) => orgById(d, o as string));
  const pinned = new Set(pinIds ?? []);
  const muted = !!conv.mutedUntil && Date.parse(conv.mutedUntil) > Date.now();

  const messageMenu = (m: MessageDTO): MenuItem[] => {
    const mine = m.authorId === d.me.id;
    const isPinned = pinned.has(m.id);
    return [
      ...(conv.canPost ? [{ label: t('menu.reply'), icon: '↩', onSelect: () => { setReplyTo(m); input.current?.focus(); } }] : []),
      { label: t('menu.copyText'), icon: '⧉', onSelect: async () => { await copyText(m.body); toast(t('toast.copied')); } },
      { label: t('menu.copyLink'), icon: '⛓', onSelect: async () => { await copyText(messageLink(m)); toast(t('toast.linkCopied')); } },
      { divider: true },
      ...(conv.canPost ? [{ label: isPinned ? t('menu.unpin') : t('menu.pin'), icon: '📌', onSelect: () => client.setMessagePinned(m, !isPinned).then(() => toast(isPinned ? t('toast.unpinned') : t('toast.pinned'))).catch((e) => toast(errorText(e))) }] : []),
      remindMenu(conv, m),
      { label: t('menu.markUnread'), icon: '●', onSelect: () => client.markUnread(id, m.seq).then(() => toast(t('toast.markedUnread'))).catch((e) => toast(errorText(e))) },
      ...(canWork ? [
        { divider: true },
        ...(myWsRole !== 'guest' ? [{ label: t('menu.derive'), icon: '⑂', onSelect: () => setDeriving(m) }] : []),
        { label: t('menu.issue'), icon: '◆', onSelect: () => setNewIssue({ origin: m }) },
        { label: t('menu.meeting'), icon: '📅', onSelect: () => newEvent({ conversationId: id, originMessageId: m.id, defaultTitle: excerpt(m.body, 80) }) },
      ] : []),
      { label: t('menu.forwardChat'), icon: '↪', onSelect: () => openDialog((close) => <ForwardToChatsDialog source={m} onClose={close} />) },
      forwardMenu(d, conv, m, () => openDialog((close) => <ForwardToChatsDialog source={m} onClose={close} />)),
      ...(mine ? [
        { divider: true },
        { label: t('menu.edit'), icon: '✎', onSelect: () => setEditing({ id: m.id, text: m.body }) },
        { label: t('menu.delete'), icon: '🗑', danger: true, onSelect: () => { if (confirm(t('menu.deleteConfirm'))) void client.deleteMessage(m.id).catch((e) => toast(errorText(e))); } },
      ] : []),
    ];
  };

  return (
    <div className={`conv ${panel ? '' : 'no-panel'}`}>
      <section className="conv-main">
        <header className="conv-head" onContextMenu={contextHandler(() => conversationMenu(conv, { onNewMeeting: () => newEvent({ conversationId: id }) }))}>
          <button className="icon-btn only-mobile" aria-label={t('common.back')} onClick={() => (history.length > 1 ? history.back() : navigate('/conversaciones'))}>‹</button>
          <div className="grow" style={{ minWidth: 0 }}>
            <h2 className="ellipsis">{conv.kind === 'internal' ? '◌ ' : conv.level === 'directivo' ? '◆ ' : ''}{title}{muted ? ' 🔕' : ''}</h2>
            <div className="small muted ellipsis">{conversationSubtitle(d, conv)}{conv.kind !== 'direct' ? ` · ${tn(conv.memberIds.length, 'n.participant', 'n.participants')}` : ''}</div>
          </div>
          <div className="row only-desktop">{orgsHere.map((o) => o && <OrgMark key={o.id} org={o} size={22} />)}</div>
          {pinned.size > 0 && <button className="btn ghost small" onClick={() => setShowPins(true)} title={t('pins.title')}>📌 {pinned.size}</button>}
          {ws && <button className="btn ghost small only-desktop" onClick={() => navigate(`/w/${ws.id}`)}>{t('chat.space')}</button>}
          <button className="icon-btn" aria-label={t('menu.open')} onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenuAt(r.left, r.bottom + 4, conversationMenu(conv, { onNewMeeting: () => newEvent({ conversationId: id }) })); }}>⋯</button>
          <button className="icon-btn" aria-label={t('chat.details')} onClick={() => setPanel(!panel)}>ⓘ</button>
        </header>
        <LineageBar conv={conv} />
        {openHere.length > 0 && (
          <div className="issues-here">
            <span className="eyebrow">{t('issue.here')}</span>
            {openHere.map((i) => {
              const owner = personById(d, i.ownerId);
              return (
                <button key={i.id} className="issue-chip" onClick={() => setOpenIssue(i.id)}>
                  <Avatar person={owner} org={orgById(d, owner?.orgId)} size={22} />
                  <span className="ellipsis">{i.title}</span>
                </button>
              );
            })}
          </div>
        )}

        <div className="msgs" ref={scroller} onScroll={onScroll} role="log" aria-live="polite">
          {local?.loading && !local.loaded && <div className="msg-sys">{t('common.loading')}</div>}
          {local?.loaded && !local.hasMore && conv.historyFromSeq > 0 && <div className="msg-sys">{t('chat.lateJoin')}</div>}
          {local?.loaded && local.hasMore && <div className="msg-sys">{local.loading ? t('chat.loadingOlder') : '·'}</div>}
          {error && <div className="error" style={{ textAlign: 'center' }}>{error}</div>}
          {rows.map((r) => {
            if (r.kind === 'day') return <div key={r.key} className="day">{r.label}</div>;
            if (r.kind === 'pending') return <PendingRow key={r.key} p={r.p} />;
            const m = r.m;
            if (m.kind === 'system') return <SystemRow key={r.key} m={m} onIssue={setOpenIssue} />;
            const author = personById(d, m.authorId);
            const org = orgById(d, author?.orgId);
            const quoted = m.replyTo ? byId.get(m.replyTo) : null;
            const isEditing = editing?.id === m.id;
            const menu = m.deletedAt ? null : menuProps(() => messageMenu(m));
            return (
              <div key={r.key} id={`msg-${id}-${m.seq}`} className={`msg ${r.cont ? 'cont' : ''} ${highlight === m.seq ? 'is-highlight' : ''} ${pinned.has(m.id) ? 'is-pinned' : ''}`} {...(menu ?? {})}>
                <div>{!r.cont && <Avatar person={author} org={org} size={34} />}</div>
                <div style={{ minWidth: 0 }}>
                  {!r.cont && (
                    <div className="msg-meta">
                      <span className="msg-author">{author?.name ?? t('chat.formerParticipant')}</span>
                      <span className="msg-org">{org?.name ?? (author?.guest ? t('common.guest') : '')}</span>
                      <span className="msg-time">{new Date(m.createdAt).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}</span>
                      {pinned.has(m.id) && <span className="msg-time">📌</span>}
                    </div>
                  )}
                  {m.replyTo && (
                    <button className="msg-quote" onClick={() => quoted && jumpTo(quoted.seq)}>
                      {quoted ? <><b>{personById(d, quoted.authorId)?.name}</b> {quoted.deletedAt ? t('chat.deleted') : excerpt(quoted.body, 120)}</> : t('reply.quoteMissing')}
                    </button>
                  )}
                  {m.forwarded && <ForwardedTag d={d} m={m} />}
                  {m.mergedFrom && <MergedCard childId={m.mergedFrom} />}
                  {isEditing ? (
                    <div className="msg-edit">
                      <textarea className="input" autoFocus rows={2} value={editing.text} onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                        onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void saveEdit(); } }} />
                      <div className="row small"><span className="muted grow">{t('edit.hint')}</span><button className="btn ghost small" onClick={() => setEditing(null)}>{t('common.cancel')}</button><button className="btn primary small" onClick={saveEdit}>{t('edit.save')}</button></div>
                    </div>
                  ) : (
                    <div className="msg-body">{m.deletedAt ? <i className="muted">{t('chat.deleted')}</i> : m.kind === 'text' ? <Linkify text={m.body} /> : m.body}{m.editedAt && !m.deletedAt && <span className="msg-edited"> {t('msg.edited')}</span>}</div>
                  )}
                  {!m.deletedAt && !isEditing && m.linkPreview && <LinkPreviewCard p={m.linkPreview} />}
                  {issueOf(m.id) && <button className="msg-issue" onClick={() => setOpenIssue(issueOf(m.id)!.id)}>◆ {issueOf(m.id)!.title}</button>}
                  {!m.deletedAt && !isEditing && (
                    <div className="msg-actions">
                      {conv.canPost && <button onClick={() => { setReplyTo(m); input.current?.focus(); }}>↩ {t('menu.reply')}</button>}
                      <button onClick={() => openDialog((close) => <ForwardToChatsDialog source={m} onClose={close} />)}>↪ {t('menu.forward')}</button>
                      {canWork && myWsRole !== 'guest' && <button onClick={() => setDeriving(m)}>{t('derive.action')}</button>}
                      {canWork && <button onClick={() => setNewIssue({ origin: m })}>{t('issue.fromMessage')}</button>}
                      <button aria-label={t('menu.open')} onClick={(e) => { const rr = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenuAt(rr.left, rr.bottom + 4, messageMenu(m)); }}>⋯</button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="typing">{typers.length ? t(typers.length > 1 ? 'chat.typingMany' : 'chat.typingOne', { names: typers.join(', ') }) : ''}</div>
        <div className="composer">
          {replyTo && (
            <div className="reply-bar">
              <span className="grow ellipsis"><b>{t('reply.to', { name: personById(d, replyTo.authorId)?.name ?? '' })}</b> · {excerpt(replyTo.body, 100)}</span>
              <button className="icon-btn" aria-label={t('reply.cancel')} onClick={() => setReplyTo(null)}>×</button>
            </div>
          )}
          {conv.canPost ? (
            <div className="composer-box">
              <button className="bring-btn" title={t('imp.action')} aria-label={t('imp.action')} onClick={() => openDialog((close) => <BringDialog conversationId={id} onClose={close} />)}>⤓</button>
              <textarea
                ref={input} rows={1} value={text} placeholder={t('chat.placeholder', { name: title })} aria-label={t('common.message')}
                onChange={(e) => { setText(e.target.value); client.typing(id); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(180, e.target.scrollHeight)}px`; }}
                onKeyDown={onKey} enterKeyHint="send"
              />
              <button className="send" onClick={send} disabled={!text.trim()} aria-label={t('chat.send')}>➤</button>
            </div>
          ) : <div className="hint" style={{ textAlign: 'center', padding: 8 }}>{t('chat.readOnly')}</div>}
        </div>
      </section>

      {panel && (
        <aside className="panel">
          <div className="row"><span className="eyebrow grow">{t('chat.details')}</span><button className="icon-btn" onClick={() => setPanel(false)} aria-label={t('common.close')}>×</button></div>
          <div>
            <div className="serif" style={{ fontSize: 26, lineHeight: 1.1 }}>{title}</div>
            <div className="small muted">{conversationSubtitle(d, conv)}</div>
          </div>
          {canWork && <ConversationAgenda conv={conv} />}
          {canWork && (
            <div>
              <div className="row" style={{ marginBottom: 6 }}>
                <span className="eyebrow grow">{t('nav.issues')} · {openHere.length}</span>
                <button className="btn small" onClick={() => setNewIssue({})}>{t('issue.new')}</button>
              </div>
              {openHere.length === 0 && <div className="hint">{t('issue.noIssues')}</div>}
              <div className="list" style={{ gap: 6 }}>{openHere.map((i) => <IssueRow key={i.id} i={i} showWhere={false} onOpen={setOpenIssue} />)}</div>
            </div>
          )}
          {conv.kind !== 'direct' && (
            <div className="card" style={{ padding: 12 }}>
              <div className="eyebrow" style={{ marginBottom: 6 }}>{t('chat.scope')}</div>
              <div className="small">{conv.kind === 'internal' ? t('chat.scopeInternal', { org: orgById(d, conv.internalOrgId)?.name ?? '' }) : conv.kind === 'multi' ? t('chat.scopeMulti') : t('chat.scopeGroup')}</div>
            </div>
          )}
          <div>
            <div className="row" style={{ marginBottom: 6 }}>
              <span className="eyebrow grow">{t('ws.participants')} · {conv.memberIds.length}</span>
              {conv.canManage && conv.kind !== 'direct' && <button className="btn small" onClick={() => setAdding(true)}>{t('chat.add')}</button>}
            </div>
            {conv.memberIds.map((mid) => {
              const p = personById(d, mid);
              const o = orgById(d, p?.orgId);
              return (
                <div key={mid} className="member">
                  <Avatar person={p} org={o} size={32} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="ellipsis" style={{ fontWeight: 600 }}>{p?.name ?? t('common.participant')}{mid === d.me.id ? ` ${t('common.you')}` : ''}</div>
                    <div className="small muted ellipsis">{[p?.title, p?.area, o?.name ?? (p?.guest ? (p.guestUntil ? t('chat.guestUntil', { date: new Date(p.guestUntil).toLocaleDateString(locale(), { day: 'numeric', month: 'short' }) }) : t('common.guest')) : null)].filter(Boolean).join(' · ')}</div>
                  </div>
                  {mid !== d.me.id && conv.kind !== 'direct' && (
                    <button className="btn ghost small" title={t('common.directMessage')} aria-label={t('common.directMessage')} onClick={() => client.openDirect(mid).then((r) => navigate(`/c/${r.id}`)).catch((e) => setError(errorText(e)))}>✉</button>
                  )}
                  {conv.canManage && mid !== d.me.id && conv.kind !== 'direct' && (
                    <button className="btn ghost small" title={t('chat.remove')} aria-label={t('chat.remove')} onClick={() => { if (confirm(t('chat.removeConfirm', { name: p?.name ?? '' }))) void client.removeMember(id, mid).catch((e) => setError(errorText(e))); }}>−</button>
                  )}
                </div>
              );
            })}
          </div>
          {conv.kind !== 'direct' && (
            <button className="btn ghost small" onClick={() => { if (confirm(t('chat.leaveConfirm'))) void client.removeMember(id, d.me.id).then(() => navigate('/')); }}>{t('chat.leave')}</button>
          )}
        </aside>
      )}
      {adding && <AddMembersDialog conversationId={id} onClose={() => setAdding(false)} />}
      {deriving && <DeriveDialog conv={conv} message={deriving} onClose={() => setDeriving(null)} />}
      {newIssue && (
        <NewIssueDialog conversationId={id} originMessageId={newIssue.origin?.id}
          defaultTitle={newIssue.origin ? excerpt(newIssue.origin.body) : ''}
          onClose={() => setNewIssue(null)} onCreated={(i) => setOpenIssue(i.id)} />
      )}
      {openIssue && <IssueDrawer id={openIssue} onClose={() => setOpenIssue(null)} />}
      {showPins && <PinsDialog conv={conv} onJump={(seq) => { setShowPins(false); jumpTo(seq); }} onClose={() => setShowPins(false)} />}
    </div>
  );
}

function ForwardedTag({ d, m }: { d: BootstrapDTO; m: MessageDTO }) {
  const f = m.forwarded!;
  const from = f.fromConversationId ? d.conversations.find((c) => c.id === f.fromConversationId) : null;
  const label = from ? t('fwd.fromConv', { name: conversationTitle(d, from) })
    : f.author ? t('fwd.fromBy', { source: t(`src.${f.source}`), author: f.author }) : t('fwd.from', { source: t(`src.${f.source}`) });
  return <div className={`fwd-tag src-${f.source}`}>↪ {label}{f.sentAt ? <span className="muted"> · {f.sentAt.includes('T') ? new Date(f.sentAt).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : f.sentAt}</span> : null}</div>;
}

function PinsDialog({ conv, onJump, onClose }: { conv: ConversationDTO; onJump: (seq: number) => void; onClose: () => void }) {
  const d = useClient((s) => s.data)!;
  const [list, setList] = useState<MessageDTO[] | null>(null);
  useEffect(() => { client.loadPins(conv.id).then(setList).catch(() => setList([])); }, [conv.id]);
  return (
    <Modal title={t('pins.title')} onClose={onClose}>
      {list === null && <div className="muted">{t('common.loading')}</div>}
      {list?.length === 0 && <div className="empty">{t('pins.empty')}</div>}
      <div className="list">
        {list?.map((m) => (
          <button key={m.id} className="card conv-card" onClick={() => onJump(m.seq)}>
            <Avatar person={personById(d, m.authorId)} org={orgById(d, personById(d, m.authorId)?.orgId)} size={28} />
            <span className="grow" style={{ minWidth: 0 }}><b className="small">{personById(d, m.authorId)?.name}</b><span className="small ellipsis" style={{ display: 'block' }}>{excerpt(m.body, 140)}</span></span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

/** Mensajes de sistema: algunos enlazan a un asunto, una reunión o la conversación derivada (si la puedes ver). */
function SystemRow({ m, onIssue }: { m: MessageDTO; onIssue: (id: string) => void }) {
  const d = useClient((s) => s.data)!;
  let p: any = null;
  try { p = m.body.startsWith('{') ? JSON.parse(m.body) : null; } catch {}
  const child = p?.k === 'derived.from' ? d.conversations.find((c) => c.id === p.childId) : null;
  return (
    <div className="msg-sys">
      {systemText(m.body)}
      {child && <> · <button className="link-btn" onClick={() => navigate(`/c/${child.id}`)}>⑂ {conversationTitle(d, child)}</button></>}
      {p?.issueId && <> · <button className="link-btn" onClick={() => onIssue(p.issueId)}>{t('lin.open')}</button></>}
      {p?.eventId && <> · <button className="link-btn" onClick={() => openEvent(p.eventId)}>{t('lin.open')}</button></>}
    </div>
  );
}

function PendingRow({ p }: { p: PendingMessage }) {
  const d = useClient((s) => s.data)!;
  const me = personById(d, d.me.id);
  return (
    <div className={`msg ${p.status === 'failed' ? 'failed' : 'pending'}`}>
      <div><Avatar person={me} org={orgById(d, me?.orgId)} size={34} /></div>
      <div>
        <div className="msg-meta">
          <span className="msg-author">{d.me.name}</span>
          <span className="msg-time">{p.status === 'failed' ? t('chat.notSent') : p.attempts > 0 ? t('chat.retrying') : t('chat.sending')}</span>
        </div>
        <div className="msg-body">{p.body}</div>
        {p.status === 'failed' && (
          <div className="row small" style={{ marginTop: 4 }}>
            <span className="error">{p.error}</span>
            <button className="btn small" onClick={() => client.retry(p.clientMessageId)}>{t('chat.retry')}</button>
            <button className="btn ghost small" onClick={() => client.discard(p.clientMessageId)}>{t('chat.discard')}</button>
          </div>
        )}
      </div>
    </div>
  );
}
