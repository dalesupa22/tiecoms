/**
 * Texto de un correo para leerlo en el chat. Los correos HTML pasados a texto traen el «alt» y la dirección de
 * cada imagen («header-logo [http://…/header.png]») y enlaces largos: las imágenes se quitan y los enlaces
 * quedan como «dominio ↗» clicable.
 */
export type MailPart = { text: string } | { href: string; label: string };

const LINK = /\[(https?:\/\/[^\]\s]+)\]|<(https?:\/\/[^>\s]+)>|(\bhttps?:\/\/[^\s<>"'\]]+)/gi;
const IMG = /\.(png|jpe?g|gif|svg|webp|bmp)(\?|#|$)|\/(img|images?|pixel|track|open)\b/i;
// Línea que solo es el «alt» de una imagen: una palabra sin espacios tipo header-logo, img_footer, spacer.
const ALT_LINE = /^[\t ]*[\w.-]*(logo|img|image|banner|icon|spacer|header|footer|pixel)[\w.-]*[\t ]*$/gim;

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u.slice(0, 40); } };

export function mailParts(raw: string): MailPart[] {
  const out: MailPart[] = [];
  let last = 0;
  for (const m of raw.matchAll(LINK)) {
    const url = m[1] ?? m[2] ?? m[3]!;
    const trail = m[3] ? url.match(/[.,;:!?)\]}»”’]+$/u)?.[0] ?? '' : '';
    const href = trail ? url.slice(0, -trail.length) : url;
    out.push({ text: raw.slice(last, m.index) });
    if (!IMG.test(href)) out.push({ href, label: host(href) });
    if (trail) out.push({ text: trail });
    last = m.index! + m[0].length;
  }
  out.push({ text: raw.slice(last) });
  // Se limpian las líneas que quedaron vacías o con solo el «alt» de la imagen.
  const joined: MailPart[] = [];
  for (const p of out) {
    const prev = joined[joined.length - 1];
    if ('text' in p && prev && 'text' in prev) { prev.text += p.text; continue; }
    joined.push({ ...p });
  }
  for (const p of joined) {
    if ('href' in p) continue;
    p.text = p.text.replace(ALT_LINE, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  }
  const first = joined[0]; if (first && 'text' in first) first.text = first.text.replace(/^\s+/, '');
  const end = joined[joined.length - 1]; if (end && 'text' in end) end.text = end.text.replace(/\s+$/, '');
  return joined;
}

/** Resumen de una línea sin direcciones ni «alt» de imágenes. */
export function mailSnippet(raw: string): string {
  return mailParts(raw).map((p) => ('href' in p ? '' : p.text)).join(' ').replace(/\s+/g, ' ').replace(/\s+([.,;:!?)])/g, '$1').trim();
}
