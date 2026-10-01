import { locale } from '../i18n.ts';

const copy = {
  es: {
    create: 'Crear documento', name: 'Nombre', format: 'Formato', content: 'Contenido', privacy: 'Privacidad del archivo',
    private: 'Privado · solo tú', shared: 'Compartido con este grupo o chat', audience: 'Solo los miembros actuales de este espacio pueden ver los archivos compartidos. Los privados solo los ves tú.',
    personal: 'Tus archivos personales son privados. Para compartir, elige un grupo o chat y sube el archivo allí.',
    docHint: 'Escribe el contenido. Podrás descargar el documento después de guardarlo.',
    sheetHint: 'Una fila por línea y columnas separadas por comas o tabulaciones. Usa comillas para textos con comas.',
    slideHint: 'La primera línea de cada diapositiva es su título. Separa las diapositivas con una línea que contenga --- .',
    created: 'Documento creado', save: 'Crear y guardar', sharedBadge: 'Compartido', privateBadge: 'Privado',
    makePrivate: 'Hacer privado', makeShared: 'Compartir con este grupo o chat', changed: 'Privacidad actualizada',
    spaces: 'Espacios', chats: 'Grupos y chats', noUpload: 'Tienes acceso de lectura a esta conversación.',
    exportHint: 'Word, Excel, PDF y PowerPoint',
  },
  en: {
    create: 'Create document', name: 'Name', format: 'Format', content: 'Content', privacy: 'File privacy',
    private: 'Private · only you', shared: 'Shared with this group or chat', audience: 'Only current members of this space can see shared files. Private files are visible only to you.',
    personal: 'Your personal files are private. To share a file, select a group or chat and upload it there.',
    docHint: 'Write the content. You can download your document after saving it.',
    sheetHint: 'One row per line, with comma- or tab-separated columns. Quote text containing commas.',
    slideHint: 'The first line of each slide is its title. Separate slides with a line containing --- .',
    created: 'Document created', save: 'Create and save', sharedBadge: 'Shared', privateBadge: 'Private',
    makePrivate: 'Make private', makeShared: 'Share with this group or chat', changed: 'Privacy updated',
    spaces: 'Spaces', chats: 'Groups and chats', noUpload: 'You have read-only access to this conversation.',
    exportHint: 'Word, Excel, PDF and PowerPoint',
  },
};
export const filesCopy = () => copy[locale().startsWith('es') ? 'es' : 'en'];
