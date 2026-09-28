import { useClient } from '../app-client.ts';
import { dndText, setDnd, useExpiry } from '../actions.tsx';
import { t } from '../i18n.ts';
import { activeUntil } from '../silence.ts';
import { Avatar, orgById, personById } from '../ui.tsx';

/** Avatar con la lunita 🌙 mientras «No molestar» está activo. */
export function MeAvatar({ size }: { size: number }) {
  const d = useClient((s) => s.data)!;
  useExpiry(d.me.dndUntil);
  const on = activeUntil(d.me.dndUntil);
  return (
    <span className={`me-avatar ${on ? 'is-dnd' : ''}`}>
      <Avatar person={personById(d, d.me.id)} org={orgById(d, d.me.primaryOrgId)} size={size} />
      {on && <span className="dnd-moon" title={dndText(d.me.dndUntil) ?? ''} aria-label={t('dnd.title')}>🌙</span>}
    </span>
  );
}

/** Franja fina arriba de la lista: «No molestar hasta las 18:00 · Reactivar». */
export function DndStrip() {
  const until = useClient((s) => s.data?.me.dndUntil);
  useExpiry(until);
  const text = dndText(until);
  if (!text) return null;
  return (
    <div className="dnd-strip" role="status">
      <span aria-hidden>🌙</span><span className="grow">{text}</span>
      <button className="link-btn" onClick={() => void setDnd(null)}>{t('dnd.off')}</button>
    </div>
  );
}
