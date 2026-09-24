import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { MessageDTO } from '@tiecoms/contracts';
import type { PendingMessage } from '@tiecoms/client-core';
import { client, useClient } from '../app-client.ts';
import { navigate } from '../router.ts';
import { Avatar, OrgMark, conversationSubtitle, conversationTitle, dayLabel, orgById, personById } from '../ui.tsx';
import { errorText, locale, systemText, t, tn } from '../i18n.ts';
import { AddMembersDialog } from './Dialogs.tsx';

type Row =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'msg'; key: string; m: MessageDTO; cont: boolean }
  | { kind: 'pending'; key: string; p: PendingMessage };

const draftKey = (id: string) => `tiecoms:draft:${id}`;

export function ConversationScreen({ id }: { id: string }) {
  const d = useClient((s) => s.data)!;
  const conv = d.conversations.find((c) => c.id === id);
  const local = useClient((s) => s.conversations[id]);
  const pendingAll = useClient((s) => s.pending);
  const typing = useClient((s) => s.typing[id]);
  const [panel, setPanel] = useState(() => window.innerWidth > 1180);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState(() => { try { return localStorage.getItem(draftKey(id)) ?? ''; } catch { return ''; } });
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prevHeight = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // La pantalla se monta de nuevo por conversación (key={id}), así el borrador no se cruza.
    client.openConversation(id).catch((e) => setError(errorText(e)));
  }, [id]);

  // Borrador local por conversación: sobrevive recargas y cambios de conversación.
  useEffect(() => { try { if (text) localStorage.setItem(draftKey(id), text); else localStorage.removeItem(draftKey(id)); } catch {} }, [id, text]);

  const pending = useMemo(() => pendingAll.filter((p) => p.conversationId === id), [pendingAll, id]);
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let lastDay = '';
    let prev: MessageDTO | null = null;
    for (const m of local?.messages ?? []) {
      const day = new Date(m.createdAt).toDateString();
      if (day !== lastDay) { out.push({ kind: 'day', key: `d${day}`, label: dayLabel(m.createdAt) }); lastDay = day; prev = null; }
      const cont = !!prev && prev.kind === 'text' && m.kind === 'text' && prev.authorId === m.authorId && Date.parse(m.createdAt) - Date.parse(prev.createdAt) < 5 * 60_000;
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

  if (!conv) {
    return (
      <div className="page"><div className="empty">{t('chat.notFound')}</div></div>
    );
  }

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
    void client.send(id, body);
    setText('');
    input.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter envía en escritorio; en móvil el teclado inserta salto de línea y se usa el botón.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia('(pointer: fine)').matches) { e.preventDefault(); send(); }
  };

  const title = conversationTitle(d, conv);
  const ws = d.workspaces.find((w) => w.id === conv.workspaceId);
  const typers = (typing ?? []).filter((t) => t.until > Date.now()).map((t) => personById(d, t.userId)?.name.split(' ')[0]).filter(Boolean);
  const orgsHere = [...new Set(conv.memberIds.map((m) => personById(d, m)?.orgId).filter(Boolean))].map((o) => orgById(d, o as string));

  return (
    <div className={`conv ${panel ? '' : 'no-panel'}`}>
      <section className="conv-main">
        <header className="conv-head">
          <button className="icon-btn only-mobile" aria-label={t('common.back')} onClick={() => (history.length > 1 ? history.back() : navigate('/conversaciones'))}>‹</button>
          <div className="grow" style={{ minWidth: 0 }}>
            <h2 className="ellipsis">{conv.kind === 'internal' ? '◌ ' : conv.level === 'directivo' ? '◆ ' : ''}{title}</h2>
            <div className="small muted ellipsis">{conversationSubtitle(d, conv)}{conv.kind !== 'direct' ? ` · ${tn(conv.memberIds.length, 'n.participant', 'n.participants')}` : ''}</div>
          </div>
          <div className="row only-desktop">{orgsHere.map((o) => o && <OrgMark key={o.id} org={o} size={22} />)}</div>
          {ws && <button className="btn ghost small only-desktop" onClick={() => navigate(`/w/${ws.id}`)}>{t('chat.space')}</button>}
          <button className="icon-btn" aria-label={t('chat.details')} onClick={() => setPanel(!panel)}>ⓘ</button>
        </header>

        <div className="msgs" ref={scroller} onScroll={onScroll} role="log" aria-live="polite">
          {local?.loading && !local.loaded && <div className="msg-sys">{t('common.loading')}</div>}
          {local?.loaded && !local.hasMore && conv.historyFromSeq > 0 && <div className="msg-sys">{t('chat.lateJoin')}</div>}
          {local?.loaded && local.hasMore && <div className="msg-sys">{local.loading ? t('chat.loadingOlder') : '·'}</div>}
          {error && <div className="error" style={{ textAlign: 'center' }}>{error}</div>}
          {rows.map((r) => {
            if (r.kind === 'day') return <div key={r.key} className="day">{r.label}</div>;
            if (r.kind === 'pending') return <PendingRow key={r.key} p={r.p} />;
            const m = r.m;
            if (m.kind === 'system') return <div key={r.key} className="msg-sys">{systemText(m.body)}</div>;
            const author = personById(d, m.authorId);
            const org = orgById(d, author?.orgId);
            return (
              <div key={r.key} className={`msg ${r.cont ? 'cont' : ''}`}>
                <div>{!r.cont && <Avatar person={author} org={org} size={34} />}</div>
                <div style={{ minWidth: 0 }}>
                  {!r.cont && (
                    <div className="msg-meta">
                      <span className="msg-author">{author?.name ?? t('chat.formerParticipant')}</span>
                      <span className="msg-org">{org?.name ?? (author?.guest ? t('common.guest') : '')}</span>
                      <span className="msg-time">{new Date(m.createdAt).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                  )}
                  <div className="msg-body">{m.deletedAt ? <i className="muted">{t('chat.deleted')}</i> : m.body}</div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="typing">{typers.length ? t(typers.length > 1 ? 'chat.typingMany' : 'chat.typingOne', { names: typers.join(', ') }) : ''}</div>
        <div className="composer">
          {conv.canPost ? (
            <div className="composer-box">
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
          {conv.kind !== 'direct' && (
            <div className="card" style={{ padding: 12 }}>
              <div className="eyebrow" style={{ marginBottom: 6 }}>{t('chat.scope')}</div>
              <div className="small">{conv.kind === 'internal' ? t('chat.scopeInternal', { org: orgById(d, conv.internalOrgId)?.name ?? '' }) : t('chat.scopeGroup')}</div>
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
                    <div className="small muted ellipsis">{[p?.title, o?.name ?? (p?.guest ? (p.guestUntil ? t('chat.guestUntil', { date: new Date(p.guestUntil).toLocaleDateString(locale(), { day: 'numeric', month: 'short' }) }) : t('common.guest')) : null)].filter(Boolean).join(' · ')}</div>
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
