import { TOPIC_ALL } from './Topics.tsx';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { BootstrapDTO, ConversationDTO, IssueDTO, MessageDTO } from '@tiecoms/contracts';
import type { PendingMessage } from '@tiecoms/client-core';
import { client, useClient } from '../app-client.ts';
import { ForwardToChatsDialog, Linkify, StackedAvatars } from './Chats.tsx';
import { QUICK_REACTIONS } from '@tiecoms/contracts';
import { ReactionBar, isJumbo, openEmojiPicker, toggleReaction, useEmojiAutocomplete } from './Reactions.tsx';
import { LinkGroup, LinksPane, MessageLinks, isLinkOnly } from './Links.tsx';
import { conversationMenu, forwardMenu, messageLink, muteMenu, muteOptions, mutedText, openDialog, remindMenu, soundMenu, soundName, unmute, useExpiry } from '../actions.tsx';
import { errorText, locale, systemText, t, tn } from '../i18n.ts';
import { contextHandler, copyText, menuProps, openMenuAt, toast, type MenuItem } from '../menu.tsx';
import { navigate, queryParam } from '../router.ts';
import { MAX_PANES, ZOOM_MAX, ZOOM_MIN, convZoomNow, setConvZoom, splitAvailable, useConvZoom } from '../split.ts';
import { SplitPicker } from './SplitPicker.tsx';
import { Avatar, ConvAvatar, Modal, OrgMark, conversationSubtitle, conversationTitle, dayLabel, isGgChat, isSelfChat, orgById, personById, personColor } from '../ui.tsx';
import { PhotoCropDialog, pickImage } from './PhotoCrop.tsx';
import { AttachmentsView, DraftTray, pickFiles, useDrafts } from './Attachments.tsx';
import { VoiceRecorder } from './Voice.tsx';
import { MentionMirror, MessageText, backspaceToken, mentionsFor, mentionsMe, useMentionPicker, type MentionToken } from './Mentions.tsx';
import { QuickReplies, SideChip, SideConnector, SideDialog, replyPrivately, sidesOf, takePrivateDraft } from './Side.tsx';
import { BringDialog } from './Bring.tsx';
import { ConversationAgenda, EventChatCard, newEvent, openEvent } from './Calendar.tsx';
import { SleepNotice } from './Sleep.tsx';
import { createChatRecovery } from '../chat-recovery.ts';
import { DerivedPendingStrip } from './Pending.tsx';
import { MeetingDialog } from './Meetings.tsx';
import { GgActionsRow, GgConsentBanner, GgThinking, saveToSelf } from './Assistant.tsx';
import { CommentsNoticeLine, MailPickDialog, MailSharedRow, WaIcon, WaSharedRow, cardQuote, openForwardCard, openMailDrawer, type CardActions, type WaShared } from './Mail.tsx';
import { CallBanner, CallButtons, openTranscript } from './Call.tsx';
import { ScheduledStrip, openScheduleMenu, scheduleMenu, whenLabel } from './Scheduled.tsx';
import { SideIssueStrip, TasksDialog } from './Issues.tsx';
import { ConversationIssues, IssueChatCard, IssueDrawer, NewIssueDialog, isClosed } from './Issues.tsx';
import { DeriveDialog, LineageBar, MergedCard } from './Lineage.tsx';
import { ChatBar, ThreadChip, threadsOf } from './ChatBar.tsx';
import { AddMembersDialog } from './Dialogs.tsx';
import { firstUnread, readThroughVisible, isReadTransparentMessage } from '../chat-nav.ts';
import { IntegrationsPanel } from './Integrations.tsx';
import { TopicDock, TopicTag, openTopicMenu, topicMenu, useTopics } from './Topics.tsx';
import { ChatSearchBar, Notice17Row, ViewOnceBubble, parseNotice, useRefPicker } from './Chat17.tsx';
import { backspaceRef, refsFor, viewOnceAllowed, type RefToken } from '../chat17.ts';
import { markAgain } from '../perf.ts';

type Row =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'msg'; key: string; m: MessageDTO; cont: boolean }
  /** Varios mensajes seguidos de la misma persona que son solo enlaces: «Laura compartió 5 enlaces». */
  | { kind: 'links'; key: string; msgs: MessageDTO[] }
  | { kind: 'pending'; key: string; p: PendingMessage }
  /** Línea «N mensajes nuevos» sobre el primer no leído (queda hasta salir del chat). */
  | { kind: 'new'; key: string };

const draftKey = (id: string) => `tiecoms:draft:${id}`;
const excerpt = (s: string, n = 90) => s.replace(/\s+/g, ' ').trim().slice(0, n);

/** Panel dentro de la vista en paralelo (Split.tsx): activo = el del URL; count = cuántos hay abiertos. */
export interface PaneProps { active: boolean; count: number; onClose: () => void; onOnly: () => void; pinned?: boolean; onPin?: () => void }

export function ConversationScreen({ id, embedded, pane }: { id: string; embedded?: { onClose: () => void; anchor?: MessageDTO | null; onSeeAnchor?: () => void }; pane?: PaneProps }) {
  const d = useClient((s) => s.data)!;
  const conv = d.conversations.find((c) => c.id === id);
  const local = useClient((s) => s.conversations[id]);
  const pendingAll = useClient((s) => s.pending);
  const typing = useClient((s) => s.typing[id]);
  const pinIds = useClient((s) => s.pins[id]);
  const allIssues = useClient((s) => s.issues);
  const [panelPref, setPanel] = useState(() => window.innerWidth > 1180);
  // Con varias conversaciones en paralelo no cabe el panel de detalles.
  const panel = panelPref && !embedded && !pane;
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
  // Mensajes con tema a los que se saltó desde «Todo» (quedan a la vista aunque «Todo» esconda los temas).
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set());
  const [replyTo, setReplyTo] = useState<MessageDTO | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [showPins, setShowPins] = useState(false);
  const [showLinks, setShowLinks] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  // Temas (docs/TEMAS.md): la banderita elegida filtra el chat y es el tema de lo que escribo.
  const topics = useTopics(id);
  // null = «General» (lo que no tiene tema; así abre el chat), TOPIC_ALL = «Todo», o el id de un tema (docs/TEMAS.md).
  const [topicFilter, setTopicFilter] = useState<string | null>(null);
  const topicById = useMemo(() => new Map(topics.map((x) => [x.id, x])), [topics]);
  const activeFilter = topicFilter && topicById.get(topicFilter) && !topicById.get(topicFilter)!.archivedAt ? topicFilter : null;
  const activeTopicIds = useMemo(() => new Set(topics.filter((x) => !x.archivedAt).map((x) => x.id)), [topics]);
  const showAll = topicFilter === TOPIC_ALL;
  const generalOnly = !activeFilter && !showAll && activeTopicIds.size > 0;
  const [text, setText] = useState(() => { try { return localStorage.getItem(draftKey(id)) ?? ''; } catch { return ''; } });
  const scroller = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  hostRef.current = host;
  // Zoom de este chat (A− / A+ o ⌘/Ctrl + rueda), para leer mejor cuando hay varios en paralelo.
  const zoom = useConvZoom(id);
  useEffect(() => {
    if (!host || embedded) return;
    const wheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      setConvZoom(id, convZoomNow(id) + (e.deltaY < 0 ? 0.1 : -0.1));
    };
    host.addEventListener('wheel', wheel, { passive: false });
    return () => host.removeEventListener('wheel', wheel);
  }, [host, id, embedded]);
  // Chat largo (docs/GRUPOS.md › «Navegar un chat largo»): con no leídos se abre en el primero, con la línea
  // «N mensajes nuevos». Lo leído se toma al montar, antes de marcar nada.
  const [entry] = useState(() => {
    const c = client.getState().data?.conversations.find((x) => x.id === id);
    if (!c || c.unread <= 0 || Number(queryParam('m')) > 0) return null;
    return { readFrom: Math.max(c.lastReadSeq, c.historyFromSeq), unread: c.unread };
  });
  const [baseRead] = useState(() => { const c = client.getState().data?.conversations.find((x) => x.id === id); return c ? Math.max(c.lastReadSeq, c.historyFromSeq) : 0; });
  const [newLine, setNewLine] = useState<number | null>(null);
  const placing = useRef(!!entry);
  const loadingUnread = useRef(false);
  const [placementFailed, setPlacementFailed] = useState(false);
  const [placementStep, setPlacementStep] = useState(0);
  const observedRead = useRef(baseRead);
  const visibleRead = useRef(new Set<number>());
  const justPlaced = useRef(false);
  // Posición respecto al final: lejos (más de una pantalla), abajo, y si la línea de nuevos quedó arriba.
  const [nav, setNav] = useState({ far: false, bottom: !entry, lineAbove: false });
  // Mensajes que llegaron mientras la persona estaba arriba: se cuentan desde el último seq que vio abajo.
  const awaySeq = useRef<number | null>(entry ? client.getState().data?.conversations.find((x) => x.id === id)?.lastMessageSeq ?? null : null);
  const [mentionsSeen, setMentionsSeen] = useState<Set<number>>(() => new Set());
  const atBottom = useRef(!entry);
  const prevHeight = useRef(0);
  const prevFirst = useRef<number | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // Altura de la caja de escribir: crece con el texto hasta un tope (30 % de la pantalla visible, máx. 180 px, para que
  // un mensaje largo no se coma la conversación, sobre todo con el teclado del celular) y vuelve a una línea al enviar
  // o vaciar. Se recalcula cada vez que cambia el texto, venga de donde venga (escribir, pegar, enviar, borrador).
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    if (!text) { el.style.height = ''; return; }
    el.style.height = 'auto';
    const view = window.visualViewport?.height ?? window.innerHeight;
    const cap = Math.max(72, Math.min(180, Math.round(view * 0.3)));
    el.style.height = `${Math.min(cap, el.scrollHeight)}px`;
  }, [text]);
  // Un hilo o sidechat abierto al lado recibe el cursor: se escribe ahí sin tocar el chat principal.
  useEffect(() => { if (embedded) requestAnimationFrame(() => input.current?.focus()); }, [embedded ? id : null]);
  const sideAnchorFor = () => replyTo ?? [...(local?.messages ?? [])].reverse().find((m) => m.kind === 'text' && !m.deletedAt && !!m.body) ?? null;
  // Menciones: tokens «@Nombre» del compositor y lista que aparece al escribir «@».
  const [tokens, setTokens] = useState<MentionToken[]>([]);
  const [caret, setCaret] = useState(0);
  // Tanda 1.7: #grupos del compositor, «una sola vista» para el próximo mensaje y la búsqueda dentro del chat.
  const [refTokens, setRefTokens] = useState<RefToken[]>([]);
  const [viewOnce, setViewOnce] = useState(false);
  const [searching, setSearching] = useState(false);
  // ⌘F / Ctrl+F (lo despacha Shell): abre la búsqueda dentro del chat o vuelve a enfocarla.
  useEffect(() => {
    // En paralelo solo busca el panel activo, y dentro de su propio chat.
    if (pane && !pane.active) return;
    const on = () => {
      setSearching(true);
      requestAnimationFrame(() => { const el = (hostRef.current ?? document).querySelector<HTMLInputElement>('.chat-search input'); el?.focus(); el?.select(); });
    };
    addEventListener('chaggu:chat-search', on);
    return () => removeEventListener('chaggu:chat-search', on);
  }, [pane?.active]);
  const refPicker = useRefPicker({
    text, caret, exclude: id,
    onPick: (range, token) => {
      const insert = `#${token.label} `;
      const next = text.slice(0, range.start) + insert + text.slice(range.end);
      const pos = range.start + insert.length;
      setText(next); setCaret(pos);
      setRefTokens((ts) => [...ts.filter((x) => !(x.conversationId === token.conversationId && x.label === token.label)), token]);
      requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(pos, pos); });
    },
  });
  // Lo que llega con seq mayor que esto después de abrir el chat es «en vivo» (confeti y carita triste).
  const liveFrom = useRef<number | null>(null);
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
      // Saltar a un mensaje (búsqueda, mención, enlace): el filtro pasa a su tema, o a «General» si no tiene.
      const target = client.getState().conversations[id]?.messages.find((m) => m.seq === seq);
      if (target && topicFilter !== TOPIC_ALL) {
        const want = target.topicId && activeTopicIds.has(target.topicId) ? target.topicId : null;
        if (want !== activeFilter) setTopicFilter(want);
      }
      setHighlight(seq);
      setRevealed((x) => (x.has(seq) ? x : new Set(x).add(seq)));
      requestAnimationFrame(() => document.getElementById(`msg-${id}-${seq}`)?.scrollIntoView({ block: 'center', behavior: 'instant' }));
      setTimeout(() => setHighlight(null), 2800);
    });
  };

  /**
   * Abrir con reintento: un 502/503/504 o un corte de red (p. ej. mientras se despliega el API) no deja el
   * chat roto con «Bad Gateway». Reintenta con espera creciente (≈30 s en total) y otra vez cuando vuelve la
   * conexión; el borrador sigue en el compositor. Un error permanente (403, 404…) se muestra tal cual.
   */
  const [retrying, setRetrying] = useState(false);
  const recovery = useRef<ReturnType<typeof createChatRecovery> | null>(null);
  const openWithRetry = () => recovery.current?.start();
  const sessionIdentity = useClient(() => client.getSessionIdentity());
  const connection = useClient((s) => s.connection);

  useEffect(() => {
    const owner = createChatRecovery({
      identity: client.getSessionIdentity,
      loaded: () => !!client.getState().conversations[id]?.loaded,
      subscribe: client.subscribe,
      open: (signal) => client.openConversation(id, false, signal),
      change: (state) => {
        setRetrying(state.status === 'retrying');
        setError(state.status === 'failed' ? state.error ? errorText(state.error) : t('err.updating') : null);
      },
    });
    recovery.current = owner;
    void owner.start();
    return () => { owner.dispose(); if (recovery.current === owner) recovery.current = null; };
  }, [id, sessionIdentity]);
  useEffect(() => { if (connection === 'online' && (retrying || error) && !client.getState().conversations[id]?.loaded) void openWithRetry(); }, [connection]);

  useEffect(() => {
    // La pantalla se monta de nuevo por conversación (key={id}), así el borrador no se cruza.
    client.loadIssues({ conversationId: id }).catch(() => {});
    client.loadPins(id).catch(() => {});
    // ?m=seq: salta a un mensaje (origen de un asunto, derivada, resultado devuelto, recordatorio o enlace copiado).
    const target = Number(queryParam('m'));
    if (target > 0) jumpTo(target);
  }, [id]);

  // Borrador local por conversación: sobrevive recargas y cambios de conversación.
  useEffect(() => { try { if (text) localStorage.setItem(draftKey(id), text); else localStorage.removeItem(draftKey(id)); } catch {} }, [id, text]);

  useEffect(() => { if (local?.loaded && liveFrom.current == null) liveFrom.current = conv?.lastMessageSeq ?? 0; }, [local?.loaded]);
  // Medición: desde que se monta el chat hasta que sus mensajes están a la vista (perf.ts).
  useEffect(() => { markAgain(`chaggu:chat-open:${id}`); }, [id]);
  useEffect(() => { if (local?.loaded) markAgain(`chaggu:chat-shown:${id}`); }, [id, local?.loaded]);
  useEffect(() => { if (local?.cached) markAgain(`chaggu:chat-painted:${id}`); }, [id, local?.cached]);
  const pending = useMemo(() => pendingAll.filter((p) => p.conversationId === id), [pendingAll, id]);
  const byId = useMemo(() => new Map((local?.messages ?? []).map((m) => [m.id, m])), [local?.messages]);
  const issueTopicOf = (m: MessageDTO) => {
    try { const p = JSON.parse(m.body); return p?.k === 'issue.created' ? allIssues[p.issueId]?.topicId ?? null : null; } catch { return null; }
  };
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let lastDay = '';
    let prev: MessageDTO | null = null;
    for (const m of local?.messages ?? []) {
      // Con un tema elegido se ven sus mensajes y las tarjetas de sus tareas.
      if (activeFilter && m.topicId !== activeFilter && !(m.kind === 'system' && issueTopicOf(m) === activeFilter)) continue;
      // «General»: solo lo que no tiene tema (ni tareas de un tema). «Todo» lo muestra todo (docs/TEMAS.md).
      if (generalOnly && !revealed.has(m.seq) && ((m.topicId && activeTopicIds.has(m.topicId)) || (m.kind === 'system' && activeTopicIds.has(issueTopicOf(m) ?? '')))) continue;
      const day = new Date(m.createdAt).toDateString();
      if (day !== lastDay) { out.push({ kind: 'day', key: `d${day}`, label: dayLabel(m.createdAt) }); lastDay = day; prev = null; }
      // Bajo la línea «N mensajes nuevos» el primer mensaje vuelve a llevar autor y hora.
      const cont = !!prev && prev.kind === 'text' && m.kind === 'text' && prev.authorId === m.authorId && !m.replyTo && !m.forwarded
        && Date.parse(m.createdAt) - Date.parse(prev.createdAt) < 5 * 60_000 && m.seq !== newLine;
      out.push({ kind: 'msg', key: m.id, m, cont });
      prev = m;
    }
    const sentIds = new Set((local?.messages ?? []).map((m) => m.clientMessageId));
    for (const p of pending) if (!sentIds.has(p.clientMessageId)) out.push({ kind: 'pending', key: p.clientMessageId, p });
    if (newLine != null) {
      let at = out.findIndex((r) => r.kind === 'msg' && r.m.seq >= newLine);
      if (at > 0 && out[at - 1]!.kind === 'day') at -= 1;
      if (at >= 0) out.splice(at, 0, { kind: 'new', key: 'new-line' });
    }
    return groupLinkRuns(out, expandedGroups, highlight, baseRead);
  }, [local?.messages, pending, expandedGroups, highlight, newLine, activeFilter, activeFilter || generalOnly ? allIssues : null, generalOnly, activeTopicIds, revealed]);
  const topicCounts = useMemo(() => {
    const n: Record<string, number> = {};
    for (const m of local?.messages ?? []) if (m.topicId && !m.deletedAt) n[m.topicId] = (n[m.topicId] ?? 0) + 1;
    return n;
  }, [local?.messages]);
  // Sin leer por tema (y sin tema, clave ''), con lo leído en vivo: el número junto a cada banderita.
  const readNow = Math.max(conv?.lastReadSeq ?? 0, conv?.historyFromSeq ?? 0);
  const topicUnread = useMemo(() => {
    const n: Record<string, number> = {};
    for (const m of local?.messages ?? []) {
      if (m.seq <= readNow || m.deletedAt || m.kind !== 'text' || m.authorId === d?.me.id) continue;
      const k = m.topicId && activeTopicIds.has(m.topicId) ? m.topicId : '';
      n[k] = (n[k] ?? 0) + 1;
    }
    return n;
  }, [local?.messages, readNow, activeTopicIds]);

  // Mantiene la vista abajo al llegar mensajes, y la posición al cargar historial antiguo.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const first = local?.messages[0]?.seq ?? null;
    // Solo al cargar historial antiguo (el primer seq bajó) se conserva la posición; la primera carga no mueve la vista.
    const olderLoaded = prevFirst.current != null && first != null && first < prevFirst.current;
    if (atBottom.current) el.scrollTop = el.scrollHeight;
    else if (olderLoaded && prevHeight.current && el.scrollHeight > prevHeight.current && el.scrollTop < 40) el.scrollTop += el.scrollHeight - prevHeight.current;
    prevHeight.current = el.scrollHeight;
    prevFirst.current = first;
  }, [rows.length]);

  useEffect(() => {
    if (conv && conv.unread > 0 && local?.loaded && !placing.current && document.visibilityState === 'visible') updateNav();
  }, [conv?.lastMessageSeq, conv?.unread, local?.loaded, id]);

  // Locate every pending page; a failed page never turns into a successful jump to the end.
  useEffect(() => {
    if (!placing.current || !entry || !local?.loaded || local.loading || loadingUnread.current || placementFailed) return;
    const r = firstUnread(local.messages, entry.readFrom, entry.unread, local.hasMore);
    if (r === 'older') {
      loadingUnread.current = true;
      void client.loadOlder(id).then((loaded) => { loadingUnread.current = false; if (!loaded) setPlacementFailed(true); else setPlacementStep((n) => n + 1); });
      return;
    }
    if (!r && entry.unread > 0) { setPlacementFailed(true); return; }
    placing.current = false;
    if (r) {
      // Todo lo no leído está en un solo tema: el chat abre en esa banderita.
      const unreadTopics = new Set(local.messages.filter((m) => m.seq > entry.readFrom && m.kind === 'text' && !m.deletedAt && m.authorId !== d?.me.id)
        .map((m) => (m.topicId && activeTopicIds.has(m.topicId) ? m.topicId : '')));
      const only = unreadTopics.size === 1 ? [...unreadTopics][0] : '';
      if (only) setTopicFilter(only);
      justPlaced.current = true; setNewLine(r.seq); return;
    }
    atBottom.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    updateNav();
  }, [local?.loaded, local?.loading, local?.messages, placementFailed, placementStep]);
  async function retryUnreadHistory() {
    if (loadingUnread.current || local?.loading) return;
    placing.current = true;
    atBottom.current = false;
    loadingUnread.current = true;
    setPlacementFailed(false);
    // Refresh even when the previous page claimed hasMore=false. Otherwise a terminal
    // history gap would show the same error forever without making another request.
    try { await client.openConversation(id, true); }
    catch { setPlacementFailed(true); }
    finally { loadingUnread.current = false; setPlacementStep((n) => n + 1); }
  }
  useLayoutEffect(() => {
    if (!justPlaced.current || newLine == null) return;
    justPlaced.current = false;
    document.getElementById(`new-${id}`)?.scrollIntoView({ block: 'start' });
    updateNav();
  }, [newLine]);

  /** Recalcula la posición (tras cada scroll): abajo o lejos, línea de nuevos arriba, menciones ya vistas y marcar leído. */
  function updateNav() {
    const el = scroller.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const bottom = dist < 60;
    if (!placing.current) {
      if (bottom) awaySeq.current = null;
      else if (atBottom.current || awaySeq.current == null) awaySeq.current = client.getState().data?.conversations.find((x) => x.id === id)?.lastMessageSeq ?? 0;
      atBottom.current = bottom;
    }
    const box = el.getBoundingClientRect();
    const line = document.getElementById(`new-${id}`);
    const lineAbove = !!line && line.getBoundingClientRect().bottom < box.top;
    const far = dist > el.clientHeight;
    setNav((n) => (n.far === far && n.bottom === bottom && n.lineAbove === lineAbove ? n : { far, bottom, lineAbove }));
    // Una mención cuenta como vista cuando su mensaje entra en pantalla.
    const seen: number[] = [];
    if (!placing.current) for (const seq of pendingMentionsRef.current) {
      const r = document.getElementById(`msg-${id}-${seq}`)?.getBoundingClientRect();
      if (r && r.top < box.bottom && r.bottom > box.top) seen.push(seq);
    }
    if (seen.length) setMentionsSeen((s0) => { const n = new Set(s0); seen.forEach((x) => n.add(x)); return n; });
    if (!placing.current && document.visibilityState === 'visible') {
      const current = client.getState();
      const meta = current.data?.conversations.find((x) => x.id === id);
      const visible = (current.conversations[id]?.messages ?? []).filter((m) => {
        if (isReadTransparentMessage(m)) return true;
        const rect = document.getElementById(`msg-${id}-${m.seq}`)?.getBoundingClientRect();
        return !!rect && rect.top < box.bottom && rect.bottom > box.top;
      }).map((m) => m.seq);
      observedRead.current = readThroughVisible(Math.max(observedRead.current, meta?.lastReadSeq ?? 0, meta?.historyFromSeq ?? 0), visibleRead.current, visible);
      client.markRead(id, observedRead.current);
    }
  }
  const pendingMentionsRef = useRef<number[]>([]);
  const scrollToBottom = () => {
    const el = scroller.current;
    if (!el) return;
    placing.current = false;
    atBottom.current = true;
    awaySeq.current = null;
    el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
    requestAnimationFrame(updateNav);
    setNav((n) => ({ ...n, far: false, bottom: true }));
  };
  // Web: Fin o ⌥↓ / Alt+↓ con el foco fuera del compositor baja al final.
  useEffect(() => {
    if (embedded || (pane && !pane.active)) return;
    const k = (e: globalThis.KeyboardEvent) => {
      if (!(e.key === 'End' || (e.altKey && e.key === 'ArrowDown'))) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (document.querySelector('.modal, .ctx-menu')) return;
      e.preventDefault(); scrollToBottom();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [embedded, id, pane?.active]);

  // El 🔕 y «Silenciado hasta…» se quitan solos cuando vence el silencio.
  useExpiry(conv?.mutedUntil);

  if (!conv) return <div className="page"><div className="empty">{t('chat.notFound')}</div></div>;

  const onScroll = () => {
    const el = scroller.current!;
    updateNav();
    if (el.scrollTop < 120 && local?.hasMore && !local.loading && !placing.current) void client.loadOlder(id);
  };
  // Menciones a mí sin leer (desde lo leído al abrir) que aún no pasaron por la pantalla: botón «@».
  const pendingMentions = (local?.messages ?? []).filter((m) => m.seq > baseRead && !m.deletedAt && mentionsMe(d, m) && !mentionsSeen.has(m.seq)).map((m) => m.seq);
  pendingMentionsRef.current = pendingMentions;
  const newWhileAway = awaySeq.current != null && !nav.bottom ? Math.max(0, conv.lastMessageSeq - awaySeq.current) : 0;
  const showJump = nav.far || newWhileAway > 0;
  const jumpToMention = () => {
    const seq = pendingMentions[0];
    if (seq == null) return;
    jumpTo(seq);
  };
  const jumpToNewLine = () => document.getElementById(`new-${id}`)?.scrollIntoView({ block: 'start', behavior: 'instant' });

  const send = () => {
    const body = text.trim();
    if (drafts.busy) { toast(t('att.uploading')); return; }
    const attachments = drafts.ready;
    if ((!body && !attachments.length) || !conv.canPost) return;
    const once = viewOnce && !privateReply;
    if (once && !viewOnceAllowed(attachments)) { toast(t('once.onlyMedia')); return; }
    atBottom.current = true;
    if (privateReply) {
      // «Responder en privado»: el directo lleva la referencia al mensaje original (el servidor pone la cita).
      const author = personById(d, privateReply.authorId)?.name ?? null;
      void client.send(id, body, null, { source: 'tiecoms', author, sentAt: privateReply.createdAt, fromConversationId: privateReply.conversationId, messageId: privateReply.id }, { attachments });
    } else void client.send(id, text, replyTo?.id ?? null, null, { attachments, mentions: once ? [] : mentionsFor(text, tokens), topicId: activeFilter, refs: once ? [] : refsFor(text, refTokens), viewOnce: once });
    drafts.clear();
    setTokens([]);
    setRefTokens([]);
    setViewOnce(false);
    setText('');
    setReplyTo(null);
    setPrivateReply(null);
    input.current?.focus();
  };
  /** Programar: sale solo a la hora elegida. Solo texto (con menciones y respuesta); los adjuntos se envían al momento. */
  const canSchedule = !!text.trim() && !drafts.drafts.length && !privateReply && !viewOnce;
  const schedule = (when: Date) => {
    const lead = text.length - text.trimStart().length;
    const body = text.trim();
    const mentions = mentionsFor(text, tokens)?.map((m) => ({ ...m, start: m.start - lead })).filter((m) => m.start >= 0 && m.start + m.length <= body.length);
    const saved = { text, tokens, replyTo };
    client.scheduleMessage(id, { body, sendAt: when.toISOString(), mentions, replyTo: replyTo?.id ?? null })
      .then((x) => toast(`🕒 ${t('sched.done', { when: whenLabel(x.sendAt) })}`, {
        label: t('issue.undo'),
        run: () => { void client.cancelScheduled(x.id).catch(() => {}); setText(saved.text); setTokens(saved.tokens); setReplyTo(saved.replyTo); },
      }, 5000))
      .catch((e) => { toast(errorText(e)); setText(saved.text); setTokens(saved.tokens); });
    setTokens([]);
    setText('');
    setReplyTo(null);
    input.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (emoji.onKeyDown(e)) return;
    if (picker.onKeyDown(e)) return;
    if (refPicker.onKeyDown(e)) return;
    if (e.key === 'Backspace' && refTokens.length) {
      const el = e.currentTarget;
      if (el.selectionStart === el.selectionEnd) {
        const r = backspaceRef(text, el.selectionStart, refTokens);
        if (r) { e.preventDefault(); setText(r.text); setCaret(r.caret); requestAnimationFrame(() => el.setSelectionRange(r.caret, r.caret)); return; }
      }
    }
    if (e.key === 'Backspace' && tokens.length) {
      const el = e.currentTarget;
      if (el.selectionStart === el.selectionEnd) {
        const r = backspaceToken(text, el.selectionStart, tokens);
        if (r) { e.preventDefault(); setText(r.text); setCaret(r.caret); requestAnimationFrame(() => el.setSelectionRange(r.caret, r.caret)); return; }
      }
    }
    // ⌘B / ⌘I / ⌘⇧X envuelven la selección en *negrilla*, _cursiva_ o ~tachado~ (sin menciones de por medio).
    const wrap = (e.metaKey || e.ctrlKey) && !e.altKey ? ({ b: '*', i: '_', x: e.shiftKey ? '~' : '' } as Record<string, string>)[e.key.toLowerCase()] : '';
    if (wrap && !tokens.length && !refTokens.length) {
      const el = e.currentTarget; const a = el.selectionStart, b = el.selectionEnd;
      e.preventDefault();
      const next = `${text.slice(0, a)}${wrap}${text.slice(a, b)}${wrap}${text.slice(b)}`;
      setText(next); requestAnimationFrame(() => el.setSelectionRange(a + 1, b + 1));
      return;
    }
    // Enter envía en escritorio; en móvil el teclado inserta salto de línea y se usa el botón.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia('(pointer: fine)').matches) { e.preventDefault(); send(); }
    if (e.key === 'Escape' && replyTo) setReplyTo(null);
    if (e.key === 'Escape' && privateReply) setPrivateReply(null);
    // Flecha arriba con el campo vacío: editar mi último mensaje (como en Slack).
    if (e.key === 'ArrowUp' && !text) {
      const mine = [...(local?.messages ?? [])].reverse().find((m) => m.authorId === d.me.id && m.kind === 'text' && !m.deletedAt && !m.viewOnce);
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
    // Y los #grupos que siguen en el texto.
    const keptRefs: RefToken[] = (orig?.refs ?? []).map((r) => ({ conversationId: r.conversationId, label: (orig?.body ?? '').slice(r.start + 1, r.start + r.length) }));
    try { await client.editMessage(editing.id, body, mentionsFor(body, kept), refsFor(body, keptRefs)); } catch (e) { toast(errorText(e)); }
  };

  const title = conversationTitle(d, conv);
  // gg: su chat (responde a todo) o cualquier chat (responde a @gg).
  const ggDm = isGgChat(conv);
  const ggHere = ggDm || conv.kind !== 'direct';
  const openHere = Object.values(allIssues).filter((i: IssueDTO) => i.conversationId === id && !isClosed(i));
  const issueOf = (mid: string) => openHere.find((i) => i.originMessageId === mid);
  // Asuntos, reuniones e hilos en todas (también directos y chats grupales). Fuera de un espacio el hilo es con
  // las mismas personas, y un hilo no se deriva otra vez.
  const canWork = conv.canPost;
  const canDerive = canWork && (!!conv.workspaceId ? conv.kind !== 'direct' : !conv.parentId);
  const myWsRole = d.workspaces.find((w) => w.id === conv.workspaceId)?.myRole;
  // Los terceros invitados participan en los asuntos pero no los abren (el API responde 403).
  const canOpenIssues = canWork && myWsRole !== 'guest';
  const ws = d.workspaces.find((w) => w.id === conv.workspaceId);
  const typers = (typing ?? []).filter((x) => x.until > Date.now()).map((x) => personById(d, x.userId)?.name.split(' ')[0]).filter(Boolean);
  const orgsHere = [...new Set(conv.memberIds.map((m) => personById(d, m)?.orgId).filter(Boolean))].map((o) => orgById(d, o as string));
  const pinned = new Set(pinIds ?? []);
  const muted = !!conv.mutedUntil && Date.parse(conv.mutedUntil) > Date.now();
  const muteLine = mutedText(conv);
  const openMuteMenu = (el: HTMLElement) => { const r = el.getBoundingClientRect(); openMenuAt(r.left, r.bottom + 4, muted ? [muteMenu(conv)] : [{ label: t('mute.how'), disabled: true }, ...muteOptions(conv)]); };
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
  /** Tarjetas de correo o WhatsApp: responder aquí, en privado y reenviar, como un mensaje normal. */
  const cardActionsFor = (m: MessageDTO, emailId: string | undefined): CardActions => {
    const mine = m.authorId === d.me.id;
    const reply = () => { setReplyTo(m); input.current?.focus(); };
    const priv = !mine && conv.kind !== 'direct' ? () => void replyPrivately(m) : undefined;
    const forward = () => { if (emailId) openForwardCard(emailId); };
    const items: MenuItem[] = [
      ...(conv.canPost ? [{ label: t('menu.reply'), icon: '↩', onSelect: reply }] : []),
      ...(priv ? [{ label: t('preply.action'), icon: '✉', hint: t('menu.hintDm', { name: personById(d, m.authorId)?.name.split(' ')[0] ?? '' }), onSelect: priv }] : []),
      ...(emailId ? [{ label: t('card.forward'), icon: '↪', onSelect: forward }] : []),
      { divider: true },
      { label: t('menu.copyLink'), icon: '⛓', onSelect: async () => { await copyText(messageLink(m)); toast(t('toast.linkCopied')); } },
    ];
    return { reply: conv.canPost ? reply : () => {}, replyPrivately: priv, forward, menu: menuProps(() => items) as Record<string, unknown> };
  };
  const messageMenu = (m: MessageDTO): MenuItem[] => {
    const mine = m.authorId === d.me.id;
    const isPinned = pinned.has(m.id);
    // Una sola vista: sin copiar, reenviar, fijar, editar ni convertir en tarea (el servidor responde 409).
    if (m.viewOnce) return [
      ...(conv.canPost ? [{ label: t('menu.reply'), icon: '↩', onSelect: () => { setReplyTo(m); input.current?.focus(); } }] : []),
      remindMenu(conv, m),
      { label: t('menu.markUnread'), icon: '●', onSelect: () => client.markUnread(id, m.seq).then(() => toast(t('toast.markedUnread'))).catch((e) => toast(errorText(e))) },
      ...(mine ? [{ divider: true }, { label: t('menu.delete'), icon: '🗑', danger: true, onSelect: () => { if (confirm(t('menu.deleteConfirm'))) void client.deleteMessage(m.id).catch((e) => toast(errorText(e))); } }] : []),
    ];
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
      ...(conv.canPost && m.kind === 'text' && !embedded ? [topicMenu(m, topics)].filter((x): x is MenuItem => !!x) : []),
      remindMenu(conv, m),
      { label: t('menu.markUnread'), icon: '●', onSelect: () => client.markUnread(id, m.seq).then(() => toast(t('toast.markedUnread'))).catch((e) => toast(errorText(e))) },
      ...(canWork ? [
        { divider: true },
        ...(canOpenIssues ? [{ label: t('menu.issue'), icon: '◆', onSelect: () => setNewIssue({ origin: m }) }] : []),
        { label: t('menu.meeting'), icon: '📅', onSelect: () => newEvent({ conversationId: id, originMessageId: m.id, defaultTitle: excerpt(m.body, 80) }) },
      ] : []),
      { label: t('menu.forwardChat'), icon: '↪', onSelect: () => openDialog((close) => <ForwardToChatsDialog source={m} onClose={close} />) },
      forwardMenu(d, conv, m, () => openDialog((close) => <ForwardToChatsDialog source={m} onClose={close} />)),
      ...(!isSelfChat(d, conv) && m.kind === 'text' && m.body ? [{ label: t('self.saveHere'), icon: '✎', onSelect: () => void saveToSelf(m, personById(d, m.authorId)?.name ?? null) }] : []),
      ...(mine ? [
        { divider: true },
        { label: t('menu.edit'), icon: '✎', onSelect: () => setEditing({ id: m.id, text: m.body }) },
        { label: t('menu.delete'), icon: '🗑', danger: true, onSelect: () => { if (confirm(t('menu.deleteConfirm'))) void client.deleteMessage(m.id).catch((e) => toast(errorText(e))); } },
      ] : []),
    ];
  };

  return (
    <div ref={setHost} style={zoom !== 1 && !embedded ? { zoom } : undefined} className={`conv ${panel || sideConv ? '' : 'no-panel'} ${sideConv ? 'has-side' : ''} ${embedded ? 'is-embedded' : ''}`}>
      {sideConv && <SideConnector host={host} anchorId={sideConv.parentMessageId} color={personColor(sideAnchor?.authorId ?? sideConv.memberIds[0])} />}
      <section className={`conv-main ${dropping ? 'is-dropping' : ''}`}
        onDragOver={(e) => { if (conv.canPost && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true); } }}
        onDragLeave={(e) => { if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false); }}
        onDrop={(e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setDropping(false); drafts.add(e.dataTransfer.files); input.current?.focus(); }}>
        {dropping && <div className="drop-hint" aria-hidden>{t('att.drop')}</div>}
        <header className="conv-head" onContextMenu={contextHandler(() => conversationMenu(conv, { onNewMeeting: () => newEvent({ conversationId: id }) }))}>
          {!embedded && <button className="icon-btn only-mobile" aria-label={t('common.back')} onClick={() => (history.length > 1 ? history.back() : navigate('/conversaciones'))}>‹</button>}
          {conv.kind !== 'direct' && conv.avatarUrl && <ConvAvatar c={conv} size={30} />}
          <div className="grow conv-head-title" style={{ minWidth: 0 }}>
            <h2 className="ellipsis">{conv.kind === 'internal' ? '◌ ' : conv.level === 'directivo' ? '◆ ' : ''}{isSide ? `💬 ${t('side.title')}` : title}{muted && <> <button className="head-mute" title={`${muteLine ?? t('side.muted')} · ${t('menu.unmute')}`} aria-label={t('menu.unmute')} onClick={(e) => openMuteMenu(e.currentTarget)}>🔕</button></>}</h2>
            {isSide
              ? <div className="small muted ellipsis side-head-people"><StackedAvatars c={conv} size={18} /> 🔒 {t('side.privateN', { n: conv.memberIds.length })}</div>
              : <div className="small muted ellipsis">{conversationSubtitle(d, conv)}{conv.kind !== 'direct' ? ` · ${tn(conv.memberIds.length, 'n.participant', 'n.participants')}` : ''}</div>}
          </div>
          <div className="row only-desktop head-orgs">{orgsHere.map((o) => o && <OrgMark key={o.id} org={o} size={22} />)}</div>
          {embedded && pinned.size > 0 && <button className="btn ghost small" onClick={() => setShowPins(true)} title={t('pins.title')}>📌 {pinned.size}</button>}
          {embedded && conv.canManage && conv.kind !== 'direct' && <button className="btn ghost small" onClick={() => openDialog((close) => <AddMembersDialog conversationId={id} onClose={close} />)} title={t('bar.addPeople')}>＋ {t('bar.people')}</button>}
          {ws && !embedded && <button className="btn ghost small only-desktop head-space" onClick={() => navigate(`/w/${ws.id}`)}>{t('chat.space')}</button>}
          {!isSide && <CallButtons conv={conv} />}
          {!embedded && <span className="zoom-pill only-desktop" role="group" aria-label={t('zoom.label')}>
            <button className="icon-btn" aria-label={t('zoom.out')} title={t('zoom.out')} disabled={zoom <= ZOOM_MIN} onClick={() => setConvZoom(id, zoom - 0.1)}>A−</button>
            {zoom !== 1 && <button className="zoom-val" title={t('zoom.reset')} onClick={() => setConvZoom(id, 1)}>{Math.round(zoom * 100)}%</button>}
            <button className="icon-btn" aria-label={t('zoom.in')} title={t('zoom.in')} disabled={zoom >= ZOOM_MAX} onClick={() => setConvZoom(id, zoom + 0.1)}>A+</button>
          </span>}
          {/* ⊞ Abrir otro chat al lado (hasta 4, split.ts): lo mismo que arrastrar un chat de la lista. */}
          {!embedded && splitAvailable() && (!pane || pane.count < MAX_PANES) && <button className="icon-btn only-desktop head-split" aria-label={t('split.add')} title={t('split.add')} onClick={() => openDialog((close) => <SplitPicker activeId={id} onClose={close} />)}>⊞</button>}
          <button className={`icon-btn only-desktop head-search ${searching ? 'is-on' : ''}`} aria-label={t('csearch.open')} title={t('csearch.open')} aria-pressed={searching} onClick={() => setSearching((v) => !v)}>🔎</button>
          <button className="icon-btn" aria-label={t('menu.open')} onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenuAt(r.left, r.bottom + 4, [{ label: t('csearch.open'), icon: '🔎', onSelect: () => setSearching(true) }, ...(!embedded ? [{ label: `${t('zoom.in')} · ${Math.round(zoom * 100)}%`, icon: 'A+', onSelect: () => setConvZoom(id, zoom + 0.1) }, { label: t('zoom.out'), icon: 'A−', onSelect: () => setConvZoom(id, zoom - 0.1) }, ...(zoom !== 1 ? [{ label: t('zoom.reset'), icon: '↺', onSelect: () => setConvZoom(id, 1) }] : [])] : []), { divider: true }, ...conversationMenu(conv, { onNewMeeting: () => newEvent({ conversationId: id }) })]); }}>⋯</button>
          {embedded ? <>
            <button className="icon-btn" aria-label={t('side.openFull')} title={t('side.openFull')} onClick={() => navigate(`/c/${id}`)}>⤢</button>
            <button className="icon-btn" aria-label={t('side.close')} title={t('side.close')} onClick={embedded.onClose}>×</button>
          </> : pane ? <>
            {pane.onPin && <button className={`icon-btn head-keep ${pane.pinned ? 'is-on' : ''}`} aria-pressed={!!pane.pinned} aria-label={t(pane.pinned ? 'grid.unpin' : 'grid.pin')} title={t(pane.pinned ? 'grid.unpin' : 'grid.pin')} onClick={pane.onPin}>📌</button>}
            {pane.count > 1 && <button className="icon-btn head-keep" aria-label={t('split.only')} title={t('split.only')} onClick={pane.onOnly}>⤢</button>}
            <button className="icon-btn head-keep" aria-label={t('split.close')} title={t('split.close')} onClick={pane.onClose}>×</button>
          </> : <button className="icon-btn" aria-label={t('chat.details')} onClick={() => setPanel(!panelPref)}>ⓘ</button>}
        </header>
        {searching && <ChatSearchBar conv={conv} scroller={scroller} onJump={jumpTo} onClose={() => { setSearching(false); input.current?.focus(); }} />}
        {!isSide && <CallBanner conversationId={id} />}
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
        {!embedded && <TopicDock conv={conv} list={topics} filter={showAll ? TOPIC_ALL : activeFilter} onFilter={(x) => { setTopicFilter(x); atBottom.current = true; requestAnimationFrame(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }); }} counts={topicCounts} unread={topicUnread} />}
        {!embedded && <DerivedPendingStrip conv={conv} />}

        {placementFailed && <div className="error" role="alert">{t('chat.unreadLoadFailed')} <button className="link-btn" disabled={local?.loading} onClick={() => void retryUnreadHistory()}>{t('chat.retryUnread')}</button></div>}
        <div className="msgs-wrap">
        {nav.lineAbove && entry && newLine != null && (
          <button className="jump-new" onClick={jumpToNewLine} aria-label={t('chat.jumpNew')} title={t('chat.jumpNew')}>{t('chat.newAbove', { n: entry.unread })}</button>
        )}
        <div className="msgs" data-conv-id={id} ref={scroller} onScroll={onScroll} role="log" aria-live="polite">
          {local?.loading && !local.loaded && <div className="msg-sys">{t('common.loading')}</div>}
          {local?.loaded && !local.hasMore && conv.historyFromSeq > 0 && <div className="msg-sys">{t('chat.lateJoin')}</div>}
          {local?.loaded && local.hasMore && <div className="msg-sys">{local.loading ? t('chat.loadingOlder') : '·'}</div>}
          {retrying && <div className="hint" role="status" style={{ textAlign: 'center' }}>⟳ {t('chat.reconnecting')}</div>}
          {error && <div className="error" style={{ textAlign: 'center' }}>{error} <button className="link-btn" onClick={() => void openWithRetry()}>{t('chat.retry')}</button></div>}
          {activeFilter && local?.loaded && !rows.some((r) => r.kind === 'msg' || r.kind === 'links') && <div className="topic-empty">{t('topic.empty', { name: topicById.get(activeFilter)!.name })}</div>}
          {rows.map((r) => {
            if (r.kind === 'day') return <div key={r.key} className="day">{r.label}</div>;
            if (r.kind === 'new') return <div key={r.key} id={`new-${id}`} className="new-line" role="separator">{entry && entry.unread === 1 ? t('chat.newMessagesOne') : t('chat.newMessages', { n: entry?.unread ?? 0 })}</div>;
            if (r.kind === 'links') return <LinkGroup key={r.key} d={d} msgs={r.msgs} menuFor={messageMenu} onExpand={() => setExpandedGroups((g) => new Set(g).add(r.key))} />;
            if (r.kind === 'pending') return <PendingRow key={r.key} p={r.p} />;
            const m = r.m;
            if (m.kind === 'system') return <SystemRow key={r.key} m={m} onIssue={setOpenIssue} canPost={conv.canPost} live={liveFrom.current != null && m.seq > liveFrom.current} cardActions={cardActionsFor} />;
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
                      {!embedded && m.topicId && !m.deletedAt && <TopicTag topic={topicById.get(m.topicId)} onClick={conv.canPost ? () => openTopicMenu(document.querySelector(`[data-mid="${m.id}"] .topic-tag`) as HTMLElement, m, topics) : undefined}
                        by={m.topicBy && m.topicBy !== m.authorId ? t('topic.by', { name: m.topicBy === d.me.id ? t('common.youShort') : personById(d, m.topicBy)?.name.split(' ')[0] ?? '' }) : null} />}
                    </div>
                  )}
                  {r.cont && !embedded && m.topicId && !m.deletedAt && (() => {
                    const prevM = (local?.messages ?? []).find((x) => x.seq === m.seq - 1);
                    return prevM?.topicId === m.topicId ? null : <div className="msg-meta is-topic-only"><TopicTag topic={topicById.get(m.topicId)} /></div>;
                  })()}
                  {m.replyTo && (
                    <button className="msg-quote" onClick={() => quoted && jumpTo(quoted.seq)}>
                      {quoted ? <><b>{personById(d, quoted.authorId)?.name}</b> {quoted.deletedAt ? t('chat.deleted') : excerpt(cardQuote(quoted) ?? quoted.body, 120)}</> : t('reply.quoteMissing')}
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
                  ) : m.viewOnce && !m.deletedAt ? <ViewOnceBubble m={m} /> : (
                    (m.body || m.deletedAt || !m.attachments?.length) && <div className={`msg-body ${!m.deletedAt && isJumbo(m.body) ? 'is-jumbo' : ''}`}>{m.deletedAt ? <i className="muted">{t('chat.deleted')}</i> : m.kind === 'text' ? <MessageText d={d} body={m.body} mentions={m.mentions} refs={m.refs} /> : m.body}{m.editedAt && !m.deletedAt && <span className="msg-edited"> {t('msg.edited')}</span>}</div>
                  )}
                  {!m.deletedAt && !m.viewOnce && !!m.attachments?.length && <AttachmentsView list={m.attachments} onCreateIssue={canOpenIssues ? (title) => setNewIssue({ origin: m, title }) : undefined} />}
                  {!m.deletedAt && !isEditing && !m.viewOnce && <MessageLinks m={m} mode={conv.linkPreviews ?? 'large'} onIssue={canOpenIssues ? (title) => setNewIssue({ origin: m, title }) : undefined} />}
                  {!m.deletedAt && <ReactionBar d={d} m={m} canReact={conv.canPost} actions={reactionActions} onIssue={setOpenIssue} />}
                  {!embedded && <ThreadChip d={d} threads={threadsOf(d, id, m.id).filter((c) => c.deriveKind !== 'side')} onOpen={setSideId} />}
                  {!embedded && <SideChip d={d} sides={sidesOf(d, id, m.id)} onOpen={setSideId} />}
                  {issueOf(m.id) && <button className="msg-issue" onClick={() => setOpenIssue(issueOf(m.id)!.id)}>◆ {issueOf(m.id)!.title}</button>}
                  {!m.deletedAt && !isEditing && (
                    <div className="msg-actions">
                      {conv.canPost && <button className="msg-act-react" aria-label={t('react.add')} title={t('react.add')} onClick={(e) => { const rr = (e.currentTarget as HTMLElement).getBoundingClientRect(); pickReaction(m, rr.left, rr.bottom + 6); }}>☺</button>}
                      {conv.canPost && QUICK_REACTIONS.slice(0, 3).map((e) => <button key={e} className="msg-act-quick" aria-label={e} onClick={() => react(m, e)}>{e}</button>)}
                      {conv.canPost && <button onClick={() => { setReplyTo(m); input.current?.focus(); }}>↩ {t('menu.reply')}</button>}
                      {!m.viewOnce && <button onClick={() => openDialog((close) => <ForwardToChatsDialog source={m} onClose={close} />)}>↪ {t('menu.forward')}</button>}
                      {canDerive && myWsRole !== 'guest' && !m.viewOnce && <button onClick={() => setDeriving(m)}>{t('derive.action')}</button>}
                      {canOpenIssues && !m.viewOnce && <button onClick={() => setNewIssue({ origin: m })}>{t('issue.fromMessage')}</button>}
                      {conv.canPost && !embedded && m.kind === 'text' && !m.viewOnce && <button onClick={(e) => openTopicMenu(e.currentTarget as HTMLElement, m, topics)}>🏷 {t('topic.set')}</button>}
                      <button aria-label={t('menu.open')} onClick={(e) => { const rr = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenuAt(rr.left, rr.bottom + 4, messageMenu(m)); }}>⋯</button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {ggHere && <GgThinking conversationId={id} inDm={ggDm} />}
        </div>
        {(showJump || (pendingMentions.length > 0 && !nav.bottom)) && (
          <div className="jump-stack">
            {pendingMentions.length > 0 && !nav.bottom && (
              <button className="jump-btn is-mention" onClick={jumpToMention} aria-label={t('chat.jumpMention')} title={t('chat.jumpMention')}>
                @{pendingMentions.length > 1 && <span className="pill">{pendingMentions.length}</span>}
              </button>
            )}
            {showJump && (
              <button className="jump-btn" onClick={() => scrollToBottom()} aria-label={t('chat.jumpLatest')} title={`${t('chat.jumpLatest')} (End)`}>
                ⌄{newWhileAway > 0 && <span className="pill">{newWhileAway}</span>}
              </button>
            )}
          </div>
        )}
        </div>
        {isSide && local?.loaded && !(local.messages ?? []).some((m) => m.kind === 'text') && <div className="side-empty">💬 {t('side.emptyChat')}</div>}
        {isSide && conv.canPost && !text.trim() && lastText && lastText.authorId !== d.me.id && (
          <QuickReplies onSend={(q) => { atBottom.current = true; void client.send(id, q); }} onAsk={() => setAdding(true)} />
        )}
        <div className="typing">{typers.length ? t(typers.length > 1 ? 'chat.typingMany' : 'chat.typingOne', { names: typers.join(', ') }) : ''}</div>
        <div className="composer">
          {privateReply && (
            <div className="reply-bar is-private">
              <span className="grow ellipsis"><b>✉ {t('preply.bar', { name: personById(d, privateReply.authorId)?.name ?? '' })}</b> · {excerpt(cardQuote(privateReply) ?? privateReply.body, 100)}</span>
              <button className="icon-btn" aria-label={t('preply.cancel')} onClick={() => setPrivateReply(null)}>×</button>
            </div>
          )}
          {replyTo && (
            <div className="reply-bar">
              <span className="grow ellipsis"><b>{t('reply.to', { name: personById(d, replyTo.authorId)?.name ?? '' })}</b> · {excerpt(cardQuote(replyTo) ?? replyTo.body, 100)}</span>
              <button className="icon-btn" aria-label={t('reply.cancel')} onClick={() => setReplyTo(null)}>×</button>
            </div>
          )}
          {ggDm && <GgConsentBanner />}
          {conv.canPost && <SleepNotice conv={conv} typing={!!text.trim()} onSchedule={canSchedule ? schedule : undefined} />}
          {conv.sideIssueId && <SideIssueStrip sideId={id} issueId={conv.sideIssueId} onOpen={setOpenIssue} />}
          {conv.canPost && <ScheduledStrip conversationId={id} />}
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
                  { label: t('meet.nowTitle'), icon: '📹', onSelect: () => openDialog((close) => <MeetingDialog conversationId={id} onClose={close} />) },
                  { label: t('meet.laterTitle'), icon: '🔗', onSelect: () => openDialog((close) => <MeetingDialog conversationId={id} scheduled onClose={close} />) },
                  { label: t('bar.newEvent'), icon: '📅', onSelect: () => newEvent({ conversationId: id }) },
                  ...(d.features?.mail ? [{ divider: true as const }, { label: t('mail.fromChat'), icon: '✉', onSelect: () => openDialog((close) => <MailPickDialog conversationId={id} onClose={close} />) }, { label: t('wa.fromChat'), icon: '✆', onSelect: () => navigate('/whatsapp') }] : []),
                  ...(canOpenIssues ? [{ label: t('bar.newIssue'), icon: '◆', onSelect: () => setNewIssue({}) }] : []),
                  ...(conv.sideIssueId ? [{ label: t('task.addHere'), icon: '☑', onSelect: () => openDialog((close) => <TasksDialog parentId={conv.sideIssueId!} conversationId={id} onClose={close} />) }] : []),
                ]);
              }}>＋</button>
              <button className="bring-btn" title={t('imp.action')} aria-label={t('imp.action')} onClick={() => openDialog((close) => <BringDialog conversationId={id} onClose={close} />)}>⤓</button>
              <button className="bring-btn composer-emoji" title={t('react.insert')} aria-label={t('react.insert')} onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openEmojiPicker(r.left, r.top - 8, insertEmoji); }}>☺</button>
              <div className="mention-wrap">
              {picker.view}
              {refPicker.view}
              {emoji.view}
              <MentionMirror text={text} tokens={tokens} taRef={input} refRanges={refsFor(text, refTokens)} />
              <textarea
                ref={input} rows={1} value={text} placeholder={isSide ? (sideOthers.length === 1 ? t('side.placeholder', { name: personById(d, sideOthers[0])?.name.split(' ')[0] ?? '' }) : t('side.placeholderMany')) : activeFilter ? t('topic.placeholder', { name: topicById.get(activeFilter)!.name }) : t('chat.placeholder', { name: title })} aria-label={t('common.message')}
                onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
                onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); client.typing(id); }}
                onKeyDown={onKey} enterKeyHint="send"
                onPaste={(e) => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); drafts.add(files); } }}
              />
              </div>
              {!privateReply && <button type="button" className={`bring-btn once-btn ${viewOnce ? 'is-on' : ''}`} aria-pressed={viewOnce} title={viewOnce ? t('once.on') : t('once.toggle')} aria-label={t('once.toggle')}
                onClick={() => { const next = !viewOnce; setViewOnce(next); toast(next ? t('once.on') : t('once.off')); input.current?.focus(); }}><span className="once-ico" aria-hidden>1</span></button>}
              {/* Con el compositor vacío, el micrófono: mantener pulsado graba una nota de voz. */}
              {!text.trim() && !drafts.drafts.length && !privateReply
                ? <VoiceRecorder conversationId={id} viewOnce={viewOnce} onSent={() => { atBottom.current = true; setReplyTo(null); setViewOnce(false); }} />
                : <>
                  {canSchedule && <button className="bring-btn sched-btn" title={t('sched.menuTitle')} aria-label={t('sched.menuTitle')} onClick={(e) => openScheduleMenu(e.currentTarget, schedule)}>🕒</button>}
                  <button className="send" onClick={send} disabled={(!text.trim() && !drafts.ready.length) || drafts.busy} aria-label={t('chat.send')}
                    {...(canSchedule ? menuProps(() => scheduleMenu(schedule, t('sched.menuTitle'))) : {})}>➤</button>
                </>}
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
          {/* Silenciar: interruptor con el tiempo restante; al encenderlo se elige por cuánto. */}
          <div className="card mute-row">
            <span aria-hidden style={{ fontSize: 18, filter: muted ? 'grayscale(1)' : undefined }}>{muted ? '🔕' : '🔔'}</span>
            <span className="grow">
              <b style={{ display: 'block' }}>{t('mute.switch')}</b>
              <span className="small muted" style={{ display: 'block' }}>{muteLine ?? t('mute.switchHint')}</span>
            </span>
            <button className="switch" role="switch" aria-checked={muted} aria-label={t('mute.switch')}
              onClick={(e) => { if (muted) void unmute(conv); else openMuteMenu(e.currentTarget); }} />
          </div>
          {/* Sonido de este chat (docs/SONIDOS.md): el menú lo cambia y lo hace sonar. */}
          <button className="card mute-row" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openMenuAt(r.left, r.bottom + 4, soundMenu(conv).items!); }}>
            <span aria-hidden style={{ fontSize: 18 }}>🎵</span>
            <span className="grow" style={{ textAlign: 'left' }}>
              <b style={{ display: 'block' }}>{t('sound.chat')}</b>
              <span className="small muted" style={{ display: 'block' }}>{soundName(conv.sound)}</span>
            </span>
            <span className="muted">›</span>
          </button>
          {canWork && <ConversationAgenda conv={conv} />}
          {canWork && (
            <div>
              <div className="row" style={{ marginBottom: 6 }}>
                <span className="eyebrow grow">{t('nav.issues')} · {openHere.length}</span>
                {canOpenIssues && <button className="btn small" onClick={() => setNewIssue({})}>{t('issue.new')}</button>}
              </div>
              <ConversationIssues conversationId={id} canCreate={canOpenIssues} onOpen={setOpenIssue} />
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
                    <div className="ellipsis" style={{ fontWeight: 600 }}>{p?.name ?? t('common.participant')}{mid === d.me.id ? ` ${t('common.you')}` : ''}
                      {conv.adminIds?.includes(mid) && <span className="tag" style={{ marginLeft: 6 }} title={conv.createdBy === mid ? t('chat.creator') : undefined}>{t('chat.admin')}</span>}
                      {p?.kind === 'agent' && <span className="tag" style={{ marginLeft: 6 }}>{t('chat.bot')}</span>}
                    </div>
                    <div className="small muted ellipsis">{[p?.title, p?.area, o?.name ?? (p?.guest ? (p.guestUntil ? t('chat.guestUntil', { date: new Date(p.guestUntil).toLocaleDateString(locale(), { day: 'numeric', month: 'short' }) }) : t('common.guest')) : null)].filter(Boolean).join(' · ')}</div>
                  </div>
                  {mid !== d.me.id && conv.kind !== 'direct' && p?.kind !== 'agent' && (
                    <button className="btn ghost small" title={t('common.directMessage')} aria-label={t('common.directMessage')} onClick={() => client.openDirect(mid).then((r) => navigate(`/c/${r.id}`)).catch((e) => setError(errorText(e)))}>✉</button>
                  )}
                  {conv.canManage && conv.adminIds && conv.kind !== 'direct' && p?.kind !== 'agent' && !p?.guest && !(conv.adminIds.includes(mid) && conv.createdBy === mid) && (mid !== d.me.id || conv.adminIds.includes(mid)) && (
                    conv.adminIds.includes(mid)
                      ? <button className="btn ghost small" title={mid === d.me.id ? t('chat.leaveAdmin') : t('chat.unmakeAdmin')} aria-label={t('chat.unmakeAdmin')}
                          onClick={() => { if (confirm(t('chat.unmakeAdminConfirm', { name: p?.name ?? '' }))) void client.setMemberAdmin(id, mid, false).catch((e) => setError(errorText(e))); }}>★</button>
                      : <button className="btn ghost small" title={t('chat.makeAdmin')} aria-label={t('chat.makeAdmin')}
                          onClick={() => { if (confirm(t('chat.makeAdminConfirm', { name: p?.name ?? '' }))) void client.setMemberAdmin(id, mid, true).catch((e) => setError(errorText(e))); }}>☆</button>
                  )}
                  {conv.canManage && mid !== d.me.id && conv.kind !== 'direct' && conv.createdBy !== mid && p?.kind !== 'agent' && (
                    <button className="btn ghost small" title={t('chat.remove')} aria-label={t('chat.remove')} onClick={() => { if (confirm(t('chat.removeConfirm', { name: p?.name ?? '' }))) void client.removeMember(id, mid).catch((e) => setError(errorText(e))); }}>−</button>
                  )}
                </div>
              );
            })}
          </div>
          {(conv.kind === 'group' || conv.kind === 'internal') && conv.workspaceId && <IntegrationsPanel conv={conv} />}
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
        <NewIssueDialog conversationId={id} originMessageId={newIssue.origin?.id} topicId={activeFilter}
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
function SystemRow({ m, onIssue, canPost, live, cardActions }: { m: MessageDTO; onIssue: (id: string) => void; canPost: boolean; live: boolean; cardActions?: (m: MessageDTO, emailId: string | undefined) => CardActions }) {
  const d = useClient((s) => s.data)!;
  // gg: lo que dejó listo (tarjetas para confirmar) y respuestas rápidas (docs/GG-CHAT.md).
  if (m.body.startsWith('{"k":"gg.actions"')) {
    try { const g = JSON.parse(m.body); return <GgActionsRow key={m.id} messageId={m.id} conversationId={m.conversationId} p={g} />; } catch { return null; }
  }
  // Correo y WhatsApp traídos al chat (docs/CORREO.md): mensaje de quien lo trajo + tarjeta.
  let px: any = null;
  try { px = m.body.startsWith('{"k":"mail.') || m.body.startsWith('{"k":"wa.') ? JSON.parse(m.body) : null; } catch {}
  if (px?.k === 'mail.shared' && px.emailId) return <MailSharedRow m={m} p={px} onIssue={onIssue} actions={cardActions?.(m, px.emailId)} />;
  if (px?.k === 'wa.shared' && px.text != null) return <WaSharedRow m={m} p={px as WaShared} onIssue={onIssue} actions={cardActions?.(m, px.emailId)} />;
  if (px?.k === 'mail.comments' && px.emailId) return (
    <div id={`msg-${m.conversationId}-${m.seq}`} className="msg-card-row">
      {/* Una línea, no otra tarjeta: la tarjeta original ya muestra los comentarios. */}
      <CommentsNoticeLine count={px.count} title={px.title} lastByName={px.lastByName} lastExcerpt={px.lastExcerpt}
        icon={px.provider === 'whatsapp' ? <WaIcon size={14} /> : <span aria-hidden>✉</span>} onOpen={() => openMailDrawer(px.emailId, 'comments')} />
    </div>
  );
  if ((px?.k === 'mail.replied' || px?.k === 'mail.reply_failed') && px.emailId) return (
    <div id={`msg-${m.conversationId}-${m.seq}`} className="msg-sys">{systemText(m.body)} · <button className="link-btn" onClick={() => openMailDrawer(px.emailId)}>{t('lin.open')}</button></div>
  );
  // Tanda 1.7: es hoy, tarea hecha, tarea vencida y comentarios agrupados, como tarjetas.
  const notice = parseNotice(m.body);
  if (notice) return <Notice17Row m={m} p={notice} canPost={canPost} live={live} onIssue={onIssue} />;
  let p: any = null;
  try { p = m.body.startsWith('{') ? JSON.parse(m.body) : null; } catch {}
  // Una tarea nueva se ve como tarjeta completa, con sus comentarios y para comentar ahí mismo.
  // Igual con un evento nuevo: tarjeta con fecha, enlace para unirse y respuesta ahí mismo.
  if (p?.k === 'event.created' && p.eventId) return (
    <div id={`msg-${m.conversationId}-${m.seq}`} className="msg-card-row"><EventChatCard eventId={p.eventId} creatorId={m.authorId} /></div>
  );
  if (p?.k === 'issue.created' && p.issueId && !p.parentIssueId) return (
    <div id={`msg-${m.conversationId}-${m.seq}`} className="msg-card-row"><IssueChatCard issueId={p.issueId} creatorId={m.authorId} canPost={canPost} onOpen={onIssue} /></div>
  );
  const child = p?.k === 'derived.from' ? d.conversations.find((c) => c.id === p.childId) : null;
  // Los hilos no ensucian el chat: el aviso «se abrió un hilo» lo reemplaza el chip bajo su mensaje.
  if (p?.k === 'derived.from') return null;
  return (
    <div id={`msg-${m.conversationId}-${m.seq}`} className="msg-sys">
      {systemText(m.body)}
      {child && <> · <button className="link-btn" onClick={() => navigate(`/c/${child.id}`)}>⑂ {conversationTitle(d, child)}</button></>}
      {p?.issueId && <> · <button className="link-btn" onClick={() => onIssue(p.issueId)}>{t('lin.open')}</button></>}
      {p?.eventId && <> · <button className="link-btn" onClick={() => openEvent(p.eventId)}>{t('lin.open')}</button></>}
      {p?.k === 'call.transcript' && p.callId && <> · <button className="link-btn" onClick={() => openTranscript(p.callId)}>{t('call.transcriptOpen')}</button></>}
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
function groupLinkRuns(rows: Row[], expanded: Set<string>, highlight: number | null, readFrom: number): Row[] {
  const out: Row[] = [];
  let run: Extract<Row, { kind: 'msg' }>[] = [];
  const flush = () => {
    const key = run.length ? `lg${run[0]!.m.id}` : '';
    if (run.length >= 3 && !expanded.has(key) && !run.some((r) => r.m.seq === highlight || r.m.seq > readFrom)) out.push({ kind: 'links', key, msgs: run.map((r) => r.m) });
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
