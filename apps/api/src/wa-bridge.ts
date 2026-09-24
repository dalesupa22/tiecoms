/**
 * Puente de WhatsApp: mantiene vivas las cuentas que cada persona conectó.
 *
 * Usa Baileys, que se vincula como «dispositivo vinculado» (igual que WhatsApp
 * Web), así funciona tanto con WhatsApp personal como con WhatsApp Business y
 * lee grupos, chats y mensajes. Solo lee: no envía mensajes ni marca como leído.
 *
 * Un proceso reclama cada cuenta con un lease en la BD (una sesión por cuenta
 * aunque haya varias réplicas). Las credenciales se guardan cifradas en wa_auth.
 */
import { hostname } from 'node:os';
import pino from 'pino';
import makeWASocket, { Browsers, DisconnectReason, fetchLatestWaWebVersion, isJidGroup, jidNormalizedUser, makeCacheableSignalKeyStore } from 'baileys';
import { pool } from './db.ts';
import {
  bridgeToTieComs, chatFromWa, dbAuthState, groupRow, msgRow, notifyOwner, organizeAccount, setStatus, skipJid, storeMessages, tsOf,
  upsertChats, upsertContacts, type ChatRow, type MsgRow, type Session,
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
    notifyOwner(s);
  } catch (e: any) { console.error(`[wa] ${s.id} no pude leer los grupos`, e?.message); }
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

  sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest }) => {
    try {
      await upsertContacts(s, contacts);
      await upsertChats(s, chats.map(chatFromWa).filter(Boolean) as ChatRow[]);
      const rows = messages.filter((m) => tsOf(m.messageTimestamp).getTime() >= cutoff).map((m) => msgRow(s, m)).filter(Boolean) as MsgRow[];
      await storeMessages(s, rows, false);
      await setStatus(s.id, { last_sync_at: new Date() });
      organizeSoon();
      notifyOwner(s);
      if (isLatest) console.log(`[wa] ${s.id} historial recibido`);
    } catch (e: any) { console.error(`[wa] ${s.id} historial`, e?.message); }
  });
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
      const rows = messages.map((m) => msgRow(s, m)).filter(Boolean) as MsgRow[];
      const inserted = await storeMessages(s, rows, type === 'notify');
      if (inserted.length) notifyOwner(s);
      if (type === 'notify') await bridgeToTieComs(s, inserted);
      // Los nombres de quienes escriben en 1:1 sirven como contacto.
      await upsertContacts(s, messages.filter((m) => !m.key.fromMe && m.pushName && m.key.remoteJid && !isJidGroup(m.key.remoteJid))
        .map((m) => ({ id: m.key.remoteJid!, notify: m.pushName! })));
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
      try { await s.sock.logout('TieComs: cuenta desconectada'); } catch {}
    }
    if (s) stopLocal(s);
    await pool.query('DELETE FROM wa_accounts WHERE id = $1', [r.id]);
    console.log(`[wa] ${r.id} desconectada y borrada`);
  }
}

async function tick() {
  await purgeRemoved();
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
