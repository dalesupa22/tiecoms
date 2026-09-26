import { useEffect, useState, useSyncExternalStore } from 'react';
import type { BootstrapDTO, ConversationDTO, LinkItemDTO, LinkKind, LinkPreviewDTO, LinkPreviewMode, LinkProvider, MessageDTO } from '@tiecoms/contracts';
import { apiUrl, client, useClient } from '../app-client.ts';
import { errorText, getLang, locale, t } from '../i18n.ts';
import { toast, type MenuItem } from '../menu.tsx';
import { navigate } from '../router.ts';
import { Avatar, Modal, conversationTitle, orgById, personById, timeLabel } from '../ui.tsx';

/**
 * Enlaces (docs/REACCIONES_ENLACES.md): tarjetas por plataforma, grupo compacto cuando alguien comparte varios
 * seguidos, pestaña «Enlaces» del chat, «Ver después» (estado solo mío) y «¿De qué trata?» con IA bajo pedido.
 */
const PROVIDER: Record<LinkProvider, { name: string; ico: string }> = {
  youtube: { name: 'YouTube', ico: '▶' }, tiktok: { name: 'TikTok', ico: '♪' }, instagram: { name: 'Instagram', ico: '◎' },
  x: { name: 'X', ico: '𝕏' }, linkedin: { name: 'LinkedIn', ico: 'in' }, facebook: { name: 'Facebook', ico: 'f' },
  vimeo: { name: 'Vimeo', ico: '▶' }, spotify: { name: 'Spotify', ico: '♫' }, google: { name: 'Google', ico: 'G' }, github: { name: 'GitHub', ico: '⌥' },
};
const KIND_ICO: Record<LinkKind, string> = { video: '▶', short: '▮', post: '✎', article: '¶', audio: '♫', image: '▣', doc: '▤', code: '⌥', link: '↗' };

export const duration = (s?: number | null) => (s ? `${Math.floor(s / 3600) ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}` : Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : null);
const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
/** «YouTube · Short · 0:45» o «nytimes.com · Artículo». */
export function linkMeta(p: { kind?: LinkKind; provider?: LinkProvider | null; siteName?: string | null; url: string; durationSec?: number | null; author?: string | null }) {
  const src = p.provider ? PROVIDER[p.provider].name : p.siteName ?? hostOf(p.url);
  const kind = p.kind && p.kind !== 'link' ? t(`link.kind.${p.kind}` as any) : null;
  return [src, kind, p.author, duration(p.durationSec)].filter(Boolean).join(' · ');
}

// ---------- Estado personal («Ver después» / visto), compartido por las tarjetas de esta pestaña ----------
type State = { savedAt: string | null; seenAt: string | null };
let states: Record<string, State> = {};
let pendingCount = 0;
let loaded: Promise<void> | null = null;
const stateListeners = new Set<() => void>();
const emit = () => stateListeners.forEach((l) => l());
function loadStates() {
  loaded ??= (async () => {
    try {
      const r = await client.listSavedLinks('all');
      for (const l of r.links) states[l.id] = { savedAt: l.savedAt, seenAt: l.seenAt };
      pendingCount = r.pending;
      emit();
    } catch { loaded = null; }
  })();
  return loaded;
}
function useLinkState(id?: string): State | null {
  useEffect(() => { void loadStates(); }, []);
  return useSyncExternalStore((l) => { stateListeners.add(l); return () => stateListeners.delete(l); }, () => (id ? states[id] ?? null : null));
}
export function usePendingLinks() {
  useEffect(() => { void loadStates(); }, []);
  return useSyncExternalStore((l) => { stateListeners.add(l); return () => stateListeners.delete(l); }, () => pendingCount);
}
function remember(l: LinkItemDTO) {
  const before = states[l.id];
  const wasPending = !!before?.savedAt && !before.seenAt;
  const isPending = !!l.savedAt && !l.seenAt;
  states = { ...states, [l.id]: { savedAt: l.savedAt, seenAt: l.seenAt } };
  pendingCount = Math.max(0, pendingCount + (isPending ? 1 : 0) - (wasPending ? 1 : 0));
  emit();
}
export async function setSaved(linkId: string, saved: boolean) {
  try { const l = await client.setLinkState(linkId, { saved, ...(saved ? { seen: false } : {}) }); remember(l); toast(saved ? t('link.savedToast') : t('link.unsavedToast'), saved ? { label: t('link.openSaved'), run: () => navigate('/ver-despues') } : undefined); return l; }
  catch (e) { toast(errorText(e)); return null; }
}
/** Abrir un enlace desde Chaggu lo marca como visto (solo para mí). */
export function markSeen(linkId?: string) {
  if (!linkId || states[linkId]?.seenAt) return;
  void client.setLinkState(linkId, { seen: true }).then(remember).catch(() => {});
}

// ---------- Resumen con IA ----------
export function SummaryBox({ linkId }: { linkId: string }) {
  const [s, setS] = useState<{ text: string; basis: string } | 'loading' | null>(null);
  const run = () => {
    setS('loading');
    client.summarizeLink(linkId, getLang()).then((r) => setS({ text: r.summary, basis: r.basis })).catch((e) => { setS(null); toast(errorText(e)); });
  };
  if (!s) return <button className="link-act" onClick={run}>✨ {t('link.summary')}</button>;
  if (s === 'loading') return <span className="link-act is-busy">✨ {t('link.summarizing')}</span>;
  return (
    <div className="link-summary">
      <span className="eyebrow">✨ {s.basis === 'article' ? t('link.fromArticle') : t('link.fromDescription')}</span>
      <div>{s.text}</div>
    </div>
  );
}

// ---------- Tarjeta ----------
export function LinkCard({ p, mode = 'large', onIssue }: { p: LinkPreviewDTO; mode?: LinkPreviewMode; onIssue?: (title: string) => void }) {
  const st = useLinkState(p.linkId);
  if (mode === 'none') return null;
  const saved = !!st?.savedAt;
  const seen = !!st?.seenAt;
  const meta = linkMeta(p);
  const video = p.kind === 'video' || p.kind === 'short';
  const open = () => markSeen(p.linkId);
  if (mode === 'compact') {
    return (
      <div className={`link-mini ${seen ? 'is-seen' : ''}`}>
        <a href={p.url} target="_blank" rel="noopener noreferrer nofollow" onClick={open} className="link-mini-main">
          <span className={`link-ico prov-${p.provider ?? 'web'}`} aria-hidden>{p.provider ? PROVIDER[p.provider].ico : KIND_ICO[p.kind ?? 'link']}</span>
          <span className="grow ellipsis"><b>{p.title ?? hostOf(p.url)}</b> <span className="muted small">{meta}</span></span>
        </a>
        {p.linkId && <button className={`link-save ${saved ? 'on' : ''}`} title={saved ? t('link.unsave') : t('link.save')} aria-label={saved ? t('link.unsave') : t('link.save')} onClick={() => void setSaved(p.linkId!, !saved)}>🔖</button>}
      </div>
    );
  }
  return (
    <div className="link-wrap">
      <a className={`link-card ${p.imageUrl ? '' : 'no-img'} ${p.kind === 'short' ? 'is-short' : ''} ${p.provider ? `prov-${p.provider}` : ''}`} href={p.url} target="_blank" rel="noopener noreferrer nofollow" onClick={open}>
        {p.imageUrl && (
          <span className="link-card-media">
            <img src={apiUrl(p.imageUrl)} alt="" loading="lazy" draggable={false} />
            {video && <span className="link-play" aria-hidden>▶</span>}
            {duration(p.durationSec) && <span className="link-dur">{duration(p.durationSec)}</span>}
          </span>
        )}
        <span className="link-card-text">
          <span className="link-card-site">{p.provider && <span className={`link-ico prov-${p.provider}`} aria-hidden>{PROVIDER[p.provider].ico}</span>} {meta}</span>
          {p.title && <b className="link-card-title">{p.title}</b>}
          {p.description && <span className="link-card-desc">{p.description}</span>}
        </span>
      </a>
      {p.linkId && (
        <div className="link-acts">
          <button className={`link-act ${saved ? 'on' : ''}`} onClick={() => void setSaved(p.linkId!, !saved)}>🔖 {saved ? (seen ? t('link.seen') : t('link.savedShort')) : t('link.save')}</button>
          <SummaryBox linkId={p.linkId} />
          {onIssue && <button className="link-act" onClick={() => onIssue(p.title ?? hostOf(p.url))}>◆ {t('link.toIssue')}</button>}
        </div>
      )}
    </div>
  );
}

/** Vistas previas de un mensaje (hasta 3) según la preferencia de la conversación. */
export function MessageLinks({ m, mode, onIssue }: { m: MessageDTO; mode: LinkPreviewMode; onIssue?: (title: string) => void }) {
  const list = m.linkPreviews?.length ? m.linkPreviews : m.linkPreview ? [m.linkPreview] : [];
  if (!list.length || mode === 'none') return null;
  // Con varios enlaces, las tarjetas van compactas para no llenar el chat.
  const eff: LinkPreviewMode = list.length > 1 && mode === 'large' ? 'compact' : mode;
  return <div className="link-list">{list.map((p) => <LinkCard key={p.linkId ?? p.url} p={p} mode={eff} onIssue={onIssue} />)}</div>;
}

// ---------- Grupo: «Laura compartió 5 enlaces» ----------
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
/** Un mensaje que es casi solo enlaces (el texto que queda es corto). */
export function isLinkOnly(m: MessageDTO) {
  if (m.kind !== 'text' || m.deletedAt || m.replyTo || m.forwarded || m.attachments?.length) return false;
  const urls = m.body.match(URL_RE);
  return !!urls?.length && m.body.replace(URL_RE, '').replace(/\s+/g, ' ').trim().length <= 24;
}

export function LinkGroup({ d, msgs, onExpand }: { d: BootstrapDTO; msgs: MessageDTO[]; onExpand: () => void }) {
  const author = personById(d, msgs[0]!.authorId);
  const org = orgById(d, author?.orgId);
  const previews = msgs.flatMap((m) => {
    const ps = m.linkPreviews?.length ? m.linkPreviews : m.linkPreview ? [m.linkPreview] : [];
    const urls = m.body.match(URL_RE) ?? [];
    return ps.length ? ps : urls.map((u) => ({ url: u, title: null, description: null, siteName: null, imageUrl: null } as LinkPreviewDTO));
  });
  return (
    <div className="msg link-group" data-mid={msgs[0]!.id}>
      <div><Avatar person={author} org={org} size={34} /></div>
      <div style={{ minWidth: 0 }}>
        <div className="msg-meta">
          <span className="msg-author">{author?.name ?? t('chat.formerParticipant')}</span>
          <span className="msg-org">{org?.name ?? ''}</span>
          <span className="msg-time">{new Date(msgs[0]!.createdAt).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <div className="link-group-head">
          <span>🔗 {t('link.groupShared', { name: author?.name.split(' ')[0] ?? '', n: previews.length })}</span>
          <button className="link-btn small" onClick={onExpand}>{t('link.groupExpand')}</button>
        </div>
        <div className="link-list">{previews.map((p, i) => <LinkCard key={`${p.linkId ?? p.url}-${i}`} p={p} mode="compact" />)}</div>
      </div>
    </div>
  );
}

// ---------- Pestaña «Enlaces» del chat ----------
const FILTERS = ['all', 'video', 'social', 'article', 'doc', 'other'] as const;

function LinkRow({ d, l, showConv, onJump, onChange }: { d: BootstrapDTO; l: LinkItemDTO; showConv?: boolean; onJump?: () => void; onChange?: (l: LinkItemDTO) => void }) {
  const st = useLinkState(l.id) ?? { savedAt: l.savedAt, seenAt: l.seenAt };
  const p = l.preview;
  const who = l.authorId === d.me.id ? t('common.youShort') : personById(d, l.authorId ?? '')?.name.split(' ')[0] ?? '';
  const conv = showConv ? d.conversations.find((c) => c.id === l.conversationId) : null;
  const saved = !!st.savedAt;
  return (
    <div className={`card link-row ${st.seenAt ? 'is-seen' : ''}`}>
      <a className="link-row-main" href={l.url} target="_blank" rel="noopener noreferrer nofollow" onClick={() => { markSeen(l.id); }}>
        {p?.imageUrl ? <img src={apiUrl(p.imageUrl)} alt="" loading="lazy" /> : <span className={`link-row-ico prov-${l.provider ?? 'web'}`} aria-hidden>{l.provider ? PROVIDER[l.provider].ico : KIND_ICO[l.kind]}</span>}
        <span className="grow" style={{ minWidth: 0 }}>
          <b className="ellipsis" style={{ display: 'block' }}>{p?.title ?? l.url}</b>
          <span className="small muted ellipsis" style={{ display: 'block' }}>{linkMeta({ ...p, url: l.url, kind: l.kind, provider: l.provider })}</span>
          <span className="small muted">{[who, conv ? conversationTitle(d, conv) : null, timeLabel(l.createdAt)].filter(Boolean).join(' · ')}{st.seenAt ? ` · ✓ ${t('link.seen')}` : ''}</span>
        </span>
      </a>
      <div className="link-acts">
        <button className={`link-act ${saved ? 'on' : ''}`} onClick={() => void setSaved(l.id, !saved).then((x) => x && onChange?.(x))}>🔖 {saved ? t('link.savedShort') : t('link.save')}</button>
        {showConv && saved && !st.seenAt && <button className="link-act" onClick={() => void client.setLinkState(l.id, { seen: true }).then((x) => { remember(x); onChange?.(x); })}>✓ {t('link.markSeen')}</button>}
        <SummaryBox linkId={l.id} />
        {onJump && <button className="link-act" onClick={onJump}>↩ {t('link.goToMessage')}</button>}
        {showConv && saved && <RemindButton l={l} />}
      </div>
    </div>
  );
}

function RemindButton({ l }: { l: LinkItemDTO }) {
  const at = (days: number, hour: number) => { const x = new Date(); x.setDate(x.getDate() + days); x.setHours(hour, 0, 0, 0); return x.toISOString(); };
  const friday = () => { const x = new Date(); const add = (5 - x.getDay() + 7) % 7 || 7; x.setDate(x.getDate() + add); x.setHours(9, 0, 0, 0); return x.toISOString(); };
  const set = (iso: string) => void client.createReminder({ conversationId: l.conversationId, messageId: l.messageId, note: l.preview?.title ?? l.url, remindAt: iso })
    .then(() => toast(t('link.remindSet'))).catch((e) => toast(errorText(e)));
  return (
    <select className="link-act" aria-label={t('link.remind')} value="" onChange={(e) => { const v = e.target.value; if (v === 'eve') set(at(0, 18)); if (v === 'tom') set(at(1, 9)); if (v === 'fri') set(friday()); }}>
      <option value="">⏰ {t('link.remind')}</option>
      {new Date().getHours() < 17 && <option value="eve">{t('link.remindEvening')}</option>}
      <option value="tom">{t('link.remindTomorrow')}</option>
      <option value="fri">{t('link.remindFriday')}</option>
    </select>
  );
}

export function LinksPane({ conv, onJump, onClose }: { conv: ConversationDTO; onJump: (seq: number) => void; onClose: () => void }) {
  const d = useClient((s) => s.data)!;
  const [kind, setKind] = useState<(typeof FILTERS)[number]>('all');
  const [q, setQ] = useState('');
  const [page, setPage] = useState<{ links: LinkItemDTO[]; hasMore: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = (more = false) => {
    setBusy(true);
    const before = more ? page?.links[page.links.length - 1]?.createdAt : undefined;
    client.listLinks(conv.id, { kind, q: q.trim() || undefined, before })
      .then((r) => setPage((p) => (more && p ? { links: [...p.links, ...r.links], hasMore: r.hasMore } : r)))
      .catch((e) => toast(errorText(e))).finally(() => setBusy(false));
  };
  useEffect(() => { const h = setTimeout(() => load(), q ? 250 : 0); return () => clearTimeout(h); }, [conv.id, kind, q]);
  const mode = conv.linkPreviews ?? 'large';
  return (
    <Modal title={t('bar.linksTitle')} onClose={onClose}>
      <input className="input" placeholder={t('link.searchPh')} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="seg link-filters" role="tablist">
        {FILTERS.map((f) => <button key={f} role="tab" aria-selected={kind === f} className={kind === f ? 'on' : ''} onClick={() => setKind(f)}>{t(`link.filter.${f}` as any)}</button>)}
      </div>
      {page === null && <div className="muted">{t('common.loading')}</div>}
      {page?.links.length === 0 && <div className="hint">{q || kind !== 'all' ? t('link.noMatch') : t('link.empty')}</div>}
      <div className="list" style={{ gap: 6 }}>
        {page?.links.map((l) => <LinkRow key={l.id} d={d} l={l} onJump={() => { onClose(); onJump(l.messageSeq); }} />)}
      </div>
      {page?.hasMore && <button className="btn ghost small" disabled={busy} onClick={() => load(true)}>{t('link.more')}</button>}
      <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
        <span className="small muted">{t('link.previewMode')}: {(['large', 'compact', 'none'] as const).map((m) => (
          <button key={m} className={`link-btn small ${mode === m ? 'is-on' : ''}`} onClick={() => void client.setLinkPreviewMode(conv.id, m).catch((e) => toast(errorText(e)))}>{t(`link.mode.${m}` as any)}</button>
        ))}</span>
        <button className="btn" onClick={() => { onClose(); navigate('/ver-despues'); }}>🔖 {t('link.openSaved')}</button>
      </div>
    </Modal>
  );
}

/** Submenú del chat: vista previa grande, compacta o ninguna (preferencia personal). */
export function previewModeMenu(conv: ConversationDTO): MenuItem {
  const cur = conv.linkPreviews ?? 'large';
  return {
    label: t('link.previewMode'), icon: '🔗',
    items: (['large', 'compact', 'none'] as const).map((m) => ({
      label: `${cur === m ? '✓ ' : ''}${t(`link.mode.${m}` as any)}`,
      onSelect: () => void client.setLinkPreviewMode(conv.id, m).catch((e) => toast(errorText(e))),
    })),
  };
}

// ---------- Pantalla «Ver después» ----------
export function SavedLinksScreen() {
  const d = useClient((s) => s.data)!;
  const [state, setState] = useState<'pending' | 'seen'>('pending');
  const [page, setPage] = useState<{ links: LinkItemDTO[]; hasMore: boolean } | null>(null);
  const pending = usePendingLinks();
  const load = (more = false) => {
    const before = more ? page?.links[page.links.length - 1]?.savedAt ?? undefined : undefined;
    client.listSavedLinks(state, before).then((r) => {
      for (const l of r.links) remember(l);
      setPage((p) => (more && p ? { links: [...p.links, ...r.links], hasMore: r.hasMore } : r));
    }).catch((e) => toast(errorText(e)));
  };
  useEffect(() => { setPage(null); load(); }, [state]);
  const drop = (l: LinkItemDTO) => setPage((p) => (p ? { ...p, links: p.links.filter((x) => x.id !== l.id) } : p));
  return (
    <div className="page"><div className="page-narrow" style={{ maxWidth: 760 }}>
      <h1>🔖 {t('nav.saved')}</h1>
      <p className="muted">{t('link.savedIntro')}</p>
      <div className="seg" style={{ margin: '12px 0', maxWidth: 360 }}>
        <button className={state === 'pending' ? 'on' : ''} onClick={() => setState('pending')}>{t('link.pending')}{pending ? ` · ${pending}` : ''}</button>
        <button className={state === 'seen' ? 'on' : ''} onClick={() => setState('seen')}>{t('link.seenTab')}</button>
      </div>
      {page === null && <div className="muted">{t('common.loading')}</div>}
      {page?.links.length === 0 && <div className="empty">{state === 'pending' ? t('link.savedEmpty') : t('link.seenEmpty')}</div>}
      <div className="list" style={{ gap: 8 }}>
        {page?.links.map((l) => (
          <LinkRow key={l.id} d={d} l={l} showConv onJump={() => navigate(`/c/${l.conversationId}?m=${l.messageSeq}`)}
            onChange={(x) => { if ((state === 'pending' && (x.seenAt || !x.savedAt)) || (state === 'seen' && !x.savedAt)) drop(x); }} />
        ))}
      </div>
      {page?.hasMore && <button className="btn ghost" onClick={() => load(true)}>{t('link.more')}</button>}
    </div></div>
  );
}
