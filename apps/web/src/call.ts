/**
 * La llamada en curso de este navegador (una a la vez), con el SDK de Amazon Chime.
 * - El API crea la reunión y el attendee; aquí solo se conecta el audio y el video.
 * - Latido cada 30 s: si la pestaña muere, el servidor la saca sola.
 * - Transcripción: el SDK entrega frases parciales (subtítulos en vivo) y finales; las finales se mandan
 *   al API en lotes para guardarlas (el API deduplica, todos los participantes las reportan).
 */
import type { AccountEvent, CallDTO, CallJoinDTO, CallKind, CallTranscriptSegmentInput, GuestCallStateDTO, GuestJoinDTO } from '@tiecoms/contracts';
import { callUserId } from '@tiecoms/contracts';
import { apiUrl, client } from './app-client.ts';

export interface CallTile { tileId: number; local: boolean; userId: string | null; active: boolean }
export interface Caption { resultId: string; userId: string | null; text: string; partial: boolean; /** Pedazo de audio en Groq: «Procesando…». */ processing?: boolean }
export interface CallView {
  call: CallDTO;
  phase: 'connecting' | 'live' | 'ended';
  muted: boolean;
  camera: boolean;
  tiles: CallTile[];
  captions: Caption[];
  /** Quién suena ahora (ids de persona). */
  speaking: string[];
  /** 1.7.1: quién tiene el micrófono silenciado (por persona, del indicador de volumen de Chime). */
  mutedUsers: string[];
  /** Salida de audio y micrófono elegidos (deviceId; '' = el predeterminado). */
  audioOutput: string;
  audioInput: string;
  error: string | null;
  /** Estoy compartiendo mi pantalla. */
  sharing: boolean;
  /** Pantallas que comparten los demás (recuadros de contenido de Chime; la mía no se muestra). */
  screens: CallTile[];
  /** Entré como invitado por enlace (sin cuenta). */
  guest: boolean;
}

/** El navegador deja compartir pantalla (en móviles no hay getDisplayMedia). */
export const canShareScreen = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia && !/Android|iPhone|iPad/.test(navigator.userAgent);

type Listener = (v: CallView | null) => void;
let view: CallView | null = null;
const listeners = new Set<Listener>();
const emit = () => { for (const l of listeners) l(view); };
const patch = (p: Partial<CallView>) => { if (view) { view = { ...view, ...p }; emit(); syncRecorder(); } };
export function subscribeCall(l: Listener) { listeners.add(l); l(view); return () => { listeners.delete(l); }; }
export const currentCall = () => view;

let session: any = null;
let audioEl: HTMLAudioElement | null = null;
let beat: ReturnType<typeof setInterval> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let outbox: CallTranscriptSegmentInput[] = [];
let leaving = false;
/** Invitado por enlace: su id y el secreto para latir y salir (no hay sesión de chaggu). */
let guest: { id: string; secret: string } | null = null;
/** Mi id dentro de la llamada si entré como invitado ("guest:{id}", como lo ven los demás). */
export const myGuestId = () => (guest ? `guest:${guest.id}` : null);
/** Mi attendee de Chime: su recuadro de contenido (mi propia pantalla) no se muestra. */
let myAttendeeId = '';
/** Último error al conectar (para mostrarlo). */
export let lastError: string | null = null;

// Estado de la llamada que llega por el socket (quién está, si transcribe) sin tocar la conexión.
client.subscribe(() => {
  if (!view) return;
  const c = client.getState().calls[view.call.conversationId];
  if (c && c.id === view.call.id && c !== view.call) patch({ call: c });
  if (c === null && view.phase !== 'ended') void teardown();
});

/**
 * Pide micrófono (y cámara) antes de tocar el API: si el navegador no deja, no se crea una llamada vacía
 * que deje «Empezó / Terminó 0:00» en el chat ni hace sonar a los demás.
 */
async function askDevices(camera: boolean) {
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error(''), { code: 'mic_denied' });
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: camera });
    s.getTracks().forEach((x) => x.stop());
  } catch (e: any) {
    if (camera) return askDevices(false); // sin cámara se entra solo con voz
    const code = await micErrorCode(e);
    lastError = e?.message || code;
    throw Object.assign(new Error(''), { code });
  }
}

/**
 * Por qué no hay micrófono, para decir dónde se arregla:
 * - mic_blocked_os: el sitio tiene permiso pero Windows o macOS se lo niegan al navegador
 *   (Chrome/Edge dicen «Permission denied by system»; o el permiso del sitio ya está en granted).
 * - mic_busy: otra app lo tiene tomado (Teams, Zoom; muy común en Windows).
 * - mic_missing: no hay micrófono conectado.
 * - mic_denied: la persona o el navegador lo bloquearon para este sitio (candado).
 */
async function micErrorCode(e: any): Promise<string> {
  const name = String(e?.name ?? '');
  const msg = String(e?.message ?? '');
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'mic_missing';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'mic_busy';
  if (/by system/i.test(msg)) return 'mic_blocked_os';
  try {
    const st = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
    if (st?.state === 'granted') return 'mic_blocked_os';
  } catch { /* Firefox/Safari viejos no conocen «microphone» */ }
  return 'mic_denied';
}

/** Llama o entra a la llamada en curso de la conversación. */
export async function startCall(conversationId: string, kind: CallKind) {
  if (view && view.call.conversationId === conversationId && view.phase !== 'ended') return;
  await askDevices(kind === 'video');
  if (view) await hangUp();
  await connect(await client.startCall(conversationId, kind), kind === 'video');
}

/** Entrar desde el aviso «te están llamando». */
export async function joinCall(callId: string, camera: boolean) {
  if (view?.call.id === callId && view.phase !== 'ended') return;
  await askDevices(camera);
  if (view) await hangUp();
  await connect(await client.joinCall(callId), camera);
}

// ---------- Invitados por enlace ----------
async function publicPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(apiUrl(`/api/v1${path}`), { method: 'POST', headers: { 'content-type': 'application/json', 'x-tiecoms-client': 'web' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json?.error?.message ?? ''), { code: json?.error?.code ?? 'internal', status: res.status });
  return json as T;
}

/** Lo que ve un invitado de la llamada, con la forma de CallDTO para reusar el panel. */
function guestCall(g: GuestCallStateDTO, prev?: CallDTO): CallDTO {
  return {
    id: g.callId, conversationId: '', kind: g.kind, startedBy: '', startedAt: g.startedAt ?? prev?.startedAt ?? new Date().toISOString(),
    endedAt: g.active ? null : new Date().toISOString(), activeUserIds: g.activeUserIds, transcribing: g.transcribing,
    hasTranscript: false, names: g.names, guests: g.guests,
  };
}

/** Entrar como invitado con el enlace (/llamada/:token), sin cuenta. */
export async function joinAsGuest(token: string, name: string, camera: boolean) {
  if (view && view.phase !== 'ended') return;
  await askDevices(camera);
  const j = await publicPost<GuestJoinDTO>(`/call-links/${encodeURIComponent(token)}/join`, { name });
  guest = { id: j.guestId, secret: j.secret };
  await connect({ call: guestCall(j.call), meeting: j.meeting, attendee: j.attendee } as CallJoinDTO, camera);
}

/** Entrar como invitado a una sala abierta (/sala/:código): la abre si estaba vacía. */
export async function joinRoomAsGuest(code: string, name: string, camera: boolean) {
  if (view && view.phase !== 'ended') return;
  await askDevices(camera);
  const j = await publicPost<GuestJoinDTO>(`/rooms/${encodeURIComponent(code)}/join`, { name });
  guest = { id: j.guestId, secret: j.secret };
  await connect({ call: guestCall(j.call), meeting: j.meeting, attendee: j.attendee } as CallJoinDTO, camera);
}

/** Entrar a una de mis salas desde la app. */
export async function startRoom(roomId: string, camera = true) {
  if (view && view.phase !== 'ended') return;
  await askDevices(camera);
  await connect(await client.enterRoom(roomId), camera);
}

function beatOnce() {
  if (!view) return;
  if (guest) {
    const g = guest;
    void publicPost<GuestCallStateDTO>(`/call-guests/${g.id}/heartbeat`, { secret: g.secret })
      .then((s) => { if (view && guest === g) { if (!s.active) void teardown(); else patch({ call: guestCall(s, view.call) }); } })
      .catch((err) => { if (err?.code === 'not_in_call' || err?.status === 404) void teardown(); });
    return;
  }
  client.callHeartbeat(view.call.id).catch((err) => { if (err?.code === 'not_in_call') void teardown(); });
}

async function connect(j: CallJoinDTO, camera: boolean) {
  leaving = false;
  view = { call: j.call, phase: 'connecting', muted: false, camera, tiles: [], captions: [], speaking: [], mutedUsers: [], audioOutput: '', audioInput: '', error: null, sharing: false, screens: [], guest: !!guest };
  myAttendeeId = (j.attendee as any)?.Attendee?.AttendeeId ?? '';
  emit();
  try {
    // El SDK de Chime usa `global` (de Node); en el navegador es globalThis. Sin esto falla al cargar.
    (globalThis as any).global ??= globalThis;
    const sdk = await import('amazon-chime-sdk-js');
    const logger = new sdk.ConsoleLogger('chime', sdk.LogLevel.WARN);
    const devices = new sdk.DefaultDeviceController(logger, { enableWebAudio: false });
    session = new sdk.DefaultMeetingSession(new sdk.MeetingSessionConfiguration(j.meeting, j.attendee), logger, devices);
    const av = session.audioVideo;
    const mics = await av.listAudioInputDevices();
    await av.startAudioInput(mics[0]?.deviceId ?? 'default');
    view.audioInput = mics[0]?.deviceId ?? '';
    audioEl ??= Object.assign(document.createElement('audio'), { autoplay: true });
    await av.bindAudioElement(audioEl);
    av.addObserver({
      audioVideoDidStart: () => { patch({ phase: 'live' }); const cb = onLive; onLive = null; cb?.(); },
      audioVideoDidStop: () => { if (!leaving) void teardown(); },
      videoTileDidUpdate: (t: any) => {
        if (!view || !t.tileId) return;
        if (t.isContent) {
          // La pantalla que comparto yo no se muestra (sería un espejo infinito); la de los demás, en grande.
          if (myAttendeeId && String(t.boundAttendeeId ?? '').startsWith(myAttendeeId)) return;
          const scr: CallTile = { tileId: t.tileId, local: false, userId: t.boundExternalUserId ? callUserId(t.boundExternalUserId) : null, active: t.active };
          patch({ screens: [...view.screens.filter((x) => x.tileId !== t.tileId), scr] });
          return;
        }
        // ExternalUserId = "{userId}#{deviceKey}" (1.7.1) o solo el id (clientes 1.7.0).
        const tile: CallTile = { tileId: t.tileId, local: t.localTile, userId: t.boundExternalUserId ? callUserId(t.boundExternalUserId) : null, active: t.active };
        patch({ tiles: [...view.tiles.filter((x) => x.tileId !== t.tileId), tile] });
      },
      videoTileWasRemoved: (tileId: number) => { if (view) patch({ tiles: view.tiles.filter((x) => x.tileId !== tileId), screens: view.screens.filter((x) => x.tileId !== tileId) }); },
    });
    // También se entera cuando la persona deja de compartir desde la barra del navegador o del sistema.
    av.addContentShareObserver({
      contentShareDidStart: () => patch({ sharing: true }),
      contentShareDidStop: () => patch({ sharing: false }),
    });
    av.realtimeSubscribeToMuteAndUnmuteLocalAudio((muted: boolean) => patch({ muted }));
    const attendeeUsers = new Map<string, string>();
    const mutedBy = new Map<string, boolean>();
    av.realtimeSubscribeToAttendeeIdPresence((attendeeId: string, present: boolean, externalUserId?: string) => {
      if (present && externalUserId) {
        attendeeUsers.set(attendeeId, callUserId(externalUserId));
        // Micrófono silenciado por persona (una persona en varios dispositivos: silenciada si todos lo están).
        av.realtimeSubscribeToVolumeIndicator(attendeeId, (_id: string, _vol: number | null, muted: boolean | null) => {
          if (muted === null) return;
          mutedBy.set(attendeeId, muted);
          const byUser = new Map<string, boolean>();
          for (const [a, m] of mutedBy) { const u = attendeeUsers.get(a); if (u) byUser.set(u, (byUser.get(u) ?? true) && m); }
          patch({ mutedUsers: [...byUser].filter(([, m]) => m).map(([u]) => u) });
        });
      }
      if (!present) { mutedBy.delete(attendeeId); av.realtimeUnsubscribeFromVolumeIndicator?.(attendeeId); }
    });
    av.subscribeToActiveSpeakerDetector(new sdk.DefaultActiveSpeakerPolicy(), (ids: string[]) => {
      patch({ speaking: ids.map((a) => attendeeUsers.get(a)).filter((x): x is string => !!x) });
    });
    av.transcriptionController?.subscribeToTranscriptEvent((e: any) => onTranscript(e));
    av.start();
    if (camera) await startCamera();
    // Los invitados laten más seguido: así también se enteran de quién entra y sale (no tienen socket).
    beat = setInterval(beatOnce, guest ? 15_000 : 30_000);
    addEventListener('pagehide', onPageHide);
  } catch (e: any) {
    console.error('[call] no se pudo conectar', e);
    const mic = /^(NotAllowed|PermissionDenied|NotFound|DevicesNotFound|NotReadable|TrackStart|Overconstrained)Error$/.test(String(e?.name)) ? await micErrorCode(e) : null;
    lastError = mic ?? (e?.message ?? String(e));
    await hangUp();
    // Sin mensaje propio: errorText muestra el texto traducido del código.
    throw Object.assign(new Error(''), { code: mic ?? 'call_connect_failed' });
  }
}

function onPageHide() {
  // Al cerrar la pestaña se intenta avisar; si no alcanza, el servidor la saca al dejar de latir (75 s; invitados 45 s).
  if (guest) { navigator.sendBeacon?.(apiUrl(`/api/v1/call-guests/${guest.id}/leave`), new Blob([JSON.stringify({ secret: guest.secret })], { type: 'application/json' })); return; }
  if (view) void client.leaveCall(view.call.id).catch(() => {});
}

// ---------- Compartir pantalla ----------
/**
 * Comparte una pantalla, ventana o pestaña (la elige la persona en el selector del navegador o del sistema).
 * Tiene que llamarse desde un clic. Chime la manda como un recuadro de contenido aparte, a 15 cuadros por
 * segundo: texto nítido sin gastar de más. Cancelar el selector no es un error.
 */
export async function startScreenShare() {
  const av = session?.audioVideo;
  if (!av || !view || view.sharing) return;
  try {
    await av.startContentShareFromScreenCapture(undefined, 15);
    patch({ sharing: true });
  } catch (e: any) {
    if (e?.name === 'NotAllowedError' || e?.name === 'AbortError') return;
    throw Object.assign(new Error(''), { code: 'screen_share_failed' });
  }
}

export function stopScreenShare() {
  const av = session?.audioVideo;
  if (!av || !view?.sharing) return;
  av.stopContentShare();
  patch({ sharing: false });
}

async function startCamera() {
  const av = session?.audioVideo;
  if (!av) return;
  const cams = await av.listVideoInputDevices();
  if (!cams.length) { patch({ camera: false, error: 'no_camera' }); return; }
  await av.startVideoInput(cams[0].deviceId);
  av.startLocalVideoTile();
  patch({ camera: true });
}

/**
 * Cámara en plena llamada, sin reconectar: prenderla empieza el recuadro local (los demás lo ven enseguida);
 * apagarla lo quita y mi recuadro vuelve al avatar.
 */
export async function toggleCamera() {
  const av = session?.audioVideo;
  if (!av || !view) return;
  if (view.camera) {
    av.stopLocalVideoTile();
    await av.stopVideoInput();
    patch({ camera: false, tiles: view.tiles.filter((x) => !x.local) });
  } else await startCamera();
}

// ---------- Salida de audio y micrófono (1.7.1) ----------
export interface AudioDevice { deviceId: string; label: string }
/** Salidas de audio (altavoz, audífonos, Bluetooth). Vacía si el navegador no deja elegir (sin setSinkId). */
export async function listAudioOutputs(): Promise<AudioDevice[]> {
  const av = session?.audioVideo;
  if (!av || typeof (HTMLMediaElement.prototype as any).setSinkId !== 'function') return [];
  return ((await av.listAudioOutputDevices()) as MediaDeviceInfo[]).map((x) => ({ deviceId: x.deviceId, label: x.label || x.deviceId }));
}
export async function listAudioInputs(): Promise<AudioDevice[]> {
  const av = session?.audioVideo;
  if (!av) return [];
  return ((await av.listAudioInputDevices()) as MediaDeviceInfo[]).map((x) => ({ deviceId: x.deviceId, label: x.label || x.deviceId }));
}
export async function chooseAudioOutput(deviceId: string) {
  const av = session?.audioVideo;
  if (!av) return;
  await av.chooseAudioOutput(deviceId);
  patch({ audioOutput: deviceId });
}
export async function chooseAudioInput(deviceId: string) {
  const av = session?.audioVideo;
  if (!av) return;
  await av.startAudioInput(deviceId);
  patch({ audioInput: deviceId });
}

// ---------- «Pasar aquí» (1.7.1) ----------
let onLive: (() => void) | null = null;
/** Entra desde este dispositivo y, cuando conecta, saca al otro dispositivo mío (leave {deviceKey}). */
export async function passHere(callId: string, otherDeviceKey: string, camera = false) {
  onLive = () => { void client.leaveCall(callId, false, otherDeviceKey).catch(() => {}); };
  try { await joinCall(callId, camera); } catch (e) { onLive = null; throw e; }
}

export function toggleMute() {
  const av = session?.audioVideo;
  if (!av || !view) return;
  if (view.muted) av.realtimeUnmuteLocalAudio(); else av.realtimeMuteLocalAudio();
}

export function bindTile(tileId: number, el: HTMLVideoElement | null) {
  if (el) session?.audioVideo.bindVideoElement(tileId, el);
}

// ---------- Transcripción ----------
function onTranscript(e: any) {
  if (!view || !Array.isArray(e?.results)) return;
  let captions = view.captions;
  for (const r of e.results) {
    const alt = r.alternatives?.[0];
    const text = String(alt?.transcript ?? '').trim();
    if (!text) continue;
    const who = alt.items?.find((i: any) => i.attendee)?.attendee;
    const userId = who?.externalUserId ? callUserId(who.externalUserId) : null;
    captions = [...captions.filter((c) => c.resultId !== r.resultId), { resultId: r.resultId, userId, text, partial: r.isPartial }].slice(-6);
    if (!r.isPartial) {
      outbox.push({ resultId: r.resultId, attendeeId: who?.attendeeId ?? null, externalUserId: userId, language: r.languageCode ?? null, text: text.slice(0, 4000), startMs: Math.max(0, Math.round(r.startTimeMs)), endMs: Math.max(0, Math.round(r.endTimeMs)) });
      flushTimer ??= setTimeout(() => void flush(), 3000);
    }
  }
  patch({ captions });
}

async function flush() {
  flushTimer = null;
  if (!view || !outbox.length || guest) return;
  const callId = view.call.id;
  const batch = outbox.splice(0, 50);
  try { await client.sendCallTranscript(callId, batch); }
  catch (e: any) {
    // Sin red: se reintenta; apagada o fuera de la llamada: se descarta.
    if (!e?.code || e.code === 'internal') { outbox.unshift(...batch); flushTimer = setTimeout(() => void flush(), 5000); }
  }
  if (outbox.length) flushTimer ??= setTimeout(() => void flush(), 500);
}

// ---------- Transcripción con Groq: pedazos del micrófono propio (docs/LLAMADAS.md) ----------
/** Corta en el primer silencio después de 12 s, y a los 20 s como máximo (Groq cobra mínimo 10 s por pedazo). */
const CHUNK_MIN_MS = 12_000;
const CHUNK_MAX_MS = 20_000;
/** Voz mínima dentro del pedazo para mandarlo (evita pagar silencios y las alucinaciones de Whisper). */
const MIN_VOICE_MS = 800;
const VOICE_RMS = 0.015;
let rec: { stop: () => void } | null = null;

function syncRecorder() {
  // Los invitados por enlace también mandan su micrófono (con su secreto, /call-guests/:id/audio).
  const want = !!view && view.phase === 'live' && view.call.transcribing;
  if (want && !rec) startRecorder();
  if (!want && rec) { rec.stop(); rec = null; }
}

function startRecorder() {
  if (!view || typeof MediaRecorder === 'undefined') return;
  const callId = view.call.id;
  const startedAt = Date.parse(view.call.startedAt);
  // Invitado: sus credenciales quedan con la grabación (al colgar se borran antes de subir el último pedazo).
  const g = guest;
  let stopped = false;
  rec = { stop: () => { stopped = true; } };
  void (async () => {
    let stream: MediaStream;
    try {
      // Pista aparte del mismo micrófono, con cancelación de eco para no transcribir a los demás.
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch { rec = null; return; }
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
    const ac = new AudioContext();
    const an = ac.createAnalyser();
    an.fftSize = 1024;
    ac.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    while (!stopped) {
      const chunks: Blob[] = [];
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 24_000 } : undefined);
      mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const t0 = Date.now();
      let voiced = 0;
      let lastVoice = 0;
      mr.start();
      await new Promise<void>((resolve) => {
        const iv = setInterval(() => {
          an.getFloatTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += v * v;
          const now = Date.now();
          if (!view?.muted && Math.sqrt(sum / buf.length) > VOICE_RMS) { voiced += 100; lastVoice = now; }
          const el = now - t0;
          if (stopped || el >= CHUNK_MAX_MS || (el >= CHUNK_MIN_MS && now - lastVoice > 700)) { clearInterval(iv); resolve(); }
        }, 100);
      });
      const done = new Promise((r) => { mr.onstop = r; });
      mr.stop();
      await done;
      if (voiced >= MIN_VOICE_MS && chunks.length) void uploadChunk(callId, new Blob(chunks, { type: (mime || 'audio/webm').split(';')[0] }), t0 - startedAt, Date.now() - t0, g);
    }
    stream.getTracks().forEach((x) => x.stop());
    void ac.close().catch(() => {});
  })();
}

async function uploadChunk(callId: string, blob: Blob, offsetMs: number, durationMs: number, g: { id: string; secret: string } | null = null) {
  const segId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const meta = { segId, offsetMs: Math.max(0, offsetMs), durationMs };
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await (g ? guestAudio(g, blob, meta) : client.sendCallAudio(callId, blob, meta)); return; }
    catch (e: any) {
      // Sin red o Groq caído: un reintento con el mismo segId (el servidor no duplica). Apagada o fuera: nada.
      if (e?.status && e.status < 500) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/** Pedazo del invitado por enlace: sin sesión de chaggu, con su secreto. */
async function guestAudio(g: { id: string; secret: string }, blob: Blob, meta: { segId: string; offsetMs: number; durationMs: number }) {
  const res = await fetch(apiUrl(`/api/v1/call-guests/${g.id}/audio`), {
    method: 'POST', body: blob,
    headers: {
      'content-type': 'application/octet-stream', 'x-tiecoms-client': 'web', 'x-guest-secret': g.secret, 'x-file-type': blob.type || 'audio/webm',
      'x-seg-id': meta.segId, 'x-offset-ms': String(Math.round(meta.offsetMs)), 'x-duration-ms': String(Math.round(meta.durationMs)),
    },
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw Object.assign(new Error(json?.error?.message ?? ''), { code: json?.error?.code ?? 'internal', status: res.status });
  }
}

/** «Procesando…» y luego las frases, para todos en la llamada (llegan por la cuenta). */
export function onCallTranscriptEvent(e: Extract<AccountEvent, { type: 'call.processing' | 'call.transcript' }>) {
  if (!view || e.callId !== view.call.id) return;
  const key = `p:${e.segId}`;
  let captions = view.captions.filter((c) => c.resultId !== key);
  if (e.type === 'call.processing') captions = [...captions, { resultId: key, userId: e.userId, text: '', partial: true, processing: true }];
  else for (const sg of e.segments) captions = [...captions.filter((c) => c.resultId !== sg.resultId), { resultId: sg.resultId, userId: sg.speakerUserId ?? e.userId, text: sg.text, partial: false }];
  patch({ captions: captions.slice(-8) });
}

export async function setTranscription(on: boolean, aiSummary = false) {
  if (!view) return;
  if (!on) await flush();
  const call = await client.setCallTranscription(view.call.id, on, aiSummary);
  patch({ call, ...(on ? {} : { captions: [] }) });
}

// ---------- Colgar ----------
export async function hangUp(forAll = false) {
  if (!view) return;
  const id = view.call.id;
  const g = guest;
  if (g) { await teardown(); await publicPost(`/call-guests/${g.id}/leave`, { secret: g.secret }).catch(() => {}); return; }
  await flush().catch(() => {});
  await teardown();
  await client.leaveCall(id, forAll).catch(() => {});
}

async function teardown() {
  leaving = true;
  if (rec) { rec.stop(); rec = null; }
  if (beat) clearInterval(beat);
  beat = null;
  removeEventListener('pagehide', onPageHide);
  const s = session;
  session = null;
  guest = null;
  myAttendeeId = '';
  if (s) {
    try { s.audioVideo.stopContentShare(); } catch {}
    try { s.audioVideo.stopLocalVideoTile(); } catch {}
    await s.audioVideo.stopVideoInput().catch(() => {});
    await s.audioVideo.stopAudioInput().catch(() => {});
    s.audioVideo.stop();
  }
  if (view) { view = { ...view, phase: 'ended', tiles: [], screens: [], sharing: false }; emit(); }
  view = null;
  emit();
}
