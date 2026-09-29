/**
 * La llamada en curso de este navegador (una a la vez), con el SDK de Amazon Chime.
 * - El API crea la reunión y el attendee; aquí solo se conecta el audio y el video.
 * - Latido cada 30 s: si la pestaña muere, el servidor la saca sola.
 * - Transcripción: el SDK entrega frases parciales (subtítulos en vivo) y finales; las finales se mandan
 *   al API en lotes para guardarlas (el API deduplica, todos los participantes las reportan).
 */
import type { CallDTO, CallJoinDTO, CallKind, CallTranscriptSegmentInput } from '@tiecoms/contracts';
import { client } from './app-client.ts';

export interface CallTile { tileId: number; local: boolean; userId: string | null; active: boolean }
export interface Caption { resultId: string; userId: string | null; text: string; partial: boolean }
export interface CallView {
  call: CallDTO;
  phase: 'connecting' | 'live' | 'ended';
  muted: boolean;
  camera: boolean;
  tiles: CallTile[];
  captions: Caption[];
  /** Quién suena ahora (ids de persona). */
  speaking: string[];
  error: string | null;
}

type Listener = (v: CallView | null) => void;
let view: CallView | null = null;
const listeners = new Set<Listener>();
const emit = () => { for (const l of listeners) l(view); };
const patch = (p: Partial<CallView>) => { if (view) { view = { ...view, ...p }; emit(); } };
export function subscribeCall(l: Listener) { listeners.add(l); l(view); return () => { listeners.delete(l); }; }
export const currentCall = () => view;

let session: any = null;
let audioEl: HTMLAudioElement | null = null;
let beat: ReturnType<typeof setInterval> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let outbox: CallTranscriptSegmentInput[] = [];
let leaving = false;

// Estado de la llamada que llega por el socket (quién está, si transcribe) sin tocar la conexión.
client.subscribe(() => {
  if (!view) return;
  const c = client.getState().calls[view.call.conversationId];
  if (c && c.id === view.call.id && c !== view.call) patch({ call: c });
  if (c === null && view.phase !== 'ended') void teardown();
});

/** Llama o entra a la llamada en curso de la conversación. */
export async function startCall(conversationId: string, kind: CallKind) {
  if (view && view.call.conversationId === conversationId && view.phase !== 'ended') return;
  if (view) await hangUp();
  await connect(await client.startCall(conversationId, kind), kind === 'video');
}

/** Entrar desde el aviso «te están llamando». */
export async function joinCall(callId: string, camera: boolean) {
  if (view?.call.id === callId && view.phase !== 'ended') return;
  if (view) await hangUp();
  await connect(await client.joinCall(callId), camera);
}

async function connect(j: CallJoinDTO, camera: boolean) {
  leaving = false;
  view = { call: j.call, phase: 'connecting', muted: false, camera, tiles: [], captions: [], speaking: [], error: null };
  emit();
  try {
    const sdk = await import('amazon-chime-sdk-js');
    const logger = new sdk.ConsoleLogger('chime', sdk.LogLevel.WARN);
    const devices = new sdk.DefaultDeviceController(logger, { enableWebAudio: false });
    session = new sdk.DefaultMeetingSession(new sdk.MeetingSessionConfiguration(j.meeting, j.attendee), logger, devices);
    const av = session.audioVideo;
    const mics = await av.listAudioInputDevices();
    await av.startAudioInput(mics[0]?.deviceId ?? 'default');
    audioEl ??= Object.assign(document.createElement('audio'), { autoplay: true });
    await av.bindAudioElement(audioEl);
    av.addObserver({
      audioVideoDidStart: () => patch({ phase: 'live' }),
      audioVideoDidStop: () => { if (!leaving) void teardown(); },
      videoTileDidUpdate: (t: any) => {
        if (!view || !t.tileId || t.isContent) return;
        const tile: CallTile = { tileId: t.tileId, local: t.localTile, userId: t.boundExternalUserId ?? null, active: t.active };
        patch({ tiles: [...view.tiles.filter((x) => x.tileId !== t.tileId), tile] });
      },
      videoTileWasRemoved: (tileId: number) => { if (view) patch({ tiles: view.tiles.filter((x) => x.tileId !== tileId) }); },
    });
    av.realtimeSubscribeToMuteAndUnmuteLocalAudio((muted: boolean) => patch({ muted }));
    const attendeeUsers = new Map<string, string>();
    av.realtimeSubscribeToAttendeeIdPresence((attendeeId: string, present: boolean, externalUserId?: string) => {
      if (present && externalUserId) attendeeUsers.set(attendeeId, externalUserId);
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
    patch({ error: e?.message ?? String(e) });
    await hangUp();
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

export async function toggleCamera() {
  const av = session?.audioVideo;
  if (!av || !view) return;
  if (view.camera) { av.stopLocalVideoTile(); await av.stopVideoInput(); patch({ camera: false }); }
  else await startCamera();
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
    const userId = who?.externalUserId ?? null;
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
