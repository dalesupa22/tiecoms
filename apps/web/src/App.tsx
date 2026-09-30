import { Suspense, lazy, useEffect, useRef } from 'react';
import { notices, useClient } from './app-client.ts';
import { handleNotice } from './notices.ts';
import { installSoundUnlock } from './sound.ts';
import { t, useLang } from './i18n.ts';
import { asset, navigate, parse, usePath } from './router.ts';
import { AuthScreen, ConfirmSignupScreen, SsoReturnScreen } from './screens/Auth.tsx';
import { ConversationArea, GridScreen } from './screens/Split.tsx';
import { DragTray } from './screens/Tray.tsx';
import { useGridSide } from './split.ts';
import { InviteScreen } from './screens/Invite.tsx';
import { InboxScreen, PeopleScreen, SettingsScreen, SpacesScreen, TodayScreen, WorkspaceScreen } from './screens/Pages.tsx';
import { Shell } from './screens/Shell.tsx';
import { IssuesScreen } from './screens/Issues.tsx';
import { TrazoScreen } from './screens/Lineage.tsx';
import { AgendaScreen } from './screens/Calendar.tsx';
import { ShareScreen } from './screens/Bring.tsx';
import { WhatsAppScreen } from './screens/WhatsApp.tsx';
import { MailScreen } from './screens/Mail.tsx';
import { FilesScreen } from './screens/Files.tsx';
import { DmsScreen, GroupsScreen, OversightScreen, ReadOnlyConversationScreen } from './screens/Groups.tsx';
import { DialogHost } from './actions.tsx';
import { MenuHost, ToastHost } from './menu.tsx';
import { BubbleHost, useTabBadge } from './bubbles.tsx';
import { UpdateBanner } from './update.tsx';
import { EmojiPickerHost } from './screens/Reactions.tsx';
import { SavedLinksScreen } from './screens/Links.tsx';
import { ScheduledScreen } from './screens/Scheduled.tsx';
import { CallDock, CallsScreen, IncomingCallHost, OtherDeviceCallBar } from './screens/Call.tsx';
/** «Documentos que firmé»: se carga aparte junto con el visor de PDF. */
const SignedScreen = lazy(() => import('./screens/Signed.tsx'));
/** /llamada/:token: invitados por enlace, sin cuenta. Se carga aparte. */
const GuestCallScreen = lazy(() => import('./screens/GuestCall.tsx'));
/** Citas por enlace (cita.chaggu.com): públicas, sin cuenta. Se cargan aparte. */
const BookingScreen = lazy(() => import('./screens/Booking.tsx'));

function nextParam() {
  const n = new URLSearchParams(location.search).get('next');
  return n && n.startsWith('/') && !n.startsWith('//') ? n : undefined;
}

notices.handler = handleNotice;
// El audio del sonido de mensajes se desbloquea con el primer clic o tecla (sound.ts).
installSoundUnlock();

import { markOnce } from './perf.ts';

export function App() {
  const path = usePath();
  const status = useClient((s) => s.status);
  // Cambiar de idioma vuelve a pintar toda la app (key={lang}).
  const lang = useLang();
  const route = parse(path);
  const prevStatus = useRef(status);
  useTabBadge();
  const gridSide = useGridSide();

  useEffect(() => {
    if (status === 'anonymous' && !['login', 'signup', 'invite', 'sso', 'guestCall', 'room', 'booking', 'bookingManage', 'bookingHome', 'confirmSignup'].includes(route.name)) navigate(`/login${path !== '/' ? `?next=${encodeURIComponent(path)}` : ''}`, true);
    // Con sesión desde antes, el enlace de una invitación a la empresa (/signup?org=…) se acepta en /invite/… (también
    // entra a sus grupos). Si la sesión acaba de nacer aquí mismo (se registró con el enlace), ya entró: sigue normal.
    const org = route.name === 'signup' ? new URLSearchParams(location.search).get('org') : null;
    const fresh = prevStatus.current === 'anonymous';
    prevStatus.current = status;
    if (status === 'ready' && org && !fresh) navigate(`/invite/${encodeURIComponent(org)}`, true);
    else if (status === 'ready' && (route.name === 'login' || route.name === 'signup')) navigate(nextParam() ?? '/', true);
  }, [status, route.name, path]);

  if (status === 'ready') markOnce('chaggu:ready');
  // Invitado por enlace: no necesita sesión, ni esperar a que cargue la de chaggu.
  if (route.name === 'guestCall') return <Suspense fallback={null}><GuestCallScreen key={lang} token={route.token} /><ToastHost /></Suspense>;
  if (route.name === 'room') return <Suspense fallback={null}><GuestCallScreen key={lang} room={route.code} /><ToastHost /></Suspense>;
  if (route.name === 'booking' || route.name === 'bookingManage' || route.name === 'bookingHome') return <Suspense fallback={null}><BookingScreen key={lang} route={route} /><ToastHost /></Suspense>;
  if (status === 'loading') return <div className="auth"><img src={asset("/chaggu-logo.svg")} alt="chaggu" width={128} height={56} style={{ opacity: 0.6 }} /></div>;
  if (route.name === 'sso') return <SsoReturnScreen key={lang} />;
  if (route.name === 'confirmSignup') return <ConfirmSignupScreen key={lang} token={route.token} />;
  if (route.name === 'invite') return <InviteScreen key={lang} token={route.token} />;
  if (status === 'anonymous') return <AuthScreen key={lang} mode={route.name === 'signup' ? 'signup' : 'login'} after={nextParam()} />;
  if (route.name === 'login' || route.name === 'signup') return null;

  return (
    <>
    <Shell key={lang} route={route}>
      {route.name === 'today' && <TodayScreen />}
      {route.name === 'inbox' && <InboxScreen />}
      {route.name === 'spaces' && <SpacesScreen />}
      {route.name === 'people' && <PeopleScreen />}
      {route.name === 'issues' && <IssuesScreen />}
      {route.name === 'trazo' && <TrazoScreen />}
      {route.name === 'agenda' && <AgendaScreen />}
      {route.name === 'share' && <ShareScreen />}
      {route.name === 'whatsapp' && <WhatsAppScreen />}
      {route.name === 'files' && <FilesScreen />}
      {route.name === 'saved' && <SavedLinksScreen />}
      {route.name === 'scheduled' && <ScheduledScreen />}
      {route.name === 'calls' && <CallsScreen />}
      {route.name === 'mail' && <MailScreen />}
      {route.name === 'signed' && <Suspense fallback={<div className="page"><div className="hint">{t('common.loading')}</div></div>}><SignedScreen /></Suspense>}
      {route.name === 'groups' && <GroupsScreen />}
      {route.name === 'dms' && <DmsScreen />}
      {route.name === 'oversight' && <OversightScreen key={route.id} orgId={route.id} />}
      {route.name === 'readonly' && <ReadOnlyConversationScreen key={route.id} id={route.id} />}
      {route.name === 'settings' && <SettingsScreen />}
      {route.name === 'workspace' && <WorkspaceScreen key={route.id} id={route.id} />}
      {route.name === 'conversation' && <ConversationArea id={route.id} search={location.search} />}
      {route.name === 'grid' && <GridScreen />}
    </Shell>
    <UpdateBanner />
    <DragTray gridVisible={route.name === 'conversation' || route.name === 'grid' || (gridSide && (route.name === 'whatsapp' || route.name === 'mail'))} />
    <MenuHost />
    <DialogHost />
    <ToastHost />
    <BubbleHost />
    <EmojiPickerHost />
    <CallDock />
    <IncomingCallHost />
    <OtherDeviceCallBar />
    </>
  );
}
