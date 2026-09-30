/**
 * Correo saliente con la API transaccional de Brevo (BREVO_API_KEY). El remitente
 * es MAIL_FROM (admin@chaggu.com), que debe estar verificado en Brevo junto con
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
const suppressed = (process.env.MAIL_SUPPRESS_DOMAINS ?? 'demo.tiecoms.com,demo.chaggu.com,example.com,example.org,example.net')
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
<tr><td style="font-size:18px;font-weight:700;color:#111827;padding-bottom:20px">chaggu</td></tr>
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
    ? `${p.inviterName} invited you to ${p.targetName} on chaggu`
    : `${p.inviterName} te invitó a ${p.targetName} en chaggu`;
  const title = en ? `Join ${target}` : `Únete a ${target}`;
  const lead = p.kind === 'org'
    ? (en ? `<b>${who}</b> invited you to create your chaggu account inside <b>${target}</b>.`
      : `<b>${who}</b> te invitó a crear tu cuenta de chaggu dentro de <b>${target}</b>.`)
    : (en ? `<b>${who}</b> invited you to the shared space <b>${target}</b> on chaggu, where teams from different companies work together.`
      : `<b>${who}</b> te invitó al espacio compartido <b>${target}</b> en chaggu, donde trabajan juntos equipos de distintas empresas.`);
  const note = en ? `The link is single-use and expires on ${until}.` : `El enlace es de un solo uso y vence el ${until}.`;
  const footer = en ? `If you weren't expecting this invitation, you can ignore this email. If the button doesn't work, copy this link:`
    : `Si no esperabas esta invitación, puedes ignorar este correo. Si el botón no funciona, copia este enlace:`;
  const label = en ? 'Accept invitation' : 'Aceptar invitación';
  const text = [
    en ? `${p.inviterName} invited you to ${p.targetName} on chaggu.` : `${p.inviterName} te invitó a ${p.targetName} en chaggu.`,
    '', `${label}: ${p.url}`, '', note,
  ].join('\n');
  return {
    to: [{ email: p.to }], subject, text,
    html: layout(p.lang, title, [lead, note], { label, url: p.url }, footer),
    replyTo: { email: p.inviterEmail, name: p.inviterName },
    tags: [p.kind === 'org' ? 'org-invitation' : 'workspace-invitation'],
  };
}

/** Confirmar el correo al crear la cuenta con un correo corporativo (docs/REGISTRO.md). */
export function signupConfirmMail(p: { lang: MailLang; to: string; name: string; url: string; orgName: string | null; joining: boolean }): Mail {
  const en = p.lang === 'en';
  const first = esc(p.name.split(' ')[0] ?? p.name), org = p.orgName ? esc(p.orgName) : null;
  const subject = en
    ? (p.joining && p.orgName ? `Confirm your email to join ${p.orgName} on chaggu` : 'Confirm your email to create your chaggu account')
    : (p.joining && p.orgName ? `Confirma tu correo para unirte a ${p.orgName} en chaggu` : 'Confirma tu correo para crear tu cuenta de chaggu');
  const title = en ? `Hi ${first}, confirm your email` : `Hola ${first}, confirma tu correo`;
  const lead = p.joining && org
    ? (en ? `<b>${org}</b> is already on chaggu. Confirm that this address is yours and you will join your team right away.`
      : `<b>${org}</b> ya está en chaggu. Confirma que este correo es tuyo y entras de una con tu equipo.`)
    : (en ? `Confirm that this address is yours to create ${org ? `<b>${org}</b>` : 'your company'} on chaggu. Colleagues with your company email will join it later.`
      : `Confirma que este correo es tuyo para crear ${org ? `<b>${org}</b>` : 'tu empresa'} en chaggu. Tus colegas con el correo de la empresa se sumarán después.`);
  const note = en ? 'The link is single-use and expires in 48 hours.' : 'El enlace es de un solo uso y vence en 48 horas.';
  const footer = en ? `If you didn't try to create an account, ignore this email. If the button doesn't work, copy this link:`
    : 'Si no intentaste crear una cuenta, ignora este correo. Si el botón no funciona, copia este enlace:';
  const label = en ? 'Confirm and enter' : 'Confirmar y entrar';
  return {
    to: [{ email: p.to, name: p.name }], subject,
    text: [subject, '', `${label}: ${p.url}`, '', note].join('\n'),
    html: layout(p.lang, title, [lead, note], { label, url: p.url }, footer),
    tags: ['signup-confirm'],
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
  const footer = en ? 'You get this email because you turned on the weekly link digest in your chaggu profile. Turn it off there anytime.'
    : 'Te llega porque activaste el resumen semanal de enlaces en tu perfil de chaggu. Lo apagas ahí cuando quieras.';
  const text = [
    title, '',
    ...(p.total ? [en ? `${p.total} links shared:` : `${p.total} ${p.total === 1 ? 'enlace compartido' : 'enlaces compartidos'}:`, ...p.byConversation.map((c) => `- ${c.name}: ${c.count}`), ''] : []),
    ...(p.pendingCount ? [en ? `${p.pendingCount} saved to watch later:` : `${p.pendingCount} ${p.pendingCount === 1 ? 'guardado' : 'guardados'} para ver después:`, ...p.pending.map((l) => `- ${l.title} ${l.url}`), ''] : []),
    `${label}: ${url}`,
  ].join('\n');
  return { to: [{ email: p.to, name: p.name }], subject, text, html: layout(p.lang, title, paragraphs, { label, url }, footer), tags: ['link-digest'] };
}

/** Citas por enlace (docs/CITAS.md): confirmación, cambio y cancelación para quien reservó. Diseño propio, con tarjeta de fecha. */
export function bookingMail(p: {
  kind: 'confirmed' | 'rescheduled' | 'cancelled'; lang: MailLang; to: string; guestName: string; title: string; hosts: string[];
  startsAt: Date; endsAt: Date; timezone: string; joinUrl: string | null; manageUrl: string; pageUrl: string;
}): Mail {
  const en = p.lang === 'en';
  const first = esc(p.guestName.split(' ')[0] ?? p.guestName);
  const loc = en ? 'en-US' : 'es-CO';
  const part = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(loc, { timeZone: p.timezone, ...o }).format(p.startsAt);
  const when = new Intl.DateTimeFormat(loc, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: p.timezone, timeZoneName: 'short' }).format(p.startsAt);
  const dayBig = part({ day: 'numeric' }), monthSmall = part({ month: 'short' }).replace('.', '').toUpperCase();
  const weekday = part({ weekday: 'long' });
  const range = `${part({ hour: 'numeric', minute: '2-digit' })} – ${new Intl.DateTimeFormat(loc, { hour: 'numeric', minute: '2-digit', timeZone: p.timezone, timeZoneName: 'short' }).format(p.endsAt)}`;
  const mins = Math.round((p.endsAt.getTime() - p.startsAt.getTime()) / 60_000);
  const who = p.hosts.join(', ');
  const cancelled = p.kind === 'cancelled';
  const subject = {
    confirmed: en ? `✓ Confirmed: ${p.title} · ${when}` : `✓ Confirmada: ${p.title} · ${when}`,
    rescheduled: en ? `🔁 New time: ${p.title} · ${when}` : `🔁 Nuevo horario: ${p.title} · ${when}`,
    cancelled: en ? `Cancelled: ${p.title}` : `Cancelada: ${p.title}`,
  }[p.kind];
  const headline = {
    confirmed: en ? `You're in, ${first}! 🎉` : `¡Quedó agendada, ${first}! 🎉`,
    rescheduled: en ? `New time, ${first} 🔁` : `Nuevo horario, ${first} 🔁`,
    cancelled: en ? `Your booking was cancelled, ${first}` : `Tu cita fue cancelada, ${first}`,
  }[p.kind];
  const sub = {
    confirmed: en ? `We saved your spot with ${esc(who)}. A calendar invite is on its way too.` : `Te guardamos el cupo con ${esc(who)}. También te llega la invitación a tu calendario.`,
    rescheduled: en ? `Your meeting with ${esc(who)} moved. Here's the updated time.` : `Tu reunión con ${esc(who)} cambió de horario. Aquí está el nuevo.`,
    cancelled: en ? 'No worries — you can pick another time whenever you want.' : 'Sin problema: puedes elegir otro horario cuando quieras.',
  }[p.kind];
  const fmtZ = (d: Date) => d.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const gcal = `https://calendar.google.com/calendar/render?${new URLSearchParams({ action: 'TEMPLATE', text: `${p.title} · ${who}`, dates: `${fmtZ(p.startsAt)}/${fmtZ(p.endsAt)}`, details: p.joinUrl ?? p.pageUrl, location: p.joinUrl ?? '' })}`;
  const btn = (label: string, url: string, primary = true) =>
    `<a href="${esc(url)}" style="display:inline-block;margin:0 8px 10px 0;padding:14px 26px;border-radius:12px;font-weight:700;font-size:15px;text-decoration:none;${primary ? 'background:#FF5A36;color:#17161F' : 'background:#ffffff;color:#17161F;border:2px solid #17161F;padding:12px 24px'}">${label}</a>`;
  const card = cancelled ? '' : `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0;background:#faf7f2;border-radius:16px"><tr>
<td width="92" align="center" style="padding:18px 0 18px 18px"><div style="background:#17161F;border-radius:14px;width:76px;padding:8px 0;text-align:center"><div style="font-size:12px;letter-spacing:1.5px;color:#FF5A36;font-weight:700">${esc(monthSmall)}</div><div style="font-size:34px;line-height:38px;color:#ffffff;font-weight:800">${esc(dayBig)}</div></div></td>
<td style="padding:18px 20px"><div style="font-size:17px;font-weight:800;color:#17161F">${esc(p.title)}</div>
<div style="font-size:14px;color:#4b4a55;margin-top:4px;text-transform:capitalize">${esc(weekday)} · ${esc(range)}</div>
<div style="font-size:13px;color:#6b6a75;margin-top:2px">${en ? `${mins} min · with` : `${mins} min · con`} ${esc(who)}</div></td></tr></table>`;
  const buttons = cancelled
    ? btn(en ? 'Book another time' : 'Reservar otro horario', p.pageUrl)
    : [p.joinUrl ? btn(en ? '🎥 Join the video call' : '🎥 Entrar a la videollamada', p.joinUrl) : '', btn(en ? 'Add to calendar' : 'Agregar al calendario', gcal, !p.joinUrl)].join('');
  const manage = cancelled ? '' : `<p style="margin:6px 0 0;font-size:14px;color:#4b4a55">${en ? 'Plans changed?' : '¿Cambió el plan?'} <a href="${esc(p.manageUrl)}" style="color:#C73A1A;font-weight:700">${en ? 'Reschedule or cancel' : 'Cambiar horario o cancelar'}</a></p>`;
  const html = `<!doctype html><html lang="${p.lang}"><body style="margin:0;background:#efece6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(when)} · ${esc(who)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#efece6;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:20px;overflow:hidden">
<tr><td style="background:#17161F;padding:22px 32px"><span style="font-size:24px;font-weight:800;color:#ffffff;letter-spacing:-0.5px">chaggu</span><span style="font-size:24px;font-weight:800;color:#FF5A36">.</span></td></tr>
<tr><td style="padding:32px 32px 28px">
<h1 style="margin:0 0 8px;font-size:26px;line-height:1.2;color:#17161F;letter-spacing:-0.5px">${headline}</h1>
<p style="margin:0;font-size:16px;line-height:1.55;color:#4b4a55">${sub}</p>${card}
<div>${buttons}</div>${manage}
</td></tr>
<tr><td style="padding:18px 32px 26px;border-top:1px solid #efece6;font-size:12px;line-height:1.6;color:#8a8994">${en ? 'Booked through' : 'Reservada con'} <a href="https://www.chaggu.com" style="color:#8a8994"><b>chaggu</b></a> — ${en ? 'where teams from different companies get things done together.' : 'donde equipos de distintas empresas trabajan juntos.'}<br>${en ? 'You got this because someone used your email to book a time.' : 'Te llega porque alguien usó tu correo para reservar este horario.'}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [headline.replace(/<[^>]+>/g, ''), '', p.title, `${en ? 'With' : 'Con'} ${who}`, when, ...(p.joinUrl && !cancelled ? ['', `${en ? 'Video call' : 'Videollamada'}: ${p.joinUrl}`] : []), '',
    cancelled ? `${en ? 'Book another time' : 'Reservar otro horario'}: ${p.pageUrl}` : `${en ? 'Reschedule or cancel' : 'Cambiar o cancelar'}: ${p.manageUrl}`].join('\n');
  return { to: [{ email: p.to, name: p.guestName }], subject, text, html, tags: [`booking-${p.kind}`] };
}
