import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// El selector no toca red al pintarse (los datos llegan en efectos); el cliente se simula igual.
vi.mock('../src/app-client.ts', () => ({ apiUrl: (p: string) => p, client: { request: vi.fn(), uploadAttachment: vi.fn(), getSessionIdentity: () => 'test-session', subscribe: () => () => {} } }));
vi.mock('../src/actions.tsx', () => ({ openDialog: vi.fn() }));
vi.mock('../src/menu.tsx', () => ({ toast: vi.fn() }));
// useSyncExternalStore sin getServerSnapshot no pinta en el servidor: el idioma se lee directo.
vi.mock('../src/i18n.ts', async (importOriginal) => { const m: any = await importOriginal(); return { ...m, useLang: () => m.getLang() }; });

// i18n.ts marca el idioma en <html> al cargar.
(globalThis as any).document ??= { documentElement: {} };

const { fitMemeText, gridMove, masonry, memeCanvasSize, parseGifCommand, wrapLines } = await import('../src/gifs.ts');
const { GifButton, GifPicker, openGifPicker } = await import('../src/screens/Gifs.tsx');
const { openDialog } = await import('../src/actions.tsx');
const { setLang } = await import('../src/i18n.ts');

describe('comando /gif', () => {
  it('reconoce /gif con y sin búsqueda', () => {
    expect(parseGifCommand('/gif gato')).toBe('gato');
    expect(parseGifCommand('  /GIF   gato   feliz ')).toBe('gato feliz');
    expect(parseGifCommand('/gif')).toBe('');
    expect(parseGifCommand('/gifs perro')).toBe('perro');
  });
  it('no confunde otros textos', () => {
    expect(parseGifCommand('mira este /gif gato')).toBeNull();
    expect(parseGifCommand('/gifted')).toBeNull();
    expect(parseGifCommand('/giphy gato')).toBeNull();
    expect(parseGifCommand('gif gato')).toBeNull();
  });
});

describe('mampostería y teclado', () => {
  // 3 columnas de 100 px: altos 100, 50, 200, 100, 100, 50.
  const sizes = [{ width: 100, height: 100 }, { width: 200, height: 100 }, { width: 100, height: 200 }, { width: 100, height: 100 }, { width: 100, height: 100 }, { width: 100, height: 50 }];
  const { tiles, height } = masonry(sizes, 3, 100, 6);
  it('cada ítem va a la columna más baja', () => {
    expect(tiles.map((t) => t.col)).toEqual([0, 1, 2, 1, 0, 1]);
    expect(tiles.map((t) => t.top)).toEqual([0, 0, 0, 56, 106, 162]);
    expect(height).toBe(212);
  });
  it('↑↓ dentro de la columna, ←→ a la vecina más cercana en vertical', () => {
    expect(gridMove(tiles, 0, 'ArrowDown')).toBe(4);
    expect(gridMove(tiles, 4, 'ArrowUp')).toBe(0);
    expect(gridMove(tiles, 0, 'ArrowUp')).toBe(0); // arriba del todo: se queda (el selector vuelve al buscador)
    expect(gridMove(tiles, 4, 'ArrowRight')).toBe(5); // centro 156: el 5 (187) queda más cerca que el 3 (106)
    expect(gridMove(tiles, 0, 'ArrowRight')).toBe(1);
    expect(gridMove(tiles, 3, 'ArrowRight')).toBe(2);
    expect(gridMove(tiles, 2, 'ArrowRight')).toBe(2); // última columna
    expect(gridMove(tiles, 5, 'ArrowLeft')).toBe(4);
    expect(gridMove(tiles, 3, 'End')).toBe(5);
    expect(gridMove(tiles, 3, 'Home')).toBe(0);
    expect(gridMove([], 0, 'ArrowDown')).toBe(-1);
  });
});

describe('texto del meme', () => {
  const measure = (s: string, px: number) => s.length * px * 0.5; // letra condensada simulada
  it('mayúsculas y renglones que caben', () => {
    expect(wrapLines('cuando el cliente pide un cambio', 100, (s) => s.length * 10)).toEqual(['CUANDO EL', 'CLIENTE', 'PIDE UN', 'CAMBIO']);
  });
  it('baja la letra hasta que quepa en 3 renglones', () => {
    const short = fitMemeText('hola', 600, 600, 1, measure);
    const long = fitMemeText('cuando despliegas el viernes a las cinco y nadie revisó el pull request', 600, 600, 1, measure);
    expect(short.lines).toEqual(['HOLA']);
    expect(long.lines.length).toBeLessThanOrEqual(3);
    expect(long.size).toBeLessThan(short.size);
    for (const l of long.lines) expect(measure(l, long.size)).toBeLessThanOrEqual(600 * 0.92);
    expect(fitMemeText('hola', 600, 600, 1.5, measure).size).toBeGreaterThan(short.size);
  });
  it('lienzo de hasta 800 px de ancho', () => {
    expect(memeCanvasSize(1200, 900)).toEqual({ width: 800, height: 600 });
    expect(memeCanvasSize(500, 400)).toEqual({ width: 500, height: 400 });
  });
});

describe('selector de GIFs', () => {
  it('un selector de otra sesión no muestra ni usa el chat anterior', () => {
    expect(renderToStaticMarkup(<GifPicker conversationId="old-chat" sessionIdentity="previous-session" onSend={() => { throw new Error('stale send'); }} onClose={() => {}} />)).toBe('');
  });
  it('botón GIF accesible que abre el selector', () => {
    setLang('es');
    const html = renderToStaticMarkup(<GifButton conversationId="c1" onSend={() => {}} />);
    expect(html).toContain('aria-label="GIF o meme"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('>GIF</button>');
    openGifPicker({ conversationId: 'c1', query: 'gato', onSend: () => {} });
    expect(openDialog).toHaveBeenCalledTimes(1);
  });
  it('diálogo con pestañas GIFs y Memes; /gif gato llega como búsqueda inicial', () => {
    setLang('es');
    const html = renderToStaticMarkup(<GifPicker conversationId="c1" query="gato" onSend={() => {}} onClose={() => {}} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>GIFs</);
    expect(html).toMatch(/role="tab"[^>]*aria-selected="false"[^>]*>Memes</);
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('value="gato"');
    expect(html).toContain('Resultados para «gato»');
    expect(html).toContain('role="listbox"');
  });
  it('pestaña Memes y textos en inglés', () => {
    setLang('en');
    const html = renderToStaticMarkup(<GifPicker conversationId="c1" tab="memes" onSend={() => {}} onClose={() => {}} />);
    expect(html).toMatch(/aria-selected="true"[^>]*>Memes</);
    expect(html).toContain('Popular templates');
    expect(html).toContain('placeholder="Filter templates"');
    setLang('es');
  });
});
