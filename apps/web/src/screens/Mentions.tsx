import { RichText } from './RichText.tsx';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { BootstrapDTO, ConversationDTO, MentionDTO, MentionItemDTO, MessageDTO, MessageRefDTO, PersonDTO } from '@tiecoms/contracts';
import { ggRanges, segmentBody } from '../chat17.ts';
import { openRef } from './Chat17.tsx';
import { client, useClient } from '../app-client.ts';
import { attachmentSummaryText, errorText, t } from '../i18n.ts';
import { openMenuAt, toast } from '../menu.tsx';
import { navigate } from '../router.ts';
import { Avatar, GG_ID, conversationTitle, orgById, personById, personInk, timeLabel } from '../ui.tsx';
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
export function MentionMirror({ text, tokens, taRef, refRanges = [] }: { text: string; tokens: MentionToken[]; taRef: RefObject<HTMLTextAreaElement | null>; refRanges?: { start: number; length: number }[] }) {
  const mentioned = mentionsFor(text, tokens).map((m) => ({ ...m, ref: false, gg: m.userId === GG_ID }));
  // «@gg» escrito a mano también se resalta con el degradado de gg.
  const typedGg = ggRanges(text).filter((g) => !mentioned.some((m) => m.start === g.start)).map((g) => ({ ...g, ref: false, gg: true }));
  const ranges = [...mentioned, ...typedGg, ...refRanges.map((r) => ({ ...r, ref: true, gg: false }))].sort((a, b) => a.start - b.start);
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
    if (r.start < at) continue;
    parts.push(text.slice(at, r.start));
    parts.push(<mark key={r.start} className={r.ref ? 'is-ref' : r.gg ? 'is-gg' : undefined}>{text.slice(r.start, r.start + r.length)}</mark>);
    at = r.start + r.length;
  }
  parts.push(text.slice(at), '​');
  return <div className="mention-mirror" aria-hidden style={{ ...style, transform: `translateY(${-scroll}px)` }}>{parts}</div>;
}

// ---------- En las burbujas ----------
/**
 * Texto con enlaces, menciones (negrita del color de la persona; si soy yo, fondo suave) y #grupos (pastilla del
 * color del acento: abre la conversación o avisa «No tienes acceso a #Nombre»).
 */
/** @gg con el degradado de la marca (pedido de Danny, 29-sep-2026). */
const GgMention = ({ text }: { text: string }) => <span className="mention is-gg" title="gg">{text}</span>;
/** Texto sin menciones estructuradas: «@gg» escrito a mano también lleva el degradado. */
function TextWithGg({ text }: { text: string }) {
  const rs = ggRanges(text);
  if (!rs.length) return <Linkify text={text} />;
  const out: React.ReactNode[] = [];
  let at = 0;
  rs.forEach((r, i) => { out.push(<Linkify key={`t${i}`} text={text.slice(at, r.start)} />, <GgMention key={`g${i}`} text={text.slice(r.start, r.start + r.length)} />); at = r.start + r.length; });
  out.push(<Linkify key="end" text={text.slice(at)} />);
  return <>{out}</>;
}

/** «- » o «* » al inicio de línea se ve como viñeta; mide lo mismo, así las posiciones de las menciones no cambian. */
const bullets = (s: string) => s.replace(/(^|\n)([ \t]*)[-*] (?=\S)/g, '$1$2• ');

function PlainMessageText({ d, body: raw, mentions, refs }: { d: BootstrapDTO; body: string; mentions?: MentionDTO[]; refs?: MessageRefDTO[] }) {
  const body = raw;
  if (!mentions?.length && !refs?.length) return <TextWithGg text={body} />;
  const segs = segmentBody(body, mentions, refs);
  return <>{segs.map((sg, i) => {
    if (sg.kind === 'text') return <TextWithGg key={i} text={sg.text} />;
    if (sg.kind === 'ref') {
      const ref = sg.ref;
      return <button key={i} type="button" className="ref-pill" title={ref.name} onClick={() => openRef(d, ref)}>{sg.text}</button>;
    }
    const m = sg.mention;
    if (m.userId === GG_ID) return <GgMention key={i} text={sg.text} />;
    const p = m.userId === 'all' ? null : personById(d, m.userId);
    const me = m.userId === 'all' || m.userId === d.me.id;
    return (
      <button key={i} type="button" className={`mention ${me ? 'is-me' : ''}`} style={p ? { color: personInk(p.id) } : undefined}
        onClick={(e) => { if (!p) return; const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenuAt(r.left, r.bottom + 4, personMenu(p)); }}>
        {sg.text}
      </button>
    );
  })}</>;
}

export function MessageText({ d, body, mentions, refs }: { d: BootstrapDTO; body: string; mentions?: MentionDTO[]; refs?: MessageRefDTO[] }) {
  return <RichText text={body} plain={(start, end) => <PlainMessageText d={d} body={body.slice(start, end)}
    mentions={mentions?.filter((m) => m.start >= start && m.start + m.length <= end).map((m) => ({ ...m, start: m.start - start }))}
    refs={refs?.filter((r) => r.start >= start && r.start + r.length <= end).map((r) => ({ ...r, start: r.start - start }))} />} />;
}

export const mentionsMe = (d: BootstrapDTO, m: MessageDTO) => m.authorId !== d.me.id && (m.mentions ?? []).some((x) => x.userId === d.me.id || x.userId === 'all');

// ---------- Bandeja ----------
/** Dónde me escribieron: grupo, chat individual, múltiple o sidechat (para saber a dónde va la respuesta). */
export function mentionPlace(d: BootstrapDTO, conv: ConversationDTO | undefined): { kind: 'direct' | 'multi' | 'group' | 'side' | 'internal'; label: string; title: string } {
  if (!conv) return { kind: 'group', label: t('mention.wGroup'), title: '' };
  const title = conversationTitle(d, conv);
  if (conv.deriveKind === 'side') return { kind: 'side', label: t('mention.wSide'), title };
  if (conv.kind === 'direct') return { kind: 'direct', label: t('mention.wDirect'), title };
  if (conv.kind === 'multi') return { kind: 'multi', label: t('mention.wMulti'), title };
  if (conv.kind === 'internal') return { kind: 'internal', label: t('mention.wInternal'), title };
  return { kind: 'group', label: t('mention.wGroup'), title };
}

/** Texto de la tarjeta sin botones dentro (la tarjeta entera abre el chat): menciones en negrita, la mía resaltada. */
function MentionPreview({ d, m }: { d: BootstrapDTO; m: MessageDTO }) {
  if (!m.mentions?.length) return <>{m.body}</>;
  return <>{segmentBody(m.body, m.mentions, m.refs).map((sg, i) => sg.kind !== 'mention' ? <span key={i}>{sg.text}</span>
    : <b key={i} className={`mention ${sg.mention.userId === d.me.id || sg.mention.userId === 'all' ? 'is-me' : ''}`}>{sg.text}</b>)}</>;
}

const PENDING_KEY = 'tiecoms:mentions:pending';
const storedPending = () => { try { return localStorage.getItem(PENDING_KEY) !== '0'; } catch { return true; } };

/**
 * Bandeja «Menciones»: todas las veces que me nombraron (grupos, individuales, múltiples y sidechats) en un solo
 * lugar, con buscador y filtro «Sin responder». Cada una dice dónde fue y se responde ahí mismo: la respuesta sale
 * en esa conversación (y en su tema), citando el mensaje, sin tener que abrir el chat.
 */
export function MentionsInbox() {
  const d = useClient((s) => s.data)!;
  const [items, setItems] = useState<MentionItemDTO[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPendingState] = useState(storedPending);
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Respondidas en esta sesión: siguen a la vista con «✓ Respondida» hasta recargar (no saltan de golpe).
  const [done, setDone] = useState<Set<string>>(() => new Set());
  const setPending = (v: boolean) => { setPendingState(v); try { localStorage.setItem(PENDING_KEY, v ? '1' : '0'); } catch {} };
  useEffect(() => { const h = setTimeout(() => setQ(query.trim()), 250); return () => clearTimeout(h); }, [query]);
  const gen = useRef(0);
  const load = (before?: string) => {
    const my = before ? gen.current : ++gen.current;
    return client.listMentions(before, 50, { q, pending }).then((r) => {
      if (my !== gen.current) return;
      setError(null);
      setItems((x) => (before ? [...(x ?? []), ...r.mentions] : r.mentions)); setMore(r.hasMore);
    }).catch((e) => { if (my === gen.current) setError(errorText(e)); });
  };
  const unread = d.conversations.reduce((n, c) => n + (c.unreadMentions ?? 0), 0);
  useEffect(() => { void load(); }, [unread, q, pending]);
  useEffect(() => { setDone(new Set()); }, [q, pending]);

  const send = (it: MentionItemDTO, place: string) => {
    const text = (drafts[it.message.id] ?? '').trim();
    if (!text) return;
    void client.send(it.conversationId, text, it.message.id, null, it.message.topicId ? { topicId: it.message.topicId } : {});
    client.markRead(it.conversationId, it.message.seq);
    setDrafts((x) => { const n = { ...x }; delete n[it.message.id]; return n; });
    setDone((x) => new Set(x).add(it.message.id));
    // Al responder, se abre la siguiente pendiente para seguir de corrido.
    const list = items ?? [];
    const next = list.slice(list.findIndex((x) => x.message.id === it.message.id) + 1).find((x) => !x.answered && !done.has(x.message.id));
    setOpen(next && d.conversations.find((c) => c.id === next.conversationId)?.canPost ? next.message.id : null);
    toast(t('mention.sent', { place }));
  };

  const head = (
    <div className="mention-head">
      <input type="search" className="mention-search" value={query} placeholder={t('mention.search')} aria-label={t('mention.search')}
        onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.preventDefault(); setQuery(''); } }} />
      <div className="mention-seg" role="group">
        <button type="button" aria-pressed={pending} className={pending ? 'on' : ''} onClick={() => setPending(true)}>{t('mention.fPending')}</button>
        <button type="button" aria-pressed={!pending} className={!pending ? 'on' : ''} onClick={() => setPending(false)}>{t('mention.fAll')}</button>
      </div>
    </div>
  );
  if (error && !items) return <>{head}<div className="error" style={{ padding: 10 }}>{error}</div></>;
  if (!items) return <>{head}<div className="hint" style={{ padding: 10 }}>{t('common.loading')}</div></>;
  if (!items.length) return <>{head}<div className="home-empty">{q ? t('mention.noResults') : pending ? t('mention.allDone') : t('mention.empty')}</div></>;
  return (
    <>
      {head}
      <div className="mention-inbox">
        {items.map((it) => {
          const conv = d.conversations.find((c) => c.id === it.conversationId);
          const author = personById(d, it.message.authorId);
          const place = mentionPlace(d, conv);
          const where = place.kind === 'direct' ? place.label : `${place.label} · ${place.title}`;
          const answered = it.answered || done.has(it.message.id);
          const isOpen = open === it.message.id;
          const canPost = !!conv?.canPost;
          const files = it.message.attachments?.length ? attachmentSummaryText({ count: it.message.attachments.length, images: 0, videos: 0, files: it.message.attachments.length, firstName: it.message.attachments[0]!.name }) : '';
          const goTo = () => navigate(`/c/${it.conversationId}?m=${it.message.seq}`);
          return (
            <div key={it.message.id} className={`mention-item ${it.read ? '' : 'unread'} ${answered ? 'answered' : ''} ${isOpen ? 'is-open' : ''}`}>
              <div className="mention-where">
                <span className={`mention-kind k-${place.kind}`}>{place.kind === 'direct' ? '👤' : place.kind === 'multi' ? '👥' : place.kind === 'side' ? '💬' : place.kind === 'internal' ? '◌' : '#'}</span>
                <span className="grow ellipsis" title={where}>{place.kind === 'direct' ? <><b>{place.label}</b></> : <><span className="muted">{place.label} · </span><b>{place.title}</b></>}</span>
                <span className="muted">{timeLabel(it.createdAt)}</span>
              </div>
              <button type="button" className="mention-body" onClick={goTo} title={t('mention.open')}>
                <Avatar person={author} org={orgById(d, author?.orgId)} size={26} />
                <span className="grow" style={{ minWidth: 0 }}>
                  <b className="small" style={{ display: 'block' }}>{author?.name}{it.all ? <span className="muted"> · {t('mention.allLabel')}</span> : null}</b>
                  <span className="mention-text small">{files ? `${files} · ` : ''}<MentionPreview d={d} m={it.message} /></span>
                </span>
              </button>
              {isOpen && canPost ? (
                <div className="mention-reply">
                  <textarea autoFocus rows={2} value={drafts[it.message.id] ?? ''} placeholder={t('mention.replyHere', { place: place.kind === 'direct' ? place.title : place.title || place.label })}
                    onChange={(e) => setDrafts((x) => ({ ...x, [it.message.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(it, place.title || place.label); }
                      if (e.key === 'Escape') { e.preventDefault(); setOpen(null); }
                    }} />
                  <div className="row mention-actions">
                    <span className="grow hint small">{t('mention.enterHint')}</span>
                    <button type="button" className="btn ghost small" onClick={() => setOpen(null)}>{t('mention.cancel')}</button>
                    <button type="button" className="btn small primary" disabled={!(drafts[it.message.id] ?? '').trim()} onClick={() => send(it, place.title || place.label)}>{t('mention.send')}</button>
                  </div>
                </div>
              ) : (
                <div className="row mention-actions">
                  {answered ? <span className="mention-done">✓ {t('mention.answered')}</span> : null}
                  <span className="grow" />
                  {!it.read && !answered && <button type="button" className="btn ghost small" onClick={() => { client.markRead(it.conversationId, it.message.seq); setItems((x) => x?.map((y) => (y.message.id === it.message.id ? { ...y, read: true } : y)) ?? null); }} title={t('mention.markRead')}>✓ {t('mention.readShort')}</button>}
                  <button type="button" className="btn ghost small" onClick={goTo} title={t('mention.open')}>{t('mention.openShort')} ›</button>
                  {canPost ? <button type="button" className="btn small primary" onClick={() => setOpen(it.message.id)}>↩ {t('mention.reply')}</button>
                    : <span className="hint small">{t('mention.cantPost')}</span>}
                </div>
              )}
            </div>
          );
        })}
        {more && <button className="btn ghost small" onClick={() => void load(items.at(-1)!.createdAt)}>{t('mention.loadMore')}</button>}
      </div>
    </>
  );
}

export function toastDropped(d: BootstrapDTO, ids: string[]) {
  if (!ids.length) return;
  toast(t('mention.dropped', { names: ids.map((id) => (id === 'all' ? t('mention.allLabel') : personById(d, id)?.name ?? '?')).join(', ') }));
}
