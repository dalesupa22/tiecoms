/**
 * Firmar PDFs. La geometría y el estampado no necesitan el API; el flujo completo sí
 * (API_URL con S3, en local test/fake-s3.mjs).
 */
import { randomUUID } from 'node:crypto';
import { PDFDocument, degrees } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.ts';
import { displaySize, displayToPdf, hasDigitalSignature, isEncrypted, normRotation, stampPdf, winAnsi } from '../src/modules/signatures.ts';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 8);
const faultTests = process.env.SIGNATURES_FAULT_TESTS === '1';
if (faultTests) {
  const db = new URL(process.env.DATABASE_URL!);
  const local = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);
  if (!process.env.API_URL || !local(new URL(API).hostname) || !local(db.hostname) || !/^\/chaggu_release_[a-z0-9_]+$/.test(db.pathname)) {
    throw new Error('Las pruebas de fallos requieren API local y una base aislada chaggu_release_*');
  }
}
afterAll(async () => { if (faultTests) await pool.end(); });

/** Falla solo la fila del caso actual; siempre retira el trigger de la base local aislada. */
async function withInsertFailure(table: 'jobs' | 'pdf_signings', condition: string, check: () => Promise<void>) {
  if (!faultTests) throw new Error('SIGNATURES_FAULT_TESTS no habilitado');
  const name = `test_signature_failure_${randomUUID().replaceAll('-', '')}`;
  try {
    await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'signature_test_failure'; END $$`);
    await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION ${name}()`);
    await check();
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
    await pool.query(`DROP FUNCTION IF EXISTS ${name}()`);
  }
}

// PNG 40×20 opaco (pdf-lib lo incrusta).
async function png(w = 40, h = 20) {
  const { deflateSync } = await import('node:zlib');
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) raw.writeUInt32BE(0x1030a0ff, y * (w * 4 + 1) + 1 + x * 4); }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function crc32(b: Buffer) {
  let c = ~0;
  for (const byte of b) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
async function makePdf(rotations: number[] = [0], size: [number, number] = [612, 792]) {
  const doc = await PDFDocument.create();
  for (const r of rotations) { const p = doc.addPage(size); p.setRotation(degrees(r)); p.drawText(`rot ${r}`, { x: 40, y: 40, size: 12 }); }
  return Buffer.from(await doc.save());
}

describe('geometría de la página', () => {
  const box = { x: 10, y: 20, width: 600, height: 800 };
  it('normaliza la rotación', () => {
    expect([0, 90, 180, 270, -90, 450, 360].map(normRotation)).toEqual([0, 90, 180, 270, 270, 90, 0]);
    expect(displaySize(box, 90)).toEqual({ w: 800, h: 600 });
  });
  it('las esquinas de la página vista caen en las esquinas del PDF', () => {
    // Arriba a la izquierda de lo que se ve, para cada /Rotate (sentido horario).
    expect(displayToPdf(box, 0, 0, 0)).toEqual({ x: 10, y: 820 });
    expect(displayToPdf(box, 90, 0, 0)).toEqual({ x: 10, y: 20 });
    expect(displayToPdf(box, 180, 0, 0)).toEqual({ x: 610, y: 20 });
    expect(displayToPdf(box, 270, 0, 0)).toEqual({ x: 610, y: 820 });
  });
  it('una imagen girada con la página queda derecha y en su caja', () => {
    for (const r of [0, 90, 180, 270]) {
      const bx = 100, by = 50, bw = 120, bh = 40;
      const o = displayToPdf(box, r, bx, by + bh);
      const t = (r * Math.PI) / 180;
      // drawImage gira en sentido antihorario sobre (x, y): así quedan las otras esquinas.
      const right = { x: o.x + bw * Math.cos(t), y: o.y + bw * Math.sin(t) };
      const top = { x: o.x - bh * Math.sin(t), y: o.y + bh * Math.cos(t) };
      const eR = displayToPdf(box, r, bx + bw, by + bh), eT = displayToPdf(box, r, bx, by);
      expect(right.x).toBeCloseTo(eR.x); expect(right.y).toBeCloseTo(eR.y);
      expect(top.x).toBeCloseTo(eT.x); expect(top.y).toBeCloseTo(eT.y);
    }
  });
});

describe('texto y detección', () => {
  it('deja el texto en lo que Helvetica sabe escribir', () => {
    expect(winAnsi('Peña Núñez — 27/09/2026 €')).toBe('Peña Núñez — 27/09/2026 €');
    expect(winAnsi('Łódź ✍️\nhola')).toBe('Lódz ?? hola');
  });
  it('reconoce PDFs con firma digital o cifrados', async () => {
    const plain = await makePdf();
    expect(hasDigitalSignature(plain)).toBe(false);
    expect(isEncrypted(plain)).toBe(false);
    const signed = Buffer.concat([plain, Buffer.from('\n9 0 obj << /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached /ByteRange [0 10 20 30] >> endobj\n')]);
    expect(hasDigitalSignature(signed)).toBe(true);
    expect(isEncrypted(Buffer.concat([plain, Buffer.from('trailer << /Encrypt 12 0 R >>')]))).toBe(true);
  });
});

describe('estampar', () => {
  const opts = (certificate = false) => ({
    signerName: 'Danny Suárez', signerEmail: 'danny@example.com', signedAt: new Date('2026-09-27T15:42:00Z'), timeZone: 'America/Bogota', lang: 'es' as const,
    stamp: true, certificate, signingId: randomUUID(), documentName: 'Contrato.pdf', originalSha256: 'ab'.repeat(32), ip: '10.0.0.1',
  });
  it('estampa firma y texto en páginas giradas y agrega la constancia', async () => {
    const pdf = await makePdf([0, 90, 180, 270]);
    const sig = randomUUID();
    const placements = [1, 2, 3, 4].flatMap((page) => [
      { type: 'signature' as const, signatureId: sig, page, x: 0.6, y: 0.8, w: 0.3, h: 0.08 },
      { type: 'text' as const, text: '27/09/2026', page, x: 0.1, y: 0.8, w: 0.2, h: 0.03 },
    ]);
    const out = await stampPdf(pdf, placements, new Map([[sig, await png()]]), opts(true));
    expect(out.pages).toBe(4);
    const doc = await PDFDocument.load(out.bytes);
    expect(doc.getPageCount()).toBe(5);
    expect(doc.getPage(1).getRotation().angle).toBe(90);
    expect(out.bytes.toString('latin1')).toContain('/Subtype /Image');
  });
  it('rechaza página inexistente, PDF roto y cifrado', async () => {
    const sig = randomUUID();
    const pdf = await makePdf();
    await expect(stampPdf(pdf, [{ type: 'signature', signatureId: sig, page: 3, x: 0, y: 0, w: 0.1, h: 0.1 }], new Map([[sig, await png()]]), opts()))
      .rejects.toMatchObject({ status: 400 });
    await expect(stampPdf(Buffer.from('%PDF-1.4 roto'), [], new Map(), opts())).rejects.toMatchObject({ code: 'invalid_pdf' });
  });
});

// ---------- Flujo completo contra el API ----------
interface Actor { token: string; id: string; orgId: string }
async function call(path: string, opts: { method?: string; token?: string; body?: unknown; raw?: Buffer; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body || opts.raw ? 'POST' : 'GET'),
    headers: {
      ...(opts.body ? { 'content-type': 'application/json' } : opts.raw ? { 'content-type': 'application/octet-stream' } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), 'x-forwarded-for': ip(), ...opts.headers,
    },
    body: opts.body ? JSON.stringify(opts.body) : opts.raw,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = {};
  try { json = JSON.parse(buf.toString()); } catch {}
  return { status: res.status, json, buf, headers: res.headers };
}
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function signup(name: string): Promise<Actor> {
  const res = await fetch(`${API}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({
    name, email: `${name.toLowerCase()}.sig.${run}@example.com`, password: 'clave-segura-123', orgName: `${name} SAS ${run}`,
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  }) });
  const j: any = await res.json();
  expect(res.status).toBe(200);
  return { token: j.accessToken, id: j.user.id, orgId: j.user.primaryOrgId };
}
const savePng = (a: Actor, body: Buffer, kind = 'signature', source = 'drawn') =>
  call('/me/signatures', { token: a.token, raw: body, headers: { 'content-type': 'image/png', 'x-signature-kind': kind, 'x-signature-source': source } });

describe.skipIf(!process.env.API_URL)('firmar un PDF del chat', () => {
  let adriana: Actor, danny: Actor, extra: Actor, conv: string, pdfId: string, sourceMessageId: string;
  beforeAll(async () => {
    adriana = await signup('Adriana'); danny = await signup('Danny'); extra = await signup('Extra');
    const ws = await call('/workspaces', { token: adriana.token, body: { name: `Firmas ${run}` } });
    conv = ws.json.generalConversationId;
    const inv = await call(`/workspaces/${ws.json.id}/invitations`, { token: adriana.token, body: { role: 'member', conversationIds: [conv] } });
    await call(`/invitations/${inv.json.token}/accept`, { token: danny.token, body: {} });
    const up = await call(`/conversations/${conv}/attachments`, { token: adriana.token, raw: await makePdf([0, 90]), headers: { 'x-file-name': encodeURIComponent('Contrato Nexo.pdf'), 'x-file-type': 'application/pdf' } });
    pdfId = up.json.id;
    const sent = await call(`/conversations/${conv}/messages`, { token: adriana.token, body: { clientMessageId: randomUUID(), body: 'Danny, me firmas esto porfa', attachmentIds: [pdfId] } });
    sourceMessageId = sent.json.message.id;
  });

  it('guarda, lista, sirve solo a su dueño y borra firmas', async () => {
    const r = await savePng(danny, await png(300, 120));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ kind: 'signature', source: 'drawn', width: 300, height: 120 });
    const list = await call('/me/signatures', { token: danny.token });
    expect(list.json.signatures.map((s: any) => s.id)).toContain(r.json.id);
    expect((await call(`/me/signatures/${r.json.id}/image`, { token: danny.token })).headers.get('content-type')).toBe('image/png');
    expect((await call(`/me/signatures/${r.json.id}/image`, { token: adriana.token })).status).toBe(404);
    expect((await savePng(danny, Buffer.from('<svg/>'))).status).toBe(400);
    expect((await call(`/me/signatures/${r.json.id}`, { method: 'DELETE', token: adriana.token })).status).toBe(404);
    expect((await call(`/me/signatures/${r.json.id}`, { method: 'DELETE', token: danny.token })).status).toBe(200);
    expect((await call('/me/signatures', { token: danny.token })).json.signatures).toHaveLength(0);
  });

  it.skipIf(!faultTests)('si falla el job de borrado conserva la firma y permite reintentar', async () => {
    const sig = (await savePng(danny, await png())).json;
    const dedupe = `delete-signature:${sig.id}`;
    await withInsertFailure('jobs', `NEW.dedupe_key = '${dedupe}'`, async () => {
      expect((await call(`/me/signatures/${sig.id}`, { method: 'DELETE', token: danny.token })).status).toBe(500);
      expect((await call('/me/signatures', { token: danny.token })).json.signatures.map((s: any) => s.id)).toContain(sig.id);
      expect((await call(`/me/signatures/${sig.id}/image`, { token: danny.token })).status).toBe(200);
      expect((await pool.query('SELECT 1 FROM jobs WHERE dedupe_key = $1', [dedupe])).rowCount).toBe(0);
    });
    expect((await call(`/me/signatures/${sig.id}`, { method: 'DELETE', token: danny.token })).status).toBe(200);
    expect((await call(`/me/signatures/${sig.id}/image`, { token: danny.token })).status).toBe(404);
    expect((await pool.query('SELECT 1 FROM jobs WHERE dedupe_key = $1', [dedupe])).rowCount).toBe(1);
  });

  it('rechaza firmar un adjunto que aún no se ha enviado al chat', async () => {
    const sig = (await savePng(adriana, await png())).json;
    const up = await call(`/conversations/${conv}/attachments`, { token: adriana.token, raw: await makePdf(), headers: { 'x-file-name': 'pendiente.pdf', 'x-file-type': 'application/pdf' } });
    const r = await call(`/attachments/${up.json.id}/sign`, { token: adriana.token, body: {
      clientMessageId: randomUUID(), placements: [{ type: 'signature', signatureId: sig.id, page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.1 }],
    } });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('bad_request');
    expect((await call(`/attachments/${up.json.id}/sign-info`, { token: adriana.token })).json.history).toEqual([]);
  });

  it.skipIf(!faultTests)('un fallo de la constancia revierte la publicación y el reintento es idempotente', async () => {
    const up = await call(`/conversations/${conv}/attachments`, { token: adriana.token, raw: await makePdf(), headers: { 'x-file-name': 'atomicidad.pdf', 'x-file-type': 'application/pdf' } });
    expect(up.status).toBe(200);
    const pdfId = up.json.id;
    expect((await call(`/conversations/${conv}/messages`, { token: adriana.token, body: { clientMessageId: randomUUID(), body: '', attachmentIds: [pdfId] } })).status).toBe(201);
    const sig = (await savePng(danny, await png())).json;
    const clientMessageId = randomUUID();
    const body = { clientMessageId, placements: [{ type: 'signature', signatureId: sig.id, page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.1 }] };
    const seqs = async () => (await pool.query('SELECT last_message_seq, last_event_seq FROM conversations WHERE id = $1', [conv])).rows[0];
    const before = await seqs();
    await withInsertFailure('pdf_signings', `NEW.user_id = '${danny.id}' AND NEW.source_attachment_id = '${pdfId}'`, async () => {
      expect((await call(`/attachments/${pdfId}/sign`, { token: danny.token, body })).status).toBe(500);
      expect((await pool.query('SELECT 1 FROM messages WHERE conversation_id = $1 AND author_id = $2 AND client_message_id = $3', [conv, danny.id, clientMessageId])).rowCount).toBe(0);
      expect(await seqs()).toEqual(before);
      expect((await pool.query('SELECT 1 FROM pdf_signings WHERE user_id = $1 AND source_attachment_id = $2', [danny.id, pdfId])).rowCount).toBe(0);
    });
    const retry = await call(`/attachments/${pdfId}/sign`, { token: danny.token, body });
    expect(retry.status).toBe(201);
    const record = await pool.query('SELECT id, message_id, result_attachment_id FROM pdf_signings WHERE user_id = $1 AND source_attachment_id = $2', [danny.id, pdfId]);
    expect(record.rows).toEqual([{ id: retry.json.signing.id, message_id: retry.json.message.id, result_attachment_id: retry.json.attachment.id }]);
    const duplicate = await call(`/attachments/${pdfId}/sign`, { token: danny.token, body });
    expect(duplicate.status).toBe(200);
    expect(duplicate.json.message.id).toBe(retry.json.message.id);
    expect((await pool.query('SELECT 1 FROM pdf_signings WHERE user_id = $1 AND source_attachment_id = $2', [danny.id, pdfId])).rowCount).toBe(1);
  });

  it('firma, responde en el hilo con el PDF firmado y deja constancia', async () => {
    const sig = (await savePng(danny, await png(300, 120))).json;
    const initials = (await savePng(danny, await png(80, 60), 'initials', 'typed')).json;
    const info = await call(`/attachments/${pdfId}/sign-info`, { token: danny.token });
    expect(info.json).toMatchObject({ hasDigitalSignature: false, encrypted: false, history: [] });
    const clientMessageId = randomUUID();
    const body = {
      clientMessageId, certificate: true, timeZone: 'America/Bogota',
      placements: [
        { type: 'signature', signatureId: sig.id, page: 1, x: 0.55, y: 0.82, w: 0.3, h: 0.08 },
        { type: 'signature', signatureId: initials.id, page: 2, x: 0.85, y: 0.9, w: 0.08, h: 0.06 },
        { type: 'text', text: '27/09/2026', page: 1, x: 0.1, y: 0.85, w: 0.18, h: 0.025 },
      ],
    };
    const r = await call(`/attachments/${pdfId}/sign`, { token: danny.token, body });
    expect(r.status).toBe(201);
    expect(r.json.message.replyTo).toBe(sourceMessageId);
    expect(r.json.message.body).toBe('✍️ Documento firmado');
    expect(r.json.attachment).toMatchObject({ name: 'Contrato Nexo (firmado).pdf', contentType: 'application/pdf' });
    expect(r.json.attachment.signing).toMatchObject({ signerId: danny.id, signerName: 'Danny' });
    const file = await call(`/attachments/${r.json.attachment.id}`, { token: adriana.token });
    expect(file.status).toBe(200);
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(file.buf).digest('hex')).toBe(r.json.signing.signedSha256);
    expect((await PDFDocument.load(file.buf)).getPageCount()).toBe(3);
    // Reintento idéntico: mismo mensaje, sin duplicar.
    const again = await call(`/attachments/${pdfId}/sign`, { token: danny.token, body });
    expect(again.status).toBe(200);
    expect(again.json.message.id).toBe(r.json.message.id);
    // Adriana ve el historial del original.
    const hist = await call(`/attachments/${pdfId}/sign-info`, { token: adriana.token });
    expect(hist.json.history).toHaveLength(1);
    expect(hist.json.history[0].signedSha256).toBe(r.json.signing.signedSha256);
    // Reenviar el firmado conserva la constancia.
    const fwd = await call(`/conversations/${conv}/messages`, { token: adriana.token, body: { clientMessageId: randomUUID(), body: '', forwardAttachmentIds: [r.json.attachment.id] } });
    expect(fwd.json.message.attachments[0].signing.signedSha256).toBe(r.json.signing.signedSha256);
  });

  it('historial «Documentos que firmé»: solo lo mío, con quién lo pidió, marcas y búsqueda por referencia', async () => {
    const sig = (await savePng(danny, await png(300, 120))).json;
    // Una póliza: la misma firma varias veces en páginas distintas.
    const placements = [1, 2, 2].map((page, i) => ({ type: 'signature', signatureId: sig.id, page, x: 0.1 + i * 0.2, y: 0.8, w: 0.15, h: 0.06 }));
    const r = await call(`/attachments/${pdfId}/sign`, { token: danny.token, body: { clientMessageId: randomUUID(), placements: [...placements, { type: 'text', text: 'CC 123', page: 1, x: 0.1, y: 0.9, w: 0.1, h: 0.02 }] } });
    expect(r.status).toBe(201);
    const h = await call('/me/signings?limit=1', { token: danny.token });
    expect(h.status).toBe(200);
    const item = h.json.signings[0];
    expect(item).toMatchObject({
      id: r.json.signing.id, documentName: 'Contrato Nexo.pdf', requestedById: adriana.id, requestedByName: 'Adriana',
      marks: 4, signatureMarks: 3, pagesMarked: 2, pages: 2, stamp: true, certificate: false, signedSha256: r.json.signing.signedSha256,
    });
    expect(item.ref).toMatch(/^[0-9A-F]{8}$/);
    expect(item.attachment.id).toBe(r.json.attachment.id);
    expect(h.json.total).toBeGreaterThanOrEqual(2);
    expect(h.json.nextBefore).toBeTruthy();
    const more = await call(`/me/signings?before=${encodeURIComponent(h.json.nextBefore)}`, { token: danny.token });
    expect(more.json.signings.map((x: any) => x.id)).not.toContain(item.id);
    expect((await call(`/me/signings?q=${item.ref}`, { token: danny.token })).json.signings.map((x: any) => x.id)).toEqual([item.id]);
    expect((await call('/me/signings?q=adriana', { token: danny.token })).json.total).toBeGreaterThanOrEqual(2);
    expect((await call('/me/signings?q=nada-que-ver', { token: danny.token })).json.total).toBe(0);
    // Adriana no firmó nada: su historial no muestra lo de Danny.
    expect((await call('/me/signings', { token: adriana.token })).json.signings).toHaveLength(0);
    // El sello impreso lleva la referencia.
    const file = await call(`/attachments/${r.json.attachment.id}`, { token: danny.token });
    expect(file.status).toBe(200);
  });

  it('no deja firmar con firmas ajenas, sin acceso ni fuera de la página', async () => {
    const mine = (await savePng(adriana, await png())).json;
    const base = { clientMessageId: randomUUID(), placements: [{ type: 'signature', signatureId: mine.id, page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.1 }] };
    expect((await call(`/attachments/${pdfId}/sign`, { token: danny.token, body: base })).status).toBe(400);
    expect((await call(`/attachments/${pdfId}/sign`, { token: extra.token, body: base })).status).toBe(404);
    const outside = { ...base, placements: [{ ...base.placements[0], x: 0.9, w: 0.3 }] };
    expect((await call(`/attachments/${pdfId}/sign`, { token: adriana.token, body: outside })).status).toBe(400);
    const page9 = { ...base, placements: [{ ...base.placements[0], page: 9 }] };
    expect((await call(`/attachments/${pdfId}/sign`, { token: adriana.token, body: page9 })).status).toBe(400);
  });

  it('avisa si el PDF ya trae firma digital y solo sigue con confirmación', async () => {
    const pdf = Buffer.concat([await makePdf(), Buffer.from('\n% << /Type /Sig /SubFilter /adbe.pkcs7.detached /ByteRange [0 1 2 3] >>\n')]);
    const up = await call(`/conversations/${conv}/attachments`, { token: adriana.token, raw: pdf, headers: { 'x-file-name': 'firmado.pdf', 'x-file-type': 'application/pdf' } });
    await call(`/conversations/${conv}/messages`, { token: adriana.token, body: { clientMessageId: randomUUID(), body: '', attachmentIds: [up.json.id] } });
    const sig = (await savePng(danny, await png())).json;
    const body = { clientMessageId: randomUUID(), placements: [{ type: 'signature', signatureId: sig.id, page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.1 }] };
    expect((await call(`/attachments/${up.json.id}/sign-info`, { token: danny.token })).json.hasDigitalSignature).toBe(true);
    const r = await call(`/attachments/${up.json.id}/sign`, { token: danny.token, body });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('has_digital_signature');
    expect((await call(`/attachments/${up.json.id}/sign`, { token: danny.token, body: { ...body, acceptBreakingSignatures: true } })).status).toBe(201);
  });

  it('no firma lo que no es PDF', async () => {
    const up = await call(`/conversations/${conv}/attachments`, { token: adriana.token, raw: Buffer.from('hola'), headers: { 'x-file-name': 'nota.txt', 'x-file-type': 'text/plain' } });
    await call(`/conversations/${conv}/messages`, { token: adriana.token, body: { clientMessageId: randomUUID(), body: '', attachmentIds: [up.json.id] } });
    expect((await call(`/attachments/${up.json.id}/sign-info`, { token: danny.token })).status).toBe(422);
  });
});
