/** Parte pura de chat-bg.ts (se prueba en test/panes-core.test.ts). */
export type BgPattern = 'dots' | 'lines' | 'waves' | 'grid';
export interface ChatBg { id: string; tone: number; pattern?: BgPattern; label: string }
/** tone = índice de --cbg-N (styles.css) y del acento del panel (--gc-N-fg). */
export const CHAT_BGS: ChatBg[] = [
  { id: 'cielo', tone: 0, label: 'bg.cielo' },
  { id: 'menta', tone: 1, label: 'bg.menta' },
  { id: 'lila', tone: 2, label: 'bg.lila' },
  { id: 'agua', tone: 3, label: 'bg.agua' },
  { id: 'rosa', tone: 4, label: 'bg.rosa' },
  { id: 'durazno', tone: 5, label: 'bg.durazno' },
  { id: 'indigo', tone: 6, label: 'bg.indigo' },
  { id: 'coral', tone: 7, label: 'bg.coral' },
  { id: 'puntos', tone: 0, pattern: 'dots', label: 'bg.puntos' },
  { id: 'lineas', tone: 3, pattern: 'lines', label: 'bg.lineas' },
  { id: 'ondas', tone: 1, pattern: 'waves', label: 'bg.ondas' },
  { id: 'cuadros', tone: 6, pattern: 'grid', label: 'bg.cuadros' },
];
export const TONES = 8;
const byId = new Map(CHAT_BGS.map((b) => [b.id, b]));

/** Hash estable del id (el mismo en todas las sesiones): el fondo automático de un chat no cambia. */
export function autoTone(id: string) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % TONES;
}
/**
 * Fondo que se ve: el elegido; si no hay y hay varios paneles, el automático (solo tono, sin patrón); con 1 panel,
 * ninguno. 'none' = «Sin fondo» elegido a propósito (también en paralelo).
 */
export function effectiveBg(choice: string | undefined, id: string, multi: boolean): ChatBg | null {
  if (choice === 'none') return null;
  const picked = choice ? byId.get(choice) : undefined;
  if (picked) return picked;
  if (!multi) return null;
  const tone = autoTone(id);
  return { id: `auto-${tone}`, tone, label: 'bg.auto' };
}

