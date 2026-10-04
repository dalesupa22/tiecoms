import { describe, expect, it } from 'vitest';
import { MAX_ATTACHMENT_BYTES } from '@tiecoms/contracts';
import { decodeFile, MAX_BASE64_LENGTH, validateFileType } from '../src/modules/mcp-file-input.ts';

describe('MCP file bytes: strict bounded base64', () => {
  it.each(['a', 'ab', 'abc', 'archivo áéí', '\0binary\xff'])('round-trips canonical data (%#)', (input) => {
    const body = Buffer.from(input);
    expect(decodeFile(body.toString('base64'))).toEqual(body);
  });
  it.each(['', 'a', 'AAA', '====', '=AAA', 'AA=A', 'aGVs bG8=', 'aGVsbG8=\n', 'data:image/png;base64,YQ==', 'https://a.test/file', 'YWJj-_==', 'AB==', 'AAB='])('rejects malformed or noncanonical data (%#)', (value) => {
    expect(() => decodeFile(value)).toThrow();
  });
  it('accepts exactly the product limit and rejects the extra byte even at the same encoded length', () => {
    const maximum = Buffer.alloc(MAX_ATTACHMENT_BYTES, 0);
    expect(decodeFile(maximum.toString('base64'))).toHaveLength(MAX_ATTACHMENT_BYTES);
    expect(() => decodeFile(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64'))).toThrow(expect.objectContaining({ code: 'too_large' }));
    expect(() => decodeFile('A'.repeat(MAX_BASE64_LENGTH + 4))).toThrow(expect.objectContaining({ code: 'too_large' }));
  });
});

describe('MCP file types', () => {
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
  it('accepts real PDF framing and normalizes detected binary PDF', () => {
    expect(validateFileType(pdf, 'application/pdf', null, null)).toBe('application/pdf');
    expect(validateFileType(pdf, 'application/octet-stream', null, null)).toBe('application/pdf');
  });
  it.each([Buffer.from('not a pdf'), Buffer.from('%PDF-1.7\nincomplete')])('rejects spoofed or truncated PDFs (%#)', (body) => {
    expect(() => validateFileType(body, 'application/pdf', null, null)).toThrow(expect.objectContaining({ code: 'unsupported_type' }));
  });
  it('enforces product image detection, declared MIME and dimensions', () => {
    const image = Buffer.from('image fixture recognized by product sniffer');
    expect(validateFileType(image, 'image/png', 'image/png', { width: 1, height: 1 })).toBe('image/png');
    expect(validateFileType(image, 'application/octet-stream', 'image/png', { width: 1, height: 1 })).toBe('image/png');
    expect(() => validateFileType(image, 'image/png', null, null)).toThrow();
    expect(() => validateFileType(image, 'image/jpeg', 'image/png', { width: 1, height: 1 })).toThrow();
    expect(() => validateFileType(image, 'image/png', 'image/png', null)).toThrow();
    expect(() => validateFileType(image, 'image/png', 'image/png', { width: 0, height: 1 })).toThrow();
  });
  it('validates UTF-8 text and JSON rather than trusting the MIME', () => {
    expect(validateFileType(Buffer.from('acción'), 'text/plain', null, null)).toBe('text/plain');
    expect(validateFileType(Buffer.from('{"ok":true}'), 'application/json', null, null)).toBe('application/json');
    expect(() => validateFileType(Buffer.from([0xff]), 'text/plain', null, null)).toThrow();
    expect(() => validateFileType(Buffer.from('a\0b'), 'text/csv', null, null)).toThrow();
    expect(() => validateFileType(Buffer.from('{'), 'application/json', null, null)).toThrow();
  });
  it('serves other binary files only through the product safe generic download MIME', () => {
    const binary = Buffer.from([0x01, 0xff]);
    expect(validateFileType(binary, 'application/octet-stream', null, null)).toBe('application/octet-stream');
    expect(() => validateFileType(binary, 'text/html', null, null)).toThrow();
    expect(() => validateFileType(binary, 'bad mime', null, null)).toThrow();
    expect(() => validateFileType(binary, 'image/svg+xml', null, null)).toThrow();
  });
  it('requires the ZIP file signature', () => {
    expect(validateFileType(Buffer.from([0x50, 0x4b, 3, 4]), 'application/zip', null, null)).toBe('application/zip');
    expect(() => validateFileType(Buffer.from('not a zip'), 'application/zip', null, null)).toThrow();
  });
});
