/**
 * Utilidades puras de la tanda 1.7 (docs/TANDA-1.7.md): #grupos en el compositor y en las burbujas, resaltado
 * de la búsqueda en el chat, fechas rápidas de «Nueva fecha» y quién abrió un mensaje de una sola vista.
 * Sin React ni DOM, para probarlas con vitest.
 */
import type { MentionDTO, MessageRefDTO } from '@tiecoms/contracts';

/** Un #grupo del compositor: «#Nombre» ligado a una conversación. */
export interface RefToken { conversationId: string; label: string }

/**
 * Offsets UTF-16 de cada #grupo dentro del texto (como mentionsFor con «@»). Los tokens cuyo texto ya no está
 * (se editó a mano) se descartan.
 */
export function refsFor(text: string, tokens: RefToken[]): { conversationId: string; start: number; length: number }[] {
  const out: { conversationId: string; start: number; length: number }[] = [];
  const used = new Set<number>();
  for (const tk of tokens) {
    const needle = `#${tk.label}`;
    let from = 0, at = -1;
    while ((at = text.indexOf(needle, from)) >= 0) {
      const end = at + needle.length;
      const before = at === 0 || /\s|\(/.test(text[at - 1]!);
      const after = end === text.length || !/[\p{L}\p{N}]/u.test(text[end]!);
      if (before && after && !used.has(at)) break;
      from = at + 1;
    }
    if (at >= 0) { used.add(at); out.push({ conversationId: tk.conversationId, start: at, length: needle.length }); }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Consulta activa de «#»: al inicio o tras espacio, hasta el cursor (sin salto de línea, ≤ 40). */
export function activeHashQuery(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf('#');
  if (at < 0 || (at > 0 && !/\s|\(/.test(upto[at - 1]!))) return null;
  const q = upto.slice(at + 1);
  if (q.length > 40 || /\n/.test(q) || /\s{2,}/.test(q)) return null;
  return { start: at, query: q };
}

/** Retroceso justo después de un #grupo: se borra entero. */
export function backspaceRef(text: string, caret: number, tokens: RefToken[]): { text: string; caret: number } | null {
  for (const r of refsFor(text, tokens)) {
    const end = r.start + r.length;
    if (caret === end || (caret === end + 1 && text[end] === ' ')) return { text: text.slice(0, r.start) + text.slice(caret), caret: r.start };
  }
  return null;
}

export type BodySegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; text: string; mention: MentionDTO }
  | { kind: 'ref'; text: string; ref: MessageRefDTO };

/** Parte el cuerpo en texto, menciones y #grupos (ordenados, sin solaparse; lo que no cuadra se ignora). */
export function segmentBody(body: string, mentions: MentionDTO[] = [], refs: MessageRefDTO[] = []): BodySegment[] {
  const marks = [
    ...mentions.map((m) => ({ start: m.start, length: m.length, seg: (text: string): BodySegment => ({ kind: 'mention', text, mention: m }) })),
    ...refs.map((r) => ({ start: r.start, length: r.length, seg: (text: string): BodySegment => ({ kind: 'ref', text, ref: r }) })),
  ].filter((m) => m.start >= 0 && m.length > 0 && m.start + m.length <= body.length).sort((a, b) => a.start - b.start);
  const out: BodySegment[] = [];
  let at = 0;
  for (const m of marks) {
    if (m.start < at) continue;
    if (m.start > at) out.push({ kind: 'text', text: body.slice(at, m.start) });
    out.push(m.seg(body.slice(m.start, m.start + m.length)));
    at = m.start + m.length;
  }
  if (at < body.length || !out.length) out.push({ kind: 'text', text: body.slice(at) });
  return out;
}

/** Sin tildes ni mayúsculas conservando el largo (1 a 1), para resaltar sobre el texto original. */
export function foldKeep(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const base = ch.normalize('NFD')[0] ?? ch;
    const low = base.toLowerCase();
    out += low.length === 1 ? low : ch;
  }
  return out;
}

/** Posiciones [inicio, largo] de la consulta dentro del texto, sin tildes ni mayúsculas. */
export function findMatches(text: string, query: string, max = 50): [number, number][] {
  const q = foldKeep(query.trim());
  if (q.length < 2) return [];
  const f = foldKeep(text);
  const out: [number, number][] = [];
  for (let i = f.indexOf(q); i >= 0 && out.length < max; i = f.indexOf(q, i + q.length)) out.push([i, q.length]);
  return out;
}

/** Lo que se resalta de la consulta: sin el filtro from:Nombre. */
export const searchTerms = (q: string) => q.replace(/(?:^|\s)from:(?:"[^"]+"|\S+)/i, ' ').replace(/\s+/g, ' ').trim();

/** «3 de 17» (con «+» si hay más en el servidor). i es el índice 0 = el más nuevo. */
export const resultPosition = (i: number, n: number, more: boolean) => ({ i: n ? i + 1 : 0, n: `${n}${more ? '+' : ''}` });

// ---------- «Nueva fecha» ----------
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** Hoy, Mañana y Próximo lunes (si hoy es lunes, el de la otra semana) en AAAA-MM-DD locales. */
export function quickDueDates(now = new Date()): { today: string; tomorrow: string; monday: string } {
  const at = (days: number) => { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days); return ymd(d); };
  const dow = now.getDay();
  const toMonday = ((8 - dow) % 7) || 7;
  return { today: at(0), tomorrow: at(1), monday: at(toMonday) };
}

// ---------- Una sola vista ----------
/** Qué es un mensaje de una sola vista para su burbuja: foto, nota de voz o texto. */
export function viewOnceKind(m: { attachments?: { kind?: string; contentType: string }[] }): 'photo' | 'voice' | 'message' {
  const a = m.attachments ?? [];
  if (a.some((x) => x.kind === 'voice')) return 'voice';
  if (a.some((x) => x.contentType.startsWith('image/'))) return 'photo';
  return 'message';
}
/** Una sola vista solo con texto, imágenes y notas de voz. */
export const viewOnceAllowed = (drafts: { contentType: string; kind?: string }[]) => drafts.every((a) => a.kind === 'voice' || a.contentType.startsWith('image/'));

// ---------- Mensajes de sistema de la tanda ----------
export type Notice17 =
  | { k: 'event.today'; eventId: string; title: string; startsAt: string; timezone: string }
  | { k: 'issue.done'; issueId: string; title: string; byId: string; byName: string }
  | { k: 'issue.overdue'; issueId: string; title: string; ownerId: string | null; ownerName: string | null; dueDate: string }
  | { k: 'issue.comments'; issueId: string; title: string; count: number; lastById: string; lastByName: string; lastExcerpt: string }
  | { k: 'event.comments'; eventId: string; title: string; count: number; lastById: string; lastByName: string; lastExcerpt: string };
export function parseNotice(body: string): Notice17 | null {
  if (!body.startsWith('{')) return null;
  try {
    const p = JSON.parse(body);
    return ['event.today', 'issue.done', 'issue.overdue', 'issue.comments', 'event.comments'].includes(p?.k) ? p as Notice17 : null;
  } catch { return null; }
}

/** Efectos (confeti, carita triste) una vez por mensaje y por dispositivo. */
const shown = new Set<string>();
export function claimEffect(store: Pick<Storage, 'getItem' | 'setItem'> | null, messageId: string): boolean {
  const key = `tiecoms:fx:${messageId}`;
  if (shown.has(key)) return false;
  shown.add(key);
  try {
    if (store?.getItem(key)) return false;
    store?.setItem(key, '1');
  } catch { /* sin almacenamiento: basta con la memoria de esta pestaña */ }
  return true;
}
