import { useEffect, useMemo, useState } from 'react';
import type { ForwardSource, ReminderDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { errorText, locale, t } from '../i18n.ts';
import { toast } from '../menu.tsx';
import { navigate, queryParam } from '../router.ts';
import { ConvAvatar, Modal, conversationSubtitle, conversationTitle } from '../ui.tsx';
import { MAX_ATTACHMENT_BYTES } from '@tiecoms/contracts';
import { FileChip } from './Attachments.tsx';

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
/** Lo que llegó desde otra app: por GET (título/texto/enlace) o por el service worker (POST con archivos). */
async function readShared(): Promise<{ text: string; files: File[] }> {
  const text = [queryParam('title'), queryParam('text'), queryParam('url')].filter(Boolean).join('\n').trim();
  const id = queryParam('shared');
  if (!id || typeof caches === 'undefined') return { text, files: [] };
  try {
    const cache = await caches.open('tiecoms-share');
    const base = `${import.meta.env.BASE_URL}__share/${id}/`;
    const metaRes = await cache.match(`${base}meta`);
    if (!metaRes) return { text, files: [] };
    const meta = await metaRes.json();
    const files: File[] = [];
    for (const key of meta.files as string[]) {
      const r = await cache.match(key);
      if (!r) continue;
      files.push(new File([await r.blob()], decodeURIComponent(r.headers.get('x-file-name') ?? 'archivo'), { type: r.headers.get('content-type') ?? '' }));
      await cache.delete(key);
    }
    await cache.delete(`${base}meta`);
    return { text: [meta.title, meta.text, meta.url].filter(Boolean).join('\n').trim() || text, files };
  } catch { return { text, files: [] }; }
}

/**
 * «Compartir en TieComs»: vista previa, buscador, hasta 5 conversaciones (recientes primero),
 * mensaje opcional y envío con progreso. Mismo diseño que la extensión de iOS y la actividad de Android.
 */
export function ShareScreen() {
  const d = useClient((s) => s.data)!;
  const [shared, setShared] = useState<{ text: string; files: File[] } | null>(null);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previews = useMemo(() => (shared?.files ?? []).filter((f) => f.type.startsWith('image/')).map((f) => URL.createObjectURL(f)), [shared]);
  useEffect(() => { void readShared().then(setShared); }, []);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);
  const needle = q.trim().toLowerCase();
  const list = d.conversations
    .filter((c) => c.canPost && (!needle || conversationTitle(d, c).toLowerCase().includes(needle)))
    .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
  const toggle = (id: string) => setPicked((x) => (x.includes(id) ? x.filter((y) => y !== id) : x.length >= 5 ? (toast(t('share.max5')), x) : [...x, id]));
  const tooBig = (shared?.files ?? []).find((f) => f.size > MAX_ATTACHMENT_BYTES);
  const items = (shared?.files.length ?? 0) + (shared?.text ? 1 : 0);

  async function send() {
    if (!shared) return;
    setError(null);
    const body = [note.trim(), shared.text].filter(Boolean).join('\n\n');
    try {
      const steps = picked.length * (shared.files.length + 1);
      let step = 0;
      for (const conv of picked) {
        // Los adjuntos pertenecen a una conversación: se suben a cada destino.
        const attachments = [];
        for (const f of shared.files) {
          setProgress(t('share.progress', { i: ++step, n: steps }));
          attachments.push(await client.uploadAttachment(conv, f, f.name));
        }
        setProgress(t('share.progress', { i: ++step, n: steps }));
        await client.send(conv, body, null, null, { attachments });
      }
      toast(picked.length === 1 ? t('share.sentOne') : t('share.sentMany', { n: picked.length }));
      navigate(picked.length === 1 ? `/c/${picked[0]}` : '/', true);
    } catch (e) { setError(errorText(e) || t('share.failed')); setProgress(null); }
  }

  return (
    <div className="page"><div className="page-narrow" style={{ maxWidth: 640 }}>
      <h1>{t('share.header')}</h1>
      {!shared ? <div className="muted">{t('common.loading')}</div> : items === 0 ? <div className="empty">{t('share.empty')}</div> : (
        <>
          <div className="small muted">{items === 1 ? t('share.item') : t('share.items', { n: items })}</div>
          {previews.length > 0 && <div className="share-thumbs">{previews.map((u) => <img key={u} src={u} alt="" />)}</div>}
          {shared.files.filter((f) => !f.type.startsWith('image/')).map((f) => <FileChip key={f.name + f.size} a={{ name: f.name, contentType: f.type, sizeBytes: f.size }} />)}
          {shared.text && <blockquote className="derive-quote" style={{ margin: '10px 0' }}>{shared.text.slice(0, 400)}</blockquote>}
          {tooBig && <div className="error">{t('att.tooBig', { name: tooBig.name })}</div>}
        </>
      )}
      <input className="input" style={{ marginTop: 12 }} placeholder={t('fwd.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="eyebrow" style={{ margin: '12px 0 6px' }}>{needle ? t('share.pick') : t('share.recent')}</div>
      <div className="list" style={{ maxHeight: 360, overflow: 'auto', gap: 4 }}>
        {list.map((c) => (
          <label key={c.id} className={`check fwd-opt ${picked.includes(c.id) ? 'is-on' : ''}`}>
            <input type="checkbox" checked={picked.includes(c.id)} onChange={() => toggle(c.id)} />
            <ConvAvatar c={c} size={28} />
            <span className="grow" style={{ minWidth: 0 }}>
              <b className="ellipsis" style={{ display: 'block' }}>{conversationTitle(d, c)}</b>
              <span className="small muted ellipsis" style={{ display: 'block' }}>{conversationSubtitle(d, c)}</span>
            </span>
          </label>
        ))}
      </div>
      <textarea className="input" rows={2} style={{ marginTop: 10 }} placeholder={t('share.addMessage')} value={note} onChange={(e) => setNote(e.target.value)} />
      {error && <div className="error">{error}</div>}
      <div className="modal-actions" style={{ marginTop: 10 }}>
        <span className="small muted grow">{progress ?? ''}</span>
        <button className="btn ghost" onClick={() => navigate('/', true)}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={!picked.length || !items || !!tooBig || !!progress} onClick={send}>
          {picked.length > 1 ? t('share.sendTo', { n: picked.length }) : t('share.send')}
        </button>
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
