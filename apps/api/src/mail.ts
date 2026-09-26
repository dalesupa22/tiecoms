/**
 * Correo saliente con la API transaccional de Brevo (BREVO_API_KEY). El remitente
 * es MAIL_FROM (admin@tiecoms.com), que debe estar verificado en Brevo junto con
 * el dominio (DKIM). Sin llave, `mailEnabled()` es falso y nadie intenta enviar.
 */
import { config } from './config.ts';
import { ApiError } from './errors.ts';

const BREVO_URL = process.env.BREVO_API_URL ?? 'https://api.brevo.com/v3/smtp/email';

export const mailEnabled = () => !!process.env.BREVO_API_KEY;

export interface Mail {
  to: { email: string; name?: string }[];
  subject: string;
  html: string;
  text: string;
  replyTo?: { email: string; name?: string };
  tags?: string[];
}

/** Envía un correo y devuelve el messageId de Brevo. */
export async function sendMail(m: Mail): Promise<string> {
  const key = process.env.BREVO_API_KEY;
  if (!key) throw new ApiError(503, 'mail_unavailable', 'El envío de correos aún no está configurado');
  const res = await fetch(BREVO_URL, {
    method: 'POST',
    headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: config.mailFrom, name: config.mailFromName },
      to: m.to, subject: m.subject, htmlContent: m.html, textContent: m.text,
      ...(m.replyTo ? { replyTo: m.replyTo } : {}),
      ...(m.tags?.length ? { tags: m.tags } : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => ({})) as { messageId?: string; code?: string; message?: string };
  if (!res.ok) throw new ApiError(502, 'mail_failed', `Brevo respondió ${res.status}: ${body.code ?? ''} ${body.message ?? ''}`.trim());
  return body.messageId ?? '';
}

export type MailResult = { status: 'sent' | 'failed' | 'skipped'; error?: string };

/**
 * Dominios a los que nunca se envía: cuentas demo y de pruebas (un rebote por cada
 * resiembra dañaría la reputación del remitente).
 */
const suppressed = (process.env.MAIL_SUPPRESS_DOMAINS ?? 'demo.tiecoms.com,example.com,example.org,example.net')
  .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
const isSuppressed = (email: string) => {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  return suppressed.some((d) => domain === d || domain.endsWith(`.${d}`));
};

/** Envío que nunca rompe el flujo que lo llama: registra el fallo y lo devuelve. */
export async function trySendMail(m: Mail): Promise<MailResult> {
  if (!mailEnabled()) return { status: 'skipped', error: 'mail_unavailable' };
  if (m.to.every((r) => isSuppressed(r.email))) return { status: 'skipped', error: 'suppressed' };
  try {
    await sendMail({ ...m, to: m.to.filter((r) => !isSuppressed(r.email)) });
    return { status: 'sent' };
  } catch (e: any) {
    console.log(`[mail] no se pudo enviar "${m.subject}" (${m.tags?.join(',') ?? ''}): ${e?.message}`);
    return { status: 'failed', error: String(e?.message ?? e).slice(0, 500) };
  }
}

// ---------- Plantillas ----------

export type MailLang = 'es' | 'en';

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

function layout(lang: MailLang, title: string, paragraphs: string[], cta: { label: string; url: string }, footer: string) {
  const ps = paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#1f2937">${p}</p>`).join('');
  return `<!doctype html><html lang="${lang}"><body style="margin:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;padding:32px">
<tr><td style="font-size:18px;font-weight:700;color:#111827;padding-bottom:20px">TieComs</td></tr>
<tr><td><h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#111827">${title}</h1>${ps}
<p style="margin:24px 0"><a href="${esc(cta.url)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:8px">${cta.label}</a></p>
<p style="margin:0;font-size:12px;line-height:1.5;color:#6b7280">${footer}<br><a href="${esc(cta.url)}" style="color:#6b7280;word-break:break-all">${esc(cta.url)}</a></p>
</td></tr></table></td></tr></table></body></html>`;
}

/** Invitación a una empresa (org) o a un espacio compartido (workspace). */
export function invitationMail(p: {
  lang: MailLang; to: string; inviterName: string; inviterEmail: string; targetName: string;
  kind: 'org' | 'workspace'; url: string; expiresAt: Date;
}): Mail {
  const en = p.lang === 'en';
  const who = esc(p.inviterName), target = esc(p.targetName);
  const until = p.expiresAt.toLocaleDateString(en ? 'en-US' : 'es-CO', { day: 'numeric', month: 'long', year: 'numeric' });
  const subject = en
    ? `${p.inviterName} invited you to ${p.targetName} on TieComs`
    : `${p.inviterName} te invitó a ${p.targetName} en TieComs`;
  const title = en ? `Join ${target}` : `Únete a ${target}`;
  const lead = p.kind === 'org'
    ? (en ? `<b>${who}</b> invited you to create your TieComs account inside <b>${target}</b>.`
      : `<b>${who}</b> te invitó a crear tu cuenta de TieComs dentro de <b>${target}</b>.`)
    : (en ? `<b>${who}</b> invited you to the shared space <b>${target}</b> on TieComs, where teams from different companies work together.`
      : `<b>${who}</b> te invitó al espacio compartido <b>${target}</b> en TieComs, donde trabajan juntos equipos de distintas empresas.`);
  const note = en ? `The link is single-use and expires on ${until}.` : `El enlace es de un solo uso y vence el ${until}.`;
  const footer = en ? `If you weren't expecting this invitation, you can ignore this email. If the button doesn't work, copy this link:`
    : `Si no esperabas esta invitación, puedes ignorar este correo. Si el botón no funciona, copia este enlace:`;
  const label = en ? 'Accept invitation' : 'Aceptar invitación';
  const text = [
    en ? `${p.inviterName} invited you to ${p.targetName} on TieComs.` : `${p.inviterName} te invitó a ${p.targetName} en TieComs.`,
    '', `${label}: ${p.url}`, '', note,
  ].join('\n');
  return {
    to: [{ email: p.to }], subject, text,
    html: layout(p.lang, title, [lead, note], { label, url: p.url }, footer),
    replyTo: { email: p.inviterEmail, name: p.inviterName },
    tags: [p.kind === 'org' ? 'org-invitation' : 'workspace-invitation'],
  };
}

/** Resumen semanal de enlaces (opt-in en el perfil): lo que compartieron otros y mi «Ver después» pendiente. */
export function linkDigestMail(p: {
  lang: MailLang; to: string; name: string; appUrl: string;
  total: number; byConversation: { conversationId: string; name: string; count: number }[];
  pending: { title: string; url: string; conversationName: string }[]; pendingCount: number;
}): Mail {
  const en = p.lang === 'en';
  const first = esc(p.name.split(' ')[0] ?? p.name);
  const subject = en
    ? `${p.total} ${p.total === 1 ? 'link' : 'links'} shared this week${p.pendingCount ? ` · ${p.pendingCount} saved to watch` : ''}`
    : `${p.total} ${p.total === 1 ? 'enlace compartido' : 'enlaces compartidos'} esta semana${p.pendingCount ? ` · ${p.pendingCount} por ver` : ''}`;
  const title = en ? `Your links of the week, ${first}` : `Tus enlaces de la semana, ${first}`;
  const convs = p.byConversation.map((c) => `• <b>${esc(c.name)}</b>: ${c.count}`).join('<br>');
  const pend = p.pending.map((l) => `• <a href="${esc(l.url)}" style="color:#111827">${esc(l.title.slice(0, 120))}</a> <span style="color:#6b7280">(${esc(l.conversationName)})</span>`).join('<br>');
  const paragraphs = [
    p.total ? (en ? `Your teams shared <b>${p.total}</b> links in the last 7 days:` : `Tus equipos compartieron <b>${p.total}</b> enlaces en los últimos 7 días:`) + `<br>${convs}` : '',
    p.pendingCount ? (en ? `You have <b>${p.pendingCount}</b> saved to watch later:` : `Tienes <b>${p.pendingCount}</b> ${p.pendingCount === 1 ? 'guardado' : 'guardados'} para ver después:`) + `<br>${pend}` : '',
  ].filter(Boolean);
  const url = `${p.appUrl.replace(/\/$/, '')}/ver-despues`;
  const label = en ? 'Open Watch later' : 'Abrir «Ver después»';
  const footer = en ? 'You get this email because you turned on the weekly link digest in your TieComs profile. Turn it off there anytime.'
    : 'Te llega porque activaste el resumen semanal de enlaces en tu perfil de TieComs. Lo apagas ahí cuando quieras.';
  const text = [
    title, '',
    ...(p.total ? [en ? `${p.total} links shared:` : `${p.total} ${p.total === 1 ? 'enlace compartido' : 'enlaces compartidos'}:`, ...p.byConversation.map((c) => `- ${c.name}: ${c.count}`), ''] : []),
    ...(p.pendingCount ? [en ? `${p.pendingCount} saved to watch later:` : `${p.pendingCount} ${p.pendingCount === 1 ? 'guardado' : 'guardados'} para ver después:`, ...p.pending.map((l) => `- ${l.title} ${l.url}`), ''] : []),
    `${label}: ${url}`,
  ].join('\n');
  return { to: [{ email: p.to, name: p.name }], subject, text, html: layout(p.lang, title, paragraphs, { label, url }, footer), tags: ['link-digest'] };
}
