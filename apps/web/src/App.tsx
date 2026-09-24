import { useEffect } from 'react';
import { useClient } from './app-client.ts';
import { useLang } from './i18n.ts';
import { asset, navigate, parse, usePath } from './router.ts';
import { AuthScreen } from './screens/Auth.tsx';
import { ConversationScreen } from './screens/Conversation.tsx';
import { InviteScreen } from './screens/Invite.tsx';
import { InboxScreen, PeopleScreen, SettingsScreen, SpacesScreen, TodayScreen, WorkspaceScreen } from './screens/Pages.tsx';
import { Shell } from './screens/Shell.tsx';

function nextParam() {
  const n = new URLSearchParams(location.search).get('next');
  return n && n.startsWith('/') && !n.startsWith('//') ? n : undefined;
}

export function App() {
  const path = usePath();
  const status = useClient((s) => s.status);
  // Cambiar de idioma vuelve a pintar toda la app (key={lang}).
  const lang = useLang();
  const route = parse(path);

  useEffect(() => {
    if (status === 'anonymous' && !['login', 'signup', 'invite'].includes(route.name)) navigate(`/login${path !== '/' ? `?next=${encodeURIComponent(path)}` : ''}`, true);
    if (status === 'ready' && (route.name === 'login' || route.name === 'signup')) navigate(nextParam() ?? '/', true);
  }, [status, route.name, path]);

  if (status === 'loading') return <div className="auth"><img src={asset("/tiecoms-mark.svg")} alt="TieComs" width={160} height={35} style={{ opacity: 0.6 }} /></div>;
  if (route.name === 'invite') return <InviteScreen key={lang} token={route.token} />;
  if (status === 'anonymous') return <AuthScreen key={lang} mode={route.name === 'signup' ? 'signup' : 'login'} after={nextParam()} />;
  if (route.name === 'login' || route.name === 'signup') return null;

  return (
    <Shell key={lang} route={route}>
      {route.name === 'today' && <TodayScreen />}
      {route.name === 'inbox' && <InboxScreen />}
      {route.name === 'spaces' && <SpacesScreen />}
      {route.name === 'people' && <PeopleScreen />}
      {route.name === 'settings' && <SettingsScreen />}
      {route.name === 'workspace' && <WorkspaceScreen key={route.id} id={route.id} />}
      {route.name === 'conversation' && <ConversationScreen key={route.id} id={route.id} />}
    </Shell>
  );
}
