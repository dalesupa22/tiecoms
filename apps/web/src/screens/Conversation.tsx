import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { BootstrapDTO, ConversationDTO, IssueDTO, MessageDTO } from '@tiecoms/contracts';
import type { PendingMessage } from '@tiecoms/client-core';
import { client, useClient } from '../app-client.ts';
import { ForwardToChatsDialog, Linkify, StackedAvatars } from './Chats.tsx';
import { QUICK_REACTIONS } from '@tiecoms/contracts';
import { ReactionBar, isJumbo, openEmojiPicker, toggleReaction, useEmojiAutocomplete } from './Reactions.tsx';
import { LinkGroup, LinksPane, MessageLinks, isLinkOnly } from './Links.tsx';
import { conversationMenu, forwardMenu, messageLink, openDialog, remindMenu } from '../actions.tsx';
import { errorText, locale, systemText, t, tn } from '../i18n.ts';
import { contextHandler, copyText, menuProps, openMenuAt, toast, type MenuItem } from '../menu.tsx';
import { navigate, queryParam } from '../router.ts';
import { Avatar, ConvAvatar, Modal, OrgMark, conversationSubtitle, conversationTitle, dayLabel, orgById, personById, personColor } from '../ui.tsx';
import { PhotoCropDialog, pickImage } from './PhotoCrop.tsx';
import { AttachmentsView, DraftTray, pickFiles, useDrafts } from './Attachments.tsx';
import { VoiceRecorder } from './Voice.tsx';
import { MentionMirror, MessageText, backspaceToken, mentionsFor, mentionsMe, useMentionPicker, type MentionToken } from './Mentions.tsx';
import { QuickReplies, SideChip, SideConnector, SideDialog, replyPrivately, sidesOf, takePrivateDraft } from './Side.tsx';
import { BringDialog } from './Bring.tsx';
import { ConversationAgenda, newEvent, openEvent } from './Calendar.tsx';
import { IssueDrawer, IssueRow, NewIssueDialog, isClosed } from './Issues.tsx';
import { DeriveDialog, LineageBar, MergedCard } from './Lineage.tsx';
import { ChatBar, ThreadChip, threadsOf } from './ChatBar.tsx';
import { AddMembersDialog } from './Dialogs.tsx';

type Row =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'msg'; key: string; m: MessageDTO; cont: boolean }
  /** Varios mensajes seguidos de la misma persona que son solo enlaces: «Laura compartió 5 enlaces». */
  | { kind: 'links'; key: string; msgs: MessageDTO[] }
  | { kind: 'pending'; key: string; p: PendingMessage };

const draftKey = (id: string) => `tiecoms:draft:${id}`;
const excerpt = (s: string, n = 90) => s.replace(/\s+/g, ' ').trim().slice(0, n);

export function ConversationScreen({ id, embedded }: { id: string; embedded?: { onClose: () => void; anchor?: MessageDTO | null; onSeeAnchor?: () => void } }) {
  const d = useClient((s) => s.data)!;
  const conv = d.conversations.find((c) => c.id === id);
  const local = useClient((s) => s.conversations[id]);
  const pendingAll = useClient((s) => s.pending);
  const typing = useClient((s) => s.typing[id]);
  const pinIds = useClient((s) => s.pins[id]);
  const allIssues = useClient((s) => s.issues);
  const [panelPref, setPanel] = useState(() => window.innerWidth > 1180);
  const panel = panelPref && !embedded;
  // Conversación lateral abierta como panel a la derecha (o hoja en el teléfono).
  const [sideId, setSideId] = useState<string | null>(null);
  const [sideFor, setSideForState] = useState<{ message: MessageDTO; userIds: string[] } | null>(null);
  const setSideFor = (v: MessageDTO | { message: MessageDTO; userIds: string[] } | null) => setSideForState(v && 'message' in v ? v : v ? { message: v, userIds: [] } : null);
  const [privateReply, setPrivateReply] = useState<MessageDTO | null>(() => takePrivateDraft(id));
  const [groupCrop, setGroupCrop] = useState<File | null>(null);
  const drafts = useDrafts(id);
  const [dropping, setDropping] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deriving, setDeriving] = useState<MessageDTO | null>(null);
  const [newIssue, setNewIssue] = useState<{ origin?: MessageDTO; title?: string } | null>(null);
  // ?issue=<id>: se abre directo el asunto (desde el árbol de Grupos).
  const [openIssue, setOpenIssue] = useState<string | null>(() => queryParam('issue'));
  const [highlight, setHighlight] = useState<number | null>(null);
  const [replyTo, setReplyTo] = useState<MessageDTO | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [showPins, setShowPins] = useState(false);
  const [showLinks, setShowLinks] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [text, setText] = useState(() => { try { return localStorage.getItem(draftKey(id)) ?? ''; } catch { return ''; } });
  const scroller = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const atBottom = useRef(true);
  const prevHeight = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);
  // Un hilo o sidechat abierto al lado recibe el cursor: se escribe ahí sin tocar el chat principal.
  useEffect(() => { if (embedded) requestAnimationFrame(() => input.current?.focus()); }, [embedded ? id : null]);
  const sideAnchorFor = () => replyTo ?? [...(local?.messages ?? [])].reverse().find((m) => m.kind === 'text' && !m.deletedAt && !!m.body) ?? null;
  // Menciones: tokens «@Nombre» del compositor y lista que aparece al escribir «@».
  const [tokens, setTokens] = useState<MentionToken[]>([]);
  const [caret, setCaret] = useState(0);
  const picker = useMentionPicker({
    conv, text, caret, messages: local?.messages ?? [],
    onPick: (range, token) => {
      const insert = `@${token.label} `;
      const next = text.slice(0, range.start) + insert + text.slice(range.end);
      const pos = range.start + insert.length;
      setText(next); setCaret(pos);
      setTokens((ts) => [...ts.filter((x) => !(x.userId === token.userId && x.label === token.label)), token]);
      requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(pos, pos); });
    },
    onAddPerson: (p) => void client.addMembers(id, [p.id], 'now').then(() => toast(t('toast.sent'))).catch((e) => toast(errorText(e))),
    // Ancla: el mensaje al que se responde o el último visible con texto; sin ancla no se ofrece.
    onAskSide: embedded || !sideAnchorFor() ? undefined : (p) => { const anchor = sideAnchorFor(); if (anchor) setSideFor({ message: anchor, userIds: [p.id] }); },
  });

  // «:» en el compositor: lista de emojis (Enter o Tab lo inserta).
  const emoji = useEmojiAutocomplete({
    text, caret,
    onPick: (range, e) => {
      const next = text.slice(0, range.start) + e + text.slice(range.end);
      const pos = range.start + e.length;
      setText(next); setCaret(pos);
      requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(pos, pos); });
    },
  });
  const insertEmoji = (e: string) => {
    const el = input.current;
    const a = el?.selectionStart ?? text.length, b = el?.selectionEnd ?? text.length;
    const next = text.slice(0, a) + e + text.slice(b);
    setText(next);
    const pos = a + e.length;
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(pos, pos); setCaret(pos); });
  };
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
    return groupLinkRuns(out, expandedGroups, highlight);
  }, [local?.messages, pending, expandedGroups, highlight]);

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
    if (drafts.busy) { toast(t('att.uploading')); return; }
    const attachments = drafts.ready;
    if ((!body && !attachments.length) || !conv.canPost) return;
    atBottom.current = true;
    if (privateReply) {
      // «Responder en privado»: el directo lleva la referencia al mensaje original (el servidor pone la cita).
      const author = personById(d, privateReply.authorId)?.name ?? null;
      void client.send(id, body, null, { source: 'tiecoms', author, sentAt: privateReply.createdAt, fromConversationId: privateReply.conversationId, messageId: privateReply.id }, { attachments });
    } else void client.send(id, text, replyTo?.id ?? null, null, { attachments, mentions: mentionsFor(text, tokens) });
    drafts.clear();
    setTokens([]);
    setText('');
    setReplyTo(null);
    setPrivateReply(null);
    input.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (emoji.onKeyDown(e)) return;
    if (picker.onKeyDown(e)) return;
    if (e.key === 'Backspace' && tokens.length) {
      const el = e.currentTarget;
      if (el.selectionStart === el.selectionEnd) {
        const r = backspaceToken(text, el.selectionStart, tokens);
        if (r) { e.preventDefault(); setText(r.text); setCaret(r.caret); requestAnimationFrame(() => el.setSelectionRange(r.caret, r.caret)); return; }
      }
    }
    // Enter envía en escritorio; en móvil el teclado inserta salto de línea y se usa el botón.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia('(pointer: fine)').matches) { e.preventDefault(); send(); }
    if (e.key === 'Escape' && replyTo) setReplyTo(null);
    if (e.key === 'Escape' && privateReply) setPrivateReply(null);
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
    // Conserva las menciones que siguen en el texto editado.
    const kept: MentionToken[] = (orig?.mentions ?? []).map((m) => ({ userId: m.userId, label: (orig?.body ?? '').slice(m.start + 1, m.start + m.length) }));
    try { await client.editMessage(editing.id, body, mentionsFor(body, kept)); } catch (e) { toast(errorText(e)); }
  };

  const title = conversationTitle(d, conv);
  const openHere = Object.values(allIssues).filter((i: IssueDTO) => i.conversationId === id && !isClosed(i));
  const issueOf = (mid: string) => openHere.find((i) => i.originMessageId === mid);
  // Asuntos y reuniones en todas (también directos y chats grupales); derivar sigue siendo de espacios.
  const canWork = conv.canPost;
  const canDerive = canWork && conv.kind !== 'direct' && !!conv.workspaceId;
  const myWsRole = d.workspaces.find((w) => w.id === conv.workspaceId)?.myRole;
  // Los terceros invitados participan en los asuntos pero no los abren (el API responde 403).
  const canOpenIssues = canWork && myWsRole !== 'guest';
  const ws = d.workspaces.find((w) => w.id === conv.workspaceId);
  const typers = (typing ?? []).filter((x) => x.until > Date.now()).map((x) => personById(d, x.userId)?.name.split(' ')[0]).filter(Boolean);
  const orgsHere = [...new Set(conv.memberIds.map((m) => personById(d, m)?.orgId).filter(Boolean))].map((o) => orgById(d, o as string));
  const pinned = new Set(pinIds ?? []);
  const muted = !!conv.mutedUntil && Date.parse(conv.mutedUntil) > Date.now();
  const canPhoto = conv.kind !== 'direct' && conv.canPost && (conv.kind === 'multi' || conv.canManage);
  const sideConv = sideId ? d.conversations.find((c) => c.id === sideId) : null;
  const sideAnchor = sideConv?.parentMessageId ? byId.get(sideConv.parentMessageId) ?? null : null;
  const isSide = conv.deriveKind === 'side';
  const sideOthers = conv.memberIds.filter((m) => m !== d.me.id);
  const lastText = [...(local?.messages ?? [])].reverse().find((m) => m.kind === 'text' && !m.deletedAt) ?? null;
  // Sin acceso al origen, la tarjeta del ancla usa el extracto del mensaje side.started.
  const anchorExcerpt = (() => {
    const first = (local?.messages ?? []).find((m) => m.kind === 'system');
    try { const p = first ? JSON.parse(first.body) : null; return p?.k === 'side.started' ? `${p.authorName}: ${p.excerpt}` : null; } catch { return null; }
  })();

  const reactionActions = orgById(d, d.me.primaryOrgId)?.reactionActions !== false;
  const react = (m: MessageDTO, emoji: string) => {
    const mine = (m.reactions ?? []).some((r) => r.emoji === emoji && r.userIds.includes(d.me.id));
    void toggleReaction(m, emoji, !mine, { actions: reactionActions });
  };
  const pickReaction = (m: MessageDTO, x: number, y: number) => openEmojiPicker(x, y, (emoji) => react(m, emoji), { quick: true, actions: reactionActions });
  const messageMenu = (m: MessageDTO): MenuItem[] => {
    const mine = m.authorId === d.me.id;
    const isPinned = pinned.has(m.id);
    return [
      ...(conv.canPost ? [{
        label: t('react.menu'), icon: '☺',
        items: [
          ...QUICK_REACTIONS.map((e) => ({ label: e, hint: reactionActions && e === '👀' ? t('react.lookHint') : reactionActions && e === '✅' ? t('react.doneHint') : undefined, onSelect: () => react(m, e) })),
          { divider: true },
          { label: t('react.more'), icon: '＋', onSelect: () => { const el = document.querySelector(`[data-mid="${m.id}"]`)?.getBoundingClientRect(); pickReaction(m, (el?.left ?? 80) + 48, (el?.bottom ?? 200) - 4); } },
        ],
      }] : []),
      ...(conv.canPost ? [{ label: t('menu.reply'), icon: '↩', onSelect: () => { setReplyTo(m); input.current?.focus(); } }] : []),
      // Responder en privado: por DM al autor. Es distinto del sidechat (un hilo privado con quien elijas).
      ...(!mine && conv.kind !== 'direct' ? [{ label: t('preply.action'), icon: '✉', hint: t('menu.hintDm', { name: personById(d, m.authorId)?.name.split(' ')[0] ?? '' }), onSelect: () => void replyPrivately(m) }] : []),
      { divider: true },
      // Responder aparte, sin llenar el chat: hilo con los del chat o sidechat privado con quien elijas.
      ...(!embedded && canDerive && myWsRole !== 'guest' ? [{ label: t('menu.derive'), icon: '💬', hint: t('menu.hintThread'), onSelect: () => setDeriving(m) }] : []),
      ...(!embedded ? [{ label: t('side.ask'), icon: '🔒', hint: t('menu.hintSide'), onSelect: () => setSideFor(m) }] : []),
      { divider: true },
      { label: t('menu.copyText'), icon: '⧉', onSelect: async () => { await copyText(m.body); toast(t('toast.copied')); } },
      { label: t('menu.copyLink'), icon: '⛓', onSelect: async () => { await copyText(messageLink(m)); toast(t('toast.linkCopied')); } },
      { divider: true },
      ...(conv.canPost ? [{ label: isPinned ? t('menu.unpin') : t('menu.pin'), icon: '📌', onSelect: () => client.setMessagePinned(m, !isPinned).then(() => toast(isPinned ? t('toast.unpinned') : t('toast.pinned'))).catch((e) => toast(errorText(e))) }] : []),
      remindMenu(conv, m),
      { label: t('menu.markUnread'), icon: '●', onSelect: () => client.markUnread(id, m.seq).then(() => toast(t('toast.markedUnread'))).catch((e) => toast(errorText(e))) },
      ...(canWork ? [
        { divider: true },
        ...(canOpenIssues ? [{ label: t('menu.issue'), icon: '◆', onSelect: () => setNewIssue({ origin: m }) }] : []),
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
    <div ref={setHost} className={`conv ${panel || sideConv ? '' : 'no-panel'} ${sideConv ? 'has-side' : ''} ${embedded ? 'is-embedded' : ''}`}>
      {sideConv && <SideConnector host={host} anchorId={sideConv.parentMessageId} color={personColor(sideAnchor?.authorId ?? sideConv.memberIds[0])} />}
      <section className={`conv-main ${dropping ? 'is-dropping' : ''}`}
        onDragOver={(e) => { if (conv.canPost && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true); } }}
        onDragLeave={(e) => { if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false); }}
        onDrop={(e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setDropping(false); drafts.add(e.dataTransfer.files); input.current?.focus(); }}>
        {dropping && <div className="drop-hint" aria-hidden>{t('att.drop')}</div>}
        <header className="conv-head" onContextMenu={contextHandler(() => conversationMenu(conv, { onNewMeeting: () => newEvent({ conversationId: id }) }))}>
          {!embedded && <button className="icon-btn only-mobile" aria-label={t('common.back')} onClick={() => (history.length > 1 ? history.back() : navigate('/conversaciones'))}>‹</button>}
          {conv.kind !== 'direct' && conv.avatarUrl && <ConvAvatar c={conv} size={30} />}
          <div className="grow" style={{ minWidth: 0 }}>
            <h2 className="ellipsis">{conv.kind === 'internal' ? '◌ ' : conv.level === 'directivo' ? '◆ ' : ''}{isSide ? `💬 ${t('side.title')}` : title}{muted ? ' 🔕' : ''}</h2>
            {isSide
              ? <div className="small muted ellipsis side-head-people"><StackedAvatars c={conv} size={18} /> 🔒 {t('side.privateN', { n: conv.memberIds.length })}</div>
              : <div className="small muted ellipsis">{conversationSubtitle(d, conv)}{conv.kind !== 'direct' ? ` · ${tn(conv.memberIds.length, 'n.participant', 'n.participants')}` : ''}</div>}
          </div>
          <div className="row only-desktop">{orgsHere.map((o) => o && <OrgMark key={o.id} org={o} size={22} />)}</div>
          {embedded && pinned.size > 0 && <button className="btn ghost small" onClick={() => setShowPins(true)} title={t('pins.title')}>📌 {pinned.size}</button>}
          {embedded && conv.canManage && conv.kind !== 'direct' && <button className="btn ghost small" onClick={() => openDialog((close) => <AddMembersDialog conversationId={id} onClose={close} />)} title={t('bar.addPeople')}>＋ {t('bar.people')}</button>}
          {ws && !embedded && <button className="btn ghost small only-desktop" onClick={() => navigate(`/w/${ws.id}`)}>{t('chat.space')}</button>}
          <button className="icon-btn" aria-label={t('menu.open')} onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenuAt(r.left, r.bottom + 4, conversationMenu(conv, { onNewMeeting: () => newEvent({ conversationId: id }) })); }}>⋯</button>
          {embedded ? <>
            <button className="icon-btn" aria-label={t('side.openFull')} title={t('side.openFull')} onClick={() => navigate(`/c/${id}`)}>⤢</button>
            <button className="icon-btn" aria-label={t('side.close')} title={t('side.close')} onClick={embedded.onClose}>×</button>
          </> : <button className="icon-btn" aria-label={t('chat.details')} onClick={() => setPanel(!panelPref)}>ⓘ</button>}
        </header>
        {isSide && (embedded?.anchor || anchorExcerpt) && (
          <div className="side-anchor" style={{ borderLeftColor: personColor(embedded?.anchor?.authorId ?? null) }}>
            <div className="row" style={{ gap: 6 }}>
              <span className="eyebrow grow">{t('side.anchor')}</span>
              {embedded?.anchor && <span className="small muted">{new Date(embedded.anchor.createdAt).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}</span>}
              {embedded?.onSeeAnchor && <button className="link-btn small" onClick={embedded.onSeeAnchor}>{t('side.seeInChat')}</button>}
              {!embedded && conv.parentId && d.conversations.some((c) => c.id === conv.parentId) && (
                <button className="link-btn small" onClick={() => navigate(`/c/${conv.parentId}${conv.parentMessageSeq ? `?m=${conv.parentMessageSeq}` : ''}`)}>{t('side.seeInChat')}</button>
              )}
            </div>
            <div className="small side-anchor-clamp">
              {embedded?.anchor ? <><b>{personById(d, embedded.anchor.authorId)?.name}</b> · {embedded.anchor.body}</> : anchorExcerpt}
            </div>
          </div>
        )}
        <LineageBar conv={conv} />
        {!embedded && (
          <ChatBar conv={conv} pinnedCount={pinned.size} canOpenIssues={canOpenIssues} onPins={() => setShowPins(true)} onLinks={() => setShowLinks(true)}
            onOpenIssue={setOpenIssue} onNewIssue={() => setNewIssue({})} onOpenThread={setSideId} />
        )}

        <div className="msgs" ref={scroller} onScroll={onScroll} role="log" aria-live="polite">
          {local?.loading && !local.loaded && <div className="msg-sys">{t('common.loading')}</div>}
          {local?.loaded && !local.hasMore && conv.historyFromSeq > 0 && <div className="msg-sys">{t('chat.lateJoin')}</div>}
          {local?.loaded && local.hasMore && <div className="msg-sys">{local.loading ? t('chat.loadingOlder') : '·'}</div>}
          {error && <div className="error" style={{ textAlign: 'center' }}>{error}</div>}
          {rows.map((r) => {
            if (r.kind === 'day') return <div key={r.key} className="day">{r.label}</div>;
            if (r.kind === 'links') return <LinkGroup key={r.key} d={d} msgs={r.msgs} onExpand={() => setExpandedGroups((g) => new Set(g).add(r.key))} />;
            if (r.kind === 'pending') return <PendingRow key={r.key} p={r.p} />;
            const m = r.m;
            if (m.kind === 'system') return <SystemRow key={r.key} m={m} onIssue={setOpenIssue} />;
            const author = personById(d, m.authorId);
            const org = orgById(d, author?.orgId);
            const quoted = m.replyTo ? byId.get(m.replyTo) : null;
            const isEditing = editing?.id === m.id;
            const menu = m.deletedAt ? null : menuProps(() => messageMenu(m));
            return (
              <div key={r.key} id={`msg-${id}-${m.seq}`} data-mid={m.id} className={`msg ${r.cont ? 'cont' : ''} ${highlight === m.seq ? 'is-highlight' : ''} ${pinned.has(m.id) ? 'is-pinned' : ''} ${sideConv?.parentMessageId === m.id ? 'is-anchor' : ''} ${mentionsMe(d, m) ? 'mentions-me' : ''}`} {...(menu ?? {})}>
                <div>{!r.cont && <Avatar person={author} org={org} size={34} />}</div>
                <div style={{ minWidth: 0 }}>
                  {!r.cont && (
                    <div className="msg-meta">
                      <span className="msg-author" style={conv.kind !== 'direct' && author ? { color: personColor(author.id) } : undefined}>{author?.name ?? t('chat.formerParticipant')}</span>
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
                  {m.mergedFrom && <MergedCard childId={m.mergedFrom} kind={m.mergedKind} />}
                  {isEditing ? (
                    <div className="msg-edit">
                      <textarea className="input" autoFocus rows={2} value={editing.text} onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                        onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void saveEdit(); } }} />
                      <div className="row small"><span className="muted grow">{t('edit.hint')}</span><button className="btn ghost small" onClick={() => setEditing(null)}>{t('common.cancel')}</button><button className="btn primary small" onClick={saveEdit}>{t('edit.save')}</button></div>
                    </div>
                  ) : (
                    (m.body || m.deletedAt || !m.attachments?.length) && <div className={`msg-body ${!m.deletedAt && isJumbo(m.body) ? 'is-jumbo' : ''}`}>{m.deletedAt ? <i className="muted">{t('chat.deleted')}</i> : m.kind === 'text' ? <MessageText d={d} body={m.body} mentions={m.mentions} /> : m.body}{m.editedAt && !m.deletedAt && <span className="msg-edited"> {t('msg.edited')}</span>}</div>
                  )}
                  {!m.deletedAt && !!m.attachments?.length && <AttachmentsView list={m.attachments} onCreateIssue={canOpenIssues ? (title) => setNewIssue({ origin: m, title }) : undefined} />}
                  {!m.deletedAt && !isEditing && <MessageLinks m={m} mode={conv.linkPreviews ?? 'large'} onIssue={canOpenIssues ? (title) => setNewIssue({ origin: m, title }) : undefined} />}
                  {!m.deletedAt && <ReactionBar d={d} m={m} canReact={conv.canPost} actions={reactionActions} onIssue={setOpenIssue} />}
                  {!embedded && <ThreadChip d={d} threads={threadsOf(d, id, m.id).filter((c) => c.deriveKind !== 'side')} onOpen={setSideId} />}
                  {!embedded && <SideChip d={d} sides={sidesOf(d, id, m.id)} onOpen={setSideId} />}
                  {issueOf(m.id) && <button className="msg-issue" onClick={() => setOpenIssue(issueOf(m.id)!.id)}>◆ {issueOf(m.id)!.title}</button>}
                  {!m.deletedAt && !isEditing && (
                    <div className="msg-actions">
                      {conv.canPost && <button className="msg-act-react" aria-label={t('react.add')} title={t('react.add')} onClick={(e) => { const rr = (e.currentTarget as HTMLElement).getBoundingClientRect(); pickReaction(m, rr.left, rr.bottom + 6); }}>☺</button>}
                      {conv.canPost && QUICK_REACTIONS.slice(0, 3).map((e) => <button key={e} className="msg-act-quick" aria-label={e} onClick={() => react(m, e)}>{e}</button>)}
                      {conv.canPost && <button onClick={() => { setReplyTo(m); input.current?.focus(); }}>↩ {t('menu.reply')}</button>}
                      <button onClick={() => openDialog((close) => <ForwardToChatsDialog source={m} onClose={close} />)}>↪ {t('menu.forward')}</button>
                      {canDerive && myWsRole !== 'guest' && <button onClick={() => setDeriving(m)}>{t('derive.action')}</button>}
                      {canOpenIssues && <button onClick={() => setNewIssue({ origin: m })}>{t('issue.fromMessage')}</button>}
                      <button aria-label={t('menu.open')} onClick={(e) => { const rr = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenuAt(rr.left, rr.bottom + 4, messageMenu(m)); }}>⋯</button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {isSide && local?.loaded && !(local.messages ?? []).some((m) => m.kind === 'text') && <div className="side-empty">💬 {t('side.emptyChat')}</div>}
        {isSide && conv.canPost && !text.trim() && lastText && lastText.authorId !== d.me.id && (
          <QuickReplies onSend={(q) => { atBottom.current = true; void client.send(id, q); }} onAsk={() => setAdding(true)} />
        )}
        <div className="typing">{typers.length ? t(typers.length > 1 ? 'chat.typingMany' : 'chat.typingOne', { names: typers.join(', ') }) : ''}</div>
        <div className="composer">
          {privateReply && (
            <div className="reply-bar is-private">
              <span className="grow ellipsis"><b>✉ {t('preply.bar', { name: personById(d, privateReply.authorId)?.name ?? '' })}</b> · {excerpt(privateReply.body, 100)}</span>
              <button className="icon-btn" aria-label={t('preply.cancel')} onClick={() => setPrivateReply(null)}>×</button>
            </div>
          )}
          {replyTo && (
            <div className="reply-bar">
              <span className="grow ellipsis"><b>{t('reply.to', { name: personById(d, replyTo.authorId)?.name ?? '' })}</b> · {excerpt(replyTo.body, 100)}</span>
              <button className="icon-btn" aria-label={t('reply.cancel')} onClick={() => setReplyTo(null)}>×</button>
            </div>
          )}
          {conv.canPost ? (
            <>
            <DraftTray drafts={drafts.drafts} onRemove={drafts.remove} onRetry={drafts.retry} />
            <div className="composer-box">
              <button className="bring-btn" title={t('bar.plus')} aria-label={t('bar.plus')} onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                openMenuAt(r.left, r.top - 8, [
                  { label: t('att.fromPhotos'), icon: '🖼', onSelect: () => pickFiles('media', drafts.add) },
                  { label: t('att.fromFiles'), icon: '📎', onSelect: () => pickFiles('any', drafts.add) },
                  { divider: true },
                  { label: t('bar.newEvent'), icon: '📅', onSelect: () => newEvent({ conversationId: id }) },
                  ...(canOpenIssues ? [{ label: t('bar.newIssue'), icon: '◆', onSelect: () => setNewIssue({}) }] : []),
                ]);
              }}>＋</button>
              <button className="bring-btn" title={t('imp.action')} aria-label={t('imp.action')} onClick={() => openDialog((close) => <BringDialog conversationId={id} onClose={close} />)}>⤓</button>
              <button className="bring-btn composer-emoji" title={t('react.insert')} aria-label={t('react.insert')} onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openEmojiPicker(r.left, r.top - 8, insertEmoji); }}>☺</button>
              <div className="mention-wrap">
              {picker.view}
              {emoji.view}
              <MentionMirror text={text} tokens={tokens} taRef={input} />
              <textarea
                ref={input} rows={1} value={text} placeholder={isSide ? (sideOthers.length === 1 ? t('side.placeholder', { name: personById(d, sideOthers[0])?.name.split(' ')[0] ?? '' }) : t('side.placeholderMany')) : t('chat.placeholder', { name: title })} aria-label={t('common.message')}
                onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
                onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); client.typing(id); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(180, e.target.scrollHeight)}px`; }}
                onKeyDown={onKey} enterKeyHint="send"
                onPaste={(e) => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); drafts.add(files); } }}
              />
              </div>
              {/* Con el compositor vacío, el micrófono: mantener pulsado graba una nota de voz. */}
              {!text.trim() && !drafts.drafts.length && !privateReply
                ? <VoiceRecorder conversationId={id} onSent={() => { atBottom.current = true; setReplyTo(null); }} />
                : <button className="send" onClick={send} disabled={(!text.trim() && !drafts.ready.length) || drafts.busy} aria-label={t('chat.send')}>➤</button>}
            </div>
            </>
          ) : <div className="hint" style={{ textAlign: 'center', padding: 8 }}>{t('chat.readOnly')}</div>}
        </div>
      </section>

      {sideConv && (
        <aside className="side-panel" aria-label={t('side.title')}>
          <ConversationScreen key={sideConv.id} id={sideConv.id} embedded={{ onClose: () => setSideId(null), anchor: sideAnchor, onSeeAnchor: sideAnchor ? () => jumpTo(sideAnchor.seq) : undefined }} />
        </aside>
      )}
      {panel && !sideConv && (
        <aside className="panel">
          <div className="row"><span className="eyebrow grow">{t('chat.details')}</span><button className="icon-btn" onClick={() => setPanel(false)} aria-label={t('common.close')}>×</button></div>
          <div className="row" style={{ gap: 12, alignItems: 'center' }}>
            {conv.kind !== 'direct' && conv.avatarUrl && <ConvAvatar c={conv} size={56} />}
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="serif" style={{ fontSize: 26, lineHeight: 1.1 }}>{title}</div>
              <div className="small muted">{conversationSubtitle(d, conv)}</div>
            </div>
          </div>
          {canPhoto && (
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              <button className="btn small" onClick={() => void pickImage().then((f) => { if (!f) return; if (!f.type.startsWith('image/')) toast(t('photo.invalid')); else setGroupCrop(f); })}>📷 {conv.avatarUrl ? t('group.changePhoto') : t('group.addPhoto')}</button>
              {conv.avatarUrl && <button className="btn ghost small" onClick={() => { if (confirm(t('group.removeConfirm'))) void client.removeConversationAvatar(id).then(() => toast(t('group.photoRemoved'))).catch((e) => toast(errorText(e))); }}>{t('group.removePhoto')}</button>}
            </div>
          )}
          {canWork && <ConversationAgenda conv={conv} />}
          {canWork && (
            <div>
              <div className="row" style={{ marginBottom: 6 }}>
                <span className="eyebrow grow">{t('nav.issues')} · {openHere.length}</span>
                {canOpenIssues && <button className="btn small" onClick={() => setNewIssue({})}>{t('issue.new')}</button>}
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
      {sideFor && <SideDialog conv={conv} message={sideFor.message} initialUserIds={sideFor.userIds} onClose={() => setSideFor(null)} onOpened={setSideId} />}
      {groupCrop && <PhotoCropDialog file={groupCrop} title={t('photo.cropGroupTitle')} onClose={() => setGroupCrop(null)}
        onSave={async (blob) => { await client.setConversationAvatar(id, blob); }} />}
      {adding && <AddMembersDialog conversationId={id} onClose={() => setAdding(false)} />}
      {deriving && <DeriveDialog conv={conv} message={deriving} onClose={() => setDeriving(null)} onOpened={setSideId} />}
      {newIssue && (
        <NewIssueDialog conversationId={id} originMessageId={newIssue.origin?.id}
          defaultTitle={newIssue.title ?? (newIssue.origin ? excerpt(newIssue.origin.body) : '')}
          onClose={() => setNewIssue(null)} onCreated={(i) => setOpenIssue(i.id)} />
      )}
      {openIssue && <IssueDrawer id={openIssue} onClose={() => setOpenIssue(null)} />}
      {showLinks && <LinksPane conv={conv} onJump={jumpTo} onClose={() => setShowLinks(false)} />}
      {showPins && <PinsDialog conv={conv} onJump={(seq) => { setShowPins(false); jumpTo(seq); }} onClose={() => setShowPins(false)} />}
    </div>
  );
}

function ForwardedTag({ d, m }: { d: BootstrapDTO; m: MessageDTO }) {
  const f = m.forwarded!;
  const from = f.fromConversationId ? d.conversations.find((c) => c.id === f.fromConversationId) : null;
  if (f.messageId) {
    // «Responder en privado»: cita del original, con enlace si quien lee puede abrir el origen.
    const mine = m.authorId === d.me.id;
    const text = mine ? t('preply.you', { excerpt: f.excerpt ?? '' }) : t('preply.other', { name: personById(d, m.authorId)?.name ?? '', excerpt: f.excerpt ?? '' });
    return (
      <div className="fwd-tag src-private">
        ✉ {text}
        {from && <> <span className="muted">{t('preply.in', { name: conversationTitle(d, from) })}</span> · <button className="link-btn" onClick={() => navigate(`/c/${from.id}${f.messageSeq ? `?m=${f.messageSeq}` : ''}`)}>{t('preply.open')}</button></>}
      </div>
    );
  }
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
  // Los hilos no ensucian el chat: el aviso «se abrió un hilo» lo reemplaza el chip bajo su mensaje.
  if (p?.k === 'derived.from') return null;
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
        {p.body && <div className="msg-body">{p.body}</div>}
        {!!p.attachments?.length && <AttachmentsView list={p.attachments} />}
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

/**
 * Tres o más mensajes seguidos de la misma persona (en 10 minutos) que son solo enlaces se muestran como un
 * grupo compacto. No se agrupan los que tienen reacciones o el mensaje al que se está saltando.
 */
function groupLinkRuns(rows: Row[], expanded: Set<string>, highlight: number | null): Row[] {
  const out: Row[] = [];
  let run: Extract<Row, { kind: 'msg' }>[] = [];
  const flush = () => {
    const key = run.length ? `lg${run[0]!.m.id}` : '';
    if (run.length >= 3 && !expanded.has(key) && !run.some((r) => r.m.seq === highlight)) out.push({ kind: 'links', key, msgs: run.map((r) => r.m) });
    else out.push(...run);
    run = [];
  };
  for (const r of rows) {
    const ok = r.kind === 'msg' && isLinkOnly(r.m) && !r.m.reactions?.length;
    const prev = run[run.length - 1];
    if (ok && prev && (prev.m.authorId !== r.m.authorId || Date.parse(r.m.createdAt) - Date.parse(prev.m.createdAt) > 10 * 60_000)) flush();
    if (ok) { run.push(r as Extract<Row, { kind: 'msg' }>); continue; }
    flush();
    out.push(r);
  }
  flush();
  return out;
}
