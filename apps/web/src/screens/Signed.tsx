/**
 * «Documentos que firmé» (/firmas): la trazabilidad de todo lo que cada persona firmó en Chaggu,
 * con su sello, quién lo pidió, dónde, cuántas marcas y las huellas del original y del firmado.
 * Abajo, las firmas guardadas para verlas, crear o borrar.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SignatureDTO, SigningHistoryItemDTO } from '@tiecoms/contracts';
import { MAX_SAVED_SIGNATURES } from '@tiecoms/contracts';
import { client } from '../app-client.ts';
import { errorText, getLang, t } from '../i18n.ts';
import { toast } from '../menu.tsx';
import { navigate } from '../router.ts';
import { Modal } from '../ui.tsx';
import PdfSheet, { CreateSignature, SavedTile, useSignatures } from './Sign.tsx';

const dayFmt = () => new Intl.DateTimeFormat(getLang() === 'en' ? 'en-US' : 'es-CO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const timeFmt = () => new Intl.DateTimeFormat(getLang() === 'en' ? 'en-US' : 'es-CO', { hour: '2-digit', minute: '2-digit' });
const fullFmt = () => new Intl.DateTimeFormat(getLang() === 'en' ? 'en-US' : 'es-CO', { dateStyle: 'long', timeStyle: 'medium' });

/** Sello circular: «CHAGGU · FIRMADO ELECTRÓNICAMENTE» alrededor, ✓ al centro y la referencia. */
export function Seal({ refCode, size = 56 }: { refCode: string; size?: number }) {
  const rim = getLang() === 'en' ? 'CHAGGU · ELECTRONICALLY SIGNED · ' : 'CHAGGU · FIRMADO ELECTRÓNICAMENTE · ';
  const id = `seal-${refCode}-${size}`;
  // En tamaño de lista el texto del borde no se lee: solo anillos y ✓ (la referencia va al lado).
  if (size < 72) return (
    <svg className="seal" width={size} height={size} viewBox="0 0 100 100" role="img" aria-label={`${t('signed.seal')} ${refCode}`}>
      <circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" strokeWidth="5" strokeDasharray="3 5.2" />
      <circle cx="50" cy="50" r="35" fill="currentColor" opacity=".1" />
      <circle cx="50" cy="50" r="35" fill="none" stroke="currentColor" strokeWidth="4" />
      <path d="M34 51 l11 11 l22 -24" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  return (
    <svg className="seal" width={size} height={size} viewBox="0 0 100 100" role="img" aria-label={`${t('signed.seal')} ${refCode}`}>
      <defs><path id={id} d="M50,50 m-38,0 a38,38 0 1,1 76,0 a38,38 0 1,1 -76,0" /></defs>
      <circle cx="50" cy="50" r="47" fill="none" stroke="currentColor" strokeWidth="3" />
      <circle cx="50" cy="50" r="29" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <text fontSize="9.2" fontWeight="700" letterSpacing="1.2" fill="currentColor"><textPath href={`#${id}`} textLength="236">{rim}</textPath></text>
      <path d="M40 44 l7 7 l14 -15" fill="none" stroke="currentColor" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
      <text x="50" y="66" textAnchor="middle" fontSize="7.4" fontWeight="800" letterSpacing=".4" fill="currentColor">{refCode}</text>
    </svg>
  );
}

export default function SignedScreen() {
  const [items, setItems] = useState<SigningHistoryItemDTO[] | null>(null);
  const [total, setTotal] = useState(0);
  const [next, setNext] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState<SigningHistoryItemDTO | null>(null);
  const [tab, setTab] = useState<'docs' | 'mine'>('docs');
  const seq = useRef(0);

  const load = useCallback(async (query: string) => {
    const my = ++seq.current;
    try {
      const r = await client.listSignings({ q: query, limit: 30 });
      if (my !== seq.current) return;
      setItems(r.signings); setNext(r.nextBefore); setTotal(r.total);
    } catch (e) { if (my === seq.current) { toast(errorText(e)); setItems([]); } }
  }, []);
  useEffect(() => { const tm = setTimeout(() => void load(q), q ? 250 : 0); return () => clearTimeout(tm); }, [q, load]);

  async function more() {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await client.listSignings({ q, before: next, limit: 30 });
      setItems((xs) => [...(xs ?? []), ...r.signings]); setNext(r.nextBefore);
    } catch (e) { toast(errorText(e)); } finally { setLoadingMore(false); }
  }

  // Agrupado por día.
  const groups: { day: string; list: SigningHistoryItemDTO[] }[] = [];
  for (const it of items ?? []) {
    const day = dayFmt().format(new Date(it.signedAt));
    if (groups.at(-1)?.day !== day) groups.push({ day, list: [] });
    groups.at(-1)!.list.push(it);
  }

  return (
    <div className="page"><div className="page-narrow signed-page">
      <h1>{t('signed.title')}</h1>
      <p className="muted" style={{ margin: '0 0 14px' }}>{t('signed.intro')}</p>
      <div className="seg signed-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'docs'} className={tab === 'docs' ? 'on' : ''} onClick={() => setTab('docs')}>{t('signed.tabDocs')}{items ? ` · ${total}` : ''}</button>
        <button role="tab" aria-selected={tab === 'mine'} className={tab === 'mine' ? 'on' : ''} onClick={() => setTab('mine')}>{t('signed.tabMine')}</button>
      </div>

      {tab === 'mine' ? <MySignatures /> : (
        <>
          <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('signed.search')} style={{ marginBottom: 12 }} />
          {!items ? <div className="hint">{t('common.loading')}</div>
            : !items.length ? (
              <div className="signed-empty card">
                <Seal refCode="········" size={64} />
                <b>{q ? t('signed.noResults') : t('signed.empty')}</b>
                {!q && <span className="small muted">{t('signed.emptyHint')}</span>}
              </div>
            ) : groups.map((g) => (
              <section key={g.day} className="signed-day">
                <h2 className="signed-day-h">{g.day}</h2>
                <div className="card signed-list">
                  {g.list.map((it) => (
                    <button key={it.id} type="button" className="signed-row" onClick={() => setOpen(it)}>
                      <Seal refCode={it.ref} size={48} />
                      <span className="grow" style={{ minWidth: 0 }}>
                        <b className="ellipsis" style={{ display: 'block' }}>{it.documentName}</b>
                        <span className="small muted ellipsis" style={{ display: 'block' }}>
                          {[it.requestedByName ? t('signed.requestedBy', { name: it.requestedByName }) : null, it.conversationName].filter(Boolean).join(' · ') || t('signed.byMe')}
                        </span>
                        <span className="small muted">{timeFmt().format(new Date(it.signedAt))} · {t('signed.marks', { n: it.signatureMarks, p: it.pagesMarked, total: it.pages })} · <span className="signed-ref">{it.ref}</span></span>
                      </span>
                      <span className="muted" aria-hidden>›</span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          {next && <div style={{ textAlign: 'center', margin: 16 }}><button className="btn" disabled={loadingMore} onClick={() => void more()}>{loadingMore ? t('common.loading') : t('signed.more')}</button></div>}
        </>
      )}
      {open && <SigningDetail it={open} onClose={() => setOpen(null)} />}
    </div></div>
  );
}

function Copyable({ label, value }: { label: string; value: string }) {
  return (
    <div className="signed-hash">
      <span className="small muted">{label}</span>
      <button type="button" title={t('common.copy')} onClick={() => { void navigator.clipboard?.writeText(value).then(() => toast(t('common.copied'))); }}>
        <code>{value}</code>
      </button>
    </div>
  );
}

function SigningDetail({ it, onClose }: { it: SigningHistoryItemDTO; onClose: () => void }) {
  const [viewing, setViewing] = useState(false);
  return (
    <>
      {!viewing && <Modal title={t('signed.detailTitle')} onClose={onClose}>
        <div className="signed-detail-head">
          <Seal refCode={it.ref} size={92} />
          <div style={{ minWidth: 0 }}>
            <b style={{ fontSize: 16, wordBreak: 'break-word' }}>{it.documentName}</b>
            <div className="small muted">{fullFmt().format(new Date(it.signedAt))}</div>
            <div className="small">{t('signed.ref')} <b>{it.ref}</b></div>
          </div>
        </div>
        <dl className="signed-dl">
          <dt>{t('signed.signedByLabel')}</dt><dd>{it.signerName}</dd>
          {it.requestedByName && <><dt>{t('signed.requestedByLabel')}</dt><dd>{it.requestedByName}</dd></>}
          {it.conversationName && <><dt>{t('signed.where')}</dt><dd>{it.conversationName}</dd></>}
          <dt>{t('signed.marksLabel')}</dt><dd>{t('signed.marksLong', { n: it.marks, s: it.signatureMarks, p: it.pagesMarked, total: it.pages })}</dd>
          <dt>{t('signed.extras')}</dt><dd>{[it.stamp ? t('sign.stamp') : null, it.certificate ? t('sign.certificate') : null].filter(Boolean).join(' · ') || '—'}</dd>
        </dl>
        <Copyable label={t('signed.hashSigned')} value={it.signedSha256} />
        <Copyable label={t('signed.hashOriginal')} value={it.originalSha256} />
        {!it.attachment && <div className="pdf-banner warn" style={{ borderRadius: 10 }}>{t('signed.noAccess')}</div>}
        <div className="modal-actions" style={{ flexWrap: 'wrap' }}>
          <button className="btn ghost" onClick={() => { onClose(); navigate(`/c/${it.conversationId}`); }}>{t('signed.goChat')}</button>
          <button className="btn primary" disabled={!it.attachment} onClick={() => setViewing(true)}>{t('signed.view')}</button>
        </div>
      </Modal>}
      {viewing && it.attachment && <PdfSheet a={it.attachment} onClose={() => setViewing(false)} />}
    </>
  );
}

function MySignatures() {
  const sigs = useSignatures();
  const [creating, setCreating] = useState<null | 'signature' | 'initials'>(null);
  const [preview, setPreview] = useState<SignatureDTO | null>(null);
  async function del(s: SignatureDTO) {
    if (!window.confirm(t('sign.deleteConfirm'))) return;
    try { await client.deleteSignature(s.id); sigs.remove(s.id); } catch (e) { toast(errorText(e)); }
  }
  const full = (sigs.list?.length ?? 0) >= MAX_SAVED_SIGNATURES;
  return (
    <>
      <p className="small muted" style={{ marginTop: 0 }}>{t('sign.privacy')}</p>
      {(['signature', 'initials'] as const).map((kind) => (
        <section key={kind} style={{ marginBottom: 18 }}>
          <h2 className="signed-day-h">{kind === 'initials' ? t('sign.myInitials') : t('sign.mySignatures')}</h2>
          <div className="sig-grid">
            {(sigs.list ?? []).filter((s) => s.kind === kind).map((s) => <SavedTile key={s.id} s={s} onPick={() => setPreview(s)} onDelete={() => void del(s)} />)}
            <button type="button" className="sig-tile sig-new" disabled={full} onClick={() => setCreating(kind)}>
              <span>＋</span>{kind === 'initials' ? t('sign.newInitials') : t('sign.newSignature')}
            </button>
          </div>
        </section>
      ))}
      {full && <p className="small muted">{t('sign.tooMany', { n: MAX_SAVED_SIGNATURES })}</p>}
      {creating && <CreateSignature kind={creating} onClose={() => setCreating(null)} onSaved={(s) => { sigs.add(s); setCreating(null); toast(t('signed.saved')); }} />}
      {preview && (
        <Modal title={preview.kind === 'initials' ? t('sign.initials') : t('sign.signature')} onClose={() => setPreview(null)}>
          <div className="sig-photo" style={{ minHeight: 160 }}><SavedTile s={preview} onPick={() => {}} onDelete={() => { setPreview(null); void del(preview); }} /></div>
          <p className="small muted" style={{ margin: 0 }}>{t('signed.createdAt', { when: fullFmt().format(new Date(preview.createdAt)) })}</p>
        </Modal>
      )}
    </>
  );
}
