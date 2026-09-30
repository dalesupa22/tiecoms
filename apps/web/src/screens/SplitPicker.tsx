/**
 * ⊞ «Abrir otro chat al lado» (encabezado del chat): elegir una conversación para verla en paralelo (split.ts).
 * Es la forma visible de lo mismo que arrastrar un chat de la lista.
 */
import { useState } from 'react';
import { useClient } from '../app-client.ts';
import { t } from '../i18n.ts';
import { MAX_PANES, currentPanes, openBeside } from '../split.ts';
import { Avatar, ConvAvatar, Modal, conversationTitle, directOtherId, personById } from '../ui.tsx';
import { activityOf } from './Shell.tsx';

export function SplitPicker({ activeId, onClose }: { activeId: string; onClose: () => void }) {
  const d = useClient((s) => s.data);
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
  const full = currentPanes().length >= MAX_PANES;
  return (
    <Modal title={t('split.pickTitle')} onClose={onClose}>
      <p className="small muted" style={{ marginTop: 0 }}>{full ? t('split.pickFull') : t('split.pickHelp')}</p>
      <input className="input" autoFocus placeholder={t('split.pickSearch')} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="call-pick">
        {list.map(({ c, name }) => {
          const other = c.kind === 'direct' ? personById(d, directOtherId(d, c)) : null;
          return (
            <button key={c.id} className="call-pick-row" onClick={() => { onClose(); openBeside(c.id, activeId); }}>
              {other ? <Avatar person={other} size={30} /> : <ConvAvatar c={c} size={30} fallback={<span className="call-pick-hash">#</span>} />}
              <span className="grow ellipsis">{name}</span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
