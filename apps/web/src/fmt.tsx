/**
 * Formato básico como en WhatsApp: *negrilla*, _cursiva_, ~tachado~ y `código`. Las marcas se quedan en el texto
 * (se ven tenues) para que copiar y las menciones sigan usando las mismas posiciones. Las viñetas («- » o «* » al
 * inicio de línea) se pintan como «• » en MessageText.
 */
const FMT = /(`[^`\n]{1,4000}`|\*[^\s*](?:[^*\n]{0,4000}[^\s*])?\*|_[^\s_](?:[^_\n]{0,4000}[^\s_])?_|~[^\s~](?:[^~\n]{0,4000}[^\s~])?~)/g;
const FMT_TAG = { '*': 'strong', _: 'em', '~': 's', '`': 'code' } as const;
export function Formatted({ text }: { text: string }) {
  const parts = text.split(FMT);
  if (parts.length === 1) return <>{text}</>;
  return <>{parts.map((part, i) => {
    if (i % 2 === 0) return part;
    // «_» dentro de una palabra (nombre_archivo) no es cursiva.
    const before = parts[i - 1]!.slice(-1), after = parts[i + 1]?.[0] ?? '';
    if (/[\p{L}\p{N}]/u.test(before) || /[\p{L}\p{N}]/u.test(after)) return part;
    const mark = part[0] as keyof typeof FMT_TAG;
    const Tag = FMT_TAG[mark];
    return <Tag key={i} className={`fmt fmt-${Tag}`}><span className="fmt-mark">{mark}</span>{part.slice(1, -1)}<span className="fmt-mark">{mark}</span></Tag>;
  })}</>;
}
