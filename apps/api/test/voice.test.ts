/**
 * Notas de voz: subir como adjunto de voz, transcripción con Inworld falso, resumen/sugerencia con DeepSeek falso,
 * variante AAC con ffmpeg falso, fallo y reintento. API + worker con INWORLD_STT_URL, DEEPSEEK_URL y FFMPEG_PATH
 * apuntando a test/fake-voice.mjs y test/fake-ffmpeg.mjs (FAKE_VOICE_URL = el falso).
 */
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chunkPcm, waveformFromPcm } from '../src/modules/voice-providers.ts';
import { sniffAudio, summarize, summaryText } from '../src/modules/attachments.ts';

const API = process.env.API_URL ?? 'http://localhost:3020';
const FAKE = process.env.FAKE_VOICE_URL ?? 'http://127.0.0.1:59048';
const run = randomUUID().slice(0, 8);
interface Actor { token: string; id: string; orgId: string }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(path: string, opts: { method?: string; token?: string; body?: unknown; raw?: Buffer; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body || opts.raw ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : opts.raw ? { 'content-type': 'application/octet-stream' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : opts.raw,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = {};
  try { json = JSON.parse(buf.toString()); } catch {}
  return { status: res.status, json, buf, headers: res.headers };
}
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function signup(name: string, orgInviteToken?: string): Promise<Actor> {
  const res = await fetch(`${API}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({
    name, email: `${name.toLowerCase()}.voz.${run}@example.com`, password: 'clave-segura-123', ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }),
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  }) });
  const j: any = await res.json();
  expect(res.status).toBe(200);
  return { token: j.accessToken, id: j.user.id, orgId: j.user.primaryOrgId };
}
// Cabecera de un webm (EBML) y de un m4a: lo que mandan la web y las apps.
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('webm-opus-falso-'.repeat(20))]);
const M4A = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4A \0\0\0\0M4A mp42isom', 'latin1'), Buffer.from('aac'.repeat(50))]);
const voiceUpload = (a: Actor, conv: string, body: Buffer, type: string, extra: Record<string, string> = {}) =>
  call(`/conversations/${conv}/attachments`, { token: a.token, raw: body, headers: { 'x-file-name': 'nota.webm', 'x-file-type': type, 'x-voice-note': '1', 'x-ai-consent': '1', 'x-duration-ms': '52000', ...extra } });

describe('utilidades de voz', () => {
  it('reconoce formatos de audio, arma la onda y parte el PCM', () => {
    expect(sniffAudio(WEBM)).toBe('audio/webm');
    expect(sniffAudio(M4A)).toBe('audio/mp4');
    expect(sniffAudio(Buffer.from('OggS\0\0'))).toBe('audio/ogg');
    const pcm = Buffer.alloc(32000);
    for (let i = 0; i < 16000; i++) pcm.writeInt16LE(i < 8000 ? 10000 : 1000, i * 2);
    const w = waveformFromPcm(pcm, 4);
    expect(w).toEqual([1, 1, 0.1, 0.1]);
    expect(chunkPcm(Buffer.alloc(25), 10).map((b) => b.length)).toEqual([10, 10, 5]);
    const v = { id: '', name: 'n', contentType: 'audio/mp4', sizeBytes: 1, width: null, height: null, url: '', thumbUrl: null, kind: 'voice' as const, durationMs: 42_400 };
    expect(summaryText(summarize([v])!, 'es')).toBe('🎤 Nota de voz (0:42)');
    expect(summaryText(summarize([v])!, 'en')).toBe('🎤 Voice note (0:42)');
  });
});

describe('notas de voz', () => {
  let ana: Actor, beto: Actor, extra: Actor, chatId: string, socket: Socket;
  const updates: any[] = [];
  beforeAll(async () => {
    ana = await signup('Ana');
    beto = await signup('Beto', (await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: {} })).json.token);
    extra = await signup('Extra');
    chatId = (await call('/chats', { token: ana.token, body: { userIds: [beto.id], name: 'Voz' } })).json.id;
    socket = await new Promise((res, rej) => {
      const s = io(API, { path: '/api/socket.io', transports: ['websocket'], auth: { token: beto.token } });
      s.on('conv.event', (e) => { if (e.type === 'message.updated') updates.push(e); });
      s.once('ready', () => res(s)); s.once('connect_error', rej);
    });
  });
  afterAll(() => socket?.disconnect());

  async function waitTranscript(messageId: string, status: string) {
    for (let i = 0; i < 80; i++) {
      const u = updates.find((e) => e.message.id === messageId && e.message.attachments?.[0]?.transcript?.status === status);
      if (u) return u.message.attachments[0];
      await sleep(250);
    }
    throw new Error(`sin transcripción ${status}`);
  }

  it('sube, se envía solo con la nota y el worker la transcribe, resume, sugiere asunto y deja un AAC reproducible', async () => {
    const up = await voiceUpload(ana, chatId, WEBM, 'audio/webm;codecs=opus', { 'x-waveform': '0.1,0.5,1.4,-2,abc,0.33' });
    expect(up.status).toBe(200);
    expect(up.json).toMatchObject({ kind: 'voice', contentType: 'audio/webm', durationMs: 52000, waveform: [0.1, 0.5, 1, 0, 0.33], transcript: null });
    const sent = await call(`/conversations/${chatId}/messages`, { token: ana.token, body: { clientMessageId: randomUUID(), body: '', attachmentIds: [up.json.id] } });
    expect(sent.status).toBe(201);
    expect(sent.json.message.attachments[0].transcript).toEqual({ status: 'pending', text: null, language: null, summary: null, suggestedIssue: null });
    const done = await waitTranscript(sent.json.message.id, 'done');
    expect(done.transcript).toMatchObject({ status: 'done', text: 'hola equipo por favor envíen el contrato firmado mañana temprano', language: 'es-CO', summary: 'Piden el contrato firmado para mañana', suggestedIssue: 'Enviar el contrato firmado' });
    expect(done.contentType).toBe('audio/mp4');
    const reqs = (await (await fetch(`${FAKE}/sent`)).json()) as any[];
    const stt = reqs.filter((r) => r.kind === 'stt').at(-1);
    // El archivo va tal cual (webm) con AUTO_DETECT, sin sampleRate.
    expect(stt).toMatchObject({ auth: 'Basic clave-falsa-inworld', config: { modelId: 'inworld/inworld-stt-1', audioEncoding: 'AUTO_DETECT', language: 'es-CO' }, bytes: WEBM.length });
    expect(stt.config.sampleRateHertz).toBeUndefined();
    const llm = reqs.filter((r) => r.kind === 'llm').at(-1);
    expect(llm).toMatchObject({ auth: 'Bearer clave-falsa-deepseek', model: 'deepseek-chat' });
    const system = llm.messages.find((m: any) => m.role === 'system').content;
    expect(system).toContain('Autor (quien habla): Ana');
    expect(system).toContain('Participantes de la conversación: Beto');
    expect(system).toContain('Conversación: Voz');
    expect(system).toContain('tercera persona con el autor como sujeto');
    expect(system).toContain('se compromete');
    // url sirve la variante AAC; ?original=1 el webm subido.
    const play = await call(`/attachments/${up.json.id}`, { token: beto.token });
    expect(play.headers.get('content-type')).toBe('audio/mp4');
    expect((await call(`/attachments/${up.json.id}?original=1`, { token: beto.token })).buf.equals(WEBM)).toBe(true);
    expect((await call(`/attachments/${up.json.id}`, { token: extra.token })).status).toBe(404);
    // La lista muestra «🎤 Nota de voz» en la vista previa de adjuntos.
    const conv = (await call('/bootstrap', { token: beto.token })).json.conversations.find((c: any) => c.id === chatId);
    expect(conv.lastHumanPreview.attachments).toMatchObject({ count: 1, voices: 1, voiceDurationMs: 52000, files: 0 });
    expect(conv.lastMessagePreview).toBe('🎤');
  });

  it('m4a de las apps: se transcribe directo aunque ffmpeg falle; sin variante; nota corta sin resumen', async () => {
    // «romper-ffmpeg» hace fallar al ffmpeg falso: el camino directo no lo necesita.
    const m4a = Buffer.concat([M4A, Buffer.from('romper-ffmpeg')]);
    const up = await voiceUpload(ana, chatId, m4a, 'audio/mp4', { 'x-duration-ms': '8000', 'x-waveform': '0.2,0.8,0.4' });
    const m = (await call(`/conversations/${chatId}/messages`, { token: ana.token, body: { clientMessageId: randomUUID(), body: '', attachmentIds: [up.json.id] } })).json.message;
    const done = await waitTranscript(m.id, 'done');
    expect(done.contentType).toBe('audio/mp4');
    expect(done.transcript.summary).toBeNull();
    expect(done.transcript.text).toContain('contrato');
    expect(done.waveform).toEqual([0.2, 0.8, 0.4]);
    expect((await call(`/attachments/${up.json.id}`, { token: beto.token })).buf.equals(m4a)).toBe(true);
    const stt = ((await (await fetch(`${FAKE}/sent`)).json()) as any[]).filter((r) => r.kind === 'stt').at(-1);
    expect(stt.bytes).toBe(m4a.length);
  });

  it('formato no aceptado: ffmpeg lo pasa a WAV 16 kHz y se transcribe; el servidor calcula la onda', async () => {
    const odd = Buffer.from('audio-raro-sin-cabecera-conocida'.repeat(10));
    const up = await voiceUpload(ana, chatId, odd, 'audio/x-caf', { 'x-duration-ms': '' });
    expect(up.json.contentType).toBe('audio/x-caf');
    const m = (await call(`/conversations/${chatId}/messages`, { token: ana.token, body: { clientMessageId: randomUUID(), body: '', attachmentIds: [up.json.id] } })).json.message;
    const done = await waitTranscript(m.id, 'done');
    const stt = ((await (await fetch(`${FAKE}/sent`)).json()) as any[]).filter((r) => r.kind === 'stt').at(-1);
    expect(stt.head.startsWith('RIFF')).toBe(true);
    expect(stt.bytes).toBe(44 + 64000);
    expect(done.waveform.length).toBeGreaterThan(10);
    expect(done.durationMs).toBe(2000);
  });

  it('un compromiso del autor («el jueves te mando…») se sugiere como asunto', async () => {
    const up = await voiceUpload(ana, chatId, Buffer.concat([M4A, Buffer.from('compromiso')]), 'audio/mp4', { 'x-duration-ms': '6000' });
    const m = (await call(`/conversations/${chatId}/messages`, { token: ana.token, body: { clientMessageId: randomUUID(), body: '', attachmentIds: [up.json.id] } })).json.message;
    const done = await waitTranscript(m.id, 'done');
    expect(done.transcript).toMatchObject({ status: 'done', summary: null, suggestedIssue: 'Enviar el contrato revisado el jueves' });
    const llm = ((await (await fetch(`${FAKE}/sent`)).json()) as any[]).filter((r) => r.kind === 'llm').at(-1);
    expect(llm.messages.find((x: any) => x.role === 'user').content).toContain('Hola Beto, el jueves te mando');
    expect(llm.messages.find((x: any) => x.role === 'system').content).toContain('summary: null.');
  });

  it('si Inworld falla queda failed y se reintenta a mano', async () => {
    await fetch(`${FAKE}/fail`, { method: 'POST' });
    const up = await voiceUpload(ana, chatId, M4A, 'audio/mp4');
    const m = (await call(`/conversations/${chatId}/messages`, { token: ana.token, body: { clientMessageId: randomUUID(), body: '', attachmentIds: [up.json.id] } })).json.message;
    const failed = await waitTranscript(m.id, 'failed');
    expect(failed.transcript.text).toBeNull();
    expect((await call(`/attachments/${up.json.id}/transcribe`, { token: extra.token, body: {} })).status).toBe(404);
    expect((await call(`/attachments/${up.json.id}/transcribe`, { token: beto.token, body: {} })).status).toBe(403);
    const retry = await call(`/attachments/${up.json.id}/transcribe`, { token: beto.token, body: { aiConsent: true } });
    expect(retry.status).toBe(200);
    expect(retry.json.transcript.status).toBe('pending');
    const again = updates.length;
    await waitTranscript(m.id, 'done');
    expect(updates.length).toBeGreaterThan(again);
  });

  it('sin consentimiento envía y convierte el audio localmente sin transferirlo a IA; ni un participante puede habilitarlo al reintentar', async () => {
    const before = ((await (await fetch(`${FAKE}/sent`)).json()) as any[]).length;
    const up = await voiceUpload(ana, chatId, WEBM, 'audio/webm', { 'x-ai-consent': '0' });
    const m = (await call(`/conversations/${chatId}/messages`, { token: ana.token, body: { clientMessageId: randomUUID(), body: '', attachmentIds: [up.json.id] } })).json.message;
    expect(m.attachments[0].transcript.status).toBe('disabled');
    const converted = await waitTranscript(m.id, 'disabled');
    expect(converted.contentType).toBe('audio/mp4');
    expect((await call(`/attachments/${up.json.id}?original=1`, { token: beto.token })).buf.equals(WEBM)).toBe(true);
    expect((await call(`/attachments/${up.json.id}/transcribe`, { token: beto.token, body: { aiConsent: true } })).status).toBe(403);
    expect((await call(`/attachments/${up.json.id}/transcribe`, { token: ana.token, body: { aiConsent: true } })).status).toBe(403);
    expect(((await (await fetch(`${FAKE}/sent`)).json()) as any[]).length).toBe(before);
  });

  it('valida el audio y la duración', async () => {
    expect((await voiceUpload(ana, chatId, Buffer.from('no soy audio'), 'text/plain')).status).toBe(400);
    expect((await voiceUpload(ana, chatId, M4A, 'audio/mp4', { 'x-duration-ms': String(16 * 60_000) })).status).toBe(400);
    const file = await call(`/conversations/${chatId}/attachments`, { token: ana.token, raw: M4A, headers: { 'x-file-name': 'cancion.m4a', 'x-file-type': 'audio/mp4' } });
    expect(file.json.kind).toBeUndefined();
    expect((await call(`/attachments/${file.json.id}/transcribe`, { token: ana.token, body: {} })).status).toBe(400);
  });
});
