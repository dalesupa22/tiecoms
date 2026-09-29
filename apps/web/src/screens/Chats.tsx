import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { BootstrapDTO, ConversationDTO, MessageDTO, PersonDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { attachmentSummaryText, errorText, t } from '../i18n.ts';
import { toast } from '../menu.tsx';
import { openDialog } from '../actions.tsx';
import { groupWorkspaces } from './Shell.tsx';
import { CreateGroupDialog } from './Groups.tsx';
import { navigate } from '../router.ts';
import { Avatar, ConvAvatar, Modal, OrgMark, conversationTitle, orgById, personById } from '../ui.tsx';
import { destinationLabel, peopleByOrg, recentPeopleIds, searchGroups } from '../quick-search.ts';
import { openDirect } from './Quick.tsx';

// ---------- Enlaces clicables en el texto ----------
const URL_SPLIT = /(\bhttps?:\/\/[^\s<>"'`]+)/gi;
export function Linkify({ text }: { text: string }) {
  const parts = text.split(URL_SPLIT);
  return <>{parts.map((part, i) => {
    if (i % 2 === 0) return part;
    // La puntuación final no es parte del enlace.
    const trail = part.match(/[.,;:!?¿¡)\]}»”’]+$/u)?.[0] ?? '';
    const href = trail ? part.slice(0, -trail.length) : part;
    return <span key={i}><a href={href} target="_blank" rel="noopener noreferrer nofollow">{href}</a>{trail}</span>;
  })}</>;
}

// ---------- Vista previa de enlaces ----------
const roleLine = (p: PersonDTO) => [p.title, p.area].filter(Boolean).join(' · ');

/**
 * Mensaje nuevo (✎ y ⌘K), como WhatsApp o Slack: tocar una persona la marca (una o varias, de cualquier empresa)
 * y queda arriba como chip; abajo «Abrir chat» con una o «Crear chat (n)» con varias (nombre opcional).
 * El 💬 de la fila, doble clic o Enter con un solo resultado abren el directo al instante. Al buscar también salen
 * grupos (se abren). «Grupo en un espacio» sigue abajo (docs/GRUPOS.md › Barra de arriba y búsqueda rápida).
 */
export function NewChatDialog({ onClose }: { onClose: () => void }) {
  const d = useClient((s) => s.data)!;
  const [mode, setMode] = useState<'compose' | 'space'>('compose');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const searching = !!q.trim();
  const orgs = useMemo(() => peopleByOrg(d, q), [d, q]);
  const groups = useMemo(() => (picked.length || !searching ? [] : searchGroups(d, q, { title: (c) => conversationTitle(d, c) }).slice(0, 6)), [d, q, picked.length, searching]);
  const recents = useMemo(() => recentPeopleIds(d).slice(0, 8).map((id) => personById(d, id)).filter((p): p is PersonDTO => !!p), [d]);
  // Lo que se recorre con el teclado: grupos encontrados y luego personas, en el orden en que se ven.
  const items: ({ kind: 'group'; c: ConversationDTO } | { kind: 'person'; p: PersonDTO })[] = [
    ...groups.map((c) => ({ kind: 'group' as const, c })),
    ...orgs.flatMap((g) => g.people.map((p) => ({ kind: 'person' as const, p }))),
  ];
  const at = Math.min(active, Math.max(0, items.length - 1));
  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => { list.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' }); }, [at]);
  /** Marca o desmarca; al buscar, limpia la búsqueda para seguir eligiendo (como el «Para:» de Slack). */
  const toggle = (id: string) => {
    setPicked((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));
    if (searching) setQ('');
    search.current?.focus();
  };
  const pickedOrgs = [...new Set([d.me.primaryOrgId, ...picked.map((id) => personById(d, id)?.orgId)].filter(Boolean) as string[])];

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); onClose(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  /** Directo inmediato con esa persona (💬, doble clic o Enter con un solo resultado). */
  const open = (p: PersonDTO) => run(() => openDirect(p.id));
  const openGroup = (c: ConversationDTO) => { onClose(); navigate(`/c/${c.id}`); };
  const create = () => run(async () => {
    if (picked.length === 1) { await openDirect(picked[0]!); return; }
    const r = await client.request<{ id: string; kind: string }>('/chats', { method: 'POST', json: { userIds: picked, ...(name.trim() ? { name: name.trim() } : {}) } });
    await client.loadBootstrap();
    navigate(`/c/${r.id}`);
  });
  const choose = (it: (typeof items)[number] | undefined) => {
    if (!it || busy) return;
    if (it.kind === 'group') openGroup(it.c);
    else toggle(it.p.id);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(at + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(at - 1, 0)); }
    else if (e.key === 'Backspace' && !q && picked.length) setPicked((x) => x.slice(0, -1));
    else if (e.key === 'Enter') {
      e.preventDefault();
      // ⌘/Ctrl+Enter, o Enter sin búsqueda con gente marcada: abre o crea el chat.
      if ((e.metaKey || e.ctrlKey || !searching) && picked.length) { void create(); return; }
      // Al buscar, Enter marca a la persona (no abre su directo): se pueden buscar y juntar varias (pedido de Danny, 29-sep-2026).
      if (searching) choose(items[at]);
    }
  };
  const isActive = (it: (typeof items)[number]) => searching && items[at] === it;
  const first = picked.length === 1 ? personById(d, picked[0])?.name.split(' ')[0] ?? '' : '';

  if (mode === 'space') {
    return (
      <Modal title={t('chat.mode.space')} onClose={onClose}>
        <button className="btn ghost small" style={{ alignSelf: 'flex-start' }} onClick={() => setMode('compose')}>‹ {t('dms.new')}</button>
        <SpaceGroupForm onClose={onClose} />
      </Modal>
    );
  }
  return (
    <Modal title={t('dms.new')} onClose={onClose}>
      <div className={`search-field compose-search ${picked.length ? 'has-chips' : ''}`} onClick={() => search.current?.focus()}>
        <span aria-hidden className="muted">⌕</span>
        {picked.map((id) => {
          const p = personById(d, id);
          return (
            <button key={id} type="button" className="chip compose-chip" onClick={(e) => { e.stopPropagation(); toggle(id); }} title={t('common.remove')}>
              <Avatar person={p} org={orgById(d, p?.orgId)} size={20} />{p?.name.split(' ')[0]} <span aria-hidden>×</span>
            </button>
          );
        })}
        <input ref={search} className="grow" autoFocus type="search" value={q} placeholder={picked.length ? t('compose.addMore') : t('compose.search')} aria-label={t('compose.search')} autoComplete="off" spellCheck={false}
          role="combobox" aria-expanded aria-controls="compose-list" onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} disabled={busy} />
        {q && <button type="button" className="search-clear" onClick={() => setQ('')} aria-label={t('common.clear')}>×</button>}
      </div>
      {picked.length > 1 && (
        <div className="compose-multi">
          <div className="row small muted" style={{ gap: 6, flexWrap: 'wrap' }}>
            {pickedOrgs.map((o) => <OrgMark key={o} org={orgById(d, o)} size={18} />)}
            <span>{pickedOrgs.length > 1 ? t('chat.crossCompany', { n: pickedOrgs.length }) : t('chat.sameCompany')}</span>
          </div>
          <input className="input" maxLength={120} placeholder={t('chat.groupNamePh')} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      )}
      {!picked.length && <div className="small muted compose-tip">{t(searching ? 'compose.tipSearch' : 'compose.tip')}</div>}
      <div className="compose-list" id="compose-list" ref={list} role="listbox" aria-multiselectable aria-busy={busy}>
        {!searching && recents.length > 0 && (
          <section>
            <div className="picker-org">{t('compose.recent')}</div>
            <div className="compose-recents">
              {recents.map((p) => {
                const on = picked.includes(p.id);
                return (
                  <button key={p.id} type="button" className={`compose-recent ${on ? 'on' : ''}`} onClick={() => toggle(p.id)} onDoubleClick={() => void open(p)}
                    aria-pressed={on} aria-label={p.name} title={p.name}>
                    <span className="compose-recent-av"><Avatar person={p} org={orgById(d, p.orgId)} size={44} />{on && <span className="compose-recent-check" aria-hidden>✓</span>}</span>
                    <span className="ellipsis">{p.name.split(' ')[0]}</span>
                  </button>
                );
              })}
            </div>
          </section>
        )}
        {groups.length > 0 && (
          <section>
            <div className="picker-org">{t('search.groups')}</div>
            {items.filter((x) => x.kind === 'group').map((it) => {
              const c = (it as { c: ConversationDTO }).c;
              return (
                <button key={c.id} type="button" role="option" aria-selected={isActive(it)} data-active={isActive(it) || undefined}
                  className={`person-row ${isActive(it) ? 'is-active' : ''}`} onClick={() => openGroup(c)}>
                  <span className="compose-group-ico"><ConvAvatar c={c} size={26} /></span>
                  <span className="grow ellipsis"><b>{destinationLabel(d, c, conversationTitle(d, c))}</b></span>
                </button>
              );
            })}
          </section>
        )}
        {orgs.length === 0 && groups.length === 0 && <div className="hint" style={{ padding: 12 }}>{t('chat.nobody')}</div>}
        {orgs.map((g) => (
          <section key={g.orgId}>
            <div className="picker-org"><OrgMark org={g.org} size={20} /><span>{g.org?.name ?? t('common.guests')}</span>{g.isMine && <span className="tag">{t('chat.myTeam')}</span>}</div>
            {g.people.map((p) => {
              const it = items.find((x) => x.kind === 'person' && x.p.id === p.id)!;
              const on = picked.includes(p.id);
              const line = roleLine(p) || (p.guest ? t('common.guest') : g.org?.name ?? '');
              return (
                <div key={p.id} role="option" aria-selected={on} data-active={isActive(it) || undefined} tabIndex={-1}
                  className={`person-row ${isActive(it) ? 'is-active' : ''} ${on ? 'on' : ''}`} onClick={() => toggle(p.id)} onDoubleClick={() => void open(p)}>
                  <span className={`compose-check ${on ? 'on' : ''}`} aria-hidden>{on ? '✓' : ''}</span>
                  <Avatar person={p} org={g.org} size={32} />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <b className="ellipsis" style={{ display: 'block' }}>{p.name}</b>
                    {line && <span className="small muted ellipsis" style={{ display: 'block' }}>{line}</span>}
                  </span>
                  <button type="button" className="person-row-go" title={t('search.opensChat')} aria-label={`${t('search.opensChat')}: ${p.name}`}
                    onClick={(e) => { e.stopPropagation(); void open(p); }}>💬</button>
                </div>
              );
            })}
          </section>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="modal-actions">
        <button className="btn ghost small" style={{ marginRight: 'auto' }} onClick={() => setMode('space')}>{t('chat.mode.space')}</button>
        {picked.length ? (
          <button className="btn primary" disabled={busy} onClick={() => void create()}>
            {picked.length > 1 ? t('chat.createGroup', { n: picked.length + 1 }) : t('compose.openWith', { name: first })}
          </button>
        ) : (
          <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        )}
      </div>
    </Modal>
  );
}

/**
 * «Grupo en un espacio»: espacio (agrupado por empresa, solo donde no soy tercero), nombre obligatorio,
 * interno (solo mi empresa en ese espacio), nivel directivo opcional y miembros del espacio. Usa POST /workspaces/:id/conversations.
 */
function SpaceGroupForm({ onClose }: { onClose: () => void }) {
  const d = useClient((s) => s.data)!;
  const groups = groupWorkspaces(d).map((g) => ({ ...g, workspaces: g.workspaces.filter((w) => w.myRole !== 'guest') })).filter((g) => g.workspaces.length);
  const [wsId, setWsId] = useState<string | null>(groups[0]?.workspaces[0]?.id ?? null);
  const [name, setName] = useState('');
  const [internal, setInternal] = useState(false);
  const [directive, setDirective] = useState(false);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ws = d.workspaces.find((w) => w.id === wsId);
  const myOrgs = new Set(d.organizations.filter((o) => o.myRole).map((o) => o.id));
  const members = new Set(ws?.memberIds ?? []);
  const needle = q.trim().toLowerCase();
  const candidates = d.people
    .filter((p) => members.has(p.id) && p.id !== d.me.id && (!internal || (!!p.orgId && myOrgs.has(p.orgId))))
    .filter((p) => !needle || [p.name, p.title, p.area, orgById(d, p.orgId)?.name].some((x) => x?.toLowerCase().includes(needle)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const toggle = (id: string) => setPicked((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));
  async function create() {
    if (!ws || name.trim().length < 2) return;
    setBusy(true); setError(null);
    try {
      const r = await client.createConversation(ws.id, {
        name: name.trim(), kind: internal ? 'internal' : 'group', level: internal ? null : directive ? 'directivo' : 'operativo',
        memberIds: picked.filter((id) => members.has(id) && (!internal || myOrgs.has(personById(d, id)?.orgId ?? ''))),
      });
      onClose();
      navigate(`/c/${r.id}`);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  if (!groups.length) {
    return (
      <>
        <div className="empty">{t('chat.noSpaces')}</div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn primary" onClick={() => openDialog((close) => <CreateGroupDialog preset={{ kind: 'company' }} onClose={close} />)}>{t('dlg.createSpace')}</button>
        </div>
      </>
    );
  }
  return (
    <>
      <div className="eyebrow">{t('chat.pickSpace')}</div>
      <div className="list" style={{ maxHeight: 180, overflow: 'auto', gap: 2, flex: 'none' }}>
        {groups.map((g) => (
          <section key={g.org?.id ?? 'none'}>
            <div className="picker-org"><OrgMark org={g.org} size={20} /><span>{g.org?.name ?? t('common.noCompany')}</span></div>
            {g.workspaces.map((w) => (
              <label key={w.id} className={`check ${wsId === w.id ? 'derive-opt is-on' : ''}`}>
                <input type="radio" name="ws" checked={wsId === w.id} onChange={() => { setWsId(w.id); setPicked([]); }} />
                <span className="grow ellipsis"><b>{w.name}</b>{w.department ? <span className="small muted"> · {w.department}</span> : null}</span>
              </label>
            ))}
          </section>
        ))}
      </div>
      <label className="field"><span>{t('chat.groupName')}</span><input className="input" required minLength={2} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="check"><input type="checkbox" checked={internal} onChange={(e) => { setInternal(e.target.checked); setPicked([]); }} /><span className="grow"><b>{t('chat.internalOnly')}</b><span className="small muted" style={{ display: 'block' }}>{t('chat.internalHint')}</span></span></label>
      {!internal && <label className="check"><input type="checkbox" checked={directive} onChange={(e) => setDirective(e.target.checked)} /><span className="grow"><b>{t('chat.directive')}</b></span></label>}
      <div className="eyebrow">{t('chat.spaceMembers')}</div>
      <input className="input" placeholder={t('chat.searchSpace')} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="list" style={{ maxHeight: 220, overflow: 'auto', gap: 2, flex: 'none' }}>
        {candidates.length === 0 && <div className="hint">{needle ? t('chat.nobody') : t('dlg.noCandidates')}</div>}
        {candidates.map((p) => (
          <label key={p.id} className={`picker-person ${picked.includes(p.id) ? 'on' : ''}`}>
            <input type="checkbox" checked={picked.includes(p.id)} onChange={() => toggle(p.id)} />
            <Avatar person={p} org={orgById(d, p.orgId)} size={30} />
            <span className="grow" style={{ minWidth: 0 }}><b className="ellipsis" style={{ display: 'block' }}>{p.name}</b><span className="small muted ellipsis" style={{ display: 'block' }}>{roleLine(p) || orgById(d, p.orgId)?.name}</span></span>
          </label>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={busy || !ws || name.trim().length < 2} onClick={create}>
          {t('chat.createSpaceGroup')}
        </button>
      </div>
    </>
  );
}

/** Caritas apiladas de un chat grupal (hasta 3), con el logo de su empresa. */
export function StackedAvatars({ c, size = 22 }: { c: ConversationDTO; size?: number }) {
  const d = useClient((s) => s.data)!;
  const others = c.memberIds.filter((m) => m !== d.me.id).slice(0, 3);
  return (
    <span className="stack" style={{ width: size + (others.length - 1) * (size * 0.55), height: size }}>
      {others.map((m, i) => { const p = personById(d, m); return <span key={m} style={{ left: i * size * 0.55, zIndex: 3 - i }}><Avatar person={p} org={null} size={size} /></span>; })}
    </span>
  );
}

// ---------- Reenviar a otros chats ----------
export function ForwardToChatsDialog({ source, onClose }: { source: MessageDTO; onClose: () => void }) {
  const d = useClient((s) => s.data)!;
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const author = personById(d, source.authorId)?.name ?? null;
  const needle = q.trim().toLowerCase();
  const list = d.conversations
    .filter((c) => c.canPost && c.id !== source.conversationId && (!needle || conversationTitle(d, c).toLowerCase().includes(needle)))
    .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
  const toggle = (id: string) => setPicked((x) => (x.includes(id) ? x.filter((y) => y !== id) : x.length >= 10 ? x : [...x, id]));
  async function send() {
    setBusy(true);
    try {
      for (const target of picked) {
        if (comment.trim()) await client.send(target, comment.trim());
        // Los adjuntos se reenvían como copias del mismo archivo (forwardAttachmentIds).
        await client.send(target, source.body, null, { source: 'tiecoms', author, sentAt: source.createdAt, fromConversationId: source.conversationId },
          { forwardAttachmentIds: (source.attachments ?? []).map((a) => a.id) });
      }
      const one = picked.length === 1 ? picked[0]! : null;
      toast(picked.length === 1 ? t('toast.sent') : t('fwd.sentMany', { n: picked.length }), one ? { label: t('lin.open'), run: () => navigate(`/c/${one}`) } : undefined);
      onClose();
    } catch (e) { toast(errorText(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title={t('fwd.title')} onClose={onClose}>
      <blockquote className="derive-quote">{source.body ? `“${source.body.slice(0, 240)}”` : null}{source.attachments?.length ? ` ${attachmentSummaryText({ count: source.attachments.length, images: source.attachments.filter((a) => a.contentType.startsWith('image/')).length, videos: source.attachments.filter((a) => a.contentType.startsWith('video/')).length, files: 0, firstName: source.attachments[0]!.name })}` : null}{author ? <span className="small muted"> — {author}</span> : null}</blockquote>
      <input className="input" placeholder={t('fwd.search')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <div className="list" style={{ maxHeight: 280, overflow: 'auto', gap: 4 }}>
        {list.map((c) => <ChatOption key={c.id} d={d} c={c} on={picked.includes(c.id)} onToggle={() => toggle(c.id)} />)}
      </div>
      <input className="input" placeholder={t('fwd.comment')} value={comment} onChange={(e) => setComment(e.target.value)} />
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={!picked.length || busy} onClick={send}>{picked.length > 1 ? t('fwd.sendMany', { n: picked.length }) : t('fwd.send')}</button>
      </div>
    </Modal>
  );
}

function ChatOption({ d, c, on, onToggle }: { d: BootstrapDTO; c: ConversationDTO; on: boolean; onToggle: () => void }) {
  const other = c.kind === 'direct' ? personById(d, c.memberIds.find((m) => m !== d.me.id)) : null;
  const ws = d.workspaces.find((w) => w.id === c.workspaceId);
  const orgIds = [...new Set(c.memberIds.map((m) => personById(d, m)?.orgId).filter(Boolean) as string[])];
  const sub = other ? [other.title, orgById(d, other.orgId)?.name].filter(Boolean).join(' · ')
    : ws ? ws.name : t('chat.groupChat');
  return (
    <label className={`check fwd-opt ${on ? 'is-on' : ''}`}>
      <input type="checkbox" checked={on} onChange={onToggle} />
      {other ? <Avatar person={other} org={orgById(d, other.orgId)} size={30} /> : c.kind === 'multi' ? <StackedAvatars c={c} size={24} /> : <span className="fwd-hash">{c.kind === 'internal' ? '◌' : '#'}</span>}
      <span className="grow" style={{ minWidth: 0 }}>
        <b className="ellipsis" style={{ display: 'block' }}>{conversationTitle(d, c)}</b>
        <span className="small muted ellipsis" style={{ display: 'block' }}>{sub}</span>
      </span>
      {!other && <span className="row" style={{ gap: 2 }}>{orgIds.slice(0, 4).map((o) => <OrgMark key={o} org={orgById(d, o)} size={16} />)}</span>}
    </label>
  );
}
