/**
 * GIFs y memes en el compositor (docs/GIFS.md): botón «GIF» y selector con dos pestañas.
 * - GIFs: tendencias y búsqueda (con debounce), cuadrícula de mampostería con carga perezosa y teclado.
 * - Memes: plantillas populares y un editor simple (texto arriba/abajo con letra de meme) que dibuja en canvas.
 * Todo llega por el API de chaggu (imágenes en /api/v1/gifs/media?t=…). Al enviar, el GIF queda como adjunto de
 * imagen normal (lo guarda el servidor) y el meme se sube como una foto; la atribución va en el texto del mensaje.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { AttachmentDTO, GifItemDTO, GifListDTO, SendGifResult } from '@tiecoms/contracts';
import { apiUrl, client } from '../app-client.ts';
import { openDialog } from '../actions.tsx';
import { errorText, useLang, type Lang } from '../i18n.ts';
import { toast } from '../menu.tsx';
import { MEME_FONT, fitMemeText, gridMove, masonry, memeCanvasSize, type MemeText } from '../gifs.ts';
import './gifs.css';

const S = {
  es: {
    button: 'GIF o meme', title: 'GIFs y memes', gifs: 'GIFs', memes: 'Memes', close: 'Cerrar',
    searchKlipy: 'Buscar en KLIPY', searchFree: 'Buscar GIFs libres (Wikimedia Commons)', searchLabel: 'Buscar GIFs',
    trending: 'Destacados', results: 'Resultados para «{q}»', empty: 'No encontramos GIFs para «{q}».', loading: 'Cargando…',
    more: 'Cargar más', sending: 'Enviando…', retry: 'Reintentar',
    freeNote: 'Catálogo libre y pequeño: GIFs con licencia Creative Commons. Se envía con su atribución.',
    templates: 'Plantillas populares', filter: 'Filtrar plantillas', back: '← Plantillas', top: 'Texto de arriba', bottom: 'Texto de abajo',
    size: 'Tamaño de letra', send: 'Enviar', preview: 'Vista previa del meme', memeFail: 'No se pudo cargar la plantilla.',
    keys: '↑↓←→ para moverte · Enter para enviar · Esc para cerrar',
  },
  en: {
    button: 'GIF or meme', title: 'GIFs and memes', gifs: 'GIFs', memes: 'Memes', close: 'Close',
    searchKlipy: 'Search KLIPY', searchFree: 'Search free GIFs (Wikimedia Commons)', searchLabel: 'Search GIFs',
    trending: 'Featured', results: 'Results for “{q}”', empty: 'No GIFs found for “{q}”.', loading: 'Loading…',
    more: 'Load more', sending: 'Sending…', retry: 'Retry',
    freeNote: 'Small free catalog: Creative Commons GIFs. Sent with their attribution.',
    templates: 'Popular templates', filter: 'Filter templates', back: '← Templates', top: 'Top text', bottom: 'Bottom text',
    size: 'Text size', send: 'Send', preview: 'Meme preview', memeFail: 'Could not load the template.',
    keys: '↑↓←→ to move · Enter to send · Esc to close',
  },
} satisfies Record<Lang, Record<string, string>>;
type Key = keyof typeof S.es;
const tx = (lang: Lang, k: Key, vars: Record<string, string> = {}) => S[lang][k].replace(/\{(\w+)\}/g, (_, v) => vars[v] ?? '');

export type GifSend = (attachment: AttachmentDTO, body: string) => void;
export interface GifPickerOptions { conversationId: string; query?: string; tab?: 'gifs' | 'memes'; onSend: GifSend; sessionIdentity?: string }

export function openGifPicker(opts: GifPickerOptions) {
  const sessionIdentity = client.getSessionIdentity();
  openDialog((close) => <GifPicker {...opts} sessionIdentity={sessionIdentity} onClose={close} />);
}

/** Botón «GIF» del compositor (junto al emoji). */
export function GifButton({ conversationId, onSend, disabled }: { conversationId: string; onSend: GifSend; disabled?: boolean }) {
  const lang = useLang();
  return (
    <button type="button" className="bring-btn gif-btn" title={tx(lang, 'button')} aria-label={tx(lang, 'button')} aria-haspopup="dialog" disabled={disabled}
      onClick={() => openGifPicker({ conversationId, onSend })}>GIF</button>
  );
}

export function GifPicker({ conversationId, query: initialQuery = '', tab: initialTab = 'gifs', onSend, onClose, sessionIdentity = client.getSessionIdentity() }: GifPickerOptions & { onClose: () => void }) {
  const lang = useLang();
  const [tab, setTab] = useState<'gifs' | 'memes'>(initialTab);
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState<GifItemDTO | null>(null);
  const inFlight = useRef(false);
  const currentSession = () => client.getSessionIdentity() === sessionIdentity;
  useEffect(() => {
    const check = () => { if (client.getSessionIdentity() !== sessionIdentity) onClose(); };
    check();
    return client.subscribe(check);
  }, [sessionIdentity, onClose]);
  // Esc: primero sale del editor; si no, cierra.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || sending) return;
      e.preventDefault(); e.stopPropagation();
      if (editing) setEditing(null); else onClose();
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [editing, onClose, sending]);

  const sendGif = async (item: GifItemDTO) => {
    if (inFlight.current || !currentSession()) return;
    inFlight.current = true;
    setSending(true);
    try {
      const r = await client.request<SendGifResult>(`/conversations/${conversationId}/gifs`, { method: 'POST', json: { url: item.url } });
      if (!currentSession()) { onClose(); return; }
      onSend(r.attachment, r.attribution ?? '');
      onClose();
    } catch (e) { inFlight.current = false; if (!currentSession()) { onClose(); return; } toast(errorText(e)); setSending(false); }
  };
  const sendMeme = async (blob: Blob, name: string) => {
    if (inFlight.current || !currentSession()) return;
    inFlight.current = true;
    setSending(true);
    try {
      const att = await client.uploadAttachment(conversationId, blob, name);
      if (!currentSession()) { onClose(); return; }
      onSend(att, editing?.attribution ?? '');
      onClose();
    } catch (e) { inFlight.current = false; if (!currentSession()) { onClose(); return; } toast(errorText(e)); setSending(false); }
  };

  const tabs = (['gifs', 'memes'] as const);
  const onTabKey = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = tab === 'gifs' ? 'memes' : 'gifs';
    setTab(next); setEditing(null);
    requestAnimationFrame(() => document.getElementById(`gif-tab-${next}`)?.focus());
  };
  if (!currentSession()) return null;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !sending && onClose()}>
      <div className="modal gif-modal" role="dialog" aria-modal="true" aria-label={tx(lang, 'title')} aria-busy={sending}>
        <div className="gif-head">
          <div className="gif-tabs" role="tablist" aria-label={tx(lang, 'title')} onKeyDown={onTabKey}>
            {tabs.map((k) => (
              <button key={k} id={`gif-tab-${k}`} role="tab" type="button" aria-selected={tab === k} aria-controls={`gif-panel-${k}`} tabIndex={tab === k ? 0 : -1}
                className={tab === k ? 'on' : ''} onClick={() => { setTab(k); setEditing(null); }}>{tx(lang, k)}</button>
            ))}
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={tx(lang, 'close')} disabled={sending}>×</button>
        </div>
        <div id={`gif-panel-${tab}`} role="tabpanel" aria-labelledby={`gif-tab-${tab}`} className="gif-panel">
          {tab === 'gifs'
            ? <GifSearch lang={lang} initialQuery={initialQuery} onPick={sendGif} disabled={sending} />
            : editing
              ? <MemeEditor lang={lang} template={editing} onBack={() => setEditing(null)} onSend={sendMeme} busy={sending} />
              : <MemeTemplates lang={lang} onPick={setEditing} />}
        </div>
        {sending && <div className="gif-sending" role="status">{tx(lang, 'sending')}</div>}
      </div>
    </div>
  );
}

// ---------- GIFs ----------
function GifSearch({ lang, initialQuery, onPick, disabled }: { lang: Lang; initialQuery: string; onPick: (g: GifItemDTO) => void; disabled: boolean }) {
  const [q, setQ] = useState(initialQuery);
  const [debounced, setDebounced] = useState(initialQuery.trim());
  const [list, setList] = useState<GifListDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const seq = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const grid = useRef<MasonryHandle>(null);

  useEffect(() => { const h = setTimeout(() => setDebounced(q.trim()), 350); return () => clearTimeout(h); }, [q]);
  useEffect(() => { input.current?.focus(); }, []);
  const fetchPage = useCallback(async (cursor: string | null) => {
    const id = ++seq.current;
    setLoading(true); setError(null);
    const p = new URLSearchParams({ lang, ...(debounced ? { q: debounced } : {}), ...(cursor ? { cursor } : {}) });
    try {
      const r = await client.request<GifListDTO>(`/gifs/${debounced ? 'search' : 'trending'}?${p}`);
      if (id !== seq.current) return;
      setList((prev) => (cursor && prev ? { ...r, items: dedupe([...prev.items, ...r.items]) } : r));
    } catch (e) {
      if (id === seq.current) setError(errorText(e));
    } finally { if (id === seq.current) setLoading(false); }
  }, [debounced, lang]);
  useEffect(() => { setList(null); void fetchPage(null); }, [fetchPage, reload]);

  const provider = list?.provider;
  const placeholder = provider === 'klipy' ? tx(lang, 'searchKlipy') : provider === 'openverse' ? tx(lang, 'searchFree') : tx(lang, 'searchLabel');
  return (
    <>
      <input ref={input} className="input gif-search" type="search" value={q} placeholder={placeholder} aria-label={tx(lang, 'searchLabel')}
        maxLength={100} disabled={disabled} enterKeyHint="search"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); grid.current?.focus(0); }
          if (e.key === 'Enter' && list?.items[0] && debounced === q.trim()) { e.preventDefault(); onPick(list.items[0]); }
        }} />
      <div className="gif-sub" aria-live="polite">
        <span>{debounced ? tx(lang, 'results', { q: debounced }) : tx(lang, 'trending')}</span>
        {loading && <span className="hint">{tx(lang, 'loading')}</span>}
      </div>
      {error
        ? <div className="empty gif-empty">{error} <button type="button" className="btn small" onClick={() => setReload((n) => n + 1)}>{tx(lang, 'retry')}</button></div>
        : list && !list.items.length && !loading
          ? <div className="empty gif-empty">{tx(lang, 'empty', { q: debounced })}</div>
          : <Masonry ref={grid} items={list?.items ?? []} label={debounced ? tx(lang, 'results', { q: debounced }) : tx(lang, 'trending')} onPick={onPick} disabled={disabled}
              onEnd={list?.next && !loading ? () => void fetchPage(list.next) : undefined} onExitTop={() => input.current?.focus()} />}
      <div className="gif-foot">
        {provider === 'openverse' && <span className="hint">{tx(lang, 'freeNote')}</span>}
        <span className="hint gif-keys">{tx(lang, 'keys')}</span>
        {list?.poweredBy && <a className="gif-powered" href={list.poweredBy.url} target="_blank" rel="noopener noreferrer">{list.poweredBy.label}</a>}
      </div>
    </>
  );
}

const dedupe = (items: GifItemDTO[]) => { const seen = new Set<string>(); return items.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true))); };

interface MasonryHandle { focus: (i: number) => void }
/** Cuadrícula de mampostería con posiciones absolutas; flechas para moverse, Enter para elegir, carga perezosa. */
const Masonry = forwardRef<MasonryHandle, { items: GifItemDTO[]; label: string; onPick: (g: GifItemDTO) => void; onEnd?: () => void; onExitTop?: () => void; disabled?: boolean }>(
  function Masonry({ items: all, label, onPick, onEnd, onExitTop, disabled }, ref) {
    // Imágenes que no cargan (el proveedor las borró o no tiene miniatura): se quitan de la cuadrícula.
    const [broken, setBroken] = useState<ReadonlySet<string>>(new Set());
    const items = useMemo(() => all.filter((i) => !broken.has(i.id)), [all, broken]);
    const box = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(0);
    const [active, setActive] = useState(0);
    useLayoutEffect(() => {
      const el = box.current;
      if (!el) return;
      setWidth(el.clientWidth);
      const ro = new ResizeObserver(() => setWidth(el.clientWidth));
      ro.observe(el);
      return () => ro.disconnect();
    }, []);
    const gap = 6;
    const cols = width && width < 360 ? 2 : 3;
    const colWidth = width ? (width - gap * (cols - 1)) / cols : 0;
    const layout = useMemo(() => masonry(items, cols, colWidth || 1, gap), [items, cols, colWidth]);
    const focus = (i: number) => {
      if (!items.length) return;
      const n = Math.max(0, Math.min(items.length - 1, i));
      setActive(n);
      const el = box.current?.querySelector<HTMLElement>(`[data-i="${n}"]`);
      el?.focus();
      el?.scrollIntoView({ block: 'nearest' });
    };
    useImperativeHandle(ref, () => ({ focus }), [items]);
    useEffect(() => { if (active >= items.length) setActive(0); }, [items.length]);
    // Carga perezosa: cuando el final entra en pantalla, la página siguiente.
    const end = useRef<HTMLDivElement>(null);
    useEffect(() => {
      if (!onEnd || !end.current) return;
      const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) onEnd(); }, { root: box.current?.parentElement ?? null, rootMargin: '200px' });
      io.observe(end.current);
      return () => io.disconnect();
    }, [onEnd]);
    const onKey = (e: ReactKeyboardEvent) => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const next = gridMove(layout.tiles, active, e.key);
      if (e.key === 'ArrowUp' && next === active && onExitTop) { onExitTop(); return; }
      focus(next);
      if (next >= items.length - 4) onEnd?.();
    };
    return (
      <div className="gif-scroll">
        <div ref={box} className="gif-grid" role="listbox" aria-label={label} style={{ height: layout.height }} onKeyDown={onKey}>
          {width > 0 && layout.tiles.map((tile) => {
            const g = items[tile.index]!;
            return (
              <button key={g.id} type="button" role="option" aria-selected={tile.index === active} data-i={tile.index} tabIndex={tile.index === active ? 0 : -1}
                className="gif-tile" disabled={disabled} title={g.attribution ?? g.title} aria-label={g.title}
                style={{ left: tile.col * (colWidth + gap), top: tile.top, width: colWidth, height: tile.height }}
                onFocus={() => setActive(tile.index)} onClick={() => onPick(g)}>
                <img src={apiUrl(g.previewUrl)} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBroken((b) => new Set(b).add(g.id))} />
              </button>
            );
          })}
        </div>
        <div ref={end} className="gif-end" aria-hidden />
      </div>
    );
  });

// ---------- Memes ----------
function MemeTemplates({ lang, onPick }: { lang: Lang; onPick: (g: GifItemDTO) => void }) {
  const [list, setList] = useState<GifListDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [reload, setReload] = useState(0);
  const grid = useRef<MasonryHandle>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let alive = true;
    setError(null);
    client.request<GifListDTO>('/memes/templates').then((r) => alive && setList(r)).catch((e) => alive && setError(errorText(e)));
    return () => { alive = false; };
  }, [reload]);
  useEffect(() => { input.current?.focus(); }, []);
  const items = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (list?.items ?? []).filter((i) => !f || i.title.toLowerCase().includes(f));
  }, [list, filter]);
  return (
    <>
      <input ref={input} className="input gif-search" type="search" value={filter} placeholder={tx(lang, 'filter')} aria-label={tx(lang, 'filter')} maxLength={60}
        onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); grid.current?.focus(0); } if (e.key === 'Enter' && items[0]) { e.preventDefault(); onPick(items[0]); } }} />
      <div className="gif-sub"><span>{tx(lang, 'templates')}</span>{!list && !error && <span className="hint">{tx(lang, 'loading')}</span>}</div>
      {error
        ? <div className="empty gif-empty">{error} <button type="button" className="btn small" onClick={() => setReload((n) => n + 1)}>{tx(lang, 'retry')}</button></div>
        : <Masonry ref={grid} items={items} label={tx(lang, 'templates')} onPick={onPick} onExitTop={() => input.current?.focus()} />}
      <div className="gif-foot"><span className="hint gif-keys">{tx(lang, 'keys')}</span>{list?.poweredBy && <a className="gif-powered" href={list.poweredBy.url} target="_blank" rel="noopener noreferrer">{list.poweredBy.label}</a>}</div>
    </>
  );
}

/** Letra de meme: Impact si el sistema la tiene; si no, Anton (Google Fonts, OFL), que se carga al abrir el editor. */
let memeFont: Promise<void> | null = null;
function loadMemeFont() {
  memeFont ??= (async () => {
    const href = 'https://fonts.googleapis.com/css2?family=Anton&display=swap';
    if (!document.querySelector(`link[href="${href}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = href;
      document.head.appendChild(link);
      await new Promise((r) => { link.onload = r; link.onerror = r; setTimeout(r, 3000); });
    }
    await document.fonts?.load('48px Anton').catch(() => []);
  })();
  return memeFont;
}

function MemeEditor({ lang, template, onBack, onSend, busy }: { lang: Lang; template: GifItemDTO; onBack: () => void; onSend: (b: Blob, name: string) => void; busy: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<ImageBitmap | HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [text, setText] = useState<MemeText>({ top: '', bottom: '', scale: 1 });
  const topRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    let alive = true;
    // Por fetch (no <img> directo al canvas): así el lienzo no queda «contaminado» y se puede exportar, también en Tauri.
    (async () => {
      await loadMemeFont();
      const res = await fetch(apiUrl(template.url));
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const bmp = typeof createImageBitmap === 'function' ? await createImageBitmap(blob) : await new Promise<HTMLImageElement>((ok, ko) => {
        const i = new Image(); i.onload = () => ok(i); i.onerror = ko; i.src = URL.createObjectURL(blob);
      });
      if (alive) setImg(bmp);
    })().catch(() => alive && setFailed(true));
    requestAnimationFrame(() => topRef.current?.focus());
    return () => { alive = false; };
  }, [template.url]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !img) return;
    const size = memeCanvasSize(img.width, img.height);
    c.width = size.width; c.height = size.height;
    drawMeme(c.getContext('2d')!, img, size.width, size.height, text);
  }, [img, text]);

  const send = () => {
    const c = canvas.current;
    if (!c || !img || busy) return;
    c.toBlob((b) => { if (b) onSend(b, `meme-${template.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'chaggu'}.jpg`); }, 'image/jpeg', 0.9);
  };
  const canSend = !!img && !busy && !!(text.top.trim() || text.bottom.trim());
  const field = (k: 'top' | 'bottom') => (
    <label className="field meme-field">
      <span>{tx(lang, k)}</span>
      <textarea ref={k === 'top' ? topRef : undefined} className="input" rows={2} maxLength={120} value={text[k]} disabled={busy}
        onChange={(e) => setText((x) => ({ ...x, [k]: e.target.value }))}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} />
    </label>
  );
  return (
    <div className="meme-editor">
      <div className="meme-stage">
        {failed ? <div className="empty">{tx(lang, 'memeFail')}</div>
          : <canvas ref={canvas} className="meme-canvas" role="img" aria-label={`${tx(lang, 'preview')}: ${template.title}. ${text.top} ${text.bottom}`.trim()}
              style={{ aspectRatio: `${template.width} / ${template.height}` }} />}
      </div>
      <div className="meme-form">
        <div className="meme-name" title={template.title}>{template.title}</div>
        {template.sourceUrl && <a href={template.sourceUrl} target="_blank" rel="noopener noreferrer">{lang === 'es' ? 'Fuente de la plantilla' : 'Template source'}</a>}
        {field('top')}
        {field('bottom')}
        <label className="field meme-field">
          <span>{tx(lang, 'size')} · {Math.round(text.scale * 100)}%</span>
          <input type="range" min={60} max={160} step={5} value={Math.round(text.scale * 100)} disabled={busy}
            onChange={(e) => setText((x) => ({ ...x, scale: Number(e.target.value) / 100 }))} />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onBack} disabled={busy}>{tx(lang, 'back')}</button>
          <button type="button" className="btn primary" onClick={send} disabled={!canSend}>{tx(lang, 'send')}</button>
        </div>
      </div>
    </div>
  );
}

/** Dibuja la plantilla y los dos textos (mayúsculas, relleno blanco, borde negro), como un meme clásico. */
export function drawMeme(ctx: CanvasRenderingContext2D, img: CanvasImageSource, w: number, h: number, text: MemeText) {
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const measureAt = (s: string, px: number) => { ctx.font = `${px}px ${MEME_FONT}`; return ctx.measureText(s).width; };
  const block = (value: string, where: 'top' | 'bottom') => {
    if (!value.trim()) return;
    const { size, lines } = fitMemeText(value, w, h, text.scale, measureAt);
    ctx.font = `${size}px ${MEME_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = Math.max(2, size / 7);
    ctx.strokeStyle = '#000';
    ctx.fillStyle = '#fff';
    const lh = size * 1.08;
    const pad = Math.round(h * 0.03);
    const y0 = where === 'top' ? pad : h - pad - lines.length * lh;
    lines.forEach((l, i) => {
      const y = y0 + i * lh;
      ctx.strokeText(l, w / 2, y);
      ctx.fillText(l, w / 2, y);
    });
  };
  block(text.top, 'top');
  block(text.bottom, 'bottom');
}
