import { useMemo, useState } from 'react';
import type { BootstrapDTO, ConversationDTO, LinkPreviewDTO, MessageDTO, PersonDTO } from '@tiecoms/contracts';
import { apiUrl, client, useClient } from '../app-client.ts';
import { errorText, t } from '../i18n.ts';
import { toast } from '../menu.tsx';
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
    <Modal title={t('chat.new')} onClose={onClose}>
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
    </Modal>
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
        await client.send(target, source.body, null, { source: 'tiecoms', author, sentAt: source.createdAt, fromConversationId: source.conversationId });
      }
      const one = picked.length === 1 ? picked[0]! : null;
      toast(picked.length === 1 ? t('toast.sent') : t('fwd.sentMany', { n: picked.length }), one ? { label: t('lin.open'), run: () => navigate(`/c/${one}`) } : undefined);
      onClose();
    } catch (e) { toast(errorText(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title={t('fwd.title')} onClose={onClose}>
      <blockquote className="derive-quote">“{source.body.slice(0, 240)}”{author ? <span className="small muted"> — {author}</span> : null}</blockquote>
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
