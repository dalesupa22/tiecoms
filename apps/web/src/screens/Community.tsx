import { useEffect, useState } from 'react';
import { client, useClient } from '../app-client.ts';
import { communityGroups, communityPosts, suggestedCommunity } from '../community.ts';
import { errorText, getLang, locale, t } from '../i18n.ts';
import { navigate } from '../router.ts';
import { Avatar, conversationTitle, orgById, personById } from '../ui.tsx';
import { AttachmentsView } from './Attachments.tsx';
import { Linkify } from './Chats.tsx';
import { openCreateGroup } from './Groups.tsx';

export function CommunityScreen() {
  const d = useClient((s) => s.data)!;
  const en = getLang() === 'en';
  const groups = communityGroups(d.conversations);
  const key = `chaggu:community:${d.me.id}`;
  const [id, setId] = useState(() => { try { return localStorage.getItem(key) ?? suggestedCommunity(d.conversations); } catch { return suggestedCommunity(d.conversations); } });
  const local = useClient((s) => s.conversations[id]);
  const [error, setError] = useState<string | null>(null);
  const c = groups.find((g) => g.id === id);
  useEffect(() => {
    if (!c) return;
    setError(null); try { localStorage.setItem(key, c.id); } catch {}
    void client.openConversation(c.id).catch((e) => setError(errorText(e)));
  }, [c?.id, key]);
  const posts = communityPosts(local?.messages ?? []);
  return <div className="page"><div className="page-narrow" style={{ maxWidth: 850 }}>
    <div className="row"><h1 className="grow">{t('nav.community')}</h1><button className="btn small" onClick={() => openCreateGroup()}>{en ? 'Create group' : 'Crear grupo'}</button></div>
    <p className="muted">{en ? 'News, updates, photos and short videos from your groups. Choose the group whose updates you want to see.' : 'Noticias, novedades, fotos y videos cortos de tus grupos. Elige el grupo cuyas novedades quieres ver.'}</p>
    <label className="field">{en ? 'Community group' : 'Grupo de comunidad'}<select className="input" value={c?.id ?? ''} onChange={(e) => setId(e.target.value)}><option value="">{en ? 'Choose a group' : 'Elige un grupo'}</option>{groups.map((g) => <option key={g.id} value={g.id}>{conversationTitle(d, g)}</option>)}</select></label>
    {c && <div className="row" style={{ margin: '16px 0' }}><span className="small muted grow">{en ? 'Visible to the members of' : 'Visible para los miembros de'} {conversationTitle(d, c)} · {c.memberIds.length}</span><button className="btn primary" onClick={() => navigate(`/c/${c.id}`)}>{en ? 'Publish an update' : 'Publicar novedad'}</button></div>}
    {error && <div className="error">{error}</div>}
    {local?.loading && <div className="hint">{t('common.loading')}</div>}
    <div className="list">{c && posts.map((m) => { const author = personById(d, m.authorId); return <article key={m.id} className="card" style={{ padding: 18 }}><div className="row"><Avatar person={author} org={orgById(d, author?.orgId)} size={32} /><b className="grow">{author?.name}</b><time className="small muted">{new Date(m.createdAt).toLocaleString(locale())}</time></div>{m.body && <div style={{ whiteSpace: 'pre-wrap', margin: '12px 0' }}><Linkify text={m.body} /></div>}<AttachmentsView list={m.attachments ?? []} /><button className="link-btn" onClick={() => navigate(`/c/${c.id}?m=${m.seq}`)}>{en ? 'Open conversation' : 'Abrir conversación'}</button></article>; })}</div>
    {c && !local?.loading && !posts.length && <div className="empty">{en ? 'No updates yet.' : 'Todavía no hay novedades.'}</div>}
    {c && local?.hasMore && <button className="btn" disabled={local.loading} style={{ marginTop: 14 }} onClick={() => void client.loadOlder(c.id).catch((e) => setError(errorText(e)))}>{en ? 'Older updates' : 'Novedades anteriores'}</button>}
  </div></div>;
}
