import { describe, expect, it } from 'vitest';
import {
  activeHashQuery, backspaceRef, claimEffect, findMatches, foldKeep, parseNotice, quickDueDates, refsFor, resultPosition, searchTerms, segmentBody,
  viewOnceAllowed, viewOnceKind,
} from '../src/chat17.ts';

// Tanda 1.7 (docs/TANDA-1.7.md): utilidades de render de #grupos, búsqueda, «Nueva fecha» y una sola vista.
describe('#grupos en el compositor', () => {
  it('refsFor ubica cada #Nombre y descarta lo que ya no está', () => {
    const tokens = [{ conversationId: 'c1', label: 'Operación Andes' }, { conversationId: 'c2', label: 'Ventas' }, { conversationId: 'c3', label: 'Borrado' }];
    const text = 'Mira #Operación Andes y (#Ventas), pero no #Ventas2';
    expect(refsFor(text, tokens)).toEqual([
      { conversationId: 'c1', start: 5, length: '#Operación Andes'.length },
      { conversationId: 'c2', start: text.indexOf('#Ventas'), length: 7 },
    ]);
  });
  it('activeHashQuery solo tras espacio o al inicio', () => {
    expect(activeHashQuery('hola #ope', 9)).toEqual({ start: 5, query: 'ope' });
    expect(activeHashQuery('#', 1)).toEqual({ start: 0, query: '' });
    expect(activeHashQuery('color#fff', 9)).toBeNull();
    expect(activeHashQuery('hola #a\nb', 9)).toBeNull();
  });
  it('retroceso borra el #grupo entero', () => {
    expect(backspaceRef('ver #Ventas ', 12, [{ conversationId: 'c', label: 'Ventas' }])).toEqual({ text: 'ver ', caret: 4 });
    expect(backspaceRef('ver #Ventas', 5, [{ conversationId: 'c', label: 'Ventas' }])).toBeNull();
  });
});

describe('burbujas con menciones y #grupos', () => {
  it('segmentBody intercala texto, menciones y refs en orden', () => {
    const body = 'Hola @Ana, mira #Ventas.';
    const segs = segmentBody(body, [{ userId: 'u1', start: 5, length: 4 }], [{ conversationId: 'c', name: 'Ventas', start: 16, length: 7 }]);
    expect(segs.map((s) => [s.kind, s.text])).toEqual([['text', 'Hola '], ['mention', '@Ana'], ['text', ', mira '], ['ref', '#Ventas'], ['text', '.']]);
  });
  it('ignora tramos fuera del texto o solapados', () => {
    const segs = segmentBody('#A #B', [], [{ conversationId: 'a', name: 'A', start: 0, length: 2 }, { conversationId: 'x', name: 'X', start: 1, length: 3 }, { conversationId: 'z', name: 'Z', start: 4, length: 9 }]);
    expect(segs.map((s) => s.kind)).toEqual(['ref', 'text']);
    expect(segmentBody('', [], [])).toEqual([{ kind: 'text', text: '' }]);
  });
});

describe('búsqueda en el chat', () => {
  it('foldKeep conserva el largo y quita tildes y mayúsculas', () => {
    expect(foldKeep('Reunión ÑANDÚ')).toBe('reunion nandu');
    expect(foldKeep('Reunión').length).toBe(7);
  });
  it('findMatches encuentra sin tildes y en posiciones del original', () => {
    const text = 'La REUNIÓN de hoy y otra reunion';
    const m = findMatches(text, 'reunion');
    expect(m).toEqual([[3, 7], [25, 7]]);
    expect(text.slice(3, 10)).toBe('REUNIÓN');
    expect(findMatches(text, 'a')).toEqual([]);
  });
  it('searchTerms quita from:Nombre; resultPosition arma «3 de 17»', () => {
    expect(searchTerms('from:Ana presupuesto')).toBe('presupuesto');
    expect(searchTerms('hola from:"Ana María"')).toBe('hola');
    expect(resultPosition(2, 17, false)).toEqual({ i: 3, n: '17' });
    expect(resultPosition(0, 30, true)).toEqual({ i: 1, n: '30+' });
    expect(resultPosition(0, 0, false)).toEqual({ i: 0, n: '0' });
  });
});

describe('«Nueva fecha» y mensajes de sistema', () => {
  it('Hoy, Mañana y Próximo lunes', () => {
    // Miércoles 30 de septiembre de 2026.
    expect(quickDueDates(new Date(2026, 8, 30, 15))).toEqual({ today: '2026-09-30', tomorrow: '2026-10-01', monday: '2026-10-05' });
    // Un lunes: el de la otra semana.
    expect(quickDueDates(new Date(2026, 9, 5, 9)).monday).toBe('2026-10-12');
    // Domingo: mañana ya es lunes.
    expect(quickDueDates(new Date(2026, 9, 4, 9)).monday).toBe('2026-10-05');
  });
  it('parseNotice reconoce solo las claves nuevas', () => {
    expect(parseNotice(JSON.stringify({ k: 'issue.done', issueId: 'i', title: 'T', byId: 'u', byName: 'Ana' }))?.k).toBe('issue.done');
    expect(parseNotice(JSON.stringify({ k: 'issue.created', issueId: 'i' }))).toBeNull();
    expect(parseNotice('hola')).toBeNull();
  });
  it('los efectos salen una sola vez por mensaje', () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    expect(claimEffect(store, 'm1')).toBe(true);
    expect(claimEffect(store, 'm1')).toBe(false);
    expect(claimEffect(store, 'm2')).toBe(true);
  });
});

describe('una sola vista', () => {
  it('tipo de burbuja y adjuntos permitidos', () => {
    expect(viewOnceKind({ attachments: [] })).toBe('message');
    expect(viewOnceKind({ attachments: [{ contentType: 'image/png' }] })).toBe('photo');
    expect(viewOnceKind({ attachments: [{ contentType: 'audio/mp4', kind: 'voice' }] })).toBe('voice');
    expect(viewOnceAllowed([{ contentType: 'image/jpeg' }, { contentType: 'audio/webm', kind: 'voice' }])).toBe(true);
    expect(viewOnceAllowed([{ contentType: 'application/pdf' }])).toBe(false);
  });
});
