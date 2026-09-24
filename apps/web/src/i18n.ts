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
  'auth.withGoogle': 'Continuar con Google', 'auth.withMicrosoft': 'Continuar con Microsoft', 'auth.orEmail': 'o con tu correo',
  'auth.ssoNeedsCompany': 'Escribe el nombre de tu empresa antes de continuar.', 'auth.backToLogin': 'Volver a entrar',
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
  // Navegación nueva
  'nav.issues': 'Asuntos', 'nav.trazo': 'Trazo',
  // Asuntos
  'issue.new': '＋ Asunto', 'issue.newTitle': 'Nuevo asunto', 'issue.fromMessage': '＋ Abrir asunto', 'issue.title': 'Qué hay que resolver',
  'issue.owner': 'Responsable', 'issue.due': 'Fecha límite', 'issue.noDue': 'Sin fecha', 'issue.create': 'Abrir asunto', 'issue.status': 'Estado',
  'issue.st.open': 'Abierto', 'issue.st.in_progress': 'En curso', 'issue.st.waiting': 'Esperando', 'issue.st.done': 'Resuelto', 'issue.st.cancelled': 'Descartado',
  'issue.waitingOn': 'Esperando a', 'issue.waitingOnPh': 'Elige una empresa', 'issue.here': 'Asuntos aquí', 'issue.origin': 'Ver mensaje de origen',
  'issue.originOut': 'El mensaje de origen quedó fuera de tu historial', 'issue.requestedBy': 'Lo pidió {name}', 'issue.manual': 'Creado a mano',
  'issue.stalled': 'Detenido hace {n} días', 'issue.stalledOne': 'Detenido hace 1 día', 'issue.overdue': 'Vencido', 'issue.today': 'Vence hoy',
  'issue.comment': 'Comentar', 'issue.commentPh': 'Escribe un avance o una pregunta…', 'issue.history': 'Historial', 'issue.noIssues': 'No hay asuntos abiertos aquí.',
  'issue.mine': 'Míos', 'issue.allOpen': 'Abiertos', 'issue.closed': 'Cerrados', 'issue.pageSub': 'Lo que quedó pendiente en tus conversaciones, con responsable y fecha. Cada asunto guarda el mensaje donde nació y solo lo ve quien puede leer esa conversación.',
  'issue.empty': 'No hay asuntos con este filtro.', 'issue.yours': 'Tus asuntos', 'issue.yoursEmpty': 'No tienes asuntos abiertos.', 'issue.in': 'en {name}',
  'issue.ev.created': 'abrió el asunto', 'issue.ev.status': 'cambió el estado a {to}', 'issue.ev.owner': 'cambió el responsable', 'issue.ev.due': 'cambió la fecha a {to}',
  'issue.ev.title': 'renombró el asunto', 'issue.ev.waiting': 'marcó que se espera a otra empresa', 'issue.bottleneck': 'Posible cuello de botella',
  // Bifurcaciones
  'derive.action': '⑂ Derivar', 'derive.title': 'Derivar una conversación', 'derive.body': 'Resuelve esta parte aparte, sin mover el hilo original. Cuando termines, devuelves el resultado aquí.',
  'derive.same': 'Grupo derivado · misma audiencia', 'derive.sameNote': 'Sigue con las mismas personas y empresas de este grupo',
  'derive.internal': 'Diagnóstico interno · {org}', 'derive.internalNote': 'Solo tu empresa resuelve y devuelve la respuesta',
  'derive.directive': 'Decisión directiva', 'derive.directiveNote': 'Quien lidera el espacio, tú y quien escribió el mensaje',
  'derive.name': 'Nombre', 'derive.reason': 'Por qué se deriva (opcional)', 'derive.create': 'Derivar',
  'derive.prefix.same': 'Derivada', 'derive.prefix.internal': 'Diagnóstico', 'derive.prefix.directive': 'Decisión',
  'lin.label': 'Linaje', 'lin.from': 'Viene de', 'lin.fromHidden': 'Viene de una conversación fuera de tu alcance', 'lin.kids': 'Derivó en',
  'lin.returned': 'Devolvió su resultado', 'lin.return': '↩ Devolver el resultado', 'lin.trazo': 'Ver el trazo',
  'lin.returnTitle': 'Devolver el resultado', 'lin.returnBody': 'Se publica en «{name}» como cierre de esta derivada. Quienes están allí lo verán aunque no participen aquí.',
  'lin.returnSend': 'Devolver', 'lin.resultOf': 'Resultado de «{name}»', 'lin.resultHidden': 'Resultado de una conversación derivada', 'lin.open': 'Abrir',
  'lin.kind.same': 'Misma audiencia', 'lin.kind.internal': 'Interno', 'lin.kind.directive': 'Directivo',
  // Trazo
  'trazo.sub': 'Una conversación se deriva en otra cuando hay que resolver algo aparte —con el equipo, con otra empresa, con dirección— y se vuelve a conectar cuando devuelve su resultado. Aquí ves cada recorrido completo.',
  'trazo.empty': 'Aún no hay conversaciones derivadas en tu alcance. Deriva una desde cualquier mensaje con «⑂ Derivar».',
  'trazo.open': 'Abierta', 'trazo.returnedOn': 'Devuelta {date}', 'trazo.tramos': '{n} tramos', 'trazo.companies': 'Empresas en el recorrido',
  // Mensajes de sistema nuevos
  'sys.issue.created': 'Abrió el asunto «{title}».', 'sys.issue.closed': 'Cerró el asunto «{title}».', 'sys.issue.reopened': 'Reabrió el asunto «{title}».',
  'sys.derived.here': 'Conversación derivada de «{parent}»: «{excerpt}»', 'sys.derived.from': 'Se derivó una conversación desde aquí.', 'sys.returned': 'Esta conversación devolvió su resultado al origen.',
  'common.save': 'Guardar', 'common.none': 'Nadie',
  // Menús contextuales
  'menu.reply': 'Responder', 'menu.copyText': 'Copiar texto', 'menu.copyLink': 'Copiar enlace', 'menu.pin': 'Fijar mensaje', 'menu.unpin': 'Quitar de fijados',
  'menu.remind': 'Recordarme', 'menu.markUnread': 'Marcar como no leído desde aquí', 'menu.derive': 'Derivar a otra conversación', 'menu.issue': 'Abrir asunto',
  'menu.meeting': 'Agendar reunión', 'menu.forward': 'Reenviar', 'menu.edit': 'Editar', 'menu.delete': 'Eliminar mensaje', 'menu.deleteConfirm': '¿Eliminar este mensaje? Se verá como «Mensaje eliminado».',
  'menu.open': 'Abrir', 'menu.openTab': 'Abrir en una pestaña nueva', 'menu.pinTop': 'Fijar arriba', 'menu.unpinTop': 'Desfijar', 'menu.markRead': 'Marcar como leído',
  'menu.markUnreadConv': 'Marcar como no leído', 'menu.mute': 'Silenciar', 'menu.unmute': 'Reactivar notificaciones', 'menu.leave': 'Salir del grupo',
  'menu.newGroup': 'Nuevo grupo', 'menu.invite': 'Invitar', 'menu.openSpace': 'Abrir espacio', 'menu.dm': 'Mensaje directo', 'menu.viewIssues': 'Ver asuntos',
  'when.20m': 'En 20 minutos', 'when.1h': 'En 1 hora', 'when.3h': 'En 3 horas', 'when.tomorrow': 'Mañana a las 9:00', 'when.monday': 'El lunes a las 9:00', 'when.custom': 'Elegir fecha y hora…',
  'mute.1h': 'Por 1 hora', 'mute.8h': 'Por 8 horas', 'mute.week': 'Por 1 semana', 'mute.forever': 'Hasta que lo reactive',
  'fwd.tiecoms': 'A otra conversación de TieComs…', 'fwd.whatsapp': 'Por WhatsApp', 'fwd.slack': 'Copiar para Slack', 'fwd.email': 'Por correo', 'fwd.teams': 'Copiar para Teams',
  'toast.copied': 'Copiado', 'toast.linkCopied': 'Enlace copiado · solo abre para quien tiene acceso', 'toast.slackCopied': 'Copiado con formato de Slack · pégalo en el canal',
  'toast.teamsCopied': 'Copiado · pégalo en Teams', 'toast.reminderSet': 'Te lo recuerdo {when}', 'toast.pinned': 'Fijado', 'toast.unpinned': 'Quitado de fijados', 'toast.muted': 'Silenciado',
  'toast.unmuted': 'Notificaciones reactivadas', 'toast.markedUnread': 'Marcado como no leído', 'toast.sent': 'Enviado',
  // Respuesta, edición, fijados
  'reply.to': 'Respondiendo a {name}', 'reply.cancel': 'Cancelar respuesta', 'reply.quoteMissing': 'Respuesta a un mensaje anterior', 'msg.edited': '(editado)',
  'edit.save': 'Guardar', 'edit.hint': 'Esc para cancelar · Enter para guardar', 'pins.title': 'Fijados', 'pins.empty': 'No hay mensajes fijados.', 'pins.count': '{n} fijados',
  'side.pinned': 'Fijados', 'side.muted': 'Silenciado',
  // Reenvíos
  'fwd.title': 'Reenviar a TieComs', 'fwd.pick': 'Elige la conversación', 'fwd.search': 'Buscar conversación', 'fwd.comment': 'Agregar un comentario (opcional)', 'fwd.send': 'Reenviar',
  'fwd.label': 'Reenviado', 'fwd.from': 'Reenviado desde {source}', 'fwd.fromBy': 'Reenviado desde {source} · {author}', 'fwd.fromConv': 'Reenviado desde «{name}»',
  'src.whatsapp': 'WhatsApp', 'src.slack': 'Slack', 'src.email': 'correo', 'src.teams': 'Teams', 'src.tiecoms': 'TieComs', 'src.other': 'otra app',
  'imp.action': 'Traer desde WhatsApp, Slack o correo', 'imp.title': 'Traer a TieComs', 'imp.body': 'Pega lo que copiaste de WhatsApp, Slack, un correo u otra app. Queda marcado con su origen y su autor original.',
  'imp.source': 'Desde', 'imp.paste': 'Pega aquí el mensaje, el hilo o el correo', 'imp.author': 'Autor original (opcional)', 'imp.detected': 'Detecté {n} mensajes de WhatsApp',
  'imp.asMany': 'Traerlos como {n} mensajes separados', 'imp.asOne': 'Traerlo como un solo mensaje', 'imp.send': 'Traer', 'imp.subject': 'Asunto: {s}',
  'share.title': 'Compartir en TieComs', 'share.body': 'Elige dónde publicar lo que compartiste.', 'share.empty': 'No llegó texto para compartir.',
  // Recordatorios
  'rem.title': 'Recordatorios', 'rem.due': 'Ahora', 'rem.upcoming': 'Próximos', 'rem.empty': 'Sin recordatorios pendientes.', 'rem.done': 'Hecho', 'rem.snooze': 'Posponer 1 h',
  'rem.open': 'Abrir', 'rem.custom': 'Recordarme', 'rem.when': 'Cuándo', 'rem.note': 'Nota (opcional)', 'rem.save': 'Guardar recordatorio', 'rem.about': 'Sobre «{name}»',
  'rem.alert': 'Recordatorio', 'notif.enable': 'Activar notificaciones del navegador', 'notif.on': 'Notificaciones activadas en este navegador', 'notif.blocked': 'El navegador bloqueó las notificaciones',
  'notif.title': 'Notificaciones',
  // Calendario
  'nav.agenda': 'Agenda', 'cal.today': 'Hoy', 'cal.prev': 'Semana anterior', 'cal.next': 'Semana siguiente', 'cal.new': '＋ Reunión', 'cal.newTitle': 'Nueva reunión', 'cal.editTitle': 'Editar reunión',
  'cal.title': 'Título', 'cal.conversation': 'Grupo', 'cal.date': 'Fecha', 'cal.start': 'Inicio', 'cal.end': 'Fin', 'cal.tz': 'Zona horaria', 'cal.location': 'Lugar o enlace de la reunión',
  'cal.locationPh': 'Sala, dirección o enlace de Meet, Teams o Zoom', 'cal.invitees': 'Invitados', 'cal.description': 'Notas (opcional)', 'cal.save': 'Guardar', 'cal.create': 'Agendar',
  'cal.organizer': 'Organiza {name}', 'cal.rsvp.yes': 'Asistiré', 'cal.rsvp.no': 'No asistiré', 'cal.rsvp.maybe': 'Tal vez', 'cal.rsvp.pending': 'Sin responder',
  'cal.addGoogle': 'Google Calendar', 'cal.addOutlook': 'Outlook', 'cal.ics': 'Descargar .ics', 'cal.addTo': 'Agregar a tu calendario', 'cal.join': 'Unirse', 'cal.openChat': 'Abrir conversación',
  'cal.cancel': 'Cancelar reunión', 'cal.cancelConfirm': '¿Cancelar esta reunión? Se avisará en el grupo.', 'cal.cancelled': 'Cancelada', 'cal.empty': 'No hay reuniones esta semana.',
  'cal.todayList': 'Hoy en tu agenda', 'cal.todayEmpty': 'Sin reuniones hoy.', 'cal.upcoming': 'Próximas reuniones', 'cal.noUpcoming': 'Sin reuniones próximas en este grupo.',
  'cal.yourTz': 'Tu hora', 'cal.eventTz': 'Hora del evento', 'cal.edit': 'Editar', 'cal.week': 'Semana del {date}',
  'sys.event.created': 'Agendó «{title}» para el {when}.', 'sys.event.moved': 'Movió «{title}» al {when}.', 'sys.event.cancelled': 'Canceló la reunión «{title}».',
  'day.today': 'Hoy', 'day.yesterday': 'Ayer',
  // Errores del API por código
  'err.unauthorized': 'Correo o contraseña incorrectos', 'err.conflict': 'Ya existe o ya no es válido', 'err.forbidden': 'No tienes permiso para esto',
  'err.not_found': 'No encontrado o fuera de tu alcance', 'err.rate_limited': 'Demasiados intentos. Espera un momento.', 'err.bad_request': 'Revisa los datos',
  'err.internal': 'Error interno. Intenta de nuevo.', 'err.network': 'Sin conexión con el servidor',
  'err.domain_claimed': 'Tu empresa ya está en TieComs. Pide a su administrador que te invite.',
  'err.sso_expired': 'El inicio de sesión venció. Inténtalo de nuevo.', 'err.sso_state': 'No pudimos confirmar el inicio de sesión en este navegador. Inténtalo de nuevo.',
  'err.sso_cancelled': 'Cancelaste el inicio de sesión.', 'err.sso_failed': 'No pudimos completar el inicio de sesión.',
  'err.sso_unavailable': 'Este inicio de sesión aún no está disponible.', 'err.sso_personal_account': 'Usa tu cuenta de Microsoft de trabajo; las cuentas personales no están habilitadas.',
  'err.sso_email_unverified': 'Tu proveedor no ha verificado este correo. Entra con tu correo y contraseña.', 'err.account_disabled': 'Esta cuenta está desactivada.',
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
  'auth.withGoogle': 'Continue with Google', 'auth.withMicrosoft': 'Continue with Microsoft', 'auth.orEmail': 'or with your email',
  'auth.ssoNeedsCompany': 'Type your company name before continuing.', 'auth.backToLogin': 'Back to sign in',
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
  'nav.issues': 'Issues', 'nav.trazo': 'Trace',
  'issue.new': '＋ Issue', 'issue.newTitle': 'New issue', 'issue.fromMessage': '＋ Open issue', 'issue.title': 'What needs to be solved',
  'issue.owner': 'Owner', 'issue.due': 'Due date', 'issue.noDue': 'No date', 'issue.create': 'Open issue', 'issue.status': 'Status',
  'issue.st.open': 'Open', 'issue.st.in_progress': 'In progress', 'issue.st.waiting': 'Waiting', 'issue.st.done': 'Done', 'issue.st.cancelled': 'Dropped',
  'issue.waitingOn': 'Waiting on', 'issue.waitingOnPh': 'Pick a company', 'issue.here': 'Issues here', 'issue.origin': 'See original message',
  'issue.originOut': 'The original message is outside your history', 'issue.requestedBy': 'Requested by {name}', 'issue.manual': 'Created manually',
  'issue.stalled': 'Stalled for {n} days', 'issue.stalledOne': 'Stalled for 1 day', 'issue.overdue': 'Overdue', 'issue.today': 'Due today',
  'issue.comment': 'Comment', 'issue.commentPh': 'Write an update or a question…', 'issue.history': 'History', 'issue.noIssues': 'No open issues here.',
  'issue.mine': 'Mine', 'issue.allOpen': 'Open', 'issue.closed': 'Closed', 'issue.pageSub': 'What was left pending in your conversations, with an owner and a date. Every issue keeps the message it came from, and only people who can read that conversation see it.',
  'issue.empty': 'No issues match this filter.', 'issue.yours': 'Your issues', 'issue.yoursEmpty': 'You have no open issues.', 'issue.in': 'in {name}',
  'issue.ev.created': 'opened the issue', 'issue.ev.status': 'changed the status to {to}', 'issue.ev.owner': 'changed the owner', 'issue.ev.due': 'changed the date to {to}',
  'issue.ev.title': 'renamed the issue', 'issue.ev.waiting': 'marked it as waiting on another company', 'issue.bottleneck': 'Possible bottleneck',
  'derive.action': '⑂ Branch', 'derive.title': 'Branch a conversation', 'derive.body': 'Solve this part separately without moving the original thread. When you are done, you return the result here.',
  'derive.same': 'Branched group · same audience', 'derive.sameNote': 'Continues with the same people and companies as this group',
  'derive.internal': 'Internal diagnosis · {org}', 'derive.internalNote': 'Only your company works on it and returns the answer',
  'derive.directive': 'Leadership decision', 'derive.directiveNote': 'The space leads, you and whoever wrote the message',
  'derive.name': 'Name', 'derive.reason': 'Why it is branched (optional)', 'derive.create': 'Branch',
  'derive.prefix.same': 'Branch', 'derive.prefix.internal': 'Diagnosis', 'derive.prefix.directive': 'Decision',
  'lin.label': 'Lineage', 'lin.from': 'Comes from', 'lin.fromHidden': 'Comes from a conversation outside your scope', 'lin.kids': 'Branched into',
  'lin.returned': 'Returned its result', 'lin.return': '↩ Return the result', 'lin.trazo': 'See the trace',
  'lin.returnTitle': 'Return the result', 'lin.returnBody': 'It is posted in “{name}” as the close of this branch. People there will see it even if they are not part of this one.',
  'lin.returnSend': 'Return', 'lin.resultOf': 'Result of “{name}”', 'lin.resultHidden': 'Result of a branched conversation', 'lin.open': 'Open',
  'lin.kind.same': 'Same audience', 'lin.kind.internal': 'Internal', 'lin.kind.directive': 'Leadership',
  'trazo.sub': 'A conversation branches into another when something has to be solved separately —with the team, with another company, with leadership— and reconnects when it returns its result. Here you see each full journey.',
  'trazo.empty': 'There are no branched conversations in your scope yet. Branch one from any message with “⑂ Branch”.',
  'trazo.open': 'Open', 'trazo.returnedOn': 'Returned {date}', 'trazo.tramos': '{n} legs', 'trazo.companies': 'Companies in the journey',
  'sys.issue.created': 'Opened the issue “{title}”.', 'sys.issue.closed': 'Closed the issue “{title}”.', 'sys.issue.reopened': 'Reopened the issue “{title}”.',
  'sys.derived.here': 'Branched from “{parent}”: “{excerpt}”', 'sys.derived.from': 'A conversation was branched from here.', 'sys.returned': 'This conversation returned its result to its origin.',
  'common.save': 'Save', 'common.none': 'Nobody',
  'menu.reply': 'Reply', 'menu.copyText': 'Copy text', 'menu.copyLink': 'Copy link', 'menu.pin': 'Pin message', 'menu.unpin': 'Unpin',
  'menu.remind': 'Remind me', 'menu.markUnread': 'Mark unread from here', 'menu.derive': 'Branch into a new conversation', 'menu.issue': 'Open issue',
  'menu.meeting': 'Schedule a meeting', 'menu.forward': 'Forward', 'menu.edit': 'Edit', 'menu.delete': 'Delete message', 'menu.deleteConfirm': 'Delete this message? It will show as “Message deleted”.',
  'menu.open': 'Open', 'menu.openTab': 'Open in a new tab', 'menu.pinTop': 'Pin to top', 'menu.unpinTop': 'Unpin', 'menu.markRead': 'Mark as read',
  'menu.markUnreadConv': 'Mark as unread', 'menu.mute': 'Mute', 'menu.unmute': 'Unmute', 'menu.leave': 'Leave group',
  'menu.newGroup': 'New group', 'menu.invite': 'Invite', 'menu.openSpace': 'Open space', 'menu.dm': 'Direct message', 'menu.viewIssues': 'View issues',
  'when.20m': 'In 20 minutes', 'when.1h': 'In 1 hour', 'when.3h': 'In 3 hours', 'when.tomorrow': 'Tomorrow at 9:00', 'when.monday': 'Monday at 9:00', 'when.custom': 'Pick date and time…',
  'mute.1h': 'For 1 hour', 'mute.8h': 'For 8 hours', 'mute.week': 'For 1 week', 'mute.forever': 'Until I turn it back on',
  'fwd.tiecoms': 'To another TieComs conversation…', 'fwd.whatsapp': 'Via WhatsApp', 'fwd.slack': 'Copy for Slack', 'fwd.email': 'Via email', 'fwd.teams': 'Copy for Teams',
  'toast.copied': 'Copied', 'toast.linkCopied': 'Link copied · it only opens for people with access', 'toast.slackCopied': 'Copied with Slack formatting · paste it in the channel',
  'toast.teamsCopied': 'Copied · paste it in Teams', 'toast.reminderSet': 'I will remind you {when}', 'toast.pinned': 'Pinned', 'toast.unpinned': 'Unpinned', 'toast.muted': 'Muted',
  'toast.unmuted': 'Notifications back on', 'toast.markedUnread': 'Marked as unread', 'toast.sent': 'Sent',
  'reply.to': 'Replying to {name}', 'reply.cancel': 'Cancel reply', 'reply.quoteMissing': 'Reply to an earlier message', 'msg.edited': '(edited)',
  'edit.save': 'Save', 'edit.hint': 'Esc to cancel · Enter to save', 'pins.title': 'Pinned', 'pins.empty': 'No pinned messages.', 'pins.count': '{n} pinned',
  'side.pinned': 'Pinned', 'side.muted': 'Muted',
  'fwd.title': 'Forward to TieComs', 'fwd.pick': 'Choose the conversation', 'fwd.search': 'Search conversation', 'fwd.comment': 'Add a comment (optional)', 'fwd.send': 'Forward',
  'fwd.label': 'Forwarded', 'fwd.from': 'Forwarded from {source}', 'fwd.fromBy': 'Forwarded from {source} · {author}', 'fwd.fromConv': 'Forwarded from “{name}”',
  'src.whatsapp': 'WhatsApp', 'src.slack': 'Slack', 'src.email': 'email', 'src.teams': 'Teams', 'src.tiecoms': 'TieComs', 'src.other': 'another app',
  'imp.action': 'Bring in from WhatsApp, Slack or email', 'imp.title': 'Bring into TieComs', 'imp.body': 'Paste what you copied from WhatsApp, Slack, an email or another app. It keeps its source and original author.',
  'imp.source': 'From', 'imp.paste': 'Paste the message, thread or email here', 'imp.author': 'Original author (optional)', 'imp.detected': 'Detected {n} WhatsApp messages',
  'imp.asMany': 'Bring them as {n} separate messages', 'imp.asOne': 'Bring it as a single message', 'imp.send': 'Bring in', 'imp.subject': 'Subject: {s}',
  'share.title': 'Share to TieComs', 'share.body': 'Choose where to post what you shared.', 'share.empty': 'No text arrived to share.',
  'rem.title': 'Reminders', 'rem.due': 'Now', 'rem.upcoming': 'Upcoming', 'rem.empty': 'No pending reminders.', 'rem.done': 'Done', 'rem.snooze': 'Snooze 1 h',
  'rem.open': 'Open', 'rem.custom': 'Remind me', 'rem.when': 'When', 'rem.note': 'Note (optional)', 'rem.save': 'Save reminder', 'rem.about': 'About “{name}”',
  'rem.alert': 'Reminder', 'notif.enable': 'Turn on browser notifications', 'notif.on': 'Notifications are on in this browser', 'notif.blocked': 'The browser blocked notifications',
  'notif.title': 'Notifications',
  'nav.agenda': 'Calendar', 'cal.today': 'Today', 'cal.prev': 'Previous week', 'cal.next': 'Next week', 'cal.new': '＋ Meeting', 'cal.newTitle': 'New meeting', 'cal.editTitle': 'Edit meeting',
  'cal.title': 'Title', 'cal.conversation': 'Group', 'cal.date': 'Date', 'cal.start': 'Start', 'cal.end': 'End', 'cal.tz': 'Time zone', 'cal.location': 'Place or meeting link',
  'cal.locationPh': 'Room, address or Meet, Teams or Zoom link', 'cal.invitees': 'Invitees', 'cal.description': 'Notes (optional)', 'cal.save': 'Save', 'cal.create': 'Schedule',
  'cal.organizer': 'Organized by {name}', 'cal.rsvp.yes': 'Going', 'cal.rsvp.no': 'Not going', 'cal.rsvp.maybe': 'Maybe', 'cal.rsvp.pending': 'No answer',
  'cal.addGoogle': 'Google Calendar', 'cal.addOutlook': 'Outlook', 'cal.ics': 'Download .ics', 'cal.addTo': 'Add to your calendar', 'cal.join': 'Join', 'cal.openChat': 'Open conversation',
  'cal.cancel': 'Cancel meeting', 'cal.cancelConfirm': 'Cancel this meeting? The group will be notified.', 'cal.cancelled': 'Cancelled', 'cal.empty': 'No meetings this week.',
  'cal.todayList': 'Today on your calendar', 'cal.todayEmpty': 'No meetings today.', 'cal.upcoming': 'Upcoming meetings', 'cal.noUpcoming': 'No upcoming meetings in this group.',
  'cal.yourTz': 'Your time', 'cal.eventTz': 'Event time', 'cal.edit': 'Edit', 'cal.week': 'Week of {date}',
  'sys.event.created': 'Scheduled “{title}” for {when}.', 'sys.event.moved': 'Moved “{title}” to {when}.', 'sys.event.cancelled': 'Cancelled the meeting “{title}”.',
  'day.today': 'Today', 'day.yesterday': 'Yesterday',
  'err.unauthorized': 'Wrong email or password', 'err.conflict': 'Already exists or is no longer valid', 'err.forbidden': 'You do not have permission to do this',
  'err.not_found': 'Not found or outside your scope', 'err.rate_limited': 'Too many attempts. Please wait a moment.', 'err.bad_request': 'Please check the details',
  'err.internal': 'Internal error. Please try again.', 'err.network': 'Cannot reach the server',
  'err.domain_claimed': 'Your company is already on TieComs. Ask its administrator to invite you.',
  'err.sso_expired': 'Sign-in expired. Please try again.', 'err.sso_state': 'We could not confirm the sign-in in this browser. Please try again.',
  'err.sso_cancelled': 'You cancelled the sign-in.', 'err.sso_failed': 'We could not complete the sign-in.',
  'err.sso_unavailable': 'This sign-in option is not available yet.', 'err.sso_personal_account': 'Use your work Microsoft account; personal accounts are not enabled.',
  'err.sso_email_unverified': 'Your provider has not verified this email. Sign in with your email and password.', 'err.account_disabled': 'This account is disabled.',
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
    if (p.startsAt) p.when = new Date(p.startsAt).toLocaleString(locale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    return key in es ? t(key, p) : body;
  } catch { return body; }
}
