import { downloadPendingWaMedia } from './modules/wa-media-bridge.ts';
/**
 * Puente de WhatsApp: mantiene vivas las cuentas que cada persona conectó.
 *
 * Usa Baileys, que se vincula como «dispositivo vinculado» (igual que WhatsApp
 * Web), así funciona tanto con WhatsApp personal como con WhatsApp Business y
 * lee grupos, chats y mensajes. Lee y nada más, salvo lo que la persona responde desde chaggu en una cuenta
 * con «Responder desde chaggu» activado (wa_outbox). Nunca marca como leído.
 *
 * Un proceso reclama cada cuenta con un lease en la BD (una sesión por cuenta
 * aunque haya varias réplicas). Las credenciales se guardan cifradas en wa_auth.
 */
import { hostname } from 'node:os';
import pino from 'pino';
import makeWASocket, { Browsers, DisconnectReason, fetchLatestWaWebVersion, jidNormalizedUser, makeCacheableSignalKeyStore } from 'baileys';
import { pool,tx } from './db.ts';
import {
  bridgeToTieComs, chatFromWa, dbAuthState, groupRow, msgRow, notifyOwner, organizeAccount, setStatus, skipJid, storeMessages, tsOf,
  upsertChats, upsertContacts, type ChatRow, type MsgRow, type Session,
  storeReaction, aliasOf, rememberSenders, storeAliases,
} from './modules/wa-sync.ts';

const BRIDGE_ID = `${hostname()}:${process.pid}`;
const LEASE_SECONDS = 60;
/** Del historial inicial solo se guarda lo reciente. */
const HISTORY_DAYS = 120;
const logger = pino({ level: process.env.WA_LOG_LEVEL ?? 'error' });

/** Versión de WhatsApp Web que se anuncia; una vieja hace que el servidor cierre antes del QR. */
let waVersion: { v: [number, number, number]; at: number } | null = null;
async function currentVersion() {
  if (!waVersion || Date.now() - waVersion.at > 6 * 3600_000) {
    const r = await fetchLatestWaWebVersion().catch(() => null);
    if (r?.version) waVersion = { v: r.version as [number, number, number], at: Date.now() };
  }
  return waVersion?.v;
}

// ---------- Sesiones ----------
const sessions = new Map<string, Session>();

async function syncGroups(s: Session) {
  if (!s.sock) return;
  try {
    const groups = await s.sock.groupFetchAllParticipating();
    await upsertChats(s, Object.values(groups).map(groupRow));
    // Los participantes traen LID y número: con eso se ponen nombres a los mensajes.
    await storeAliases(s, Object.values(groups).flatMap((g) => g.participants ?? []).map(aliasOf));
    await resolveLids(s);
    notifyOwner(s);
  } catch (e: any) { console.error(`[wa] ${s.id} no pude leer los grupos`, e?.message); }
}

/** Autores que solo conocemos por LID: se le pregunta a Baileys su número (lo guarda al descifrar). */
async function resolveLids(s: Session) {
  const repo = (s.sock as any)?.signalRepository?.lidMapping;
  if (!repo) return;
  const { rows } = await pool.query(
    `SELECT DISTINCT m.author_jid AS lid FROM wa_messages m
      WHERE m.account_id = $1 AND m.author_jid LIKE '%@lid'
        AND NOT EXISTS (SELECT 1 FROM wa_jid_alias a WHERE a.account_id = m.account_id AND a.lid = m.author_jid)
      LIMIT 5000`,
    [s.id],
  );
  const pairs: { lid: string; pn: string | null }[] = [];
  for (const r of rows) pairs.push({ lid: r.lid, pn: await repo.getPNForLID(r.lid).catch(() => null) });
  await storeAliases(s, pairs);
  const found = pairs.filter((p) => p.pn).length;
  if (rows.length) console.log(`[wa] ${s.id} LID resueltos ${found}/${rows.length}`);
}

async function connect(s: Session) {
  const auth = await dbAuthState(s.id);
  s.registered = !!auth.state.creds.registered;
  let pairingRequested = false;
  let qrShown = false;
  let organizeTimer: NodeJS.Timeout | null = null;
  const organizeSoon = () => {
    if (organizeTimer) clearTimeout(organizeTimer);
    organizeTimer = setTimeout(() => void organizeAccount(s).then(() => notifyOwner(s)).catch(() => {}), 5000);
  };

  const version = await currentVersion();
  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: { creds: auth.state.creds, keys: makeCacheableSignalKeyStore(auth.state.keys, logger as any) },
    logger: logger as any,
    // «Desktop» hace que WhatsApp cierre con 428 antes del QR (probado 24-sep-2026); Chrome sí funciona.
    browser: Browsers.macOS('Chrome'),
    syncFullHistory: true,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    shouldIgnoreJid: (jid) => skipJid(jid),
    getMessage: async () => undefined,
  });
  s.sock = sock;
  const cutoff = Date.now() - HISTORY_DAYS * 86400_000;

  sock.ev.on('creds.update', () => void auth.saveCreds().catch((e) => console.error('[wa] no pude guardar credenciales', e.message)));

  sock.ev.on('connection.update', async (u) => {
    if (s.stopping || s.sock !== sock) return;
    try {
      if (u.qr && !s.registered) {
        qrShown = true;
        if (s.pairPhone && !pairingRequested) {
          pairingRequested = true;
          const code = await sock.requestPairingCode(s.pairPhone);
          await setStatus(s.id, { status: 'qr', qr: u.qr, pairing_code: code, last_error: null });
        } else {
          await setStatus(s.id, { status: 'qr', qr: u.qr, last_error: null });
        }
        notifyOwner(s);
      }
      if (u.connection === 'open') {
        s.retries = 0;
        s.registered = true;
        s.me = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
        await setStatus(s.id, {
          status: 'connected', qr: null, pairing_code: null, last_error: null, connected_at: new Date(), last_sync_at: new Date(),
          phone: s.me?.split('@')[0] ?? null, push_name: sock.user?.name ?? sock.user?.notify ?? null, platform: auth.state.creds.platform ?? null,
        });
        notifyOwner(s);
        void syncGroups(s);
      }
      if (u.connection === 'close') {
        const code = (u.lastDisconnect?.error as any)?.output?.statusCode as number | undefined;
        console.log(`[wa] ${s.id} conexión cerrada (${code ?? '?'}: ${u.lastDisconnect?.error?.message ?? ''})`);
        s.sock = null;
        if (code === DisconnectReason.loggedOut) {
          // Se cerró desde el teléfono («Cerrar sesión» en Dispositivos vinculados).
          await pool.query('DELETE FROM wa_auth WHERE account_id = $1', [s.id]);
          await setStatus(s.id, { status: 'logged_out', qr: null, pairing_code: null, lease_owner: null, lease_until: null });
          stopLocal(s);
        } else if (!s.registered && qrShown && code !== DisconnectReason.restartRequired) {
          // Nadie escaneó a tiempo: se deja de intentar hasta que la persona pida otro código.
          await setStatus(s.id, { status: 'expired', qr: null, pairing_code: null, lease_owner: null, lease_until: null });
          stopLocal(s);
        } else {
          s.retries++;
          if (!s.registered && s.retries > 5) { await fail(s, new Error(`WhatsApp cerró la conexión antes de dar el código (${code ?? '?'})`)); return; }
          const wait = code === DisconnectReason.restartRequired ? 0 : Math.min(60_000, 1000 * 2 ** Math.min(s.retries, 6));
          if (code !== DisconnectReason.restartRequired) await setStatus(s.id, { status: 'reconnecting', last_error: `cierre ${code ?? '?'}` });
          setTimeout(() => { if (!s.stopping && sessions.get(s.id) === s) void connect(s).catch((e) => fail(s, e)); }, wait);
        }
        notifyOwner(s);
      }
    } catch (e: any) { console.error(`[wa] ${s.id} connection.update`, e?.message); }
  });

  sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, lidPnMappings, isLatest }) => {
    try {
      await upsertContacts(s, contacts);
      await storeAliases(s, lidPnMappings ?? []);
      await rememberSenders(s, messages);
      await upsertChats(s, chats.map(chatFromWa).filter(Boolean) as ChatRow[]);
      const rows = messages.filter((m) => tsOf(m.messageTimestamp).getTime() >= cutoff).map((m) => msgRow(s, m)).filter(Boolean) as MsgRow[];
      await storeMessages(s, rows, false);
      await setStatus(s.id, { last_sync_at: new Date() });
      organizeSoon();
      notifyOwner(s);
      if (isLatest) { console.log(`[wa] ${s.id} historial recibido`); void resolveLids(s).then(() => notifyOwner(s)).catch(() => {}); }
    } catch (e: any) { console.error(`[wa] ${s.id} historial`, e?.message); }
  });
  sock.ev.on('lid-mapping.update', (m) => void storeAliases(s, [m]).catch(() => {}));
  sock.ev.on('contacts.upsert', (c) => void upsertContacts(s, c).then(organizeSoon).catch(() => {}));
  sock.ev.on('contacts.update', (c) => void upsertContacts(s, c).catch(() => {}));
  sock.ev.on('chats.upsert', (c) => void upsertChats(s, c.map(chatFromWa).filter(Boolean) as ChatRow[]).then(() => notifyOwner(s)).catch(() => {}));
  sock.ev.on('chats.update', (c) => void upsertChats(s, c.map(chatFromWa).filter(Boolean) as ChatRow[]).then(() => notifyOwner(s)).catch(() => {}));
  sock.ev.on('groups.upsert', (g) => void upsertChats(s, g.map(groupRow)).then(() => notifyOwner(s)).catch(() => {}));
  sock.ev.on('groups.update', (g) => void upsertChats(s, g.filter((x) => x.id).map((x) => ({
    jid: x.id!, name: x.subject ?? null, isGroup: true, participants: x.size ?? null, description: x.desc ?? null,
  }))).then(() => notifyOwner(s)).catch(() => {}));
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      for (const m of messages) if (m.message?.reactionMessage) await storeReaction(s, m).catch((e) => console.error(`[wa] ${s.id} reacción`, e?.message));
      const rows = messages.map((m) => msgRow(s, m)).filter(Boolean) as MsgRow[];
      const inserted = await storeMessages(s, rows, type === 'notify');
      if (inserted.length) notifyOwner(s);
      if (type === 'notify') await bridgeToTieComs(s, inserted);
      // El nombre que se puso quien escribe (y su número junto al LID) sirve cuando no está en la libreta.
      await rememberSenders(s, messages);
    } catch (e: any) { console.error(`[wa] ${s.id} mensajes`, e?.message); }
  });
}

async function fail(s: Session, e: any) {
  console.error(`[wa] ${s.id} falló`, e?.message ?? e);
  await setStatus(s.id, { status: 'error', last_error: String(e?.message ?? e).slice(0, 500), lease_owner: null, lease_until: null }).catch(() => {});
  stopLocal(s);
}

function stopLocal(s: Session) {
  s.stopping = true;
  try { s.sock?.end(undefined); } catch {}
  s.sock = null;
  if (sessions.get(s.id) === s) sessions.delete(s.id);
}

async function start(row: any) {
  const s: Session = { id: row.id, userId: row.user_id, kind: row.kind, pairPhone: row.pair_phone, sock: null, stopping: false, retries: 0, registered: false, me: null, notifyTimer: null };
  sessions.set(s.id, s);
  console.log(`[wa] ${s.id} iniciando (${row.status})`);
  try { await connect(s); } catch (e) { await fail(s, e); }
}

/** Cuentas desconectadas por su dueño: se cierra la sesión en WhatsApp y se borra todo. */
async function purgeRemoved() {
  const { rows } = await pool.query('SELECT id FROM wa_accounts WHERE removed_at IS NOT NULL');
  for (const r of rows) {
    const s = sessions.get(r.id);
    if (s?.sock) {
      try { await s.sock.logout('chaggu: cuenta desconectada'); } catch {}
    }
    if (s) stopLocal(s);
    await tx(async c=>{
      const originals=await c.query("SELECT media_info->>'key' AS key FROM wa_messages WHERE account_id=$1 AND media_info->>'key' IS NOT NULL",[r.id]);
      for(const original of originals.rows) await c.query("INSERT INTO jobs(kind,payload) VALUES('wa.delete_original',$1)",[JSON.stringify({key:original.key})]);
      await c.query('DELETE FROM wa_accounts WHERE id=$1',[r.id]);
    });
    console.log(`[wa] ${r.id} desconectada y borrada`);
  }
}

/**
 * Manda lo que las personas respondieron desde chaggu (wa_outbox) por las cuentas que atiende este proceso. El texto se borra al
 * enviar (queda en WhatsApp). Un envío que se quedó «sending» no se reintenta a ciegas: pudo haber salido.
 */
async function processOutbox() {
  const live = [...sessions.values()].filter((s) => s.sock && s.registered && !s.stopping);
  if (live.length) {
    const { rows } = await pool.query(
      `UPDATE wa_outbox SET status = 'sending', attempts = attempts + 1
        WHERE id IN (SELECT o.id FROM wa_outbox o JOIN wa_accounts a ON a.id = o.account_id
                      WHERE o.status = 'queued' AND o.account_id = ANY($1) AND a.send_enabled
                      ORDER BY o.created_at LIMIT 20 FOR UPDATE OF o SKIP LOCKED)
        RETURNING id, account_id, jid, body`,
      [live.map((s) => s.id)],
    );
    for (const r of rows) {
      const s = sessions.get(r.account_id);
      try {
        if (!s?.sock) throw new Error('La sesión de WhatsApp no está lista');
        const sent=await s.sock.sendMessage(r.jid,{text:r.body});
        if(sent) { const row=msgRow(s,sent); if(row) await storeMessages(s,[row],false); }
        await pool.query("UPDATE wa_outbox SET status = 'sent', sent_at = now(), body = '' WHERE id = $1", [r.id]);
        notifyOwner(s);
      } catch (e: any) {
        console.error(`[wa] ${r.account_id} no pude enviar`, e?.message);
        await pool.query("UPDATE wa_outbox SET status = 'failed', error = $2, body = '' WHERE id = $1", [r.id, String(e?.message ?? e).slice(0, 300)]);
      }
    }
  }
  await pool.query("UPDATE wa_outbox SET status = 'failed', error = 'Se interrumpió el envío. Revisa en WhatsApp antes de reintentar.', body = '' WHERE status = 'sending' AND created_at < now() - interval '2 minutes'");
  await pool.query("DELETE FROM wa_outbox WHERE status IN ('sent', 'failed') AND created_at < now() - interval '7 days'");
}

let mediaDownloading=false,mediaCursor=0;
async function tick() {
  await purgeRemoved();
  // One background account per tick: provider media I/O cannot delay account leases, sends, or reconnects.
  const candidates=[...sessions.values()].filter(s=>s.sock && !s.stopping);
  if(!mediaDownloading && candidates.length) {
    const s=candidates[mediaCursor++ % candidates.length]!;mediaDownloading=true;
    void downloadPendingWaMedia(s.id,s.sock!,()=>!s.stopping && sessions.get(s.id)===s).then(n=>{if(n && !s.stopping) notifyOwner(s);}).catch(()=>{}).finally(()=>{mediaDownloading=false;});
  }
  await processOutbox().catch((e: any) => console.error('[wa] outbox', e?.message));
  const mine = [...sessions.keys()];
  if (mine.length) {
    await pool.query(`UPDATE wa_accounts SET lease_until = now() + make_interval(secs => $3) WHERE id = ANY($1) AND lease_owner = $2`, [mine, BRIDGE_ID, LEASE_SECONDS]);
  }
  // Las cuentas que alguien más dejó de atender (o nuevas) se reclaman aquí.
  const { rows } = await pool.query(
    `UPDATE wa_accounts SET lease_owner = $1, lease_until = now() + make_interval(secs => $2)
      WHERE id IN (SELECT id FROM wa_accounts
                    WHERE removed_at IS NULL AND status IN ('pending', 'qr', 'connected', 'reconnecting')
                      AND (lease_until IS NULL OR lease_until < now()) AND NOT (id = ANY($3))
                    FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [BRIDGE_ID, LEASE_SECONDS, mine],
  );
  for (const r of rows) void start(r);
}

let stop = false;
let wake: (() => void) | null = null;

async function main() {
  const listener = await pool.connect();
  await listener.query('LISTEN tiecoms_wa');
  listener.on('notification', () => wake?.());
  console.log(`[wa] puente ${BRIDGE_ID} iniciado`);
  while (!stop) {
    try { await tick(); } catch (e: any) { console.error('[wa] error en ciclo', e?.message); }
    await new Promise<void>((r) => { wake = r; setTimeout(r, 5000); });
    wake = null;
  }
  listener.release();
  // Al apagar se sueltan los leases para que otra réplica retome sin esperar.
  const ids = [...sessions.keys()];
  for (const s of [...sessions.values()]) stopLocal(s);
  if (ids.length) await pool.query('UPDATE wa_accounts SET lease_owner = NULL, lease_until = NULL WHERE id = ANY($1) AND lease_owner = $2', [ids, BRIDGE_ID]).catch(() => {});
  await pool.end();
  process.exit(0);
}

process.on('unhandledRejection', (e: any) => console.error('[wa] promesa sin manejar', e?.message ?? e));
process.on('SIGTERM', () => { stop = true; wake?.(); });
process.on('SIGINT', () => { stop = true; wake?.(); });
void main();
