/**
 * Pantalla «Hoy» personalizable y guía «Qué puedes hacer en chaggu» (docs/HOY.md; solo web y escritorio).
 * La lógica pura (plantillas, orden, tamaños, guardado, «no usado primero») vive en ../home-layout.ts.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { CallHistoryItemDTO, ConversationDTO, MailConnectionDTO, WaAccountDTO, WaChatDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { locale, t, tn } from '../i18n.ts';
import { ht, type HomeKey } from '../home-i18n.ts';
import {
  TEMPLATE_IDS, applyTemplate, dismissGuide, gridRows, guideView, loadGuide, loadLayout, moveBy, moveTo, noteKey,
  resetLayout, restoreDismissed, saveGuide, saveLayout, setCompactStats, setFavorites, setSize, setVisible, touchGuide,
  type BlockId, type GuideId, type GuideSignals, type GuideState, type HomeLayout,
} from '../home-layout.ts';
import { asset, navigate } from '../router.ts';
import { activityOf, isMuted } from '../home-order.ts';
import { ConvAvatar, Modal, OrgMark, SideIcon, Avatar, conversationTitle, counterpartOrg, directOtherId, isGgChat, orgById, personById, timeLabel } from '../ui.tsx';
import { openDialog } from '../actions.tsx';
import { toast } from '../menu.tsx';
import { MAX_PANES, openBeside, splitAvailable, usePanes } from '../split.ts';
import { currentTheme, setThemePreference, useThemePreference } from '../theme.ts';
import { MailConnectNudge, ProviderIcon, WaIcon, openMailDrawer } from './Mail.tsx';
import { TodayAgenda } from './Calendar.tsx';
import { RemindersSection } from './Bring.tsx';
import { IssueDrawer, IssueRow, NewIssueDialog, isClosed } from './Issues.tsx';
import { MentionsInbox } from './Mentions.tsx';
import { InviteDialog } from './Dialogs.tsx';
import { ConvCard, InviteColleague } from './Pages.tsx';
import { openCreateGroup } from './Groups.tsx';
import { openGgChat } from './Assistant.tsx';
import { isMac, quickKey } from './Quick.tsx';
import '../home.css';

const EMPTY: never[] = [];

function greeting() {
  const h = new Date().getHours();
  return t(h < 12 ? 'today.morning' : h < 19 ? 'today.afternoon' : 'today.evening');
}
const blockName = (id: BlockId) => ht(`blk.${id}` as HomeKey);

// ---------- Datos que no están en el snapshot (se piden al abrir Hoy; fallar = «no se sabe») ----------
function useHomeFetches(l: HomeLayout) {
  const d = useClient((s) => s.data)!;
  const waRevision = useClient((s) => s.waRevision);
  const callsKey = useClient((s) => Object.values(s.calls).map((c) => c?.id ?? '').sort().join(','));
  const [wa, setWa] = useState<WaAccountDTO[] | null>(null);
  const [waChats, setWaChats] = useState<WaChatDTO[] | null>(null);
  const [mail, setMail] = useState<MailConnectionDTO[] | null>(null);
  const [mailUnread, setMailUnread] = useState<number | null>(null);
  const [calls, setCalls] = useState<CallHistoryItemDTO[] | null>(null);
  const shows = (id: BlockId) => l.blocks.some((b) => b.id === id && b.visible);
  const waOn = shows('whatsapp');
  const mailOn = shows('mail');
  useEffect(() => { client.request<{ accounts: WaAccountDTO[] }>('/whatsapp/accounts').then((r) => setWa(r.accounts)).catch(() => {}); }, [waRevision]);
  const waConnected = !!wa?.some((a) => a.status === 'connected');
  useEffect(() => {
    if (!waOn || !waConnected) return;
    client.request<{ chats: WaChatDTO[] }>('/whatsapp/chats?groups=0').then((r) => setWaChats(r.chats)).catch(() => {});
  }, [waOn, waConnected, waRevision]);
  useEffect(() => { if (d.features?.mail !== false) client.mailConnections().then(setMail).catch(() => {}); }, [d.features?.mail]);
  const mailConnected = !!mail?.some((c) => c.status === 'active');
  useEffect(() => { if (mailOn && mailConnected) client.mailUnread().then(setMailUnread).catch(() => {}); }, [mailOn, mailConnected]);
  useEffect(() => { if (d.features?.calls !== false) client.callHistory().then((r) => setCalls(r.calls)).catch(() => {}); }, [d.features?.calls, callsKey]);
  return { wa, waConnected, waChats, mail, mailConnected, mailUnread, calls };
}
type Fetches = ReturnType<typeof useHomeFetches>;

/** Qué dicen los datos sobre cada tarjeta de la guía (true = ya lo usó; undefined = no se sabe). */
function useGuideSignals(f: Fetches): GuideSignals {
  const d = useClient((s) => s.data)!;
  const madeTask = useClient((s) => Object.values(s.issues).some((i) => i.createdBy === s.data?.me.id));
  const madeTopic = useClient((s) => Object.values(s.topics).some((list) => list.some((x) => x.createdBy === s.data?.me.id)));
  const inCall = useClient((s) => Object.values(s.calls).some((c) => !!c && !c.endedAt));
  const panes = usePanes();
  const theme = useThemePreference();
  const colleagues = d.people.some((p) => p.id !== d.me.id && p.kind !== 'agent' && p.orgId === d.me.primaryOrgId);
  return {
    call: inCall || (f.calls ? f.calls.length > 0 : undefined),
    panes: panes.length > 1 || undefined,
    whatsapp: f.wa ? f.waConnected : undefined,
    mail: f.mail ? f.mailConnected : undefined,
    task: madeTask || undefined,
    topics: madeTopic || undefined,
    gg: d.conversations.some(isGgChat) || undefined,
    invite: colleagues || undefined,
    dark: theme !== 'system' || undefined,
  };
}

// ---------- Pantalla ----------
export function TodayScreen() {
  const d = useClient((s) => s.data)!;
  const pending = useClient((s) => s.pending);
  const uid = d.me.id;
  const [layout, setLayoutState] = useState<HomeLayout>(() => loadLayout(uid));
  useEffect(() => { setLayoutState(loadLayout(uid)); }, [uid]);
  const update = (fn: (l: HomeLayout) => HomeLayout) => setLayoutState((l) => { const n = fn(l); if (n !== l) saveLayout(uid, n); return n; });
  const [editing, setEditing] = useState(false);
  const [grabbed, setGrabbed] = useState<BlockId | null>(null);
  const [announce, setAnnounce] = useState('');
  const [openIssue, setOpenIssue] = useState<string | null>(null);
  const f = useHomeFetches(layout);
  useEffect(() => { client.loadIssues({ mine: true, open: true }).catch(() => {}); }, []);

  // Columnas según el ancho real del área (no de la ventana): la barra lateral y los paneles cambian el espacio.
  const gridRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(2);
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const fit = () => { const w = el.clientWidth; setCols(w >= 1060 ? 3 : w >= 620 ? 2 : 1); };
    fit();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  const visibleIds = new Set(d.conversations.map((c) => c.id));
  const issues = useClient((s) => s.issues);
  const mine = useMemo(() => Object.values(issues).filter((i) => i.ownerId === d.me.id && !isClosed(i) && (!i.conversationId || visibleIds.has(i.conversationId)))
    .sort((a, b) => (a.dueDate ?? '9').localeCompare(b.dueDate ?? '9')), [issues, d]);
  const unreadConvs = d.conversations.filter((c) => c.unread > 0);
  const unread = unreadConvs.reduce((n, c) => n + c.unread, 0);
  const orgsCount = new Set(d.workspaces.flatMap((w) => w.organizationIds)).size;
  const rawDate = new Date().toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' });
  const date = rawDate.charAt(0).toUpperCase() + rawDate.slice(1);

  // Peso estimado de cada bloque (filas aprox.) para repartir las columnas sin huecos.
  const weight = (id: BlockId): number => {
    const rows = (n: number, max: number) => 1 + Math.min(Math.max(n, 1), max) * 1.3;
    switch (id) {
      case 'waiting': return rows(unreadConvs.length, 8);
      case 'tasks': return rows(mine.length, 5);
      case 'recent': return rows(6, 6);
      case 'pinned': return rows(d.conversations.filter((c) => c.pinnedAt).length, 6);
      case 'mentions': return 5;
      case 'note': return 3;
      case 'agenda': case 'reminders': return 2.5;
      default: return 3;
    }
  };
  const rows = gridRows(layout.blocks, cols, weight);
  const shown = layout.blocks.filter((b) => b.visible);
  const hidden = layout.blocks.filter((b) => !b.visible);

  // Tras mover con el teclado el bloque cambia de columna (se vuelve a montar): el foco vuelve a él.
  useEffect(() => {
    if (grabbed) document.querySelector<HTMLElement>(`[data-home-block="${grabbed}"]`)?.focus();
  }, [layout, grabbed]);

  const onBlockKey = (id: BlockId) => (e: KeyboardEvent<HTMLElement>) => {
    if (!editing || e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (grabbed === id) { setGrabbed(null); setAnnounce(ht('home.dropped', { name: blockName(id), n: shown.findIndex((b) => b.id === id) + 1, total: shown.length })); }
      else { setGrabbed(id); setAnnounce(ht('home.grabbed', { name: blockName(id) })); }
      return;
    }
    if (e.key === 'Escape' && grabbed) { e.preventDefault(); e.stopPropagation(); setGrabbed(null); return; }
    const delta = e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : 0;
    if (!delta) return;
    e.preventDefault();
    if (grabbed !== id) {
      // Sin seleccionar, las flechas pasan de un bloque a otro.
      const at = shown.findIndex((b) => b.id === id);
      const next = shown[at + delta];
      if (next) document.querySelector<HTMLElement>(`[data-home-block="${next.id}"]`)?.focus();
      return;
    }
    update((l) => moveBy(l, id, delta));
    const at = Math.max(0, Math.min(shown.length - 1, shown.findIndex((b) => b.id === id) + delta));
    setAnnounce(ht('home.dropped', { name: blockName(id), n: at + 1, total: shown.length }));
  };

  // Arrastrar y soltar (HTML5), solo en modo Personalizar.
  const dragId = useRef<BlockId | null>(null);
  const [drop, setDrop] = useState<{ id: BlockId; where: 'before' | 'after' } | null>(null);
  const dnd = (id: BlockId) => editing ? {
    draggable: true,
    onDragStart: (e: DragEvent) => { dragId.current = id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); },
    onDragEnd: () => { dragId.current = null; setDrop(null); },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!dragId.current || dragId.current === id) return;
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      const where = e.clientY < r.top + r.height / 2 ? 'before' : 'after';
      if (drop?.id !== id || drop.where !== where) setDrop({ id, where });
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const from = dragId.current;
      if (from && drop) update((l) => moveTo(l, from, drop.id, drop.where));
      dragId.current = null; setDrop(null);
    },
  } : {};

  const content = (id: BlockId): ReactNode => {
    switch (id) {
      case 'stats': return <StatsBlock compact={layout.compactStats} narrow={cols > 1 && layout.blocks.find((b) => b.id === 'stats')?.size === 'narrow'} unread={unread} waiting={unreadConvs.length} spaces={d.workspaces.length} tasks={mine.length} />;
      case 'guide': return <GuideBlock f={f} />;
      case 'waiting': return <WaitingBlock list={unreadConvs} />;
      case 'agenda': return <TodayAgenda />;
      case 'reminders': return <RemindersSection />;
      case 'tasks': return <TasksBlock list={mine} onOpen={setOpenIssue} />;
      case 'recent': return <RecentBlock />;
      case 'mentions': return <><BlockHead id="mentions" link={null} /><div className="home-scroll"><MentionsInbox /></div></>;
      case 'pinned': return <PinnedBlock />;
      case 'calls': return <CallsBlock history={f.calls} />;
      case 'mail': return <MailBlock f={f} />;
      case 'whatsapp': return <WaBlock f={f} />;
      case 'favorites': return <FavoritesBlock ids={layout.favorites} onPick={(ids) => update((l) => setFavorites(l, ids))} />;
      case 'note': return <NoteBlock uid={uid} />;
    }
  };

  const block = (id: BlockId) => {
    const pref = layout.blocks.find((b) => b.id === id)!;
    const at = shown.findIndex((b) => b.id === id);
    return (
      <section key={id} data-home-block={id} className={`home-block is-${pref.size} ${editing ? 'is-editing' : ''} ${grabbed === id ? 'is-grabbed' : ''} ${drop?.id === id ? `drop-${drop.where}` : ''}`}
        tabIndex={editing ? 0 : undefined} aria-label={editing ? `${blockName(id)} · ${ht('home.drag')}` : undefined} aria-roledescription={editing ? 'block' : undefined}
        onKeyDown={onBlockKey(id)} {...dnd(id)}>
        {editing && (
          <div className="home-block-bar" onKeyDown={(e) => e.stopPropagation()}>
            <span className="home-grip" aria-hidden>⠿</span>
            <b className="grow ellipsis">{blockName(id)}</b>
            <button className="home-tool" disabled={at <= 0} title={ht('home.moveUp')} aria-label={`${ht('home.moveUp')}: ${blockName(id)}`} onClick={() => update((l) => moveBy(l, id, -1))}>↑</button>
            <button className="home-tool" disabled={at >= shown.length - 1} title={ht('home.moveDown')} aria-label={`${ht('home.moveDown')}: ${blockName(id)}`} onClick={() => update((l) => moveBy(l, id, 1))}>↓</button>
            <span className="home-size" role="group" aria-label={blockName(id)}>
              <button className={pref.size === 'narrow' ? 'on' : ''} aria-pressed={pref.size === 'narrow'} onClick={() => update((l) => setSize(l, id, 'narrow'))}>{ht('home.narrow')}</button>
              <button className={pref.size === 'wide' ? 'on' : ''} aria-pressed={pref.size === 'wide'} onClick={() => update((l) => setSize(l, id, 'wide'))}>{ht('home.wide')}</button>
            </span>
            {id === 'stats' && <button className={`home-tool wide-txt ${layout.compactStats ? 'on' : ''}`} aria-pressed={layout.compactStats} onClick={() => update((l) => setCompactStats(l, !l.compactStats))}>{ht('stats.compactHint')}</button>}
            <button className="home-tool" title={ht('home.hide')} aria-label={`${ht('home.hide')}: ${blockName(id)}`} onClick={() => update((l) => setVisible(l, id, false))}>×</button>
          </div>
        )}
        <div className="home-block-body" inert={editing || undefined}>{content(id)}</div>
      </section>
    );
  };

  return (
    <div className="page home-page"><div className="page-narrow home-wide">
      <div className="home-head">
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="small muted">{date}</div>
          <h1>{greeting()}, {d.me.name.split(' ')[0]}.</h1>
          <div className="muted">
            {unread ? t('today.summary', { messages: tn(unread, 'n.newMessage', 'n.newMessages'), conversations: tn(unreadConvs.length, 'n.conversation', 'n.conversations') }) : t('today.upToDate')}
            {' · '}{t('today.spacesWith', { spaces: tn(d.workspaces.length, 'n.space', 'n.spaces'), companies: tn(Math.max(0, orgsCount - 1), 'n.company', 'n.companies') })}
          </div>
        </div>
        <button className={`btn small ${editing ? 'primary' : ''} home-customize`} aria-pressed={editing} onClick={() => { setEditing((x) => !x); setGrabbed(null); }}>
          {editing ? `✓ ${ht('home.done')}` : `⚙ ${ht('home.customize')}`}
        </button>
      </div>
      {!editing && <MailConnectNudge />}
      {editing && (
        <div className="home-editor card" role="region" aria-label={ht('home.editing')}>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <b className="grow">{ht('home.editing')}</b>
            <button className="btn small ghost" onClick={() => { update(() => resetLayout(uid)); toast(ht('home.resetDone')); }}>↺ {ht('home.reset')}</button>
          </div>
          <div className="small muted">{ht('home.editHint')}</div>
          <div className="eyebrow" style={{ marginTop: 6 }}>{ht('home.templates')}</div>
          <div className="home-templates">
            {TEMPLATE_IDS.map((id) => (
              <button key={id} className={`home-template ${layout.template === id ? 'on' : ''}`} aria-pressed={layout.template === id} onClick={() => update((l) => applyTemplate(l, id))}>
                <b>{ht(`home.tpl.${id}` as HomeKey)}</b><span className="small muted">{ht(`home.tpl.${id}.d` as HomeKey)}</span>
              </button>
            ))}
          </div>
          {hidden.length > 0 && <>
            <div className="eyebrow" style={{ marginTop: 6 }}>{ht('home.hidden')}</div>
            <div className="chips">
              {hidden.map((b) => <button key={b.id} className="chip ghost" onClick={() => update((l) => setVisible(l, b.id, true))}>{ht('home.add', { name: blockName(b.id) })}</button>)}
            </div>
          </>}
        </div>
      )}
      {d.workspaces.length === 0 && (
        <div className="card home-start">
          <div className="serif" style={{ fontSize: 30 }}>{t('today.startTitle')}</div>
          <div className="muted">{t('today.startBody')}</div>
          <button className="btn primary" onClick={() => openCreateGroup()}>{t('today.newSpace')}</button>
        </div>
      )}
      <div className="sr-only" aria-live="polite">{announce}</div>
      <div ref={gridRef} className={`home-grid cols-${cols}`}>
        {shown.length === 0 && <div className="empty">{ht('home.noneVisible')}</div>}
        {rows.map((r, i) => r.kind === 'wide'
          ? <div key={`w-${r.id}`} className="home-row">{block(r.id)}</div>
          : <div key={`c-${i}-${r.cols.map((c) => c.join('.')).join('|')}`} className="home-row home-cols" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
              {r.cols.map((c, k) => <div key={k} className="home-col">{c.map(block)}</div>)}
            </div>)}
      </div>
      {openIssue && <IssueDrawer id={openIssue} onClose={() => setOpenIssue(null)} />}
      {pending.length > 0 && <div className="hint" style={{ marginTop: 16 }}>{t('today.queued')}: {pending.length}</div>}
    </div></div>
  );
}

function BlockHead({ id, count, link }: { id: BlockId; count?: ReactNode; link: { label: string; to: () => void } | null }) {
  return (
    <div className="row home-block-head">
      <span className="eyebrow grow">{blockName(id)}</span>
      {count != null && <span className="small muted">{count}</span>}
      {link && <button className="btn ghost small" onClick={link.to}>{link.label}</button>}
    </div>
  );
}

// ---------- Números ----------
function StatsBlock({ compact, narrow, unread, waiting, spaces, tasks }: { compact: boolean; narrow: boolean; unread: number; waiting: number; spaces: number; tasks: number }) {
  const items: [string, number, boolean, () => void][] = [
    [t('today.unread'), unread, true, () => navigate('/conversaciones')],
    [t('today.waiting'), waiting, true, () => navigate('/conversaciones')],
    [t('today.spaces'), spaces, false, () => navigate('/espacios')],
    [t('issue.yours'), tasks, false, () => navigate('/asuntos')],
  ];
  if (compact) {
    return (
      <div className="home-stats-compact">
        {items.map(([label, n, dark]) => <button key={label} className={`home-stat-chip ${dark ? 'dark' : ''}`} onClick={items.find((x) => x[0] === label)![3]}><b>{n}</b><span>{label}</span></button>)}
      </div>
    );
  }
  return (
    <div className={`stats home-stats ${narrow ? 'is-narrow' : ''}`}>
      {items.map(([label, n, dark, go]) => <button key={label} className={`stat ${dark ? 'dark' : ''}`} onClick={go}><div className="eyebrow">{label}</div><div className="num">{n}</div></button>)}
    </div>
  );
}

// ---------- Listas de chats ----------
const WAIT_MAX = 8;
function WaitingBlock({ list }: { list: ConversationDTO[] }) {
  return (
    <>
      <BlockHead id="waiting" count={tn(list.length, 'n.conversation', 'n.conversations')} link={null} />
      <div className="list">
        {list.length ? list.slice(0, WAIT_MAX).map((c) => <ConvCard key={c.id} c={c} />) : <div className="empty">{t('today.nothing')}</div>}
        {list.length > WAIT_MAX && <button className="btn ghost small" onClick={() => navigate('/conversaciones')}>{t('nav.inbox')} · {list.length} ›</button>}
      </div>
    </>
  );
}
function RecentBlock() {
  const convs = useClient((s) => s.data?.conversations ?? EMPTY);
  const recent = useMemo(() => convs.filter((c) => c.lastMessageAt).slice(0, 6), [convs]);
  return (
    <>
      <BlockHead id="recent" link={null} />
      <div className="list">{recent.map((c) => <ConvCard key={c.id} c={c} />)}</div>
      <button className="btn" style={{ marginTop: 12, width: '100%' }} onClick={() => openCreateGroup()}>{t('today.newSpace')}</button>
    </>
  );
}
function PinnedBlock() {
  const convs = useClient((s) => s.data?.conversations ?? EMPTY);
  const pinned = useMemo(() => convs.filter((c) => c.pinnedAt).sort((a, b) => (b.pinnedAt ?? '').localeCompare(a.pinnedAt ?? '')), [convs]);
  return (
    <>
      <BlockHead id="pinned" count={pinned.length || null} link={null} />
      <div className="list">{pinned.length ? pinned.slice(0, 6).map((c) => <ConvCard key={c.id} c={c} />) : <div className="empty">{ht('pinned.empty')}</div>}</div>
    </>
  );
}
function TasksBlock({ list, onOpen }: { list: import('@tiecoms/contracts').IssueDTO[]; onOpen: (id: string) => void }) {
  return (
    <>
      <BlockHead id="tasks" link={{ label: `${t('nav.issues')} ›`, to: () => navigate('/asuntos') }} />
      <div className="list">{list.length ? list.slice(0, 5).map((i) => <IssueRow key={i.id} i={i} onOpen={onOpen} />) : <div className="empty">{t('issue.yoursEmpty')}</div>}</div>
    </>
  );
}

/** Un chat en pequeño (ícono + nombre + no leídos) para Accesos rápidos. */
function ConvTile({ c }: { c: ConversationDTO }) {
  const d = useClient((s) => s.data)!;
  const other = c.kind === 'direct' ? personById(d, directOtherId(d, c)) : null;
  const org = other ? orgById(d, other.orgId) : c.workspaceId ? counterpartOrg(d, c.workspaceId) : null;
  return (
    <button className="home-tile" onClick={() => navigate(`/c/${c.id}`)} title={conversationTitle(d, c)}>
      {other ? <Avatar person={other} org={org} size={30} /> : c.avatarUrl ? <ConvAvatar c={c} size={30} /> : c.deriveKind === 'side' ? <SideIcon size={30} /> : <OrgMark org={org} size={30} />}
      <span className="ellipsis grow">{conversationTitle(d, c)}</span>
      {c.unread > 0 && <span className={`pill ${isMuted(c) ? 'is-muted' : ''}`}>{c.unread}</span>}
    </button>
  );
}
function FavoritesBlock({ ids, onPick }: { ids: string[]; onPick: (ids: string[]) => void }) {
  const convs = useClient((s) => s.data?.conversations ?? EMPTY);
  const list = useMemo(() => {
    if (ids.length) return ids.map((id) => convs.find((c) => c.id === id)).filter((c): c is ConversationDTO => !!c);
    const pinned = convs.filter((c) => c.pinnedAt);
    const active = [...convs].filter((c) => !c.pinnedAt && !c.parentId).sort((a, b) => activityOf(b).localeCompare(activityOf(a)));
    return [...pinned, ...active].slice(0, 8);
  }, [ids, convs]);
  const pick = () => openDialog((close) => <FavoritesDialog initial={ids} onClose={close} onSave={(x) => { onPick(x); close(); }} />);
  return (
    <>
      <BlockHead id="favorites" count={ids.length ? null : ht('fav.auto')} link={{ label: `✎ ${ht('fav.edit')}`, to: pick }} />
      {list.length ? <div className="home-tiles">{list.map((c) => <ConvTile key={c.id} c={c} />)}</div> : <div className="empty">{ht('fav.empty')}</div>}
    </>
  );
}
function FavoritesDialog({ initial, onClose, onSave }: { initial: string[]; onClose: () => void; onSave: (ids: string[]) => void }) {
  const d = useClient((s) => s.data)!;
  const [sel, setSel] = useState<string[]>(initial);
  const [q, setQ] = useState('');
  const list = d.conversations.filter((c) => !q || conversationTitle(d, c).toLowerCase().includes(q.toLowerCase())).slice(0, 60);
  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= 12 ? s : [...s, id]));
  return (
    <Modal title={ht('fav.pick')} onClose={onClose}>
      <div className="small muted">{ht('fav.pickHint')}</div>
      <input className="input" autoFocus placeholder={ht('fav.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="home-pick">
        {list.map((c) => (
          <label key={c.id} className="home-pick-row">
            <input type="checkbox" checked={sel.includes(c.id)} onChange={() => toggle(c.id)} />
            <span className="ellipsis grow">{conversationTitle(d, c)}</span>
          </label>
        ))}
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={() => setSel([])}>{ht('fav.auto')}</button>
        <button className="btn primary" onClick={() => onSave(sel)}>{t('common.done')}</button>
      </div>
    </Modal>
  );
}

// ---------- Llamadas, correo, WhatsApp ----------
function CallsBlock({ history }: { history: CallHistoryItemDTO[] | null }) {
  const d = useClient((s) => s.data)!;
  const calls = useClient((s) => s.calls);
  const live = useMemo(() => Object.values(calls).filter((c): c is NonNullable<typeof c> => !!c && !c.endedAt), [calls]);
  const title = (conversationId: string) => { const c = d.conversations.find((x) => x.id === conversationId); return c ? conversationTitle(d, c) : t('call.title'); };
  const recent = (history ?? []).filter((x) => x.call.endedAt).slice(0, 4);
  return (
    <>
      <BlockHead id="calls" link={{ label: ht('calls.open'), to: () => navigate('/llamadas') }} />
      <div className="list" style={{ gap: 6 }}>
        {live.map((c) => (
          <button key={c.id} className="card home-line is-live" onClick={() => navigate(`/c/${c.conversationId}`)}>
            <span className="home-live-dot" aria-hidden />
            <span className="grow ellipsis"><b>{title(c.conversationId)}</b> <span className="small muted">· {t('calls.liveNow')}</span></span>
            <span className="btn small accent" aria-hidden>{ht('calls.join')}</span>
          </button>
        ))}
        {recent.map((x) => (
          <button key={x.call.id} className="card home-line" onClick={() => navigate(`/c/${x.call.conversationId}`)}>
            <span aria-hidden>{x.call.kind === 'video' ? '🎥' : '📞'}</span>
            <span className="grow ellipsis">{title(x.call.conversationId)}{x.missed && <span className="home-missed"> · {ht('calls.missed')}</span>}</span>
            <span className="small muted">{timeLabel(x.call.startedAt)}</span>
          </button>
        ))}
        {!live.length && !recent.length && <div className="empty">{ht('calls.none')}</div>}
      </div>
    </>
  );
}

function MailBlock({ f }: { f: Fetches }) {
  const d = useClient((s) => s.data)!;
  const mails = useClient((s) => s.mails);
  const pending = useMemo(() => Object.values(mails).filter((m) => m.provider !== 'whatsapp' && m.status === 'pending' && m.direction === 'in')
    .sort((a, b) => (b.sentAt ?? '').localeCompare(a.sentAt ?? '')).slice(0, 5), [mails]);
  return (
    <>
      <BlockHead id="mail" count={f.mailUnread ? ht('mail.inboxUnread', { n: f.mailUnread }) : null} link={{ label: ht('mail.open'), to: () => navigate('/correo') }} />
      <div className="list" style={{ gap: 6 }}>
        {f.mail && !f.mailConnected && (
          <div className="card home-connect"><span className="row" style={{ gap: 4 }} aria-hidden><ProviderIcon provider="google" size={20} /><ProviderIcon provider="microsoft" size={20} /></span>
            <span className="small grow">{ht('mail.notConnected')}</span><button className="btn small primary" onClick={() => navigate('/correo')}>{t('mail.connect')}</button></div>
        )}
        {pending.map((m) => {
          const conv = d.conversations.find((c) => c.id === m.conversationId);
          return (
            <button key={m.id} className="card home-line" onClick={() => openMailDrawer(m.id)}>
              <ProviderIcon provider={m.provider as 'google'} size={18} />
              <span className="grow" style={{ minWidth: 0 }}>
                <b className="ellipsis" style={{ display: 'block' }}>{m.subject || t('mail.noSubject')}</b>
                <span className="small muted ellipsis" style={{ display: 'block' }}>{m.from?.name ?? m.from?.email}{conv ? ` · ${conversationTitle(d, conv)}` : ''}</span>
              </span>
              <span className="small muted">{timeLabel(m.sentAt)}</span>
            </button>
          );
        })}
        {(!f.mail || f.mailConnected) && !pending.length && <div className="empty">{ht('mail.pendingEmpty')}</div>}
      </div>
    </>
  );
}

function WaBlock({ f }: { f: Fetches }) {
  const unread = (f.waChats ?? []).filter((c) => c.unread > 0 && !c.hidden).sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '')).slice(0, 6);
  return (
    <>
      <BlockHead id="whatsapp" count={unread.length || null} link={{ label: ht('wa.open'), to: () => navigate('/whatsapp') }} />
      <div className="list" style={{ gap: 6 }}>
        {f.wa && !f.waConnected && (
          <div className="card home-connect"><WaIcon size={20} /><span className="small grow">{ht('wa.notConnected')}</span><button className="btn small primary" onClick={() => navigate('/whatsapp')}>{ht('guide.whatsapp.a')}</button></div>
        )}
        {unread.map((c) => (
          <button key={`${c.accountId}:${c.jid}`} className="card home-line" onClick={() => navigate('/whatsapp')}>
            <WaIcon size={18} />
            <span className="grow" style={{ minWidth: 0 }}>
              <b className="ellipsis" style={{ display: 'block' }}>{c.name}</b>
              <span className="small muted ellipsis" style={{ display: 'block' }}>{c.lastPreview ?? ''}</span>
            </span>
            <span className="pill home-wa-pill">{c.unread}</span>
          </button>
        ))}
        {f.waConnected && !unread.length && <div className="empty">{ht('wa.none')}</div>}
        {!f.wa && <div className="empty">{ht('wa.none')}</div>}
      </div>
    </>
  );
}

// ---------- Nota rápida ----------
function NoteBlock({ uid }: { uid: string }) {
  const [text, setText] = useState(() => { try { return localStorage.getItem(noteKey(uid)) ?? ''; } catch { return ''; } });
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const h = setTimeout(() => {
      try { if (text) localStorage.setItem(noteKey(uid), text); else localStorage.removeItem(noteKey(uid)); setSaved(true); } catch { /* sin almacenamiento */ }
    }, 400);
    return () => clearTimeout(h);
  }, [text, uid]);
  return (
    <>
      <BlockHead id="note" count={saved && text ? ht('note.saved') : null} link={text ? { label: ht('note.clear'), to: () => setText('') } : null} />
      <textarea className="input home-note" aria-label={blockName('note')} placeholder={ht('note.ph')} value={text} onChange={(e) => { setSaved(false); setText(e.target.value); }} />
    </>
  );
}

// ---------- Guía «Qué puedes hacer en chaggu» ----------
const GUIDE_ICON: Record<GuideId, string> = { call: '📞', panes: '▥', whatsapp: '', mail: '✉', task: '◆', topics: '#', gg: '', invite: '＋', dark: '◐', shortcuts: '⌘' };
const GUIDE_TONE: Record<GuideId, string> = { call: 'accent', panes: 'blue', whatsapp: 'green', mail: 'blue', task: 'amber', topics: 'violet', gg: 'teal', invite: 'accent', dark: 'ink', shortcuts: 'ink' };
const GUIDE_FEW = 4;

/**
 * Qué hace cada botón. Destinos que aún no existen en esta rama (docs/HOY.md › «Destinos»):
 * - call: la «llamada rápida» con enlace para invitados va en otra rama; mientras, abre /llamadas (Nueva llamada → chat → 🔗).
 * - panes: usa los paneles de split.ts (hoy MAX_PANES); los paneles nuevos (hasta 8, correo/WhatsApp/tareas) llegan en su rama.
 */
function runGuide(id: GuideId) {
  const s = client.getState();
  const d = s.data!;
  const byActivity = [...d.conversations].filter((c) => !c.parentId).sort((a, b) => activityOf(b).localeCompare(activityOf(a)));
  switch (id) {
    case 'call': navigate('/llamadas'); return;
    case 'panes': {
      const [a, b] = byActivity;
      if (!a) { navigate('/conversaciones'); return; }
      navigate(`/c/${a.id}`);
      if (b && splitAvailable()) { openBeside(b.id, a.id); toast(ht('guide.panesHint')); } else toast(ht('guide.panesNarrow'));
      return;
    }
    case 'whatsapp': navigate('/whatsapp'); return;
    case 'mail': navigate('/correo'); return;
    case 'task': openDialog((close) => <NewIssueDialog onClose={close} onCreated={(i) => navigate(`/c/${i.conversationId}?issue=${i.id}`)} />); return;
    case 'topics': {
      const g = byActivity.find((c) => c.kind === 'group' && c.canManage) ?? byActivity.find((c) => c.kind === 'group');
      if (g) { navigate(`/c/${g.id}`); toast(ht('guide.topicsHint'), undefined, 5000); } else openCreateGroup();
      return;
    }
    case 'gg': void openGgChat(); return;
    case 'invite': {
      const myOrg = orgById(d, d.me.primaryOrgId);
      if (myOrg && (myOrg.myRole === 'owner' || myOrg.myRole === 'admin')) {
        openDialog((close) => <Modal title={ht('guide.invite.t')} onClose={close}><InviteColleague orgId={myOrg.id} orgName={myOrg.name} /></Modal>);
        return;
      }
      const ws = d.workspaces.find((w) => w.myRole === 'lead' || w.myRole === 'admin');
      if (ws) openDialog((close) => <InviteDialog workspaceId={ws.id} onClose={close} />);
      else navigate('/participantes');
      return;
    }
    case 'dark': setThemePreference(currentTheme() === 'dark' ? 'light' : 'dark'); return;
    case 'shortcuts': openDialog((close) => <ShortcutsDialog onClose={close} />); return;
  }
}

function GuideBlock({ f }: { f: Fetches }) {
  const uid = useClient((s) => s.data?.me.id ?? '');
  const [g, setG] = useState<GuideState>(() => loadGuide(uid));
  const [all, setAll] = useState(false);
  useThemePreference(); // el botón de Modo oscuro dice «Volver a claro» cuando ya está oscuro
  const signals = useGuideSignals(f);
  const view = guideView(g, signals);
  const save = (n: GuideState) => { setG(n); saveGuide(uid, n); };
  const items = all ? view.items : view.items.slice(0, GUIDE_FEW);
  const mod = isMac ? '⌘' : 'Ctrl+';
  const desc = (id: GuideId) => ht(`guide.${id}.d` as HomeKey, { n: MAX_PANES, k: quickKey, f: `${mod}F` });
  const action = (id: GuideId) => (id === 'dark' && currentTheme() === 'dark' ? ht('guide.dark.aLight') : ht(`guide.${id}.a` as HomeKey));
  const pct = Math.round((view.discovered / view.total) * 100);
  return (
    <div className="home-guide">
      <div className="row home-guide-head" style={{ flexWrap: 'wrap' }}>
        <span className="serif home-guide-title grow">{ht('guide.title')}</span>
        <span className="home-progress" role="progressbar" aria-valuemin={0} aria-valuemax={view.total} aria-valuenow={view.discovered} aria-label={ht('guide.progress', { n: view.discovered, total: view.total })}>
          <span className="home-progress-bar"><span style={{ width: `${pct}%` }} /></span>
          <span className="small muted">{ht('guide.progress', { n: view.discovered, total: view.total })}</span>
        </span>
      </div>
      {view.items.length === 0 || view.items.every((x) => x.used) ? <div className="small muted" style={{ marginBottom: 8 }}>{ht('guide.allDone')}</div> : null}
      <div className="home-guide-grid">
        {items.map(({ id, used }) => (
          <div key={id} className={`home-guide-card tone-${GUIDE_TONE[id]} ${used ? 'is-used' : ''}`}>
            <span className="home-guide-ico" aria-hidden>
              {id === 'whatsapp' ? <WaIcon size={18} /> : id === 'gg' ? <img src={asset('/gg-mark.svg')} alt="" width={20} height={20} /> : GUIDE_ICON[id]}
            </span>
            <span className="home-guide-text">
              <b>{ht(`guide.${id}.t` as HomeKey)}{used && <span className="home-used" title={ht('guide.used')}> ✓</span>}</b>
              <span className="small muted">{desc(id)}</span>
            </span>
            <span className="home-guide-actions">
              <button className={`btn small ${used ? '' : 'primary'}`} onClick={() => { save(touchGuide(g, id)); runGuide(id); }}>{action(id)}</button>
              <button className="icon-btn home-guide-x" aria-label={`${ht('guide.dismiss')}: ${ht(`guide.${id}.t` as HomeKey)}`} title={ht('guide.dismiss')} onClick={() => save(dismissGuide(g, id))}>×</button>
            </span>
          </div>
        ))}
      </div>
      <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        {view.items.length > GUIDE_FEW && <button className="btn ghost small" aria-expanded={all} onClick={() => setAll((x) => !x)}>{all ? ht('guide.less') : ht('guide.all', { n: view.items.length })}</button>}
        {view.dismissed > 0 && <button className="btn ghost small" onClick={() => save(restoreDismissed(g))}>{ht('guide.restore', { n: view.dismissed })}</button>}
      </div>
    </div>
  );
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const m = isMac ? '⌘' : 'Ctrl';
  const rows: [string[], string][] = [
    [[m, 'K'], ht('keys.new')], [[m, 'F'], ht('keys.find')], [[m, '⇧', 'F'], ht('keys.findAll')],
    [[m, 'B'], ht('keys.bold')], [['Enter'], ht('keys.send')], [['⇧', 'Enter'], ht('keys.newline')], [['Esc'], ht('keys.close')],
    [['↑', '↓', '←', '→'], ht('keys.home')],
  ];
  return (
    <Modal title={ht('keys.title')} onClose={onClose}>
      <div className="home-keys">
        {rows.map(([k, label]) => <div key={label} className="home-key-row"><span className="home-kbds">{k.map((x) => <kbd key={x}>{x}</kbd>)}</span><span>{label}</span></div>)}
      </div>
    </Modal>
  );
}
