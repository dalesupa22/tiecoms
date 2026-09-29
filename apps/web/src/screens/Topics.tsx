import { useEffect, useRef, useState } from 'react';
import { TOPIC_COLORS, TOPIC_LIMIT, type ConversationDTO, type MessageDTO, type TopicColor, type TopicDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { openDialog } from '../actions.tsx';
import { errorText, t } from '../i18n.ts';
import { menuProps, openMenuAt, toast, type MenuItem } from '../menu.tsx';
import { Modal, personById } from '../ui.tsx';

/**
 * Temas del chat (docs/TEMAS.md): banderitas arriba del chat, con scroll horizontal.
 * Tocar una filtra el chat y lo que escribas sale con ese tema; «Todo» quita el filtro y muestra lo que no tiene tema
 * más lo no leído de los temas. El número de cada banderita es lo que tiene sin leer.
 * Mantener presionada (o clic derecho) abre renombrar, color, archivar y quitar. Sin límite práctico (TOPIC_LIMIT es un tope técnico).
 */
const ICONS = ['🌐', '🌱', '💰', '📣', '📈', '🤝', '🎯', '🧾', '⚙️', '📦', '🎓', '⚖️'];
const EMPTY: TopicDTO[] = [];

export function useTopics(conversationId: string) {
  const list = useClient((s) => s.topics[conversationId]) ?? EMPTY;
  useEffect(() => { client.loadTopics(conversationId).catch(() => {}); }, [conversationId]);
  return list;
}
export const activeTopics = (list: TopicDTO[]) => list.filter((x) => !x.archivedAt);

/** Temas de un chat que no está abierto (p. ej. tareas en /asuntos): se piden una vez por chat. */
const asked = new Set<string>();
export function useTopicsOf(conversationId: string | null) {
  const list = useClient((s) => (conversationId ? s.topics[conversationId] : undefined));
  useEffect(() => {
    if (!conversationId || list || asked.has(conversationId)) return;
    asked.add(conversationId);
    client.loadTopics(conversationId).catch(() => asked.delete(conversationId));
  }, [conversationId, list]);
  return list ?? EMPTY;
}

/** Etiqueta de tema de una tarea: la ✕ la deja sin tema (con Deshacer). */
export function IssueTopicTag({ issueId, conversationId, topicId, canEdit }: { issueId: string; conversationId: string | null; topicId?: string | null; canEdit: boolean }) {
  const list = useTopicsOf(topicId ? conversationId : null);
  const topic = topicId ? list.find((x) => x.id === topicId) : undefined;
  if (!topic) return null;
  return (
    <span className={`topic-tag c-${topic.archivedAt ? 'gray' : topic.color} issue-topic`}>
      {topic.archivedAt ? '🗄' : topic.icon} {topic.name}
      {canEdit && <button className="topic-x" aria-label={t('topic.none')} title={t('topic.none')} onClick={(e) => {
        e.stopPropagation();
        void client.updateIssue(issueId, { topicId: null })
          .then(() => toast(t('topic.untaggedTask'), { label: t('issue.undo'), run: () => void client.updateIssue(issueId, { topicId: topic.id }).catch((er) => toast(errorText(er))) }, 4500))
          .catch((er) => toast(errorText(er)));
      }}>×</button>}
    </span>
  );
}

/** Submenú «Tema» de una tarea. */
export function issueTopicMenu(issueId: string, current: string | null | undefined, list: TopicDTO[]): MenuItem | null {
  const act = activeTopics(list);
  if (!act.length) return null;
  const set = (topicId: string | null) => void client.updateIssue(issueId, { topicId }).catch((e) => toast(errorText(e)));
  return {
    label: t('topic.set'), icon: '🏷',
    items: [
      ...act.map((x) => ({ label: `${x.icon} ${x.name}${current === x.id ? '  ✓' : ''}`, onSelect: () => set(x.id) })),
      ...(current ? [{ divider: true }, { label: t('topic.none'), icon: '⌫', onSelect: () => set(null) }] : []),
    ],
  };
}

export function TopicTag({ topic, onClick, by }: { topic: TopicDTO | undefined; onClick?: () => void; by?: string | null }) {
  if (!topic) return null;
  const cls = `topic-tag c-${topic.archivedAt ? 'gray' : topic.color}`;
  const body = <>{topic.archivedAt ? '🗄' : topic.icon} {topic.name}</>;
  return (
    <>
      {onClick ? <button className={cls} onClick={onClick} title={t('topic.set')}>{body}</button> : <span className={cls}>{body}</span>}
      {by && <span className="topic-by">· {by}</span>}
    </>
  );
}

/** Submenú «Tema» de un mensaje: cualquiera del chat lo etiqueta con un tema activo o lo deja sin tema. */
export function topicMenu(m: MessageDTO, list: TopicDTO[]): MenuItem | null {
  const act = activeTopics(list);
  if (!act.length) return null;
  const set = (topicId: string | null) => {
    const prev = m.topicId ?? null;
    void client.setMessageTopic(m, topicId).then(() => {
      const name = list.find((x) => x.id === topicId)?.name;
      toast(name ? t('topic.tagged', { name }) : t('topic.untagged'), { label: t('issue.undo'), run: () => void client.setMessageTopic(m, prev).catch(() => {}) }, 4500);
    }).catch((e) => toast(errorText(e)));
  };
  return {
    label: t('topic.set'), icon: '🏷',
    items: [
      ...act.map((x) => ({ label: `${x.icon} ${x.name}${m.topicId === x.id ? '  ✓' : ''}`, onSelect: () => set(x.id) })),
      ...(m.topicId ? [{ divider: true }, { label: t('topic.none'), icon: '⌫', onSelect: () => set(null) }] : []),
    ],
  };
}
export function openTopicMenu(el: HTMLElement, m: MessageDTO, list: TopicDTO[]) {
  const item = topicMenu(m, list);
  if (!item?.items) { newTopicDialog(m.conversationId, list, (tp) => void client.setMessageTopic(m, tp.id).catch((e) => toast(errorText(e)))); return; }
  const r = el.getBoundingClientRect();
  openMenuAt(r.left, r.bottom + 4, [...item.items, { divider: true }, { label: t('topic.newTitle'), icon: '＋', onSelect: () => newTopicDialog(m.conversationId, list, (tp) => void client.setMessageTopic(m, tp.id).catch((e) => toast(errorText(e)))) }]);
}

export function newTopicDialog(conversationId: string, list: TopicDTO[], onCreated?: (tp: TopicDTO) => void) {
  openDialog((close) => <NewTopicDialog conversationId={conversationId} list={list} onClose={close} onCreated={onCreated} />);
}

function NewTopicDialog({ conversationId, list, onClose, onCreated, edit }: { conversationId: string; list: TopicDTO[]; onClose: () => void; onCreated?: (tp: TopicDTO) => void; edit?: TopicDTO }) {
  const act = activeTopics(list);
  const used = new Set(list.map((x) => x.icon));
  const [name, setName] = useState(edit?.name ?? '');
  const [icon, setIcon] = useState(edit?.icon ?? ICONS.find((i) => !used.has(i)) ?? ICONS[0]!);
  const [color, setColor] = useState<TopicColor>(edit?.color ?? TOPIC_COLORS.find((c) => !list.some((x) => x.color === c)) ?? 'blue');
  const [busy, setBusy] = useState(false);
  const full = !edit && act.length >= TOPIC_LIMIT;
  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      if (edit) await client.updateTopic(edit, { name: name.trim(), icon, color });
      else { const tp = await client.createTopic(conversationId, { name: name.trim(), icon, color }); onCreated?.(tp); }
      onClose();
    } catch (e) { toast(errorText(e)); setBusy(false); }
  };
  if (full) return (
    <Modal title={t('topic.full', { max: TOPIC_LIMIT })} onClose={onClose}>
      <div className="hint">{t('topic.fullHint')}</div>
      <div className="modal-actions"><button className="btn primary" onClick={onClose}>{t('common.done')}</button></div>
    </Modal>
  );
  return (
    <Modal title={edit ? t('topic.renameTitle') : t('topic.newTitle')} onClose={onClose}>
      <input className="input" autoFocus value={name} maxLength={40} placeholder={t('topic.namePh')} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} />
      <div className="topic-pick">{ICONS.map((i) => <button key={i} className={`topic-pick-icon ${i === icon ? 'is-on' : ''}`} onClick={() => setIcon(i)} aria-label={i}>{i}</button>)}</div>
      <div className="topic-pick">{TOPIC_COLORS.map((c) => <button key={c} className={`topic-swatch c-${c} ${c === color ? 'is-on' : ''}`} onClick={() => setColor(c)} aria-label={t(`topic.colors.${c}` as any)} title={t(`topic.colors.${c}` as any)} />)}</div>
      <div className="topic-preview"><span className={`topic-flag c-${color} is-on`}>{icon} {name.trim() || t('topic.namePh')}</span></div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={!name.trim() || busy} onClick={() => void save()}>{edit ? t('common.save') : t('topic.create')}</button>
      </div>
    </Modal>
  );
}

function ArchivedDialog({ list, onClose }: { list: TopicDTO[]; onClose: () => void }) {
  const live = useClient((s) => s.topics[list[0]?.conversationId ?? '']) ?? list;
  const archived = live.filter((x) => x.archivedAt);
  const full = activeTopics(live).length >= TOPIC_LIMIT;
  return (
    <Modal title={t('topic.archivedTitle')} onClose={onClose}>
      <div className="small muted">{t('topic.archiveHint')}</div>
      <div className="list" style={{ gap: 6 }}>
        {archived.map((x) => (
          <div key={x.id} className="card conv-card">
            <span aria-hidden>{x.icon}</span><b className="grow">{x.name}</b>
            <button className="btn small" disabled={full} title={full ? t('topic.fullHint') : undefined}
              onClick={() => void client.updateTopic(x, { archived: false }).then(() => toast(t('topic.restored', { name: x.name }))).catch((e) => toast(errorText(e)))}>{t('topic.restore')}</button>
          </div>
        ))}
      </div>
      {full && <div className="hint">{t('topic.fullHint')}</div>}
    </Modal>
  );
}

export function TopicDock({ conv, list, filter, onFilter, counts, unread = {} }: {
  conv: ConversationDTO; list: TopicDTO[]; filter: string | null; onFilter: (id: string | null) => void; counts: Record<string, number>;
  /** Sin leer por tema; '' = sin tema (va en «Todo»). */
  unread?: Record<string, number>;
}) {
  const d = useClient((s) => s.data)!;
  const act = activeTopics(list);
  const archived = list.filter((x) => x.archivedAt);
  const canEdit = conv.canPost;
  const flagMenu = (x: TopicDTO): MenuItem[] => [
    { label: t('topic.rename'), icon: '✎', onSelect: () => openDialog((close) => <NewTopicDialog conversationId={conv.id} list={list} edit={x} onClose={close} />) },
    { label: t('topic.color'), icon: '🎨', items: TOPIC_COLORS.map((c) => ({ label: `${c === x.color ? '● ' : ''}${t(`topic.colors.${c}` as any)}`, onSelect: () => void client.updateTopic(x, { color: c }).catch((e) => toast(errorText(e))) })) },
    { divider: true },
    { label: t('topic.archive'), icon: '🗄', onSelect: () => {
      if (filter === x.id) onFilter(null);
      void client.updateTopic(x, { archived: true })
        .then(() => toast(t('topic.archived', { name: x.name }), { label: t('issue.undo'), run: () => void client.updateTopic(x, { archived: false }).catch((e) => toast(errorText(e))) }, 5000))
        .catch((e) => toast(errorText(e)));
    } },
    { label: t('topic.remove'), icon: '⌫', danger: true, onSelect: () => {
      if (!confirm(t('topic.removeConfirm', { name: x.name, n: counts[x.id] ?? 0 }))) return;
      if (filter === x.id) onFilter(null);
      void client.deleteTopic(x).then(() => toast(t('topic.removed', { name: x.name }))).catch((e) => toast(errorText(e)));
    } },
  ];
  // La banderita elegida siempre queda a la vista (en el teléfono la fila es más ancha que la pantalla).
  const dock = useRef<HTMLDivElement>(null);
  useEffect(() => { dock.current?.querySelector('.topic-flag.is-on')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }); }, [filter, act.length]);
  if (!act.length && !archived.length && !canEdit) return null;
  return (
    <div ref={dock} className="topic-dock" role="tablist" aria-label={t('topic.bar')}>
      <button role="tab" aria-selected={!filter} className={`topic-flag c-plain ${!filter ? 'is-on' : ''}`} onClick={() => onFilter(null)}>💬 {t('topic.all')}{unread[''] && act.length > 0 ? <span className="topic-unread" aria-label={t('topic.unreadN', { n: unread['']! })}>{unread['']}</span> : null}</button>
      {act.map((x) => (
        <button key={x.id} role="tab" aria-selected={filter === x.id} className={`topic-flag c-${x.color} ${filter === x.id ? 'is-on' : ''}`}
          title={personById(d, x.createdBy)?.name}
          onClick={() => onFilter(filter === x.id ? null : x.id)} {...(canEdit ? menuProps(() => flagMenu(x)) : {})}>
          {x.icon} {x.name}{unread[x.id] ? <span className="topic-unread" aria-label={t('topic.unreadN', { n: unread[x.id]! })}>{unread[x.id]}</span> : null}
        </button>
      ))}
      {canEdit && (
        <button className="topic-flag c-plain is-new" onClick={() => newTopicDialog(conv.id, list, (tp) => onFilter(tp.id))}>
          ＋ {t('topic.new')}
        </button>
      )}
      {archived.length > 0 && <button className="topic-flag c-gray" onClick={() => openDialog((close) => <ArchivedDialog list={list} onClose={close} />)}>🗄 {t('topic.archivedN', { n: archived.length })}</button>}
    </div>
  );
}
