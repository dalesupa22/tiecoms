/** HTML de un correo listo para pintarlo (docs/CORREO.md › Ver el correo con su diseño). Sin dependencias: se prueba solo. */
const MAX_HTML = 600_000;
/** rewrite: lleva cada imagen http(s) al proxy de chaggu (la app solo carga imágenes propias; el remitente no ve la IP). */
export function safeHtml(html: string, rewrite?: (url: string) => string): string {
  const clean = html.slice(0, MAX_HTML)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|iframe|object|embed|applet|form|noscript|template|svg|math)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(script|iframe|object|embed|applet|form|input|button|select|textarea|base|meta|link|frame|frameset)\b[^>]*>/gi, '')
    .replace(/\s(on[a-z]+|srcdoc|formaction)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src|action|background|xlink:href)\s*=\s*(["']?)\s*(javascript|vbscript|data:text\/html)[^"'>\s]*\2/gi, '')
    // Imágenes incrustadas por cid: no se pueden servir aquí; se quitan para no dejar cajas rotas.
    .replace(/\ssrc\s*=\s*(["'])cid:[^"']*\1/gi, '')
    .replace(/expression\s*\(/gi, '')
    .replace(/url\s*\(\s*(["']?)\s*javascript:[^)]*\)/gi, 'none');
  if (!rewrite) return clean;
  const ent = (u: string) => u.replace(/&amp;/g, '&');
  return clean
    .replace(/\s(src|background)\s*=\s*(["'])(https?:\/\/[^"']+)\2/gi, (_, a: string, q: string, u: string) => ` ${a}=${q}${rewrite(ent(u))}${q}`)
    .replace(/url\(\s*(["']?)(https?:\/\/[^)"']+)\1\s*\)/gi, (_, q: string, u: string) => `url(${q}${rewrite(ent(u))}${q})`);
}
