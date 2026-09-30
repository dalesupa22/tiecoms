import { getLang } from './i18n.ts';

/**
 * Textos de la pantalla «Hoy» personalizable y de la guía (docs/HOY.md). Van aparte de i18n.ts para no chocar con
 * las otras ramas que agregan claves allí; usan el mismo idioma (getLang) y la misma sintaxis {variable}.
 */
const es = {
  'home.customize': 'Personalizar', 'home.done': 'Listo', 'home.editing': 'Personalizando tu inicio',
  'home.editHint': 'Arrastra los bloques para ordenarlos, o selecciona uno y usa las flechas. Los cambios se guardan solos en este dispositivo.',
  'home.templates': 'Plantillas', 'home.reset': 'Restablecer por defecto', 'home.resetDone': 'Inicio restablecido',
  'home.tpl.default': 'Por defecto', 'home.tpl.focus': 'Enfoque', 'home.tpl.manager': 'Gerente', 'home.tpl.support': 'Soporte', 'home.tpl.custom': 'A tu medida',
  'home.tpl.default.d': 'Todo lo de siempre y la guía', 'home.tpl.focus.d': 'Solo te esperan y tus tareas', 'home.tpl.manager.d': 'Números, menciones y agenda', 'home.tpl.support.d': 'Correo, WhatsApp y te esperan',
  'home.blocks': 'Bloques', 'home.hidden': 'Ocultos', 'home.show': 'Mostrar', 'home.hide': 'Ocultar', 'home.add': '＋ {name}',
  'home.narrow': 'Angosto', 'home.wide': 'Ancho', 'home.moveUp': 'Subir', 'home.moveDown': 'Bajar', 'home.drag': 'Arrastrar para mover',
  'home.compact': 'Números compactos', 'home.big': 'Números grandes',
  'home.grabbed': '{name} seleccionado. Usa las flechas para moverlo; Enter o Esc para soltarlo.', 'home.dropped': '{name} en el puesto {n} de {total}.',
  'home.noneVisible': 'No hay bloques a la vista. Elige una plantilla o muestra alguno de abajo.',
  // Nombres de los bloques
  'blk.stats': 'Resumen en números', 'blk.guide': 'Qué puedes hacer', 'blk.waiting': 'Te esperan', 'blk.agenda': 'Agenda de hoy', 'blk.reminders': 'Recordatorios',
  'blk.tasks': 'Tus tareas', 'blk.recent': 'Actividad reciente', 'blk.mentions': 'Menciones recientes', 'blk.pinned': 'Fijados', 'blk.calls': 'Llamadas',
  'blk.mail': 'Correos por responder', 'blk.whatsapp': 'WhatsApp sin leer', 'blk.favorites': 'Accesos rápidos', 'blk.note': 'Nota rápida',
  // Bloques nuevos
  'pinned.empty': 'Fija un chat desde su menú (clic derecho › Fijar) y aparece aquí.',
  'calls.none': 'Sin llamadas en curso ni recientes.', 'calls.recentTitle': 'Recientes', 'calls.join': 'Entrar', 'calls.open': 'Llamadas ›', 'calls.missed': 'Perdida',
  'mail.pendingEmpty': 'Nada por responder. Los correos que lleves a un chat quedan aquí hasta que alguien responda.',
  'mail.inboxUnread': '{n} sin leer en tu bandeja', 'mail.open': 'Correo ›', 'mail.notConnected': 'Conecta Gmail u Outlook para ver aquí lo que falta responder.',
  'wa.none': 'Sin mensajes de WhatsApp por leer.', 'wa.notConnected': 'Conecta tu WhatsApp para ver aquí los chats sin leer.', 'wa.open': 'WhatsApp ›',
  'fav.empty': 'Elige tus chats favoritos para abrirlos de un toque.', 'fav.edit': 'Elegir chats', 'fav.pick': 'Accesos rápidos', 'fav.pickHint': 'Marca hasta 12 chats. Si no eliges ninguno, van los fijados y los más activos.',
  'fav.auto': 'Fijados y más activos', 'fav.search': 'Buscar un chat',
  'note.ph': 'Apunta algo para ti. Solo se guarda en este dispositivo.', 'note.saved': 'Guardada', 'note.clear': 'Borrar',
  'stats.compactHint': 'Compactas',
  // Guía
  'guide.title': 'Qué puedes hacer en chaggu', 'guide.progress': '{n} de {total} descubiertas', 'guide.all': 'Ver las {n}', 'guide.less': 'Ver menos',
  'guide.dismiss': 'Descartar', 'guide.restore': 'Mostrar las descartadas ({n})', 'guide.used': 'Ya lo usas', 'guide.allDone': '¡Ya conoces todo lo básico! Puedes ocultar este bloque en Personalizar.',
  'guide.call.t': 'Llamada con enlace', 'guide.call.d': 'Llama a un chat y comparte 🔗 un enlace para invitados sin cuenta.', 'guide.call.a': 'Nueva llamada',
  'guide.panes.t': 'Paneles en paralelo', 'guide.panes.d': 'Hasta {n} chats a la vez: arrastra chats, correo, WhatsApp o tareas al lado.', 'guide.panes.a': 'Abrir dos chats',
  'guide.whatsapp.t': 'Conectar WhatsApp', 'guide.whatsapp.d': 'Tus grupos de WhatsApp ordenados y llevados a un chat con un clic.', 'guide.whatsapp.a': 'Conectar',
  'guide.mail.t': 'Conectar correo', 'guide.mail.d': 'Gmail u Outlook: lleva un correo al chat y respóndelo en equipo.', 'guide.mail.a': 'Conectar',
  'guide.task.t': 'Tarea desde un mensaje', 'guide.task.d': 'En cualquier mensaje: menú › Crear tarea, con responsable y fecha.', 'guide.task.a': 'Crear tarea',
  'guide.topics.t': 'Temas en un chat', 'guide.topics.d': 'Separa un grupo en temas (Pagos, Legal…) sin abrir más grupos.', 'guide.topics.a': 'Ir a un grupo',
  'guide.gg.t': 'gg, tu asistente', 'guide.gg.d': 'Pídele resúmenes o tareas; o escribe @gg en cualquier chat.', 'guide.gg.a': 'Hablar con gg',
  'guide.invite.t': 'Invita a tu equipo', 'guide.invite.d': 'Suma colegas de tu empresa o invita a otra empresa a un espacio.', 'guide.invite.a': 'Invitar',
  'guide.dark.t': 'Modo oscuro', 'guide.dark.d': 'Automático, claro u oscuro; también en Ajustes.', 'guide.dark.a': 'Probar oscuro', 'guide.dark.aLight': 'Volver a claro',
  'guide.shortcuts.t': 'Atajos de teclado', 'guide.shortcuts.d': '{k} mensaje nuevo, {f} buscar y más.', 'guide.shortcuts.a': 'Ver atajos',
  'guide.topicsHint': 'Toca «＋ Tema» sobre los mensajes para crear el primero.', 'guide.panesHint': 'Arrastra otro chat de la lista al área del chat para sumar paneles.', 'guide.panesNarrow': 'Los paneles se ven en ventanas desde 860 px de ancho.',
  'keys.title': 'Atajos de teclado', 'keys.new': 'Mensaje nuevo', 'keys.find': 'Buscar en el chat (o chats y personas)', 'keys.findAll': 'Buscar chats, grupos y personas',
  'keys.bold': 'Negrita / cursiva / tachado al escribir', 'keys.send': 'Enviar', 'keys.newline': 'Nueva línea', 'keys.close': 'Cerrar un diálogo o menú', 'keys.home': 'En Personalizar: mover el bloque seleccionado',
};
type Key = keyof typeof es;
const en: Record<Key, string> = {
  'home.customize': 'Customize', 'home.done': 'Done', 'home.editing': 'Customizing your home',
  'home.editHint': 'Drag blocks to reorder them, or select one and use the arrow keys. Changes save automatically on this device.',
  'home.templates': 'Templates', 'home.reset': 'Reset to default', 'home.resetDone': 'Home reset',
  'home.tpl.default': 'Default', 'home.tpl.focus': 'Focus', 'home.tpl.manager': 'Manager', 'home.tpl.support': 'Support', 'home.tpl.custom': 'Custom',
  'home.tpl.default.d': 'Everything as usual plus the guide', 'home.tpl.focus.d': 'Only waiting on you and your tasks', 'home.tpl.manager.d': 'Numbers, mentions and calendar', 'home.tpl.support.d': 'Email, WhatsApp and waiting on you',
  'home.blocks': 'Blocks', 'home.hidden': 'Hidden', 'home.show': 'Show', 'home.hide': 'Hide', 'home.add': '＋ {name}',
  'home.narrow': 'Narrow', 'home.wide': 'Wide', 'home.moveUp': 'Move up', 'home.moveDown': 'Move down', 'home.drag': 'Drag to move',
  'home.compact': 'Compact numbers', 'home.big': 'Large numbers',
  'home.grabbed': '{name} selected. Use the arrow keys to move it; Enter or Esc to drop it.', 'home.dropped': '{name} in position {n} of {total}.',
  'home.noneVisible': 'No blocks are showing. Pick a template or show one below.',
  'blk.stats': 'Numbers', 'blk.guide': 'What you can do', 'blk.waiting': 'Waiting on you', 'blk.agenda': 'Today’s calendar', 'blk.reminders': 'Reminders',
  'blk.tasks': 'Your tasks', 'blk.recent': 'Recent activity', 'blk.mentions': 'Recent mentions', 'blk.pinned': 'Pinned', 'blk.calls': 'Calls',
  'blk.mail': 'Emails to answer', 'blk.whatsapp': 'Unread WhatsApp', 'blk.favorites': 'Quick access', 'blk.note': 'Quick note',
  'pinned.empty': 'Pin a chat from its menu (right-click › Pin) and it shows up here.',
  'calls.none': 'No ongoing or recent calls.', 'calls.recentTitle': 'Recent', 'calls.join': 'Join', 'calls.open': 'Calls ›', 'calls.missed': 'Missed',
  'mail.pendingEmpty': 'Nothing to answer. Emails you bring to a chat stay here until someone replies.',
  'mail.inboxUnread': '{n} unread in your inbox', 'mail.open': 'Email ›', 'mail.notConnected': 'Connect Gmail or Outlook to see what still needs an answer.',
  'wa.none': 'No unread WhatsApp messages.', 'wa.notConnected': 'Connect your WhatsApp to see unread chats here.', 'wa.open': 'WhatsApp ›',
  'fav.empty': 'Pick your favorite chats to open them in one tap.', 'fav.edit': 'Pick chats', 'fav.pick': 'Quick access', 'fav.pickHint': 'Check up to 12 chats. If you pick none, pinned and most active chats show.',
  'fav.auto': 'Pinned and most active', 'fav.search': 'Search a chat',
  'note.ph': 'Jot something down for yourself. It is only saved on this device.', 'note.saved': 'Saved', 'note.clear': 'Clear',
  'stats.compactHint': 'Compact',
  'guide.title': 'What you can do in chaggu', 'guide.progress': '{n} of {total} discovered', 'guide.all': 'See all {n}', 'guide.less': 'See less',
  'guide.dismiss': 'Dismiss', 'guide.restore': 'Show dismissed ({n})', 'guide.used': 'Already using it', 'guide.allDone': 'You know all the basics! You can hide this block in Customize.',
  'guide.call.t': 'Call with a link', 'guide.call.d': 'Call a chat and share 🔗 a link for guests without an account.', 'guide.call.a': 'New call',
  'guide.panes.t': 'Side-by-side panes', 'guide.panes.d': 'Up to {n} chats at once: drag chats, email, WhatsApp or tasks alongside.', 'guide.panes.a': 'Open two chats',
  'guide.whatsapp.t': 'Connect WhatsApp', 'guide.whatsapp.d': 'Your WhatsApp groups sorted, and brought into a chat in one click.', 'guide.whatsapp.a': 'Connect',
  'guide.mail.t': 'Connect email', 'guide.mail.d': 'Gmail or Outlook: bring an email to a chat and answer it as a team.', 'guide.mail.a': 'Connect',
  'guide.task.t': 'Task from a message', 'guide.task.d': 'On any message: menu › Create task, with an owner and a due date.', 'guide.task.a': 'Create task',
  'guide.topics.t': 'Topics in a chat', 'guide.topics.d': 'Split a group into topics (Payments, Legal…) without more groups.', 'guide.topics.a': 'Go to a group',
  'guide.gg.t': 'gg, your assistant', 'guide.gg.d': 'Ask for summaries or tasks; or type @gg in any chat.', 'guide.gg.a': 'Talk to gg',
  'guide.invite.t': 'Invite your team', 'guide.invite.d': 'Add colleagues from your company or invite another company to a space.', 'guide.invite.a': 'Invite',
  'guide.dark.t': 'Dark mode', 'guide.dark.d': 'Automatic, light or dark; also in Settings.', 'guide.dark.a': 'Try dark', 'guide.dark.aLight': 'Back to light',
  'guide.shortcuts.t': 'Keyboard shortcuts', 'guide.shortcuts.d': '{k} new message, {f} search and more.', 'guide.shortcuts.a': 'See shortcuts',
  'guide.topicsHint': 'Tap «＋ Topic» above the messages to create the first one.', 'guide.panesHint': 'Drag another chat from the list onto the chat area to add panes.', 'guide.panesNarrow': 'Panes show in windows at least 860 px wide.',
  'keys.title': 'Keyboard shortcuts', 'keys.new': 'New message', 'keys.find': 'Search in the chat (or chats and people)', 'keys.findAll': 'Search chats, groups and people',
  'keys.bold': 'Bold / italic / strikethrough while typing', 'keys.send': 'Send', 'keys.newline': 'New line', 'keys.close': 'Close a dialog or menu', 'keys.home': 'In Customize: move the selected block',
};
const dicts = { es, en };
export type HomeKey = Key;
export function ht(key: Key, vars: Record<string, string | number> = {}): string {
  const s = dicts[getLang()][key] ?? es[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}
