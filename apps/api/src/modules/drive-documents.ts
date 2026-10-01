import { Document, HeadingLevel, Packer, Paragraph } from 'docx';
import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { CreateDriveDocumentInput } from '@tiecoms/contracts';
import { badRequest } from '../errors.ts';

const types = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** CSV/tab text from the editor. Values stay strings, including =formula input. */
export function documentTable(content: string): string[][] {
  if (!content.trim()) return [['']];
  const delimiter = content.includes('\t') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [], value = '', quoted = false;
  const text = content.replace(/\r\n?/g, '\n');
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"' && (quoted || !value)) {
      if (quoted && text[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) { row.push(value); value = ''; }
    else if (char === '\n' && !quoted) { row.push(value); rows.push(row); row = []; value = ''; }
    else value += char;
  }
  row.push(value);
  if (row.length > 1 || value || !rows.length) rows.push(row);
  if (rows.length > 2000 || rows.some((r) => r.length > 100)) throw badRequest('La hoja admite hasta 2000 filas y 100 columnas');
  return rows;
}

export async function generateDriveDocument(input: Pick<CreateDriveDocumentInput, 'name' | 'format' | 'content'>) {
  const title = input.name.normalize('NFC').replace(/[\u0000-\u001f\\/]/g, ' ').trim().replace(/\.(docx|xlsx|pdf|pptx)$/i, '').slice(0, 110) || 'Documento';
  const name = `${title}.${input.format}`;
  let body: Buffer;
  if (input.format === 'docx') {
    const doc = new Document({ title, creator: 'Chaggu', sections: [{ children: [
      new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
      ...input.content.split(/\r?\n/).map((text) => new Paragraph({ text })),
    ] }] });
    body = await Packer.toBuffer(doc);
  } else if (input.format === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Chaggu';
    const sheet = workbook.addWorksheet('Datos');
    const rows = documentTable(input.content);
    sheet.addRows(rows);
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    for (let col = 1; col <= Math.max(...rows.map((r) => r.length)); col++) {
      sheet.getColumn(col).width = Math.min(60, Math.max(14, ...rows.map((r) => (r[col - 1]?.length ?? 0) + 2)));
    }
    body = Buffer.from(await workbook.xlsx.writeBuffer());
  } else if (input.format === 'pptx') {
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';
    pptx.author = 'Chaggu'; pptx.subject = title; pptx.title = title;
    // A line with --- begins a new slide; the first line is its title.
    const sections = input.content.split(/\r?\n\s*---\s*\r?\n/);
    if (sections.length > 100) throw badRequest('La presentación admite hasta 100 diapositivas');
    for (const [i, section] of sections.entries()) {
      const [heading, ...lines] = section.split(/\r?\n/);
      const slide = pptx.addSlide();
      slide.background = { color: 'FFFFFF' };
      slide.addText(heading?.trim() || title, { x: 0.6, y: 0.4, w: 12.1, h: 0.8, fontFace: 'Arial', fontSize: 28, bold: true, color: '183A52', breakLine: false, fit: 'shrink' });
      slide.addText(lines.join('\n'), { x: 0.6, y: 1.5, w: 12.1, h: 5.2, fontFace: 'Arial', fontSize: 20, color: '293744', valign: 'top', fit: 'shrink' });
      slide.addText(`${i + 1}`, { x: 12, y: 7, w: 0.6, h: 0.25, fontSize: 10, color: '667788' });
    }
    body = Buffer.from(await pptx.write({ outputType: 'nodebuffer', compression: true }) as Uint8Array);
  } else {
    const pdf = await PDFDocument.create();
    pdf.setTitle(title); pdf.setAuthor('Chaggu');
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    // Validate before producing a PDF; never silently discard user characters.
    try { font.encodeText(title + input.content.replace(/[\r\n\t]/g, ' ')); }
    catch { throw badRequest('El texto incluye símbolos que el PDF no puede representar. Crea un Word para conservarlos.'); }
    let page = pdf.addPage([595.28, 841.89]), y = 790;
    const nextPage = () => { page = pdf.addPage([595.28, 841.89]); y = 790; };
    const line = (text: string, titleLine = false) => {
      if (y < 55) nextPage();
      page.drawText(text, { x: 48, y, size: titleLine ? 18 : 11, font: titleLine ? bold : font, color: rgb(0.08, 0.15, 0.2) });
      y -= titleLine ? 28 : 16;
    };
    const wrapped = (text: string, titleLine = false) => {
      const f = titleLine ? bold : font, size = titleLine ? 18 : 11;
      let current = '';
      for (const char of text.replace(/\t/g, '    ')) {
        if (f.widthOfTextAtSize(current + char, size) > 495 && current) { line(current, titleLine); current = ''; }
        current += char;
      }
      line(current, titleLine);
    };
    wrapped(title, true);
    for (const paragraph of input.content.split(/\r?\n/)) wrapped(paragraph);
    body = Buffer.from(await pdf.save());
  }
  return { name, contentType: types[input.format], body };
}
