/** Pines de conversaciones de correo (migr. 096, MailPinDTO). Cada persona fija lo suyo; nada se comparte. */
import type { z } from 'zod';
import type { MailPinDTO, MailPinInput } from '@tiecoms/contracts';
import { pool } from '../db.ts';

const toDTO = (r: any): MailPinDTO => ({
  provider: r.provider, threadKey: r.thread_key, messageId: r.message_id, subject: r.subject ?? '',
  from: r.from_email ? { name: r.from_name ?? null, email: r.from_email } : null, date: r.last_at ? new Date(r.last_at).toISOString() : null,
  mainPinnedAt: r.main_pinned_at ? new Date(r.main_pinned_at).toISOString() : null, mailPinnedAt: r.mail_pinned_at ? new Date(r.mail_pinned_at).toISOString() : null,
});

export async function listPins(userId: string): Promise<MailPinDTO[]> {
  const { rows } = await pool.query('SELECT * FROM mail_pins WHERE user_id = $1 ORDER BY GREATEST(main_pinned_at, mail_pinned_at) DESC LIMIT 200', [userId]);
  return rows.map(toDTO);
}

/** Fija o quita cada pin; si no queda ninguno, la fila se borra. Devuelve la lista completa. */
export async function setPin(userId: string, input: z.infer<typeof MailPinInput>) {
  const flag = (v: boolean | undefined, col: string) => (v === undefined ? col : v ? `COALESCE(${col}, now())` : 'NULL');
  await pool.query(
    `INSERT INTO mail_pins (user_id, provider, thread_key, message_id, subject, from_name, from_email, last_at, main_pinned_at, mail_pinned_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $9::boolean THEN now() END, CASE WHEN $10::boolean THEN now() END)
     ON CONFLICT (user_id, provider, thread_key) DO UPDATE SET message_id = EXCLUDED.message_id, subject = EXCLUDED.subject,
       from_name = EXCLUDED.from_name, from_email = EXCLUDED.from_email, last_at = COALESCE(EXCLUDED.last_at, mail_pins.last_at),
       main_pinned_at = ${flag(input.main, 'mail_pins.main_pinned_at')}, mail_pinned_at = ${flag(input.mail, 'mail_pins.mail_pinned_at')}, updated_at = now()`,
    [userId, input.provider, input.threadKey, input.messageId, input.subject.slice(0, 300), input.from?.name?.slice(0, 200) ?? null,
      input.from?.email?.toLowerCase().slice(0, 254) ?? null, input.date ?? null, input.main === true, input.mail === true]);
  await pool.query('DELETE FROM mail_pins WHERE user_id = $1 AND provider = $2 AND thread_key = $3 AND main_pinned_at IS NULL AND mail_pinned_at IS NULL', [userId, input.provider, input.threadKey]);
  return { pins: await listPins(userId) };
}
