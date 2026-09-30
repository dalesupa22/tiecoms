import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Formatted as Linkify } from '../src/fmt.tsx';

// Formato básico en los mensajes, como en WhatsApp (30-sep-2026).
const html = (text: string) => renderToStaticMarkup(<Linkify text={text} />).replace(/<span class="fmt-mark">.<\/span>/g, '');

describe('formato de mensajes', () => {
  it('negrilla, cursiva, tachado y código', () => {
    expect(html('para el *viernes*')).toBe('para el <strong class="fmt fmt-strong">viernes</strong>');
    expect(html('la _plantilla_ ya')).toBe('la <em class="fmt fmt-em">plantilla</em> ya');
    expect(html('~Llamar~')).toBe('<s class="fmt fmt-s">Llamar</s>');
    expect(html('sube `a.xlsx`')).toBe('sube <code class="fmt fmt-code">a.xlsx</code>');
  });
  it('no toca lo que no es formato', () => {
    expect(html('nombre_de_archivo.pdf')).toBe('nombre_de_archivo.pdf');
    expect(html('2 * 3 * 4')).toBe('2 * 3 * 4');
    expect(html('* suelto')).toBe('* suelto');
  });
});
