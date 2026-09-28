/**
 * Ver y firmar un PDF del chat. Se carga aparte (pdf.js pesa ~1,6 MB) cuando alguien abre un PDF.
 *
 * Ver: páginas a lo ancho, dibujadas cuando se acercan a la pantalla. Firmar: se agregan marcas
 * (firma, iniciales, fecha, texto) que se arrastran y se agrandan con el dedo o el mouse; sus
 * coordenadas son proporciones de la página tal como se ve, igual que las espera el servidor, que
 * estampa el PDF y responde en el hilo con el firmado.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { AttachmentDTO, SignatureDTO, SignInfoDTO, SignPlacementInput } from '@tiecoms/contracts';
import { MAX_SAVED_SIGNATURES } from '@tiecoms/contracts';
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import SignaturePad from 'signature_pad';
import { client, useClient } from '../app-client.ts';
import { errorText, getLang, t } from '../i18n.ts';
import { toast } from '../menu.tsx';
import { Modal } from '../ui.tsx';
import { INK_COLORS, SCRIPT_FONTS, loadScriptFonts, photoCanvas, trimmedPng, typedCanvas, type InkColor } from '../sign-image.ts';
import { blobUrl, downloadAttachment } from './Attachments.tsx';

GlobalWorkerOptions.workerSrc = workerSrc;
const assetBase = `${import.meta.env.BASE_URL}pdfjs/`;

type MarkKind = 'signature' | 'initials' | 'date' | 'text';
interface Mark { id: string; kind: MarkKind; page: number; x: number; y: number; w: number; h: number; signatureId?: string; text?: string; group?: string }
interface PageSize { w: number; h: number }

const uid = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const TEXT_FONT = 'Helvetica, Arial, sans-serif';
let measureCtx: CanvasRenderingContext2D | null = null;
/** Ancho del texto a 1 px en la letra del servidor (Helvetica ≈ Arial). */
function textWidth1(text: string) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx!.font = `100px ${TEXT_FONT}`;
  return measureCtx!.measureText(text).width / 100;
}
const todayText = () => new Intl.DateTimeFormat(getLang() === 'en' ? 'en-US' : 'es-CO', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date());

// ---------- Firmas guardadas (caché del módulo) ----------
let savedCache: SignatureDTO[] | null = null;
export function useSignatures() {
  const [list, setList] = useState<SignatureDTO[] | null>(savedCache);
  const reload = useCallback(async () => {
    try { savedCache = (await client.listSignatures()).signatures; setList(savedCache); } catch (e) { toast(errorText(e)); setList((l) => l ?? []); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  const add = (s: SignatureDTO) => { savedCache = [s, ...(savedCache ?? [])]; setList(savedCache); };
  const remove = (id: string) => { savedCache = (savedCache ?? []).filter((s) => s.id !== id); setList(savedCache); };
  return { list, add, remove };
}
function useBlob(path: string | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { let alive = true; if (path) blobUrl(path).then((u) => alive && setUrl(u)).catch(() => {}); return () => { alive = false; }; }, [path]);
  return url;
}

// ---------- Pantalla ----------
export default function PdfSheet({ a, startSigning = false, onClose }: { a: AttachmentDTO; startSigning?: boolean; onClose: () => void }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [info, setInfo] = useState<SignInfoDTO | null>(null);
  const [signing, setSigning] = useState(startSigning);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [sheet, setSheet] = useState<null | { type: 'pick' | 'create'; kind: 'signature' | 'initials' } | { type: 'text'; markId?: string } | { type: 'confirm' }>(null);
  const [visiblePage, setVisiblePage] = useState(1);
  const sigs = useSignatures();
  const stage = useRef<HTMLDivElement>(null);
  const [stageW, setStageW] = useState(0);

  // Cargar el PDF (y lo que el servidor sabe de él) una vez.
  useEffect(() => {
    let alive = true;
    let task: ReturnType<typeof getDocument> | null = null;
    (async () => {
      try {
        const blob = await client.fetchBlob(a.url);
        const data = new Uint8Array(await blob.arrayBuffer());
        if (!alive) return;
        task = getDocument({ data, wasmUrl: `${assetBase}wasm/`, standardFontDataUrl: `${assetBase}standard_fonts/`, cMapUrl: `${assetBase}cmaps/`, cMapPacked: true });
        const loaded = await task.promise;
        const out: PageSize[] = [];
        for (let i = 1; i <= loaded.numPages; i++) {
          const vp = (await loaded.getPage(i)).getViewport({ scale: 1 });
          out.push({ w: vp.width, h: vp.height });
        }
        if (!alive) return;
        setDoc(loaded); setSizes(out);
      } catch (e: any) {
        if (alive) setLoadError(e?.name === 'PasswordException' ? t('sign.encrypted') : errorText(e) || t('sign.cantOpen'));
      }
    })();
    client.signInfo(a.id).then((i) => alive && setInfo(i)).catch(() => {});
    return () => { alive = false; void task?.destroy(); };
  }, [a.id, a.url]);

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageW(el.clientWidth));
    ro.observe(el); setStageW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const dirty = marks.length > 0;
  const close = useCallback(() => {
    if (dirty && !window.confirm(t('sign.discard'))) return;
    onClose();
  }, [dirty, onClose]);

  // Teclado: Esc cierra (o suelta la selección), Supr borra la marca elegida.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (sheet || (e.target as HTMLElement)?.closest?.('input, textarea')) return;
      if (e.key === 'Escape') { if (selected) setSelected(null); else close(); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { setMarks((ms) => ms.filter((m) => m.id !== selected)); setSelected(null); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [sheet, selected, close]);

  // Página que más se ve: ahí caen las marcas nuevas.
  const pageEls = useRef(new Map<number, HTMLDivElement>());
  const onScroll = useCallback(() => {
    const el = stage.current;
    if (!el) return;
    const mid = el.getBoundingClientRect().top + el.clientHeight / 2;
    let best = 1, dist = Infinity;
    for (const [n, p] of pageEls.current) {
      const r = p.getBoundingClientRect();
      const d = mid < r.top ? r.top - mid : mid > r.bottom ? mid - r.bottom : 0;
      if (d < dist) { dist = d; best = n; }
    }
    setVisiblePage(best);
  }, []);

  /** Centro de lo que se ve en la página visible, en proporciones. */
  function viewCenter(page: number) {
    const el = stage.current, p = pageEls.current.get(page);
    if (!el || !p) return { cx: 0.5, cy: 0.5 };
    const s = el.getBoundingClientRect(), r = p.getBoundingClientRect();
    return { cx: clamp((s.left + s.width / 2 - r.left) / r.width, 0.1, 0.9), cy: clamp((s.top + s.height / 2 - r.top) / r.height, 0.1, 0.9) };
  }

  function placeSignature(s: SignatureDTO) {
    const page = visiblePage, size = sizes[page - 1];
    if (!size) return;
    const initials = s.kind === 'initials';
    // Ancho en puntos: firma ≈ 170 pt (6 cm), iniciales ≈ 60 pt; alto según la imagen.
    let wPt = initials ? 60 : 170;
    let hPt = (wPt * s.height) / s.width;
    const maxH = initials ? 50 : 70;
    if (hPt > maxH) { hPt = maxH; wPt = (hPt * s.width) / s.height; }
    const w = Math.min(0.9, wPt / size.w), h = Math.min(0.9, hPt / size.h);
    const { cx, cy } = viewCenter(page);
    const m: Mark = { id: uid(), kind: s.kind, signatureId: s.id, page, w, h, x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h) };
    setMarks((ms) => [...ms, m]); setSelected(m.id);
  }

  function placeText(kind: 'date' | 'text', text: string, replace?: string) {
    const page = replace ? marks.find((m) => m.id === replace)?.page ?? visiblePage : visiblePage;
    const size = sizes[page - 1];
    if (!size || !text.trim()) return;
    const hPt = 18, wPt = Math.max(30, textWidth1(text) * hPt * 0.78 * 1.06);
    const w = Math.min(0.95, wPt / size.w), h = Math.min(0.5, hPt / size.h);
    if (replace) { setMarks((ms) => ms.map((m) => (m.id === replace ? { ...m, text, w: Math.min(1 - m.x, w * (m.h / h)) } : m))); return; }
    const { cx, cy } = viewCenter(page);
    const m: Mark = { id: uid(), kind, text, page, w, h, x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h) };
    setMarks((ms) => [...ms, m]); setSelected(m.id);
  }

  /** La marca elegida se copia en la misma posición en todas las páginas (típico con las iniciales). */
  function toAllPages(id: string) {
    const base = marks.find((m) => m.id === id);
    if (!base) return;
    const group = base.group ?? uid();
    const copies: Mark[] = [];
    for (let p = 1; p <= sizes.length; p++) {
      if (p === base.page || marks.some((m) => m.group === group && m.page === p)) continue;
      const k = (sizes[base.page - 1]!.w / sizes[p - 1]!.w);
      const w = Math.min(0.95, base.w * k), h = Math.min(0.95, base.h * (sizes[base.page - 1]!.h / sizes[p - 1]!.h));
      copies.push({ ...base, id: uid(), group, page: p, w, h, x: clamp(base.x, 0, 1 - w), y: clamp(base.y, 0, 1 - h) });
    }
    setMarks((ms) => [...ms.map((m) => (m.id === id ? { ...m, group } : m)), ...copies]);
    toast(t('sign.copied', { n: copies.length }));
  }

  /** Llevar una marca a otra página conservando su tamaño en puntos. */
  function moveToPage(id: string, page: number, left: number, top: number, rect: DOMRect) {
    setMarks((ms) => ms.map((m) => {
      if (m.id !== id) return m;
      const from = sizes[m.page - 1]!, to = sizes[page - 1]!;
      const w = Math.min(0.95, (m.w * from.w) / to.w), h = Math.min(0.95, (m.h * from.h) / to.h);
      return { ...m, page, group: undefined, w, h, x: clamp((left - rect.left) / rect.width, 0, 1 - w), y: clamp((top - rect.top) / rect.height, 0, 1 - h) };
    }));
    setVisiblePage(page);
  }

  /** Las copias de «En todas» se mueven y se agrandan juntas. */
  const update = useCallback((id: string, patch: Partial<Mark>) => setMarks((ms) => {
    const group = ms.find((m) => m.id === id)?.group;
    return ms.map((m) => {
      if (m.id !== id && (!group || m.group !== group)) return m;
      const next = { ...m, ...patch };
      next.w = Math.min(next.w, 1); next.h = Math.min(next.h, 1);
      next.x = clamp(next.x, 0, 1 - next.w); next.y = clamp(next.y, 0, 1 - next.h);
      return next;
    });
  }), []);
  /** Otra marca igual un poco más abajo (pólizas: la misma firma varias veces en una página). */
  function duplicate(id: string) {
    const base = marks.find((m) => m.id === id);
    if (!base) return;
    const gap = base.h + 0.02;
    const below = base.y + gap + base.h <= 1;
    const m: Mark = { ...base, id: uid(), group: undefined, y: below ? base.y + gap : Math.max(0, base.y - gap) };
    setMarks((ms) => [...ms, m]); setSelected(m.id);
  }
  const removeMark = (id: string) => { setMarks((ms) => ms.filter((m) => m.id !== id)); setSelected(null); };

  function startSig(kind: 'signature' | 'initials') {
    const have = (sigs.list ?? []).some((s) => s.kind === kind);
    setSheet({ type: have ? 'pick' : 'create', kind });
  }

  const pageW = Math.max(200, (stageW - 24) * zoom);
  const sel = marks.find((m) => m.id === selected) ?? null;
  const sigCount = marks.filter((m) => m.kind === 'signature' || m.kind === 'initials').length;
  const signed = a.signing ?? info?.signing ?? null;

  return (
    <div className="pdf-sheet" role="dialog" aria-modal="true" aria-label={a.name}>
      <div className="pdf-bar">
        <button className="icon-btn" aria-label={t('common.close')} onClick={close}>×</button>
        <div className="grow" style={{ minWidth: 0 }}>
          <b className="ellipsis" style={{ display: 'block' }}>{a.name}</b>
          <span className="small muted">{sizes.length ? t('sign.pageOf', { i: visiblePage, n: sizes.length }) : t('common.loading')}</span>
        </div>
        <div className="pdf-zoom">
          <button className="icon-btn" aria-label={t('sign.zoomOut')} disabled={zoom <= 1} onClick={() => setZoom((z) => Math.max(1, z - 0.5))}>−</button>
          <button className="icon-btn" aria-label={t('sign.zoomIn')} disabled={zoom >= 3} onClick={() => setZoom((z) => Math.min(3, z + 0.5))}>+</button>
        </div>
        <button className="icon-btn" aria-label={t('att.download')} onClick={() => void downloadAttachment(a)}>⤓</button>
        {!signing && <button className="btn accent small" disabled={!doc || !!info?.encrypted} onClick={() => setSigning(true)}>✍️ {t('sign.sign')}</button>}
      </div>

      {signed && !signing && (
        <div className="pdf-banner ok">✓ {t('sign.signedBy', { name: signed.signerName, when: new Date(signed.signedAt).toLocaleString() })} · <code>{signed.signedSha256.slice(0, 12)}</code></div>
      )}
      {signing && info?.hasDigitalSignature && <div className="pdf-banner warn">⚠️ {t('sign.hasDigital')}</div>}
      {signing && !marks.length && <div className="pdf-banner hint">{t('sign.hint')}</div>}

      <div className={`pdf-stage${signing ? ' is-signing' : ''}`} ref={stage} onScroll={onScroll}
        onPointerDown={(e) => { if (!(e.target as HTMLElement).closest('.pdf-mark')) setSelected(null); }}>
        {loadError ? <div className="pdf-msg">{loadError}</div>
          : !doc ? <div className="pdf-msg"><span className="pdf-spin" /> {t('common.loading')}</div>
          : sizes.map((s, i) => (
            <PageView key={i} doc={doc} n={i + 1} size={s} width={pageW} root={stage} pageEls={pageEls.current}>
              {marks.filter((m) => m.page === i + 1).map((m) => (
                <MarkView key={m.id} m={m} pageCss={{ w: pageW, h: (pageW * s.h) / s.w }} selected={m.id === selected} editable={signing}
                  sig={m.signatureId ? sigs.list?.find((x) => x.id === m.signatureId) : undefined}
                  onSelect={() => setSelected(m.id)} onChange={(p) => update(m.id, p)} onRemove={() => removeMark(m.id)}
                  onEdit={m.kind === 'text' || m.kind === 'date' ? () => setSheet({ type: 'text', markId: m.id }) : undefined}
                  onDropPage={(page, left, top, rect) => moveToPage(m.id, page, left, top, rect)} />
              ))}
            </PageView>
          ))}
      </div>

      {signing && (
        <div className="pdf-tools">
          {sel ? (
            <>
              <button className="pdf-tool" onClick={() => removeMark(sel.id)}><span>🗑</span>{t('sign.remove')}</button>
              <button className="pdf-tool" onClick={() => duplicate(sel.id)}><span>⊕</span>{t('sign.duplicate')}</button>
              {sizes.length > 1 && <button className="pdf-tool" onClick={() => toAllPages(sel.id)}><span>⧉</span>{t('sign.allPages')}</button>}
              {(sel.kind === 'text' || sel.kind === 'date') && <button className="pdf-tool" onClick={() => setSheet({ type: 'text', markId: sel.id })}><span>✎</span>{t('sign.editText')}</button>}
              <button className="pdf-tool" onClick={() => setSelected(null)}><span>✓</span>{t('common.done')}</button>
            </>
          ) : (
            <>
              <button className="pdf-tool" onClick={() => startSig('signature')}><span>✍️</span>{t('sign.signature')}</button>
              <button className="pdf-tool" onClick={() => startSig('initials')}><span className="pdf-ini">AB</span>{t('sign.initials')}</button>
              <button className="pdf-tool" onClick={() => placeText('date', todayText())}><span>📅</span>{t('sign.date')}</button>
              <button className="pdf-tool" onClick={() => setSheet({ type: 'text' })}><span>Aa</span>{t('sign.text')}</button>
              <button className="btn accent pdf-go" disabled={!sigCount} onClick={() => setSheet({ type: 'confirm' })}>
                {t('sign.finish')}{sigCount ? ` (${sigCount})` : ''}
              </button>
            </>
          )}
        </div>
      )}

      {sheet?.type === 'pick' && (
        <PickSignature kind={sheet.kind} list={(sigs.list ?? []).filter((s) => s.kind === sheet.kind)} total={sigs.list?.length ?? 0}
          onClose={() => setSheet(null)} onPick={(s) => { setSheet(null); placeSignature(s); }}
          onNew={() => setSheet({ type: 'create', kind: sheet.kind })} onDeleted={sigs.remove} />
      )}
      {sheet?.type === 'create' && (
        <CreateSignature kind={sheet.kind} onClose={() => setSheet(null)} onSaved={(s) => { sigs.add(s); setSheet(null); placeSignature(s); }} />
      )}
      {sheet?.type === 'text' && (
        <TextDialog initial={sheet.markId ? marks.find((m) => m.id === sheet.markId)?.text ?? '' : ''}
          onClose={() => setSheet(null)} onDone={(text) => {
            const id = sheet.markId; setSheet(null);
            if (id) placeText('text', text, id); else placeText('text', text);
          }} />
      )}
      {sheet?.type === 'confirm' && (
        <ConfirmSign a={a} info={info} marks={marks} pages={sizes.length} onClose={() => setSheet(null)} onSigned={() => { setSheet(null); setMarks([]); onClose(); }} />
      )}
    </div>
  );
}

// ---------- Una página ----------
function PageView({ doc, n, size, width, root, pageEls, children }: {
  doc: PDFDocumentProxy; n: number; size: PageSize; width: number; root: React.RefObject<HTMLDivElement | null>;
  pageEls: Map<number, HTMLDivElement>; children: React.ReactNode;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(n <= 2);
  const height = (width * size.h) / size.w;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    pageEls.set(n, el);
    const io = new IntersectionObserver(([e]) => setNear(!!e?.isIntersecting), { root: root.current, rootMargin: '900px 0px' });
    io.observe(el);
    return () => { io.disconnect(); pageEls.delete(n); };
  }, [pageEls, n, root]);

  // Se redibuja al acercarse o al cambiar el ancho (con una pausa corta para no hacerlo en cada cuadro).
  // pdf.js no admite dos dibujos a la vez en el mismo lienzo: cada uno espera a que termine el anterior.
  const last = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (!near) return;
    let task: RenderTask | null = null, cancelled = false;
    const timer = setTimeout(() => {
      last.current = last.current.catch(() => {}).then(async () => {
        if (cancelled || !canvas.current) return;
        try {
          const page = await doc.getPage(n);
          if (cancelled || !canvas.current) return;
          // Nitidez según la pantalla, sin pasar el límite de lienzo de Safari en iPhone (~16 Mpx).
          const dpr = Math.min(window.devicePixelRatio || 1, 3);
          let scale = (width / size.w) * dpr;
          const px = size.w * size.h * scale * scale;
          if (px > 12_000_000) scale *= Math.sqrt(12_000_000 / px);
          const vp = page.getViewport({ scale });
          const c = canvas.current;
          c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
          task = page.render({ canvas: c, viewport: vp });
          await task.promise;
        } catch (e: any) { if (e?.name !== 'RenderingCancelledException') console.warn('pdf render', n, e); }
      });
    }, 80);
    return () => { cancelled = true; clearTimeout(timer); task?.cancel(); };
  }, [near, doc, n, width, size.w, size.h]);

  return (
    <div className="pdf-page" ref={wrap} style={{ width, height }} data-page={n}>
      <canvas ref={canvas} style={{ width: '100%', height: '100%' }} aria-label={`${n}`} />
      {children}
    </div>
  );
}

// ---------- Una marca ----------
function MarkView({ m, pageCss, sig, selected, editable, onSelect, onChange, onRemove, onEdit, onDropPage }: {
  m: Mark; pageCss: { w: number; h: number }; sig?: SignatureDTO; selected: boolean; editable: boolean;
  onSelect: () => void; onChange: (p: Partial<Mark>) => void; onRemove: () => void; onEdit?: () => void;
  /** Se soltó sobre otra página: esquina superior izquierda en pantalla. */
  onDropPage: (page: number, left: number, top: number, rect: DOMRect) => void;
}) {
  const img = useBlob(sig?.url);
  const drag = useRef<null | { mode: 'move' | 'resize'; px: number; py: number; m: Mark; moved: boolean; offX: number; offY: number; scroll0: number }>(null);
  const isText = m.kind === 'text' || m.kind === 'date';

  function down(e: RPointerEvent, mode: 'move' | 'resize') {
    if (!editable) return;
    e.stopPropagation(); e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const box = (e.currentTarget as HTMLElement).closest('.pdf-mark')!.getBoundingClientRect();
    drag.current = { mode, px: e.clientX, py: e.clientY, m, moved: false, offX: e.clientX - box.left, offY: e.clientY - box.top, scroll0: stageOf(e)?.scrollTop ?? 0 };
    onSelect();
  }
  const stageOf = (e: RPointerEvent) => (e.currentTarget as HTMLElement).closest('.pdf-stage') as HTMLElement | null;
  function move(e: RPointerEvent) {
    const d = drag.current;
    if (!d) return;
    // Cerca del borde de arriba o de abajo, la hoja se desplaza sola para llevar la firma más lejos.
    const st = stageOf(e);
    if (st && d.mode === 'move') {
      const r = st.getBoundingClientRect();
      if (e.clientY > r.bottom - 48) st.scrollTop += 14; else if (e.clientY < r.top + 48) st.scrollTop -= 14;
    }
    const scrolled = st ? st.scrollTop - d.scroll0 : 0;
    const dx = (e.clientX - d.px) / pageCss.w, dy = (e.clientY - d.py + scrolled) / pageCss.h;
    if (Math.abs(e.clientX - d.px) + Math.abs(e.clientY - d.py) > 3) d.moved = true;
    if (d.mode === 'move') onChange({ x: clamp(d.m.x + dx, 0, 1 - d.m.w), y: clamp(d.m.y + dy, 0, 1 - d.m.h) });
    else {
      // Esquina: la firma conserva su proporción; el texto crece en alto y ancho a la vez igual.
      const ratio = d.m.h / d.m.w * (pageCss.h / pageCss.w);
      let wCss = Math.max(18, d.m.w * pageCss.w + (e.clientX - d.px));
      wCss = Math.min(wCss, (1 - d.m.x) * pageCss.w, ((1 - d.m.y) * pageCss.h) / ratio);
      onChange({ w: wCss / pageCss.w, h: (wCss * ratio) / pageCss.h });
    }
  }
  function up(e: RPointerEvent) {
    const d = drag.current;
    drag.current = null;
    if (d?.mode === 'move' && d.moved) {
      const target = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.classList.contains('pdf-page')) as HTMLElement | undefined;
      const page = Number(target?.dataset.page);
      if (target && page && page !== m.page) { onDropPage(page, e.clientX - d.offX, e.clientY - d.offY, target.getBoundingClientRect()); return; }
    }
    if (d && !d.moved && d.mode === 'move' && selected && isText && onEdit && e.pointerType !== 'mouse') onEdit();
  }

  const hCss = m.h * pageCss.h, wCss = m.w * pageCss.w;
  const fontPx = isText && m.text ? Math.max(4, Math.min(hCss * 0.78, wCss / Math.max(1e-6, textWidth1(m.text)))) : 0;
  return (
    <div className={`pdf-mark k-${m.kind}${selected ? ' is-sel' : ''}${editable ? '' : ' is-static'}`}
      style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%`, width: `${m.w * 100}%`, height: `${m.h * 100}%` }}
      onPointerDown={(e) => down(e, 'move')} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { drag.current = null; }}
      onDoubleClick={onEdit}>
      {isText ? <span className="pdf-mark-text" style={{ fontSize: fontPx, fontFamily: TEXT_FONT }}>{m.text}</span>
        : img ? <img src={img} alt="" draggable={false} /> : <span className="pdf-spin" />}
      {editable && selected && (
        <>
          <button type="button" className="pdf-x" aria-label={t('sign.remove')} onPointerDown={(e) => e.stopPropagation()} onClick={onRemove}>×</button>
          <span className="pdf-handle" aria-hidden onPointerDown={(e) => down(e, 'resize')} onPointerMove={move} onPointerUp={up} />
        </>
      )}
    </div>
  );
}

// ---------- Elegir una firma guardada ----------
function PickSignature({ kind, list, total, onClose, onPick, onNew, onDeleted }: {
  kind: 'signature' | 'initials'; list: SignatureDTO[]; total: number; onClose: () => void;
  onPick: (s: SignatureDTO) => void; onNew: () => void; onDeleted: (id: string) => void;
}) {
  async function del(s: SignatureDTO) {
    if (!window.confirm(t('sign.deleteConfirm'))) return;
    try { await client.deleteSignature(s.id); onDeleted(s.id); } catch (e) { toast(errorText(e)); }
  }
  return (
    <Modal title={kind === 'initials' ? t('sign.myInitials') : t('sign.mySignatures')} onClose={onClose}>
      <div className="sig-grid">
        {list.map((s) => <SavedTile key={s.id} s={s} onPick={() => onPick(s)} onDelete={() => void del(s)} />)}
        <button type="button" className="sig-tile sig-new" disabled={total >= MAX_SAVED_SIGNATURES} onClick={onNew}>
          <span>＋</span>{kind === 'initials' ? t('sign.newInitials') : t('sign.newSignature')}
        </button>
      </div>
      {total >= MAX_SAVED_SIGNATURES && <p className="small muted">{t('sign.tooMany', { n: MAX_SAVED_SIGNATURES })}</p>}
    </Modal>
  );
}
export function SavedTile({ s, onPick, onDelete }: { s: SignatureDTO; onPick: () => void; onDelete: () => void }) {
  const url = useBlob(s.url);
  return (
    <div className="sig-tile">
      <button type="button" className="sig-use" onClick={onPick} aria-label={t('sign.use')}>{url ? <img src={url} alt="" /> : <span className="pdf-spin" />}</button>
      <button type="button" className="sig-del" aria-label={t('sign.delete')} onClick={onDelete}>🗑</button>
    </div>
  );
}

// ---------- Crear una firma ----------
export function CreateSignature({ kind, onClose, onSaved }: { kind: 'signature' | 'initials'; onClose: () => void; onSaved: (s: SignatureDTO) => void }) {
  const me = useClient((s) => s.data?.me);
  const [tab, setTab] = useState<'drawn' | 'typed' | 'uploaded'>('drawn');
  const [color, setColor] = useState<InkColor>('blue');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [empty, setEmpty] = useState(true);
  const getCanvas = useRef<() => Promise<HTMLCanvasElement | null>>(async () => null);

  async function save() {
    setBusy(true); setError(null);
    try {
      const c = await getCanvas.current();
      const png = c ? await trimmedPng(c, kind === 'initials' ? 600 : 1200, 600) : null;
      if (!png) { setError(t('sign.empty')); return; }
      onSaved(await client.createSignature(png.blob, kind, tab));
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  const defaultText = kind === 'initials'
    ? (me?.name ?? '').split(/\s+/).filter(Boolean).slice(0, 3).map((w) => w[0]!.toUpperCase()).join('')
    : me?.name ?? '';
  return (
    <Modal title={kind === 'initials' ? t('sign.newInitials') : t('sign.newSignature')} onClose={onClose}>
      <div className="seg" role="tablist">
        {(['drawn', 'typed', 'uploaded'] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => { setTab(k); setEmpty(true); setError(null); }}>
            {t(`sign.tab.${k}`)}
          </button>
        ))}
      </div>
      {tab === 'drawn' && <DrawPad kind={kind} color={color} bind={getCanvas} onEmpty={setEmpty} />}
      {tab === 'typed' && <TypePad initial={defaultText} color={color} bind={getCanvas} onEmpty={setEmpty} />}
      {tab === 'uploaded' && <PhotoPad color={color} bind={getCanvas} onEmpty={setEmpty} />}
      <div className="row" style={{ gap: 8 }}>
        <span className="small muted">{t('sign.ink')}</span>
        {(Object.keys(INK_COLORS) as InkColor[]).map((c) => (
          <button key={c} type="button" className={`ink-dot${color === c ? ' on' : ''}`} aria-label={t(`sign.ink.${c}`)} aria-pressed={color === c}
            style={{ background: `rgb(${INK_COLORS[c].join(',')})` }} onClick={() => setColor(c)} />
        ))}
      </div>
      <p className="small muted" style={{ margin: 0 }}>{t('sign.privacy')}</p>
      {error && <div className="error">{error}</div>}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={busy || empty} onClick={() => void save()}>{busy ? t('common.wait') : t('sign.saveUse')}</button>
      </div>
    </Modal>
  );
}

type Bind = React.RefObject<() => Promise<HTMLCanvasElement | null>>;

function DrawPad({ kind, color, bind, onEmpty }: { kind: 'signature' | 'initials'; color: InkColor; bind: Bind; onEmpty: (e: boolean) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pad = useRef<SignaturePad | null>(null);
  useEffect(() => {
    const c = canvas.current!;
    const p = new SignaturePad(c, { minWidth: 1.2, maxWidth: 3.6, velocityFilterWeight: 0.6, penColor: `rgb(${INK_COLORS[color].join(',')})` });
    pad.current = p;
    const fit = () => {
      const data = p.toData();
      const r = Math.max(window.devicePixelRatio || 1, 2);
      c.width = c.offsetWidth * r; c.height = c.offsetHeight * r;
      c.getContext('2d')!.scale(r, r);
      p.clear(); if (data.length) p.fromData(data);
    };
    fit();
    const ro = new ResizeObserver(fit); ro.observe(c);
    p.addEventListener('endStroke', () => onEmpty(p.isEmpty()));
    bind.current = async () => (p.isEmpty() ? null : c);
    return () => { ro.disconnect(); p.off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const p = pad.current;
    if (!p) return;
    const rgb = `rgb(${INK_COLORS[color].join(',')})`;
    p.penColor = rgb;
    // Recolorea lo ya dibujado.
    const data = p.toData().map((g) => ({ ...g, penColor: rgb }));
    p.clear(); if (data.length) p.fromData(data);
  }, [color]);
  return (
    <div className={`sig-pad k-${kind}`}>
      <canvas ref={canvas} />
      <span className="sig-line" aria-hidden />
      <span className="sig-pad-hint" aria-hidden>{t('sign.drawHere')}</span>
      <button type="button" className="btn ghost small sig-clear" onClick={() => { pad.current?.clear(); onEmpty(true); }}>{t('sign.clear')}</button>
    </div>
  );
}

function TypePad({ initial, color, bind, onEmpty }: { initial: string; color: InkColor; bind: Bind; onEmpty: (e: boolean) => void }) {
  const [text, setText] = useState(initial);
  const [font, setFont] = useState<string>(SCRIPT_FONTS[0]);
  const [ready, setReady] = useState(false);
  useEffect(() => { void loadScriptFonts().then(() => setReady(true)); }, []);
  useEffect(() => { onEmpty(!text.trim()); bind.current = async () => (text.trim() ? typedCanvas(text.trim(), font, color) : null); }, [text, font, color, bind, onEmpty]);
  const ink = `rgb(${INK_COLORS[color].join(',')})`;
  return (
    <>
      <input className="input" value={text} maxLength={60} onChange={(e) => setText(e.target.value)} placeholder={t('sign.typePh')} autoFocus />
      <div className="sig-fonts" role="radiogroup" style={{ opacity: ready ? 1 : 0.5 }}>
        {SCRIPT_FONTS.map((f) => (
          <button key={f} type="button" role="radio" aria-checked={font === f} className={`sig-font${font === f ? ' on' : ''}`} onClick={() => setFont(f)}
            style={{ fontFamily: `"${f}", cursive`, color: ink }}>{text.trim() || t('sign.typePh')}</button>
        ))}
      </div>
    </>
  );
}

function PhotoPad({ color, bind, onEmpty }: { color: InkColor; bind: Bind; onEmpty: (e: boolean) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [threshold, setThreshold] = useState<number | null>(null);
  const [auto, setAuto] = useState(160);
  const [preview, setPreview] = useState<string | null>(null);
  const [keepColor, setKeepColor] = useState(false);
  const last = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!file) { onEmpty(true); return; }
    let alive = true;
    void photoCanvas(file, keepColor ? null : color, threshold).then((r) => {
      if (!alive) return;
      last.current = r.canvas; setAuto(r.auto); if (threshold === null) setThreshold(r.threshold);
      setPreview(r.canvas.toDataURL('image/png')); onEmpty(false);
    }).catch(() => { toast(t('sign.photoError')); });
    return () => { alive = false; };
  }, [file, threshold, color, keepColor, onEmpty]);
  useEffect(() => { bind.current = async () => last.current; }, [bind]);
  function pick(capture: boolean) {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    if (capture) input.setAttribute('capture', 'environment');
    input.onchange = () => { const f = input.files?.[0]; if (f) { setThreshold(null); setFile(f); } };
    input.click();
  }
  return (
    <>
      <div className="sig-photo">
        {preview ? <img src={preview} alt="" /> : <span className="muted small">{t('sign.photoHint')}</span>}
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn small only-mobile" onClick={() => pick(true)}>📷 {t('sign.takePhoto')}</button>
        <button type="button" className="btn small" onClick={() => pick(false)}>🖼 {t('sign.pickImage')}</button>
        {file && <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={keepColor} onChange={(e) => setKeepColor(e.target.checked)} /> {t('sign.keepColor')}</label>}
      </div>
      {file && threshold !== null && (
        <label className="small muted" style={{ display: 'grid', gap: 4 }}>
          {t('sign.cleanBg')}
          <input type="range" min={Math.max(40, auto - 70)} max={Math.min(250, auto + 70)} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
        </label>
      )}
    </>
  );
}

// ---------- Texto libre ----------
function TextDialog({ initial, onClose, onDone }: { initial: string; onClose: () => void; onDone: (text: string) => void }) {
  const [text, setText] = useState(initial);
  const me = useClient((s) => s.data?.me);
  const quick = [me?.name, me?.title, todayText()].filter((x): x is string => !!x);
  return (
    <Modal title={t('sign.textTitle')} onClose={onClose}>
      <input className="input" value={text} maxLength={300} autoFocus onChange={(e) => setText(e.target.value)} placeholder={t('sign.textPh')}
        onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) onDone(text.trim()); }} />
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {quick.map((q) => <button key={q} type="button" className="chip" style={{ padding: '4px 10px' }} onClick={() => setText(q)}>{q}</button>)}
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={!text.trim()} onClick={() => onDone(text.trim())}>{t('common.done')}</button>
      </div>
    </Modal>
  );
}

// ---------- Confirmar y enviar ----------
function ConfirmSign({ a, info, marks, pages, onClose, onSigned }: {
  a: AttachmentDTO; info: SignInfoDTO | null; marks: Mark[]; pages: number; onClose: () => void; onSigned: () => void;
}) {
  const [body, setBody] = useState('');
  const [stamp, setStamp] = useState(true);
  const [certificate, setCertificate] = useState(false);
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsAccept, setNeedsAccept] = useState(!!info?.hasDigitalSignature);
  const clientMessageId = useMemo(uid, []);
  // Un doble toque en «Firmar» no debe firmar sin leer: el botón se activa un instante después.
  const [armed, setArmed] = useState(false);
  useEffect(() => { const tm = setTimeout(() => setArmed(true), 600); return () => clearTimeout(tm); }, []);
  const pagesUsed = new Set(marks.map((m) => m.page)).size;
  const sigCount = marks.filter((m) => m.kind === 'signature' || m.kind === 'initials').length;

  async function go() {
    setBusy(true); setError(null);
    const placements: SignPlacementInput[] = marks.map((m) => {
      const box = { page: m.page, x: clamp(m.x, 0, 1), y: clamp(m.y, 0, 1), w: clamp(m.w, 0.004, 1 - m.x), h: clamp(m.h, 0.004, 1 - m.y) };
      return m.signatureId ? { type: 'signature', signatureId: m.signatureId, ...box } : { type: 'text', text: m.text ?? '', ...box };
    });
    try {
      await client.signPdf(a.id, {
        clientMessageId, body: body.trim(), placements, stamp, certificate, acceptBreakingSignatures: accept,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      toast(t('sign.done'));
      onSigned();
    } catch (e: any) {
      if (e?.code === 'has_digital_signature') { setNeedsAccept(true); setError(t('sign.hasDigital')); }
      else setError(errorText(e));
    } finally { setBusy(false); }
  }

  return (
    <Modal title={t('sign.confirmTitle')} onClose={onClose}>
      <p style={{ margin: 0 }}>{t('sign.summary', { name: a.name, n: sigCount, p: pagesUsed, total: pages })}</p>
      <textarea className="input" rows={2} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} placeholder={t('sign.bodyPh')} />
      <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
        <input type="checkbox" checked={stamp} onChange={(e) => setStamp(e.target.checked)} />
        <span><b>{t('sign.stamp')}</b><br /><span className="small muted">{t('sign.stampHelp')}</span></span>
      </label>
      <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
        <input type="checkbox" checked={certificate} onChange={(e) => setCertificate(e.target.checked)} />
        <span><b>{t('sign.certificate')}</b><br /><span className="small muted">{t('sign.certificateHelp')}</span></span>
      </label>
      {needsAccept && (
        <label className="row pdf-banner warn" style={{ gap: 8, alignItems: 'flex-start', borderRadius: 10 }}>
          <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
          <span>{t('sign.acceptBreak')}</span>
        </label>
      )}
      <p className="small muted" style={{ margin: 0 }}>{t('sign.legal')}</p>
      {error && <div className="error">{error}</div>}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('common.back')}</button>
        <button className="btn accent" disabled={!armed || busy || (needsAccept && !accept)} onClick={() => void go()}>{busy ? t('sign.signing') : `✍️ ${t('sign.signSend')}`}</button>
      </div>
    </Modal>
  );
}
