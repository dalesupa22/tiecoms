import { Fragment, useEffect, useMemo, useState, type KeyboardEvent, type RefObject } from 'react';
import type { BootstrapDTO, ConversationDTO, MentionDTO, MentionItemDTO, MessageDTO, PersonDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { attachmentSummaryText, errorText, t } from '../i18n.ts';
import { openMenuAt, toast } from '../menu.tsx';
import { navigate } from '../router.ts';
import { Avatar, conversationTitle, orgById, personById, personColor, timeLabel } from '../ui.tsx';
import { personMenu } from '../actions.tsx';
import { Linkify } from './Chats.tsx';

/** Sin tildes y en minúsculas, para buscar «@maria» y encontrar a «María». */
export const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Un token del compositor: «@Nombre Apellido» ligado a una persona (o @todos). */
export interface MentionToken { userId: string | 'all'; label: string }

/**
 * Offsets UTF-16 de cada token dentro del texto (en orden de aparición, sin solaparse).
 * Los tokens cuyo texto ya no está (se editó a mano) se descartan.
 */
export function mentionsFor(text: string, tokens: MentionToken[]): MentionDTO[] {
  const out: MentionDTO[] = [];
  const used = new Set<number>();
  for (const tk of tokens) {
    const needle = `@${tk.label}`;
    let from = 0, at = -1;
    while ((at = text.indexOf(needle, from)) >= 0) {
      const end = at + needle.length;
      const before = at === 0 || /\s|\(/.test(text[at - 1]!);
      const after = end === text.length || !/[\p{L}\p{N}]/u.test(text[end]!);
      if (before && after && !used.has(at)) break;
      from = at + 1;
    }
    if (at >= 0) { used.add(at); out.push({ userId: tk.userId, start: at, length: needle.length }); }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Consulta de mención activa: «@» al inicio o tras espacio, hasta el cursor (sin salto de línea, ≤ 30). */
export function activeQuery(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf('@');
  if (at < 0 || (at > 0 && !/\s/.test(upto[at - 1]!))) return null;
  const q = upto.slice(at + 1);
  if (q.length > 30 || /\n/.test(q) || /\s{2,}/.test(q)) return null;
  return { start: at, query: q };
}

interface Option { kind: 'person'; p: PersonDTO }
interface AllOption { kind: 'all' }
type Opt = Option | AllOption;

/** Participantes ordenados por cuánto escriben en la conversación y filtrados por nombre o apellido (sin tildes). */
function options(d: BootstrapDTO, conv: ConversationDTO, messages: MessageDTO[], query: string): { list: Opt[]; outsiders: PersonDTO[] } {
  const q = fold(query.trim());
  const counts = new Map<string, number>();
  for (const m of messages) counts.set(m.authorId, (counts.get(m.authorId) ?? 0) + 1);
  const match = (p: PersonDTO) => !q || fold(p.name).split(/\s+/).some((w) => w.startsWith(q)) || fold(p.name).startsWith(q);
  const members = conv.memberIds.filter((id) => id !== d.me.id).map((id) => personById(d, id)).filter(Boolean) as PersonDTO[];
  const list: Opt[] = members.filter(match).sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) || a.name.localeCompare(b.name)).slice(0, 8).map((p) => ({ kind: 'person', p }));
  if (conv.kind !== 'direct' && (!q || fold(t('mention.all')).startsWith(q) || 'all'.startsWith(q) || 'todos'.startsWith(q))) list.push({ kind: 'all' });
  const inChat = new Set(conv.memberIds);
  const outsiders = q.length >= 2 ? d.people.filter((p) => !inChat.has(p.id) && p.id !== d.me.id && match(p)).slice(0, 2) : [];
  return { list, outsiders };
}

/**
 * Lista de mención sobre el compositor. Devuelve un manejador de teclado para ↑/↓/Enter/Tab/Esc.
 * onPick inserta «@Nombre Apellido » en el lugar de la consulta.
 */
export function useMentionPicker({ conv, text, caret, messages, onPick, onAddPerson, onAskSide }: {
  conv: ConversationDTO | undefined; text: string; caret: number; messages: MessageDTO[];
  onPick: (range: { start: number; end: number }, token: MentionToken) => void; onAddPerson?: (p: PersonDTO) => void;
  /** «Preguntarle en un sidechat»: solo si hay un mensaje ancla razonable (el que se responde o el último visible). */
  onAskSide?: (p: PersonDTO) => void;
}) {
  const d = useClient((s) => s.data)!;
  const [index, setIndex] = useState(0);
  // Un sidechat admite colegas de mis empresas aunque no estén en el chat (misma regla del API).
  const myOrgs = new Set(d.organizations.filter((o) => o.myRole).map((o) => o.id));
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const q = conv ? activeQuery(text, caret) : null;
  const { list, outsiders } = useMemo(() => (q && conv ? options(d, conv, messages, q.query) : { list: [] as Opt[], outsiders: [] as PersonDTO[] }), [d, conv, messages, q?.query, q?.start]);
  // Con espacios en la consulta (ya se eligió o se sigue escribiendo) solo se muestra si alguien coincide.
  const open = !!q && closedAt !== q.start && (list.length > 0 || outsiders.length > 0 || !/\s/.test(q.query));
  useEffect(() => { setIndex(0); }, [q?.query]);
  useEffect(() => { if (!q) setClosedAt(null); }, [!!q]);
  const pick = (o: Opt) => {
    if (!q) return;
    const label = o.kind === 'all' ? t('mention.all') : o.p.name;
    onPick({ start: q.start, end: caret }, { userId: o.kind === 'all' ? 'all' : o.p.id, label });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || (!list.length && e.key !== 'Escape')) return false;
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => (i + 1) % list.length); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => (i - 1 + list.length) % list.length); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(list[index]!); return true; }
    if (e.key === 'Escape') { e.preventDefault(); setClosedAt(q!.start); return true; }
    return false;
  };
  const view = open ? (
    <div className="mention-picker" role="listbox" aria-label={t('mention.picker')}>
      {list.map((o, i) => o.kind === 'all' ? (
        <button key="all" type="button" role="option" aria-selected={i === index} className={i === index ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); pick(o); }}>
          <span className="mention-all-ico">@</span><span className="grow"><b>{t('mention.allLabel')}</b><span className="small muted" style={{ display: 'block' }}>{t('mention.allHint')}</span></span>
        </button>
      ) : (
        <button key={o.p.id} type="button" role="option" aria-selected={i === index} className={i === index ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); pick(o); }}>
          <Avatar person={o.p} org={orgById(d, o.p.orgId)} size={28} />
          <span className="grow" style={{ minWidth: 0 }}><b className="ellipsis" style={{ display: 'block' }}>{o.p.name}</b>
            <span className="small muted ellipsis" style={{ display: 'block' }}>{[o.p.title, orgById(d, o.p.orgId)?.name].filter(Boolean).join(' · ')}</span></span>
        </button>
      ))}
      {!list.length && !outsiders.length && <div className="hint" style={{ padding: 8 }}>{t('mention.noMatch')}</div>}
      {outsiders.map((p) => (
        <div key={p.id} className="mention-outsider">
          <Avatar person={p} org={orgById(d, p.orgId)} size={24} />
          <span className="grow small">{t('mention.notInChat', { name: p.name.split(' ')[0]! })}</span>
          {conv?.canManage && conv.kind !== 'direct' && onAddPerson && <button type="button" className="btn small" onMouseDown={(e) => { e.preventDefault(); onAddPerson(p); }}>{t('mention.addToChat')}</button>}
          {onAskSide && myOrgs.has(p.orgId ?? '') && <button type="button" className="btn ghost small" onMouseDown={(e) => { e.preventDefault(); onAskSide(p); }}>💬 {t('mention.askSide')}</button>}
        </div>
      ))}
    </div>
  ) : null;
  return { view, onKeyDown, open };
}

/** Retroceso justo después de un token: se borra entero. Devuelve el texto nuevo o null. */
export function backspaceToken(text: string, caret: number, tokens: MentionToken[]): { text: string; caret: number } | null {
  for (const m of mentionsFor(text, tokens)) {
    const end = m.start + m.length;
    if (caret === end || (caret === end + 1 && text[end] === ' ')) return { text: text.slice(0, m.start) + text.slice(caret), caret: m.start };
  }
  return null;
}

/** Espejo detrás del textarea que resalta los tokens (el textarea va con fondo transparente). */
export function MentionMirror({ text, tokens, taRef }: { text: string; tokens: MentionToken[]; taRef: RefObject<HTMLTextAreaElement | null> }) {
  const ranges = mentionsFor(text, tokens);
  const [scroll, setScroll] = useState(0);
  const [style, setStyle] = useState<React.CSSProperties>({});
  // Mismas medidas que el textarea para que el resaltado quede exactamente debajo del texto.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    setStyle({ padding: cs.padding, font: cs.font, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, border: `${cs.borderTopWidth} solid transparent` });
  }, [taRef, ranges.length]);
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    const h = () => setScroll(el.scrollTop);
    el.addEventListener('scroll', h);
    return () => el.removeEventListener('scroll', h);
  }, [taRef]);
  if (!ranges.length) return null;
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const r of ranges) {
    parts.push(text.slice(at, r.start));
    parts.push(<mark key={r.start}>{text.slice(r.start, r.start + r.length)}</mark>);
    at = r.start + r.length;
  }
  parts.push(text.slice(at), '​');
  return <div className="mention-mirror" aria-hidden style={{ ...style, transform: `translateY(${-scroll}px)` }}>{parts}</div>;
}

// ---------- En las burbujas ----------
/** Texto con enlaces y menciones (negrita del color de la persona; si soy yo, fondo suave). */
export function MessageText({ d, body, mentions }: { d: BootstrapDTO; body: string; mentions?: MentionDTO[] }) {
  const list = (mentions ?? []).filter((m) => m.start >= 0 && m.start + m.length <= body.length).sort((a, b) => a.start - b.start);
  if (!list.length) return <Linkify text={body} />;
  const out: React.ReactNode[] = [];
  let at = 0;
  for (const m of list) {
    if (m.start < at) continue;
    out.push(<Linkify key={`t${at}`} text={body.slice(at, m.start)} />);
    const label = body.slice(m.start, m.start + m.length);
    const p = m.userId === 'all' ? null : personById(d, m.userId);
    const me = m.userId === 'all' || m.userId === d.me.id;
    out.push(
      <button key={`m${m.start}`} type="button" className={`mention ${me ? 'is-me' : ''}`} style={p ? { color: personColor(p.id) } : undefined}
        onClick={(e) => { if (!p) return; const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenuAt(r.left, r.bottom + 4, personMenu(p)); }}>
        {label}
      </button>,
    );
    at = m.start + m.length;
  }
  out.push(<Linkify key={`t${at}`} text={body.slice(at)} />);
  return <>{out.map((x, i) => <Fragment key={i}>{x}</Fragment>)}</>;
}

export const mentionsMe = (d: BootstrapDTO, m: MessageDTO) => m.authorId !== d.me.id && (m.mentions ?? []).some((x) => x.userId === d.me.id || x.userId === 'all');

// ---------- Bandeja ----------
export function MentionsInbox() {
  const d = useClient((s) => s.data)!;
  const [items, setItems] = useState<MentionItemDTO[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = (before?: string) => client.listMentions(before).then((r) => { setItems((x) => (before ? [...(x ?? []), ...r.mentions] : r.mentions)); setMore(r.hasMore); }).catch((e) => setError(errorText(e)));
  const unread = d.conversations.reduce((n, c) => n + (c.unreadMentions ?? 0), 0);
  useEffect(() => { void load(); }, [unread]);
  if (error) return <div className="error" style={{ padding: 10 }}>{error}</div>;
  if (!items) return <div className="hint" style={{ padding: 10 }}>{t('common.loading')}</div>;
  if (!items.length) return <div className="home-empty">{t('mention.empty')}</div>;
  return (
    <div className="mention-inbox">
      {items.map((it) => {
        const conv = d.conversations.find((c) => c.id === it.conversationId);
        const author = personById(d, it.message.authorId);
        const text = [it.message.attachments?.length ? attachmentSummaryText({ count: it.message.attachments.length, images: 0, videos: 0, files: it.message.attachments.length, firstName: it.message.attachments[0]!.name }) : '', it.message.body].filter(Boolean).join(' · ');
        return (
          <button key={`${it.message.id}`} className={`mention-item ${it.read ? '' : 'unread'}`} onClick={() => navigate(`/c/${it.conversationId}?m=${it.message.seq}`)}>
            <Avatar person={author} org={orgById(d, author?.orgId)} size={26} />
            <span className="grow" style={{ minWidth: 0 }}>
              <span className="row small" style={{ gap: 4 }}><b className="ellipsis grow">{author?.name}{conv ? <span className="muted"> · {t('mention.inConv', { name: conversationTitle(d, conv) })}</span> : null}</b><span className="muted">{timeLabel(it.createdAt)}</span></span>
              <span className="small ellipsis" style={{ display: 'block' }}>{it.all ? `${t('mention.allLabel')} · ` : ''}{text}</span>
            </span>
          </button>
        );
      })}
      {more && <button className="btn ghost small" onClick={() => void load(items.at(-1)!.createdAt)}>{t('mention.loadMore')}</button>}
    </div>
  );
}

export function toastDropped(d: BootstrapDTO, ids: string[]) {
  if (!ids.length) return;
  toast(t('mention.dropped', { names: ids.map((id) => (id === 'all' ? t('mention.allLabel') : personById(d, id)?.name ?? '?')).join(', ') }));
}
