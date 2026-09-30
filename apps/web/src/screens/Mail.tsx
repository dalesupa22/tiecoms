import { useEffect, useMemo, useRef, useState } from 'react';
import type { MailConnectionDTO, MailListItemDTO, MailMessageDTO, MailProvider, MessageDTO, SharedMailDTO, SharedMailCommentDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { errorText, locale, t } from '../i18n.ts';
import { openMenuAt, toast } from '../menu.tsx';
import { navigate, queryParam } from '../router.ts';
import { Avatar, Modal, conversationTitle, initials, orgById, personById, personColor } from '../ui.tsx';
import { openDialog, quickTimes } from '../actions.tsx';
import { mailParts, mailSnippet } from '../mail-text.ts';
import { inboxKey, mailKey, waKey } from '../panes-core.ts';
import { openBeside, paneDragProps, splitAvailable, usePaneCtx, wantsPane } from '../split.ts';
import { prepareMeetingProof, takeMeetingProof, clearMeetingProof } from '../meeting-oauth.ts';

/**
 * Correo en el chat (docs/CORREO.md): la lista es tu Gmail u Outlook en vivo; al llevar un correo a un chat
 * aparece como tarjeta con su icono, se comenta en su hilo y quien lo trajo lo responde o lo programa desde ahí.
 */

// ---------- Iconos de Gmail y Outlook ----------
export function ProviderIcon({ provider, size = 18 }: { provider: MailProvider; size?: number }) {
  if (provider === 'google') return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-label="Gmail" role="img" className="mail-prov-ico">
      <path fill="#4caf50" d="M45 16.2l-5 2.75-5 4.75V40h7a3 3 0 0 0 3-3V16.2z" />
      <path fill="#1e88e5" d="M3 16.2l3.61 1.71L13 23.7V40H6a3 3 0 0 1-3-3V16.2z" />
      <path fill="#e53935" d="M35 11.2L24 19.45 13 11.2l-1 5.8 1 6.7 11 8.25 11-8.25 1-6.7z" />
      <path fill="#c62828" d="M3 12.3v3.9l10 7.5V11.2L9.88 8.86A4.14 4.14 0 0 0 3 12.3z" />
      <path fill="#fbc02d" d="M45 12.3v3.9l-10 7.5V11.2l3.12-2.34A4.14 4.14 0 0 1 45 12.3z" />
    </svg>
  );
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-label="Outlook" role="img" className="mail-prov-ico">
      <path fill="#1a73c9" d="M18 10h24a2 2 0 0 1 2 2v24a2 2 0 0 1-2 2H18z" />
      <path fill="#50b4f0" d="M44 16 30 25 18 17v-5h24a2 2 0 0 1 2 2z" opacity=".85" />
      <rect x="4" y="12" width="24" height="24" rx="3" fill="#0a5aa8" />
      <ellipse cx="16" cy="24" rx="6.2" ry="7.4" fill="none" stroke="#fff" strokeWidth="3.2" />
    </svg>
  );
}
const LABEL: Record<MailProvider | 'whatsapp', string> = { google: 'Gmail', microsoft: 'Outlook', whatsapp: 'WhatsApp' };
const SrcIcon = ({ provider, size = 22 }: { provider: MailProvider | 'whatsapp'; size?: number }) => (provider === 'whatsapp' ? <WaIcon size={size} /> : <ProviderIcon provider={provider} size={size} />);
/** Recibido ↙ o enviado ↗: se distingue de un vistazo en la lista y en la tarjeta. */
export const DirBadge = ({ out }: { out: boolean }) => <span className={`mail-dir ${out ? 'out' : 'in'}`} title={t(out ? 'mail.dir.out' : 'mail.dir.in')} aria-label={t(out ? 'mail.dir.out' : 'mail.dir.in')}>{out ? '↗' : '↙'}</span>;
export const WaIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-label="WhatsApp" role="img"><circle cx="12" cy="12" r="11" fill="#25d366" />
    <path fill="#fff" d="M16.9 14.3c-.3-.1-1.6-.8-1.8-.9-.3-.1-.4-.1-.6.1l-.8 1c-.2.2-.3.2-.6.1a6.6 6.6 0 0 1-3.3-2.9c-.3-.4.3-.4.7-1.3.1-.2 0-.3 0-.5l-.8-2c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2c0 1.3.9 2.5 1.1 2.7.1.2 1.8 2.8 4.4 3.9 1.7.7 2.3.8 3.1.6.5-.1 1.6-.6 1.8-1.3.2-.6.2-1.1.2-1.3-.1 0-.2-.1-.5-.2z" /></svg>
);

const fmtDate = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso); const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString(locale(), { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
};
const fmtWhen = (iso: string) => new Date(iso).toLocaleString(locale(), { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const who = (a: { name: string | null; email: string } | null | undefined) => (a ? a.name || a.email : '');
const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function Highlight({ text, q }: { text: string; q?: string }) {
  const words = (q ?? '').split(/\s+/).filter((w) => w.length > 1 && !w.includes(':'));
  if (!words.length) return <>{text}</>;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return <>{text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}</>;
}

// ---------- Conexión ----------
export function useMailConnections() {
  const [list, setList] = useState<MailConnectionDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => client.mailConnections().then((l) => { setList(l); setError(null); }).catch((e) => setError(errorText(e)));
  useEffect(() => { void load(); }, []);
  return { list, error, reload: load };
}
export async function connectMail(p: MailProvider) {
  const session = client.getSessionIdentity();
  try {
    const userId = client.getState().data?.me.id;
    if (!userId) return;
    const proof = await prepareMeetingProof(sessionStorage, userId, p, () => client.getSessionIdentity() === session);
    const { url } = await client.connectMailProvider(p, proof, 'web');
    if (client.getSessionIdentity() === session) window.location.assign(url);
  } catch (e) { clearMeetingProof(sessionStorage); toast(errorText(e)); }
}
/** Al volver del consentimiento a /correo?mail=1&provider=…&receipt=…: canjea el recibo con la prueba de este navegador. */
function useConfirmReturn(onDone: () => void) {
  useEffect(() => {
    if (!queryParam('mail')) return;
    const p = queryParam('provider'); const receipt = queryParam('receipt'); const error = queryParam('error');
    history.replaceState(null, '', location.pathname);
    const userId = client.getState().data?.me.id;
    if (receipt && p && userId) {
      try {
        const verifier = takeMeetingProof(sessionStorage, userId, p);
        void client.confirmMailProvider(receipt, verifier).then((r) => { toast(t('mail.connectedToast', { name: LABEL[r.provider] })); onDone(); }).catch((e) => toast(errorText(e)));
      } catch (e) { toast(errorText(e)); }
    } else {
      clearMeetingProof(sessionStorage);
      if (error) toast(error === 'cancelled' ? t('mail.cancelledToast') : t('mail.failedToast', { code: error }));
    }
  }, []);
}

function ConnectCards({ list, reload }: { list: MailConnectionDTO[]; reload: () => void }) {
  return (
    <div className="mail-connect">
      {list.map((c) => (
        <div key={c.provider} className="card conv-card">
          <ProviderIcon provider={c.provider} size={26} />
          <span className="grow" style={{ minWidth: 0 }}>
            <b style={{ display: 'block' }}>{c.label}</b>
            <span className={`small ${c.status === 'reconnect' || !c.available ? 'error' : 'muted'}`} style={{ display: 'block' }}>
              {!c.available ? c.unavailableReason : c.status === 'active' ? t('mail.connectedAs', { email: c.accountEmail ?? '' }) : c.status === 'reconnect' ? t('mail.reconnectHint') : t('mail.connectHint')}
            </span>
          </span>
          {c.available && c.status !== 'active' && <button className="btn small primary" onClick={() => void connectMail(c.provider)}>{c.status === 'reconnect' ? t('mail.reconnect') : t('mail.connect')}</button>}
          {c.status !== 'none' && <button className="btn small ghost" onClick={() => void client.disconnectMailProvider(c.provider).then(reload).catch((e) => toast(errorText(e)))}>{t('mail.disconnect')}</button>}
        </div>
      ))}
      <div className="hint">{t('mail.privacyHint')}</div>
    </div>
  );
}

// ---------- Lista con búsqueda y filtros ----------
// Caché de esta pestaña (en memoria): volver a Correo o a un filtro ya visto pinta al instante y se refresca
// por detrás si tiene más de 20 s. La vista previa se precarga al pasar el cursor por la fila.
const LIST_CACHE = new Map<string, { items: MailListItemDTO[]; next: string | null; at: number }>();
const PREVIEW_CACHE = new Map<string, Promise<MailMessageDTO>>();
const previewOf = (provider: MailProvider, id: string) => {
  const k = `${provider}:${id}`;
  let p = PREVIEW_CACHE.get(k);
  if (!p) {
    p = client.getMail(provider, id);
    p.catch(() => PREVIEW_CACHE.delete(k));
    PREVIEW_CACHE.set(k, p);
    if (PREVIEW_CACHE.size > 60) PREVIEW_CACHE.delete(PREVIEW_CACHE.keys().next().value!);
  }
  return p;
};
type Filters = { box: 'inbox' | 'sent' | 'all'; q: string; from: string; to: string; after: string; before: string; attachments: boolean; unread: boolean; label: string; range: string | null };
const EMPTY: Filters = { box: 'inbox', q: '', from: '', to: '', after: '', before: '', attachments: false, unread: false, label: '', range: null };

/** Un correo de la bandeja en su propio panel (se queda ahí mientras trabajas). */
export const openInboxPane = (provider: MailProvider, m: MailListItemDTO) =>
  openBeside(inboxKey(provider, m.id), undefined, { meta: { title: m.subject || t('mail.noSubject'), sub: who(m.box === 'sent' ? m.to[0] : m.from), snap: m } });
/** Un correo traído a un chat, en panel (o en el panel lateral si la ventana es angosta). Nunca dos veces. */
export function openMailPane(emailId: string, subject?: string) {
  if (!splitAvailable()) { openMailDrawer(emailId, 'read'); return; }
  openBeside(mailKey(emailId), undefined, subject ? { meta: { title: subject } } : {});
}

function MailBrowser({ connections, onPick, pickLabel, compact }: { connections: MailConnectionDTO[]; onPick: (provider: MailProvider, item: MailListItemDTO) => void; pickLabel: string; compact?: boolean }) {
  const inPane = !!usePaneCtx();
  const ready = connections.filter((c) => c.status === 'active');
  const [provider, setProvider] = useState<MailProvider | null>(ready[0]?.provider ?? null);
  const [f, setF] = useState<Filters>(EMPTY);
  // Pestaña de Recibidos: por defecto Principal (sin promociones). Al buscar, todas, salvo que se haya elegido una.
  const [cat, setCat] = useState<string | null>(null);
  const [qText, setQText] = useState('');
  const [open, setOpen] = useState<null | 'from' | 'to' | 'label' | 'range'>(null);
  const [items, setItems] = useState<MailListItemDTO[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<MailListItemDTO | null>(null);
  const seq = useRef(0);
  useEffect(() => { if (!provider && ready[0]) setProvider(ready[0].provider); }, [connections]);
  // Escribir busca solo, a los 400 ms.
  useEffect(() => { const h = setTimeout(() => setF((x) => (x.q === qText.trim() ? x : { ...x, q: qText.trim() })), 400); return () => clearTimeout(h); }, [qText]);
  const cats = provider === 'microsoft' ? ['focused', 'other', 'any'] : ['primary', 'updates', 'promotions', 'social', 'forums', 'any'];
  const category = f.box !== 'inbox' ? undefined : cat ?? (f.q || f.from || f.to || f.label ? 'any' : cats[0]);
  const query = (page?: string) => ({ provider: provider!, box: f.box, category, q: f.q, from: f.from, to: f.to, after: f.after, before: f.before, attachments: f.attachments, unread: f.unread, label: f.label, page });
  const cacheKey = provider ? JSON.stringify(query()) : '';
  const load = async (page?: string, fresh = false) => {
    if (!provider) return;
    const my = ++seq.current;
    setBusy(true); setError(null);
    try {
      const r = await client.listMail({ ...query(page), fresh });
      if (my !== seq.current) return;
      setItems((x) => {
        const list = page ? [...(x ?? []), ...r.items] : r.items;
        LIST_CACHE.set(cacheKey, { items: list, next: r.nextPage, at: Date.now() });
        if (LIST_CACHE.size > 30) LIST_CACHE.delete(LIST_CACHE.keys().next().value!);
        return list;
      });
      setNext(r.nextPage);
    } catch (e) { if (my === seq.current) { setError(errorText(e)); if (!page) setItems((x) => x ?? []); } }
    finally { if (my === seq.current) setBusy(false); }
  };
  useEffect(() => { setCat(null); }, [provider]);
  useEffect(() => {
    const hit = LIST_CACHE.get(cacheKey);
    if (hit) { setItems(hit.items); setNext(hit.next); if (Date.now() - hit.at > 20_000) void load(); else seq.current++; }
    else { setItems(null); void load(); }
  }, [cacheKey]);
  const hover = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefetch = (m: MailListItemDTO) => { if (hover.current) clearTimeout(hover.current); hover.current = setTimeout(() => void previewOf(provider!, m.id).catch(() => {}), 250); };
  const filtered = !!(f.q || f.from || f.to || f.after || f.before || f.attachments || f.unread || f.label);
  const setRange = (key: string, after: string, before = '') => { setF((x) => ({ ...x, after, before, range: key })); setOpen(null); };
  const dateMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const now = new Date(); const back = (days: number) => ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days));
    openMenuAt(r.left, r.bottom + 4, [
      { label: t('mail.date.today'), icon: '·', onSelect: () => setRange('today', back(0)) },
      { label: t('mail.date.7'), icon: '·', onSelect: () => setRange('7', back(7)) },
      { label: t('mail.date.30'), icon: '·', onSelect: () => setRange('30', back(30)) },
      { label: t('mail.date.year'), icon: '·', onSelect: () => setRange('year', `${now.getFullYear()}-01-01`) },
      { label: t('mail.date.older'), icon: '·', onSelect: () => setRange('older', '', back(365)) },
      { divider: true },
      { label: t('mail.date.between'), icon: '📅', onSelect: () => { setF((x) => ({ ...x, range: 'custom' })); setOpen('range'); } },
      ...(f.after || f.before ? [{ label: t('mail.date.any'), icon: '✕', onSelect: () => setRange('', '', '') }] : []),
    ]);
  };
  const rangeLabel = f.range === 'today' ? t('mail.date.today') : f.range === '7' ? t('mail.date.7') : f.range === '30' ? t('mail.date.30') : f.range === 'year' ? t('mail.date.year')
    : f.range === 'older' ? t('mail.date.older') : f.after || f.before ? `${f.after || '…'} – ${f.before || '…'}` : t('mail.f.date');
  const conn = connections.find((c) => c.provider === provider);
  if (!ready.length) return <ConnectCards list={connections} reload={() => location.reload()} />;
  return (
    <div className={`mail-browser ${compact ? 'is-compact' : ''}`}>
      <div className="mail-bar">
        {ready.length > 1 && (
          <div className="seg" role="tablist">
            {ready.map((c) => <button key={c.provider} className={provider === c.provider ? 'on' : ''} onClick={() => setProvider(c.provider)}><ProviderIcon provider={c.provider} size={14} /> {c.label}</button>)}
          </div>
        )}
        {ready.length === 1 && conn && <span className="mail-account"><ProviderIcon provider={conn.provider} size={16} /> {conn.accountEmail}</span>}
        <div className="seg" role="radiogroup" aria-label={t('mail.box')}>
          {(['inbox', 'sent', 'all'] as const).map((b) => <button key={b} className={f.box === b ? 'on' : ''} onClick={() => setF((x) => ({ ...x, box: b }))}>{t(`mail.box.${b}`)}</button>)}
        </div>
      </div>
      {f.box === 'inbox' && (
        <div className="mail-cats" role="tablist" aria-label={t('mail.cat')}>
          {cats.map((c) => <button key={c} role="tab" aria-selected={category === c} className={category === c ? 'on' : ''} onClick={() => setCat(c)}>{t(`mail.cat.${c}` as 'mail.cat.any')}</button>)}
        </div>
      )}
      <div className="mail-search">
        <span aria-hidden>🔎</span>
        <input className="input" value={qText} placeholder={t('mail.searchPh')} onChange={(e) => setQText(e.target.value)} aria-label={t('mail.search')} />
        {(qText || filtered) && <button className="icon-btn" aria-label={t('mail.clear')} onClick={() => { setQText(''); setF({ ...EMPTY, box: f.box }); setOpen(null); }}>✕</button>}
      </div>
      <div className="chips mail-chips">
        <button className={`chip ${f.after || f.before ? 'on' : ''}`} onClick={dateMenu}>{rangeLabel} ▾</button>
        <button className={`chip ${f.from ? 'on' : ''}`} onClick={() => setOpen(open === 'from' ? null : 'from')}>{f.from ? `${t('mail.f.from')}: ${f.from}` : t('mail.f.from')} ▾</button>
        <button className={`chip ${f.to ? 'on' : ''}`} onClick={() => setOpen(open === 'to' ? null : 'to')}>{f.to ? `${t('mail.f.to')}: ${f.to}` : t('mail.f.to')} ▾</button>
        <button className={`chip ${f.attachments ? 'on' : ''}`} aria-pressed={f.attachments} onClick={() => setF((x) => ({ ...x, attachments: !x.attachments }))}>📎 {t('mail.f.attachments')}</button>
        <button className={`chip ${f.unread ? 'on' : ''}`} aria-pressed={f.unread} onClick={() => setF((x) => ({ ...x, unread: !x.unread }))}>{t('mail.f.unread')}</button>
        <button className={`chip ${f.label ? 'on' : ''}`} onClick={() => setOpen(open === 'label' ? null : 'label')}>{f.label ? `${provider === 'microsoft' ? t('mail.f.category') : t('mail.f.label')}: ${f.label}` : provider === 'microsoft' ? t('mail.f.category') : t('mail.f.label')} ▾</button>
      </div>
      {open && open !== 'range' && <FilterInput key={open} label={t(`mail.f.${open === 'label' && provider === 'microsoft' ? 'category' : open}`)} value={f[open]} onApply={(v) => { setF((x) => ({ ...x, [open]: v })); setOpen(null); }} />}
      {open === 'range' && (
        <div className="mail-filter-row">
          <label className="small">{t('mail.date.from')} <input className="input" type="date" value={f.after} max={f.before || undefined} onChange={(e) => setF((x) => ({ ...x, after: e.target.value, range: 'custom' }))} /></label>
          <label className="small">{t('mail.date.until')} <input className="input" type="date" value={f.before} min={f.after || undefined} onChange={(e) => setF((x) => ({ ...x, before: e.target.value, range: 'custom' }))} /></label>
          <button className="btn small" onClick={() => setOpen(null)}>{t('common.done')}</button>
        </div>
      )}
      <div className="mail-res-h"><button className="link-btn mail-refresh" disabled={busy} title={t('mail.refresh')} aria-label={t('mail.refresh')} onClick={() => void load(undefined, true)}>{busy ? '…' : '↻'}</button> {filtered ? (items ? t('mail.results', { n: items.length + (next ? '+' : ''), name: LABEL[provider!] }) : t('mail.searching')) : (f.box === 'inbox' && category && category !== 'any' ? `${t('mail.latest.inbox')} · ${t(`mail.cat.${category}` as 'mail.cat.any')}` : t(`mail.latest.${f.box}`))}</div>
      {error && <div className="error" style={{ padding: '8px 12px' }}>{error}</div>}
      <div className="mail-list">
        {items === null && <div className="hint" style={{ padding: 16 }}>{t('common.loading')}</div>}
        {items?.length === 0 && !error && <div className="empty" style={{ padding: 16 }}>{filtered ? t('mail.noResults') : t('mail.empty')}</div>}
        {items?.map((m) => {
          const other = m.box === 'sent' ? m.to[0] : m.from;
          return (
            <div key={m.id} className={`mail-row ${m.unread ? 'is-unread' : ''}`} onMouseEnter={() => prefetch(m)} onMouseLeave={() => { if (hover.current) clearTimeout(hover.current); }} onTouchStart={() => prefetch(m)}
              {...(!compact ? paneDragProps(inboxKey(provider!, m.id), { title: m.subject || t('mail.noSubject'), sub: who(other), snap: m }) : {})}>
              {/* En un panel, o con ⌘/Ctrl + clic, el correo se abre en su propio panel; si no, la vista previa. */}
              <button className="mail-row-main" onClick={(e) => { if (!compact && (inPane || wantsPane(e))) openInboxPane(provider!, m); else setPreview(m); }}>
                <span className="avatar" style={{ width: 32, height: 32, fontSize: 12, background: personColor(other?.email ?? m.id) }} aria-hidden>{initials(who(other) || '?')}</span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="row" style={{ gap: 6 }}>{f.box !== 'inbox' && <DirBadge out={m.box === 'sent'} />}<b className="ellipsis grow">{m.box === 'sent' ? `${t('mail.toShort')} ${who(other)}` : who(other)}</b><span className="small muted mail-date">{fmtDate(m.date)}</span></span>
                  <span className="ellipsis mail-subj" style={{ display: 'block' }}><Highlight text={m.subject || t('mail.noSubject')} q={f.q} /></span>
                  <span className="small muted ellipsis" style={{ display: 'block' }}>{m.hasAttachments ? '📎 ' : ''}<Highlight text={m.snippet} q={f.q} /></span>
                </span>
              </button>
              {!compact && splitAvailable() && <button className="icon-btn mail-panel-btn" title={t('split.inPanel')} aria-label={t('split.inPanel')} onClick={() => openInboxPane(provider!, m)}>⊞</button>}
              <button className="btn small primary mail-pick" onClick={() => onPick(provider!, m)}>{pickLabel}</button>
            </div>
          );
        })}
        {next && <div className="mail-more"><button className="btn small" disabled={busy} onClick={() => void load(next)}>{busy ? t('common.loading') : t('mail.more')}</button></div>}
      </div>
      <div className="mail-foot"><ProviderIcon provider={provider!} size={13} /> {filtered ? t('mail.searchFoot', { name: LABEL[provider!] }) : t('mail.liveFoot', { name: LABEL[provider!] })}</div>
      {preview && <MailPreview provider={provider!} item={preview} pickLabel={pickLabel} onPick={() => { const p = preview; setPreview(null); onPick(provider!, p); }} onClose={() => setPreview(null)} />}
    </div>
  );
}

function FilterInput({ label, value, onApply }: { label: string; value: string; onApply: (v: string) => void }) {
  const [v, setV] = useState(value);
  return (
    <form className="mail-filter-row" onSubmit={(e) => { e.preventDefault(); onApply(v.trim()); }}>
      <input className="input" autoFocus value={v} placeholder={label} onChange={(e) => setV(e.target.value)} aria-label={label} />
      <button className="btn small primary">{t('mail.apply')}</button>
      {value && <button type="button" className="btn small ghost" onClick={() => onApply('')}>{t('mail.remove')}</button>}
    </form>
  );
}

/** Vista previa del correo completo (en vivo) antes de llevarlo al chat. */
function MailPreview({ provider, item, pickLabel, onPick, onClose }: { provider: MailProvider; item: MailListItemDTO; pickLabel: string; onPick: () => void; onClose: () => void }) {
  const [m, setM] = useState<MailMessageDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { previewOf(provider, item.id).then(setM).catch((e) => setError(errorText(e))); }, [item.id]);
  return (
    <Modal title={item.subject || t('mail.noSubject')} onClose={onClose}>
      <MailMeta from={item.from} to={m?.to ?? item.to} cc={m?.cc ?? []} date={item.date} provider={provider} />
      {error && <div className="error">{error}</div>}
      <div className="mail-body">{m ? m.body || t('mail.noBody') : t('common.loading')}</div>
      {!!m?.attachments.length && <div className="att-chips">{m.attachments.map((a) => <span key={a.id} className="file-chip">📎 {a.name} · {kb(a.size)}</span>)}</div>}
      <div className="modal-actions">{splitAvailable() && <button className="btn ghost" onClick={() => { onClose(); openInboxPane(provider, item); }}>⊞ {t('split.inPanel')}</button>}<button className="btn ghost" onClick={onClose}>{t('common.close')}</button><button className="btn primary" onClick={onPick}>{pickLabel}</button></div>
    </Modal>
  );
}

function MailMeta({ from, to, cc, date, provider }: { from: SharedMailDTO['from']; to: SharedMailDTO['to']; cc: SharedMailDTO['cc']; date: string | null; provider: MailProvider | 'whatsapp' }) {
  const list = (l: SharedMailDTO['to']) => l.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ');
  return (
    <dl className="mail-meta">
      <dt>{t('mail.meta.from')}</dt><dd>{from ? (from.name ? `${from.name} <${from.email}>` : from.email) : '—'}</dd>
      {!!to.length && <><dt>{t('mail.meta.to')}</dt><dd>{list(to)}</dd></>}
      {!!cc.length && <><dt>CC</dt><dd>{list(cc)}</dd></>}
      {date && <><dt>{t('mail.meta.date')}</dt><dd>{new Date(date).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' })} · <SrcIcon provider={provider} size={12} /> {LABEL[provider]}</dd></>}
    </dl>
  );
}

// ---------- Llevar a un chat ----------
/** Elegir uno o varios chats (hasta 10) para llevar un correo o un WhatsApp. */
function ChatPicker({ picked, setPicked, exclude }: { picked: string[]; setPicked: (v: string[]) => void; exclude?: string }) {
  const d = useClient((s) => s.data)!;
  const [q, setQ] = useState('');
  const list = useMemo(() => d.conversations.filter((c) => c.canPost && c.id !== exclude && (!q || conversationTitle(d, c).toLowerCase().includes(q.toLowerCase()))).slice(0, 80), [d, q, exclude]);
  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : picked.length >= 10 ? picked : [...picked, id]);
  return (
    <>
      <input className="input" placeholder={t('mail.pickChat')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      {picked.length > 0 && (
        <div className="chips">{picked.map((id) => { const c = d.conversations.find((x) => x.id === id); return c ? <button key={id} className="chip on" onClick={() => toggle(id)}>{conversationTitle(d, c)} ✕</button> : null; })}</div>
      )}
      <div className="list" style={{ maxHeight: 220, overflow: 'auto' }}>
        {list.map((c) => (
          <label key={c.id} className={`check ${picked.includes(c.id) ? 'derive-opt is-on' : ''}`}>
            <input type="checkbox" checked={picked.includes(c.id)} onChange={() => toggle(c.id)} />
            <span className="grow"><b>{conversationTitle(d, c)}</b><span className="small muted" style={{ display: 'block' }}>{d.workspaces.find((w) => w.id === c.workspaceId)?.name ?? t('kind.direct')}</span></span>
          </label>
        ))}
      </div>
    </>
  );
}
function WhoSees({ picked }: { picked: string[] }) {
  const d = useClient((s) => s.data)!;
  const convs = picked.map((id) => d.conversations.find((c) => c.id === id)).filter(Boolean) as typeof d.conversations;
  if (!convs.length) return null;
  const people = new Set(convs.flatMap((c) => c.memberIds));
  return <div className="warn-box">{convs.length === 1 ? t('mail.whoSees', { n: convs[0]!.memberIds.length, name: conversationTitle(d, convs[0]!) }) : t('mail.whoSeesMany', { n: people.size, chats: convs.length })}</div>;
}
const shareLabel = (d: NonNullable<ReturnType<typeof client.getState>['data']>, picked: string[]) => {
  if (picked.length === 1) { const c = d.conversations.find((x) => x.id === picked[0]); return c ? t('mail.shareIn', { name: conversationTitle(d, c) }) : t('mail.share'); }
  return picked.length > 1 ? t('mail.shareInMany', { n: picked.length }) : t('mail.share');
};

function ShareStep({ provider, item, conversationId, onDone, onBack }: { provider: MailProvider; item: MailListItemDTO; conversationId?: string; onDone: (convId: string) => void; onBack: () => void }) {
  const d = useClient((s) => s.data)!;
  const [picked, setPicked] = useState<string[]>(conversationId ? [conversationId] : []);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const share = async () => {
    if (!picked.length || busy) return;
    setBusy(true);
    try {
      await client.shareMail({ provider, messageId: item.id, conversationIds: picked, comment: comment.trim() || undefined });
      toast(picked.length > 1 ? t('mail.sharedMany', { n: picked.length }) : t('mail.shared'));
      onDone(conversationId && picked.includes(conversationId) ? conversationId : picked[0]!);
    } catch (e) { toast(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="xcard mini">
        <div className="xcard-top"><span className="src-ico"><ProviderIcon provider={provider} size={20} /></span>
          <div style={{ minWidth: 0 }}><b className="ellipsis" style={{ display: 'block' }}><DirBadge out={item.box === 'sent'} /> {item.subject || t('mail.noSubject')}</b><span className="small muted">{who(item.box === 'sent' ? item.to[0] : item.from)} · {fmtDate(item.date)}{item.hasAttachments ? ' · 📎' : ''}</span></div></div>
      </div>
      <ChatPicker picked={picked} setPicked={setPicked} />
      <textarea className="input" rows={3} maxLength={4000} placeholder={t('mail.commentPh')} value={comment} onChange={(e) => setComment(e.target.value)} />
      <WhoSees picked={picked} />
      <div className="modal-actions">
        <button className="btn ghost" onClick={onBack}>{t('common.back')}</button>
        <button className="btn primary" disabled={!picked.length || busy} onClick={() => void share()}>{busy ? t('mail.sharing') : shareLabel(d, picked)}</button>
      </div>
    </>
  );
}

/** Un correo de la bandeja como panel: se lee completo y se lleva a un chat (ahí se comenta y se responde). */
export function InboxMailReader({ provider, id, item }: { provider: MailProvider; id: string; item?: MailListItemDTO }) {
  const [m, setM] = useState<MailMessageDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { previewOf(provider, id).then(setM).catch((e) => setError(errorText(e))); }, [provider, id]);
  const base = m ?? item;
  const share = () => base && openDialog((close) => (
    <Modal title={t('mail.shareTitle')} onClose={close}><ShareStep provider={provider} item={base} onBack={close} onDone={(cid) => { close(); openBeside(cid); }} /></Modal>
  ));
  return (
    <div className="pane-mail">
      {base && <MailMeta from={base.from} to={m?.to ?? base.to} cc={m?.cc ?? []} date={base.date} provider={provider} />}
      {error && <div className="error">{error}</div>}
      <div className="mail-body pane-mail-body">{m ? m.body || t('mail.noBody') : t('common.loading')}</div>
      {!!m?.attachments.length && <div className="att-chips">{m.attachments.map((a) => <span key={a.id} className="file-chip">📎 {a.name} · {kb(a.size)}</span>)}</div>}
      <div className="pane-mail-foot"><span className="small muted grow">{t('mail.paneHint')}</span><button className="btn small primary" disabled={!base} onClick={share}>{t('mail.bring')}</button></div>
    </div>
  );
}

/** Desde el ＋ del chat: elegir un correo (con búsqueda) y compartirlo en este chat. */
export function MailPickDialog({ conversationId, onClose }: { conversationId?: string; onClose: () => void }) {
  const { list, error } = useMailConnections();
  const [pick, setPick] = useState<{ provider: MailProvider; item: MailListItemDTO } | null>(null);
  return (
    <Modal title={pick ? t('mail.shareTitle') : t('mail.pickTitle')} onClose={onClose}>
      {!list && (error ? <div className="error">{error}</div> : <div className="muted">{t('common.loading')}</div>)}
      {list && !pick && <MailBrowser connections={list} compact pickLabel={conversationId ? t('mail.pickHere') : t('mail.bring')} onPick={(provider, item) => setPick({ provider, item })} />}
      {pick && <ShareStep {...pick} conversationId={conversationId} onBack={() => setPick(null)} onDone={(id) => { onClose(); if (id !== conversationId) navigate(`/c/${id}`); }} />}
    </Modal>
  );
}

/** Más › Correo: la lista en vivo, con búsqueda y filtros; «Llevar a un chat» en cada correo. */
export function MailScreen() {
  const { list, error, reload } = useMailConnections();
  useConfirmReturn(() => void reload());
  const ready = list?.some((c) => c.status === 'active');
  return (
    <div className="page mail-page">
      <div className="page-head">
        <h1 className="serif">{t('mail.title')}</h1>
        {ready && <button className="btn small ghost" onClick={() => openDialog((close) => <Modal title={t('mail.accounts')} onClose={close}><ConnectCards list={list!} reload={() => { close(); void reload(); }} /></Modal>)}>{t('mail.accounts')}</button>}
      </div>
      {error && <div className="error">{error}</div>}
      {!list && !error && <div className="muted">{t('common.loading')}</div>}
      {list && !ready && <><p className="muted" style={{ maxWidth: 560 }}>{t('mail.intro')}</p><ConnectCards list={list} reload={() => void reload()} /></>}
      {list && ready && <MailBrowser connections={list} pickLabel={t('mail.bring')} onPick={(provider, item) => openDialog((close) => (
        <Modal title={t('mail.shareTitle')} onClose={close}><ShareStep provider={provider} item={item} onBack={close} onDone={(id) => { close(); navigate(`/c/${id}`); }} /></Modal>
      ))} />}
    </div>
  );
}

// ---------- La tarjeta en el chat ----------
function useSharedMail(id: string) {
  const email = useClient((s) => s.mails[id]);
  const [missing, setMissing] = useState(false);
  useEffect(() => { if (!email) client.loadSharedMail(id).catch(() => setMissing(true)); }, [id, !!email]);
  return { email, missing };
}
async function openAttachment(emailId: string, a: { id: string; name: string; contentType: string }) {
  const w = /^(image\/|application\/pdf)/.test(a.contentType) ? window.open('', '_blank') : null;
  try {
    const blob = await client.fetchBlob(client.mailAttachmentPath(emailId, a.id));
    const url = URL.createObjectURL(blob);
    if (w) w.location.href = url;
    else { const l = document.createElement('a'); l.href = url; l.download = a.name; l.click(); }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) { w?.close(); toast(errorText(e)); }
}

export function MailStatus({ email }: { email: SharedMailDTO }) {
  const d = useClient((s) => s.data)!;
  if (email.status === 'replied') return <span className="pill-state ok">{email.repliedBy === d.me.id ? t('mail.repliedByYou', { when: fmtDate(email.repliedAt) }) : t('mail.repliedBy', { name: personById(d, email.repliedBy)?.name.split(' ')[0] ?? '', when: fmtDate(email.repliedAt) })}</span>;
  if (email.status === 'scheduled') return <span className="pill-state sched">{email.scheduledReply ? t('mail.scheduledFor', { when: fmtWhen(email.scheduledReply.sendAt) }) : t('mail.scheduled')}</span>;
  if (email.direction === 'out') return <span className="pill-state out">{email.sharedBy === d.me.id ? t('mail.sentByYou') : t('mail.sentMail')}</span>;
  return <span className="pill-state wait">{t('mail.pending')}</span>;
}

/** Comentarios en la tarjeta, como en la tarjeta de tarea: los 2 últimos, «Ver los N comentarios» y comentar ahí mismo. */
function CardComments({ email, canPost }: { email: SharedMailDTO; canPost: boolean }) {
  const d = useClient((s) => s.data)!;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const body = text.trim(); if (!body || busy) return;
    setBusy(true);
    try { await client.commentMail(email.id, body); setText(''); } catch (e) { toast(errorText(e)); } finally { setBusy(false); }
  };
  const last = email.lastComments.slice(-2);
  return (
    <>
      {last.length > 0 && (
        <div className="task-card-comments">
          {last.map((c) => <div key={c.id} className="task-card-comment"><b>{c.authorId === d.me.id ? t('common.youShort') : personById(d, c.authorId)?.name.split(' ')[0]}</b> {c.body}</div>)}
          {email.commentCount > last.length && <button className="link-btn small" onClick={() => openMailDrawer(email.id, 'comments')}>{t('task.cardAll', { n: email.commentCount })}</button>}
        </div>
      )}
      {canPost && (
        <div className="task-card-reply">
          <input className="input" value={text} placeholder={email.provider === 'whatsapp' ? t('mail.commentWaPh') : t('mail.commentCardPh')} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
          <button className="btn small" disabled={!text.trim() || busy} onClick={() => void send()}>{t('comments.send')}</button>
        </div>
      )}
    </>
  );
}

/** Cuerpo del correo con los enlaces como «dominio ↗» y sin las direcciones de las imágenes. */
export function MailText({ text }: { text: string }) {
  const parts = useMemo(() => mailParts(text), [text]);
  return <>{parts.map((p, i) => ('href' in p
    ? <a key={i} className="mail-link" href={p.href} title={p.href} target="_blank" rel="noopener noreferrer nofollow">{p.label} ↗</a>
    : <span key={i}>{p.text}</span>))}</>;
}

/**
 * El correo con su diseño. Iframe con sandbox sin scripts (el API ya quitó scripts y on*): solo deja abrir enlaces
 * en otra pestaña. allow-same-origin es para medir el alto y encoger los correos de 600 px al ancho de la tarjeta.
 */
const HTML_HEAD = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline' https:; font-src https: data:"><base target="_blank"><meta name="color-scheme" content="light"><style>:root{color-scheme:light}html,body{margin:0;background:#fff;color:#1f1f1f;font:14px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;overflow-wrap:anywhere}body{padding:12px}img{max-width:100%;height:auto}a{color:#1a5fd6}</style>`;
const htmlCache = new Map<string, string | null>();
function useMailHtml(id: string, on: boolean) {
  const [html, setHtml] = useState<string | null | undefined>(htmlCache.get(id));
  useEffect(() => {
    if (!on || htmlCache.has(id)) return;
    let live = true;
    client.mailHtml(id).then((r) => { htmlCache.set(id, r.html); if (live) setHtml(r.html); }).catch(() => live && setHtml(null));
    return () => { live = false; };
  }, [id, on]);
  return html;
}
export function MailHtml({ html, maxHeight }: { html: string; maxHeight?: number }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [h, setH] = useState(160);
  const fit = () => {
    const f = ref.current, doc = f?.contentDocument;
    if (!f || !doc?.body) return;
    // Se mide sin zoom y se encoge lo que no cabe (los boletines vienen a 600 px).
    const root = doc.documentElement;
    root.style.zoom = '';
    const w = f.clientWidth, sw = root.scrollWidth, sh = doc.body.offsetHeight;
    const z = sw > w + 2 ? w / sw : 1;
    if (z !== 1) root.style.zoom = String(z);
    setH(Math.ceil(sh * z) + 2);
  };
  useEffect(() => { const f = ref.current; if (!f) return; const ro = new ResizeObserver(() => fit()); ro.observe(f); return () => ro.disconnect(); }, []);
  return (
    <iframe ref={ref} className="mail-html" title={t('mail.title')} sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer" srcDoc={`<!doctype html><html><head>${HTML_HEAD}</head><body>${html}</body></html>`}
      style={{ height: maxHeight ? Math.min(h, maxHeight) : h }} scrolling={maxHeight && h > maxHeight ? 'yes' : 'no'}
      onLoad={() => { fit(); ref.current?.contentDocument?.querySelectorAll('img').forEach((i) => i.addEventListener('load', fit, { once: true })); }} />
  );
}

export function MailCard({ emailId, banner, onIssue }: { emailId: string; banner?: React.ReactNode; onIssue?: (id: string) => void }) {
  const d = useClient((s) => s.data)!;
  const { email, missing } = useSharedMail(emailId);
  // «Ver correo» lo abre ahí mismo, dentro de la tarjeta; el panel queda para responder o ver el hilo.
  const [peek, setPeek] = useState(false);
  const html = useMailHtml(emailId, peek && email?.provider !== 'whatsapp');
  useEffect(() => { if (peek && email && !email.full) client.loadSharedMailFull(emailId).catch((e) => toast(errorText(e))); }, [peek, !!email, email?.full]);
  if (!email) return missing ? <div className="card mail-card is-missing small muted">{t('mail.unavailable')}</div> : <div className="card mail-card is-loading" aria-busy>…</div>;
  const mine = email.sharedBy === d.me.id;
  const conv = d.conversations.find((c) => c.id === email.conversationId);
  const isWa = email.provider === 'whatsapp';
  const other = email.direction === 'out' ? email.to[0] : email.from;
  const open = (mode: DrawerMode) => (mode === 'read' ? openMailPane(email.id, email.subject) : openMailDrawer(email.id, mode));
  // Se arrastra al área de paneles: el correo (o, si es tu WhatsApp, su chat) queda abierto al lado.
  const waChat = isWa && mine && email.wa ? waKey(email.wa.accountId, email.wa.jid) : null;
  const drag = paneDragProps(waChat ?? mailKey(email.id), { title: (isWa ? email.wa?.chatName : email.subject) || t('mail.noSubject') });
  const taskBtn = email.issueId
    ? <button className="btn small" onClick={() => onIssue?.(email.issueId!)}>◆ {t('mail.seeTask')}</button>
    : conv?.canPost ? <button className="btn small" onClick={() => openDialog((close) => <MailTaskDialog email={email} onClose={close} />)}>◆ {t('mail.task')}</button> : null;
  if (isWa) {
    const wa = email.wa;
    const author = email.direction === 'out' ? (mine ? t('common.youShort') : personById(d, email.sharedBy)?.name.split(' ')[0]) : email.from?.name ?? t('wa.someone');
    return (
      <div className="card mail-card wa-card" {...drag}>
        {banner}
        <div className="mail-card-top">
          <span className="src-ico wa"><WaIcon size={22} /></span>
          <div style={{ minWidth: 0 }}>
            <div className="mail-card-kind">WhatsApp{wa?.accountKind === 'business' ? ' Business' : ''} · {wa?.isGroup ? `👥 ${t('wa.groupShort')}` : ''}{wa?.chatName ?? email.subject}</div>
            <div className="small muted ellipsis"><b>{author}</b> · {fmtDate(email.sentAt)}</div>
          </div>
        </div>
        <button className="wa-quote link-quote" onClick={() => open('read')}>{email.snippet}</button>
        <CardComments email={email} canPost={!!conv?.canPost} />
        <div className="mail-card-foot">
          <span className="grow" />
          {taskBtn}
          {mine && wa && <button className="btn small" onClick={() => (splitAvailable() ? openBeside(waChat!, undefined, { meta: { title: wa.chatName ?? email.subject } }) : navigate('/whatsapp'))}>{t('wa.seeIn')}</button>}
        </div>
      </div>
    );
  }
  return (
    <div className={`card mail-card ${email.direction === 'out' ? 'is-out' : 'is-in'}`} {...drag}>
      {banner}
      <div className="mail-card-top">
        <span className="src-ico"><SrcIcon provider={email.provider} size={22} /></span>
        <div style={{ minWidth: 0 }}>
          <div className="mail-card-kind"><DirBadge out={email.direction === 'out'} /> {t(email.direction === 'out' ? 'mail.kind.out' : 'mail.kind.in', { name: LABEL[email.provider] })}</div>
          <button className="mail-card-title" onClick={() => open('read')}>{email.subject || t('mail.noSubject')}</button>
          <div className="small muted ellipsis">{email.direction === 'out' ? `${t('mail.toShort')} ` : ''}{who(other)}{other?.name ? ` · ${other.email}` : ''} · {fmtDate(email.sentAt)}</div>
        </div>
      </div>
      {peek
        ? html ? <MailHtml html={html} maxHeight={460} />
          : <div className="mail-peek" aria-busy={!email.full || html === undefined}>{email.full ? (email.body ? <MailText text={email.body} /> : t('mail.noBody')) : `${mailSnippet(email.snippet)}…`}</div>
        : <button className="mail-card-snip" onClick={() => setPeek(true)}>{mailSnippet(email.snippet) || t('mail.noBody')}</button>}
      <div className="mail-peek-bar">
        <button className="link-btn small" aria-expanded={peek} onClick={() => setPeek((v) => !v)}>{peek ? `▴ ${t('mail.peekHide')}` : `▾ ${t('mail.peek')}`}</button>
        <button className="link-btn small" onClick={() => open('read')}>⤢ {splitAvailable() ? t('split.inPanel') : t('mail.peekPanel')}</button>
      </div>
      {!!email.attachments.length && (
        <div className="att-chips">
          {email.attachments.slice(0, 4).map((a) => <button key={a.id} className="file-chip" title={t('mail.openAttachment')} onClick={() => void openAttachment(email.id, a)}>📎 {a.name} · {kb(a.size)}</button>)}
          {email.attachments.length > 4 && <button className="file-chip" onClick={() => open('read')}>+{email.attachments.length - 4}</button>}
        </div>
      )}
      <CardComments email={email} canPost={!!conv?.canPost} />
      <div className="mail-card-foot">
        <MailStatus email={email} />
        <span className="grow" />
        {taskBtn}
        {mine && email.status !== 'replied' && email.status !== 'scheduled' && <button className="btn small primary" onClick={() => open('reply')}>{t('mail.reply')}</button>}
      </div>
    </div>
  );
}

/** Aviso agrupado de comentarios: una línea corta que lleva a la tarjeta, sin repetirla. */
export function CommentsNoticeLine({ count, title, lastByName, lastExcerpt, icon, onOpen }: { count: number; title: string; lastByName: string; lastExcerpt: string; icon?: React.ReactNode; onOpen: () => void }) {
  return (
    <button className="comments-line" onClick={onOpen}>
      {icon}<span className="comments-line-n">{count > 1 ? t('comments.many', { n: count }) : t('comments.one')}</span>
      <span className="comments-line-t ellipsis">«{title}» · <b>{String(lastByName ?? '').split(' ')[0]}</b> {lastExcerpt}</span>
    </button>
  );
}

/** Mensaje de sistema «mail.shared»: se ve como un mensaje de quien lo trajo, con su comentario y la tarjeta. */
/** Responder, responder en privado y reenviar la tarjeta, como un mensaje normal (clic derecho o los botones al pasar). */
export interface CardActions { reply: () => void; replyPrivately?: () => void; forward: () => void; menu: Record<string, unknown> }
function CardHoverBar({ a }: { a: CardActions }) {
  return (
    <div className="card-actions-bar" role="toolbar">
      <button onClick={a.reply} title={t('menu.reply')} aria-label={t('menu.reply')}>↩</button>
      {a.replyPrivately && <button onClick={a.replyPrivately} title={t('preply.action')} aria-label={t('preply.action')}>✉</button>}
      <button onClick={a.forward} title={t('card.forward')} aria-label={t('card.forward')}>↪</button>
    </div>
  );
}
export const openForwardCard = (emailId: string) => openDialog((close) => <ForwardCardDialog emailId={emailId} onClose={close} />);
function ForwardCardDialog({ emailId, onClose }: { emailId: string; onClose: () => void }) {
  const d = useClient((s) => s.data)!;
  const email = useClient((s) => s.mails[emailId]);
  const [picked, setPicked] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!picked.length || busy) return;
    setBusy(true);
    try {
      await client.forwardShared(emailId, picked, comment.trim() || undefined);
      const first = picked[0]!;
      toast(picked.length > 1 ? t('mail.sharedMany', { n: picked.length }) : t('mail.shared'), { label: t('lin.open'), run: () => navigate(`/c/${first}`) });
      onClose();
    } catch (e) { toast(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={t('card.forwardTitle')} onClose={onClose}>
      {email && (
        <div className="xcard mini"><div className="xcard-top"><span className={`src-ico ${email.provider === 'whatsapp' ? 'wa' : ''}`}><SrcIcon provider={email.provider} size={20} /></span>
          <div style={{ minWidth: 0 }}><b className="ellipsis" style={{ display: 'block' }}>{email.provider === 'whatsapp' ? email.wa?.chatName ?? email.subject : email.subject || t('mail.noSubject')}</b><span className="small muted ellipsis" style={{ display: 'block' }}>{email.snippet}</span></div></div></div>
      )}
      <ChatPicker picked={picked} setPicked={setPicked} exclude={email?.conversationId} />
      <textarea className="input" rows={2} maxLength={4000} placeholder={t('mail.commentPh')} value={comment} onChange={(e) => setComment(e.target.value)} />
      <WhoSees picked={picked} />
      <div className="modal-actions"><button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" disabled={!picked.length || busy} onClick={() => void go()}>{busy ? t('mail.sharing') : shareLabel(d, picked)}</button></div>
    </Modal>
  );
}

export function MailSharedRow({ m, p, onIssue, actions }: { m: MessageDTO; p: { emailId: string; comment?: string }; onIssue: (id: string) => void; actions?: CardActions }) {
  const d = useClient((s) => s.data)!;
  const author = personById(d, m.authorId);
  return (
    <div id={`msg-${m.conversationId}-${m.seq}`} data-mid={m.id} className="msg card-msg" {...(actions?.menu ?? {})}>
      {actions && <CardHoverBar a={actions} />}
      <div><Avatar person={author} org={orgById(d, author?.orgId)} size={34} /></div>
      <div style={{ minWidth: 0 }}>
        <div className="msg-meta"><span className="msg-author">{author?.name ?? t('common.participant')}</span><span className="msg-time">{new Date(m.createdAt).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' })}</span></div>
        {p.comment && <div className="msg-body">{p.comment}</div>}
        <MailCard emailId={p.emailId} onIssue={onIssue} />
      </div>
    </div>
  );
}

// ---------- Panel del correo: leer, comentar, responder o programar ----------
type DrawerMode = 'read' | 'comments' | 'reply';
export const openMailDrawer = (id: string, mode: DrawerMode = 'read') => openDialog((close) => <MailDrawer id={id} mode={mode} onClose={close} />);
/** El mismo lector con diseño, comentarios y respuesta, dentro de un panel (docs/PANELES.md). */
export const MailReader = ({ id, onClose }: { id: string; onClose: () => void }) => <MailDrawer id={id} mode="read" onClose={onClose} inline />;

function MailDrawer({ id, mode, onClose, inline }: { id: string; mode: DrawerMode; onClose: () => void; inline?: boolean }) {
  const d = useClient((s) => s.data)!;
  const { email, missing } = useSharedMail(id);
  const [tab, setTab] = useState<'comment' | 'reply'>(mode === 'reply' ? 'reply' : 'comment');
  const [bodyOpen, setBodyOpen] = useState(mode === 'read');
  const [orig, setOrig] = useState<string | null>(null);
  const [origBusy, setOrigBusy] = useState(false);
  const [asText, setAsText] = useState(false);
  const html = useMailHtml(id, !!email && email.provider !== 'whatsapp');
  const commentsRef = useRef<HTMLDivElement>(null);
  // La tarjeta llega sin cuerpo: se pide al abrir el panel.
  useEffect(() => { if (email && !email.full) client.loadSharedMailFull(id).catch(() => {}); }, [id, !!email, email?.full]);
  const showOriginal = async () => {
    setOrigBusy(true);
    try { setOrig((await client.mailOriginal(id)).body); setBodyOpen(true); } catch (e) { toast(errorText(e)); } finally { setOrigBusy(false); }
  };
  useEffect(() => { if (inline) return; const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, []);
  useEffect(() => { if (mode === 'comments') commentsRef.current?.scrollIntoView({ block: 'start' }); }, [!!email]);
  const mine = email?.sharedBy === d.me.id;
  const conv = email ? d.conversations.find((c) => c.id === email.conversationId) : null;
  const other = email ? (email.direction === 'out' ? email.to[0] : email.from) : null;
  const gmailLink = mine ? email?.webLink ?? null : null;
  const body = (
      <aside className={`mail-drawer ${inline ? 'is-inline' : ''}`} role={inline ? 'region' : 'dialog'} aria-label={email?.subject ?? t('mail.title')} onClick={(e) => e.stopPropagation()}>
        {inline ? gmailLink && <div className="pane-mail-links"><a className="btn small ghost" href={gmailLink} target="_blank" rel="noopener noreferrer">{t('mail.openIn', { name: LABEL[email!.provider] })} ↗</a></div> : <header className="mail-drawer-h">
          {email && <span className={`src-ico ${email.provider === 'whatsapp' ? 'wa' : ''}`}><SrcIcon provider={email.provider} size={20} /></span>}
          <b className="grow ellipsis">{email ? email.subject || t('mail.noSubject') : t('mail.title')}</b>
          {gmailLink && <a className="btn small ghost" href={gmailLink} target="_blank" rel="noopener noreferrer">{t('mail.openIn', { name: LABEL[email!.provider] })} ↗</a>}
          <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}>×</button>
        </header>}
        {!email && <div className="hint" style={{ padding: 16 }}>{missing ? t('mail.unavailable') : t('common.loading')}</div>}
        {email && (
          <div className="mail-drawer-b">
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}><MailStatus email={email} />{email.issueId && <span className="pill-state muted">◆ {t('mail.hasTask')}</span>}
              {email.scheduledReply && <button className="btn small ghost" onClick={() => void client.cancelMailReply(email.id).then(() => toast(t('mail.scheduleCancelled'))).catch((e) => toast(errorText(e)))}>{t('mail.cancelSchedule')}</button>}</div>
            <MailMeta from={email.from} to={email.to} cc={email.cc} date={email.sentAt} provider={email.provider} />
            {html && !asText && !orig ? <MailHtml html={html} /> : <div className={`mail-body ${bodyOpen || orig ? '' : 'is-clamped'}`} aria-busy={!email.full}>{orig != null ? <MailText text={orig} /> : email.full ? (email.body ? <MailText text={email.body} /> : t('mail.noBody')) : `${mailSnippet(email.snippet)}…`}</div>}
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              {html && !orig && <button className="link-btn" onClick={() => setAsText((v) => !v)}>{asText ? t('mail.asDesign') : t('mail.asText')}</button>}
              {(!html || asText) && email.full && !orig && email.body.length > 400 && <button className="link-btn" onClick={() => setBodyOpen((v) => !v)}>{bodyOpen ? t('mail.less') : t('mail.moreBody')}</button>}
              {(!html || asText) && email.full && email.trimmed && !orig && <button className="link-btn" disabled={origBusy} onClick={() => void showOriginal()}>{origBusy ? t('common.loading') : t('mail.showHistory')}</button>}
              {orig && <button className="link-btn" onClick={() => setOrig(null)}>{t('mail.hideHistory')}</button>}
            </div>
            {!!email.attachments.length && (
              <>
                <div className="eyebrow">{t('mail.attachmentsOnDemand', { name: LABEL[email.provider] })}</div>
                {email.attachments.map((a) => (
                  <div key={a.id} className="mail-file">
                    <span className="mail-file-ico">{(a.name.split('.').pop() ?? '').slice(0, 4).toUpperCase()}</span>
                    <span className="grow" style={{ minWidth: 0 }}><b className="ellipsis" style={{ display: 'block' }}>{a.name}</b><span className="small muted">{kb(a.size)}</span></span>
                    <button className="btn small" onClick={() => void openAttachment(email.id, a)}>{t('mail.open')}</button>
                  </div>
                ))}
              </>
            )}
            <div ref={commentsRef} className="eyebrow" style={{ marginTop: 6 }}>{t('mail.thread')}{email.commentCount ? ` · ${email.commentCount}` : ''}</div>
            <MailComments email={email} />
          </div>
        )}
        {email && conv?.canPost && (
          <div className="mail-composer">
            <div className="seg mail-seg" role="tablist">
              <button className={tab === 'comment' ? 'on' : ''} onClick={() => setTab('comment')}>💬 {t('mail.toTeam')}</button>
              {/* Un WhatsApp se responde en WhatsApp: el API da 400 a /reply (docs/CORREO.md). */}
              {mine && email.provider !== 'whatsapp' && <button className={tab === 'reply' ? 'on' : ''} onClick={() => setTab('reply')}>✉ {t('mail.replyTo', { name: who(other).split(' ')[0] || '…' })}</button>}
            </div>
            {tab === 'comment' || email.provider === 'whatsapp' ? <CommentBox email={email} autoFocus={!inline} /> : <ReplyBox email={email} onSent={inline ? () => setTab('comment') : onClose} />}
          </div>
        )}
      </aside>
  );
  return inline ? body : <div className="drawer-shade" onClick={onClose}>{body}</div>;
}

function MailComments({ email }: { email: SharedMailDTO }) {
  const d = useClient((s) => s.data)!;
  const [list, setList] = useState<SharedMailCommentDTO[] | null>(null);
  useEffect(() => { let live = true; client.mailComments(email.id).then((c) => live && setList(c)).catch(() => live && setList(email.lastComments)); return () => { live = false; }; }, [email.id, email.commentCount]);
  const person = (id: string) => personById(d, id);
  return (
    <div className="mail-comments">
      {email.comment && (
        <div className="mail-comment">
          <Avatar person={person(email.sharedBy)} org={null} size={26} />
          <div><div className="small"><b>{person(email.sharedBy)?.name.split(' ')[0]}</b> <span className="muted">{fmtDate(email.createdAt)}</span></div>{email.comment}</div>
        </div>
      )}
      {list === null && <div className="hint">{t('common.loading')}</div>}
      {list?.length === 0 && !email.comment && <div className="hint">{t('mail.noComments')}</div>}
      {list?.map((c) => (
        <div key={c.id} className="mail-comment">
          <Avatar person={person(c.authorId)} org={null} size={26} />
          <div><div className="small"><b>{c.authorId === d.me.id ? t('common.youShort') : person(c.authorId)?.name.split(' ')[0]}</b> <span className="muted">{fmtDate(c.createdAt)}</span></div>{c.body}</div>
        </div>
      ))}
    </div>
  );
}

function CommentBox({ email, autoFocus = true }: { email: SharedMailDTO; autoFocus?: boolean }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const body = text.trim(); if (!body || busy) return;
    setBusy(true);
    try { await client.commentMail(email.id, body); setText(''); } catch (e) { toast(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <>
      <textarea className="input" rows={2} autoFocus={autoFocus} value={text} placeholder={t('mail.commentTeamPh')} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
      <div className="row"><span className="small muted grow">{t('mail.teamOnly', { name: who(email.direction === 'out' ? email.to[0] : email.from).split(' ')[0] ?? '' })}</span><button className="btn small primary" disabled={!text.trim() || busy} onClick={() => void send()}>{t('comments.send')}</button></div>
    </>
  );
}

function ReplyBox({ email, onSent }: { email: SharedMailDTO; onSent: () => void }) {
  const d = useClient((s) => s.data)!;
  const conv = useClient((s) => s.conversations[email.conversationId]);
  const me = (email.accountEmail ?? '').toLowerCase();
  const to = email.direction === 'out' ? email.to : email.from ? [email.from] : [];
  const defaultCc = useMemo(() => [...email.to, ...email.cc].map((a) => a.email).filter((e, i, l) => e !== me && !to.some((x) => x.email === e) && l.indexOf(e) === i), [email.id]);
  const draftKey = `chaggu:mail-draft:${email.id}`;
  const [body, setBody] = useState(() => { try { return localStorage.getItem(draftKey) ?? ''; } catch { return ''; } });
  const [cc, setCc] = useState(defaultCc.join(', '));
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState<null | 'draft' | 'send'>(null);
  const [custom, setCustom] = useState(false);
  const [at, setAt] = useState('');
  useEffect(() => { try { body ? localStorage.setItem(draftKey, body) : localStorage.removeItem(draftKey); } catch {} }, [body]);
  // Adjuntos del chat (lo que el equipo subió al hilo): los últimos de los mensajes cargados.
  const files = useMemo(() => (conv?.messages ?? []).flatMap((m) => (m.attachments ?? []).filter((a) => a.kind !== 'voice').map((a) => ({ ...a, by: m.authorId }))).slice(-12).reverse(), [conv?.messages]);
  const ccList = cc.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
  const badCc = ccList.some((x) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
  const gg = async () => {
    setBusy('draft');
    try { const r = await client.draftMailReply(email.id); setBody(r.body); } catch (e) { toast(errorText(e)); } finally { setBusy(null); }
  };
  const send = async (sendAt?: Date) => {
    if (!body.trim() || busy || badCc) return;
    setBusy('send');
    try {
      await client.replyMail(email.id, { body: body.trim(), cc: ccList, attachmentIds: picked, sendAt: sendAt?.toISOString(), notifyChat: true });
      try { localStorage.removeItem(draftKey); } catch {}
      toast(sendAt ? t('mail.scheduledToast', { when: fmtWhen(sendAt.toISOString()) }) : t('mail.sentToast'));
      onSent();
    } catch (e) { toast(errorText(e)); } finally { setBusy(null); }
  };
  const scheduleMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenuAt(r.left - 160, r.top - 8, [
      ...quickTimes().filter((q) => q.key !== '20m').map((q) => ({ label: q.label, icon: '🕒', onSelect: () => void send(q.date) })),
      { divider: true }, { label: t('mail.pickTime'), icon: '📅', onSelect: () => setCustom(true) },
    ]);
  };
  return (
    <>
      <div className="small muted">{t('mail.meta.to')}: {to.map(who).join(', ')} · {t('mail.from')}: {email.accountEmail}</div>
      <label className="mail-cc small">CC <input className="input" value={cc} onChange={(e) => setCc(e.target.value)} placeholder={t('mail.ccPh')} /></label>
      {badCc && <div className="error small">{t('mail.badCc')}</div>}
      <textarea className="input mail-reply-text" rows={6} value={body} maxLength={20000} autoFocus placeholder={t('mail.replyPh')} onChange={(e) => setBody(e.target.value)} />
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        <button className="btn small" disabled={!!busy} onClick={() => void gg()}>{busy === 'draft' ? t('mail.ggWorking') : `✨ ${t('mail.gg')}`}</button>
        <span className="small muted">{email.commentCount ? t('mail.ggHint', { n: email.commentCount }) : t('mail.ggHintNone')}</span>
      </div>
      {!!files.length && (
        <details className="mail-attach-pick">
          <summary className="small">📎 {picked.length ? t('mail.attachN', { n: picked.length }) : t('mail.attachFromChat')}</summary>
          {files.map((a) => (
            <label key={a.id} className="check small">
              <input type="checkbox" checked={picked.includes(a.id)} onChange={(e) => setPicked((l) => (e.target.checked ? [...l, a.id].slice(0, 10) : l.filter((x) => x !== a.id)))} />
              <span className="grow ellipsis">{a.name} · {kb(a.sizeBytes ?? 0)} · {personById(d, a.by)?.name.split(' ')[0]}</span>
            </label>
          ))}
        </details>
      )}
      {custom && (
        <div className="row" style={{ gap: 6 }}>
          <input className="input" type="datetime-local" value={at} min={new Date(Date.now() + 60_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16)} onChange={(e) => setAt(e.target.value)} aria-label={t('mail.pickTime')} />
          <button className="btn small primary" disabled={!at || !body.trim() || !!busy} onClick={() => void send(new Date(at))}>{t('mail.schedule')}</button>
        </div>
      )}
      <div className="row">
        <span className="small muted grow">{t('mail.sentVia', { name: LABEL[email.provider] })}</span>
        <div className="split-btn">
          <button className="btn small primary" disabled={!body.trim() || !!busy || badCc} onClick={() => void send()}>{busy === 'send' ? t('mail.sending') : t('mail.send')}</button>
          <button className="btn small primary" disabled={!body.trim() || !!busy || badCc} aria-label={t('mail.scheduleMenu')} title={t('mail.scheduleMenu')} onClick={scheduleMenu}>▾</button>
        </div>
      </div>
    </>
  );
}

// ---------- Tarea desde el correo ----------
function MailTaskDialog({ email, onClose }: { email: SharedMailDTO; onClose: () => void }) {
  const d = useClient((s) => s.data)!;
  const conv = d.conversations.find((c) => c.id === email.conversationId);
  const [title, setTitle] = useState(email.direction === 'in' ? `${t('mail.taskPrefix')} ${who(email.from).split(' ')[0]}: ${email.subject.replace(/^\s*((re|rv|fw|fwd|aw)\s*:\s*)+/i, '')}`.slice(0, 200) : email.subject.slice(0, 200));
  const [owner, setOwner] = useState<string>(d.me.id);
  const [due, setDue] = useState('');
  const [close, setClose] = useState(true);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try { await client.mailTask(email.id, { title: title.trim(), ownerId: owner || null, dueDate: due || null, closeOnReply: close }); toast(t('mail.taskCreated')); onClose(); }
    catch (e) { toast(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={t('mail.taskTitle')} onClose={onClose}>
      <label className="field"><span>{t('mail.taskName')}</span><input className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} autoFocus /></label>
      <label className="field"><span>{t('mail.taskOwner')}</span>
        <select className="input" value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">{t('mail.taskNoOwner')}</option>
          {(conv?.memberIds ?? [d.me.id]).map((id) => <option key={id} value={id}>{personById(d, id)?.name ?? id}</option>)}
        </select>
      </label>
      <label className="field"><span>{t('mail.taskDue')}</span><input className="input" type="date" value={due} min={ymd(new Date())} onChange={(e) => setDue(e.target.value)} /></label>
      <label className="check"><input type="checkbox" checked={close} onChange={(e) => setClose(e.target.checked)} /> {t('mail.taskClose')}</label>
      <div className="hint">{t('mail.taskHint')}</div>
      <div className="modal-actions"><button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" disabled={busy || title.trim().length < 2} onClick={() => void create()}>{t('mail.taskCreate')}</button></div>
    </Modal>
  );
}

// ---------- WhatsApp ----------
export type WaShared = { accountId: string; jid: string; waMessageId: string; accountKind: 'personal' | 'business'; chatName: string | null; isGroup: boolean; author: string | null; fromMe: boolean; text: string; sentAt: string | null; comment?: string };
export function WaSharedRow({ m, p, onIssue, actions }: { m: MessageDTO; p: WaShared & { emailId?: string }; onIssue?: (id: string) => void; actions?: CardActions }) {
  const d = useClient((s) => s.data)!;
  const author = personById(d, m.authorId);
  return (
    <div id={`msg-${m.conversationId}-${m.seq}`} data-mid={m.id} className="msg card-msg" {...(actions?.menu ?? {})}>
      {actions && <CardHoverBar a={actions} />}
      <div><Avatar person={author} org={orgById(d, author?.orgId)} size={34} /></div>
      <div style={{ minWidth: 0 }}>
        <div className="msg-meta"><span className="msg-author">{author?.name ?? t('common.participant')}</span><span className="msg-time">{new Date(m.createdAt).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' })}</span></div>
        {p.comment && <div className="msg-body">{p.comment}</div>}
        {/* Desde la 040 el mensaje compartido tiene registro propio (hilo y tarea); los viejos se pintan del payload. */}
        {p.emailId ? <MailCard emailId={p.emailId} onIssue={onIssue} /> : (
          <div className="card mail-card wa-card">
            <div className="mail-card-top">
              <span className="src-ico wa"><WaIcon size={22} /></span>
              <div style={{ minWidth: 0 }}>
                <div className="mail-card-kind">WhatsApp{p.accountKind === 'business' ? ' Business' : ''}{p.chatName ? ` · ${p.isGroup ? `👥 ${t('wa.groupShort')}` : ''}${p.chatName}` : ''}</div>
                <div className="small muted">{p.fromMe ? t('common.youShort') : p.author ?? t('wa.someone')}{p.sentAt ? ` · ${fmtDate(p.sentAt)}` : ''}</div>
              </div>
            </div>
            <blockquote className="wa-quote">{p.text}</blockquote>
          </div>
        )}
      </div>
    </div>
  );
}

/** Llevar un mensaje de WhatsApp a uno o varios chats, igual que un correo. */
export function WaShareDialog({ accountId, jid, message, chatName, isGroup, onClose }: { accountId: string; jid: string; message: { id: string; body: string; author: string | null; fromMe: boolean; sentAt?: string }; chatName: string; isGroup?: boolean; onClose: () => void }) {
  const d = useClient((s) => s.data)!;
  const [picked, setPicked] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const share = async () => {
    if (!picked.length || busy) return;
    setBusy(true);
    try {
      await client.shareWhatsApp({ accountId, jid, messageId: message.id, conversationIds: picked, comment: comment.trim() || undefined });
      const first = picked[0]!;
      toast(picked.length > 1 ? t('mail.sharedMany', { n: picked.length }) : t('mail.shared'), { label: t('lin.open'), run: () => navigate(`/c/${first}`) });
      onClose();
    } catch (e) { toast(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={t('wa.bringTitle')} onClose={onClose}>
      <div className="xcard mini"><div className="xcard-top"><span className="src-ico wa"><WaIcon size={20} /></span><div style={{ minWidth: 0 }}><b className="ellipsis" style={{ display: 'block' }}>{isGroup ? '👥 ' : ''}{chatName}</b><span className="small muted">{message.fromMe ? t('common.youShort') : message.author ?? t('wa.someone')}{message.sentAt ? ` · ${fmtDate(message.sentAt)}` : ''}</span></div></div>
        <blockquote className="wa-quote">{message.body.slice(0, 400)}</blockquote></div>
      <ChatPicker picked={picked} setPicked={setPicked} />
      <textarea className="input" rows={2} maxLength={4000} placeholder={t('wa.commentPh')} value={comment} onChange={(e) => setComment(e.target.value)} />
      <WhoSees picked={picked} />
      <div className="modal-actions"><button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" disabled={!picked.length || busy} onClick={() => void share()}>{busy ? t('mail.sharing') : shareLabel(d, picked)}</button></div>
    </Modal>
  );
}

/** Hoy: invitación a conectar el correo. Solo si nadie está conectado; se cierra con ✕ y no vuelve. */
const NUDGE_KEY = 'chaggu:mail-nudge-off';
export function MailConnectNudge() {
  const on = useClient((s) => s.data?.features?.mail === true);
  const [off, setOff] = useState(() => { try { return localStorage.getItem(NUDGE_KEY) === '1'; } catch { return false; } });
  const [list, setList] = useState<MailConnectionDTO[] | null>(null);
  useEffect(() => { if (on && !off) client.mailConnections().then(setList).catch(() => {}); }, [on, off]);
  if (!on || off || !list || list.some((c) => c.status === 'active') || !list.some((c) => c.available)) return null;
  const close = () => { setOff(true); try { localStorage.setItem(NUDGE_KEY, '1'); } catch {} };
  return (
    <div className="card mail-nudge">
      <span className="row" style={{ gap: 4 }} aria-hidden><ProviderIcon provider="google" size={22} /><ProviderIcon provider="microsoft" size={22} /></span>
      <span className="grow" style={{ minWidth: 0 }}><b style={{ display: 'block' }}>{t('mail.nudgeTitle')}</b><span className="small muted">{t('mail.nudgeBody')}</span></span>
      <button className="btn small primary" onClick={() => navigate('/correo')}>{t('mail.connect')}</button>
      <button className="icon-btn" aria-label={t('common.close')} onClick={close}>×</button>
    </div>
  );
}

/** Cómo se cita la tarjeta de un correo o un WhatsApp compartido al responderla. */
export function cardQuote(m: { kind: string; body: string }): string | null {
  if (m.kind !== 'system') return null;
  try {
    const p = JSON.parse(m.body);
    if (p.k === 'mail.shared') return `✉ ${p.subject || t('mail.noSubject')}${p.from ? ` · ${p.from}` : ''}`;
    if (p.k === 'wa.shared') return `WhatsApp${p.chatName ? ` · ${p.chatName}` : ''}: ${p.text ?? ''}`;
  } catch {}
  return null;
}
