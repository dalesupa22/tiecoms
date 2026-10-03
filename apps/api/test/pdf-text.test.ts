import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { pdfText } from '../src/pdf-text.ts';

async function makePdf(pages: string[]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const t of pages) { const p = doc.addPage([400, 400]); p.drawText(t, { x: 40, y: 340, size: 12, font }); }
  return doc.save();
}

describe('texto de PDF para gg', () => {
  it('lee cada página con su número', async () => {
    const r = await pdfText(await makePdf(['Contrato Nestle 2026', 'Valor total: 45.000.000 COP']), 10_000);
    expect(r.pages).toBe(2); expect(r.readPages).toBe(2); expect(r.truncated).toBe(false);
    expect(r.text).toContain('[Página 1]'); expect(r.text).toContain('Contrato Nestle 2026'); expect(r.text).toContain('45.000.000 COP');
  });
  it('corta en el tope y lo dice', async () => {
    const r = await pdfText(await makePdf(Array.from({ length: 30 }, (_, i) => `Clausula ${i} `.repeat(20))), 1_000);
    expect(r.truncated).toBe(true); expect(r.text.length).toBeLessThanOrEqual(1_000); expect(r.readPages).toBeLessThan(30);
  });
  it('un archivo que no es PDF falla', async () => {
    await expect(pdfText(new TextEncoder().encode('hola'), 1000)).rejects.toBeTruthy();
  });
});
