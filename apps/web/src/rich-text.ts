/** Bounded plain-text formatting. No HTML is accepted or executed. Offsets refer to the original source. */
export type RichBlock = { kind: 'text' | 'code' | 'bullet'; start: number; end: number; language?: string };
export const RENDER_TEXT_LIMIT = 32_000;
export const LONG_TEXT_LIMIT = 8_000;
export const TEXT_FILE_LIMIT = 1024 * 1024;
export function richBlocks(raw: string): RichBlock[] {
  const text = raw.slice(0, RENDER_TEXT_LIMIT), out: RichBlock[] = [];
  let at = 0, plain = 0, lines = 0;
  const pushPlain = (end: number) => { if (end > plain) out.push({ kind: 'text', start: plain, end }); };
  while (at < text.length && lines++ < 600) {
    const nl = text.indexOf('\n', at), end = nl < 0 ? text.length : nl + 1;
    const line = text.slice(at, end);
    if (line.startsWith('```')) {
      const language = line.slice(3).trim().slice(0, 30);
      const stop = text.indexOf('\n```', end - 1);
      if (stop >= end - 1) {
        pushPlain(at); out.push({ kind: 'code', start: end, end: stop, language });
        const closeEnd = text.indexOf('\n', stop + 4); at = closeEnd < 0 ? text.length : closeEnd + 1; plain = at; continue;
      }
    }
    if (/^[-*] \S/.test(line) || /^\d{1,4}\. \S/.test(line)) {
      pushPlain(at); const prefix = line.indexOf(' ') + 1;
      out.push({ kind: 'bullet', start: at + prefix, end: nl < 0 ? end : end - 1 }); plain = end;
    }
    at = end;
  }
  pushPlain(text.length); return out;
}
export function textFile(raw: string): File {
  const blob = new Blob([raw], { type: 'text/plain;charset=utf-8' });
  if (blob.size > TEXT_FILE_LIMIT) throw new Error('El texto supera 1 MiB. Adjunta el archivo original.');
  const fence = /^```([\w+-]+)\r?\n/.exec(raw);
  const extensions: Record<string,string> = { javascript:'js', js:'js', typescript:'ts', ts:'ts', python:'py', py:'py', json:'json', css:'css', html:'html', sql:'sql', bash:'sh', sh:'sh', swift:'swift', kotlin:'kt', java:'java', rust:'rs', yaml:'yaml' };
  const ext = fence ? extensions[fence[1]!.toLowerCase()] : undefined;
  // File preserves every original byte, including Markdown fences; use .md for fenced source.
  return new File([blob], ext ? `codigo-${ext}.md` : 'mensaje.txt', { type: blob.type });
}
