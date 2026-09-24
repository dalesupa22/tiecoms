import { useEffect, type ReactNode } from 'react';
import type { BootstrapDTO, ConversationDTO, OrganizationDTO, PersonDTO } from '@tiecoms/contracts';
import { locale, systemText, t } from './i18n.ts';

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1]![0] : '')).toUpperCase();
}

export function OrgMark({ org, size = 26 }: { org?: OrganizationDTO | null; size?: number }) {
  if (!org) return <span className="mark" style={{ width: size, height: size, background: '#fff', color: '#5c554c', fontSize: size * 0.42, border: '1px solid #ddd6ca' }}>◦</span>;
  return <span className="mark" title={org.name} style={{ width: size, height: size, background: org.colorBg, color: org.colorFg, fontSize: size * 0.4 }}>{org.mark}</span>;
}

export function Avatar({ person, org, size = 34 }: { person?: PersonDTO | null; org?: OrganizationDTO | null; size?: number }) {
  const bg = person?.kind === 'agent' ? '#1b1917' : org?.colorBg ?? '#e0dace';
  const fg = person?.kind === 'agent' ? '#f4f1ea' : org?.colorFg ?? '#5c554c';
  return (
    <span className="avatar" style={{ width: size, height: size, background: bg, color: fg, fontSize: size * 0.36, borderRadius: person?.kind === 'agent' ? 10 : 99 }}>
      {person?.kind === 'agent' ? '◇' : initials(person?.name ?? '?')}
      {org && size >= 30 && <span className="badge" style={{ background: org.colorBg, color: org.colorFg }}>{org.mark}</span>}
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
    const other = c.memberIds.find((m) => m !== d.me.id);
    return personById(d, other)?.name ?? t('chat.aDirect');
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
