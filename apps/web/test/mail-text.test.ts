import { describe, expect, it } from 'vitest';
import { mailParts, mailSnippet } from '../src/mail-text.ts';

// Correo en la tarjeta: sin direcciones de imágenes y con los enlaces cortos (30-sep-2026).
const BANCO = `header-logo [http://bancolombia-email-wsuite.s3.amazonaws.com/templates/6071/img/header.png]\n\nHola DANNY,\n\nRealizaste un pago de $120.000.\nVer detalle [https://www.bancolombia.com/personas/alertas?id=1].\n\nfooter_img [https://x.com/a.gif]\nAyuda en https://bancolombia.com/ayuda.`;

describe('mail-text', () => {
  it('quita las imágenes y su «alt»', () => {
    const text = mailParts(BANCO).map((p) => ('href' in p ? `[${p.label}]` : p.text)).join('');
    expect(text).toBe('Hola DANNY,\n\nRealizaste un pago de $120.000.\nVer detalle [bancolombia.com].\n\nAyuda en [bancolombia.com].');
  });
  it('conserva la dirección completa del enlace', () => {
    expect(mailParts(BANCO).filter((p) => 'href' in p).map((p) => 'href' in p && p.href)).toEqual(['https://www.bancolombia.com/personas/alertas?id=1', 'https://bancolombia.com/ayuda']);
  });
  it('resumen en una línea', () => {
    expect(mailSnippet(BANCO)).toBe('Hola DANNY, Realizaste un pago de $120.000. Ver detalle. Ayuda en.');
    expect(mailSnippet('Hola, te envío la propuesta')).toBe('Hola, te envío la propuesta');
  });
});
