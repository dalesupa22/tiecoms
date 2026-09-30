/**
 * La llamada en curso de este navegador (una a la vez), con el SDK de Amazon Chime.
 * - El API crea la reunión y el attendee; aquí solo se conecta el audio y el video.
 * - Latido cada 30 s: si la pestaña muere, el servidor la saca sola.
 * - Transcripción: el SDK entrega frases parciales (subtítulos en vivo) y finales; las finales se mandan
 *   al API en lotes para guardarlas (el API deduplica, todos los participantes las reportan).
 */
import type { AccountEvent, CallDTO, CallJoinDTO, CallKind, CallTranscriptSegmentInput } from '@tiecoms/contracts';
import { callUserId } from '@tiecoms/contracts';
import { client } from './app-client.ts';

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
}

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

async function connect(j: CallJoinDTO, camera: boolean) {
  leaving = false;
  view = { call: j.call, phase: 'connecting', muted: false, camera, tiles: [], captions: [], speaking: [], mutedUsers: [], audioOutput: '', audioInput: '', error: null };
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
        if (!view || !t.tileId || t.isContent) return;
        // ExternalUserId = "{userId}#{deviceKey}" (1.7.1) o solo el id (clientes 1.7.0).
        const tile: CallTile = { tileId: t.tileId, local: t.localTile, userId: t.boundExternalUserId ? callUserId(t.boundExternalUserId) : null, active: t.active };
        patch({ tiles: [...view.tiles.filter((x) => x.tileId !== t.tileId), tile] });
      },
      videoTileWasRemoved: (tileId: number) => { if (view) patch({ tiles: view.tiles.filter((x) => x.tileId !== tileId) }); },
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
    beat = setInterval(() => { if (view) client.callHeartbeat(view.call.id).catch((err) => { if (err?.code === 'not_in_call') void teardown(); }); }, 30_000);
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
  // Al cerrar la pestaña se intenta avisar; si no alcanza, el servidor la saca al dejar de latir (75 s).
  if (view) void client.leaveCall(view.call.id).catch(() => {});
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
  if (!view || !outbox.length) return;
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
  const want = !!view && view.phase === 'live' && view.call.transcribing;
  if (want && !rec) startRecorder();
  if (!want && rec) { rec.stop(); rec = null; }
}

function startRecorder() {
  if (!view || typeof MediaRecorder === 'undefined') return;
  const callId = view.call.id;
  const startedAt = Date.parse(view.call.startedAt);
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
      if (voiced >= MIN_VOICE_MS && chunks.length) void uploadChunk(callId, new Blob(chunks, { type: (mime || 'audio/webm').split(';')[0] }), t0 - startedAt, Date.now() - t0);
    }
    stream.getTracks().forEach((x) => x.stop());
    void ac.close().catch(() => {});
  })();
}

async function uploadChunk(callId: string, blob: Blob, offsetMs: number, durationMs: number) {
  const segId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await client.sendCallAudio(callId, blob, { segId, offsetMs: Math.max(0, offsetMs), durationMs }); return; }
    catch (e: any) {
      // Sin red o Groq caído: un reintento con el mismo segId (el servidor no duplica). Apagada o fuera: nada.
      if (e?.status && e.status < 500) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/** «Procesando…» y luego las frases, para todos en la llamada (llegan por la cuenta). */
export function onCallTranscriptEvent(e: Extract<AccountEvent, { type: 'call.processing' | 'call.transcript' }>) {
  if (!view || e.callId !== view.call.id) return;
  const key = `p:${e.segId}`;
  let captions = view.captions.filter((c) => c.resultId !== key);
  if (e.type === 'call.processing') captions = [...captions, { resultId: key, userId: e.userId, text: '', partial: true, processing: true }];
  else for (const sg of e.segments) captions = [...captions.filter((c) => c.resultId !== sg.resultId), { resultId: sg.resultId, userId: sg.speakerUserId, text: sg.text, partial: false }];
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
  if (s) {
    try { s.audioVideo.stopLocalVideoTile(); } catch {}
    await s.audioVideo.stopVideoInput().catch(() => {});
    await s.audioVideo.stopAudioInput().catch(() => {});
    s.audioVideo.stop();
  }
  if (view) { view = { ...view, phase: 'ended', tiles: [] }; emit(); }
  view = null;
  emit();
}
