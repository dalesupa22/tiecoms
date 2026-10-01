import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { documentTable, generateDriveDocument } from '../src/modules/drive-documents.ts';

describe('native documents from user content', () => {
  it('creates a DOCX containing accented and XML-sensitive user text', async () => {
    const result = await generateDriveDocument({ name: 'Reunión', format: 'docx', content: 'Lorena & Danny <equipo>\nPróximos pasos' });
    const zip = await JSZip.loadAsync(result.body);
    expect(await zip.file('word/document.xml')!.async('string')).toContain('Lorena &amp; Danny &lt;equipo&gt;');
    expect(await zip.file('[Content_Types].xml')!.async('string')).toContain('wordprocessingml.document');
    expect(result.name).toBe('Reunión.docx');
  });
  it('creates a readable XLSX with quoted cells and keeps formula-looking text literal', async () => {
    const result = await generateDriveDocument({ name: 'Reporte.xlsx', format: 'xlsx', content: 'Persona,Nota\nLorena,"Uno, dos"\nDanny,=1+1' });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result.body as any);
    expect(workbook.worksheets[0]!.getCell('B2').value).toBe('Uno, dos');
    expect(workbook.worksheets[0]!.getCell('B3').value).toBe('=1+1');
    expect(result.name).toBe('Reporte.xlsx');
  });
  it('creates a PDF with pagination and preserves Spanish accented text', async () => {
    const result = await generateDriveDocument({ name: 'Acta', format: 'pdf', content: 'Reunión: información, año y próximos pasos.\n'.repeat(120) });
    expect(result.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await PDFDocument.load(result.body)).getPageCount()).toBeGreaterThan(1);
    expect(result.contentType).toBe('application/pdf');
  });
  it('does not silently lose characters unsupported by the PDF font', async () => {
    await expect(generateDriveDocument({ name: 'Acta', format: 'pdf', content: '😀' })).rejects.toThrow('símbolos');
  });
  it('creates a two-slide PowerPoint from the editor separator', async () => {
    const result = await generateDriveDocument({ name: 'Plan', format: 'pptx', content: 'Primero\nContenido uno\n---\nSegundo\nContenido dos' });
    const zip = await JSZip.loadAsync(result.body);
    expect(Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))).toHaveLength(2);
    expect(await zip.file('ppt/slides/slide2.xml')!.async('string')).toContain('Contenido dos');
    expect(await zip.file('[Content_Types].xml')!.async('string')).toContain('presentationml');
  });
  it('parses quoted multiline and tab-separated spreadsheet rows', () => {
    expect(documentTable('Nombre\tTexto\nLorena\t"uno\ndos"')).toEqual([['Nombre', 'Texto'], ['Lorena', 'uno\ndos']]);
  });
});
