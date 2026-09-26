import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { QUICK_REACTIONS, REACTION_ACTIONS, normalizeEmoji, type BootstrapDTO, type MessageDTO, type ReactionDTO } from '@tiecoms/contracts';
import { client } from '../app-client.ts';
import { errorText, getLang, locale, t } from '../i18n.ts';
import { toast } from '../menu.tsx';
import { orgById, personById } from '../ui.tsx';

/**
 * Reacciones y emojis (mismas reglas en web, iOS y Android: docs/REACCIONES_ENLACES.md).
 * El catálogo (emojibase, ~570 KB por idioma) se carga solo al abrir el selector o escribir «:».
 */
export interface EmojiItem { e: string; label: string; tags: string[]; codes: string[]; group: number; skins?: string[] }

let catalog: Promise<EmojiItem[]> | null = null;
let catalogLang = '';
export function loadEmojis(): Promise<EmojiItem[]> {
  const lang = getLang();
  if (catalog && catalogLang === lang) return catalog;
  catalogLang = lang;
  catalog = (async () => {
    const [data, codes] = await Promise.all([
      lang === 'es' ? import('emojibase-data/es/compact.json') : import('emojibase-data/en/compact.json'),
      import('emojibase-data/en/shortcodes/github.json'),
    ]);
    const sc = (codes.default ?? codes) as unknown as Record<string, string | string[]>;
    const list = (data.default ?? data) as unknown as { hexcode: string; unicode: string; label: string; tags?: string[]; group?: number; order?: number; skins?: { unicode: string }[] }[];
    return list
      .filter((x) => x.group !== undefined && x.group !== 2)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((x) => {
        const c = sc[x.hexcode];
        return { e: normalizeEmoji(x.unicode) ?? x.unicode, label: x.label, tags: x.tags ?? [], codes: c ? (Array.isArray(c) ? c : [c]) : [], group: x.group!, skins: x.skins?.map((s) => normalizeEmoji(s.unicode) ?? s.unicode) };
      });
  })();
  return catalog;
}

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
/** El código que coincide con lo escrito (:thumbsup: antes que :+1:). */
const codeFor = (x: EmojiItem, q: string) => x.codes.find((c) => c.startsWith(fold(q))) ?? x.codes[0];
export function searchEmojis(list: EmojiItem[], q: string, max = 60) {
  const f = fold(q.trim().replace(/^:/, ''));
  if (!f) return [];
  const score = (x: EmojiItem) => {
    if (x.codes.some((c) => c === f)) return 0;
    if (x.codes.some((c) => c.startsWith(f))) return 1;
    if (fold(x.label).startsWith(f)) return 2;
    if (x.tags.some((tg) => fold(tg).startsWith(f))) return 3;
    if (fold(x.label).includes(f)) return 4;
    return -1;
  };
  return list.map((x) => ({ x, s: score(x) })).filter((r) => r.s >= 0).sort((a, b) => a.s - b.s).slice(0, max).map((r) => r.x);
}

// ---------- Preferencias locales (solo de este dispositivo) ----------
const RECENT_KEY = 'tiecoms:emoji-recent';
const SKIN_KEY = 'tiecoms:emoji-skin';
const readLocal = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const writeLocal = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} };
export function recentEmojis(): string[] { try { return JSON.parse(readLocal(RECENT_KEY) ?? '[]'); } catch { return []; } }
export function rememberEmoji(e: string) { writeLocal(RECENT_KEY, JSON.stringify([e, ...recentEmojis().filter((x) => x !== e)].slice(0, 24))); }
const skinIndex = () => Number(readLocal(SKIN_KEY) ?? 0) || 0;
const withSkin = (x: EmojiItem, skin: number) => (skin > 0 && x.skins?.[skin - 1]) || x.e;

// ---------- Selector (un solo host, como el menú) ----------
interface PickerState { x: number; y: number; onPick: (emoji: string) => void; quick: boolean; actions: boolean }
let picker: PickerState | null = null;
const pickerListeners = new Set<() => void>();
const setPicker = (p: PickerState | null) => { picker = p; pickerListeners.forEach((l) => l()); };
/** Abre el selector junto a un punto. quick = arriba la barra rápida de reacciones. */
export function openEmojiPicker(x: number, y: number, onPick: (emoji: string) => void, opts: { quick?: boolean; actions?: boolean } = {}) {
  setPicker({ x, y, onPick, quick: !!opts.quick, actions: !!opts.actions });
}

const GROUPS: [number, string][] = [[0, '😀'], [1, '👋'], [3, '🐻'], [4, '🍔'], [5, '✈️'], [6, '⚽'], [7, '💡'], [8, '🔣'], [9, '🏳️']];

export function EmojiPickerHost() {
  const p = useSyncExternalStore((l) => { pickerListeners.add(l); return () => pickerListeners.delete(l); }, () => picker);
  if (!p) return null;
  return <EmojiPicker key={`${p.x}:${p.y}`} state={p} onClose={() => setPicker(null)} />;
}

function EmojiPicker({ state, onClose }: { state: PickerState; onClose: () => void }) {
  const [list, setList] = useState<EmojiItem[] | null>(null);
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<number | 'recent'>(recentEmojis().length ? 'recent' : 0);
  const [skin, setSkin] = useState(skinIndex);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: state.x, top: state.y });
  useEffect(() => { void loadEmojis().then(setList).catch(() => setList([])); }, []);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose(); };
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    setTimeout(() => document.addEventListener('mousedown', down), 0);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, []);
  // Dentro de la pantalla: se abre hacia arriba si no cabe abajo.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(state.x, window.innerWidth - r.width - 8));
    const top = state.y + r.height + 8 > window.innerHeight ? Math.max(8, state.y - r.height - 12) : state.y;
    setPos({ left, top });
  }, [list === null]);
  const pick = (e: string) => { rememberEmoji(e); state.onPick(e); onClose(); };
  const shown = useMemo(() => {
    if (!list) return [];
    if (q.trim()) return searchEmojis(list, q, 120);
    if (group === 'recent') {
      const r = recentEmojis();
      return r.map((e) => list.find((x) => x.e === e || x.skins?.includes(e)) ?? { e, label: e, tags: [], codes: [], group: -1 });
    }
    return list.filter((x) => x.group === group);
  }, [list, q, group]);
  const hint = (e: string) => (state.actions && e === REACTION_ACTIONS.look ? t('react.lookHint') : state.actions && e === REACTION_ACTIONS.done ? t('react.doneHint') : undefined);
  return (
    <div ref={box} className="emoji-picker" style={{ left: pos.left, top: pos.top }} role="dialog" aria-label={t('react.picker')}>
      {state.quick && (
        <div className="emoji-quick">
          {QUICK_REACTIONS.map((e) => (
            <button key={e} className={hint(e) ? 'has-action' : ''} title={hint(e)} aria-label={hint(e) ?? e} onClick={() => pick(e)}>{e}</button>
          ))}
        </div>
      )}
      <div className="emoji-search">
        <input className="input" autoFocus value={q} placeholder={t('react.search')} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && shown[0]) { e.preventDefault(); pick(withSkin(shown[0], skin)); } }} />
        <select className="emoji-skin" value={skin} aria-label={t('react.skin')} onChange={(e) => { setSkin(Number(e.target.value)); writeLocal(SKIN_KEY, e.target.value); }}>
          {['✋', '✋🏻', '✋🏼', '✋🏽', '✋🏾', '✋🏿'].map((s, i) => <option key={s} value={i}>{s}</option>)}
        </select>
      </div>
      {!q && (
        <div className="emoji-tabs" role="tablist">
          <button role="tab" aria-selected={group === 'recent'} className={group === 'recent' ? 'on' : ''} title={t('react.recent')} onClick={() => setGroup('recent')}>🕘</button>
          {GROUPS.map(([g, ico]) => <button key={g} role="tab" aria-selected={group === g} className={group === g ? 'on' : ''} onClick={() => setGroup(g)}>{ico}</button>)}
        </div>
      )}
      <div className="emoji-grid">
        {list === null && <div className="muted small" style={{ gridColumn: '1 / -1', padding: 12 }}>{t('common.loading')}</div>}
        {list && !shown.length && <div className="muted small" style={{ gridColumn: '1 / -1', padding: 12 }}>{q ? t('react.none') : t('react.noRecent')}</div>}
        {shown.map((x) => { const e = withSkin(x, skin); return <button key={x.e} title={x.codes[0] ? `${x.label} · :${x.codes[0]}:` : x.label} onClick={() => pick(e)}>{e}</button>; })}
      </div>
    </div>
  );
}

// ---------- Reacciones bajo el mensaje ----------
/** «Laura (Xertify), Beto y Julián · WhatsApp». */
export function reactorsText(d: BootstrapDTO, r: ReactionDTO) {
  const names = r.userIds.map((u) => {
    if (u === d.me.id) return t('common.youShort');
    const p = personById(d, u);
    const o = orgById(d, p?.orgId);
    return p ? (o && o.id !== d.me.primaryOrgId ? `${p.name} (${o.name})` : p.name) : t('chat.formerParticipant');
  });
  for (const x of r.external ?? []) names.push(`${x.name} · ${t(`src.${x.source}` as any)}`);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} ${t('common.and')} ${names[names.length - 1]}` : names[0] ?? '';
}

/** Recordatorio de 👀: en 3 horas, o mañana a las 9 si eso cae de noche. */
export function lookRemindAt(now = new Date()) {
  const at = new Date(now.getTime() + 3 * 3600_000);
  if (at.getHours() >= 19 || at.getDate() !== now.getDate()) {
    const next = new Date(now); next.setDate(now.getDate() + 1); next.setHours(9, 0, 0, 0);
    return next;
  }
  return at;
}

export async function toggleReaction(m: MessageDTO, emoji: string, on: boolean, opts: { actions: boolean; onIssue?: (id: string) => void }) {
  try {
    const remindAt = on && opts.actions && emoji === REACTION_ACTIONS.look ? lookRemindAt().toISOString() : undefined;
    const r = await client.react(m, emoji, on, { remindAt });
    if (r.reminder) toast(t('react.lookDone', { time: new Date(r.reminder.remindAt).toLocaleString(locale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' }) }));
    else if (on && emoji === REACTION_ACTIONS.done && r.closedReminderIds?.length) toast(t('react.doneReminders'));
    if (r.openIssueId) {
      const issue = client.getState().issues[r.openIssueId];
      toast(t('react.closeIssue', { title: issue?.title ?? '' }), { label: t('react.closeIssueBtn'), run: () => void client.updateIssue(r.openIssueId!, { status: 'done' }).then(() => toast(t('react.issueClosed'))).catch((e) => toast(errorText(e))) }, 8000);
    }
  } catch (e) { toast(errorText(e)); }
}

export function ReactionBar({ d, m, canReact, actions, onIssue }: { d: BootstrapDTO; m: MessageDTO; canReact: boolean; actions: boolean; onIssue?: (id: string) => void }) {
  const list = (m.reactions ?? []).filter((r) => r.userIds.length || r.external?.length);
  if (!list.length) return null;
  return (
    <div className="rx-bar">
      {list.map((r) => {
        const mine = r.userIds.includes(d.me.id);
        const n = r.userIds.length + (r.external?.length ?? 0);
        return (
          <button key={r.emoji} className={`rx-chip ${mine ? 'mine' : ''}`} disabled={!canReact} title={reactorsText(d, r)}
            aria-label={t('react.chipLabel', { emoji: r.emoji, n, names: reactorsText(d, r) })} aria-pressed={mine}
            onClick={() => void toggleReaction(m, r.emoji, !mine, { actions, onIssue })}>
            <span className="rx-emoji">{r.emoji}</span><b>{n}</b>
          </button>
        );
      })}
      {canReact && (
        <button className="rx-chip rx-add" aria-label={t('react.add')} title={t('react.add')}
          onClick={(e) => { const rr = (e.currentTarget as HTMLElement).getBoundingClientRect(); openEmojiPicker(rr.left, rr.bottom + 6, (emoji) => void toggleReaction(m, emoji, true, { actions, onIssue }), { quick: true, actions }); }}>☺＋</button>
      )}
    </div>
  );
}

/** Solo emojis (1 a 3): el mensaje se muestra grande. */
export function isJumbo(body: string) {
  const s = body.trim();
  if (!s || s.length > 40) return false;
  const Seg = (Intl as any).Segmenter;
  if (!Seg) return false;
  const parts = [...new Seg(undefined, { granularity: 'grapheme' }).segment(s.replace(/\s+/g, ''))].map((x: any) => x.segment as string);
  return parts.length >= 1 && parts.length <= 3 && parts.every((g) => /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(g));
}

// ---------- «:» en el compositor ----------
/** Al escribir «:pal» aparece una lista de emojis; Enter o Tab lo inserta. */
export function useEmojiAutocomplete({ text, caret, onPick }: { text: string; caret: number; onPick: (range: { start: number; end: number }, emoji: string) => void }) {
  const [list, setList] = useState<EmojiItem[] | null>(null);
  const [index, setIndex] = useState(0);
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const m = /(^|\s):([\p{L}\p{N}_+\-]{2,30})$/u.exec(text.slice(0, caret));
  const query = m ? m[2]! : null;
  useEffect(() => { if (query && !list) void loadEmojis().then(setList).catch(() => {}); }, [query]);
  const start = m ? caret - query!.length - 1 : -1;
  const matches = query && list && closedAt !== start ? searchEmojis(list, query, 8) : [];
  useEffect(() => setIndex(0), [query]);
  const pick = (x: EmojiItem) => { rememberEmoji(x.e); onPick({ start, end: caret }, x.e); };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!matches.length) return false;
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => (i + 1) % matches.length); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => (i - 1 + matches.length) % matches.length); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(matches[index]!); return true; }
    if (e.key === 'Escape') { e.preventDefault(); setClosedAt(start); return true; }
    return false;
  };
  const view = matches.length ? (
    <div className="emoji-suggest" role="listbox" aria-label={t('react.suggest')}>
      {matches.map((x, i) => (
        <button key={x.e} role="option" aria-selected={i === index} className={i === index ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); pick(x); }}>
          <span className="emoji-suggest-e">{x.e}</span><span className="grow ellipsis">{codeFor(x, query!) ? `:${codeFor(x, query!)}:` : x.label}</span><span className="muted small ellipsis">{x.label}</span>
        </button>
      ))}
    </div>
  ) : null;
  return { view, onKeyDown };
}
