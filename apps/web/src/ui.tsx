import { useEffect, type ReactNode } from 'react';
import type { BootstrapDTO, ConversationDTO, OrganizationDTO, PersonDTO } from '@tiecoms/contracts';
import { locale, systemText, t } from './i18n.ts';
import { apiUrl } from './app-client.ts';

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1]![0] : '')).toUpperCase();
}

export function OrgMark({ org, size = 26 }: { org?: OrganizationDTO | null; size?: number }) {
  if (!org) return <span className="mark" style={{ width: size, height: size, background: '#fff', color: '#5c554c', fontSize: size * 0.42, border: '1px solid #ddd6ca' }}>◦</span>;
  return <span className="mark" title={org.name} style={{ width: size, height: size, background: org.colorBg, color: org.colorFg, fontSize: size * 0.4 }}>{org.mark}</span>;
}

/**
 * Color estable por persona (el mismo en web, iOS y Android): FNV-1a de 32 bits sobre
 * el id en minúsculas (caracteres ASCII), módulo 8. Paleta accesible con texto blanco, sin naranja
 * (el naranja es de la marca y de mis mensajes).
 */
export const PERSON_COLORS = ['#2F6FDB', '#1E8E5A', '#7C4DDB', '#0B8793', '#B83280', '#4C51BF', '#52606D', '#C53030'] as const;
export function personColor(id: string | null | undefined): string {
  if (!id) return '#8a8177';
  let h = 0x811c9dc5;
  for (const ch of id.toLowerCase()) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return PERSON_COLORS[h % PERSON_COLORS.length]!;
}

export function Avatar({ person, org, size = 34 }: { person?: PersonDTO | null; org?: OrganizationDTO | null; size?: number }) {
  // Sin foto: iniciales sobre el color estable de la persona; la empresa va en la insignia.
  const bg = person?.kind === 'agent' ? '#1b1917' : person ? personColor(person.id) : '#e0dace';
  const fg = person?.kind === 'agent' ? '#f4f1ea' : person ? '#ffffff' : '#5c554c';
  return (
    <span className="avatar" style={{ width: size, height: size, background: bg, color: fg, fontSize: size * 0.36, borderRadius: person?.kind === 'agent' ? 10 : 99 }}>
      {person?.avatarUrl
        ? <img src={apiUrl(person.avatarUrl)} alt="" loading="lazy" draggable={false} style={{ width: '100%', height: '100%', borderRadius: 'inherit', objectFit: 'cover' }} />
        : person?.kind === 'agent' ? '◇' : initials(person?.name ?? '?')}
      {org && size >= 30 && <span className="badge" style={{ background: org.colorBg, color: org.colorFg }}>{org.mark}</span>}
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
  return <span className="hash">{c.deriveKind === 'side' ? '💬' : c.parentId ? '⑂' : c.kind === 'internal' ? '◌' : c.level === 'directivo' ? '◆' : '#'}</span>;
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
    const other = c.memberIds.find((m) => m !== d.me.id);
    return personById(d, other)?.name ?? t('chat.aDirect');
  }
  if (c.kind === 'multi' && !c.name) {
    const names = c.memberIds.filter((m) => m !== d.me.id).map((m) => personById(d, m)?.name.split(' ')[0]).filter(Boolean) as string[];
    return names.length > 3 ? `${names.slice(0, 3).join(', ')} ${t('chat.andMore', { n: names.length - 3 })}` : names.join(', ') || t('chat.groupChat');
  }
  // Nombres que crea el sistema por defecto se muestran en el idioma de quien lee.
  if (c.kind === 'internal' && c.name === 'Equipo interno') return t('conv.defaultInternal');
  return c.name ?? t('chat.aConversation');
}

export function conversationSubtitle(d: BootstrapDTO, c: ConversationDTO) {
  if (c.kind === 'direct') {
    const other = personById(d, c.memberIds.find((m) => m !== d.me.id));
    return other ? [other.title, orgById(d, other.orgId)?.name ?? (other.guest ? t('common.guest') : null)].filter(Boolean).join(' · ') : '';
  }
  if (c.kind === 'multi') {
    const orgs = [...new Set(c.memberIds.map((m) => orgById(d, personById(d, m)?.orgId)?.name).filter(Boolean))];
    return [c.deriveKind === 'side' ? `💬 ${t('side.kind')}` : t('chat.groupChat'), orgs.slice(0, 3).join(', ')].filter(Boolean).join(' · ');
  }
  const ws = d.workspaces.find((w) => w.id === c.workspaceId);
  return [ws?.name, c.kind === 'internal' ? t('kind.internalShort') : c.level === 'directivo' ? t('kind.directivo') : null].filter(Boolean).join(' · ');
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
export const previewText = (body: string | null) => (body ? systemText(body) : null);
