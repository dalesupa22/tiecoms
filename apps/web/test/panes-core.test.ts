import { describe, expect, it } from 'vitest';
import {
  EMPTY, MAX_PANES, closePane, inboxKey, keyParts, layoutFor, layoutRows, maxPanesFor, move, normalize, openBeside, paneKind, resizeFractions,
  restoreSpace, saveSpace, swap, syncActive, taskKey, toggleMax, togglePin, victim, viewKey, visiblePanes, waKey, type PanesState,
} from '../src/panes-core.ts';

const st = (panes: string[], extra: Partial<PanesState> = {}): PanesState => ({ ...EMPTY, panes, recent: [...panes], ...extra });

describe('claves de panel', () => {
  it('distingue chats, vistas y elementos sueltos', () => {
    expect(paneKind('general')).toBe('conv');
    expect(paneKind(viewKey('agenda'))).toBe('view');
    expect(paneKind(waKey('wa1', '573001@s.whatsapp.net'))).toBe('wa');
    expect(paneKind('mail:em1')).toBe('mail');
    expect(paneKind(inboxKey('google', 'abc'))).toBe('inbox');
    expect(paneKind(taskKey('i1'))).toBe('task');
  });
  it('el jid de WhatsApp puede traer «:» y se conserva entero', () => {
    expect(keyParts(waKey('wa1', 'a:b@g.us'))).toEqual(['wa1', 'a:b@g.us']);
    expect(keyParts(inboxKey('microsoft', 'AAMk:1'))).toEqual(['microsoft', 'AAMk:1']);
  });
});

describe('normalize (lo guardado)', () => {
  it('acepta el formato viejo (arreglo de ids) y lo recorta a 8', () => {
    const s = normalize(['a', 'b', 'a', 1, 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
    expect(s.panes).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    expect(s.pinned).toEqual([]);
  });
  it('descarta fijados y agrandado que ya no están abiertos', () => {
    const s = normalize({ panes: ['a', 'b'], pinned: ['b', 'x'], recent: ['x', 'b'], maximized: 'x' });
    expect(s.pinned).toEqual(['b']);
    expect(s.recent).toEqual(['b', 'a']);
    expect(s.maximized).toBeNull();
  });
  it('basura → vacío', () => { expect(normalize('hola')).toEqual(EMPTY); expect(normalize(null)).toEqual(EMPTY); });
});

describe('syncActive (tocar un chat en la lista)', () => {
  it('sin paneles no hace nada', () => { expect(syncActive(EMPTY, 'a', null, 8)).toBe(EMPTY); });
  it('reemplaza al panel enfocado', () => {
    expect(syncActive(st(['a', 'b', 'c']), 'x', 'b', 8).panes).toEqual(['a', 'x', 'c']);
  });
  it('si el enfocado está fijado, se agrega al lado', () => {
    expect(syncActive(st(['a', 'b'], { pinned: ['b'] }), 'x', 'b', 8).panes).toEqual(['a', 'b', 'x']);
  });
  it('fijado y lleno: reemplaza al no fijado menos reciente', () => {
    const s = st(['a', 'b', 'c', 'd'], { pinned: ['b'], recent: ['b', 'c', 'a', 'd'] });
    expect(syncActive(s, 'x', 'b', 4).panes).toEqual(['a', 'b', 'c', 'x']);
  });
  it('si ya estaba abierto solo pasa a ser el más reciente', () => {
    const s = syncActive(st(['a', 'b'], { recent: ['a', 'b'] }), 'b', 'a', 8);
    expect(s.panes).toEqual(['a', 'b']);
    expect(s.recent[0]).toBe('b');
  });
});

describe('openBeside (abrir en paralelo)', () => {
  it('con espacio se agrega al final', () => {
    const r = openBeside(st(['a', 'b']), 'c', 'a', 8);
    expect(r.state.panes).toEqual(['a', 'b', 'c']);
    expect(r.replaced).toBeNull();
  });
  it('desde la vista normal: lo que ves entra primero', () => {
    expect(openBeside(EMPTY, 'b', 'a', 8).state.panes).toEqual(['a', 'b']);
    expect(openBeside(EMPTY, viewKey('mail'), viewKey('whatsapp'), 8).state.panes).toEqual(['v:whatsapp', 'v:mail']);
  });
  it('con una vista de página completa y paneles abiertos, la vista se suma', () => {
    expect(openBeside(st(['a', 'b']), waKey('w', 'j'), viewKey('whatsapp'), 8).state.panes).toEqual(['a', 'b', 'v:whatsapp', 'wa:w:j']);
  });
  it('ya abierto: no duplica', () => {
    const r = openBeside(st(['a', 'b']), 'b', 'a', 8);
    expect(r.already).toBe(true);
    expect(r.state.panes).toEqual(['a', 'b']);
  });
  it('con 8 reemplaza al no fijado menos reciente (y nunca al que estás viendo)', () => {
    const panes = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const s = st(panes, { pinned: ['h'], recent: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] });
    const r = openBeside(s, 'x', 'a', MAX_PANES);
    expect(r.replaced).toBe('g');
    expect(r.state.panes).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'x', 'h']);
    expect(r.state.recent[0]).toBe('x');
  });
  it('el activo, aunque sea el más viejo, no se reemplaza', () => {
    const s = st(['a', 'b', 'c'], { recent: ['c', 'b', 'a'] });
    expect(openBeside(s, 'x', 'a', 3).replaced).toBe('b');
  });
  it('soltar en el centro de un panel lo reemplaza (si no está fijado)', () => {
    expect(openBeside(st(['a', 'b', 'c']), 'x', 'a', 8, { target: 'b' }).state.panes).toEqual(['a', 'x', 'c']);
    const pinned = openBeside(st(['a', 'b', 'c'], { pinned: ['b'] }), 'x', 'a', 8, { target: 'b' });
    expect(pinned.state.panes).toEqual(['a', 'b', 'c', 'x']);
  });
  it('soltar en un borde lo pone al lado, en esa posición', () => {
    expect(openBeside(st(['a', 'b', 'c']), 'x', 'a', 8, { target: 'b', at: 1 }).state.panes).toEqual(['a', 'x', 'b', 'c']);
    expect(openBeside(st(['a', 'b', 'c']), 'x', 'a', 8, { target: 'b', at: 2 }).state.panes).toEqual(['a', 'b', 'x', 'c']);
  });
  it('respeta el límite de la ventana (menos de 8)', () => {
    const r = openBeside(st(['a', 'b', 'c', 'd'], { recent: ['a', 'b', 'c', 'd'] }), 'x', 'a', 4);
    expect(r.state.panes).toHaveLength(4);
    expect(r.replaced).toBe('d');
  });
  it('todos fijados y lleno: igual abre, en el lugar del más viejo', () => {
    const s = st(['a', 'b'], { pinned: ['a', 'b'], recent: ['a', 'b'] });
    expect(openBeside(s, 'x', 'a', 2).replaced).toBe('b');
  });
  it('abrir quita el agrandado', () => {
    expect(openBeside(st(['a', 'b'], { maximized: 'a' }), 'c', 'a', 8).state.maximized).toBeNull();
  });
});

describe('victim', () => {
  it('el no fijado menos reciente', () => {
    expect(victim(st(['a', 'b', 'c'], { recent: ['b', 'a', 'c'], pinned: ['c'] }))).toBe('a');
  });
});

describe('cerrar, fijar, agrandar', () => {
  it('cerrar el activo enfoca al vecino de la izquierda', () => {
    const r = closePane(st(['a', 'b', 'c']), 'b', 'b');
    expect(r.state.panes).toEqual(['a', 'c']);
    expect(r.focus).toBe('a');
  });
  it('cerrar el primero activo enfoca al siguiente', () => { expect(closePane(st(['a', 'b', 'c']), 'a', 'a').focus).toBe('b'); });
  it('con uno solo vuelve a la vista normal', () => {
    const r = closePane(st(['a', 'b']), 'b', 'a');
    expect(r.state).toEqual(EMPTY);
    expect(r.focus).toBeNull();
  });
  it('cerrar limpia fijado y reciente', () => {
    const r = closePane(st(['a', 'b', 'c'], { pinned: ['c'] }), 'c', 'a');
    expect(r.state.pinned).toEqual([]);
    expect(r.state.recent).not.toContain('c');
  });
  it('fijar y desfijar', () => {
    const s = togglePin(st(['a', 'b']), 'b');
    expect(s.pinned).toEqual(['b']);
    expect(togglePin(s, 'b').pinned).toEqual([]);
    expect(togglePin(s, 'zz')).toBe(s);
  });
  it('agrandar y volver', () => {
    const s = toggleMax(st(['a', 'b']), 'a');
    expect(s.maximized).toBe('a');
    expect(toggleMax(s, 'a').maximized).toBeNull();
  });
});

describe('reordenar', () => {
  it('intercambiar dos', () => { expect(swap(st(['a', 'b', 'c']), 'a', 'c').panes).toEqual(['c', 'b', 'a']); });
  it('mover a una posición', () => {
    expect(move(st(['a', 'b', 'c', 'd']), 'a', 3).panes).toEqual(['b', 'c', 'a', 'd']);
    expect(move(st(['a', 'b', 'c', 'd']), 'd', 0).panes).toEqual(['d', 'a', 'b', 'c']);
    expect(move(st(['a', 'b', 'c', 'd']), 'd', 4).panes).toEqual(['a', 'b', 'c', 'd']);
  });
  it('mover a su propio lugar no cambia nada', () => { const s = st(['a', 'b']); expect(move(s, 'a', 0)).toBe(s); });
});

describe('visiblePanes (ventana más chica que los abiertos)', () => {
  it('los primeros que caben, con el activo adentro', () => {
    expect(visiblePanes(['a', 'b', 'c', 'd', 'e', 'f'], 'f', 4)).toEqual(['a', 'b', 'c', 'f']);
    expect(visiblePanes(['a', 'b', 'c', 'd', 'e', 'f'], 'b', 4)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('el activo no desplaza a un fijado', () => {
    expect(visiblePanes(['a', 'b', 'c', 'd', 'e'], 'e', 4, ['d'])).toEqual(['a', 'b', 'e', 'd']);
  });
});

describe('disposición', () => {
  // Área de paneles medida en el arnés: ventana menos riel (64) y barra (272) y la barrita de paneles.
  const at1440 = [1440 - 336, 900 - 40] as const, at1920 = [1920 - 336, 1080 - 40] as const, at2560 = [2560 - 336, 1440 - 40] as const;
  it('1 y 2', () => {
    expect(layoutFor(1, ...at1440)).toEqual([1]);
    expect(layoutFor(2, ...at1440)).toEqual([2]);
  });
  it('3 en columnas cuando caben cómodas; si no, 2 arriba y 1 abajo', () => {
    expect(layoutFor(3, ...at1440)).toEqual([3]);
    expect(layoutFor(3, 900, 800)).toEqual([2, 1]);
  });
  it('4: 2×2 en 1440 y 1920; 4 columnas en 2560', () => {
    expect(layoutFor(4, ...at1440)).toEqual([2, 2]);
    expect(layoutFor(4, ...at1920)).toEqual([2, 2]);
    expect(layoutFor(4, ...at2560)).toEqual([4]);
  });
  it('5 → 3+2 · 6 → 3×2', () => {
    expect(layoutFor(5, ...at1920)).toEqual([3, 2]);
    expect(layoutFor(6, ...at1440)).toEqual([3, 3]);
  });
  it('7 → 4+3 · 8 → 4×2 en 1920 y 2560', () => {
    expect(layoutFor(7, ...at1920)).toEqual([4, 3]);
    expect(layoutFor(8, ...at1920)).toEqual([4, 4]);
    expect(layoutFor(8, ...at2560)).toEqual([4, 4]);
  });
  it('8 en una ventana alta y angosta → 3+3+2', () => { expect(layoutFor(8, 1000, 1300)).toEqual([3, 3, 2]); });
  it('modo cuadrícula no pone 3+ en una sola fila; modo columnas sí cuando caben', () => {
    expect(layoutFor(3, ...at1440, 'grid')).toEqual([2, 1]);
    expect(layoutFor(4, ...at1920, 'columns')).toEqual([4]);
  });
  it('cuántos caben según el tamaño', () => {
    expect(maxPanesFor(...at1440)).toBe(6);
    expect(maxPanesFor(...at1920)).toBe(8);
    expect(maxPanesFor(...at2560)).toBe(8);
    expect(maxPanesFor(1000 - 336, 760)).toBe(4);
    expect(maxPanesFor(600, 500)).toBe(2);
  });
  it('si no hay una legible, igual da una disposición', () => {
    expect(layoutRows(6, 600, 500)).toBeNull();
    expect(layoutFor(6, 600, 500)).toEqual([3, 3]);
  });
});

describe('divisiones', () => {
  it('al arrastrar, la suma de los dos vecinos se mantiene y hay un mínimo', () => {
    const fr = resizeFractions([0.25, 0.25, 0.5], 0, 0.2);
    expect(fr[0]! + fr[1]!).toBeCloseTo(0.5);
    expect(fr[1]).toBeCloseTo(0.12);
    expect(fr[2]).toBe(0.5);
  });
});

describe('espacios guardados', () => {
  it('guardar con nombre y volver a abrir', () => {
    const list = saveSpace([], ' Cierre de mes ', st(['a', viewKey('mail'), 'b'], { pinned: ['a'] }), '2026-09-30T00:00:00Z');
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('Cierre de mes');
    const s = restoreSpace(list[0]!);
    expect(s.panes).toEqual(['a', 'v:mail', 'b']);
    expect(s.pinned).toEqual(['a']);
  });
  it('el mismo nombre reemplaza; sin nombre o con un solo panel no guarda', () => {
    let list = saveSpace([], 'X', st(['a', 'b']));
    list = saveSpace(list, 'x', st(['c', 'd']));
    expect(list).toHaveLength(1);
    expect(list[0]!.panes).toEqual(['c', 'd']);
    expect(saveSpace(list, '  ', st(['a', 'b']))).toBe(list);
    expect(saveSpace(list, 'Y', st(['a']))).toBe(list);
  });
});

import { CHAT_BGS, TONES, autoTone, effectiveBg } from '../src/chat-bg-core.ts';
describe('fondos de chat', () => {
  it('12 fondos: 8 tonos y 4 patrones', () => {
    expect(CHAT_BGS).toHaveLength(12);
    expect(CHAT_BGS.filter((b) => b.pattern)).toHaveLength(4);
  });
  it('el automático es estable y está en rango', () => {
    expect(autoTone('general')).toBe(autoTone('general'));
    for (const id of ['a', 'general', 'temas', '00000000-0000-4000-8000-000000000001']) expect(autoTone(id)).toBeLessThan(TONES);
    const tones = new Set(['general', 'temas', 'dm-ana', 'multi1', 'diag', 'side1', 'xflow', 'pagos'].map(autoTone));
    expect(tones.size).toBeGreaterThanOrEqual(4);
  });
  it('con 1 panel no hay fondo salvo que lo elijas; con varios, automático; «Sin fondo» siempre gana', () => {
    expect(effectiveBg(undefined, 'general', false)).toBeNull();
    expect(effectiveBg(undefined, 'general', true)?.tone).toBe(autoTone('general'));
    expect(effectiveBg('ondas', 'general', false)?.pattern).toBe('waves');
    expect(effectiveBg('none', 'general', true)).toBeNull();
    expect(effectiveBg('no-existe', 'general', false)).toBeNull();
  });
});
