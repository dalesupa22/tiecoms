import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { richBlocks, textFile, RENDER_TEXT_LIMIT } from '../src/rich-text.ts';
vi.mock('../src/i18n.ts', () => ({ locale: () => 'es' }));
vi.mock('../src/menu.tsx', () => ({ copyText: vi.fn(), toast: vi.fn() }));
import { RichText } from '../src/screens/RichText.tsx';

describe('bounded rich chat text', () => {
  it('keeps code bytes and never formats or executes its contents', () => {
    const input='Antes\n```html\n<script>alert(1)</script>\nconst x = `**raw**`;\n```\nDespués';
    const blocks=richBlocks(input), code=blocks.find((b)=>b.kind==='code')!;
    expect(input.slice(code.start,code.end)).toBe('<script>alert(1)</script>\nconst x = `**raw**`;');
    const html=renderToStaticMarkup(<RichText text={input}/>);
    expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');expect(html).toContain('Después');
  });
  it('supports bullets, double bold and legacy single bold',()=>{
    const html=renderToStaticMarkup(<RichText text={'**Título**\n- Uno\n- Dos\n*viernes*'}/>);
    expect(html).toContain('<strong>Título</strong>');expect(html).toContain('<strong>viernes</strong>');
    expect((html.match(/rich-bullet/g)??[]).length).toBe(2);
  });
  it('bounds adversarial unclosed fences and marker input',()=>{
    const raw='```\n'+('*_`'.repeat(400_000));const start=performance.now();
    const blocks=richBlocks(raw);expect(Math.max(...blocks.map((b)=>b.end))).toBeLessThanOrEqual(RENDER_TEXT_LIMIT);
    expect(performance.now()-start).toBeLessThan(100);
  });
  it('prepares UTF-8 locally preserving complete original bytes',async()=>{
    const source='```typescript\n'+('á ñ 😀\n'.repeat(10000))+'```';
    const file=textFile(source);expect(await file.text()).toBe(source);expect(file.name).toBe('codigo-ts.md');
    expect(file.size).toBe(new TextEncoder().encode(source).byteLength);
    expect(()=>textFile('😀'.repeat(300_000))).toThrow();
  });
});
