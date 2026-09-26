import { useMemo, useState } from 'react';
import type { BootstrapDTO, ConversationDTO, LinkPreviewDTO, MessageDTO, PersonDTO } from '@tiecoms/contracts';
import { apiUrl, client, useClient } from '../app-client.ts';
import { attachmentSummaryText, errorText, t } from '../i18n.ts';
import { toast } from '../menu.tsx';
import { openDialog } from '../actions.tsx';
import { groupWorkspaces } from './Shell.tsx';
import { NewWorkspaceDialog } from './Dialogs.tsx';
import { navigate } from '../router.ts';
import { Avatar, Modal, OrgMark, conversationTitle, orgById, personById } from '../ui.tsx';

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
export function LinkPreviewCard({ p }: { p: LinkPreviewDTO }) {
  let host = p.siteName ?? '';
  try { host = p.siteName ?? new URL(p.url).hostname.replace(/^www\./, ''); } catch {}
  return (
    <a className={`link-card ${p.imageUrl ? '' : 'no-img'}`} href={p.url} target="_blank" rel="noopener noreferrer nofollow">
      {p.imageUrl && <img src={apiUrl(p.imageUrl)} alt="" loading="lazy" draggable={false} />}
      <span className="link-card-text">
        <span className="link-card-site">{host}</span>
        {p.title && <b className="link-card-title">{p.title}</b>}
        {p.description && <span className="link-card-desc">{p.description}</span>}
      </span>
    </a>
  );
}

// ---------- Personas agrupadas por empresa ----------
function groupByOrg(d: BootstrapDTO, people: PersonDTO[]) {
  const mine = d.me.primaryOrgId;
  const groups = new Map<string, PersonDTO[]>();
  for (const p of people) {
    const k = p.orgId ?? 'guests';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(p);
  }
  // Primero mi empresa, luego las demás por nombre, al final terceros.
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === mine) return -1; if (b === mine) return 1;
    if (a === 'guests') return 1; if (b === 'guests') return -1;
    return (orgById(d, a)?.name ?? '').localeCompare(orgById(d, b)?.name ?? '');
  });
}

const roleLine = (p: PersonDTO) => [p.title, p.area].filter(Boolean).join(' · ');

export function PeoplePicker({ picked, onToggle, exclude = [] }: { picked: string[]; onToggle: (id: string) => void; exclude?: string[] }) {
  const d = useClient((s) => s.data)!;
  const [q, setQ] = useState('');
  const skip = new Set([d.me.id, ...exclude]);
  const needle = q.trim().toLowerCase();
  const people = d.people.filter((p) => !skip.has(p.id) && p.kind === 'human')
    .filter((p) => !needle || [p.name, p.title, p.area, orgById(d, p.orgId)?.name].some((x) => x?.toLowerCase().includes(needle)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const groups = groupByOrg(d, people);
  return (
    <div className="picker">
      <input className="input" placeholder={t('chat.searchPeople')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      {picked.length > 0 && (
        <div className="picker-chips">
          {picked.map((id) => {
            const p = personById(d, id);
            return <button key={id} className="chip" onClick={() => onToggle(id)} title={t('common.remove')}><Avatar person={p} org={orgById(d, p?.orgId)} size={20} />{p?.name.split(' ')[0]} ×</button>;
          })}
        </div>
      )}
      <div className="picker-list">
        {groups.length === 0 && <div className="hint" style={{ padding: 10 }}>{t('chat.nobody')}</div>}
        {groups.map(([orgId, list]) => {
          const org = orgById(d, orgId);
          return (
            <section key={orgId}>
              <div className="picker-org"><OrgMark org={org} size={20} /><span>{org?.name ?? t('common.guests')}</span>{orgId === d.me.primaryOrgId && <span className="tag">{t('chat.myTeam')}</span>}</div>
              {list.map((p) => (
                <label key={p.id} className={`picker-person ${picked.includes(p.id) ? 'on' : ''}`}>
                  <input type="checkbox" checked={picked.includes(p.id)} onChange={() => onToggle(p.id)} />
                  <Avatar person={p} org={org} size={34} />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <b className="ellipsis" style={{ display: 'block' }}>{p.name}</b>
                    <span className="small muted ellipsis" style={{ display: 'block' }}>{roleLine(p) || (p.guest ? t('common.guest') : org?.name)}</span>
                  </span>
                </label>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** Nuevo chat: una persona abre el directo; varias, un chat grupal (pueden ser de empresas distintas). */
export function NewChatDialog({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<'person' | 'space'>('person');
  return (
    <Modal title={t('chat.new')} onClose={onClose}>
      <div className="seg" role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'person'} className={mode === 'person' ? 'on' : ''} onClick={() => setMode('person')}>{t('chat.mode.person')}</button>
        <button type="button" role="tab" aria-selected={mode === 'space'} className={mode === 'space' ? 'on' : ''} onClick={() => setMode('space')}>{t('chat.mode.space')}</button>
      </div>
      {mode === 'person' ? <PersonChatForm onClose={onClose} /> : <SpaceGroupForm onClose={onClose} />}
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
          <button className="btn primary" onClick={() => openDialog((close) => <NewWorkspaceDialog onClose={close} />)}>{t('dlg.createSpace')}</button>
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

function PersonChatForm({ onClose }: { onClose: () => void }) {
  const d = useClient((s) => s.data)!;
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const toggle = (id: string) => setPicked((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));
  const orgs = useMemo(() => [...new Set([d.me.primaryOrgId, ...picked.map((id) => personById(d, id)?.orgId)].filter(Boolean) as string[])], [d, picked]);
  async function go() {
    setBusy(true);
    try {
      const r = await client.request<{ id: string; kind: string }>('/chats', { method: 'POST', json: { userIds: picked, ...(picked.length > 1 && name.trim() ? { name: name.trim() } : {}) } });
      await client.loadBootstrap();
      onClose();
      navigate(`/c/${r.id}`);
    } catch (e) { toast(errorText(e)); } finally { setBusy(false); }
  }
  return (
    <>
      <p className="muted" style={{ margin: 0 }}>{t('chat.newHint')}</p>
      <PeoplePicker picked={picked} onToggle={toggle} />
      {picked.length > 1 && (
        <>
          <div className="row small muted" style={{ gap: 6, flexWrap: 'wrap' }}>
            {orgs.map((o) => <OrgMark key={o} org={orgById(d, o)} size={18} />)}
            <span>{orgs.length > 1 ? t('chat.crossCompany', { n: orgs.length }) : t('chat.sameCompany')}</span>
          </div>
          <input className="input" maxLength={120} placeholder={t('chat.groupNamePh')} value={name} onChange={(e) => setName(e.target.value)} />
        </>
      )}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={!picked.length || busy} onClick={go}>{picked.length > 1 ? t('chat.createGroup', { n: picked.length + 1 }) : t('chat.openDirect')}</button>
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
