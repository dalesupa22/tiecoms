/**
 * GIFs y memes (docs/GIFS.md): normalización de cada proveedor con respuestas simuladas y lista de hosts
 * permitidos del proxy. No necesita API ni base.
 */
import { describe, expect, it } from 'vitest';
import {
  cleanTitle, gifFileName, isAllowedMediaUrl, klipyUrl, licenseLabel, normalizeMemegen, normalizeKlipy, normalizeOpenverse, openverseUrl, wikimediaThumb,
  type Mint,
} from '../src/modules/gif-providers.ts';

// El token real va cifrado; aquí basta con ver qué URL y qué atribución se sellaron.
const minted: { provider: string; url: string; kind: string; attribution: string | null }[] = [];
const mint: Mint = (provider, url, kind, attribution) => { minted.push({ provider, url, kind, attribution }); return `/api/v1/gifs/media/${minted.length - 1}`; };
const sealed = (u: string) => minted[Number(u.split('/').pop())]!;

// Respuesta de KLIPY (API compatible con Tenor v2), recortada.
const KLIPY = {
  results: [
    {
      id: '8123', title: 'Gato bailando', content_description: 'cat dance', itemurl: 'https://klipy.com/gifs/gato-bailando-8123',
      media_formats: {
        tinygif: { url: 'https://static.klipy.com/ii/t/gato.gif', dims: [220, 180], size: 90_000 },
        mediumgif: { url: 'https://static.klipy.com/ii/m/gato.gif', dims: [400, 327], size: 700_000 },
        gif: { url: 'https://static.klipy.com/ii/g/gato.gif', dims: [498, 407], size: 2_100_000 },
      },
    },
    // gif enorme: se envía mediumgif.
    {
      id: '9', title: '', content_description: 'Dancing dog',
      media_formats: {
        tinygif: { url: 'https://static.klipy.com/t/dog.gif', dims: [220, 124] },
        mediumgif: { url: 'https://static.klipy.com/m/dog.gif', dims: [480, 270], size: 1_000_000 },
        gif: { url: 'https://static.klipy.com/g/dog.gif', dims: [1280, 720], size: 22_000_000 },
      },
    },
    // Archivo en un host que no es de KLIPY: se descarta.
    { id: 'x', title: 'Malo', media_formats: { tinygif: { url: 'https://evil.example/a.gif', dims: [1, 1] }, gif: { url: 'http://169.254.169.254/latest', dims: [1, 1] } } },
    // Sin dimensiones: se descarta.
    { id: 'y', title: 'Sin tamaño', media_formats: { tinygif: { url: 'https://static.klipy.com/y.gif' } } },
  ],
  next: 'CAgQ3g',
};

const OPENVERSE = {
  result_count: 156, page_count: 8, page_size: 20, page: 1,
  results: [
    {
      id: '8761dce2', title: 'Cat fall 150x300 6fps', url: 'https://upload.wikimedia.org/wikipedia/commons/7/78/Cat_fall_150x300_6fps.gif',
      creator: 'Eyytee', license: 'by-sa', license_version: '3.0', foreign_landing_url: 'https://commons.wikimedia.org/w/index.php?curid=16977329',
      filesize: 402_659, filetype: 'gif', width: 150, height: 298, mature: false,
    },
    {
      id: 'b1', title: 'File:Cat_Laptop.gif', url: 'https://upload.wikimedia.org/wikipedia/commons/d/d6/Cat_Laptop.gif',
      creator: 'No machine-readable author provided. Idil assumed (based on copyright claims).', license: 'cc0', license_version: '1.0',
      foreign_landing_url: 'https://commons.wikimedia.org/w/index.php?curid=1', filesize: 585_204, width: 2048, height: 2048, mature: false,
    },
    // Licencia no comercial, host de Flickr, contenido para adultos y archivo enorme: fuera.
    { id: 'nc', title: 'NC', url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/nc.gif', license: 'by-nc', width: 10, height: 10 },
    { id: 'fl', title: 'Flickr', url: 'https://live.staticflickr.com/1/a.gif', license: 'by', width: 10, height: 10 },
    { id: 'm', title: 'Mature', url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/m.gif', license: 'by', width: 10, height: 10, mature: true },
    { id: 'big', title: 'Big', url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/big.gif', license: 'by', width: 10, height: 10, filesize: 40_000_000 },
  ],
};

const MEMEGEN = [
  { id: 'drake', name: 'Drake Hotline Bling', lines: 2, blank: 'https://api.memegen.link/images/drake.jpg' },
  { id: 'trio', name: 'Tres cajas', lines: 3, blank: 'https://api.memegen.link/images/trio.png' },
  { id: 'evil', name: 'Otro host', lines: 2, blank: 'https://evil.example/images/x.jpg' },
  { id: 'gifx', name: 'Animada', lines: 2, blank: 'https://api.memegen.link/images/gifx.gif' },
  { id: 'raro', name: 'Otra ruta', lines: 2, blank: 'https://api.memegen.link/templates/raro.jpg' },
];

describe('hosts permitidos del proxy de GIFs', () => {
  it('solo https en los hosts de cada proveedor', () => {
    expect(isAllowedMediaUrl('klipy', 'https://static.klipy.com/a.gif')).toBe(true);
    expect(isAllowedMediaUrl('klipy', 'https://klipy.com/a.gif')).toBe(true);
    expect(isAllowedMediaUrl('klipy', 'https://klipy.com.evil.example/a.gif')).toBe(false);
    expect(isAllowedMediaUrl('klipy', 'https://evilklipy.com/a.gif')).toBe(false);
    expect(isAllowedMediaUrl('klipy', 'http://static.klipy.com/a.gif')).toBe(false);
    expect(isAllowedMediaUrl('klipy', 'https://static.klipy.com:8443/a.gif')).toBe(false);
    expect(isAllowedMediaUrl('klipy', 'https://user:pw@static.klipy.com/a.gif')).toBe(false);
    expect(isAllowedMediaUrl('openverse', 'https://upload.wikimedia.org/wikipedia/commons/7/78/a.gif')).toBe(true);
    expect(isAllowedMediaUrl('openverse', 'https://upload.wikimedia.org/other/a.gif')).toBe(false);
    expect(isAllowedMediaUrl('openverse', 'https://static.klipy.com/a.gif')).toBe(false);
    expect(isAllowedMediaUrl('memegen', 'https://api.memegen.link/images/drake.jpg')).toBe(true);
    expect(isAllowedMediaUrl('memegen', 'https://127.0.0.1/30b1gx.jpg')).toBe(false);
    expect(isAllowedMediaUrl('memegen', 'https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isAllowedMediaUrl('memegen', 'file:///etc/passwd')).toBe(false);
    expect(isAllowedMediaUrl('memegen', 'no es url')).toBe(false);
  });
});

describe('KLIPY', () => {
  it('arma la petición con filtro de contenido medio, idioma y cursor', () => {
    const u = new URL(klipyUrl('search', 'CLAVE', { q: 'gato', lang: 'es', cursor: 'CAgQ', customerId: 'h1' }));
    expect(u.origin + u.pathname).toBe('https://api.klipy.com/v2/search');
    expect(u.searchParams.get('contentfilter')).toBe('medium');
    expect(u.searchParams.get('locale')).toBe('es_CO');
    expect(u.searchParams.get('q')).toBe('gato');
    expect(u.searchParams.get('pos')).toBe('CAgQ');
    expect(u.searchParams.get('key')).toBe('CLAVE');
    const tr = new URL(klipyUrl('trending', 'K', { lang: 'en', customerId: 'h' }));
    expect(tr.pathname).toBe('/v2/featured');
    expect(tr.searchParams.get('locale')).toBe('en_US');
    expect(tr.searchParams.has('q')).toBe(false);
  });
  it('normaliza, prefiere un gif liviano para enviar y descarta hosts ajenos', () => {
    minted.length = 0;
    const r = normalizeKlipy(KLIPY, mint);
    expect(r.next).toBe('CAgQ3g');
    expect(r.items.map((i) => i.id)).toEqual(['klipy:8123', 'klipy:9']);
    const [cat, dog] = r.items as [any, any];
    expect(cat).toMatchObject({ provider: 'klipy', title: 'Gato bailando', width: 498, height: 407, attribution: 'GIF vía KLIPY', sourceUrl: 'https://klipy.com/gifs/gato-bailando-8123' });
    expect(cat.previewUrl).toMatch(/^\/api\/v1\/gifs\/media\//);
    expect(sealed(cat.previewUrl)).toMatchObject({ url: 'https://static.klipy.com/ii/t/gato.gif', kind: 'p', attribution: null });
    expect(sealed(cat.url)).toMatchObject({ url: 'https://static.klipy.com/ii/g/gato.gif', kind: 'f', attribution: 'GIF vía KLIPY' });
    expect(dog.title).toBe('Dancing dog');
    expect(sealed(dog.url).url).toBe('https://static.klipy.com/m/dog.gif');
    expect([dog.width, dog.height]).toEqual([480, 270]);
    expect(minted.some((m) => m.url.includes('evil') || m.url.includes('169.254'))).toBe(false);
  });
  it('sin resultados no hay página siguiente', () => {
    expect(normalizeKlipy({ results: [], next: 'x' }, mint)).toEqual({ items: [], next: null });
    expect(normalizeKlipy(null, mint)).toEqual({ items: [], next: null });
  });
});

describe('Openverse (Wikimedia Commons)', () => {
  it('pide solo GIFs de Wikimedia con licencias libres y sin contenido adulto', () => {
    const u = new URL(openverseUrl({ q: 'gato', page: 2 }));
    expect(u.hostname).toBe('api.openverse.org');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ q: 'gato', extension: 'gif', source: 'wikimedia', license: 'by,by-sa,cc0,pdm', mature: 'false', page_size: '20', page: '2' });
  });
  it('normaliza con atribución CC y miniaturas animadas de Wikimedia', () => {
    minted.length = 0;
    const r = normalizeOpenverse(OPENVERSE, mint, 1);
    expect(r.items.map((i) => i.id)).toEqual(['openverse:8761dce2', 'openverse:b1']);
    expect(r.next).toBe(null); // menos de 20 resultados en la página
    const [fall, laptop] = r.items as [any, any];
    expect(fall.attribution).toContain('CC BY-SA 3.0');
    expect(fall.attribution).toContain('Fuente: https://commons.wikimedia.org/w/index.php?curid=16977329');
    expect(fall.attribution).toContain('Licencia: https://creativecommons.org/licenses/by-sa/3.0/');
    expect(fall.sourceUrl).toBe('https://commons.wikimedia.org/w/index.php?curid=16977329');
    // Más angosto que la miniatura: se usa el original.
    expect(sealed(fall.url).url).toBe('https://upload.wikimedia.org/wikipedia/commons/7/78/Cat_fall_150x300_6fps.gif');
    expect([fall.width, fall.height]).toEqual([150, 298]);
    expect(laptop.title).toBe('Cat Laptop');
    expect(laptop.attribution).toContain('CC0');
    expect(laptop.attribution).toContain('https://creativecommons.org/publicdomain/zero/1.0/');
    expect(sealed(laptop.previewUrl).url).toBe('https://upload.wikimedia.org/wikipedia/commons/thumb/d/d6/Cat_Laptop.gif/250px-Cat_Laptop.gif');
    expect(sealed(laptop.url).url).toBe('https://upload.wikimedia.org/wikipedia/commons/thumb/d/d6/Cat_Laptop.gif/500px-Cat_Laptop.gif');
    expect([laptop.width, laptop.height]).toEqual([500, 500]);
  });
  it('página siguiente cuando la página vino llena', () => {
    const full = { page_count: 3, results: Array.from({ length: 20 }, (_, i) => ({ ...OPENVERSE.results[0], id: `i${i}` })) };
    expect(normalizeOpenverse(full, mint, 1).next).toBe('2');
    expect(normalizeOpenverse(full, mint, 3).next).toBe(null);
  });
  it('etiquetas de licencia y títulos', () => {
    expect(licenseLabel('by', '4.0')).toBe('CC BY 4.0');
    expect(licenseLabel('pdm', '1.0')).toBe('Dominio público');
    expect(cleanTitle('File:Floss_(dance).gif')).toBe('Floss (dance)');
    expect(wikimediaThumb('https://upload.wikimedia.org/wikipedia/commons/x/yz/a.gif', 250, 2000)).toBe('https://upload.wikimedia.org/wikipedia/commons/x/yz/a.gif');
  });
});

describe('memegen.link (plantillas de memes)', () => {
  it('normaliza plantillas con vista previa liviana y número de cajas; ignora hosts y rutas ajenas', () => {
    minted.length = 0;
    const items = normalizeMemegen(MEMEGEN, mint);
    expect(items.map((i) => i.id)).toEqual(['memegen:drake', 'memegen:trio']);
    expect(items[0]).toMatchObject({ provider: 'memegen', title: 'Drake Hotline Bling', boxCount: 2, attribution: 'Meme «Drake Hotline Bling» · vía memegen.link' });
    expect(sealed(items[0]!.previewUrl).url).toBe('https://api.memegen.link/images/drake.jpg?width=300');
    expect(sealed(items[0]!.url).url).toBe('https://api.memegen.link/images/drake.jpg?width=800');
    expect(items[1]!.boxCount).toBe(3);
  });
  it('solo permite imágenes de memegen.link', () => {
    expect(isAllowedMediaUrl('memegen', 'https://api.memegen.link/templates/x.jpg')).toBe(false);
    expect(isAllowedMediaUrl('memegen', 'http://api.memegen.link/images/x.jpg')).toBe(false);
    expect(isAllowedMediaUrl('memegen', 'https://api.memegen.link.evil.com/images/x.jpg')).toBe(false);
  });
  it('mantiene IDs únicos cuando variantes del catálogo comparten la imagen base', () => {
    const items = normalizeMemegen([
      { name: 'Primera plantilla', blank: 'https://api.memegen.link/images/drake.jpg' },
      { name: 'Variante repetida', blank: 'https://api.memegen.link/images/drake.png' },
      { name: 'Otra repetida', blank: 'https://api.memegen.link/images/DRAKE.jpg' },
      { name: 'Otra plantilla', blank: 'https://api.memegen.link/images/trio.jpg' },
    ], mint);
    expect(items.map((item) => item.id)).toEqual(['memegen:drake', 'memegen:trio']);
    expect(items[0]!.title).toBe('Primera plantilla');
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  });
});

describe('nombres de archivo', () => {
  it('slug sin tildes', () => {
    expect(gifFileName('¡Gato bailando en la oficina!', 'gif')).toBe('gato-bailando-en-la-oficina.gif');
    expect(gifFileName('???', 'webp')).toBe('gif.webp');
  });
});
