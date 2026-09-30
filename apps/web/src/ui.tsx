import { asset } from './router.ts';
import { useEffect, type ReactNode } from 'react';
import type { BootstrapDTO, ConversationDTO, OrganizationDTO, PersonDTO } from '@tiecoms/contracts';
import { attachmentSummaryText, locale, systemText, t } from './i18n.ts';
import { apiUrl } from './app-client.ts';
import { companyLine, companyOf } from './quick-search.ts';

export function initials(name: string) {
  // Solo palabras que empiezan con letra o número: «Laura (cliente)» → LC, no «L(».
  const parts = name.trim().split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+/u, '')).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1]![0] : '')).toUpperCase() || '?';
}

export function OrgMark({ org, size = 26 }: { org?: OrganizationDTO | null; size?: number }) {
  if (!org) return <span className="mark" style={{ width: size, height: size, background: 'var(--surface)', color: 'var(--ink-2)', fontSize: size * 0.42, border: '1px solid var(--line)' }}>◦</span>;
  return <span className="mark" title={org.name} style={{ width: size, height: size, background: org.colorBg, color: org.colorFg, fontSize: size * 0.4 }}>{org.mark}</span>;
}

/**
 * Color estable por persona (el mismo en web, iOS y Android): FNV-1a de 32 bits sobre
 * el id en minúsculas (caracteres ASCII), módulo 8. Paleta accesible con texto blanco, sin naranja
 * (el naranja es de la marca y de mis mensajes).
 */
// Todos cumplen AA (≥ 4.5:1) con texto blanco.
export const PERSON_COLORS = ['#2F6FDB', '#1A7F51', '#7C4DDB', '#0A7C87', '#B83280', '#4C51BF', '#52606D', '#C53030'] as const;

/** Contraste WCAG entre un color y el blanco. */
export function contrastWithWhite(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 1;
  const ch = [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
  return 1.05 / (lum + 0.05);
}
/** Naranja sobrio que sí cumple AA con texto blanco (#E8710A no alcanza en letra pequeña). */
export const BADGE_ORANGE = '#B45309';
/** Fondo del globo de no leídos: el color de la empresa solo si el texto blanco cumple AA; si no, el naranja sobrio. */
export const badgeColor = (org?: OrganizationDTO | null) => (org && contrastWithWhite(org.colorBg) >= 4.5 ? org.colorBg : BADGE_ORANGE);
function personIndex(id: string): number {
  let h = 0x811c9dc5;
  for (const ch of id.toLowerCase()) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h % PERSON_COLORS.length;
}
export function personColor(id: string | null | undefined): string {
  if (!id) return '#8a8177';
  return PERSON_COLORS[personIndex(id)]!;
}
/** El color de la persona como texto (nombre en el chat, menciones): igual en claro; más claro en oscuro para AA (--pc-N). */
export function personInk(id: string | null | undefined): string {
  return id ? `var(--pc-${personIndex(id)})` : 'var(--muted)';
}

/** gg, el asistente: participante bot con id fijo (docs/GG-CHAT.md). */
export const GG_ID = '0a9a9a9a-0000-4000-8000-000000000066';
/** En un directo, la otra persona; en «Tú» (directo contigo mismo), tú. */
export const directOtherId = (d: BootstrapDTO, c: ConversationDTO) => c.memberIds.find((m) => m !== d.me.id) ?? d.me.id;
export const isSelfChat = (d: BootstrapDTO, c: ConversationDTO) => c.kind === 'direct' && c.memberIds.every((m) => m === d.me.id);
export const isGgChat = (c: ConversationDTO) => c.kind === 'direct' && c.memberIds.includes(GG_ID);

export function Avatar({ person, org, size = 34 }: { person?: PersonDTO | null; org?: OrganizationDTO | null; size?: number }) {
  if (person?.id === GG_ID) return <span className="avatar gg-avatar" style={{ width: size, height: size }}><img src={asset('/gg-mark.svg')} alt="gg" draggable={false} /></span>;
  // Sin foto: iniciales sobre el color estable de la persona. Sin insignia de empresa: el nombre
  // de la empresa ya va escrito junto a la persona y la letra suelta («x») confundía.
  const bg = person?.kind === 'agent' ? 'var(--ink)' : person ? personColor(person.id) : 'var(--paper-3)';
  const fg = person?.kind === 'agent' ? 'var(--paper)' : person ? '#ffffff' : 'var(--ink-2)';
  return (
    <span className="avatar" style={{ width: size, height: size, background: bg, color: fg, fontSize: size * 0.36, borderRadius: person?.kind === 'agent' ? 10 : 99 }}>
      {person?.avatarUrl
        ? <img src={apiUrl(person.avatarUrl)} alt="" loading="lazy" draggable={false} style={{ width: '100%', height: '100%', borderRadius: 'inherit', objectFit: 'cover' }} />
        : person?.kind === 'agent' ? '◇' : initials(person?.name ?? '?')}
    </span>
  );
}

/** Foto de un grupo o chat; sin foto, el ícono de siempre (#, candado, ◆, 💬 lateral). */
export function ConvAvatar({ c, size = 22, fallback }: { c: ConversationDTO; size?: number; fallback?: ReactNode }) {
  if (c.avatarUrl) {
    return <img className="conv-avatar" src={apiUrl(c.avatarUrl)} alt="" width={size} height={size} loading="lazy" draggable={false}
      style={{ width: size, height: size, borderRadius: c.kind === 'multi' ? 99 : Math.round(size * 0.28), objectFit: 'cover', flex: 'none' }} />;
  }
  if (fallback) return <>{fallback}</>;
  if (c.deriveKind === 'side') return <SideIcon size={size} />;
  return <span className="hash">{c.parentId ? '⑂' : c.kind === 'internal' ? '◌' : c.level === 'directivo' ? '◆' : '#'}</span>;
}

/** Ícono de sidechat: globo de diálogo en el verde azulado de sidechats (tokens --side-ink / --side-bg, igual en iOS y Android). */
export function SideIcon({ size = 22 }: { size?: number }) {
  const g = Math.round(size * 0.6);
  return (
    <span className="side-ico" aria-hidden style={{ width: size, height: size, borderRadius: Math.round(size * 0.28) }}>
      <svg width={g} height={g} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4 19.5l1.4-4.4A7.5 7.5 0 1 1 20 11.5z" />
      </svg>
    </span>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="row"><h3 className="grow">{title}</h3><button className="icon-btn" onClick={onClose} aria-label={t('common.close')}>×</button></div>
        {children}
      </div>
    </div>
  );
}

// ---------- Selectores sobre el snapshot ----------
export const orgById = (d: BootstrapDTO, id: string | null | undefined) => d.organizations.find((o) => o.id === id) ?? null;
export const personById = (d: BootstrapDTO, id: string | null | undefined) => d.people.find((p) => p.id === id) ?? null;

export function conversationTitle(d: BootstrapDTO, c: ConversationDTO) {
  if (c.kind === 'direct') {
    if (isSelfChat(d, c)) return t('self.title');
    const other = c.memberIds.find((m) => m !== d.me.id);
    return personById(d, other)?.name ?? t('chat.aDirect');
  }
  if (c.kind === 'multi' && !c.name) {
    const names = c.memberIds.filter((m) => m !== d.me.id).map((m) => personById(d, m)?.name.split(' ')[0]).filter(Boolean) as string[];
    return names.length > 3 ? `${names.slice(0, 3).join(', ')} ${t('chat.andMore', { n: names.length - 3 })}` : names.join(', ') || t('chat.groupChat');
  }
  // Nombres que crea el sistema por defecto se muestran en el idioma de quien lee.
  if (c.kind === 'internal' && c.name === 'Equipo interno') return t('conv.defaultInternal');
  // Sidechats creados con el nombre anterior («Consulta · …»).
  if (c.deriveKind === 'side' && c.name?.startsWith('Consulta · ')) return t('side.defaultName', { excerpt: c.name.slice('Consulta · '.length) });
  return c.name ?? t('chat.aConversation');
}

export function conversationSubtitle(d: BootstrapDTO, c: ConversationDTO) {
  if (c.kind === 'direct') {
    const other = personById(d, directOtherId(d, c));
    return other ? [other.title, orgById(d, other.orgId)?.name ?? (other.guest ? t('common.guest') : null)].filter(Boolean).join(' · ') : '';
  }
  if (c.kind === 'multi') {
    const orgs = [...new Set(c.memberIds.map((m) => orgById(d, personById(d, m)?.orgId)?.name).filter(Boolean))];
    return [c.deriveKind === 'side' ? `💬 ${t('side.kind')}` : t('chat.groupChat'), orgs.slice(0, 3).join(', ')].filter(Boolean).join(' · ');
  }
  // Grupos: la empresa primero (bajo el nombre, en gris), luego el espacio si no es el mismo nombre.
  const ws = d.workspaces.find((w) => w.id === c.workspaceId);
  const company = companyLine(d, c, conversationTitle(d, c));
  const fold = (x: string) => x.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
  const co = fold(companyOf(d, c) ?? '');
  // El espacio solo si aporta: no el de la casa de la empresa ni uno cuyo nombre ya trae la empresa.
  const wsName = ws && !ws.isOrgHome && !(co && fold(ws.name).includes(co)) ? ws.name : null;
  return [company, wsName, c.kind === 'internal' ? t('kind.internalShort') : c.level === 'directivo' ? t('kind.directivo') : null].filter(Boolean).join(' · ');
}

/** Empresa "contraparte" de un espacio desde mi punto de vista (para agrupar la barra lateral). */
export function counterpartOrg(d: BootstrapDTO, workspaceId: string) {
  const ws = d.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return null;
  const mine = new Set(d.organizations.filter((o) => o.myRole).map((o) => o.id));
  const other = ws.organizationIds.find((id) => !mine.has(id));
  return orgById(d, other ?? ws.owningOrgId);
}

export function timeLabel(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
}

export function dayLabel(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return t('day.today');
  if (d.toDateString() === y.toDateString()) return t('day.yesterday');
  return d.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' });
}

/** Vista previa de la barra lateral: los mensajes de sistema se traducen. */
export const previewText = (body: string | null) => (body === '①' ? t('once.message') : body ? systemText(body) : null);

/** Vista previa de una conversación: prefiere el último mensaje de una persona (con sus adjuntos) sobre los avisos de sistema. */
export function conversationPreview(d: BootstrapDTO, c: ConversationDTO): string | null {
  const h = c.lastHumanPreview;
  if (h) {
    const who = h.authorId === d.me.id ? t('common.youShort') : c.kind !== 'direct' ? personById(d, h.authorId)?.name.split(' ')[0] : null;
    // Una sola vista: «① Foto», «① Mensaje» o «① Nota de voz», nunca el contenido.
    const text = h.viewOnce ? (h.attachments?.voices ? t('once.voice') : h.attachments?.images ? t('once.photo') : t('once.message'))
      : [h.attachments ? attachmentSummaryText(h.attachments) : '', h.body.replace(/\s+/g, ' ').trim()].filter(Boolean).join(' · ');
    if (text) return who ? `${who}: ${text}` : text;
  }
  return previewText(c.lastMessagePreview);
}
