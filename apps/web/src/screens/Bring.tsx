import { useEffect, useMemo, useState } from 'react';
import type { ForwardSource, ReminderDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { errorText, locale, t } from '../i18n.ts';
import { toast } from '../menu.tsx';
import { navigate, queryParam } from '../router.ts';
import { Modal, conversationTitle } from '../ui.tsx';

// ---------- WhatsApp: «[24/9/26, 10:12] Juan: texto» o «24/9/26 10:12 - Juan: texto» ----------
const WA_LINE = /^‎?\[?(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?\s?m\.?)?)\]?\s*(?:-\s*)?([^:]{1,60}):\s([\s\S]*)$/i;
export interface ParsedLine { author: string; sentAt: string; body: string }

export function parseWhatsApp(text: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const m = raw.match(WA_LINE);
    if (m) out.push({ sentAt: `${m[1]} ${m[2]}`, author: m[3]!.trim(), body: m[4]!.trim() });
    else if (out.length && raw.trim()) out[out.length - 1]!.body += `\n${raw}`;
  }
  return out.filter((l) => l.body && !/^<(Multimedia omitido|Media omitted)>$/i.test(l.body));
}

/** Correo pegado: toma De/From y Asunto/Subject si vienen al inicio. */
function parseEmail(text: string) {
  const from = text.match(/^(?:De|From):\s*(.+)$/im)?.[1]?.trim() ?? null;
  const subject = text.match(/^(?:Asunto|Subject):\s*(.+)$/im)?.[1]?.trim() ?? null;
  return { from, subject };
}

const SOURCES: ForwardSource[] = ['whatsapp', 'slack', 'email', 'teams', 'other'];

export function BringDialog({ conversationId, initialText = '', initialSource = 'whatsapp', onClose, onDone }: {
  conversationId: string; initialText?: string; initialSource?: ForwardSource; onClose: () => void; onDone?: () => void;
}) {
  const [source, setSource] = useState<ForwardSource>(initialSource);
  const [text, setText] = useState(initialText);
  const [author, setAuthor] = useState('');
  const [split, setSplit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = useMemo(() => (source === 'whatsapp' ? parseWhatsApp(text) : []), [source, text]);
  const mail = source === 'email' ? parseEmail(text) : null;

  async function submit() {
    setBusy(true); setError(null);
    try {
      if (parsed.length > 1 && split) {
        for (const l of parsed) await client.send(conversationId, l.body, null, { source, author: l.author, sentAt: l.sentAt });
      } else {
        const who = author || parsed[0]?.author || mail?.from || null;
        await client.send(conversationId, text.trim(), null, { source, author: who, sentAt: parsed[0]?.sentAt ?? null });
      }
      toast(t('toast.sent'));
      onDone?.();
      onClose();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title={t('imp.title')} onClose={onClose}>
      <p className="muted" style={{ margin: 0 }}>{t('imp.body')}</p>
      <div className="seg" role="radiogroup" aria-label={t('imp.source')}>
        {SOURCES.map((s) => <button key={s} className={source === s ? 'on' : ''} onClick={() => setSource(s)}>{t(`src.${s}`)}</button>)}
      </div>
      <textarea className="input" rows={8} placeholder={t('imp.paste')} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      {parsed.length > 1 && (
        <div className="card" style={{ padding: 10 }}>
          <b className="small">{t('imp.detected', { n: parsed.length })}</b>
          <div className="seg" style={{ marginTop: 8 }}>
            <button className={split ? 'on' : ''} onClick={() => setSplit(true)}>{t('imp.asMany', { n: parsed.length })}</button>
            <button className={!split ? 'on' : ''} onClick={() => setSplit(false)}>{t('imp.asOne')}</button>
          </div>
        </div>
      )}
      {mail?.subject && <div className="hint">{t('imp.subject', { s: mail.subject })}</div>}
      {!(parsed.length > 1 && split) && (
        <label className="field"><span>{t('imp.author')}</span><input className="input" maxLength={120} value={author} placeholder={parsed[0]?.author ?? mail?.from ?? ''} onChange={(e) => setAuthor(e.target.value)} /></label>
      )}
      {error && <div className="error">{error}</div>}
      <div className="modal-actions"><button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" disabled={busy || !text.trim()} onClick={submit}>{t('imp.send')}</button></div>
    </Modal>
  );
}

/** Destino de «Compartir» del sistema (PWA en Android): /share?text=… */
export function ShareScreen() {
  const d = useClient((s) => s.data)!;
  const shared = [queryParam('title'), queryParam('text'), queryParam('url')].filter(Boolean).join('\n').trim();
  const [target, setTarget] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const list = d.conversations.filter((c) => c.canPost && (!q || conversationTitle(d, c).toLowerCase().includes(q.toLowerCase())));
  if (target) return <BringDialog conversationId={target} initialText={shared} onClose={() => setTarget(null)} onDone={() => navigate(`/c/${target}`, true)} />;
  return (
    <div className="page"><div className="page-narrow" style={{ maxWidth: 640 }}>
      <h1>{t('share.title')}</h1>
      <div className="muted">{t('share.body')}</div>
      {shared ? <blockquote className="derive-quote" style={{ margin: '14px 0' }}>{shared.slice(0, 400)}</blockquote> : <div className="empty">{t('share.empty')}</div>}
      <input className="input" placeholder={t('fwd.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="list" style={{ marginTop: 10 }}>
        {list.map((c) => <button key={c.id} className="card conv-card" onClick={() => setTarget(c.id)}><b className="grow ellipsis">{conversationTitle(d, c)}</b><span className="muted">›</span></button>)}
      </div>
    </div></div>
  );
}

// ---------- Recordatorios en Hoy ----------
function ReminderRow({ r }: { r: ReminderDTO }) {
  const d = useClient((s) => s.data)!;
  const conv = d.conversations.find((c) => c.id === r.conversationId);
  const due = Date.parse(r.remindAt) <= Date.now();
  const act = (p: Promise<unknown>) => p.catch((e) => toast(errorText(e)));
  return (
    <div className={`card reminder-row ${due ? 'is-due' : ''}`}>
      <span className="rem-ico">⏰</span>
      <button className="grow" style={{ minWidth: 0, textAlign: 'left', border: 0, background: 'none', padding: 0 }} onClick={() => navigate(`/c/${r.conversationId}${r.messageSeq ? `?m=${r.messageSeq}` : ''}`)}>
        <b className="ellipsis" style={{ display: 'block' }}>{r.note || (conv ? conversationTitle(d, conv) : '')}</b>
        <span className="small muted ellipsis" style={{ display: 'block' }}>{conv ? conversationTitle(d, conv) : ''} · {new Date(r.remindAt).toLocaleString(locale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
      </button>
      {due && <button className="btn small" onClick={() => act(client.snoozeReminder(r.id, new Date(Date.now() + 3600_000).toISOString()))}>{t('rem.snooze')}</button>}
      <button className="btn small" onClick={() => act(client.completeReminder(r.id))}>{t('rem.done')}</button>
    </div>
  );
}

export function RemindersSection() {
  const list = useClient((s) => s.reminders);
  const d = useClient((s) => s.data)!;
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(i); }, []);
  const visible = new Set(d.conversations.map((c) => c.id));
  const mine = list.filter((r) => visible.has(r.conversationId));
  const due = mine.filter((r) => Date.parse(r.remindAt) <= Date.now());
  const next = mine.filter((r) => Date.parse(r.remindAt) > Date.now()).slice(0, 4);
  return (
    <section>
      <div className="row" style={{ marginBottom: 10 }}><span className="eyebrow grow">{t('rem.title')}</span></div>
      <div className="list" style={{ marginBottom: 20 }}>
        {due.length === 0 && next.length === 0 && <div className="empty">{t('rem.empty')}</div>}
        {due.map((r) => <ReminderRow key={r.id} r={r} />)}
        {next.map((r) => <ReminderRow key={r.id} r={r} />)}
      </div>
    </section>
  );
}
