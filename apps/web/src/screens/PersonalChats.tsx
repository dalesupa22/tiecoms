import { useState } from 'react';
import type { ConversationDTO } from '@tiecoms/contracts';
import { useClient } from '../app-client.ts';
import { openDialog } from '../actions.tsx';
import { getLang } from '../i18n.ts';
import { navigate } from '../router.ts';
import { Modal, ConvAvatar, conversationTitle } from '../ui.tsx';
import { updatePersonalChat, updatePersonalPreferences, usePersonalPreferences } from '../personal-prefs.ts';
import { openPersonProfile } from './Profile.tsx';
import '../personal.css';

const tr = (es: string, en: string) => getLang() === 'en' ? en : es;

export function PersonalChatControls({ conv }: { conv: ConversationDTO }) {
  const preferences = usePersonalPreferences();
  const pref = preferences.conversations[conv.id] ?? {};
  return <button className="icon-btn" title={tr('Organizar y personalizar este chat', 'Organize and customize this chat')} aria-label={tr('Organizar y personalizar este chat', 'Organize and customize this chat')} onClick={() => openDialog((close) => <PersonalChatDialog conv={conv} onClose={close} />)}>{pref.favorite ? '★' : '🎨'}</button>;
}

export function PersonalChatDialog({ conv, onClose }: { conv: ConversationDTO; onClose: () => void }) {
  const d = useClient((state) => state.data)!;
  const preferences = usePersonalPreferences();
  const pref = preferences.conversations[conv.id] ?? {};
  const [busy, setBusy] = useState(false);
  const save = async (patch: Parameters<typeof updatePersonalChat>[1]) => {
    setBusy(true);
    try { await updatePersonalChat(conv.id, patch); } catch { /* preferences helper reports errors */ } finally { setBusy(false); }
  };
  return <Modal title={conversationTitle(d, conv)} onClose={onClose}>
    <p className="hint">{tr('Estas opciones se guardan para tu cuenta y solo cambian tu vista.', 'These options are saved for your account and only change your view.')}</p>
    <div className="row"><button className="btn" disabled={busy} aria-pressed={!!pref.favorite} onClick={() => void save({ favorite: !pref.favorite })}>★ {tr(pref.favorite ? 'Quitar de favoritos' : 'Añadir a favoritos', pref.favorite ? 'Remove favorite' : 'Add favorite')}</button>
      <button className="btn" disabled={busy} onClick={() => void save({ archived: !pref.archived })}>▤ {tr(pref.archived ? 'Desarchivar para mí' : 'Archivar para mí', pref.archived ? 'Unarchive for me' : 'Archive for me')}</button></div>
    <label className="field"><span>{tr('Sección personal', 'Personal section')}</span><select className="input" value={pref.sectionId ?? ''} disabled={busy} onChange={(event) => void save({ sectionId: event.target.value || null })}><option value="">{tr('Sin sección', 'No section')}</option>{preferences.sections.map((section) => <option key={section.id} value={section.id}>{section.name}</option>)}</select></label>
    <button className="link-btn" onClick={() => { onClose(); navigate('/organizar'); }}>{tr('Crear o gestionar secciones', 'Create or manage sections')}</button>
    <label className="field"><span>{tr('Fondo de mensajes', 'Message background')}</span><select className="input" value={pref.background ?? 'default'} disabled={busy} onChange={(event) => void save({ background: event.target.value as typeof pref.background })}>{[['default', 'Predeterminado', 'Default'], ['sand', 'Arena', 'Sand'], ['mint', 'Menta', 'Mint'], ['sky', 'Cielo', 'Sky'], ['rose', 'Rosa', 'Rose'], ['dusk', 'Atardecer', 'Dusk']].map(([id, es, en]) => <option key={id} value={id}>{tr(es!, en!)}</option>)}</select></label>
    <label className="field"><span>{tr('Fuente de mensajes', 'Message font')}</span><select className="input" value={pref.font ?? 'system'} disabled={busy} onChange={(event) => void save({ font: event.target.value as typeof pref.font })}>{[['system', 'Predeterminada', 'Default'], ['serif', 'Clásica', 'Classic'], ['mono', 'Monoespaciada', 'Monospaced'], ['rounded', 'Redondeada', 'Rounded']].map(([id, es, en]) => <option key={id} value={id}>{tr(es!, en!)}</option>)}</select></label>
    <label className="row"><input type="checkbox" checked={!!pref.hideBar} disabled={busy} onChange={(event) => void save({ hideBar: event.target.checked })} />{tr('Ocultar barra de mensajes', 'Hide message toolbar')}</label>
    <div className="field"><span>{tr('Personas del chat', 'Chat participants')}</span>{conv.memberIds.map((id) => {
      const person = d.people.find((p) => p.id === id);
      return person ? <button key={id} className="btn ghost small" onClick={() => openPersonProfile(person)}>{person.name} · {tr('Ver perfil', 'View profile')}</button> : null;
    })}</div>
    <div className="modal-actions"><button className="btn" onClick={onClose}>{tr('Cerrar', 'Close')}</button></div>
  </Modal>;
}

export function PersonalChatsScreen() {
  const d = useClient((state) => state.data)!;
  const preferences = usePersonalPreferences();
  const [view, setView] = useState('all');
  const [q, setQ] = useState('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  async function addSection() {
    if (!newName.trim()) return;
    setBusy(true);
    try { const id = crypto.randomUUID(); await updatePersonalPreferences((current) => ({ ...current, sections: [...current.sections, { id, name: newName.trim() }] })); setNewName(''); setView(id); } catch { /* reported by helper */ } finally { setBusy(false); }
  }
  async function removeSection(id: string) {
    if (!confirm(tr('Eliminar esta sección personal? Los chats se conservan.', 'Delete this personal section? Chats will be kept.'))) return;
    try { await updatePersonalPreferences((current) => ({ ...current, sections: current.sections.filter((section) => section.id !== id), conversations: Object.fromEntries(Object.entries(current.conversations).map(([chatId, pref]) => [chatId, pref.sectionId === id ? { ...pref, sectionId: null } : pref])) })); setView('all'); } catch { /* reported by helper */ }
  }
  async function renameSection(id: string, currentName: string) {
    const name = prompt(tr('Nombre de la sección', 'Section name'), currentName)?.trim();
    if (!name) return;
    try { await updatePersonalPreferences((current) => ({ ...current, sections: current.sections.map((section) => section.id === id ? { ...section, name } : section) })); } catch { /* reported by helper */ }
  }
  const chats = d.conversations.filter((conv) => {
    const pref = preferences.conversations[conv.id] ?? {};
    if (view === 'archive' ? !pref.archived : pref.archived) return false;
    if (view === 'favorites' && !pref.favorite) return false;
    if (!['all', 'archive', 'favorites'].includes(view) && pref.sectionId !== view) return false;
    return conversationTitle(d, conv).toLocaleLowerCase().includes(q.toLocaleLowerCase());
  }).sort((a, b) => Number(!!b.pinnedAt) - Number(!!a.pinnedAt) || Number(b.unread > 0) - Number(a.unread > 0) || (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
  const currentSection = preferences.sections.find((section) => section.id === view);
  return <div className="page"><div className="page-head"><h1>{tr('Mis mensajes', 'My messages')}</h1><p className="muted">{tr('Favoritos, archivo y secciones personales en todos tus dispositivos.', 'Favorites, archive and personal sections across your devices.')}</p></div>
    <div className="row" style={{ flexWrap: 'wrap' }}>{[['all', 'Todos', 'All'], ['favorites', '★ Favoritos', '★ Favorites'], ['archive', '▤ Archivados', '▤ Archived'], ...preferences.sections.map((s) => [s.id, s.name, s.name])].map(([id, es, en]) => <button key={id} className={`btn small ${view === id ? 'primary' : 'ghost'}`} onClick={() => setView(id!)}>{tr(es!, en!)}</button>)}</div>
    <div className="row" style={{ marginBlock: 16 }}><input className="input grow" maxLength={80} placeholder={tr('Nueva sección, por ejemplo Xertiflow', 'New section, for example Xertiflow')} value={newName} onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void addSection(); }} /><button className="btn" disabled={busy || !newName.trim()} onClick={() => void addSection()}>＋ {tr('Sección', 'Section')}</button></div>
    {currentSection && <div className="row"><button className="link-btn" onClick={() => void renameSection(currentSection.id, currentSection.name)}>{tr('Renombrar sección', 'Rename section')}</button><button className="link-btn" onClick={() => void removeSection(currentSection.id)}>{tr('Eliminar sección', 'Delete section')}</button></div>}
    <input className="input" type="search" placeholder={tr('Buscar chat o grupo', 'Search chats or groups')} value={q} onChange={(event) => setQ(event.target.value)} />
    <div className="list" style={{ marginTop: 16 }}>{chats.map((conv) => <div key={conv.id} className="card row personal-chat-row"><button className="btn ghost grow" style={{ justifyContent: 'flex-start' }} onClick={() => navigate(`/c/${conv.id}`)}><ConvAvatar c={conv} /><span className="ellipsis">{conversationTitle(d, conv)}</span>{preferences.conversations[conv.id]?.favorite && <span>★</span>}{conv.unread > 0 && <span className="pill">{conv.unread}</span>}</button><PersonalChatControls conv={conv} /></div>)}</div>
    {!chats.length && <div className="empty">{tr('No hay chats en esta sección.', 'There are no chats in this section.')}</div>}
  </div>;
}
