/**
 * Lo que no es un chat de chaggu dentro de un panel (docs/PANELES.md): las vistas completas (Tareas, Agenda,
 * Correo, WhatsApp, Hoy, Archivos) y los elementos sueltos (un chat de WhatsApp, un correo, una tarea). Cada uno
 * reutiliza su pantalla de siempre en modo compacto, con un encabezado de una línea igual al de los chats.
 */
import type { ReactNode } from 'react';
import type { BootstrapDTO, MailListItemDTO, MailProvider, WaChatDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { t } from '../i18n.ts';
import { keyParts, paneKind, type ViewName } from '../panes-core.ts';
import { closePane, paneMetaNow, usePaneMeta } from '../split.ts';
import { Avatar, ConvAvatar, conversationTitle, directOtherId, personById } from '../ui.tsx';
import { NavIcon } from './Rail.tsx';
import { InboxMailReader, MailReader, ProviderIcon, WaIcon } from './Mail.tsx';
import { WaChatPane, WhatsAppScreen } from './WhatsApp.tsx';
import { IssueDrawer, IssuesScreen } from './Issues.tsx';
import { AgendaScreen } from './Calendar.tsx';
import { MailScreen } from './Mail.tsx';
import { TodayScreen } from './Pages.tsx';
import { FilesScreen } from './Files.tsx';
import { PaneControls, PaneNum, headDrag, type PaneProps } from './PaneBits.tsx';

const VIEW_LABEL: Record<ViewName, string> = { issues: 'nav.issues', agenda: 'nav.agenda', mail: 'nav.mail', whatsapp: 'nav.whatsapp', today: 'nav.today', files: 'nav.files' };
const VIEW_ICON: Record<ViewName, string> = { issues: 'tasks', agenda: 'agenda', mail: 'mail', whatsapp: 'whatsapp', today: 'today', files: 'files' };
export const viewLabel = (v: ViewName) => t(VIEW_LABEL[v] as never);

/** Nombre de un panel sin hooks (avisos «se reemplazó…», «Panel cerrado…»). */
export function describePane(key: string): string {
  const s = client.getState();
  const d = s.data;
  const [a] = keyParts(key);
  switch (paneKind(key)) {
    case 'conv': { const c = d?.conversations.find((x) => x.id === key); return c && d ? conversationTitle(d, c) : t('split.aChat'); }
    case 'view': return viewLabel(key.slice(2) as ViewName);
    case 'mail': return s.mails[a!]?.subject || paneMetaNow(key)?.title || t('nav.mail');
    case 'task': return s.issues[a!]?.title || paneMetaNow(key)?.title || t('nav.issues');
    default: return paneMetaNow(key)?.title ?? key;
  }
}

export interface PaneInfo { title: string; sub?: string; icon: ReactNode; unread: number; kindLabel: string }
/** Título, ícono y no leídos de un panel (para su encabezado, la barra de paneles y «Recientes»). */
export function usePaneInfo(key: string): PaneInfo {
  const kind = paneKind(key);
  const [a, b] = keyParts(key);
  const d = useClient((s) => s.data);
  const mail = useClient((s) => (kind === 'mail' ? s.mails[a!] : undefined));
  const issue = useClient((s) => (kind === 'task' ? s.issues[a!] : undefined));
  const meta = usePaneMeta(key);
  return paneInfoOf(key, d, { mail, issue, meta, a, b });
}
function paneInfoOf(key: string, d: BootstrapDTO | null, x: { mail?: ReturnType<typeof client.getState>['mails'][string]; issue?: ReturnType<typeof client.getState>['issues'][string]; meta?: { title: string; sub?: string; snap?: unknown }; a?: string; b?: string }): PaneInfo {
  switch (paneKind(key)) {
    case 'conv': {
      const c = d?.conversations.find((y) => y.id === key);
      if (!c || !d) return { title: t('split.aChat'), icon: '#', unread: 0, kindLabel: 'chaggu' };
      const other = c.kind === 'direct' ? personById(d, directOtherId(d, c)) : null;
      return { title: conversationTitle(d, c), icon: other ? <Avatar person={other} size={20} /> : <ConvAvatar c={c} size={20} fallback={<span className="pane-hash">#</span>} />, unread: c.unread, kindLabel: 'chaggu' };
    }
    case 'view': { const v = key.slice(2) as ViewName; return { title: viewLabel(v), icon: v === 'files' ? <span className="pane-glyph">▣</span> : <NavIcon name={VIEW_ICON[v]} size={18} />, unread: 0, kindLabel: t('split.view') }; }
    case 'wa': { const snap = x.meta?.snap as WaChatDTO | undefined; return { title: x.meta?.title ?? snap?.name ?? 'WhatsApp', sub: snap?.accountLabel ?? x.meta?.sub, icon: <WaIcon size={18} />, unread: snap?.unread ?? 0, kindLabel: 'WhatsApp' }; }
    case 'mail': {
      const m = x.mail;
      const isWa = m?.provider === 'whatsapp';
      return { title: (isWa ? m?.wa?.chatName : m?.subject) || x.meta?.title || t('mail.noSubject'), sub: m ? (m.direction === 'out' ? m.to[0]?.name || m.to[0]?.email : m.from?.name || m.from?.email) ?? undefined : undefined,
        icon: isWa ? <WaIcon size={18} /> : m ? <ProviderIcon provider={m.provider as MailProvider} size={18} /> : <NavIcon name="mail" size={18} />, unread: 0, kindLabel: t('nav.mail') };
    }
    case 'inbox': return { title: x.meta?.title ?? t('mail.noSubject'), sub: x.meta?.sub, icon: <ProviderIcon provider={x.a as MailProvider} size={18} />, unread: 0, kindLabel: t('nav.mail') };
    case 'task': return { title: x.issue?.title ?? x.meta?.title ?? t('nav.issues'), icon: <span className="pane-glyph">◆</span>, unread: 0, kindLabel: t('split.task') };
  }
}

/** Encabezado de una línea para lo que no es un chat (el chat tiene el suyo en Conversation.tsx). */
export function PaneHead({ k, pane }: { k: string; pane: PaneProps }) {
  const info = usePaneInfo(k);
  return (
    <header className="pane-head" {...headDrag(pane)}>
      <PaneNum pane={pane} />
      <span className="pane-ico">{info.icon}</span>
      <span className="pane-title grow"><b className="ellipsis">{info.title}</b>{info.sub && info.sub !== info.title && <span className="pane-sub ellipsis">{info.sub}</span>}</span>
      {info.unread > 0 && <span className="pill pane-unread" title={t('split.unread', { n: info.unread })}>{info.unread}</span>}
      <PaneControls pane={pane} />
    </header>
  );
}

function ViewBody({ v }: { v: ViewName }) {
  switch (v) {
    case 'issues': return <IssuesScreen />;
    case 'agenda': return <AgendaScreen />;
    case 'mail': return <MailScreen />;
    case 'whatsapp': return <WhatsAppScreen />;
    case 'today': return <TodayScreen />;
    case 'files': return <FilesScreen />;
  }
}

/** El contenido del panel según su clase. */
export function PaneBody({ k, active }: { k: string; active: boolean }) {
  const [a, b] = keyParts(k);
  const snap = usePaneMeta(k)?.snap;
  switch (paneKind(k)) {
    case 'view': return <div className="pane-view"><ViewBody v={k.slice(2) as ViewName} /></div>;
    case 'wa': return <WaChatPane accountId={a!} jid={b!} snap={snap as WaChatDTO | undefined} active={active} />;
    case 'mail': return <MailReader id={a!} onClose={() => closePane(k)} />;
    case 'inbox': return <div className="pane-scroll"><InboxMailReader provider={a as MailProvider} id={b!} item={snap as MailListItemDTO | undefined} /></div>;
    case 'task': return <div className="pane-scroll"><IssueDrawer id={a!} inline onClose={() => closePane(k)} /></div>;
    default: return null;
  }
}
