import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { BootstrapDTO, ConversationDTO, MessageDTO, PersonDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { errorText, t } from '../i18n.ts';
import { openMenuAt, toast } from '../menu.tsx';
import { navigate } from '../router.ts';
import { Avatar, Modal, conversationTitle, orgById, personById } from '../ui.tsx';

/** Laterales visibles para mí que cuelgan de un mensaje (el chip «💬 Consulta lateral · N»). */
export function sidesOf(d: BootstrapDTO, conversationId: string, messageId?: string) {
  return d.conversations
    .filter((c) => c.deriveKind === 'side' && c.parentId === conversationId && (!messageId || c.parentMessageId === messageId))
    .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
}

/** Una lateral cuelga de su origen en las listas si ese origen está en mi alcance. */
export const hangsUnderOrigin = (d: BootstrapDTO, c: ConversationDTO) => c.deriveKind === 'side' && !!c.parentId && d.conversations.some((x) => x.id === c.parentId);

type Candidate = { p: PersonDTO; group: 'chat' | 'colleague' | 'outsider'; why?: string };

/**
 * Quién puede entrar a una lateral (misma regla del API): participantes de la conversación
 * de origen y colegas de mis empresas. Los demás salen deshabilitados con el motivo.
 */
export function sideCandidates(d: BootstrapDTO, conv: ConversationDTO, blocked: Set<string>): Candidate[] {
  const myOrgs = new Set(d.organizations.filter((o) => o.myRole).map((o) => o.id));
  const inChat = new Set(conv.memberIds);
  const out: Candidate[] = [];
  for (const p of d.people) {
    if (p.id === d.me.id) continue;
    const group = inChat.has(p.id) ? 'chat' : p.orgId && myOrgs.has(p.orgId) ? 'colleague' : 'outsider';
    const why = blocked.has(p.id) ? t('side.why.blocked') : group === 'outsider' ? t('side.why.outsider') : undefined;
    out.push({ p, group, why });
  }
  const rank = { chat: 0, colleague: 1, outsider: 2 } as const;
  return out.sort((a, b) => rank[a.group] - rank[b.group] || a.p.name.localeCompare(b.p.name));
}

export function SideDialog({ conv, message, onClose, onOpened }: { conv: ConversationDTO; message: MessageDTO; onClose: () => void; onOpened: (id: string) => void }) {
  const d = useClient((s) => s.data)!;
  const [blocked, setBlocked] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { client.request<{ userIds: string[] }>('/blocks').then((r) => setBlocked(new Set(r.userIds))).catch(() => {}); }, []);
  const all = useMemo(() => sideCandidates(d, conv, blocked), [d, conv, blocked]);
  const needle = q.trim().toLowerCase();
  const match = (c: Candidate) => !needle || [c.p.name, c.p.title, c.p.area, orgById(d, c.p.orgId)?.name].some((v) => v?.toLowerCase().includes(needle));
  // Quien no se puede sumar solo aparece al buscarlo (para explicar por qué).
  const list = all.filter((c) => match(c) && (c.group !== 'outsider' || needle));
  const author = personById(d, message.authorId);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!picked.length) return;
    setBusy(true); setError(null);
    try {
      const r = await client.openSide(conv.id, { messageId: message.id, userIds: picked, ...(question.trim() ? { question: question.trim() } : {}) });
      onClose();
      onOpened(r.id);
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }

  const section = (g: Candidate['group'], label: string) => {
    const rows = list.filter((c) => c.group === g);
    if (!rows.length) return null;
    return (
      <div>
        <div className="eyebrow" style={{ margin: '6px 0 4px' }}>{label}</div>
        {rows.map((c) => {
          const org = orgById(d, c.p.orgId);
          const disabled = !!c.why;
          return (
            <label key={c.p.id} className={`check ${picked.includes(c.p.id) ? 'derive-opt is-on' : ''} ${disabled ? 'is-disabled' : ''}`} title={c.why}>
              <input type="checkbox" disabled={disabled} checked={picked.includes(c.p.id)} onChange={() => toggle(c.p.id)} />
              <Avatar person={c.p} org={org} size={28} />
              <span className="grow" style={{ minWidth: 0 }}>
                <b className="ellipsis" style={{ display: 'block' }}>{c.p.name}</b>
                <span className="small muted ellipsis" style={{ display: 'block' }}>{c.why ?? [c.p.title, org?.name].filter(Boolean).join(' · ')}</span>
              </span>
            </label>
          );
        })}
      </div>
    );
  };

  return (
    <Modal title={t('side.title')} onClose={onClose}>
      <p className="muted small" style={{ margin: 0 }}>{t('side.body')}</p>
      <blockquote className="derive-quote"><b>{author?.name}</b> · “{message.body.replace(/\s+/g, ' ').slice(0, 220)}”</blockquote>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input className="input" placeholder={t('side.search')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <div className="list" style={{ maxHeight: 260, overflow: 'auto' }}>
          {section('chat', t('side.inChat'))}
          {section('colleague', t('side.colleagues'))}
          {section('outsider', t('side.why.outsider'))}
          {!list.length && <div className="hint">{t('chat.nobody')}</div>}
        </div>
        <label className="field"><span>{t('side.question')}</span>
          <textarea className="input" rows={2} maxLength={4000} placeholder={t('side.questionPh')} value={question} onChange={(e) => setQuestion(e.target.value)} />
        </label>
        <div className="hint">{t('side.private')}</div>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <span className="small muted grow">{picked.length === 1 ? t('side.selectedOne') : picked.length ? t('side.selected', { n: picked.length }) : ''}</span>
          <button type="button" className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn primary" disabled={busy || !picked.length}>{t('side.create')}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Chip bajo el mensaje ancla: abre la lateral (o elige entre varias). */
export function SideChip({ d, sides, onOpen }: { d: BootstrapDTO; sides: ConversationDTO[]; onOpen: (id: string) => void }) {
  if (!sides.length) return null;
  const unread = sides.reduce((n, c) => n + c.unread, 0);
  return (
    <button className={`side-chip ${unread ? 'unread' : ''}`} onClick={(e) => {
      if (sides.length === 1) return onOpen(sides[0]!.id);
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      openMenuAt(r.left, r.bottom + 4, sides.map((c) => ({ label: conversationTitle(d, c), icon: '💬', hint: c.unread ? String(c.unread) : undefined, onSelect: () => onOpen(c.id) })));
    }}>
      {sides.length > 1 ? t('side.chipN', { n: sides.length }) : t('side.chip')}{unread ? <span className="pill">{unread}</span> : null}
    </button>
  );
}

// ---------- Responder en privado ----------
/** Borrador de «Responder en privado» que recoge el directo al abrirse. */
let privateDraft: { dmId: string; source: MessageDTO } | null = null;
export function takePrivateDraft(dmId: string) {
  if (privateDraft?.dmId !== dmId) return null;
  const s = privateDraft.source;
  privateDraft = null;
  return s;
}

export async function replyPrivately(m: MessageDTO) {
  try {
    const r = await client.createChat([m.authorId]);
    privateDraft = { dmId: r.id, source: m };
    navigate(`/c/${r.id}`);
  } catch (e: any) {
    toast(e?.code === 'forbidden' || e?.code === 'blocked_user' ? t('preply.unreachable') : errorText(e));
  }
}
