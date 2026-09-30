/**
 * ⊞ «Abrir en paralelo» (encabezado del chat y barra de paneles): una vista, algo reciente o un chat para verlo
 * al lado (split.ts). Es la forma visible de lo mismo que arrastrar una fila o un ícono del riel.
 */
import { useState } from 'react';
import { useClient } from '../app-client.ts';
import { t } from '../i18n.ts';
import { currentPanes, openBeside, paneLimit, useRecentPanes } from '../split.ts';
import { paneKind, viewKey, type ViewName } from '../panes-core.ts';
import { Avatar, ConvAvatar, Modal, conversationTitle, directOtherId, personById } from '../ui.tsx';
import { activityOf } from './Shell.tsx';
import { usePaneInfo, viewLabel } from './PaneItems.tsx';

function RecentChip({ k, onPick }: { k: string; onPick: () => void }) {
  const info = usePaneInfo(k);
  return <button className="chip pick-recent" onClick={onPick} title={`${info.kindLabel} · ${info.title}`}><span className="pane-tab-ico">{info.icon}</span><span className="ellipsis">{info.title}</span></button>;
}

export function SplitPicker({ activeId, onClose }: { activeId: string; onClose: () => void }) {
  const d = useClient((s) => s.data);
  const recent = useRecentPanes();
  const [q, setQ] = useState('');
  if (!d) return null;
  const open = new Set([activeId, ...currentPanes()]);
  const needle = q.trim().toLocaleLowerCase();
  const list = d.conversations
    .filter((c) => !open.has(c.id))
    .map((c) => ({ c, name: conversationTitle(d, c) }))
    .filter((x) => !needle || x.name.toLocaleLowerCase().includes(needle))
    .sort((a, b) => activityOf(b.c).localeCompare(activityOf(a.c)))
    .slice(0, 80);
  const full = Math.max(currentPanes().length, 1) >= paneLimit();
  const views: ViewName[] = ['issues', 'agenda', ...(d.features?.mail ? ['mail' as const] : []), 'whatsapp', 'today', 'files'];
  const recents = recent.filter((k) => !open.has(k) && paneKind(k) !== 'view').slice(0, 6);
  const pick = (k: string) => { onClose(); openBeside(k, activeId); };
  return (
    <Modal title={t('split.pickTitle')} onClose={onClose}>
      <p className="small muted" style={{ marginTop: 0 }}>{full ? t('split.pickFull', { n: paneLimit() }) : t('split.pickHelp')}</p>
      {!needle && <>
        <div className="eyebrow">{t('split.pickViews')}</div>
        <div className="chips pick-views">{views.map((v) => <button key={v} className="chip" disabled={open.has(viewKey(v))} onClick={() => pick(viewKey(v))}>{viewLabel(v)}</button>)}</div>
        {recents.length > 0 && <>
          <div className="eyebrow" style={{ marginTop: 10 }}>{t('split.recent')}</div>
          <div className="chips pick-views">{recents.map((k) => <RecentChip key={k} k={k} onPick={() => pick(k)} />)}</div>
        </>}
        <div className="eyebrow" style={{ marginTop: 10 }}>{t('split.pickChats')}</div>
      </>}
      <input className="input" autoFocus placeholder={t('split.pickSearch')} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="call-pick">
        {list.map(({ c, name }) => {
          const other = c.kind === 'direct' ? personById(d, directOtherId(d, c)) : null;
          return (
            <button key={c.id} className="call-pick-row" onClick={() => pick(c.id)}>
              {other ? <Avatar person={other} size={30} /> : <ConvAvatar c={c} size={30} fallback={<span className="call-pick-hash">#</span>} />}
              <span className="grow ellipsis">{name}</span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
