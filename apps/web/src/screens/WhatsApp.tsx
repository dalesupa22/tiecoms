import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WaAccountDTO, WaCategory, WaChatDTO, WaKind, WaMessageDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { errorText, locale, t } from '../i18n.ts';
import { copyText, menuProps, toast } from '../menu.tsx';
import { openDialog } from '../actions.tsx';
import { WaShareDialog } from './Mail.tsx';
import { navigate } from '../router.ts';
import { Modal, conversationTitle } from '../ui.tsx';
import { waKey } from '../panes-core.ts';
import { isOpenInPanes, openBeside, paneDragProps, setPaneMeta, splitAvailable, takePaneFocus, usePaneCtx, wantsPane } from '../split.ts';
import { WaIcon } from './Mail.tsx';

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
  /** Enviar por WhatsApp desde chaggu (docs/PANELES.md · docs/WHATSAPP.md): texto y, si hay, el mensaje citado. */
  send: (c: WaChatDTO, body: string, quotedId: string | null, clientId: string) =>
    client.request<WaMessageDTO>(`/whatsapp/chats/${c.accountId}/${encodeURIComponent(c.jid)}/messages`, { method: 'POST', json: { body, quotedId, clientId } }),
  organize: () => client.request<{ reviewed: number; changed: number }>('/whatsapp/organize', { method: 'POST', json: {} }),
};

function when(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
}

/** Un chat de WhatsApp en su propio panel (varios a la vez, fijables, con su compositor). */
export function openWaPane(c: WaChatDTO) {
  openBeside(waKey(c.accountId, c.jid), undefined, { meta: { title: c.name, sub: c.accountLabel, snap: c } });
}
const waMeta = (c: WaChatDTO) => ({ title: c.name, sub: c.accountLabel, snap: c });

export function WhatsAppScreen() {
  const inPane = !!usePaneCtx();
  const revision = useClient((s) => s.waRevision);
  const [accounts, setAccounts] = useState<WaAccountDTO[] | null>(null);
  const [max, setMax] = useState(5);
  const [connectOpen, setConnectOpen] = useState(false);
  const [chats, setChats] = useState<WaChatDTO[]>([]);
  const [counts, setCounts] = useState<Counts>({});
  const [accountId, setAccountId] = useState<string | 'all'>('all');
  const [category, setCategory] = useState<WaCategory | 'all'>('all');
  const [onlyGroups, setOnlyGroups] = useState(true);
  const [showHidden, setShowHidden] = useState(false);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<WaChatDTO | null>(null);

  const loadAccounts = useCallback(() => api.accounts().then((r) => { setAccounts(r.accounts); setMax(r.max); }).catch(() => {}), []);
  const loadChats = useCallback(() => api.chats({
    accountId: accountId === 'all' ? undefined : accountId,
    category: category === 'all' ? undefined : category,
    groups: onlyGroups ? '1' : undefined,
    hidden: showHidden ? '1' : undefined,
    q: q.trim() || undefined,
  }).then((r) => { setChats(r.chats); setCounts(r.categories); }).catch(() => {}), [accountId, category, onlyGroups, showHidden, q]);

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
  const total = Object.values(counts).reduce((n, c) => n + (c?.total ?? 0), 0);

  async function organize() {
    try { const r = await api.organize(); toast(t('wa.organized', { n: r.changed })); void loadChats(); } catch (e) { toast(errorText(e)); }
  }
  async function patch(c: WaChatDTO, p: Record<string, unknown>) {
    try {
      const up = await api.patchChat(c, p);
      setChats((list) => list.map((x) => (x.accountId === up.accountId && x.jid === up.jid ? up : x)));
      if (open && open.jid === up.jid && open.accountId === up.accountId) setOpen(up);
      void loadChats();
    } catch (e) { toast(errorText(e)); }
  }

  return (
    <div className="page"><div className="page-narrow">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <h1 className="grow">{t('wa.title')}</h1>
        {(accounts?.length ?? 0) < max && <button className="btn primary small" onClick={() => setConnectOpen(true)}>{t('wa.connect')}</button>}
      </div>
      {!inPane && <p className="muted" style={{ margin: '0 0 16px', maxWidth: 680 }}>{t('wa.intro')}</p>}

      {/* En un panel, las cuentas solo se muestran si alguna necesita atención (QR, reconexión). */}
      {(!inPane || !accounts?.length || accounts.some((a) => a.status !== 'connected')) && <div className="wa-accounts">
        {accounts?.map((a) => <AccountCard key={a.id} a={a} onChanged={loadAccounts} />)}
        {accounts && accounts.length === 0 && (
          <div className="card wa-empty">
            <div className="wa-empty-icons"><span>👤</span><span>🏪</span></div>
            <b>{t('wa.emptyTitle')}</b>
            <div className="small muted">{t('wa.emptyBody')}</div>
            <button className="btn primary" onClick={() => setConnectOpen(true)}>{t('wa.connect')}</button>
          </div>
        )}
      </div>}

      {(connected.length > 0 || total > 0) && (
        <>
          <div className="row" style={{ margin: '26px 0 10px', flexWrap: 'wrap' }}>
            <span className="eyebrow grow">{t('wa.organizer')}</span>
            <button className="btn small" onClick={organize} title={t('wa.reorganizeHint')}>✦ {t('wa.reorganize')}</button>
          </div>
          <div className="wa-cats" role="tablist">
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

          <div className={`wa-split ${open ? 'has-open' : ''}`}>
            <div className="list wa-list">
              {chats.length === 0 && <div className="empty">{connected.length ? t('wa.noChats') : t('wa.syncing')}</div>}
              {chats.map((c) => (
                <ChatRow key={`${c.accountId}|${c.jid}`} c={c} active={open?.jid === c.jid && open.accountId === c.accountId}
                  multi={(accounts?.length ?? 0) > 1} onOpen={(e) => { if (inPane || wantsPane(e)) openWaPane(c); else setOpen(c); }} onPatch={(p) => patch(c, p)} />
              ))}
            </div>
            {open && !inPane && <ChatPanel key={`${open.accountId}|${open.jid}`} c={open} revision={revision} onClose={() => setOpen(null)} onPatch={(p) => patch(open, p)} />}
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
        {a.status === 'connected' && <span className="muted"> · {t('wa.counts', { chats: a.chats, groups: a.groups })}</span>}
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

function ChatRow({ c, active, multi, onOpen, onPatch }: { c: WaChatDTO; active: boolean; multi: boolean; onOpen: (e: React.MouseEvent) => void; onPatch: (p: Record<string, unknown>) => void }) {
  const inPanes = isOpenInPanes(waKey(c.accountId, c.jid));
  return (
    <div className={`card wa-chat ${active || inPanes ? 'active' : ''} ${c.unread ? 'unread' : ''}`} {...paneDragProps(waKey(c.accountId, c.jid), waMeta(c))}>
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
          </span>
        </span>
        {c.unread > 0 && <span className="pill">{c.unread}</span>}
      </button>
      {splitAvailable() && <button className="icon-btn wa-panel-btn" title={t('split.inPanel')} aria-label={t('split.inPanel')} onClick={() => openWaPane(c)}>⊞</button>}
      <select className="wa-cat-select" value={c.category} onChange={(e) => onPatch({ category: e.target.value })} aria-label={t('wa.category')}
        title={c.categoryManual ? t('wa.manual') : t('wa.suggested')}>
        {CATEGORIES.map((k) => <option key={k} value={k}>{CAT_ICON[k]} {t(`wa.cat.${k}`)}</option>)}
      </select>
    </div>
  );
}

type LocalWa = WaMessageDTO & { pending?: boolean; failed?: string; quoted?: { author: string | null; body: string } | null; clientId?: string };

/** Un chat de WhatsApp como panel: carga el chat (o usa el que se arrastró) y lo muestra con su compositor. */
export function WaChatPane({ accountId, jid, snap, active }: { accountId: string; jid: string; snap?: WaChatDTO; active: boolean }) {
  const revision = useClient((s) => s.waRevision);
  const [c, setC] = useState<WaChatDTO | null>(snap ?? null);
  const [missing, setMissing] = useState(false);
  // Se vuelve a pedir con cada cambio de WhatsApp: así el panel sabe sus no leídos y el vínculo.
  useEffect(() => {
    let live = true;
    api.chats({ accountId, limit: '500', groups: undefined }).then((r) => {
      if (!live) return;
      const hit = r.chats.find((x) => x.jid === jid);
      if (hit) { setC(hit); setPaneMeta(waKey(accountId, jid), waMeta(hit)); } else if (!snap) setMissing(true);
    }).catch(() => { if (live && !snap) setMissing(true); });
    return () => { live = false; };
  }, [accountId, jid, revision]);
  const patch = async (p: Record<string, unknown>) => {
    if (!c) return;
    try { const up = await api.patchChat(c, p); setC(up); setPaneMeta(waKey(accountId, jid), waMeta(up)); } catch (e) { toast(errorText(e)); }
  };
  if (!c) return <div className="hint" style={{ padding: 16 }}>{missing ? t('wa.paneMissing') : t('common.loading')}</div>;
  return <ChatPanel c={c} revision={revision} onClose={() => {}} onPatch={(p) => void patch(p)} inPane active={active} />;
}

function ChatPanel({ c, revision, onClose, onPatch, inPane, active }: { c: WaChatDTO; revision: number; onClose: () => void; onPatch: (p: Record<string, unknown>) => void; inPane?: boolean; active?: boolean }) {
  const d = useClient((s) => s.data)!;
  const [messages, setMessages] = useState<LocalWa[] | null>(null);
  const [outbox, setOutbox] = useState<LocalWa[]>([]);
  const [quote, setQuote] = useState<LocalWa | null>(null);
  const [settings, setSettings] = useState(!inPane);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const mailOn = d.features?.mail === true;
  useEffect(() => { api.messages(c).then((r) => setMessages(r.messages)).catch(() => setMessages([])); }, [c.accountId, c.jid, revision]);
  // Lo enviado desde aquí sale de la bandeja local cuando el servidor ya lo trae en la lista.
  useEffect(() => { if (messages) setOutbox((o) => o.filter((x) => x.failed || !messages.some((m) => m.id === x.id))); }, [messages]);
  const shown = useMemo(() => { const have = new Set((messages ?? []).map((m) => m.id)); return [...(messages ?? []), ...outbox.filter((x) => !have.has(x.id))]; }, [messages, outbox]);
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [shown.length]);
  // Al enfocar el panel (clic o ⌘1…⌘8), el cursor va a su compositor: lo que escribes sale por este chat.
  useEffect(() => { if (inPane && active && takePaneFocus(waKey(c.accountId, c.jid))) requestAnimationFrame(() => input.current?.focus({ preventScroll: true })); }, [inPane, active]);
  const targets = useMemo(() => d.conversations.filter((x) => x.kind !== 'direct' && x.canPost !== false), [d]);
  const linked = c.linkedConversationId ? d.conversations.find((x) => x.id === c.linkedConversationId) : null;
  const send = async (body: string, again?: LocalWa) => {
    const clientId = again?.clientId ?? `wa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const local: LocalWa = again ? { ...again, failed: undefined, pending: true } : { id: clientId, clientId, fromMe: true, author: null, kind: 'text', body, sentAt: new Date().toISOString(), pending: true, quoted: quote ? { author: quote.fromMe ? t('common.youShort') : quote.author, body: quote.body } : null };
    const quotedId = again ? null : quote?.id ?? null;
    setOutbox((o) => [...o.filter((x) => x.id !== local.id), local]);
    setQuote(null);
    try {
      const sent = await api.send(c, body, quotedId, clientId);
      setOutbox((o) => o.map((x) => (x.id === local.id ? { ...sent, quoted: local.quoted } : x)));
      setMessages((m) => (m && !m.some((x) => x.id === sent.id) ? [...m, sent] : m));
    } catch (e) {
      const why = (e as { status?: number }).status === 404 ? t('wa.sendUnavailable') : errorText(e);
      setOutbox((o) => o.map((x) => (x.id === local.id ? { ...x, pending: false, failed: why } : x)));
    }
  };
  const name = c.name;
  return (
    <aside className={`card wa-panel ${inPane ? 'is-pane' : ''}`}>
      {!inPane && <div className="row" style={{ padding: '12px 14px', borderBottom: '1px solid var(--line)' }}>
        <b className="grow ellipsis">{c.name}</b>
        <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}>×</button>
      </div>}
      {inPane && linked && (
        <div className="wa-linked-bar small">
          <span className="grow ellipsis">⇄ {t('wa.linkedTo', { name: conversationTitle(d, linked) })}</span>
          <button className="link-btn small" onClick={() => openBeside(linked.id)}>{isOpenInPanes(linked.id) ? t('wa.seeLinked') : t('wa.openLinked')}</button>
        </div>
      )}
      {settings && <div className="row small muted" style={{ padding: '6px 14px', gap: 6, flexWrap: 'wrap', borderBottom: '1px solid var(--line)' }}>
        <span className="tag">{c.accountLabel}</span>{c.isGroup && c.participants ? <span>{t('wa.members', { n: c.participants })}</span> : null}
        <span className="grow" />
        <select className="wa-cat-select" value={c.category} onChange={(e) => onPatch({ category: e.target.value })} aria-label={t('wa.category')}>
          {CATEGORIES.map((k) => <option key={k} value={k}>{CAT_ICON[k]} {t(`wa.cat.${k}`)}</option>)}
        </select>
      </div>}
      {settings && c.description && <div className="small muted" style={{ padding: '8px 14px', borderBottom: '1px solid var(--line)', whiteSpace: 'pre-wrap' }}>{c.description.slice(0, 300)}</div>}
      <div className="wa-msgs" ref={box}>
        {messages === null && <div className="hint">{t('common.loading')}</div>}
        {messages?.length === 0 && !outbox.length && <div className="hint">{t('wa.noMessages')}</div>}
        {shown.map((m) => {
          const bring = () => openDialog((close) => <WaShareDialog accountId={c.accountId} jid={c.jid} chatName={c.name} isGroup={c.isGroup} message={m} onClose={close} />);
          const reply = () => { setQuote(m); input.current?.focus(); };
          return (
          <div key={m.id} className={`wa-msg ${m.fromMe ? 'me' : ''} ${m.pending ? 'is-pending' : ''} ${m.failed ? 'is-failed' : ''}`} {...menuProps(() => [
            ...(!m.pending && !m.failed ? [{ label: t('wa.reply'), icon: '↩', onSelect: reply }] : []),
            ...(mailOn ? [{ label: t('wa.bring'), icon: '⤴', onSelect: bring }] : []),
            { label: t('common.copy'), icon: '⧉', onSelect: () => void copyText(m.body).then(() => toast(t('common.copied'))) },
          ])}>
            {!m.fromMe && c.isGroup && <div className={m.author ? 'wa-author' : 'wa-author unknown'}>{m.author ?? t('wa.someone')}</div>}
            {m.quoted && <div className="wa-quoted"><b>{m.quoted.author ?? t('wa.someone')}</b> {m.quoted.body.slice(0, 140)}</div>}
            <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.body}</div>
            <div className="wa-time">{m.pending ? t('wa.sending') : new Date(m.sentAt).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
            {m.failed && <div className="wa-failed">{m.failed} <button className="link-btn small" onClick={() => void send(m.body, m)}>{t('wa.retry')}</button></div>}
            {!m.pending && !m.failed && <span className="wa-msg-acts">
              <button className="wa-bring" onClick={reply} title={t('wa.reply')} aria-label={t('wa.reply')}>↩</button>
              {mailOn && <button className="wa-bring" onClick={bring} title={t('wa.bring')}>⤴ {t('wa.bringShort')}</button>}
            </span>}
          </div>
          );
        })}
      </div>
      <WaComposer c={c} name={name} quote={quote} onClearQuote={() => setQuote(null)} inputRef={input} onSend={(b) => void send(b)} />
      {inPane && <button className="wa-settings-toggle small" aria-expanded={settings} onClick={() => setSettings((v) => !v)}>{settings ? `▾ ${t('wa.lessOptions')}` : `▸ ${t('wa.moreOptions')}`}</button>}
      {settings && <div className="wa-panel-foot">
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn small" onClick={() => onPatch({ pinned: !c.pinned })}>{c.pinned ? t('wa.unpin') : t('wa.pin')}</button>
          <button className="btn small" onClick={() => onPatch({ hidden: !c.hidden })}>{c.hidden ? t('wa.unhide') : t('wa.hide')}</button>
          {c.categoryManual && <button className="btn ghost small" onClick={() => onPatch({ category: null })}>{t('wa.resetCategory')}</button>}
        </div>
        <label className="field" style={{ marginTop: 10 }}>
          <span>{t('wa.linkTo')}</span>
          <select className="input" value={c.linkedConversationId ?? ''} onChange={(e) => onPatch({ linkedConversationId: e.target.value || null })}>
            <option value="">{t('wa.notLinked')}</option>
            {targets.map((x) => <option key={x.id} value={x.id}>{conversationTitle(d, x)}{d.workspaces.find((w) => w.id === x.workspaceId) ? ` · ${d.workspaces.find((w) => w.id === x.workspaceId)!.name}` : ''}</option>)}
          </select>
          <span className="hint">{linked ? <>{t('wa.linkedHint')} <a href="#" onClick={(e) => { e.preventDefault(); if (splitAvailable()) openBeside(linked.id); else navigate(`/c/${linked.id}`); }}>{conversationTitle(d, linked)}</a></> : t('wa.linkHint')}</span>
        </label>
      </div>}
    </aside>
  );
}

/**
 * Compositor de WhatsApp: verde y con el ícono, para que nunca se confunda con el de chaggu (docs/PANELES.md).
 * Enter envía por este chat; Shift+Enter hace un salto de línea. Cada panel tiene el suyo.
 */
function WaComposer({ c, name, quote, onClearQuote, inputRef, onSend }: { c: WaChatDTO; name: string; quote: LocalWa | null; onClearQuote: () => void; inputRef: React.RefObject<HTMLTextAreaElement | null>; onSend: (body: string) => void }) {
  const key = `chaggu:wa-draft:${c.accountId}:${c.jid}`;
  const [text, setText] = useState(() => { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } });
  useEffect(() => { try { if (text) localStorage.setItem(key, text); else localStorage.removeItem(key); } catch { /* */ } }, [text]);
  const go = () => { const b = text.trim(); if (!b) return; onSend(b); setText(''); if (inputRef.current) inputRef.current.style.height = 'auto'; };
  return (
    <div className="wa-composer">
      {quote && <div className="reply-bar wa-reply-bar"><span className="grow ellipsis"><b>↩ {quote.fromMe ? t('common.youShort') : quote.author ?? t('wa.someone')}</b> · {quote.body.slice(0, 100)}</span><button className="icon-btn" aria-label={t('reply.cancel')} onClick={onClearQuote}>×</button></div>}
      <div className="wa-composer-box">
        <span className="wa-composer-ico" aria-hidden><WaIcon size={18} /></span>
        <textarea ref={inputRef} rows={1} value={text} aria-label={t('wa.writeTo', { name })} placeholder={t('wa.writeTo', { name })}
          onChange={(e) => { setText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(140, e.target.scrollHeight)}px`; }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); go(); }
            else if (e.key === 'Escape' && quote) { e.preventDefault(); onClearQuote(); }
          }} enterKeyHint="send" />
        <button className="send wa-send" onClick={go} disabled={!text.trim()} aria-label={t('wa.send')} title={t('wa.send')}>➤</button>
      </div>
      <div className="wa-composer-hint">{t('wa.composerHint', { account: c.accountLabel })}</div>
    </div>
  );
}
