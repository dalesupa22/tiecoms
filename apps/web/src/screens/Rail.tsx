import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { BootstrapDTO, ConversationDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { t } from '../i18n.ts';
import { openMenuAt, type MenuItem } from '../menu.tsx';
import { BASE, asset, navigate, type Route } from '../router.ts';
import { rememberBack, usePanes, usePulse } from '../split.ts';
import { GridGlyph } from './Tray.tsx';
import { pendingOf } from '../home-order.ts';
import { openAccountMenu } from './Profile.tsx';
import { MeAvatar } from './Silence.tsx';

/**
 * Riel de la web de escritorio (opción A, Danny 29-sep-2026): la barra lateral queda para los chats y las
 * secciones pasan a íconos. Los canales (Grupos, DMs, WhatsApp, Correo) se prenden con su color y el número
 * de no leídos; las herramientas (Agenda, Tareas, Llamadas) solo con un punto cuando hay algo tuyo hoy.
 */

// ---------- Qué lista muestra la barra: Todo (Hoy), Grupos o DMs ----------
export type SideMode = 'all' | 'groups' | 'dms';
const MODE_KEY = 'chaggu:sidebarTab';
const modeStore = (() => {
  let value: SideMode = (() => { try { const v = localStorage.getItem(MODE_KEY); return v === 'groups' || v === 'dms' ? v : 'all'; } catch { return 'all'; } })();
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (v: SideMode) => { value = v; try { localStorage.setItem(MODE_KEY, v); } catch {} listeners.forEach((l) => l()); },
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  };
})();
export const useSideMode = () => useSyncExternalStore(modeStore.subscribe, modeStore.get);
export const setSideMode = modeStore.set;

export const isDmRow = (c: ConversationDTO) => (c.kind === 'direct' || c.kind === 'multi') && !(c.parentId && c.deriveKind !== 'side');
const isGroupRow = (c: ConversationDTO) => !!c.workspaceId && c.deriveKind !== 'side';
const sum = (d: BootstrapDTO, f: (c: ConversationDTO) => boolean) => d.conversations.filter(f).reduce((n, c) => n + pendingOf(c), 0);

// ---------- WhatsApp y correo: chats con no leídos (WhatsApp) y correos sin leer en Principal (Gmail/Outlook) ----------
function useWaUnread() {
  const rev = useClient((s) => s.waRevision);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    client.request<{ categories: Record<string, { unread: number }> }>('/whatsapp/chats?limit=1')
      .then((r) => live && setN(Object.values(r.categories ?? {}).reduce((k, c) => k + (c?.unread ?? 0), 0)))
      .catch(() => {});
    return () => { live = false; };
  }, [rev]);
  return n;
}
function useMailUnread(on: boolean) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) { setN(0); return; }
    let live = true;
    const load = () => { if (document.visibilityState === 'visible') client.mailUnread().then((v) => live && setN(v)).catch(() => {}); };
    load();
    const id = setInterval(load, 120_000);
    addEventListener('focus', load);
    return () => { live = false; clearInterval(id); removeEventListener('focus', load); };
  }, [on]);
  return n;
}

// ---------- Íconos de línea (mismo trazo que la barra móvil) ----------
const ICONS: Record<string, ReactNode> = {
  today: <><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></>,
  groups: <><circle cx="8" cy="8" r="3" /><circle cx="16" cy="8" r="3" /><path d="M2.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5M12.5 15.2c.9-.8 2.1-1.2 3.5-1.2 2.7 0 4.9 1.8 5.5 5" /></>,
  dms: <><path d="M3.5 6.5A2.5 2.5 0 0 1 6 4h8a2.5 2.5 0 0 1 2.5 2.5v5A2.5 2.5 0 0 1 14 14H8.5L5 17v-3.1A2.5 2.5 0 0 1 3.5 11.5z" /><path d="M16.5 8.5H18a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 0 1-1.5 2.3V21l-3.2-2.5H12a2.5 2.5 0 0 1-2.3-1.5" /></>,
  whatsapp: <><path d="M4 20l1.2-4.1A8 8 0 1 1 8.3 19z" /><path d="M9 9.2c0 3 2.8 5.8 5.8 5.8l1-1.3-1.8-1-1 .9a4 4 0 0 1-2.4-2.4l.9-1-1-1.8z" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="m4 7 8 6 8-6" /></>,
  agenda: <><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
  tasks: <><path d="M4 6.5l1.8 1.8L9 5M4 16.5l1.8 1.8L9 15" /><path d="M12 7h8M12 17h8" /></>,
  trazo: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="7" r="2" /><path d="M6 7v10M18 9c0 5-12 3-12 8" /></>,
  calls: <path d="M6.6 3.5h2.3l1.4 4-2 1.3a11 11 0 0 0 6.9 6.9l1.3-2 4 1.4v2.3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z" />,
  more: <><circle cx="5.5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="18.5" cy="12" r="1.2" /></>,
};
const Icon = ({ name }: { name: string }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{ICONS[name]}</svg>
);

type Tone = 'brand' | 'wa' | 'mail' | 'call' | 'missed';
function RailItem({ icon, label, on, count, tone = 'brand', dot, at, onClick }: {
  icon: string; label: string; on: boolean; count?: number; tone?: Tone; dot?: boolean; at?: number; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const lit = (count ?? 0) > 0 || (at ?? 0) > 0;
  const n = count ?? 0;
  const aria = n > 0 ? `${label}, ${n}` : label;
  return (
    <button className={`rail-item ${on ? 'on' : ''} ${lit ? `lit tone-${tone}` : ''}`} onClick={onClick} title={label} aria-label={aria} aria-current={on ? 'page' : undefined}>
      <Icon name={icon} />
      <span className="rail-label">{label}</span>
      {(at ?? 0) > 0 ? <span className="rail-count tone-brand">@{at! > 1 ? at : ''}</span>
        : n > 0 ? <span className={`rail-count tone-${tone}`}>{n > 99 ? '99+' : n}</span>
        : dot ? <span className={`rail-dot tone-${tone}`} /> : null}
    </button>
  );
}

const PAGES_MORE: { name: Route['name']; label: string; icon: string; to: string }[] = [
  { name: 'saved', label: 'nav.saved', icon: '🔖', to: '/ver-despues' },
  { name: 'scheduled', label: 'nav.scheduled', icon: '🕒', to: '/programados' },
  { name: 'signed', label: 'nav.signed', icon: '✍️', to: '/firmas' },
  { name: 'files', label: 'nav.files', icon: '▣', to: '/archivos' },
  { name: 'people', label: 'nav.people', icon: '◎', to: '/participantes' },
];

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function Rail({ route }: { route: Route }) {
  const d = useClient((s) => s.data)!;
  const mode = useSideMode();
  const callsOn = d.features?.calls === true;
  const mailOn = d.features?.mail === true;
  const wa = useWaUnread();
  const mail = useMailUnread(mailOn);
  const groups = sum(d, isGroupRow);
  const dms = sum(d, isDmRow);
  const mentions = d.conversations.reduce((n, c) => n + (c.unreadMentions ?? 0), 0);
  // Agenda: una reunión mía que empieza en las próximas 2 horas (o ya empezó y no ha terminado).
  const soon = useClient((s) => Object.values(s.events).some((e) => {
    if (e.cancelledAt) return false;
    const a = Date.parse(e.startsAt), b = Date.parse(e.endsAt), now = Date.now();
    return a - now < 2 * 3600_000 && b > now && (e.organizerId === d.me.id || e.invitees.some((i) => i.userId === d.me.id && i.rsvp !== 'no'));
  }));
  // Tareas: una tarea mía abierta que vence hoy o ya se venció.
  const due = useClient((s) => {
    const today = ymd(new Date());
    return Object.values(s.issues).some((i) => i.ownerId === d.me.id && !i.closedAt && !!i.dueDate && i.dueDate.slice(0, 10) <= today);
  });
  // Llamadas: verde si estoy en una; punto si hay una en curso en mis chats.
  const calls = useClient((s) => s.calls);
  const inCall = Object.values(calls).some((c) => c && !c.endedAt && c.activeUserIds.includes(d.me.id));
  const anyCall = Object.values(calls).some((c) => c && !c.endedAt && c.activeUserIds.length > 0);
  // Perdidas sin ver: número rojo; se quita al abrir Llamadas (POST /calls/seen).
  const missed = d.missedCalls ?? 0;

  const panes = usePanes();
  const pulse = usePulse();
  // La cuadrícula siempre a la mano: un 2×2 vivo que se llena al fijar. Entrar guarda de dónde vienes para el «← Volver».
  const goGrid = () => { rememberBack(route.name === 'grid' ? null : location.pathname.slice(BASE.length) || '/'); navigate('/cuadricula'); };
  const pick = (m: SideMode) => { setSideMode(m); if (m === 'all') navigate('/'); };
  const more = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const items: MenuItem[] = PAGES_MORE.map((p) => ({ label: t(p.label as never), icon: p.icon, hint: route.name === p.name ? '✓' : undefined, onSelect: () => navigate(p.to) }));
    openMenuAt(r.right + 6, r.top, items);
  };
  const moreOn = PAGES_MORE.some((p) => p.name === route.name);

  return (
    <nav className="rail" aria-label={t('nav.mainNav')}>
      <button className="rail-logo" onClick={() => pick('all')} aria-label="chaggu" title="chaggu"><img src={asset('/icon.svg')} alt="" width={30} height={30} /></button>
      <RailItem icon="today" label={t('nav.today')} on={mode === 'all'} at={mentions} onClick={() => pick('all')} />
      <button className={`rail-item rail-grid ${route.name === 'grid' ? 'on' : ''} ${panes.length ? 'lit tone-brand' : ''}`} onClick={goGrid} title={t('nav.grid')} aria-label={panes.length ? `${t('nav.grid')}, ${panes.length}/4` : t('nav.grid')} aria-current={route.name === 'grid' ? 'page' : undefined}>
        <span key={pulse} className={pulse ? 'glyph-pulse' : ''}><GridGlyph /></span>
        <span className="rail-label">{t('nav.grid')}</span>
        {panes.length > 0 && <span className="rail-count tone-brand">{panes.length}/4</span>}
      </button>
      <RailItem icon="groups" label={t('nav.groups')} on={mode === 'groups'} count={groups} onClick={() => pick(mode === 'groups' ? 'all' : 'groups')} />
      <RailItem icon="dms" label={t('nav.dms')} on={mode === 'dms'} count={dms} onClick={() => pick(mode === 'dms' ? 'all' : 'dms')} />
      <RailItem icon="whatsapp" label={t('nav.whatsapp')} on={route.name === 'whatsapp'} count={wa} tone="wa" onClick={() => navigate('/whatsapp')} />
      {mailOn && <RailItem icon="mail" label={t('nav.mail')} on={route.name === 'mail'} count={mail} tone="mail" onClick={() => navigate('/correo')} />}
      <span className="rail-sep" aria-hidden />
      <RailItem icon="agenda" label={t('nav.agenda')} on={route.name === 'agenda'} dot={soon} onClick={() => navigate('/agenda')} />
      <RailItem icon="tasks" label={t('nav.issues')} on={route.name === 'issues'} dot={due} onClick={() => navigate('/asuntos')} />
      <RailItem icon="trazo" label={t('nav.trazo')} on={route.name === 'trazo'} onClick={() => navigate('/trazo')} />
      {callsOn && <RailItem icon="calls" label={missed > 0 ? t('calls.missedN', { n: missed }) : t('nav.calls')} on={route.name === 'calls'} count={missed} tone={missed > 0 ? 'missed' : 'call'} dot={anyCall || inCall} onClick={() => navigate('/llamadas')} />}
      <span className="grow" />
      <RailItem icon="more" label={t('nav.more')} on={moreOn} onClick={more} />
      <button className="rail-me" aria-haspopup="menu" title={t('profile.menu')} aria-label={t('profile.menu')} onClick={(e) => openAccountMenu(e.currentTarget)}>
        <MeAvatar size={34} />
      </button>
    </nav>
  );
}
