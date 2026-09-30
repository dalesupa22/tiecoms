import { describe, expect, it } from 'vitest';
import { safeHtml } from '../src/modules/mail-html.ts';

// Correo con su diseño en la tarjeta (30-sep-2026): el HTML llega limpio y además la web lo pinta con sandbox.
describe('safeHtml', () => {
  it('quita scripts, marcos, formularios y atributos on*', () => {
    const out = safeHtml('<div onclick="x()" style="color:red"><script>alert(1)</script><iframe src="https://e.x"></iframe><form action="https://e.x"><input name="p"></form><b onmouseover=\'y()\'>Hola</b></div>');
    expect(out).toBe('<div style="color:red"><b>Hola</b></div>');
  });
  it('quita enlaces javascript: y las imágenes cid:, deja las normales', () => {
    const out = safeHtml('<a href="javascript:alert(1)">a</a><a href="https://banco.co/x">b</a><img src="cid:logo@x"><img src="https://banco.co/l.png">');
    expect(out).toBe('<a>a</a><a href="https://banco.co/x">b</a><img><img src="https://banco.co/l.png">');
  });
  it('quita meta, base y link', () => {
    expect(safeHtml('<meta http-equiv="refresh" content="0;url=https://e.x"><base href="https://e.x/"><link rel="stylesheet" href="https://e.x/a.css"><p>x</p>')).toBe('<p>x</p>');
  });
  it('lleva las imágenes al proxy', () => {
    const out = safeHtml('<img src="https://b.co/a.png?x=1&amp;y=2"><td background=\'http://b.co/bg.jpg\' style="background:url(https://b.co/c.gif)">', (u) => `/p/${encodeURIComponent(u)}`);
    expect(out).toBe(`<img src="/p/${encodeURIComponent('https://b.co/a.png?x=1&y=2')}"><td background='/p/${encodeURIComponent('http://b.co/bg.jpg')}' style="background:url(/p/${encodeURIComponent('https://b.co/c.gif')})">`);
  });
});
