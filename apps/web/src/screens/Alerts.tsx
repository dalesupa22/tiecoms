import { useEffect, useState } from 'react';
import { client, useClient } from '../app-client.ts';
import { errorText, getLang, t } from '../i18n.ts';
import { ReminderRow } from './Bring.tsx';

export function AlertsScreen() {
  const reminders = useClient((s) => s.reminders);
  const d = useClient((s) => s.data)!;
  const [filter, setFilter] = useState<'all' | 'due' | 'next'>('all');
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);
  useEffect(() => { void client.loadReminders().catch((e) => setError(errorText(e))); const id = setInterval(() => tick((n) => n + 1), 30000); return () => clearInterval(id); }, []);
  const en = getLang() === 'en';
  const visible = new Set(d.conversations.map((c) => c.id));
  const list = reminders.filter((r) => visible.has(r.conversationId) && !r.doneAt).filter((r) => filter === 'all' || (filter === 'due' ? Date.parse(r.remindAt) <= Date.now() : Date.parse(r.remindAt) > Date.now())).sort((a, b) => a.remindAt.localeCompare(b.remindAt));
  return <div className="page"><div className="page-narrow">
    <h1>{t('nav.alerts')}</h1>
    <p className="muted">{en ? 'Open, snooze or complete your reminders in one place.' : 'Abre, pospón o completa tus recordatorios en un solo lugar.'}</p>
    <div className="seg" style={{ marginBottom: 16 }}>{(['all', 'due', 'next'] as const).map((f) => <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{({ all: en ? 'All' : 'Todos', due: en ? 'Due' : 'Por atender', next: en ? 'Upcoming' : 'Próximos' })[f]}</button>)}</div>
    {error && <div className="error">{error}</div>}
    <div className="list">{list.map((r) => <ReminderRow key={r.id} r={r} />)}{!list.length && <div className="empty">{t('rem.empty')}</div>}</div>
  </div></div>;
}
