import { describe, expect, it } from 'vitest';
import { isTextFile, looksBinary } from './text-files.ts';

describe('archivos que abren en el visor de código', () => {
  it('reconoce código y texto por extensión aunque llegue como octet-stream', () => {
    for (const name of ['app.ts', 'main.py', 'query.sql', 'config.yaml', 'README.md', 'datos.csv', 'Dockerfile', '.env', 'notas.txt'])
      expect(isTextFile({ name, contentType: 'application/octet-stream' })).toBe(true);
  });
  it('reconoce por tipo MIME', () => {
    expect(isTextFile({ name: 'sin-extension', contentType: 'application/json' })).toBe(true);
    expect(isTextFile({ name: 'x', contentType: 'text/plain; charset=utf-8' })).toBe(true);
  });
  it('deja fuera PDF, imágenes, video, Office y comprimidos', () => {
    for (const [name, contentType] of [['a.pdf', 'application/pdf'], ['a.png', 'image/png'], ['a.mp4', 'video/mp4'], ['a.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], ['a.zip', 'application/zip'], ['a.docx', 'application/octet-stream']] as const)
      expect(isTextFile({ name, contentType })).toBe(false);
  });
  it('detecta binarios por bytes nulos o de control', () => {
    expect(looksBinary(new TextEncoder().encode('const a = 1;\n\tok'))).toBe(false);
    expect(looksBinary(new Uint8Array([80, 75, 3, 4, 0, 0, 1]))).toBe(true);
  });
});
