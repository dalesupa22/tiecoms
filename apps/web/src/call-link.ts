/**
 * «Nueva llamada» con enlace (docs/LLAMADAS.md › Nueva llamada): textos y enlaces para compartir la llamada y la
 * validación del correo del invitado. Módulo puro (sin React ni Chime) para probarlo.
 */
import { EMAIL_SHAPE } from '@tiecoms/contracts';
import { t } from './i18n.ts';

/** Texto sugerido para mandar con el enlace. */
export const inviteText = (url: string) => t('share.linkText', { url });
/** WhatsApp con el texto listo (la persona elige a quién). */
export const whatsappHref = (url: string) => `https://wa.me/?text=${encodeURIComponent(inviteText(url))}`;
/** Correo nuevo con asunto y cuerpo listos. */
export const mailtoHref = (url: string) => `mailto:?subject=${encodeURIComponent(t('share.emailSubject'))}&body=${encodeURIComponent(inviteText(url))}`;
/** Correo del invitado con forma válida (la misma regla que el servidor: EMAIL_SHAPE, en minúsculas, ≤ 254). */
export const validGuestEmail = (email: string) => { const m = email.trim().toLowerCase(); return m.length <= 254 && EMAIL_SHAPE.test(m); };
