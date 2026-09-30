/** Texto de la búsqueda del chat sin dependencias (lo usan el API y las pruebas). */
const FROM = 'ÁÀÂÄÃÅáàâäãåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÖÕóòôöõÚÙÛÜúùûüÑñÇç';
const TO = 'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuNnCc';
const MAP = new Map([...FROM].map((ch, i) => [ch, TO[i]!]));

/** Igual que tiecoms_fold en SQL: 1 a 1, así las posiciones del texto plegado sirven sobre el original. */
export function fold(s: string): string {
  let out = '';
  for (const ch of s) { const m = MAP.get(ch) ?? ch; const l = m.toLowerCase(); out += l.length === m.length ? l : m; }
  return out;
}

/** Separa `from:Nombre` (o from:"Nombre con espacios") del resto de la consulta. */
export function parseQuery(raw: string): { text: string; from: string | null } {
  let from: string | null = null;
  const text = raw.replace(/(?:^|\s)from:(?:"([^"]+)"|(\S+))/i, (_m, q, w) => { from = String(q ?? w).trim(); return ' '; }).replace(/\s+/g, ' ').trim();
  return { text, from };
}

/** Fragmento de ~120 caracteres alrededor de la primera coincidencia y todas las coincidencias dentro de él. */
export function snippetFor(source: string, needle: string): { snippet: string; matches: [number, number][] } {
  const flat = source.replace(/\s+/g, ' ').trim();
  if (!needle) return { snippet: flat.slice(0, 120), matches: [] };
  const f = fold(flat), n = fold(needle);
  const first = f.indexOf(n);
  const start = first < 0 ? 0 : Math.max(0, first - 40);
  const end = Math.min(flat.length, Math.max(start + 120, first + n.length + 40));
  const pre = start > 0 ? '…' : '', post = end < flat.length ? '…' : '';
  const snippet = `${pre}${flat.slice(start, end)}${post}`;
  const fs = fold(snippet);
  const matches: [number, number][] = [];
  for (let i = fs.indexOf(n); i >= 0 && matches.length < 20; i = fs.indexOf(n, i + n.length)) matches.push([i, n.length]);
  return { snippet, matches };
}

