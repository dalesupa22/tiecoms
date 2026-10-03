import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WaAccountDTO, WaCategory, WaChatDTO, WaKind, WaMessageDTO } from '@tiecoms/contracts';
import { isWorkChat, setWorkOnly, useWorkOnly } from '../wa-work-only.ts';
import { client, useClient } from '../app-client.ts';
import { errorText, locale, t } from '../i18n.ts';
import { copyText, toast } from '../menu.tsx';
import { captureWaPrivacy, openWaDialog, openWaMenuAt, useWaPrivacy, waMenuProps, waPrivacySyncing } from '../wa-privacy-ui.tsx';
import { waPrivacyAffected } from '../wa-privacy.ts';
import { waMainListMenu } from './WaInbox.tsx';
import { WaShareDialog } from './Mail.tsx';
import { navigate } from '../router.ts';
import { Modal, conversationTitle } from '../ui.tsx';
import { setDrag } from '../grid-actions.ts';
import { GridSideButton, PinToGrid } from './Tray.tsx';

const CATEGORIES: WaCategory[] = ['trabajo', 'clientes', 'familia', 'amigos', 'comunidad', 'otros'];
const CAT_ICON: Record<WaCategory, string> = { trabajo: '💼', clientes: '🤝', familia: '🏠', amigos: '🍻', comunidad: '🏘', otros: '◌' };

type Counts = Partial<Record<WaCategory, { total: number; unread: number }>>;

const api = {
  accounts: () => client.request<{ accounts: WaAccountDTO[]; max: number }>('/whatsapp/accounts'),
  create: (label: string, kind: WaKind, pairPhone: string | null) => client.request<WaAccountDTO>('/whatsapp/accounts', { method: 'POST', json: { label, kind, pairPhone } }),
  relink: (id: string, pairPhone?: string | null) => client.request<WaAccountDTO>(`/whatsapp/accounts/${id}/relink`, { method: 'POST', json: { pairPhone: pairPhone ?? null } }),
  remove: (id: string) => client.request(`/whatsapp/accounts/${id}`, { method: 'DELETE' }),
  chats: (q: Record<string, string | undefined>) => {
    const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined) as [string, string][]);
    return client.request<{ chats: WaChatDTO[]; categories: Counts }>(`/whatsapp/chats?${p}`);
  },
  patchChat: (c: WaChatDTO, patch: Record<string, unknown>) =>
    client.request<WaChatDTO>(`/whatsapp/chats/${c.accountId}/${encodeURIComponent(c.jid)}`, { method: 'PATCH', json: patch }),
  messages: (c: WaChatDTO) => client.request<{ messages: WaMessageDTO[] }>(`/whatsapp/chats/${c.accountId}/${encodeURIComponent(c.jid)}/messages?limit=80`),
  organize: () => client.request<{ reviewed: number; changed: number }>('/whatsapp/organize', { method: 'POST', json: {} }),
};

/**
 * «Responder desde chaggu» por cuenta. Apagado por defecto (solo lectura): al encenderlo se avisa de lo que implica.
 * Lo usan la tarjeta de la cuenta y el panel de la cuadrícula. Devuelve true si cambió.
 */
export async function setWaSend(a: { id: string; label: string }, on: boolean): Promise<boolean> {
  if (on && !confirm(t('wa.sendConfirm', { name: a.label }))) return false;
  try {
    await client.request(`/whatsapp/accounts/${a.id}`, { method: 'PATCH', json: { sendEnabled: on } });
    toast(t(on ? 'wa.sendOnToast' : 'wa.sendOffToast'));
    return true;
  } catch (e) { toast(errorText(e)); return false; }
}

/** «Compartir con integraciones» (MCP: Claude, ChatGPT, Semillero…). El personal viene apagado (docs/MCP.md). */
export async function setWaIntegrations(a: { id: string; label: string }, on: boolean): Promise<boolean> {
  if (on && !confirm(t('wa.intConfirm', { name: a.label }))) return false;
  try {
    await client.request(`/whatsapp/accounts/${a.id}`, { method: 'PATCH', json: { integrationsEnabled: on } });
    toast(t(on ? 'wa.intOnToast' : 'wa.intOffToast'));
    return true;
  } catch (e) { toast(errorText(e)); return false; }
}

function when(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
}

export function WhatsAppScreen() {
  const revision = useClient((s) => s.waRevision);
  const [accounts, setAccounts] = useState<WaAccountDTO[] | null>(null);
  const [max, setMax] = useState(5);
  const [connectOpen, setConnectOpen] = useState(false);
  const [chats, setChats] = useState<WaChatDTO[]>([]);
  const [counts, setCounts] = useState<Counts>({});
  const [accountId, setAccountId] = useState<string | 'all'>('all');
  const [category, setCategory] = useState<WaCategory | 'all'>('all');
  const [onlyGroups, setOnlyGroups] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<WaChatDTO | null>(null);
  const chatGeneration = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; chatGeneration.current++; }; }, []);
  useWaPrivacy((event) => {
    chatGeneration.current++;
    setChats((old) => old.filter((c) => !waPrivacyAffected(event, c)));
    setOpen((old) => old && waPrivacyAffected(event, old) ? null : old);
    if (event.reset) setAccounts((old) => old?.map((a) => a.id === event.accountId ? { ...a, privacyReady: false, chats: 0, groups: 0 } : a) ?? null);
    setCounts({});
  });

  const loadAccounts = useCallback(() => {
    const valid = captureWaPrivacy();
    return api.accounts().then((r) => { if (alive.current && valid()) { setAccounts(r.accounts); setMax(r.max); } }).catch(() => {});
  }, []);
  const loadChats = useCallback(() => {
    const generation = ++chatGeneration.current;
    const valid = captureWaPrivacy(accountId === 'all' ? undefined : accountId);
    if (!valid()) return Promise.resolve();
    return api.chats({
    accountId: accountId === 'all' ? undefined : accountId,
    category: category === 'all' ? undefined : category,
    groups: onlyGroups ? '1' : undefined,
    hidden: showHidden ? '1' : undefined,
    q: q.trim() || undefined,
    }).then((r) => { if (alive.current && generation === chatGeneration.current && valid()) { setChats(r.chats.filter((c) => client.isWaChatVisible(c.accountId, c.jid))); setCounts(r.categories); } }).catch(() => {});
  }, [accountId, category, onlyGroups, showHidden, q]);

  useEffect(() => { void loadAccounts(); }, [loadAccounts, revision]);
  useEffect(() => { const h = setTimeout(() => void loadChats(), q ? 250 : 0); return () => clearTimeout(h); }, [loadChats, revision]);
  // Mientras hay un código en pantalla se pregunta seguido: el QR cambia cada ~20 s.
  const waiting = accounts?.some((a) => a.status === 'pending' || a.status === 'qr' || a.status === 'reconnecting');
  useEffect(() => {
    if (!waiting) return;
    const h = setInterval(() => void loadAccounts(), 3000);
    return () => clearInterval(h);
  }, [waiting, loadAccounts]);

  const connected = accounts?.filter((a) => a.status === 'connected') ?? [];
  const privacySyncing = accounts?.some((a) => (accountId === 'all' || accountId === a.id) && a.privacyReady === false) ?? false;
  const workOnly = useWorkOnly();
  const visibleChats = chats.filter((c) => client.isWaChatVisible(c.accountId, c.jid) && (!workOnly || isWorkChat(c)));
  const visibleOpen = open && client.isWaChatVisible(open.accountId, open.jid) ? open : null;
  const total = Object.values(counts).reduce((n, c) => n + (c?.total ?? 0), 0);

  async function organize() {
    try { const r = await api.organize(); toast(t('wa.organized', { n: r.changed })); void loadChats(); } catch (e) { toast(errorText(e)); }
  }
  /** Una fila cambió fuera de patch (p. ej. «Mover a mi lista principal»): se reemplaza en la lista y en el detalle. */
  const replace = (up: WaChatDTO) => {
    if (!client.isWaChatVisible(up.accountId, up.jid)) return;
    setChats((list) => list.map((x) => (x.accountId === up.accountId && x.jid === up.jid ? up : x)));
    setOpen((o) => (o && o.jid === up.jid && o.accountId === up.accountId ? up : o));
  };
  async function patch(c: WaChatDTO, p: Record<string, unknown>) {
    const valid = captureWaPrivacy(c.accountId, c.jid);
    if (!valid()) return;
    try {
      const up = await api.patchChat(c, p);
      if (!alive.current || !valid()) return;
      setChats((list) => list.map((x) => (x.accountId === up.accountId && x.jid === up.jid ? up : x)));
      if (open && open.jid === up.jid && open.accountId === up.accountId) setOpen(up);
      void loadChats();
    } catch (e) { if (alive.current && valid()) toast(errorText(e)); }
  }

  return (
    <div className="page"><div className="page-narrow">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <h1 className="grow">{t('wa.title')}</h1>
        <PinToGrid payload={{ kind: 'section', section: 'wachats' }} name="WhatsApp" />
        <GridSideButton />
        {(accounts?.length ?? 0) < max && <button className="btn primary small" onClick={() => setConnectOpen(true)}>{t('wa.connect')}</button>}
      </div>
      <p className="muted" style={{ margin: '0 0 16px', maxWidth: 680 }}>{t('wa.intro')}</p>
      <WaDrafts revision={revision} />

      <div className="wa-accounts">
        {accounts?.map((a) => <AccountCard key={a.id} a={a} onChanged={loadAccounts} />)}
        {accounts && accounts.length === 0 && (
          <div className="card wa-empty">
            <div className="wa-empty-icons"><span>👤</span><span>🏪</span></div>
            <b>{t('wa.emptyTitle')}</b>
            <div className="small muted">{t('wa.emptyBody')}</div>
            <button className="btn primary" onClick={() => setConnectOpen(true)}>{t('wa.connect')}</button>
          </div>
        )}
      </div>

      {(connected.length > 0 || total > 0) && (
        <>
          <div className="row" style={{ margin: '26px 0 10px', flexWrap: 'wrap' }}>
            <span className="eyebrow grow">{t('wa.organizer')}</span>
            <button className="btn small" onClick={organize} title={t('wa.reorganizeHint')}>✦ {t('wa.reorganize')}</button>
          </div>
          <div className="wa-cats" role="tablist">
            <button className={`wa-work-only ${workOnly ? 'on' : ''}`} aria-pressed={workOnly} title={t('wa.workOnlyHint')} onClick={() => setWorkOnly(!workOnly)}>{t('wa.workOnly')} <span className="muted">{(counts.trabajo?.total ?? 0) + (counts.clientes?.total ?? 0)}</span></button>
            <button className={category === 'all' ? 'on' : ''} onClick={() => setCategory('all')}>{t('wa.cat.all')} <span className="muted">{total}</span></button>
            {CATEGORIES.map((c) => (
              <button key={c} className={category === c ? 'on' : ''} onClick={() => setCategory(c)}>
                {CAT_ICON[c]} {t(`wa.cat.${c}`)} <span className="muted">{counts[c]?.total ?? 0}</span>
                {(counts[c]?.unread ?? 0) > 0 && <span className="pill">{counts[c]!.unread}</span>}
              </button>
            ))}
          </div>
          <div className="row wa-toolbar" style={{ margin: '10px 0 12px', flexWrap: 'wrap' }}>
            <input className="input grow" style={{ minWidth: 180 }} placeholder={t('wa.search')} value={q} onChange={(e) => setQ(e.target.value)} />
            {(accounts?.length ?? 0) > 1 && (
              <select className="input" style={{ width: 'auto' }} value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label={t('wa.account')}>
                <option value="all">{t('wa.allAccounts')}</option>
                {accounts!.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            )}
            <div className="seg" style={{ minWidth: 220 }}>
              <button className={onlyGroups ? 'on' : ''} onClick={() => setOnlyGroups(true)}>{t('wa.groups')}</button>
              <button className={!onlyGroups ? 'on' : ''} onClick={() => setOnlyGroups(false)}>{t('wa.allChats')}</button>
            </div>
            <label className="row small muted" style={{ gap: 6 }}><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />{t('wa.showHidden')}</label>
          </div>

          {privacySyncing && <div className="hint" role="status">{waPrivacySyncing()}</div>}
          <div className={`wa-split ${visibleOpen ? 'has-open' : ''}`}>
            <div className="list wa-list">
              {visibleChats.length === 0 && !privacySyncing && <div className="empty">{connected.length ? t('wa.noChats') : t('wa.syncing')}</div>}
              {visibleChats.map((c) => (
                <ChatRow key={`${c.accountId}|${c.jid}`} c={c} active={visibleOpen?.jid === c.jid && visibleOpen.accountId === c.accountId}
                  multi={(accounts?.length ?? 0) > 1} onOpen={() => { if (client.isWaChatVisible(c.accountId, c.jid)) setOpen(c); }} onPatch={(p) => patch(c, p)} onChanged={replace} />
              ))}
            </div>
            {visibleOpen && <ChatPanel key={`${visibleOpen.accountId}|${visibleOpen.jid}`} c={visibleOpen} revision={revision} onClose={() => setOpen(null)} onPatch={(p) => patch(visibleOpen, p)} onChanged={replace} />}
          </div>
        </>
      )}
      {connectOpen && <ConnectDialog existing={accounts ?? []} onClose={() => setConnectOpen(false)} onDone={() => { setConnectOpen(false); void loadAccounts(); }} />}
    </div></div>
  );
}

function AccountCard({ a, onChanged }: { a: WaAccountDTO; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [phone, setPhone] = useState('');
  const [usePhone, setUsePhone] = useState(false);
  const business = a.kind === 'business' || a.platform?.startsWith('smb');
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try { await fn(); onChanged(); } catch (e) { toast(errorText(e)); } finally { setBusy(false); }
  }
  const statusText = t(`wa.status.${a.status}`);
  return (
    <div className={`card wa-account is-${a.status}`}>
      <div className="row">
        <span className="wa-logo" aria-hidden>{business ? '🏪' : '👤'}</span>
        <span className="grow" style={{ minWidth: 0 }}>
          <b>{a.label}</b> <span className="tag">{business ? 'WhatsApp Business' : 'WhatsApp'}</span>
          <span className="small muted ellipsis" style={{ display: 'block' }}>
            {a.phone ? `+${a.phone}` : ''}{a.pushName ? ` · ${a.pushName}` : ''}
          </span>
        </span>
        <span className={`wa-dot is-${a.status}`} title={statusText} />
      </div>
      <div className="small" style={{ marginTop: 8 }}>
        <b>{statusText}</b>
        {a.privacyReady === false ? <span className="muted"> · {waPrivacySyncing()}</span> : a.status === 'connected' && <span className="muted"> · {t('wa.counts', { chats: a.chats, groups: a.groups })}</span>}
        {a.lastError && a.status !== 'connected' && a.status !== 'qr' && <span className="muted"> · {a.lastError}</span>}
      </div>

      {a.status === 'pending' && <div className="hint" style={{ marginTop: 8 }}>{t('wa.preparing')}</div>}
      {a.status === 'qr' && (
        <div className="wa-qr">
          {a.pairingCode ? (
            <div className="wa-code" aria-label={t('wa.pairingCode')}>{a.pairingCode.replace(/(.{4})/, '$1-')}</div>
          ) : a.qr ? <img src={a.qr} alt={t('wa.qrAlt')} width={220} height={220} /> : null}
          <ol className="small">
            <li>{t(business ? 'wa.step1b' : 'wa.step1')}</li>
            <li>{t('wa.step2')}</li>
            <li>{t(a.pairingCode ? 'wa.step3code' : 'wa.step3')}</li>
          </ol>
        </div>
      )}
      {(a.status === 'expired' || a.status === 'logged_out' || a.status === 'error') && (
        <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
          {usePhone && <input className="input" inputMode="tel" placeholder={t('wa.phonePh')} value={phone} onChange={(e) => setPhone(e.target.value)} />}
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="btn primary small" disabled={busy} onClick={() => run(() => api.relink(a.id, usePhone ? phone : null))}>{t('wa.newCode')}</button>
            <button className="btn ghost small" onClick={() => setUsePhone(!usePhone)}>{usePhone ? t('wa.useQr') : t('wa.usePhone')}</button>
          </div>
        </div>
      )}
      {a.status === 'connected' && (
        <label className="wa-send-opt">
          <input type="checkbox" checked={a.sendEnabled} disabled={busy} onChange={(e) => void run(() => setWaSend(a, e.target.checked))} />
          <span><b>{t('wa.sendOpt')}</b><span className="small muted" style={{ display: 'block' }}>{t('wa.sendHint')}</span></span>
        </label>
      )}
      <label className="wa-send-opt">
        <input type="checkbox" checked={!!a.integrationsEnabled} disabled={busy} onChange={(e) => void run(() => setWaIntegrations(a, e.target.checked))} />
        <span><b>{t('wa.intOpt')}</b><span className="small muted" style={{ display: 'block' }}>{t('wa.intHint')}</span></span>
      </label>
      <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
        <button className="btn ghost small" disabled={busy} onClick={() => { if (confirm(t('wa.disconnectConfirm', { label: a.label }))) void run(() => api.remove(a.id)); }}>{t('wa.disconnect')}</button>
      </div>
    </div>
  );
}

function ConnectDialog({ existing, onClose, onDone }: { existing: WaAccountDTO[]; onClose: () => void; onDone: () => void }) {
  const hasPersonal = existing.some((a) => a.kind === 'personal');
  const [kind, setKind] = useState<WaKind>(hasPersonal ? 'business' : 'personal');
  const [label, setLabel] = useState('');
  const [usePhone, setUsePhone] = useState(navigator.userAgent.includes('Mobile'));
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fallback = kind === 'business' ? 'Business' : t('wa.personal');
  async function submit() {
    setBusy(true); setError(null);
    try { await api.create(label.trim() || fallback, kind, usePhone && phone.trim() ? phone : null); toast(t('wa.linking')); onDone(); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title={t('wa.connectTitle')} onClose={onClose}>
      <p className="muted" style={{ margin: 0 }}>{t('wa.connectBody')}</p>
      <div className="wa-kinds">
        {(['personal', 'business'] as const).map((k) => (
          <button key={k} className={`card ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>
            <span style={{ fontSize: 26 }}>{k === 'business' ? '🏪' : '👤'}</span>
            <b>{k === 'business' ? 'WhatsApp Business' : 'WhatsApp'}</b>
            <span className="small muted">{t(`wa.kind.${k}`)}</span>
          </button>
        ))}
      </div>
      <label className="field"><span>{t('wa.label')}</span><input className="input" maxLength={60} placeholder={fallback} value={label} onChange={(e) => setLabel(e.target.value)} /></label>
      <div className="seg">
        <button className={!usePhone ? 'on' : ''} onClick={() => setUsePhone(false)}>{t('wa.withQr')}</button>
        <button className={usePhone ? 'on' : ''} onClick={() => setUsePhone(true)}>{t('wa.withPhone')}</button>
      </div>
      {usePhone && (
        <label className="field"><span>{t('wa.phone')}</span>
          <input className="input" inputMode="tel" autoComplete="tel" placeholder={t('wa.phonePh')} value={phone} onChange={(e) => setPhone(e.target.value)} />
          <span className="hint">{t('wa.phoneHint')}</span>
        </label>
      )}
      <div className="hint">🔒 {t('wa.privacy')}</div>
      {error && <div className="error">{error}</div>}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={busy || (usePhone && phone.replace(/\D/g, '').length < 8)} onClick={submit}>{t('wa.start')}</button>
      </div>
    </Modal>
  );
}

function ChatRow({ c, active, multi, onOpen, onPatch, onChanged }: { c: WaChatDTO; active: boolean; multi: boolean; onOpen: () => void; onPatch: (p: Record<string, unknown>) => void; onChanged: (c: WaChatDTO) => void }) {
  // Clic derecho o pulsación larga: «Mover a mi lista principal», «📌 Fijar arriba» o «Sacar de mi lista principal».
  return (
    <div className={`card wa-chat ${active ? 'active' : ''} ${c.unread ? 'unread' : ''}`} draggable {...waMenuProps(c, () => waMainListMenu(c, onChanged))}
      onDragStart={(e) => setDrag(e, 'wa', { accountId: c.accountId, jid: c.jid, name: c.name, isGroup: c.isGroup }, c.name)}>
      <button className="wa-chat-main" onClick={onOpen}>
        <span className="wa-av" aria-hidden>{c.isGroup ? '👥' : CAT_ICON[c.category]}</span>
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="row" style={{ gap: 6 }}>
            <b className="ellipsis grow">{c.pinned ? '📌 ' : ''}{c.name}</b>
            <span className="small muted">{when(c.lastMessageAt)}</span>
          </span>
          <span className="small muted ellipsis" style={{ display: 'block' }}>{c.lastPreview ?? (c.isGroup && c.participants ? t('wa.members', { n: c.participants }) : '')}</span>
          <span className="row" style={{ gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            {multi && <span className="tag">{c.accountLabel}</span>}
            {c.isGroup && c.participants ? <span className="tag">{t('wa.members', { n: c.participants })}</span> : null}
            {c.linkedConversationId && <span className="tag wa-linked">⇄ chaggu</span>}
            {c.inboxPlace && <span className="tag wa-linked">{c.inboxPinnedAt ? '📌 ' : '⤴ '}{c.inboxPlace === 'groups' ? t('nav.groups') : t('nav.dms')}</span>}
          </span>
        </span>
        {c.unread > 0 && <span className="pill">{c.unread}</span>}
      </button>
      <PinToGrid payload={{ kind: 'wa', accountId: c.accountId, jid: c.jid, name: c.name, isGroup: c.isGroup }} name={c.name} />
      <button className="icon-btn" aria-label={t('menu.open')} title={t('wa.moveToInbox')} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openWaMenuAt(c, r.left, r.bottom + 4, waMainListMenu(c, onChanged)); }}>⋯</button>
      <select className="wa-cat-select" value={c.category} onChange={(e) => onPatch({ category: e.target.value })} aria-label={t('wa.category')}
        title={c.categoryManual ? t('wa.manual') : t('wa.suggested')}>
        {CATEGORIES.map((k) => <option key={k} value={k}>{CAT_ICON[k]} {t(`wa.cat.${k}`)}</option>)}
      </select>
    </div>
  );
}

function ChatPanel({ c, revision, onClose, onPatch, onChanged }: { c: WaChatDTO; revision: number; onClose: () => void; onPatch: (p: Record<string, unknown>) => void; onChanged: (c: WaChatDTO) => void }) {
  const d = useClient((s) => s.data)!;
  const [messages, setMessages] = useState<WaMessageDTO[] | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const mailOn = d.features?.mail === true;
  const visible = useWaPrivacy(() => { setMessages(null); onClose(); }, c);
  useEffect(() => {
    let live = true; const valid = captureWaPrivacy(c.accountId, c.jid);
    if (valid()) api.messages(c).then((r) => { if (live && valid()) setMessages(r.messages); }).catch(() => { if (live && valid()) setMessages([]); });
    return () => { live = false; };
  }, [c.accountId, c.jid, revision]);
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [messages]);
  const targets = useMemo(() => d.conversations.filter((x) => x.kind !== 'direct' && x.canPost !== false), [d]);
  const linked = c.linkedConversationId ? d.conversations.find((x) => x.id === c.linkedConversationId) : null;
  if (!visible) return null;
  return (
    <aside className="card wa-panel">
      <div className="row" style={{ padding: '12px 14px', borderBottom: '1px solid var(--line)' }}>
        <b className="grow ellipsis">{c.name}</b>
        <button className="icon-btn" aria-label={t('wa.openFull')} title={t('wa.openFull')} onClick={() => navigate(`/whatsapp/${c.accountId}/${encodeURIComponent(c.jid)}`)}>⤢</button>
        <PinToGrid payload={{ kind: 'wa', accountId: c.accountId, jid: c.jid, name: c.name, isGroup: c.isGroup }} name={c.name} />
        <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}>×</button>
      </div>
      <div className="row small muted" style={{ padding: '6px 14px', gap: 6, flexWrap: 'wrap', borderBottom: '1px solid var(--line)' }}>
        <span className="tag">{c.accountLabel}</span>{c.isGroup && c.participants ? <span>{t('wa.members', { n: c.participants })}</span> : null}
        <span className="grow" />
        <select className="wa-cat-select" value={c.category} onChange={(e) => onPatch({ category: e.target.value })} aria-label={t('wa.category')}>
          {CATEGORIES.map((k) => <option key={k} value={k}>{CAT_ICON[k]} {t(`wa.cat.${k}`)}</option>)}
        </select>
      </div>
      {c.description && <div className="small muted" style={{ padding: '8px 14px', borderBottom: '1px solid var(--line)', whiteSpace: 'pre-wrap' }}>{c.description.slice(0, 300)}</div>}
      <div className="wa-msgs" ref={box}>
        {messages === null && <div className="hint">{t('common.loading')}</div>}
        {messages?.length === 0 && <div className="hint">{t('wa.noMessages')}</div>}
        {messages?.map((m) => {
          const bring = () => openWaDialog(c, (close) => <WaShareDialog accountId={c.accountId} jid={c.jid} chatName={c.name} isGroup={c.isGroup} message={m} onClose={close} />);
          return (
          <div key={m.id} className={`wa-msg ${m.fromMe ? 'me' : ''}`} {...(mailOn ? waMenuProps(c, () => [
            { label: t('wa.bring'), icon: '⤴', onSelect: bring },
            { label: t('common.copy'), icon: '⧉', onSelect: () => void copyText(m.body).then(() => toast(t('common.copied'))) },
          ]) : {})}>
            {!m.fromMe && c.isGroup && <div className={m.author ? 'wa-author' : 'wa-author unknown'}>{m.author ?? t('wa.someone')}</div>}
            <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.body}</div>
            <div className="wa-time">{new Date(m.sentAt).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
            {mailOn && <button className="wa-bring" onClick={bring} title={t('wa.bring')}>⤴ {t('wa.bringShort')}</button>}
            {mailOn && <span className="wa-grab" draggable title={t('grid.carryMsgHint')} aria-label={t('grid.carryMsgHint')}
              onDragStart={(e) => { setDrag(e, 'wamsg', { accountId: c.accountId, jid: c.jid, messageId: m.id, chatName: c.name, text: m.body }, m.body.slice(0, 80)); const row = (e.currentTarget as HTMLElement).closest('.wa-msg'); if (row) e.dataTransfer.setDragImage(row, 12, 12); }}
              onClick={bring}>⠿</span>}
          </div>
          );
        })}
      </div>
      <div className="wa-panel-foot">
        {/* Bandeja de chaggu: mover a Grupos/DMs, fijar arriba o sacar (no es el fijado dentro de WhatsApp). */}
        <div className="row" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
          {waMainListMenu(c, onChanged).map((it) => (
            <button key={it.label} className={`btn small ${it.danger ? 'ghost' : ''}`}
              onClick={(e) => { if (it.items) { const r = e.currentTarget.getBoundingClientRect(); openWaMenuAt(c, r.left, r.bottom + 4, it.items); } else it.onSelect?.(); }}>
              {it.icon && !it.label?.startsWith('📌') ? `${it.icon} ` : ''}{it.label}{it.items ? ' ▾' : ''}
            </button>
          ))}
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn small" onClick={() => onPatch({ pinned: !c.pinned })}>{c.pinned ? t('wa.unpin') : t('wa.pin')}</button>
          <button className="btn small" onClick={() => onPatch({ hidden: !c.hidden })}>{c.hidden ? t('wa.unhide') : t('wa.hide')}</button>
          <button className="btn small" title={t('wa.shareChatHint')} onClick={() => onPatch({ integrationsShared: !c.integrationsShared })}>{c.integrationsShared ? t('wa.unshareChat') : t('wa.shareChat')}</button>
          {c.categoryManual && <button className="btn ghost small" onClick={() => onPatch({ category: null })}>{t('wa.resetCategory')}</button>}
        </div>
        <label className="field" style={{ marginTop: 10 }}>
          <span>{t('wa.linkTo')}</span>
          <select className="input" value={c.linkedConversationId ?? ''} onChange={(e) => onPatch({ linkedConversationId: e.target.value || null })}>
            <option value="">{t('wa.notLinked')}</option>
            {targets.map((x) => <option key={x.id} value={x.id}>{conversationTitle(d, x)}{d.workspaces.find((w) => w.id === x.workspaceId) ? ` · ${d.workspaces.find((w) => w.id === x.workspaceId)!.name}` : ''}</option>)}
          </select>
          <span className="hint">{linked ? <>{t('wa.linkedHint')} <a href="#" onClick={(e) => { e.preventDefault(); navigate(`/c/${linked.id}`); }}>{conversationTitle(d, linked)}</a></> : t('wa.linkHint')}</span>
        </label>
      </div>
    </aside>
  );
}

/**
 * «Por enviar»: WhatsApp que dejó una integración (Semillero, ChatGPT…) con create_whatsapp_draft. Nada sale sin que la
 * persona toque Enviar; puede editar el texto o descartarlo. La integración recibe el resultado por su webhook.
 */
function WaDrafts({ revision }: { revision: number }) {
  const [drafts, setDrafts] = useState<Awaited<ReturnType<typeof client.waDrafts>>['drafts']>([]);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => client.waDrafts().then((r) => setDrafts(r.drafts)).catch(() => {}), []);
  useEffect(() => { void load(); }, [load, revision]);
  if (!drafts.length) return null;
  async function act(id: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(id);
    try { await fn(); toast(ok); await load(); } catch (e) { toast(errorText(e)); } finally { setBusy(null); }
  }
  return (
    <div className="card wa-drafts">
      <div className="row"><b className="grow">{t('wa.drafts', { n: drafts.length })}</b>
        {drafts.length > 1 && <button className="btn ghost small" disabled={!!busy} onClick={() => { if (confirm(t('wa.draftsDiscardAll'))) void Promise.all(drafts.map((d) => client.discardWaDraft(d.id))).then(load); }}>{t('wa.draftDiscardAll')}</button>}
      </div>
      <div className="small muted">{t('wa.draftsHint')}</div>
      {drafts.map((d) => (
        <div key={d.id} className="wa-draft">
          <div className="small"><b>{d.to ?? '—'}</b> <span className="muted">· {d.account}{d.source ? ` · ${t('wa.draftFrom', { app: d.source })}` : ''}</span></div>
          <textarea className="input" value={edit[d.id] ?? d.text} onChange={(e) => setEdit({ ...edit, [d.id]: e.target.value })} />
          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary small" disabled={busy === d.id || !(edit[d.id] ?? d.text).trim()} onClick={() => void act(d.id, () => client.sendWaDraft(d.id, edit[d.id] !== undefined && edit[d.id] !== d.text ? edit[d.id] : undefined), t('wa.draftSent'))}>{t('wa.draftSend')}</button>
            <button className="btn ghost small" disabled={busy === d.id} onClick={() => void act(d.id, () => client.discardWaDraft(d.id), t('wa.draftDiscarded'))}>{t('wa.draftDiscard')}</button>
          </div>
        </div>
      ))}
    </div>
  );
}
