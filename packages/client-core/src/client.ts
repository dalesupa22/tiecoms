import { io, type Socket } from 'socket.io-client';
import {
  CONTRACT_VERSION, SOCKET_EVENTS,
  type AccountEvent, type AuthResult, type BootstrapDTO, type ConversationDTO, type ConversationEvent, type DeviceInfo,
  type AttachmentDTO, type MentionDTO, type MentionItemDTO, type CalendarEventDTO, type EventsPage, type ForwardedInfo, type InvitationPreviewDTO, type IssueDTO, type IssueVisibility, type MeetingConnectionDTO, type MeetingDTO, type MeetingProvider, type IssueEventDTO, type MessageDTO, type OrgInvitationCreatedDTO, type OrgInvitationPreviewDTO, type PendingInvitationDTO, type Platform, type ReminderDTO, type Rsvp, type ScheduledMessageDTO, type SleepDTO,
  type CreateGroupRequest, type CreateGroupResultDTO, type InvitationCreatedDTO, type OversightDTO,
  type LinkItemDTO, type LinkPreviewMode, type LinkSummaryDTO, type LinksPageDTO, type ReactionDTO, type TopicColor, type TopicDTO, type UserDTO, normalizeEmoji,
  type SoundChoice, type Ringtone, type CallDTO, type CallHistoryItemDTO, type CallJoinDTO, type CallKind, type CallTranscriptDTO, type CallTranscriptSegmentDTO, type CallTranscriptSegmentInput,
  type MessageRefDTO, type ChatSearchPageDTO, type ViewOnceOpenDTO, type EventCommentDTO, type ViewOnceState,
  type SignatureDTO, type SignInfoDTO, type SignPdfInput, type SignPdfResult, type SigningHistoryPageDTO, type IntegrationDTO, type IntegrationSecretDTO,
} from '@tiecoms/contracts';
import { ApiRequestError, parseError } from './api.ts';
import type { KeyValueStorage, SecretStore } from './storage.ts';
import {
  CACHE_VERSION, LAST_USER_KEY, PREFETCH_CONCURRENCY, bootKey, convIndexKey, convKey, conversationsToCache, prefetchCandidates, runLimited,
  snapshotConversation, usableBoot, usableConversation, type CachedBoot, type CachedConversation,
} from './local-cache.ts';

/** Después de la primera pintura, cuando el navegador está libre (o a los 1,2 s). */
const whenIdle = (fn: () => void) => {
  const ric = (globalThis as any).requestIdleCallback as ((cb: () => void, o?: { timeout: number }) => void) | undefined;
  if (ric) ric(fn, { timeout: 2000 }); else setTimeout(fn, 1200);
};
/** GET repetidos (misma ruta) dentro de esta ventana devuelven la misma respuesta. */
const SHARED_TTL_MS = 10_000;

export interface PendingMessage {
  clientMessageId: string;
  conversationId: string;
  body: string;
  replyTo: string | null;
  forwarded?: ForwardedInfo | null;
  /** Adjuntos ya subidos (para pintarlos mientras se envía) y adjuntos reenviados de otro mensaje. */
  attachments?: AttachmentDTO[];
  forwardAttachmentIds?: string[];
  mentions?: MentionDTO[];
  /** Tema con el que sale (docs/TEMAS.md). */
  topicId?: string | null;
  /** #grupos (tanda 1.7): conversationId + tramo del body. */
  refs?: Omit<MessageRefDTO, 'name'>[];
  /** Una sola vista (tanda 1.7). */
  viewOnce?: boolean;
  createdAt: string;
  attempts: number;
  status: 'pending' | 'sending' | 'failed';
  error?: string;
  nextAttemptAt: number;
}

export interface ConversationState {
  messages: MessageDTO[];
  /** Pintado desde la caché local mientras se pone al día (loaded aún false). */
  cached?: boolean;
  /** Cursor continuo: nunca avanza sobre un hueco. */
  lastEventSeq: number;
  hasMore: boolean;
  loaded: boolean;
  loading: boolean;
}

export type ConnectionStatus = 'offline' | 'connecting' | 'online';

export interface ClientState {
  status: 'anonymous' | 'loading' | 'ready';
  connection: ConnectionStatus;
  data: BootstrapDTO | null;
  conversations: Record<string, ConversationState>;
  pending: PendingMessage[];
  typing: Record<string, { userId: string; until: number }[]>;
  /** Asuntos conocidos por id (se cargan por espacio, conversación o «míos» y se actualizan en vivo). */
  issues: Record<string, IssueDTO>;
  /** Mensajes fijados por conversación. */
  pins: Record<string, string[]>;
  /** Temas por conversación (activos y archivados), en el orden de la fila. */
  topics: Record<string, TopicDTO[]>;
  reminders: ReminderDTO[];
  /** Mis mensajes programados por salir (y los fallidos), ordenados por hora de envío. */
  scheduled: ScheduledMessageDTO[];
  events: Record<string, CalendarEventDTO>;
  /** Correos llevados a un chat (docs/CORREO.md), por id. */
  mails: Record<string, import('@tiecoms/contracts').SharedMailDTO>;
  /** Sube cuando el puente de WhatsApp trae chats o mensajes nuevos: la pantalla vuelve a pedir la lista. */
  waRevision: number;
  /** Sube cuando cambia algún árbol de archivos visible para la persona. */
  driveRevision: number;
  /** «No molestar» guardado solo en este dispositivo porque el servidor no conoce /me/dnd (servidor viejo). */
  dndLocalOnly?: boolean;
  /** Llamada activa por conversación (null = ninguna; ausente = no se ha preguntado). */
  calls: Record<string, CallDTO | null>;
}

/** Silencio «hasta que lo reactive»: más de un año (igual que el servidor, que ahí no deja pasar menciones). */
export const isMutedForever = (until: string | null | undefined) => !!until && Date.parse(until) > Date.now() + 366 * 86_400_000;
export const isActiveUntil = (until: string | null | undefined) => !!until && Date.parse(until) > Date.now();
/** «No molestar» activo en este momento. */
export const dndActive = (s: Pick<ClientState, 'data'>) => isActiveUntil(s.data?.me.dndUntil);
/**
 * Estado de un mensaje de una sola vista para mí: los eventos en vivo llegan iguales para todos, así que se
 * calcula con el autor y openedBy (docs/TANDA-1.7.md §7). null si no es de una sola vista.
 */
export const viewOnceStateFor = (m: Pick<MessageDTO, 'viewOnce' | 'viewOnceState' | 'authorId' | 'openedBy'>, meId: string | undefined): ViewOnceState | null => {
  if (!m.viewOnce) return null;
  if (m.authorId === meId) return 'sent';
  if (m.viewOnceState === 'opened' || (m.openedBy ?? []).some((o) => o.userId === meId)) return 'opened';
  return 'unopened';
};
/** ¿El mensaje me menciona (a mí o a @todos)? */
export const mentionsUser = (m: Pick<MessageDTO, 'mentions'>, userId: string | undefined) =>
  !!userId && !!m.mentions?.some((x) => x.userId === userId || x.userId === 'all');

/** Aviso para la interfaz (notificación del sistema, sonido, toast). */
export type ClientNotice =
  /**
   * Mensaje nuevo de otra persona. No llega con «No molestar» activo ni en un chat silenciado,
   * salvo que me mencionen (`mentioned`) y el silencio no sea «hasta que lo reactive» (igual que el push).
   */
  | { kind: 'message'; conversationId: string; message: MessageDTO; mentioned: boolean; muted: boolean }
  | { kind: 'reminder'; reminder: ReminderDTO }
  /** Una reunión a la que voy empieza en `minutes` minutos. */
  | { kind: 'eventSoon'; event: CalendarEventDTO; minutes: number }
  /** El servidor descartó menciones de un mensaje propio (ids o 'all'). */
  | { kind: 'mentionsDropped'; conversationId: string; userIds: string[] }
  /** Alguien reaccionó a un mensaje mío (conversación abierta en este dispositivo). */
  | { kind: 'reaction'; conversationId: string; message: MessageDTO; userId: string; emoji: string }
  /** Me están llamando en una conversación. */
  | { kind: 'callRinging'; call: CallDTO; callerName: string; conversationTitle: string | null }
  /** Transcripción por pedazos: uno se está procesando o ya trae sus frases. */
  | { kind: 'callTranscript'; event: Extract<AccountEvent, { type: 'call.processing' | 'call.transcript' }> };

export interface ClientOptions {
  /** Origen del API, p. ej. https://app.chaggu.com. Vacío = mismo origen (web). */
  baseUrl: string;
  platform: Platform;
  deviceName: string;
  storage: KeyValueStorage;
  /** Nativo: dónde guardar el refresh token. Web: omitir (cookie httpOnly). */
  secrets?: SecretStore;
  /** Se llama con mensajes nuevos de otras personas (en conversaciones no silenciadas) y recordatorios vencidos. */
  onNotice?: (n: ClientNotice) => void;
}

const uid = () => (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36));
const base64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Cliente chaggu independiente de la interfaz. Toda la lógica de envío,
 * reintentos, orden, recuperación y no leídos vive aquí para que web,
 * escritorio y móvil se comporten igual.
 */
export class TieComsClient {
  private state: ClientState = { status: 'loading', connection: 'offline', data: null, conversations: {}, pending: [], typing: {}, issues: {}, pins: {}, topics: {}, reminders: [], scheduled: [], events: {}, mails: {}, waRevision: 0, driveRevision: 0, calls: {} };
  private listeners = new Set<() => void>();
  private accessToken: string | null = null;
  private accessExp = 0;
  private sessionGeneration = 0;
  private refreshing: Promise<boolean> | null = null;
  private socket: Socket | null = null;
  private deviceId = '';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private bootstrapTimer: ReturnType<typeof setTimeout> | null = null;
  private catchingUp = new Set<string>();
  private opening = new Map<string, { generation: number; signal?: AbortSignal; promise: Promise<void> }>();
  // ---------- Velocidad: caché local, precarga y GET compartidos ----------
  private refreshNetworkError = false;
  /** Arrancó desde la caché sin red: al volver la conexión se completa el inicio de sesión. */
  private needsLogin = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private bootDirty = false;
  private dirtyConvs = new Set<string>();
  private lastBootstrapAt = 0;
  private sharedGets = new Map<string, { generation: number; at: number; promise: Promise<unknown> }>();

  constructor(private opts: ClientOptions) {}

  // ---------- Estado observable (useSyncExternalStore) ----------
  getState = () => this.state;
  getSessionIdentity = () => `${this.sessionGeneration}:${this.state.data?.me.id ?? ''}`;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  private set(patch: Partial<ClientState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }
  private setConv(id: string, patch: Partial<ConversationState>) {
    const prev = this.state.conversations[id] ?? { messages: [], lastEventSeq: 0, hasMore: true, loaded: false, loading: false };
    const next = { ...prev, ...patch };
    this.set({ conversations: { ...this.state.conversations, [id]: next } });
    if (next.loaded && (patch.messages || patch.lastEventSeq !== undefined)) { this.dirtyConvs.add(id); this.schedulePersist(); }
  }
  private patchConversationMeta(id: string, patch: Partial<ConversationDTO>) {
    const d = this.state.data;
    if (!d) return;
    this.set({ data: { ...d, conversations: d.conversations.map((c) => (c.id === id ? { ...c, ...patch } : c)) } });
    this.bootDirty = true; this.schedulePersist();
  }

  // ---------- Caché local (stale-while-revalidate) ----------
  private schedulePersist() {
    if (this.persistTimer || !this.state.data) return;
    this.persistTimer = setTimeout(() => { this.persistTimer = null; void this.persist().catch(() => {}); }, 1500);
  }
  /** Guarda el bootstrap y las conversaciones abiertas que cambiaron (solo las ~30 más recientes). */
  private async persist() {
    const generation = this.sessionGeneration;
    const data = this.state.data;
    const userId = data?.me.id;
    if (!data || !userId || this.state.status !== 'ready') return;
    const store = this.opts.storage;
    if (this.bootDirty) {
      this.bootDirty = false;
      const boot: CachedBoot = { v: CACHE_VERSION, userId, savedAt: new Date().toISOString(), data };
      await store.set(bootKey(userId), boot);
      await store.set(LAST_USER_KEY, userId);
    }
    if (generation !== this.sessionGeneration) return;
    const keep = conversationsToCache(data);
    const keepSet = new Set(keep);
    const dirty = [...this.dirtyConvs];
    this.dirtyConvs.clear();
    for (const id of dirty) {
      const c = this.state.conversations[id];
      if (!keepSet.has(id) || !c?.loaded) continue;
      await store.set(convKey(userId, id), snapshotConversation(c));
      if (generation !== this.sessionGeneration) return;
    }
    const prev = (await store.get<string[]>(convIndexKey(userId))) ?? [];
    const cached = new Set([...prev.filter((id) => keepSet.has(id)), ...dirty.filter((id) => keepSet.has(id) && this.state.conversations[id]?.loaded)]);
    for (const id of prev) if (!keepSet.has(id)) await store.del(convKey(userId, id));
    if (generation !== this.sessionGeneration) return;
    await store.set(convIndexKey(userId), [...cached]);
  }
  private async readBootCache(): Promise<CachedBoot | null> {
    try {
      const userId = await this.opts.storage.get<string>(LAST_USER_KEY);
      return usableBoot(userId ? await this.opts.storage.get<CachedBoot>(bootKey(userId)) : null, userId);
    } catch { return null; }
  }
  private async readConvCache(id: string): Promise<CachedConversation | null> {
    const userId = this.state.data?.me.id;
    if (!userId) return null;
    try { return usableConversation(await this.opts.storage.get<CachedConversation>(convKey(userId, id)), this.state.data?.conversations.find((c) => c.id === id)); } catch { return null; }
  }

  /** GET compartido: la misma ruta en vuelo (o respondida hace menos de 10 s) no sale otra vez. */
  private sharedGet<T>(path: string, ttl = SHARED_TTL_MS): Promise<T> {
    const generation = this.sessionGeneration;
    const hit = this.sharedGets.get(path);
    if (hit && hit.generation === generation && Date.now() - hit.at < ttl) return hit.promise as Promise<T>;
    const promise = this.request<T>(path);
    this.sharedGets.set(path, { generation, at: Date.now(), promise });
    promise.catch(() => { if (this.sharedGets.get(path)?.promise === promise) this.sharedGets.delete(path); });
    return promise;
  }

  /** Precarga en segundo plano: mensajes de las conversaciones con no leídos y las fijadas (máx. 8, de 2 en 2). */
  private prefetch() {
    const generation = this.sessionGeneration;
    whenIdle(() => {
      const data = this.state.data;
      if (!data || generation !== this.sessionGeneration) return;
      const ids = prefetchCandidates(data, (id) => !!this.state.conversations[id]?.loaded || !!this.state.conversations[id]?.loading);
      void runLimited(ids, PREFETCH_CONCURRENCY, async (id) => {
        if (generation !== this.sessionGeneration) return;
        await this.openConversation(id);
      });
    });
  }

  // ---------- HTTP ----------
  private url(path: string) { return `${this.opts.baseUrl}/api/v1${path}`; }

  private async raw(path: string, init: RequestInit & { json?: unknown } = {}, auth = true): Promise<Response> {
    const headers: Record<string, string> = { 'x-tiecoms-client': this.opts.platform, 'x-tiecoms-contract': CONTRACT_VERSION };
    if (init.json !== undefined) headers['content-type'] = 'application/json';
    if (auth && this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
    return fetch(this.url(path), {
      ...init,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      credentials: 'include',
    });
  }

  private assertSession(generation: number) {
    if (generation !== this.sessionGeneration) throw new ApiRequestError(409, 'session_changed', 'La sesión cambió. Vuelve a intentarlo en la cuenta actual.');
  }

  async request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
    const generation = this.sessionGeneration;
    if (this.accessToken && Date.now() > this.accessExp - 30_000) await this.refresh();
    this.assertSession(generation);
    let res = await this.raw(path, init);
    this.assertSession(generation);
    if (res.status === 401 && (await this.refresh())) {
      this.assertSession(generation);
      res = await this.raw(path, init);
    }
    this.assertSession(generation);
    if (res.status === 401) { await this.handleSignedOut(); throw await parseError(res); }
    if (!res.ok) throw await parseError(res);
    const result = await res.json() as T;
    this.assertSession(generation);
    return result;
  }

  // ---------- Sesión ----------
  private async device(): Promise<DeviceInfo> {
    if (!this.deviceId) {
      this.deviceId = (await this.opts.storage.get<string>('device:id')) ?? uid();
      await this.opts.storage.set('device:id', this.deviceId);
    }
    return { deviceId: this.deviceId, name: this.opts.deviceName, platform: this.opts.platform, contract: CONTRACT_VERSION };
  }

  private async applyAuth(r: AuthResult) {
    this.accessToken = r.accessToken;
    this.accessExp = Date.parse(r.accessExpiresAt);
    if (r.refreshToken && this.opts.secrets) await this.opts.secrets.set(r.refreshToken);
  }

  /** Arranque: intenta reanudar la sesión guardada. */
  async start(): Promise<void> {
    this.set({ status: 'loading' });
    // Pinta de inmediato con lo último que se vio en este dispositivo; el bootstrap real lo reemplaza enseguida.
    const cached = await this.readBootCache();
    const generation = this.sessionGeneration;
    if (cached && generation === this.sessionGeneration) this.set({ status: 'ready', data: cached.data });
    if (await this.refresh()) {
      try { await this.afterLogin(); } catch (e) {
        // Sin red a mitad del arranque: se sigue con la caché y se completa al volver la conexión.
        if (!(cached && generation === this.sessionGeneration && e instanceof TypeError)) throw e;
        this.needsLogin = true;
      }
    } else if (cached && this.refreshNetworkError && generation === this.sessionGeneration) {
      this.needsLogin = true;
      this.set({ connection: 'offline' });
    } else {
      if (cached) await this.handleSignedOut();
      this.set({ status: 'anonymous' });
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.resync());
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.resync(); });
    }
  }

  async login(email: string, password: string) {
    const generation = ++this.sessionGeneration;
    this.refreshing = null;
    const res = await this.raw('/auth/login', { method: 'POST', json: { email, password, device: await this.device() } }, false);
    if (!res.ok) throw await parseError(res);
    const auth = await res.json();
    this.assertSession(generation);
    await this.applyAuth(auth);
    this.assertSession(generation);
    await this.afterLogin();
  }

  async signup(input: { name: string; email: string; password: string; orgName?: string; orgInviteToken?: string; title?: string }) {
    const generation = ++this.sessionGeneration;
    this.refreshing = null;
    const res = await this.raw('/auth/signup', { method: 'POST', json: { ...input, device: await this.device() } }, false);
    if (!res.ok) throw await parseError(res);
    const auth = await res.json();
    this.assertSession(generation);
    await this.applyAuth(auth);
    this.assertSession(generation);
    await this.afterLogin();
  }

  /**
   * URL para entrar con Google o Microsoft. Se abre en el navegador (en apps, el del
   * sistema); el verifier PKCE queda guardado hasta que vuelva el código.
   */
  async ssoStartUrl(provider: 'google' | 'microsoft', opts: { orgInviteToken?: string; orgName?: string; next?: string } = {}) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const verifier = base64url(bytes);
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    await this.opts.storage.set('sso:verifier', verifier);
    const q = new URLSearchParams({ platform: this.opts.platform, code_challenge: challenge, code_challenge_method: 'S256' });
    if (opts.orgInviteToken) q.set('org', opts.orgInviteToken);
    if (opts.orgName) q.set('org_name', opts.orgName);
    if (opts.next) q.set('next', opts.next);
    return `${this.url(`/auth/${provider}/start`)}?${q}`;
  }

  /** Canjea el código que devolvió el servidor tras Google/Microsoft. */
  async ssoComplete(code: string) {
    const generation = ++this.sessionGeneration;
    this.refreshing = null;
    const codeVerifier = await this.opts.storage.get<string>('sso:verifier');
    await this.opts.storage.del('sso:verifier');
    if (!codeVerifier) throw Object.assign(new Error('Vuelve a iniciar sesión desde esta app.'), { code: 'sso_state' });
    const res = await this.raw('/auth/sso/exchange', { method: 'POST', json: { code, codeVerifier, device: await this.device() } }, false);
    if (!res.ok) throw await parseError(res);
    const auth = await res.json();
    this.assertSession(generation);
    await this.applyAuth(auth);
    this.assertSession(generation);
    await this.afterLogin();
  }

  /** Refresco con vuelo único; en navegador se serializa entre pestañas con Web Locks. */
  private refresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    const generation = this.sessionGeneration;
    const run = async () => {
      const stored = this.opts.secrets ? await this.opts.secrets.get() : undefined;
      if (this.opts.secrets && !stored) return false;
      const res = await this.raw('/auth/refresh', { method: 'POST', json: stored ? { refreshToken: stored } : {} }, false).catch(() => null);
      if (generation !== this.sessionGeneration) return false;
      this.refreshNetworkError = !res;
      if (!res) return !!this.accessToken; // sin red: conserva la sesión local
      if (!res.ok) { this.accessToken = null; return false; }
      const auth = await res.json();
      if (generation !== this.sessionGeneration) return false;
      await this.applyAuth(auth);
      return generation === this.sessionGeneration;
    };
    const locks = (globalThis.navigator as any)?.locks;
    const pending = (locks ? locks.request('tiecoms-refresh', run) : run()).finally(() => { if (this.refreshing === pending) this.refreshing = null; });
    this.refreshing = pending;
    return pending;
  }

  async logout() {
    // Capture this session's token before clearing it; late responses cannot restore its state.
    const logout = this.raw('/auth/logout', { method: 'POST', json: {} }).catch(() => null);
    await this.handleSignedOut();
    await logout;
  }

  private async handleSignedOut() {
    const userId = this.state.data?.me.id;
    ++this.sessionGeneration;
    this.refreshing = null;
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    this.accessToken = null;
    if (this.bootstrapTimer) clearTimeout(this.bootstrapTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.bootstrapTimer = null; this.flushTimer = null;
    for (const timer of this.readTimers.values()) clearTimeout(timer);
    this.readTimers.clear();
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null; this.bootDirty = false; this.dirtyConvs.clear(); this.sharedGets.clear(); this.needsLogin = false; this.lastBootstrapAt = 0;
    this.state = { status: 'anonymous', connection: 'offline', data: null, conversations: {}, pending: [], typing: {}, issues: {}, pins: {}, topics: {}, reminders: [], scheduled: [], events: {}, mails: {}, waRevision: 0, driveRevision: 0, calls: {} };
    this.listeners.forEach((l) => l());
    await this.opts.secrets?.set(null);
    if (userId) {
      await this.opts.storage.clearPrefix(`u:${userId}:`);
      if ((await this.opts.storage.get<string>(LAST_USER_KEY).catch(() => undefined)) === userId) await this.opts.storage.del(LAST_USER_KEY);
    }
  }

  private async afterLogin() {
    const generation = this.sessionGeneration;
    await this.loadBootstrap();
    this.assertSession(generation);
    const me = this.state.data!.me.id;
    const pending = (await this.opts.storage.get<PendingMessage[]>(`u:${me}:outbox`)) ?? [];
    this.assertSession(generation);
    this.set({ status: 'ready', pending: pending.map((p) => ({ ...p, status: p.status === 'sending' ? 'pending' : p.status })) });
    this.needsLogin = false;
    this.connect();
    this.scheduleFlush(0);
    // Lo no crítico, después de la primera pintura. Grupos muestra los asuntos abiertos bajo cada grupo.
    whenIdle(() => {
      if (generation !== this.sessionGeneration) return;
      void this.loadReminders().catch(() => {});
      void this.loadScheduled().catch(() => {});
      void this.loadIssues({ open: true }).catch(() => {});
    });
    this.prefetch();
  }

  // ---------- Snapshot ----------
  async loadBootstrap() {
    const generation = this.sessionGeneration;
    const data = await this.request<BootstrapDTO>('/bootstrap');
    const dndLocalOnly = data.me.dndUntil === undefined;
    if (dndLocalOnly) {
      // Servidor anterior a «No molestar»: se usa lo guardado en este dispositivo.
      const local = await this.opts.storage.get<string | null>(`u:${data.me.id}:dnd`).catch(() => null);
      data.me.dndUntil = isActiveUntil(local) ? local : null;
    }
    this.assertSession(generation);
    this.lastBootstrapAt = Date.now();
    this.set({ data, dndLocalOnly });
    this.bootDirty = true; this.schedulePersist();
    // Conversaciones que ya no están en mi alcance: se purgan de la caché local.
    const allowed = new Set(data.conversations.map((c) => c.id));
    const kept: Record<string, ConversationState> = {};
    for (const [id, s] of Object.entries(this.state.conversations)) if (allowed.has(id)) kept[id] = s;
    this.set({ conversations: kept });
    return data;
  }

  private scheduleBootstrap() {
    if (this.bootstrapTimer) return;
    this.bootstrapTimer = setTimeout(() => { this.bootstrapTimer = null; void this.loadBootstrap().catch(() => {}); }, 250);
  }

  // ---------- Tiempo real ----------
  private connect() {
    if (this.socket) return;
    const s = io(this.opts.baseUrl || undefined, {
      path: '/api/socket.io',
      transports: ['websocket', 'polling'],
      auth: (cb) => {
        void (async () => {
          if (!this.accessToken || Date.now() > this.accessExp - 30_000) await this.refresh();
          cb({ token: this.accessToken });
        })();
      },
      reconnectionDelay: 500,
      reconnectionDelayMax: 8000,
      randomizationFactor: 0.5,
    });
    this.socket = s;
    this.set({ connection: 'connecting' });
    s.on('ready', () => {
      this.set({ connection: 'online' });
      void this.resync();
    });
    s.on('disconnect', () => this.set({ connection: 'offline' }));
    s.on('connect_error', async (err) => {
      this.set({ connection: 'offline' });
      if (err.message === 'unauthorized' && !(await this.refresh())) await this.handleSignedOut();
    });
    s.on(SOCKET_EVENTS.conversationEvent, (e: ConversationEvent) => this.onConversationEvent(e));
    s.on(SOCKET_EVENTS.accountEvent, (e: AccountEvent) => this.onAccountEvent(e));
    s.on(SOCKET_EVENTS.typing, (e: { conversationId: string; userId: string }) => {
      if (e.userId === this.state.data?.me.id) return;
      const now = Date.now();
      const list = (this.state.typing[e.conversationId] ?? []).filter((t) => t.until > now && t.userId !== e.userId);
      this.set({ typing: { ...this.state.typing, [e.conversationId]: [...list, { userId: e.userId, until: now + 4000 }] } });
    });
  }

  /** Tras reconectar o volver del segundo plano: snapshot + recuperación de huecos + cola. */
  async resync() {
    if (this.state.status !== 'ready') return;
    if (this.needsLogin) {
      // Se abrió sin red desde la caché: ahora sí se inicia la sesión.
      if (await this.refresh()) await this.afterLogin().catch(() => {});
      else if (!this.refreshNetworkError) await this.handleSignedOut();
      return;
    }
    // Lo que se pidió hace nada (p. ej. el bootstrap de afterLogin y el «ready» del socket) no se repite.
    this.sharedGets.clear();
    try {
      if (Date.now() - this.lastBootstrapAt > 5000) await this.loadBootstrap();
      for (const c of this.state.data?.conversations ?? []) {
        const local = this.state.conversations[c.id];
        if (local?.loaded && c.lastEventSeq > local.lastEventSeq) void this.catchUp(c.id);
      }
    } catch {}
    this.scheduleFlush(0);
  }

  private onAccountEvent(e: AccountEvent) {
    if (e.type === 'scope.changed') { this.scheduleBootstrap(); void this.loadIssues({ open: true }).catch(() => {}); }
    if (e.type === 'prefs.updated') this.scheduleBootstrap();
    if (e.type === 'me.dnd') this.patchMe({ dndUntil: e.dndUntil });
    // Asuntos restringidos ('org' o 'private') llegan por la cuenta, no por la conversación.
    if (e.type === 'issue.updated') { this.putIssues([e.issue]); this.recountIssues(e.issue.conversationId); }
    if (e.type === 'issue.personal') this.putIssues([e.issue]);
    if (e.type === 'issue.hidden') {
      const next = { ...this.state.issues }; delete next[e.issueId];
      this.set({ issues: next }); this.recountIssues(e.conversationId);
    }
    if (e.type === 'me.sleep') this.patchMe({ sleep: e.sleep });
    if (e.type === 'call.updated') this.putCall(e.call);
    if (e.type === 'call.processing' || e.type === 'call.transcript') this.opts.onNotice?.({ kind: 'callTranscript', event: e });
    if (e.type === 'call.ringing') {
      this.putCall(e.call);
      if (!dndActive(this.state)) this.opts.onNotice?.({ kind: 'callRinging', call: e.call, callerName: e.callerName, conversationTitle: e.conversationTitle });
    }
    if (e.type === 'reminders.changed') void this.loadReminders().catch(() => {});
    if (e.type === 'scheduled.updated') this.putScheduled(e.scheduled);
    if (e.type === 'whatsapp.updated') this.set({ waRevision: this.state.waRevision + 1 });
    if (e.type === 'drive.updated') this.set({ driveRevision: this.state.driveRevision + 1 });
    if (e.type === 'reminder.due') {
      this.set({ reminders: [...this.state.reminders.filter((r) => r.id !== e.reminder.id), e.reminder].sort((a, b) => a.remindAt.localeCompare(b.remindAt)) });
      this.opts.onNotice?.({ kind: 'reminder', reminder: e.reminder });
    }
    if (e.type === 'event.soon') {
      this.putEvents([e.event]);
      this.opts.onNotice?.({ kind: 'eventSoon', event: e.event, minutes: e.minutes });
    }
    if (e.type === 'read.updated') {
      const c = this.state.data?.conversations.find((x) => x.id === e.conversationId);
      if (c && e.seq > c.lastReadSeq) this.patchConversationMeta(c.id, { lastReadSeq: e.seq, unread: Math.max(0, c.lastMessageSeq - Math.max(e.seq, c.historyFromSeq)), ...(e.seq >= c.lastMessageSeq ? { unreadMentions: 0 } : {}) });
    }
  }

  private onConversationEvent(e: ConversationEvent) {
    const local = this.state.conversations[e.conversationId];
    const meta = this.state.data?.conversations.find((c) => c.id === e.conversationId);
    if (!meta) { this.scheduleBootstrap(); return; }
    // Los asuntos se actualizan aunque la conversación no esté abierta.
    if (e.type === 'issue.updated') { this.putIssues([e.issue]); this.recountIssues(e.conversationId); }
    if (e.type === 'pins.changed') this.set({ pins: { ...this.state.pins, [e.conversationId]: e.messageIds } });
    if (e.type === 'topics.changed') this.set({ topics: { ...this.state.topics, [e.conversationId]: e.topics } });
    if (e.type === 'calendar.updated') this.set({ events: { ...this.state.events, [e.event.id]: e.event } });
    // En vivo llega igual para todos: conservo mi respuesta programada (solo la ve quien la programó).
    if (e.type === 'mail.updated') this.putMail({ ...e.email, scheduledReply: e.email.status === 'scheduled' ? this.state.mails[e.email.id]?.scheduledReply ?? null : null, webLink: this.state.mails[e.email.id]?.webLink ?? null });
    if (e.type === 'call.updated') this.putCall(e.call);
    if (e.type === 'message.created' && e.message.authorId !== this.state.data?.me.id && e.message.kind === 'text' && !dndActive(this.state)) {
      const muted = isActiveUntil(meta.mutedUntil);
      const mentioned = mentionsUser(e.message, this.state.data?.me.id);
      if (!muted || (mentioned && !isMutedForever(meta.mutedUntil))) this.opts.onNotice?.({ kind: 'message', conversationId: e.conversationId, message: e.message, mentioned, muted });
    }
    if (e.type === 'message.created') this.bumpMeta(e.message);
    if (!local?.loaded) {
      this.patchConversationMeta(e.conversationId, { lastEventSeq: Math.max(meta.lastEventSeq, e.eventSeq) });
      return;
    }
    if (e.eventSeq <= local.lastEventSeq) return; // duplicado de transporte
    if (e.eventSeq > local.lastEventSeq + 1) { void this.catchUp(e.conversationId); return; } // hueco
    this.applyEvent(e);
  }

  private bumpMeta(m: MessageDTO) {
    const c = this.state.data?.conversations.find((x) => x.id === m.conversationId);
    if (!c || m.seq <= c.lastMessageSeq) return;
    const mine = m.authorId === this.state.data?.me.id;
    const lastReadSeq = mine && m.seq === c.lastMessageSeq + 1 && Math.max(c.lastReadSeq, c.historyFromSeq) >= c.lastMessageSeq ? m.seq : c.lastReadSeq;
    this.patchConversationMeta(c.id, {
      lastMessageSeq: m.seq, lastMessageAt: m.createdAt, lastMessagePreview: m.viewOnce ? '①' : m.body.slice(0, 140), lastReadSeq,
      // La pestaña «Enlaces» suma los enlaces nuevos sin esperar otro bootstrap.
      ...(m.kind === 'text' && c.linkCount !== undefined ? { linkCount: c.linkCount + new Set(m.body.match(/\bhttps?:\/\/[^\s<>"'`]+/gi) ?? []).size } : {}),
      unread: Math.max(0, m.seq - Math.max(lastReadSeq, c.historyFromSeq)),
    });
    // Reordena para que la conversación con actividad suba.
    const d = this.state.data!;
    this.set({ data: { ...d, conversations: [...d.conversations].sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '')) } });
  }

  private applyEvent(e: ConversationEvent) {
    const local = this.state.conversations[e.conversationId]!;
    let messages = local.messages;
    if (e.type === 'message.updated') this.noticeReaction(local.messages.find((m) => m.id === e.message.id), e.message);
    if (e.type === 'message.created' || e.type === 'message.updated') messages = upsertMessage(messages, e.message);
    if (e.type === 'members.changed') { this.patchConversationMeta(e.conversationId, { memberIds: e.memberIds, ...(e.adminIds ? { adminIds: e.adminIds } : {}) }); this.scheduleBootstrap(); }
    if (e.type === 'issue.updated') this.putIssues([e.issue]);
    if (e.type === 'message.updated') this.patchPreviewIfLast(e.message);
    this.setConv(e.conversationId, { messages, lastEventSeq: e.eventSeq });
    if (e.type === 'message.created') this.dropPending(e.message);
  }

  /** Pone al día una conversación pintada desde la caché. false = hay que pedir la página (cursor viejo o error). */
  private async catchUpFromCache(conversationId: string, generation: number, signal?: AbortSignal): Promise<boolean> {
    try {
      for (let guard = 0; guard < 25; guard++) {
        const local = this.state.conversations[conversationId];
        if (!local || generation !== this.sessionGeneration) return false;
        const page = await this.request<EventsPage>(`/conversations/${conversationId}/events?after=${local.lastEventSeq}&limit=200`, { signal });
        if (generation !== this.sessionGeneration || page.resetRequired) return false;
        for (const e of page.events) this.applyEvent(e);
        if (page.events.length < 200) return true;
      }
      return false;
    } catch (e: any) { if (e?.name === 'AbortError') throw e; return false; }
  }

  private async catchUp(conversationId: string) {
    if (this.catchingUp.has(conversationId)) return;
    this.catchingUp.add(conversationId);
    try {
      for (;;) {
        const local = this.state.conversations[conversationId];
        if (!local) return;
        const page = await this.request<EventsPage>(`/conversations/${conversationId}/events?after=${local.lastEventSeq}&limit=200`);
        if (page.resetRequired) { await this.openConversation(conversationId, true); return; }
        for (const e of page.events) this.applyEvent(e);
        if (!page.events.length || page.events.length < 200) return;
      }
    } catch {} finally { this.catchingUp.delete(conversationId); }
  }

  // ---------- Llamadas (Chime SDK) ----------
  private putCall(call: CallDTO) {
    const cur = this.state.calls[call.conversationId];
    // Una llamada terminada no pisa a otra más nueva que ya esté en curso.
    if (call.endedAt && cur && cur.id !== call.id) return;
    this.set({ calls: { ...this.state.calls, [call.conversationId]: call.endedAt ? null : call } });
  }
  async loadCall(conversationId: string) {
    const r = await this.request<{ call: CallDTO | null }>(`/conversations/${conversationId}/call`);
    this.set({ calls: { ...this.state.calls, [conversationId]: r.call } });
    return r.call;
  }
  /** Empieza o entra a la llamada de la conversación: devuelve lo que necesita el SDK. */
  async startCall(conversationId: string, kind: CallKind) {
    const r = await this.request<CallJoinDTO>(`/conversations/${conversationId}/call`, { method: 'POST', json: { kind } });
    this.putCall(r.call);
    return r;
  }
  async joinCall(callId: string) {
    const r = await this.request<CallJoinDTO>(`/calls/${callId}/join`, { method: 'POST', json: {} });
    this.putCall(r.call);
    return r;
  }
  /** Suma personas a la llamada en curso (les suena aunque no estén en el chat). */
  async inviteToCall(callId: string, userIds: string[]) {
    const r = await this.request<{ call: CallDTO }>(`/calls/${callId}/invite`, { method: 'POST', json: { userIds } });
    this.putCall(r.call);
    return r.call;
  }
  callHeartbeat(callId: string) { return this.request<{ ok: true }>(`/calls/${callId}/heartbeat`, { method: 'POST', json: {} }); }
  async leaveCall(callId: string, forAll = false) {
    const r = await this.request<{ call: CallDTO }>(`/calls/${callId}/${forAll ? 'end' : 'leave'}`, { method: 'POST', json: {} });
    this.putCall(r.call);
    return r.call;
  }
  async setCallTranscription(callId: string, on: boolean, aiSummary = false) {
    const r = await this.request<{ call: CallDTO }>(`/calls/${callId}/transcription`, { method: 'POST', json: { on, aiSummary } });
    this.putCall(r.call);
    return r.call;
  }
  sendCallTranscript(callId: string, segments: CallTranscriptSegmentInput[]) {
    return this.request<{ saved: number }>(`/calls/${callId}/transcript`, { method: 'POST', json: { segments } });
  }
  /** Un pedazo del micrófono propio para transcribir (Groq). segId lo genera el cliente: reintentar no duplica. */
  sendCallAudio(callId: string, chunk: Blob, meta: { segId: string; offsetMs: number; durationMs: number }) {
    return this.request<{ saved: number; segments: CallTranscriptSegmentDTO[] }>(`/calls/${callId}/audio`, {
      method: 'POST', body: chunk,
      headers: { 'content-type': 'application/octet-stream', 'x-file-type': chunk.type || 'audio/webm', 'x-seg-id': meta.segId, 'x-offset-ms': String(Math.round(meta.offsetMs)), 'x-duration-ms': String(Math.round(meta.durationMs)) },
    });
  }
  callTranscript(callId: string) { return this.request<CallTranscriptDTO>(`/calls/${callId}/transcript`); }
  /** Sonido predeterminado y tono de llamada (optimista). */
  async setSounds(p: { messageSound?: SoundChoice | null; ringtone?: Ringtone | null }) {
    this.patchMe(p);
    await this.request('/me/sounds', { method: 'PUT', json: p });
  }
  callHistory(before?: string) { return this.request<{ calls: CallHistoryItemDTO[]; hasMore: boolean }>(`/calls?limit=30${before ? `&before=${encodeURIComponent(before)}` : ''}`); }
  shareCall(callId: string, conversationId: string, what: 'summary' | 'transcript' | 'both') {
    return this.request<{ message: MessageDTO }>(`/calls/${callId}/share`, { method: 'POST', json: { conversationId, what } });
  }

  // ---------- Conversaciones ----------
  async openConversation(id: string, force = false, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const generation = this.sessionGeneration;
    // A second caller must await the real load, not interpret `loading` as success.
    const active = this.opening.get(id);
    if (active && active.generation === generation && !active.signal?.aborted) {
      if (!signal) return active.promise;
      // Cancelling a follower stops its wait, without cancelling the owner's fetch.
      return new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
        active.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
    }
    const local = this.state.conversations[id];
    if (local?.loaded && !force) { void this.catchUp(id); return; }
    const operation = { generation, signal, promise: Promise.resolve() };
    this.opening.set(id, operation);
    operation.promise = Promise.resolve().then(async () => {
      try {
        this.assertSession(generation);
        signal?.throwIfAborted();
        // Caché local: se pinta enseguida (loaded sigue en false) y se pone al día con los eventos. Solo si el
        // servidor no pide empezar de cero, queda cargada sin pedir la página de mensajes.
        const cached = !force && !local?.messages.length ? await this.readConvCache(id) : null;
        this.assertSession(generation);
        if (cached) {
          this.setConv(id, { messages: cached.messages, hasMore: cached.hasMore, lastEventSeq: cached.lastEventSeq, loaded: false, loading: true, cached: true });
          if (await this.catchUpFromCache(id, generation, signal)) {
            this.setConv(id, { loaded: true, loading: false, cached: false });
            void this.catchUp(id);
            return;
          }
          this.assertSession(generation);
          signal?.throwIfAborted();
        }
        this.setConv(id, { loading: true });
        const page = await this.request<{ messages: MessageDTO[]; hasMore: boolean; lastEventSeq: number }>(`/conversations/${id}/messages?limit=50`, { signal });
        this.assertSession(generation);
        signal?.throwIfAborted();
        this.setConv(id, { messages: page.messages, hasMore: page.hasMore, lastEventSeq: page.lastEventSeq, loaded: true, loading: false, cached: false });
        void this.catchUp(id);
      } catch (e) {
        // An old/aborted request must not clear a newer load or another account's state.
        if (generation === this.sessionGeneration && this.opening.get(id) === operation) this.setConv(id, { loading: false });
        throw e;
      } finally {
        if (this.opening.get(id) === operation) this.opening.delete(id);
      }
    });
    return operation.promise;
  }

  async loadOlder(id: string) {
    const local = this.state.conversations[id];
    if (!local?.loaded || !local.hasMore || local.loading) return false;
    const before = local.messages[0]?.seq;
    if (!before) return false;
    const generation = this.sessionGeneration;
    this.setConv(id, { loading: true });
    try {
      const page = await this.request<{ messages: MessageDTO[]; hasMore: boolean }>(`/conversations/${id}/messages?before=${before}&limit=50`);
      const cur = this.state.conversations[id]!;
      const older = page.messages.filter((m) => m.seq < before);
      this.setConv(id, { messages: [...older, ...cur.messages], hasMore: page.hasMore, loading: false });
      return older.length > 0 || !page.hasMore;
    } catch { if (generation === this.sessionGeneration) this.setConv(id, { loading: false }); return false; }
  }

  private readTimers = new Map<string, ReturnType<typeof setTimeout>>();
  markRead(id: string, visibleThrough: number) {
    const c = this.state.data?.conversations.find((x) => x.id === id);
    const seq = Math.min(visibleThrough, c?.lastMessageSeq ?? 0);
    if (!c || seq <= c.lastReadSeq) return;
    const generation = this.sessionGeneration;
    clearTimeout(this.readTimers.get(id));
    this.readTimers.set(id, setTimeout(() => {
      this.readTimers.delete(id);
      if (generation !== this.sessionGeneration) return;
      void this.request<{ lastReadSeq: number }>(`/conversations/${id}/read`, { method: 'POST', json: { seq } })
        .then((result) => this.applyConfirmedRead(id, result.lastReadSeq)).catch(() => {});
    }, 400));
  }

  typing(conversationId: string) { this.socket?.emit(SOCKET_EVENTS.typing, { conversationId }); }

  // ---------- Envío con cola persistente ----------
  async send(conversationId: string, body: string, replyTo: string | null = null, forwarded: ForwardedInfo | null = null,
    extra: { attachments?: AttachmentDTO[]; forwardAttachmentIds?: string[]; mentions?: MentionDTO[]; topicId?: string | null; refs?: Omit<MessageRefDTO, 'name'>[]; viewOnce?: boolean } = {}) {
    const text = body.trim();
    // Las menciones (y los #grupos) se miden sobre el texto recortado (como lo guarda el servidor).
    const lead = body.length - body.trimStart().length;
    const mentions = (extra.mentions ?? []).map((m) => ({ ...m, start: m.start - lead })).filter((m) => m.start >= 0 && m.start + m.length <= text.length);
    const refs = (extra.refs ?? []).map((r) => ({ ...r, start: r.start - lead })).filter((r) => r.start >= 0 && r.start + r.length <= text.length);
    if (!text && !extra.attachments?.length && !extra.forwardAttachmentIds?.length) return;
    const p: PendingMessage = {
      clientMessageId: uid(), conversationId, body: text, replyTo, forwarded, createdAt: new Date().toISOString(),
      ...(extra.attachments?.length ? { attachments: extra.attachments } : {}),
      ...(extra.forwardAttachmentIds?.length ? { forwardAttachmentIds: extra.forwardAttachmentIds } : {}),
      ...(mentions.length ? { mentions } : {}),
      ...(extra.topicId ? { topicId: extra.topicId } : {}),
      ...(refs.length ? { refs } : {}),
      ...(extra.viewOnce ? { viewOnce: true } : {}),
      attempts: 0, status: 'pending', nextAttemptAt: 0,
    };
    // Primero se guarda localmente: si la app se cierra, el mensaje sigue en la cola.
    await this.savePending([...this.state.pending, p]);
    this.scheduleFlush(0);
  }

  retry(clientMessageId: string) {
    void this.savePending(this.state.pending.map((p) => (p.clientMessageId === clientMessageId ? { ...p, status: 'pending', nextAttemptAt: 0, error: undefined } : p)));
    this.scheduleFlush(0);
  }

  discard(clientMessageId: string) {
    void this.savePending(this.state.pending.filter((p) => p.clientMessageId !== clientMessageId));
  }

  private async savePending(list: PendingMessage[]) {
    this.set({ pending: list });
    const me = this.state.data?.me.id;
    if (me) await this.opts.storage.set(`u:${me}:outbox`, list);
  }

  private dropPending(m: MessageDTO) {
    if (m.authorId !== this.state.data?.me.id || !m.clientMessageId) return;
    if (this.state.pending.some((p) => p.clientMessageId === m.clientMessageId)) {
      void this.savePending(this.state.pending.filter((p) => p.clientMessageId !== m.clientMessageId));
    }
  }

  private scheduleFlush(ms: number) {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush(); }, ms);
  }

  private flushing = false;
  private async flush() {
    if (this.flushing || this.state.status !== 'ready') return;
    this.flushing = true;
    try {
      // En orden: dentro de una conversación, los mensajes salen uno tras otro.
      for (const p of [...this.state.pending]) {
        if (p.status === 'failed' || p.nextAttemptAt > Date.now()) continue;
        this.updatePending(p.clientMessageId, { status: 'sending' });
        try {
          const message = await this.deliver(p);
          const local = this.state.conversations[p.conversationId];
          if (local?.loaded) this.setConv(p.conversationId, { messages: upsertMessage(local.messages, message) });
          this.bumpMeta(message);
          await this.savePending(this.state.pending.filter((x) => x.clientMessageId !== p.clientMessageId));
        } catch (e: any) {
          const permanent = e instanceof ApiRequestError && e.permanent;
          const attempts = p.attempts + 1;
          const backoff = Math.min(30_000, 500 * 2 ** attempts) * (0.5 + Math.random());
          this.updatePending(p.clientMessageId, permanent
            ? { status: 'failed', attempts, error: e.message }
            : { status: 'pending', attempts, nextAttemptAt: Date.now() + backoff });
          if (!permanent) { this.scheduleFlush(backoff); break; }
        }
      }
    } finally {
      this.flushing = false;
      await this.savePending(this.state.pending);
    }
  }

  private updatePending(id: string, patch: Partial<PendingMessage>) {
    this.set({ pending: this.state.pending.map((p) => (p.clientMessageId === id ? { ...p, ...patch } : p)) });
  }

  /** Socket con ACK si está conectado; HTTP como respaldo. Mismo clientMessageId = idempotente. */
  private async deliver(p: PendingMessage): Promise<MessageDTO> {
    const files = {
      ...(p.attachments?.length ? { attachmentIds: p.attachments.map((a) => a.id) } : {}),
      ...(p.forwardAttachmentIds?.length ? { forwardAttachmentIds: p.forwardAttachmentIds } : {}),
      ...(p.mentions?.length ? { mentions: p.mentions } : {}),
      ...(p.topicId ? { topicId: p.topicId } : {}),
      ...(p.refs?.length ? { refs: p.refs } : {}),
      ...(p.viewOnce ? { viewOnce: true } : {}),
    };
    const payload = { conversationId: p.conversationId, clientMessageId: p.clientMessageId, body: p.body, replyTo: p.replyTo, forwarded: p.forwarded ?? null, ...files };
    if (this.socket?.connected) {
      try {
        const r: any = await this.socket.timeout(8000).emitWithAck(SOCKET_EVENTS.send, payload);
        if (r?.ok) { this.noteDropped(p.conversationId, r.droppedMentions); return r.message; }
        const status = r?.error?.code === 'forbidden' ? 403 : r?.error?.code === 'not_found' ? 404 : r?.error?.code === 'conflict' || r?.error?.code === 'view_once' ? 409 : r?.error?.code === 'bad_request' ? 400 : 503;
        throw new ApiRequestError(status, r?.error?.code ?? 'error', r?.error?.message ?? 'No se pudo enviar');
      } catch (e) {
        if (e instanceof ApiRequestError) throw e;
        // Timeout del socket: se reintenta por HTTP con el mismo identificador.
      }
    }
    const r = await this.request<{ message: MessageDTO; droppedMentions?: string[] }>(`/conversations/${p.conversationId}/messages`, {
      method: 'POST', json: { clientMessageId: p.clientMessageId, body: p.body, replyTo: p.replyTo, forwarded: p.forwarded ?? null, ...files },
    });
    this.noteDropped(p.conversationId, r.droppedMentions);
    return r.message;
  }

  private noteDropped(conversationId: string, ids: unknown) {
    if (Array.isArray(ids) && ids.length) this.opts.onNotice?.({ kind: 'mentionsDropped', conversationId, userIds: ids.map(String) });
  }

  // ---------- Asuntos ----------
  private putIssues(list: IssueDTO[]) {
    if (!list.length) return;
    const next = { ...this.state.issues };
    for (const i of list) {
      if (i.conversationId === null && i.ownerId !== this.state.data?.me.id) continue;
      next[i.id] = i;
    }
    this.set({ issues: next });
  }
  private recountIssues(conversationId: string | null) {
    if (!conversationId) return; // personal: no cuenta en ningún chat
    const n = Object.values(this.state.issues).filter((i) => i.conversationId === conversationId && i.status !== 'done' && i.status !== 'cancelled').length;
    this.patchConversationMeta(conversationId, { openIssues: n });
  }
  async loadIssues(filter: { workspaceId?: string; conversationId?: string; mine?: boolean; open?: boolean } = {}) {
    const q = new URLSearchParams();
    if (filter.workspaceId) q.set('workspaceId', filter.workspaceId);
    if (filter.conversationId) q.set('conversationId', filter.conversationId);
    if (filter.mine) q.set('mine', '1');
    if (filter.open) q.set('open', '1');
    const r = await this.sharedGet<{ issues: IssueDTO[] }>(`/issues?${q}`);
    this.putIssues(r.issues);
    return r.issues;
  }
  /** Asunto personal: sin conversación, solo lo veo yo. */
  async createPersonalIssue(input: { title: string; dueDate?: string | null }) {
    const i = await this.request<IssueDTO>('/issues', { method: 'POST', json: input });
    this.putIssues([i]);
    return i;
  }
  // ---------- Reuniones (Meet, Teams, Zoom) ----------
  async meetingConnections() { return (await this.request<{ connections: MeetingConnectionDTO[] }>('/meetings/connections')).connections; }
  async connectMeetingProvider(provider: MeetingProvider, proofChallenge: string, platform: 'web' | 'ios' | 'android' | 'desktop' = 'web') {
    return this.request<{ url: string }>(`/meetings/connect/${provider}`, { method: 'POST', json: { platform, proofChallenge } });
  }
  async confirmMeetingProvider(receipt: string, proofVerifier: string) {
    return this.request<{ ok: true; provider: MeetingProvider }>('/meetings/connect/confirm', { method: 'POST', json: { receipt, proofVerifier } });
  }
  async disconnectMeetingProvider(provider: MeetingProvider) { await this.request(`/meetings/connections/${provider}`, { method: 'DELETE' }); }
  async createMeeting(input: { provider: MeetingProvider; conversationId?: string | null; idempotencyKey: string; title: string; startsAt?: string | null; durationMin: number; timezone: string; share: boolean }) {
    return this.request<MeetingDTO>('/meetings', { method: 'POST', json: input });
  }
  /** Tarea hija de un asunto (en su chat o, con conversationId, en un sidechat que salió de él). */
  async createChildIssue(parentId: string, input: { title: string; ownerId?: string | null; dueDate?: string | null; visibility?: IssueVisibility; viewerIds?: string[]; conversationId?: string }) {
    const i = await this.request<IssueDTO>(`/issues/${parentId}/children`, { method: 'POST', json: input });
    this.putIssues([i]); this.recountIssues(i.conversationId);
    return i;
  }
  async createIssue(conversationId: string, input: { title: string; ownerId?: string | null; dueDate?: string | null; originMessageId?: string | null; visibility?: IssueVisibility; viewerIds?: string[]; parentIssueId?: string | null; topicId?: string | null }) {
    const i = await this.request<IssueDTO>(`/conversations/${conversationId}/issues`, { method: 'POST', json: input });
    this.putIssues([i]); this.recountIssues(conversationId);
    return i;
  }
  async updateIssue(id: string, patch: Partial<Pick<IssueDTO, 'title' | 'status' | 'ownerId' | 'dueDate' | 'waitingOnOrgId' | 'visibility' | 'viewerIds' | 'topicId'>>) {
    const i = await this.request<IssueDTO>(`/issues/${id}`, { method: 'PATCH', json: patch });
    this.putIssues([i]); this.recountIssues(i.conversationId);
    return i;
  }
  async issueDetail(id: string) {
    const r = await this.request<{ issue: IssueDTO; events: IssueEventDTO[]; children?: IssueDTO[] }>(`/issues/${id}`);
    this.putIssues([r.issue, ...(r.children ?? [])]);
    return r;
  }
  async commentIssue(id: string, body: string) {
    const i = await this.request<IssueDTO>(`/issues/${id}/comments`, { method: 'POST', json: { body } });
    this.putIssues([i]);
    return i;
  }

  // ---------- Preferencias, fijados, no leído, edición ----------
  async setConversationPrefs(id: string, prefs: { pinned?: boolean; mutedUntil?: string | null; sound?: SoundChoice | null }) {
    const patch: Partial<ConversationDTO> = {};
    if (prefs.pinned !== undefined) patch.pinnedAt = prefs.pinned ? new Date().toISOString() : null;
    if (prefs.mutedUntil !== undefined) patch.mutedUntil = prefs.mutedUntil;
    if (prefs.sound !== undefined) patch.sound = prefs.sound;
    this.patchConversationMeta(id, patch); // optimista; el servidor confirma
    await this.request(`/conversations/${id}/prefs`, { method: 'PUT', json: prefs });
  }
  async setWorkspacePinned(id: string, pinned: boolean) {
    const d = this.state.data;
    if (d) this.set({ data: { ...d, workspaces: d.workspaces.map((w) => (w.id === id ? { ...w, pinnedAt: pinned ? new Date().toISOString() : null } : w)) } });
    await this.request(`/workspaces/${id}/prefs`, { method: 'PUT', json: { pinned } });
  }
  async markUnread(conversationId: string, seq: number) {
    const r = await this.request<{ lastReadSeq: number }>(`/conversations/${conversationId}/unread`, { method: 'POST', json: { seq } });
    const c = this.state.data?.conversations.find((x) => x.id === conversationId);
    if (c) this.patchConversationMeta(conversationId, { lastReadSeq: r.lastReadSeq, unread: Math.max(0, c.lastMessageSeq - Math.max(r.lastReadSeq, c.historyFromSeq)) });
  }
  /** Derivadas de un grupo que cuentan como sus pendientes (hilos, ramas, internas; no sidechats). */
  derivedOf(conversationId: string) {
    return (this.state.data?.conversations ?? []).filter((x) => x.parentId === conversationId && x.deriveKind !== 'side');
  }
  /**
   * «Marcar como leído» desde la lista: el grupo y sus derivadas, cada una hasta el lastMessageSeq que
   * este cliente conoce (lo que llegue después sigue sin leer). El servidor avisa a mis otros dispositivos.
   */
  async markTreeRead(conversationId: string) {
    const all = [this.state.data?.conversations.find((x) => x.id === conversationId), ...this.derivedOf(conversationId)]
      .filter((c): c is NonNullable<typeof c> => !!c && (c.unread > 0 || (c.unreadMentions ?? 0) > 0 || c.lastReadSeq < c.lastMessageSeq));
    if (!all.length) return;
    const items = all.map((c) => ({ conversationId: c.id, seq: c.lastMessageSeq }));
    const result = await this.request<{ marked: { conversationId: string; lastReadSeq: number }[] }>(`/conversations/${conversationId}/read-tree`, { method: 'POST', json: { items } });
    for (const m of result.marked) this.applyConfirmedRead(m.conversationId, m.lastReadSeq);
  }
  async markConversationRead(conversationId: string) {
    const c = this.state.data?.conversations.find((x) => x.id === conversationId);
    if (!c) return;
    const result = await this.request<{ lastReadSeq: number }>(`/conversations/${conversationId}/read`, { method: 'POST', json: { seq: c.lastMessageSeq } });
    this.applyConfirmedRead(conversationId, result.lastReadSeq);
  }
  private applyConfirmedRead(id: string, seq: number) {
    const c = this.state.data?.conversations.find((x) => x.id === id);
    if (!c) return;
    const lastReadSeq = Math.max(c.lastReadSeq, seq);
    this.patchConversationMeta(id, { lastReadSeq, unread: Math.max(0, c.lastMessageSeq - Math.max(lastReadSeq, c.historyFromSeq)), ...(lastReadSeq >= c.lastMessageSeq ? { unreadMentions: 0 } : {}) });
  }
  private patchPreviewIfLast(m: MessageDTO) {
    const c = this.state.data?.conversations.find((x) => x.id === m.conversationId);
    if (c && c.lastMessageSeq === m.seq) this.patchConversationMeta(c.id, { lastMessagePreview: m.body.slice(0, 140) });
  }
  private upsertLocal(m: MessageDTO) {
    const local = this.state.conversations[m.conversationId];
    if (local?.loaded) this.setConv(m.conversationId, { messages: upsertMessage(local.messages, m) });
    this.patchPreviewIfLast(m);
  }
  async editMessage(id: string, body: string, mentions?: MentionDTO[], refs?: Omit<MessageRefDTO, 'name'>[]) { const m = await this.request<MessageDTO>(`/messages/${id}`, { method: 'PATCH', json: { body, ...(mentions ? { mentions } : {}), ...(refs ? { refs } : {}) } }); this.upsertLocal(m); }

  // ---------- Tanda 1.7: buscar en el chat, una sola vista, comentarios de eventos ----------
  /** Busca dentro de una conversación (q ≥ 2 caracteres; admite from:Nombre). before = seq del último resultado. */
  searchChat(conversationId: string, q: string, before?: number, limit = 30, signal?: AbortSignal) {
    return this.request<ChatSearchPageDTO>(`/conversations/${conversationId}/search?q=${encodeURIComponent(q)}&limit=${limit}${before ? `&before=${before}` : ''}`, { signal });
  }
  /** Abre un mensaje de una sola vista (una vez). Localmente queda «Abierto» aunque no llegue el evento. */
  async openViewOnce(m: MessageDTO): Promise<ViewOnceOpenDTO> {
    const r = await this.request<ViewOnceOpenDTO>(`/messages/${m.id}/open`, { method: 'POST', json: {} });
    const me = this.state.data?.me.id;
    if (me) this.upsertLocal({ ...m, viewOnceState: 'opened', openedBy: [...(m.openedBy ?? []).filter((o) => o.userId !== me), { userId: me, at: new Date().toISOString() }] });
    return r;
  }
  /** Marca «Abierto» localmente (p. ej. el servidor respondió 410 already_opened desde otro dispositivo). */
  markViewOnceOpened(m: MessageDTO) {
    const me = this.state.data?.me.id;
    if (me) this.upsertLocal({ ...m, viewOnceState: 'opened', openedBy: [...(m.openedBy ?? []).filter((o) => o.userId !== me), { userId: me, at: new Date().toISOString() }] });
  }
  async eventComments(eventId: string) { return (await this.request<{ comments: EventCommentDTO[] }>(`/events/${eventId}/comments`)).comments; }
  async commentEvent(eventId: string, body: string) {
    const r = await this.request<{ comment: EventCommentDTO; event: CalendarEventDTO }>(`/events/${eventId}/comments`, { method: 'POST', json: { body } });
    this.set({ events: { ...this.state.events, [r.event.id]: r.event } });
    return r;
  }
  // ---------- Correo en el chat (docs/CORREO.md) ----------
  /** Una tarjeta sin cuerpo no borra el cuerpo que ya se había cargado al abrir el correo. */
  private putMail(m: import('@tiecoms/contracts').SharedMailDTO) {
    const prev = this.state.mails[m.id];
    const merged = !m.full && prev?.full ? { ...m, body: prev.body, full: true } : m;
    this.set({ mails: { ...this.state.mails, [m.id]: merged } });
    return merged;
  }
  // Tarjetas del chat: se piden juntas (hasta 50 por petición) en vez de una por tarjeta.
  private mailWanted = new Map<string, { resolve: (m: import('@tiecoms/contracts').SharedMailDTO) => void; reject: (e: unknown) => void }[]>();
  private mailTimer: ReturnType<typeof setTimeout> | null = null;
  private flushMailBatch = async () => {
    this.mailTimer = null;
    const batch = [...this.mailWanted.entries()].slice(0, 50);
    for (const [id] of batch) this.mailWanted.delete(id);
    if (this.mailWanted.size) this.mailTimer = setTimeout(this.flushMailBatch, 0);
    try {
      const r = await this.request<{ emails: import('@tiecoms/contracts').SharedMailDTO[] }>(`/mail/shared?ids=${batch.map(([id]) => id).join(',')}`);
      const got = new Map(r.emails.map((e) => [e.id, this.putMail(e)]));
      for (const [id, waiters] of batch) for (const w of waiters) { const e = got.get(id); if (e) w.resolve(e); else w.reject(new ApiRequestError(404, 'not_found', 'Correo no disponible')); }
    } catch (e) { for (const [, waiters] of batch) for (const w of waiters) w.reject(e); }
  };
  async mailConnections() { return (await this.request<{ connections: import('@tiecoms/contracts').MailConnectionDTO[] }>('/mail/connections')).connections; }
  connectMailProvider(provider: import('@tiecoms/contracts').MailProvider, proofChallenge: string, platform: 'web' | 'ios' | 'android' | 'desktop' = 'web') {
    return this.request<{ url: string }>(`/mail/connect/${provider}`, { method: 'POST', json: { platform, proofChallenge } });
  }
  confirmMailProvider(receipt: string, proofVerifier: string) {
    return this.request<{ ok: true; provider: import('@tiecoms/contracts').MailProvider }>('/mail/connect/confirm', { method: 'POST', json: { receipt, proofVerifier } });
  }
  async disconnectMailProvider(provider: import('@tiecoms/contracts').MailProvider) { await this.request(`/mail/connections/${provider}`, { method: 'DELETE' }); }
  /** Lista en vivo (Gmail/Outlook). Los filtros van tal cual al proveedor; nada se guarda. */
  listMail(q: { provider: import('@tiecoms/contracts').MailProvider; box?: 'inbox' | 'sent' | 'all'; category?: string; q?: string; from?: string; to?: string; after?: string; before?: string; attachments?: boolean; unread?: boolean; label?: string; page?: string; fresh?: boolean }) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '' && v !== false) p.set(k, v === true ? '1' : String(v));
    return this.request<import('@tiecoms/contracts').MailListDTO>(`/mail/messages?${p}`);
  }
  getMail(provider: import('@tiecoms/contracts').MailProvider, id: string) {
    return this.request<import('@tiecoms/contracts').MailMessageDTO>(`/mail/messages/${provider}/${encodeURIComponent(id)}`);
  }
  async shareMail(input: { provider: import('@tiecoms/contracts').MailProvider; messageId: string; conversationId: string; comment?: string; topicId?: string | null }) {
    return this.putMail(await this.request<import('@tiecoms/contracts').SharedMailDTO>('/mail/share', { method: 'POST', json: input }));
  }
  loadSharedMail(id: string): Promise<import('@tiecoms/contracts').SharedMailDTO> {
    return new Promise((resolve, reject) => {
      const list = this.mailWanted.get(id) ?? [];
      list.push({ resolve, reject });
      this.mailWanted.set(id, list);
      this.mailTimer ??= setTimeout(this.flushMailBatch, 16);
    });
  }
  /** El correo con su cuerpo (al abrir el panel). */
  async loadSharedMailFull(id: string) { return this.putMail(await this.sharedGet<import('@tiecoms/contracts').SharedMailDTO>(`/mail/shared/${id}?full=1`)); }
  /** El correo tal como está en el buzón (con historial citado y firma), en vivo y sin guardar. */
  mailOriginal(id: string) { return this.request<{ body: string }>(`/mail/shared/${id}/original`); }
  async mailComments(id: string) { return (await this.request<{ comments: import('@tiecoms/contracts').SharedMailCommentDTO[] }>(`/mail/shared/${id}/comments`)).comments; }
  async commentMail(id: string, body: string) {
    const r = await this.request<{ comment: import('@tiecoms/contracts').SharedMailCommentDTO; email: import('@tiecoms/contracts').SharedMailDTO }>(`/mail/shared/${id}/comments`, { method: 'POST', json: { body } });
    this.putMail({ ...r.email, scheduledReply: this.state.mails[id]?.scheduledReply ?? r.email.scheduledReply });
    return r;
  }
  mailAttachmentPath(id: string, attachmentId: string) { return `/mail/shared/${id}/attachments/${encodeURIComponent(attachmentId)}`; }
  draftMailReply(id: string, lang: 'es' | 'en' = 'es') { return this.request<{ body: string }>(`/mail/shared/${id}/draft`, { method: 'POST', json: { lang } }); }
  async replyMail(id: string, input: { body: string; cc?: string[]; attachmentIds?: string[]; sendAt?: string; notifyChat?: boolean }) {
    return this.putMail(await this.request<import('@tiecoms/contracts').SharedMailDTO>(`/mail/shared/${id}/reply`, { method: 'POST', json: input }));
  }
  async cancelMailReply(id: string) { return this.putMail(await this.request<import('@tiecoms/contracts').SharedMailDTO>(`/mail/shared/${id}/reply`, { method: 'DELETE' })); }
  async mailTask(id: string, input: { title: string; ownerId?: string | null; dueDate?: string | null; closeOnReply?: boolean }) {
    const r = await this.request<{ issue: IssueDTO; email: import('@tiecoms/contracts').SharedMailDTO }>(`/mail/shared/${id}/task`, { method: 'POST', json: input });
    this.putMail(r.email);
    return r;
  }
  shareWhatsApp(input: { accountId: string; jid: string; messageId: string; conversationId: string; comment?: string }) {
    return this.request<{ message: MessageDTO }>('/whatsapp/share', { method: 'POST', json: input });
  }
  /** Bandeja «Menciones»: más recientes primero; before = createdAt del último que ya tienes. */
  listMentions(before?: string, limit = 50) {
    return this.request<{ mentions: MentionItemDTO[]; hasMore: boolean }>(`/mentions?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`);
  }
  async deleteMessage(id: string) { const m = await this.request<MessageDTO>(`/messages/${id}`, { method: 'DELETE' }); this.upsertLocal(m); }
  async setMessagePinned(m: MessageDTO, pinned: boolean) {
    const r = await this.request<{ messageIds: string[] }>(`/messages/${m.id}/pin`, { method: pinned ? 'POST' : 'DELETE' });
    this.set({ pins: { ...this.state.pins, [m.conversationId]: r.messageIds } });
  }
  // ---------- Temas (docs/TEMAS.md) ----------
  private putTopics(conversationId: string, topics: TopicDTO[]) { this.set({ topics: { ...this.state.topics, [conversationId]: topics } }); }
  async loadTopics(conversationId: string) {
    const r = await this.request<{ topics: TopicDTO[] }>(`/conversations/${conversationId}/topics`);
    this.putTopics(conversationId, r.topics);
    return r.topics;
  }
  async createTopic(conversationId: string, input: { name: string; color?: TopicColor; icon?: string }) {
    const r = await this.request<{ topic: TopicDTO; topics: TopicDTO[] }>(`/conversations/${conversationId}/topics`, { method: 'POST', json: input });
    this.putTopics(conversationId, r.topics);
    return r.topic;
  }
  async updateTopic(t: TopicDTO, patch: { name?: string; color?: TopicColor; icon?: string; archived?: boolean; position?: number }) {
    const r = await this.request<{ topics: TopicDTO[] }>(`/topics/${t.id}`, { method: 'PATCH', json: patch });
    this.putTopics(t.conversationId, r.topics);
  }
  async deleteTopic(t: TopicDTO) {
    const r = await this.request<{ topics: TopicDTO[]; cleared: number }>(`/topics/${t.id}`, { method: 'DELETE' });
    this.putTopics(t.conversationId, r.topics);
    const local = this.state.conversations[t.conversationId];
    if (local?.loaded) this.setConv(t.conversationId, { messages: local.messages.map((m) => (m.topicId === t.id ? { ...m, topicId: null, topicBy: null } : m)) });
    return r.cleared;
  }
  async setMessageTopic(m: MessageDTO, topicId: string | null) {
    const out = await this.request<MessageDTO>(`/messages/${m.id}/topic`, { method: 'PUT', json: { topicId } });
    this.upsertLocal(out);
    return out;
  }
  async loadPins(conversationId: string) {
    const r = await this.sharedGet<{ messages: MessageDTO[] }>(`/conversations/${conversationId}/pins`, 3000);
    this.set({ pins: { ...this.state.pins, [conversationId]: r.messages.map((m) => m.id) } });
    return r.messages;
  }

  // ---------- Reacciones ----------
  /** Aviso local: una reacción nueva de otra persona a un mensaje mío. */
  private noticeReaction(before: MessageDTO | undefined, after: MessageDTO) {
    const me = this.state.data?.me.id;
    if (!before || !me || after.authorId !== me) return;
    const had = new Set((before.reactions ?? []).flatMap((r) => r.userIds.map((u) => `${r.emoji}|${u}`)));
    for (const r of after.reactions ?? []) for (const u of r.userIds) {
      if (u !== me && !had.has(`${r.emoji}|${u}`)) { this.opts.onNotice?.({ kind: 'reaction', conversationId: after.conversationId, message: after, userId: u, emoji: r.emoji }); return; }
    }
  }
  /**
   * Pone o quita mi reacción (optimista). remindAt: hora del recordatorio de 👀 en la zona horaria local.
   * Devuelve lo que hizo el servidor (recordatorio creado, recordatorios cerrados, asunto que se puede cerrar).
   */
  async react(m: MessageDTO, rawEmoji: string, on: boolean, opts: { remindAt?: string } = {}) {
    const emoji = normalizeEmoji(rawEmoji);
    const me = this.state.data?.me.id;
    if (!emoji || !me) throw new Error('invalid_emoji');
    const prev = m.reactions ?? [];
    let next: ReactionDTO[] = prev.map((r) => ({ ...r, userIds: r.userIds.filter((u) => u !== me || r.emoji !== emoji) }));
    if (on) {
      const hit = next.find((r) => r.emoji === emoji);
      if (hit) hit.userIds = [...hit.userIds, me]; else next = [...next, { emoji, userIds: [me] }];
    }
    next = next.filter((r) => r.userIds.length || r.external?.length);
    this.upsertLocal({ ...m, reactions: next });
    try {
      const r = await this.request<{ message: MessageDTO; reminder?: ReminderDTO; closedReminderIds?: string[]; openIssueId?: string }>(
        `/messages/${m.id}/reactions/${encodeURIComponent(emoji)}`, { method: on ? 'PUT' : 'DELETE', ...(on && opts.remindAt ? { json: { remindAt: opts.remindAt } } : {}) });
      this.upsertLocal(r.message);
      if (r.reminder || r.closedReminderIds?.length) {
        const closed = new Set(r.closedReminderIds ?? []);
        this.set({ reminders: [...this.state.reminders.filter((x) => !closed.has(x.id)), ...(r.reminder ? [r.reminder] : [])].sort((a, b) => a.remindAt.localeCompare(b.remindAt)) });
      }
      return r;
    } catch (e) { this.upsertLocal({ ...m, reactions: prev }); throw e; }
  }
  /** Reacciones con acción (👀/✅) para la gente de la empresa (solo owner/admin). */
  async setReactionActions(orgId: string, enabled: boolean) {
    await this.request(`/organizations/${orgId}/reaction-actions`, { method: 'PUT', json: { reactionActions: enabled } });
    await this.loadBootstrap();
  }

  // ---------- Enlaces ----------
  listLinks(conversationId: string, q: { kind?: string; q?: string; before?: string; limit?: number } = {}) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
    return this.request<LinksPageDTO>(`/conversations/${conversationId}/links${p.size ? `?${p}` : ''}`);
  }
  listSavedLinks(state: 'pending' | 'seen' | 'all' = 'pending', before?: string) {
    return this.request<LinksPageDTO & { pending: number }>(`/links/saved?state=${state}${before ? `&before=${encodeURIComponent(before)}` : ''}`);
  }
  setLinkState(linkId: string, state: { saved?: boolean; seen?: boolean }) {
    return this.request<LinkItemDTO>(`/links/${linkId}/state`, { method: 'PUT', json: state });
  }
  summarizeLink(linkId: string, lang: 'es' | 'en') {
    return this.request<LinkSummaryDTO>(`/links/${linkId}/summary`, { method: 'POST', json: { lang } });
  }
  async setLinkPreviewMode(conversationId: string, mode: LinkPreviewMode) {
    this.patchConversationMeta(conversationId, { linkPreviews: mode });
    await this.request(`/conversations/${conversationId}/prefs`, { method: 'PUT', json: { linkPreviews: mode } });
  }
  private patchMe(patch: Partial<UserDTO>) {
    const d = this.state.data;
    if (d) this.set({ data: { ...d, me: { ...d.me, ...patch } } });
  }
  /**
   * «No molestar» (silenciar todo) hasta `until` (ISO; MUTE_FOREVER = hasta que lo reactive); null lo apaga.
   * Si el servidor no conoce la ruta (404), se guarda solo en este dispositivo y devuelve { local: true }.
   */
  /** Modo sueño: horario diario sin sonidos. Devuelve el horario guardado. */
  async setSleep(patch: { on?: boolean; start?: string; end?: string; tz?: string; tzAuto?: boolean }) {
    const r = await this.request<{ sleep: SleepDTO }>('/me/sleep', { method: 'PUT', json: patch });
    this.patchMe({ sleep: r.sleep });
    return r.sleep;
  }
  async setDnd(until: string | null): Promise<{ dndUntil: string | null; local: boolean }> {
    const prev = this.state.data?.me.dndUntil ?? null;
    this.patchMe({ dndUntil: until });
    try {
      const r = await this.request<{ dndUntil: string | null }>('/me/dnd', { method: 'PUT', json: { until } });
      this.set({ dndLocalOnly: false });
      this.patchMe({ dndUntil: r.dndUntil });
      return { dndUntil: r.dndUntil, local: false };
    } catch (e) {
      const me = this.state.data?.me.id;
      if (e instanceof ApiRequestError && e.status === 404 && me) {
        await this.opts.storage.set(`u:${me}:dnd`, until);
        this.set({ dndLocalOnly: true });
        return { dndUntil: until, local: true };
      }
      this.patchMe({ dndUntil: prev });
      throw e;
    }
  }
  /** Resumen semanal de enlaces por correo (opt-in). */
  async setLinkDigest(on: boolean) {
    const d = this.state.data;
    if (d) this.set({ data: { ...d, me: { ...d.me, linkDigest: on } } });
    const me = await this.request<UserDTO>('/me', { method: 'PATCH', json: { linkDigest: on } });
    const d2 = this.state.data;
    if (d2) this.set({ data: { ...d2, me: { ...d2.me, ...me } } });
  }

  // ---------- Recordatorios ----------
  // ---------- Mensajes programados ----------
  private putScheduled(x: ScheduledMessageDTO) {
    const rest = this.state.scheduled.filter((y) => y.id !== x.id);
    const keep = x.status === 'pending' || x.status === 'sending' || x.status === 'failed';
    this.set({ scheduled: (keep ? [...rest, x] : rest).sort((a, b) => a.sendAt.localeCompare(b.sendAt)) });
  }
  async loadScheduled() {
    try {
      const r = await this.request<{ scheduled: ScheduledMessageDTO[] }>('/scheduled');
      this.set({ scheduled: r.scheduled });
      return r.scheduled;
    } catch { return this.state.scheduled; } // servidor viejo sin /scheduled
  }
  async scheduleMessage(conversationId: string, input: { body: string; sendAt: string; mentions?: { userId: string; start: number; length: number }[]; replyTo?: string | null }) {
    const x = await this.request<ScheduledMessageDTO>(`/conversations/${conversationId}/scheduled`, { method: 'POST', json: input });
    this.putScheduled(x);
    return x;
  }
  async updateScheduled(id: string, patch: { body?: string; sendAt?: string }) {
    const x = await this.request<ScheduledMessageDTO>(`/scheduled/${id}`, { method: 'PATCH', json: patch });
    this.putScheduled(x);
    return x;
  }
  async cancelScheduled(id: string) { this.putScheduled(await this.request<ScheduledMessageDTO>(`/scheduled/${id}`, { method: 'DELETE' })); }
  async sendScheduledNow(id: string) { this.putScheduled(await this.request<ScheduledMessageDTO>(`/scheduled/${id}/send`, { method: 'POST', json: {} })); }

  /** Personas que bloqueé (compartido por un minuto). */
  async loadBlocks() { return (await this.sharedGet<{ userIds: string[] }>('/blocks', 60_000)).userIds; }
  async loadReminders() { const r = await this.request<{ reminders: ReminderDTO[] }>('/reminders'); this.set({ reminders: r.reminders }); return r.reminders; }
  async createReminder(input: { conversationId: string; messageId?: string | null; note?: string | null; remindAt: string }) {
    const r = await this.request<ReminderDTO>('/reminders', { method: 'POST', json: input });
    this.set({ reminders: [...this.state.reminders, r].sort((a, b) => a.remindAt.localeCompare(b.remindAt)) });
    return r;
  }
  async completeReminder(id: string) {
    await this.request(`/reminders/${id}/done`, { method: 'POST', json: {} });
    this.set({ reminders: this.state.reminders.filter((r) => r.id !== id) });
  }
  async snoozeReminder(id: string, until: string) {
    await this.request(`/reminders/${id}/snooze`, { method: 'POST', json: { until } });
    this.set({ reminders: this.state.reminders.map((r) => (r.id === id ? { ...r, remindAt: until, firedAt: null } : r)).sort((a, b) => a.remindAt.localeCompare(b.remindAt)) });
  }

  // ---------- Calendario ----------
  private putEvents(list: CalendarEventDTO[]) { const n = { ...this.state.events }; for (const e of list) n[e.id] = e; this.set({ events: n }); }
  async loadEvents(from: Date, to: Date, conversationId?: string) {
    const q = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), ...(conversationId ? { conversationId } : {}) });
    const r = await this.sharedGet<{ events: CalendarEventDTO[] }>(`/events?${q}`);
    this.putEvents(r.events);
    return r.events;
  }
  /** Un evento por id (compartido: varias tarjetas del mismo evento piden una sola vez). */
  async loadEvent(id: string) {
    const e = await this.sharedGet<CalendarEventDTO>(`/events/${id}`);
    this.putEvents([e]);
    return e;
  }
  async createEvent(conversationId: string, input: { title: string; description?: string | null; location?: string | null; startsAt: string; endsAt: string; timezone: string; inviteeIds?: string[]; originMessageId?: string | null }) {
    const e = await this.request<CalendarEventDTO>(`/conversations/${conversationId}/events`, { method: 'POST', json: input });
    this.putEvents([e]); return e;
  }
  async updateEvent(id: string, patch: Record<string, unknown>) { const e = await this.request<CalendarEventDTO>(`/events/${id}`, { method: 'PATCH', json: patch }); this.putEvents([e]); return e; }
  async cancelEvent(id: string) { const e = await this.request<CalendarEventDTO>(`/events/${id}`, { method: 'DELETE' }); this.putEvents([e]); return e; }
  async rsvp(id: string, answer: Exclude<Rsvp, 'pending'>) { const e = await this.request<CalendarEventDTO>(`/events/${id}/rsvp`, { method: 'POST', json: { rsvp: answer } }); this.putEvents([e]); return e; }

  // ---------- Bifurcaciones ----------
  async derive(conversationId: string, input: { messageId: string; kind: 'same' | 'internal' | 'directive'; name?: string; reason?: string }) {
    const r = await this.request<{ id: string }>(`/conversations/${conversationId}/derive`, { method: 'POST', json: input });
    await this.loadBootstrap();
    return r;
  }
  async returnResult(conversationId: string, summary: string) {
    const r = await this.request<{ parentId: string; messageId: string }>(`/conversations/${conversationId}/return`, { method: 'POST', json: { summary } });
    await this.loadBootstrap();
    return r;
  }

  // ---------- Adjuntos ----------
  /** Sube un archivo a una conversación (queda pendiente hasta que un mensaje lo use). ≤ 25 MB. */
  uploadAttachment(conversationId: string, file: Blob, name: string, voice?: { durationMs: number; waveform?: number[]; aiConsent?: boolean }) {
    return this.request<AttachmentDTO>(`/conversations/${conversationId}/attachments`, {
      method: 'POST', body: file,
      headers: {
        'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name), 'x-file-type': file.type || 'application/octet-stream',
        ...(voice ? { 'x-voice-note': '1', ...(voice.aiConsent === true ? { 'x-ai-consent': '1' } : {}), 'x-duration-ms': String(Math.round(voice.durationMs)), ...(voice.waveform?.length ? { 'x-waveform': voice.waveform.map((v) => v.toFixed(2)).join(',') } : {}) } : {}),
      },
    });
  }
  /** Vuelve a pedir la transcripción de una nota de voz que falló. */
  retryTranscription(attachmentId: string, aiConsent = false) {
    return this.request<AttachmentDTO>(`/attachments/${attachmentId}/transcribe`, { method: 'POST', json: { aiConsent } });
  }
  /** Miniatura opcional (JPEG/PNG/WebP ≤ 512 KB) de un adjunto aún pendiente. */
  uploadAttachmentThumb(id: string, thumb: Blob) {
    return this.request<AttachmentDTO>(`/attachments/${id}/thumb`, { method: 'POST', body: thumb, headers: { 'content-type': 'application/octet-stream' } });
  }
  // ---------- Firmar PDFs ----------
  /** Mis firmas guardadas (PNG transparentes; url solo me sirve a mí). */
  listSignatures() { return this.request<{ signatures: SignatureDTO[] }>('/me/signatures'); }
  /** Guarda una firma o iniciales ya recortadas (PNG ≤ 512 KB). */
  createSignature(png: Blob, kind: SignatureDTO['kind'], source: SignatureDTO['source']) {
    return this.request<SignatureDTO>('/me/signatures', { method: 'POST', body: png, headers: { 'content-type': 'image/png', 'x-signature-kind': kind, 'x-signature-source': source } });
  }
  deleteSignature(id: string) { return this.request<{ ok: true }>(`/me/signatures/${id}`, { method: 'DELETE' }); }
  /** Historial «Documentos que firmé» (lo más reciente primero; before = nextBefore de la página anterior). */
  listSignings(q: { before?: string | null; limit?: number; q?: string } = {}) {
    const p = new URLSearchParams();
    if (q.before) p.set('before', q.before);
    if (q.limit) p.set('limit', String(q.limit));
    if (q.q?.trim()) p.set('q', q.q.trim());
    const qs = p.toString();
    return this.request<SigningHistoryPageDTO>(`/me/signings${qs ? `?${qs}` : ''}`);
  }
  /** Antes de firmar: si ya trae firma digital, si está cifrado y quién lo ha firmado en Chaggu. */
  signInfo(attachmentId: string) { return this.request<SignInfoDTO>(`/attachments/${attachmentId}/sign-info`); }
  /** Estampa las marcas en el servidor y responde en el hilo con el PDF firmado. Idempotente por clientMessageId. */
  signPdf(attachmentId: string, input: SignPdfInput) {
    return this.request<SignPdfResult>(`/attachments/${attachmentId}/sign`, { method: 'POST', json: input });
  }
  /** Descarga autenticada (Bearer) de una ruta del API, p. ej. AttachmentDTO.url. */
  async fetchBlob(apiPath: string): Promise<Blob> {
    const path = apiPath.replace(/^\/api\/v1/, '');
    if (this.accessToken && Date.now() > this.accessExp - 30_000) await this.refresh();
    let res = await this.raw(path);
    if (res.status === 401 && (await this.refresh())) res = await this.raw(path);
    if (!res.ok) throw await parseError(res);
    return res.blob();
  }

  /** Conversación lateral privada desde un mensaje (no publica nada en el origen). */
  async openSide(conversationId: string, input: { messageId?: string; issueId?: string; userIds: string[]; question?: string }) {
    const r = await this.request<{ id: string }>(`/conversations/${conversationId}/side`, { method: 'POST', json: input });
    await this.loadBootstrap();
    return r;
  }
  /** Nuevo chat: una persona → directo (reutiliza el existente); varias → chat grupal. */
  async createChat(userIds: string[], name?: string) {
    const r = await this.request<{ id: string; kind: 'direct' | 'multi' }>('/chats', { method: 'POST', json: { userIds, ...(name ? { name } : {}) } });
    await this.loadBootstrap();
    return r;
  }
  /** Foto de grupo o chat: bytes de la imagen (PNG, JPG o WebP, ≤ 3 MB). */
  async setConversationAvatar(conversationId: string, image: Blob) {
    const r = await this.request<{ avatarUrl: string }>(`/conversations/${conversationId}/avatar`, { method: 'POST', body: image, headers: { 'content-type': image.type || 'image/jpeg' } });
    await this.loadBootstrap();
    return r;
  }
  async removeConversationAvatar(conversationId: string) {
    const r = await this.request<{ avatarUrl: null }>(`/conversations/${conversationId}/avatar`, { method: 'DELETE' });
    await this.loadBootstrap();
    return r;
  }

  /** Carga hacia atrás hasta tener el mensaje con ese seq (para saltar a un mensaje de origen). */
  async ensureMessage(conversationId: string, seq: number) {
    await this.openConversation(conversationId);
    for (let guard = 0; guard < 40; guard++) {
      const c = this.state.conversations[conversationId];
      if (!c?.loaded) return false;
      if (c.messages.some((m) => m.seq === seq)) return true;
      if (!c.hasMore || (c.messages[0]?.seq ?? 0) <= seq) return false;
      await this.loadOlder(conversationId);
    }
    return false;
  }

  // ---------- Espacios, grupos, invitaciones ----------
  async createWorkspace(input: { name: string; department?: string }) {
    const r = await this.request<{ id: string; generalConversationId: string }>('/workspaces', { method: 'POST', json: input });
    await this.loadBootstrap();
    return r;
  }
  async createConversation(workspaceId: string, input: { name: string; kind: 'group' | 'internal'; level: 'directivo' | 'operativo' | null; memberIds: string[] }) {
    const r = await this.request<{ id: string }>(`/workspaces/${workspaceId}/conversations`, { method: 'POST', json: input });
    await this.loadBootstrap();
    return r;
  }
  async addMembers(conversationId: string, userIds: string[], history: 'now' | 'all') {
    const r = await this.request<{ added: string[] }>(`/conversations/${conversationId}/members`, { method: 'POST', json: { userIds, history } });
    await this.loadBootstrap();
    return r;
  }
  async removeMember(conversationId: string, userId: string) {
    await this.request(`/conversations/${conversationId}/members/${userId}`, { method: 'DELETE' });
    await this.loadBootstrap();
  }
  /** Nombrar o quitar admin del grupo (como WhatsApp). */
  async setMemberAdmin(conversationId: string, userId: string, admin: boolean) {
    const r = await this.request<{ adminIds: string[] }>(`/conversations/${conversationId}/members/${userId}/admin`, { method: 'PUT', json: { admin } });
    this.patchConversationMeta(conversationId, { adminIds: r.adminIds });
    await this.loadBootstrap();
    return r;
  }
  listIntegrations(conversationId: string) {
    return this.request<{ integrations: IntegrationDTO[]; canConfigure: boolean }>(`/conversations/${conversationId}/integrations`);
  }
  createIntegration(conversationId: string, input: { name: string; outgoingUrl?: string | null }) {
    return this.request<IntegrationSecretDTO>(`/conversations/${conversationId}/integrations`, { method: 'POST', json: input });
  }
  updateIntegration(id: string, input: { name?: string; outgoingUrl?: string | null; rotateOutgoingSecret?: boolean }) {
    return this.request<{ integration: IntegrationDTO; outgoingSecret: string | null }>(`/integrations/${id}`, { method: 'PATCH', json: input });
  }
  rotateIntegrationToken(id: string) {
    return this.request<IntegrationSecretDTO>(`/integrations/${id}/rotate`, { method: 'POST', json: {} });
  }
  revokeIntegration(id: string) {
    return this.request<{ ok: true }>(`/integrations/${id}`, { method: 'DELETE' });
  }
  async openDirect(userId: string) {
    const r = await this.request<{ id: string }>('/directs', { method: 'POST', json: { userId } });
    await this.loadBootstrap();
    return r;
  }
  createInvitation(workspaceId: string, input: { email?: string; role: 'member' | 'guest' | 'admin'; conversationIds: string[]; expiresInDays?: number; accessUntil?: string; history?: 'now' | 'all'; lang?: 'es' | 'en'; multiUse?: boolean }) {
    return this.request<InvitationCreatedDTO>(`/workspaces/${workspaceId}/invitations`, { method: 'POST', json: input });
  }
  /** El «+» de Grupos: grupo interno, en una relación existente o en una relación nueva (ver docs/GRUPOS.md). */
  async createGroup(input: CreateGroupRequest) {
    const r = await this.request<CreateGroupResultDTO>('/groups', { method: 'POST', json: input });
    await this.loadBootstrap();
    return r;
  }
  /** Archivar un grupo (quien lo administra). Si era el último de un espacio, el espacio también se archiva. */
  async archiveGroup(conversationId: string) {
    const r = await this.request<{ archived: boolean; workspaceArchived: boolean }>(`/conversations/${conversationId}/archive`, { method: 'POST', json: {} });
    await this.loadBootstrap();
    return r;
  }
  /** Entrada automática por dominio verificado (solo owner/admin). */
  async setJoinPolicy(orgId: string, joinPolicy: 'invite' | 'auto') {
    await this.request(`/organizations/${orgId}/join-policy`, { method: 'PUT', json: { joinPolicy } });
    await this.loadBootstrap();
  }
  /** Supervisión: grupos donde está la gente de mi empresa (solo owner/admin). */
  loadOversight(orgId: string) {
    return this.request<OversightDTO>(`/organizations/${orgId}/oversight`);
  }
  /** Mensajes de un grupo en solo lectura (supervisión): no toca la caché de conversaciones. */
  readOnlyMessages(conversationId: string, before?: number) {
    return this.request<{ messages: MessageDTO[]; hasMore: boolean }>(`/conversations/${conversationId}/messages?limit=50${before ? `&before=${before}` : ''}`);
  }
  async previewInvitation(token: string): Promise<InvitationPreviewDTO> {
    const res = await this.raw(`/invitations/${encodeURIComponent(token)}`, {}, false);
    if (!res.ok) throw await parseError(res);
    return res.json();
  }
  /** Acepta una invitación a un espacio o (con kind 'org') a una empresa y sus grupos. `workspaceId` puede ser null en una de empresa sin grupos. */
  async acceptInvitation(token: string) {
    const r = await this.request<{ workspaceId: string | null; conversationIds: string[]; orgId?: string; kind?: 'workspace' | 'org' }>(`/invitations/${encodeURIComponent(token)}/accept`, { method: 'POST', json: {} });
    await this.loadBootstrap();
    return r;
  }
  /**
   * Invitar a un colega a mi empresa. Con `conversationIds` entra también a esos grupos (cualquier miembro
   * puede, desde un grupo donde participa); `multiUse` = enlace y código para varias personas.
   */
  createOrgInvitation(orgId: string, input: { email?: string; role?: 'member' | 'admin'; lang?: 'es' | 'en'; workspaceId?: string; conversationIds?: string[]; history?: 'now' | 'all'; multiUse?: boolean; expiresInDays?: number } = {}) {
    return this.request<OrgInvitationCreatedDTO>(`/organizations/${orgId}/invitations`, { method: 'POST', json: input });
  }
  /** Invitaciones con correo aún sin aceptar de una empresa o un espacio. */
  async listInvitations(scope: 'organizations' | 'workspaces', id: string) {
    return (await this.request<{ invitations: PendingInvitationDTO[] }>(`/${scope}/${id}/invitations`)).invitations;
  }
  /** Reenvía el correo con un enlace nuevo (el anterior deja de servir). */
  resendInvitation(scope: 'organizations' | 'workspaces', id: string, invitationId: string) {
    return this.request<{ token: string; emailSent: boolean; emailStatus: 'sent' | 'failed' | 'skipped' }>(`/${scope}/${id}/invitations/${invitationId}/resend`, { method: 'POST', json: {} });
  }
  revokeInvitation(scope: 'organizations' | 'workspaces', id: string, invitationId: string) {
    return this.request<{ ok: true }>(`/${scope}/${id}/invitations/${invitationId}`, { method: 'DELETE' });
  }
  async previewOrgInvitation(token: string): Promise<OrgInvitationPreviewDTO> {
    const res = await this.raw(`/org-invitations/${encodeURIComponent(token)}`, {}, false);
    if (!res.ok) throw await parseError(res);
    return res.json();
  }
  sessions() { return this.request<{ sessions: { id: string; deviceName: string; platform: string; lastSeenAt: string }[]; current: string }>('/sessions'); }
  revokeSession(id: string) { return this.request(`/sessions/${id}`, { method: 'DELETE' }); }
}

function upsertMessage(list: MessageDTO[], m: MessageDTO): MessageDTO[] {
  const i = list.findIndex((x) => x.id === m.id);
  if (i >= 0) { const copy = list.slice(); copy[i] = m; return copy; }
  if (!list.length || list[list.length - 1]!.seq < m.seq) return [...list, m];
  return [...list, m].sort((a, b) => a.seq - b.seq);
}
