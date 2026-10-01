/** Reglas puras de los colores de los cuadritos (sin navegador, para poder probarlas). */
export const PALETTE = [
  { id: 'sage', name: 'tint.sage', dot: '🟢' },
  { id: 'sky', name: 'tint.sky', dot: '🔵' },
  { id: 'lilac', name: 'tint.lilac', dot: '🟣' },
  { id: 'peach', name: 'tint.peach', dot: '🟠' },
  { id: 'sand', name: 'tint.sand', dot: '🟡' },
  { id: 'rose', name: 'tint.rose', dot: '🌸' },
] as const;
export const IDS: string[] = PALETTE.map((p) => p.id);

/** El color de cada panel a la vista: el que eligió la persona ('none' = crema); si no, el asignado (si «cada uno con su color» está prendido). */
export function resolveTints(ch: Record<string, string>, as: Record<string, string>, on: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of new Set([...Object.keys(ch), ...Object.keys(as)])) {
    const c = ch[k] ?? (on ? as[k] : undefined);
    if (c && c !== 'none' && IDS.includes(c)) out[k] = c;
  }
  return out;
}
/** El color menos usado entre los paneles abiertos (el primero de la paleta si hay empate). */
export function leastUsed(used: string[]): string {
  const n = (id: string) => used.filter((u) => u === id).length;
  return IDS.reduce((best, id) => (n(id) < n(best) ? id : best), IDS[0]!);
}
