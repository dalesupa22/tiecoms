import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { BootstrapDTO, ConversationDTO, MessageDTO, PersonDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { attachmentSummaryText, errorText, t } from '../i18n.ts';
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
  // Sugerencias arriba: el autor del mensaje, la gente mencionada en él y colegas con quienes tengo directos recientes.
  const body = message.body.toLowerCase();
  const recentDm = new Set(d.conversations.filter((c) => c.kind === 'direct').sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '')).slice(0, 6).flatMap((c) => c.memberIds));
  const suggested = needle ? [] : all.filter((c) => !c.why && (c.p.id === message.authorId || body.includes(c.p.name.split(' ')[0]!.toLowerCase()) || recentDm.has(c.p.id))).slice(0, 6);
  const suggestedIds = new Set(suggested.map((c) => c.p.id));
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
    const rows = list.filter((c) => c.group === g && !suggestedIds.has(c.p.id));
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
      <div className="side-anchor-bubble">
        <Avatar person={author} org={orgById(d, author?.orgId)} size={28} />
        <div><b className="small">{author?.name}</b><div className="side-anchor-text">{message.body}</div></div>
      </div>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {suggested.length > 0 && (
          <div className="side-suggest">
            <span className="eyebrow">{t('side.suggestions')}</span>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              {suggested.map((c) => (
                <button type="button" key={c.p.id} className={`chip ${picked.includes(c.p.id) ? 'on' : ''}`} onClick={() => toggle(c.p.id)}>
                  <Avatar person={c.p} org={orgById(d, c.p.orgId)} size={20} />{c.p.name.split(' ')[0]}{picked.includes(c.p.id) ? ' ✓' : ''}
                </button>
              ))}
            </div>
          </div>
        )}
        <input className="input" placeholder={t('side.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="list" style={{ maxHeight: 260, overflow: 'auto' }}>
          {section('chat', t('side.inChat'))}
          {section('colleague', t('side.colleagues'))}
          {section('outsider', t('side.why.outsider'))}
          {!list.length && <div className="hint">{t('chat.nobody')}</div>}
        </div>
        <label className="field"><span>{t('side.question')}</span>
          <textarea className="input" rows={2} maxLength={4000} autoFocus placeholder={t('side.questionPh')} value={question} onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && picked.length === 1 && question.trim()) { e.preventDefault(); void submit(e as unknown as FormEvent); } }} />
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

/**
 * Chip-hilo bajo el mensaje ancla (solo para miembros del sidechat): avatares apilados, «Sidechat · N mensajes»,
 * extracto de lo último y punto si hay no leídos. Varios en el mismo mensaje → «N sidechats» (lista). Devuelto → verde.
 */
export function SideChip({ d, sides, onOpen }: { d: BootstrapDTO; sides: ConversationDTO[]; onOpen: (id: string) => void }) {
  if (!sides.length) return null;
  const unread = sides.reduce((n, c) => n + (c.unread > 0 ? c.unread : 0), 0);
  const one = sides.length === 1 ? sides[0]! : null;
  const people = [...new Set(sides.flatMap((c) => c.memberIds))].filter((m) => m !== d.me.id).slice(0, 3);
  const count = one ? Math.max(0, one.lastMessageSeq - 1) : 0;
  const last = one?.lastHumanPreview;
  const lastWho = last ? (last.authorId === d.me.id ? t('common.youShort') : personById(d, last.authorId)?.name.split(' ')[0]) : null;
  const lastText = last ? [last.attachments ? attachmentSummaryText(last.attachments) : '', last.body].filter(Boolean).join(' · ') : '';
  return (
    <button className={`side-thread ${unread ? 'unread' : ''} ${one?.returnedAt ? 'is-returned' : ''}`} onClick={(e) => {
      if (one) return onOpen(one.id);
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      openMenuAt(r.left, r.bottom + 4, sides.map((c) => ({ label: conversationTitle(d, c), icon: c.returnedAt ? '✓' : '💬', hint: c.unread ? String(c.unread) : undefined, onSelect: () => onOpen(c.id) })));
    }}>
      <span className="stack" style={{ width: 20 + (people.length - 1) * 11, height: 20 }}>
        {people.map((m, i) => <span key={m} style={{ left: i * 11, zIndex: 3 - i }}><Avatar person={personById(d, m)} org={null} size={20} /></span>)}
      </span>
      <span className="side-thread-text">
        <b>{one ? (one.returnedAt ? t('side.returnedChip') : t('side.thread', { n: count === 1 ? t('side.replyOne') : t('side.replies', { n: count }) })) : t('side.chipN', { n: sides.length })}</b>
        {one && lastText && <span className="side-thread-last">{lastWho ? `${lastWho}: ` : ''}{lastText}</span>}
      </span>
      {unread > 0 && <span className="side-dot" aria-label={t('home.unreadIn', { n: unread })} />}
    </button>
  );
}

/**
 * Conector curvo del mensaje ancla al panel del sidechat (pantalla ancha). Sigue al ancla al hacer scroll; si el
 * ancla sale de la vista, apunta al borde superior o inferior del chat.
 */
export function SideConnector({ host, anchorId, color }: { host: HTMLElement | null; anchorId: string | null; color: string }) {
  const [path, setPath] = useState<{ d: string; w: number; h: number; x2: number; y2: number } | null>(null);
  useEffect(() => {
    if (!host) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const panel = host.querySelector<HTMLElement>(':scope > .side-panel');
      const list = host.querySelector<HTMLElement>('.conv-main .msgs');
      const bubble = anchorId ? host.querySelector<HTMLElement>(`:scope > .conv-main [data-mid="${anchorId}"] .msg-body`) ?? host.querySelector<HTMLElement>(`[data-mid="${anchorId}"]`) : null;
      if (!panel || !list || getComputedStyle(panel).position === 'fixed') { setPath(null); return; }
      const hb = host.getBoundingClientRect(), pb = panel.getBoundingClientRect(), lb = list.getBoundingClientRect();
      let x1: number, y1: number;
      if (bubble) {
        // El texto de la burbuja (no el bloque entero): así el conector sale de donde termina el mensaje.
        const range = document.createRange();
        range.selectNodeContents(bubble);
        const tb = range.getBoundingClientRect();
        const bb = tb.width ? tb : bubble.getBoundingClientRect();
        x1 = Math.min(bb.right + 10, pb.left - 40) - hb.left;
        y1 = Math.max(lb.top + 6, Math.min(lb.bottom - 6, bb.top + Math.min(24, bb.height / 2))) - hb.top;
      } else { x1 = pb.left - 40 - hb.left; y1 = lb.top + 6 - hb.top; }
      const x2 = pb.left - hb.left + 2, y2 = Math.min(pb.top + 96, pb.bottom - 20) - hb.top;
      const mid = (x1 + x2) / 2;
      const d = `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${mid.toFixed(1)} ${y1.toFixed(1)}, ${mid.toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
      setPath((p) => (p?.d === d ? p : { d, w: hb.width, h: hb.height, x2, y2 }));
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [host, anchorId]);
  if (!path) return null;
  return (
    <svg className="side-connector" width={path.w} height={path.h} aria-hidden>
      <path d={path.d} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" />
      <circle cx={path.x2} cy={path.y2} r={4} fill={color} />
    </svg>
  );
}

/** Respuestas rápidas del compositor de un sidechat. «No sé, pregúntale a…» abre el selector para sumar a alguien. */
export function QuickReplies({ onSend, onAsk }: { onSend: (text: string) => void; onAsk: () => void }) {
  return (
    <div className="quick-replies" role="group" aria-label={t('side.suggestions')}>
      <button type="button" onClick={() => onSend(t('side.quick.check'))}>{t('side.quick.check')}</button>
      <button type="button" onClick={onAsk}>{t('side.quick.ask')}</button>
      <button type="button" onClick={() => onSend(t('side.quick.later'))}>{t('side.quick.later')}</button>
    </div>
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
