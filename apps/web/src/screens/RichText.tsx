import { Fragment, useMemo, type ReactNode } from 'react';
import { richBlocks, RENDER_TEXT_LIMIT } from '../rich-text.ts';
import { copyText, toast } from '../menu.tsx';
import { locale } from '../i18n.ts';
const label = (es: string, en: string) => locale().startsWith('en') ? en : es;
/** Safe, bounded Markdown subset: code fences, bold, italics, bullets and inline code. */
export function RichText({ text, plain }: { text: string; plain?: (start: number, end: number) => ReactNode }) {
  const blocks = useMemo(() => richBlocks(text), [text]);
  const renderPlain = plain ?? ((a: number, b: number) => text.slice(a, b));
  const inline = (start: number, end: number) => {
    const source = text.slice(start, end), out: ReactNode[] = [];
    const pattern = /(`[^`\n]{1,4000}`|\*\*[^*\n]{1,4000}\*\*|__[^_\n]{1,4000}__|\*[^*\n]{1,2000}\*)/g;
    let last = 0, match: RegExpExecArray | null, n = 0;
    while ((match = pattern.exec(source)) && n++ < 400) {
      if (match.index > last) out.push(<Fragment key={`${last}t`}>{renderPlain(start + last, start + match.index)}</Fragment>);
      const value = match[0], width = value.startsWith('**') || value.startsWith('__') ? 2 : 1;
      const content = value.startsWith('`') ? value.slice(1,-1) : renderPlain(start + match.index + width, start + pattern.lastIndex - width);
      out.push(value.startsWith('`') ? <code key={match.index}>{content}</code> : width === 2 || value.startsWith('*') ? <strong key={match.index}>{content}</strong> : <em key={match.index}>{content}</em>);
      last = pattern.lastIndex;
    }
    out.push(<Fragment key="tail">{renderPlain(start + last, end)}</Fragment>); return out;
  };
  const download = () => { const href=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'})); const a=document.createElement('a');a.href=href;a.download='mensaje.txt';a.click();setTimeout(()=>URL.revokeObjectURL(href),1000); };
  return <span className="rich-text">{blocks.map((b,i) => b.kind === 'code' ? <span className="code-block" key={i}>
    <span className="code-toolbar"><span>{b.language || label('Código','Code')}</span><button type="button" onClick={(e) => { e.stopPropagation(); void copyText(text.slice(b.start,b.end)).then((ok) => toast(ok ? label('Código copiado','Code copied') : label('No se pudo copiar','Could not copy'))); }}>{label('Copiar código','Copy code')}</button></span>
    <pre><code>{text.slice(b.start,b.end)}</code></pre></span> : b.kind === 'bullet' ? <span className="rich-bullet" key={i}><span aria-hidden>• </span>{inline(b.start,b.end)}</span> : <Fragment key={i}>{inline(b.start,b.end)}</Fragment>)}
    {text.length > RENDER_TEXT_LIMIT && <button className="btn small" onClick={download}>{label('Descargar mensaje completo','Download full message')}</button>}
  </span>;
}
