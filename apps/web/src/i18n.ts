import { useSyncExternalStore } from 'react';

export type Lang = 'es' | 'en';

/**
 * Textos de la interfaz. El idioma por defecto sale del navegador
 * (navigator.languages): español si lo prefiere, inglés en cualquier otro caso.
 * La persona puede fijarlo en Ajustes; se guarda solo en este dispositivo.
 */
const es = {
  'brand.tagline': 'Una sola red entre las empresas con las que trabajas. Cada persona ve su propio alcance.',
  'brand.network': 'Tu red',
  'common.cancel': 'Cancelar', 'common.close': 'Cerrar', 'common.done': 'Listo', 'common.copy': 'Copiar', 'common.copied': 'Copiado',
  'common.loading': 'Cargando…', 'common.wait': 'Un momento…', 'common.back': 'Volver', 'common.message': 'Mensaje', 'common.directMessage': 'Mensaje directo',
  'common.you': '(tú)', 'common.participant': 'Participante', 'common.noCompany': 'Sin empresa', 'common.guest': 'Tercero invitado', 'common.guests': 'Terceros invitados',
  'common.agents': 'Agentes', 'common.error': 'No se pudo completar',
  // Autenticación
  'auth.name': 'Tu nombre', 'auth.company': 'Tu empresa', 'auth.companyPh': 'Nombre de la empresa', 'auth.title': 'Tu cargo (opcional)',
  'auth.email': 'Correo de trabajo', 'auth.password': 'Contraseña', 'auth.passwordHint': 'Mínimo 10 caracteres.',
  'auth.login': 'Entrar', 'auth.signup': 'Crear cuenta y empresa', 'auth.signupJoin': 'Crear cuenta y unirme',
  'auth.noAccount': '¿Tu empresa aún no está en TieComs?', 'auth.createAccount': 'Crear cuenta', 'auth.haveAccount': '¿Ya tienes cuenta?',
  'auth.joining': 'Te unes a {org}', 'auth.joiningBy': '{name} te invitó a su empresa.', 'auth.inviteInvalid': 'La invitación a la empresa ya no es válida.',
  // Invitación a espacio
  'invite.title': 'Invitación', 'invite.by': '{name}{org} te invita como {role}.', 'invite.forEmail': 'Esta invitación es para {email}.',
  'invite.invalid': 'La invitación ya fue usada, se revocó o venció.',
  'invite.as': 'Entrarás como {name}. Tu empresa conserva su identidad: nadie es "invitado" en la casa de otro.',
  'invite.accept': 'Aceptar y entrar', 'invite.accepting': 'Uniéndote…', 'invite.have': 'Ya tengo cuenta',
  'role.member': 'participante', 'role.admin': 'administración', 'role.guest': 'tercero invitado', 'role.lead': 'líder',
  'role.Lead': 'Lidera', 'role.Admin': 'Administra', 'role.Member': 'Participa', 'role.Guest': 'Tercero',
  // Navegación
  'nav.today': 'Hoy', 'nav.inbox': 'Conversaciones', 'nav.chats': 'Chats', 'nav.spaces': 'Espacios', 'nav.people': 'Participantes', 'nav.peopleShort': 'Personas',
  'nav.mainNav': 'Navegación principal', 'side.companies': 'Empresas y espacios', 'side.newSpace': 'Nuevo espacio con un cliente',
  'side.empty': 'Crea tu primer espacio de trabajo con otra empresa.', 'side.directs': 'Directos',
  'conn.connecting': 'Conectando…', 'conn.offline': 'Sin conexión. Tus mensajes quedan en cola y se envían al volver.',
  // Hoy
  'today.morning': 'Buenos días', 'today.afternoon': 'Buenas tardes', 'today.evening': 'Buenas noches',
  'today.summary': '{messages} en {conversations}', 'today.upToDate': 'Estás al día.', 'today.spacesWith': '{spaces} con {companies}',
  'today.unread': 'Sin leer', 'today.waiting': 'Te esperan', 'today.spaces': 'Espacios', 'today.queued': 'En cola',
  'today.startTitle': 'Empieza con un cliente',
  'today.startBody': 'Crea un espacio para un tema de trabajo, invita a la otra empresa con un enlace y conversen en grupos con audiencia propia.',
  'today.newSpace': '＋ Nuevo espacio con un cliente', 'today.nothing': 'Nada pendiente. Buen momento para avanzar.', 'today.recent': 'Actividad reciente',
  'n.newMessage': 'mensaje nuevo', 'n.newMessages': 'mensajes nuevos', 'n.conversation': 'conversación', 'n.conversations': 'conversaciones',
  'n.space': 'espacio', 'n.spaces': 'espacios', 'n.company': 'empresa', 'n.companies': 'empresas', 'n.group': 'grupo', 'n.groups': 'grupos',
  'n.participant': 'participante', 'n.participants': 'participantes',
  'conv.noMessages': 'Sin mensajes todavía',
  // Conversaciones
  'inbox.search': 'Buscar conversación o persona', 'inbox.all': 'Todas', 'inbox.unread': 'Sin leer', 'inbox.directs': 'Directos', 'inbox.empty': 'No hay conversaciones con ese filtro.',
  // Espacios
  'spaces.new': '＋ Nuevo', 'spaces.empty': 'Aún no tienes espacios.', 'spaces.back': '‹ Espacios',
  'ws.invite': '＋ Invitar empresa o tercero', 'ws.newGroup': '＋ Nuevo grupo', 'ws.yourGroups': 'Tus grupos en este espacio',
  'ws.onlyYours': 'Solo ves los grupos en los que participas; los demás no revelan su nombre.', 'ws.participants': 'Participantes',
  'ws.guestHint': 'Como tercero invitado ves solo a las personas de tus grupos.', 'ws.notFound': 'Este espacio no existe o está fuera de tu alcance.',
  'kind.internal': 'Solo tu empresa', 'kind.directivo': 'Directivo', 'kind.operativo': 'Operativo', 'kind.internalShort': 'Interno', 'kind.direct': 'Directo',
  'conv.defaultInternal': 'Equipo interno',
  // Participantes
  'people.subtitle': 'Personas con las que compartes espacios y colegas de tu empresa. Solo ves a quien está dentro de tu alcance.',
  'people.search': 'Buscar por nombre, cargo o empresa', 'people.empty': 'Aún no compartes espacios con otras personas.', 'people.until': 'hasta {date}',
  // Ajustes
  'settings.title': 'Tu cuenta', 'settings.logout': 'Cerrar sesión', 'settings.devices': 'Dispositivos con sesión abierta', 'settings.lastSeen': 'Última actividad {date}',
  'settings.thisDevice': 'Este dispositivo', 'settings.closeSession': 'Cerrar', 'settings.language': 'Idioma', 'settings.langAuto': 'Automático (navegador)',
  'settings.platforms': 'TieComs para Web · próximamente macOS, Windows, Android e iOS con la misma cuenta y los mismos no leídos.',
  'settings.team': 'Tu empresa', 'settings.inviteColleague': 'Invitar a un colega', 'settings.inviteColleagueHint': 'Tu colega crea su cuenta dentro de {org} con este enlace de un solo uso (vence en 14 días).',
  'settings.inviteEmailPh': 'correo@tuempresa.com (opcional)', 'settings.generate': 'Generar enlace',
  // Diálogos
  'dlg.newSpace': 'Nuevo espacio', 'dlg.newSpaceBody': 'Un espacio es un tema de trabajo con otra empresa. Después invitas a su equipo; cada empresa conserva su identidad.',
  'dlg.spaceName': 'Nombre del espacio', 'dlg.spaceNamePh': 'Ej. Lanzamiento · Estudio Norte', 'dlg.department': 'Área o departamento (opcional)', 'dlg.departmentPh': 'Ej. Operaciones',
  'dlg.createSpace': 'Crear espacio', 'dlg.newGroup': 'Nuevo grupo', 'dlg.name': 'Nombre', 'dlg.shared': 'Compartido entre empresas', 'dlg.internal': 'Solo mi empresa',
  'dlg.participants': 'Participantes', 'dlg.noCandidates': 'Aún no hay más personas en este espacio. Invita a la otra empresa desde el espacio.',
  'dlg.groupHint': 'Solo quienes estén en el grupo podrán leerlo. Los grupos fuera de tu alcance no muestran su nombre.', 'dlg.createGroup': 'Crear grupo',
  'dlg.invite': 'Invitar', 'dlg.linkReady': 'Enlace listo', 'dlg.linkBody': 'Compártelo por el canal que ya usan (correo, WhatsApp). Es de un solo uso{email}; vence en 7 días.',
  'dlg.linkOnlyFor': ' y solo sirve para {email}', 'dlg.fromCompany': 'Persona de otra empresa', 'dlg.thirdParty': 'Tercero con fecha de salida',
  'dlg.memberHint': 'Entra con su propia empresa. Si su empresa aún no está en el espacio, se suma al aceptar.',
  'dlg.guestHint': 'Un tercero (abogado, consultor) solo entra a los grupos que marques, nunca al espacio completo, y pierde acceso en la fecha de salida.',
  'dlg.emailOpt': 'Correo (opcional, recomendado)', 'dlg.emailPh': 'persona@empresa.com', 'dlg.leaveDate': 'Fecha de salida', 'dlg.groupsJoin': 'Grupos a los que entra',
  'dlg.seeNew': 'Ve solo lo nuevo', 'dlg.seeHistory': 'Ve el historial', 'dlg.seeNewPl': 'Ven solo lo nuevo', 'dlg.seeHistoryPl': 'Ven el historial',
  'dlg.generate': 'Generar enlace', 'dlg.addToGroup': 'Agregar al grupo', 'dlg.allHere': 'Todas las personas del espacio ya están aquí. Para sumar a alguien nuevo, invítalo desde el espacio.',
  'dlg.add': 'Agregar',
  // Conversación
  'chat.notFound': 'Esta conversación no existe o está fuera de tu alcance.', 'chat.details': 'Detalles', 'chat.space': 'Espacio',
  'chat.lateJoin': 'Entraste aquí más tarde: ves los mensajes desde tu llegada.', 'chat.loadingOlder': 'Cargando anteriores…',
  'chat.formerParticipant': 'Participante anterior', 'chat.deleted': 'Mensaje eliminado', 'chat.typingOne': '{names} está escribiendo…', 'chat.typingMany': '{names} están escribiendo…',
  'chat.placeholder': 'Escribe a {name}', 'chat.send': 'Enviar', 'chat.readOnly': 'Solo lectura: no puedes publicar en esta conversación.',
  'chat.scope': 'Alcance', 'chat.scopeInternal': 'Solo personas de {org}.', 'chat.scopeGroup': 'Solo quienes están en este grupo pueden leerlo. Entrar después no da acceso al historial salvo concesión explícita.',
  'chat.add': '＋ Agregar', 'chat.remove': 'Quitar del grupo', 'chat.removeConfirm': '¿Quitar a {name} de este grupo?', 'chat.leave': 'Salir del grupo', 'chat.leaveConfirm': '¿Salir de este grupo?',
  'chat.guestUntil': 'Tercero hasta {date}', 'chat.notSent': 'No se envió', 'chat.retrying': 'Reintentando…', 'chat.sending': 'Enviando…', 'chat.retry': 'Reintentar', 'chat.discard': 'Descartar',
  'chat.aDirect': 'Directo', 'chat.aConversation': 'Conversación',
  // Mensajes de sistema
  'sys.workspace.created': 'Espacio «{name}» creado.', 'sys.group.created': 'Grupo «{name}» creado.',
  'sys.members.added': 'Se unió: {names}.', 'sys.members.added.all': 'Se unió: {names}, con acceso al historial.',
  'sys.member.left': '{name} salió del grupo.', 'sys.member.removed': '{name} ya no participa en este grupo.', 'sys.member.joined': '{name} se unió por invitación.',
  'day.today': 'Hoy', 'day.yesterday': 'Ayer',
  // Errores del API por código
  'err.unauthorized': 'Correo o contraseña incorrectos', 'err.conflict': 'Ya existe o ya no es válido', 'err.forbidden': 'No tienes permiso para esto',
  'err.not_found': 'No encontrado o fuera de tu alcance', 'err.rate_limited': 'Demasiados intentos. Espera un momento.', 'err.bad_request': 'Revisa los datos',
  'err.internal': 'Error interno. Intenta de nuevo.', 'err.network': 'Sin conexión con el servidor',
};

type Key = keyof typeof es;

const en: Record<Key, string> = {
  'brand.tagline': 'One network across the companies you work with. Everyone sees their own scope.',
  'brand.network': 'Your network',
  'common.cancel': 'Cancel', 'common.close': 'Close', 'common.done': 'Done', 'common.copy': 'Copy', 'common.copied': 'Copied',
  'common.loading': 'Loading…', 'common.wait': 'One moment…', 'common.back': 'Back', 'common.message': 'Message', 'common.directMessage': 'Direct message',
  'common.you': '(you)', 'common.participant': 'Participant', 'common.noCompany': 'No company', 'common.guest': 'Guest', 'common.guests': 'Guests',
  'common.agents': 'Agents', 'common.error': 'Could not complete',
  'auth.name': 'Your name', 'auth.company': 'Your company', 'auth.companyPh': 'Company name', 'auth.title': 'Your role (optional)',
  'auth.email': 'Work email', 'auth.password': 'Password', 'auth.passwordHint': 'At least 10 characters.',
  'auth.login': 'Sign in', 'auth.signup': 'Create account and company', 'auth.signupJoin': 'Create account and join',
  'auth.noAccount': 'Is your company not on TieComs yet?', 'auth.createAccount': 'Create account', 'auth.haveAccount': 'Already have an account?',
  'auth.joining': 'You are joining {org}', 'auth.joiningBy': '{name} invited you to their company.', 'auth.inviteInvalid': 'This company invitation is no longer valid.',
  'invite.title': 'Invitation', 'invite.by': '{name}{org} invites you as {role}.', 'invite.forEmail': 'This invitation is for {email}.',
  'invite.invalid': 'This invitation was already used, revoked or has expired.',
  'invite.as': 'You will join as {name}. Your company keeps its identity: nobody is a "guest" in someone else\'s house.',
  'invite.accept': 'Accept and enter', 'invite.accepting': 'Joining…', 'invite.have': 'I already have an account',
  'role.member': 'participant', 'role.admin': 'admin', 'role.guest': 'guest', 'role.lead': 'lead',
  'role.Lead': 'Lead', 'role.Admin': 'Admin', 'role.Member': 'Member', 'role.Guest': 'Guest',
  'nav.today': 'Today', 'nav.inbox': 'Conversations', 'nav.chats': 'Chats', 'nav.spaces': 'Spaces', 'nav.people': 'People', 'nav.peopleShort': 'People',
  'nav.mainNav': 'Main navigation', 'side.companies': 'Companies and spaces', 'side.newSpace': 'New space with a client',
  'side.empty': 'Create your first workspace with another company.', 'side.directs': 'Direct messages',
  'conn.connecting': 'Connecting…', 'conn.offline': 'Offline. Your messages are queued and will be sent when you reconnect.',
  'today.morning': 'Good morning', 'today.afternoon': 'Good afternoon', 'today.evening': 'Good evening',
  'today.summary': '{messages} in {conversations}', 'today.upToDate': 'You are all caught up.', 'today.spacesWith': '{spaces} with {companies}',
  'today.unread': 'Unread', 'today.waiting': 'Waiting on you', 'today.spaces': 'Spaces', 'today.queued': 'Queued',
  'today.startTitle': 'Start with a client',
  'today.startBody': 'Create a space for a piece of work, invite the other company with a link, and talk in groups with their own audience.',
  'today.newSpace': '＋ New space with a client', 'today.nothing': 'Nothing pending. Good time to move forward.', 'today.recent': 'Recent activity',
  'n.newMessage': 'new message', 'n.newMessages': 'new messages', 'n.conversation': 'conversation', 'n.conversations': 'conversations',
  'n.space': 'space', 'n.spaces': 'spaces', 'n.company': 'company', 'n.companies': 'companies', 'n.group': 'group', 'n.groups': 'groups',
  'n.participant': 'participant', 'n.participants': 'participants',
  'conv.noMessages': 'No messages yet',
  'inbox.search': 'Search conversation or person', 'inbox.all': 'All', 'inbox.unread': 'Unread', 'inbox.directs': 'Direct', 'inbox.empty': 'No conversations match this filter.',
  'spaces.new': '＋ New', 'spaces.empty': 'You have no spaces yet.', 'spaces.back': '‹ Spaces',
  'ws.invite': '＋ Invite a company or guest', 'ws.newGroup': '＋ New group', 'ws.yourGroups': 'Your groups in this space',
  'ws.onlyYours': 'You only see the groups you are in; the others do not reveal their name.', 'ws.participants': 'Participants',
  'ws.guestHint': 'As a guest you only see the people in your groups.', 'ws.notFound': 'This space does not exist or is outside your scope.',
  'kind.internal': 'Your company only', 'kind.directivo': 'Leadership', 'kind.operativo': 'Operational', 'kind.internalShort': 'Internal', 'kind.direct': 'Direct',
  'conv.defaultInternal': 'Internal team',
  'people.subtitle': 'People you share spaces with and colleagues from your company. You only see who is within your scope.',
  'people.search': 'Search by name, role or company', 'people.empty': 'You do not share spaces with anyone yet.', 'people.until': 'until {date}',
  'settings.title': 'Your account', 'settings.logout': 'Sign out', 'settings.devices': 'Devices with an open session', 'settings.lastSeen': 'Last active {date}',
  'settings.thisDevice': 'This device', 'settings.closeSession': 'Sign out', 'settings.language': 'Language', 'settings.langAuto': 'Automatic (browser)',
  'settings.platforms': 'TieComs for Web · macOS, Windows, Android and iOS coming soon with the same account and unread counts.',
  'settings.team': 'Your company', 'settings.inviteColleague': 'Invite a colleague', 'settings.inviteColleagueHint': 'Your colleague creates their account inside {org} with this single-use link (expires in 14 days).',
  'settings.inviteEmailPh': 'email@yourcompany.com (optional)', 'settings.generate': 'Generate link',
  'dlg.newSpace': 'New space', 'dlg.newSpaceBody': 'A space is a piece of work with another company. Then you invite their team; each company keeps its identity.',
  'dlg.spaceName': 'Space name', 'dlg.spaceNamePh': 'E.g. Launch · Estudio Norte', 'dlg.department': 'Area or department (optional)', 'dlg.departmentPh': 'E.g. Operations',
  'dlg.createSpace': 'Create space', 'dlg.newGroup': 'New group', 'dlg.name': 'Name', 'dlg.shared': 'Shared across companies', 'dlg.internal': 'My company only',
  'dlg.participants': 'Participants', 'dlg.noCandidates': 'There is nobody else in this space yet. Invite the other company from the space.',
  'dlg.groupHint': 'Only group members can read it. Groups outside your scope do not show their name.', 'dlg.createGroup': 'Create group',
  'dlg.invite': 'Invite', 'dlg.linkReady': 'Link ready', 'dlg.linkBody': 'Share it over the channel you already use (email, WhatsApp). It is single-use{email}; it expires in 7 days.',
  'dlg.linkOnlyFor': ' and only works for {email}', 'dlg.fromCompany': 'Person from another company', 'dlg.thirdParty': 'Guest with an end date',
  'dlg.memberHint': 'They join with their own company. If their company is not in the space yet, it is added when they accept.',
  'dlg.guestHint': 'A guest (lawyer, consultant) only joins the groups you select, never the whole space, and loses access on the end date.',
  'dlg.emailOpt': 'Email (optional, recommended)', 'dlg.emailPh': 'person@company.com', 'dlg.leaveDate': 'End date', 'dlg.groupsJoin': 'Groups they join',
  'dlg.seeNew': 'Sees only new messages', 'dlg.seeHistory': 'Sees the history', 'dlg.seeNewPl': 'See only new messages', 'dlg.seeHistoryPl': 'See the history',
  'dlg.generate': 'Generate link', 'dlg.addToGroup': 'Add to group', 'dlg.allHere': 'Everyone in the space is already here. To add someone new, invite them from the space.',
  'dlg.add': 'Add',
  'chat.notFound': 'This conversation does not exist or is outside your scope.', 'chat.details': 'Details', 'chat.space': 'Space',
  'chat.lateJoin': 'You joined later: you see messages from when you arrived.', 'chat.loadingOlder': 'Loading earlier messages…',
  'chat.formerParticipant': 'Former participant', 'chat.deleted': 'Message deleted', 'chat.typingOne': '{names} is typing…', 'chat.typingMany': '{names} are typing…',
  'chat.placeholder': 'Message {name}', 'chat.send': 'Send', 'chat.readOnly': 'Read only: you cannot post in this conversation.',
  'chat.scope': 'Scope', 'chat.scopeInternal': 'Only people from {org}.', 'chat.scopeGroup': 'Only people in this group can read it. Joining later does not grant access to the history unless explicitly allowed.',
  'chat.add': '＋ Add', 'chat.remove': 'Remove from group', 'chat.removeConfirm': 'Remove {name} from this group?', 'chat.leave': 'Leave group', 'chat.leaveConfirm': 'Leave this group?',
  'chat.guestUntil': 'Guest until {date}', 'chat.notSent': 'Not sent', 'chat.retrying': 'Retrying…', 'chat.sending': 'Sending…', 'chat.retry': 'Retry', 'chat.discard': 'Discard',
  'chat.aDirect': 'Direct', 'chat.aConversation': 'Conversation',
  'sys.workspace.created': 'Space “{name}” created.', 'sys.group.created': 'Group “{name}” created.',
  'sys.members.added': 'Joined: {names}.', 'sys.members.added.all': 'Joined: {names}, with access to the history.',
  'sys.member.left': '{name} left the group.', 'sys.member.removed': '{name} is no longer in this group.', 'sys.member.joined': '{name} joined by invitation.',
  'day.today': 'Today', 'day.yesterday': 'Yesterday',
  'err.unauthorized': 'Wrong email or password', 'err.conflict': 'Already exists or is no longer valid', 'err.forbidden': 'You do not have permission to do this',
  'err.not_found': 'Not found or outside your scope', 'err.rate_limited': 'Too many attempts. Please wait a moment.', 'err.bad_request': 'Please check the details',
  'err.internal': 'Internal error. Please try again.', 'err.network': 'Cannot reach the server',
};

const dicts: Record<Lang, Record<Key, string>> = { es, en };
const STORE_KEY = 'tiecoms:lang';

export function browserLang(): Lang {
  const prefs = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const l of prefs) {
    const base = (l || '').toLowerCase().slice(0, 2);
    if (base === 'es') return 'es';
    if (base === 'en') return 'en';
  }
  return 'en';
}

function stored(): Lang | null {
  try { const v = localStorage.getItem(STORE_KEY); return v === 'es' || v === 'en' ? v : null; } catch { return null; }
}

let current: Lang = stored() ?? browserLang();
const listeners = new Set<() => void>();
document.documentElement.lang = current;

/** null = seguir al navegador. */
export function setLang(l: Lang | null) {
  try { if (l) localStorage.setItem(STORE_KEY, l); else localStorage.removeItem(STORE_KEY); } catch {}
  current = l ?? browserLang();
  document.documentElement.lang = current;
  listeners.forEach((f) => f());
}
export const langPreference = (): Lang | null => stored();
export const getLang = () => current;
export const locale = () => (current === 'en' ? 'en-US' : 'es-CO');

export function useLang(): Lang {
  return useSyncExternalStore((f) => { listeners.add(f); return () => listeners.delete(f); }, () => current);
}

export function t(key: Key, vars: Record<string, string | number> = {}): string {
  const s = dicts[current][key] ?? es[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

export function tn(n: number, one: Key, many: Key) {
  return `${n} ${t(n === 1 ? one : many)}`;
}

/** Mensaje de error legible a partir del código del API (el texto del servidor está en español). */
export function errorText(e: any): string {
  if (e?.code === 'bad_request' && Array.isArray(e?.details) && e.details.length) {
    const paths = e.details.map((d: any) => d.path).filter(Boolean);
    return `${t('err.bad_request')}${paths.length ? `: ${[...new Set(paths)].join(', ')}` : ''}`;
  }
  const k = `err.${e?.code}` as Key;
  if (e?.code && k in es) return current === 'es' && e?.message ? e.message : t(k);
  if (e instanceof TypeError) return t('err.network');
  return e?.message || t('common.error');
}

/** Los mensajes de sistema llegan como {"k": clave, ...datos}; los antiguos, como texto plano. */
export function systemText(body: string): string {
  if (!body.startsWith('{')) return body;
  try {
    const p = JSON.parse(body);
    const key = (p.k === 'members.added' && p.history === 'all' ? 'sys.members.added.all' : `sys.${p.k}`) as Key;
    return key in es ? t(key, p) : body;
  } catch { return body; }
}
