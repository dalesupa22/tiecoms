import { io, type Socket } from 'socket.io-client';
import {
  CONTRACT_VERSION, SOCKET_EVENTS,
  type AccountEvent, type AuthResult, type BootstrapDTO, type ConversationDTO, type ConversationEvent, type DeviceInfo,
  type AttachmentDTO, type CalendarEventDTO, type EventsPage, type ForwardedInfo, type InvitationPreviewDTO, type IssueDTO, type IssueEventDTO, type MessageDTO, type OrgInvitationPreviewDTO, type PendingInvitationDTO, type Platform, type ReminderDTO, type Rsvp,
} from '@tiecoms/contracts';
import { ApiRequestError, parseError } from './api.ts';
import type { KeyValueStorage, SecretStore } from './storage.ts';

export interface PendingMessage {
  clientMessageId: string;
  conversationId: string;
  body: string;
  replyTo: string | null;
  forwarded?: ForwardedInfo | null;
  /** Adjuntos ya subidos (para pintarlos mientras se envía) y adjuntos reenviados de otro mensaje. */
  attachments?: AttachmentDTO[];
  forwardAttachmentIds?: string[];
  createdAt: string;
  attempts: number;
  status: 'pending' | 'sending' | 'failed';
  error?: string;
  nextAttemptAt: number;
}

export interface ConversationState {
  messages: MessageDTO[];
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
  reminders: ReminderDTO[];
  events: Record<string, CalendarEventDTO>;
  /** Sube cuando el puente de WhatsApp trae chats o mensajes nuevos: la pantalla vuelve a pedir la lista. */
  waRevision: number;
  /** Sube cuando cambia algún árbol de archivos visible para la persona. */
  driveRevision: number;
}

/** Aviso para la interfaz (notificación del sistema, sonido, toast). */
export type ClientNotice =
  | { kind: 'message'; conversationId: string; message: MessageDTO }
  | { kind: 'reminder'; reminder: ReminderDTO }
  /** Una reunión a la que voy empieza en `minutes` minutos. */
  | { kind: 'eventSoon'; event: CalendarEventDTO; minutes: number };

export interface ClientOptions {
  /** Origen del API, p. ej. https://app.tiecoms.com. Vacío = mismo origen (web). */
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
 * Cliente TieComs independiente de la interfaz. Toda la lógica de envío,
 * reintentos, orden, recuperación y no leídos vive aquí para que web,
 * escritorio y móvil se comporten igual.
 */
export class TieComsClient {
  private state: ClientState = { status: 'loading', connection: 'offline', data: null, conversations: {}, pending: [], typing: {}, issues: {}, pins: {}, reminders: [], events: {}, waRevision: 0, driveRevision: 0 };
  private listeners = new Set<() => void>();
  private accessToken: string | null = null;
  private accessExp = 0;
  private refreshing: Promise<boolean> | null = null;
  private socket: Socket | null = null;
  private deviceId = '';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private bootstrapTimer: ReturnType<typeof setTimeout> | null = null;
  private catchingUp = new Set<string>();

  constructor(private opts: ClientOptions) {}

  // ---------- Estado observable (useSyncExternalStore) ----------
  getState = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  private set(patch: Partial<ClientState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }
  private setConv(id: string, patch: Partial<ConversationState>) {
    const prev = this.state.conversations[id] ?? { messages: [], lastEventSeq: 0, hasMore: true, loaded: false, loading: false };
    this.set({ conversations: { ...this.state.conversations, [id]: { ...prev, ...patch } } });
  }
  private patchConversationMeta(id: string, patch: Partial<ConversationDTO>) {
    const d = this.state.data;
    if (!d) return;
    this.set({ data: { ...d, conversations: d.conversations.map((c) => (c.id === id ? { ...c, ...patch } : c)) } });
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

  async request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
    if (this.accessToken && Date.now() > this.accessExp - 30_000) await this.refresh();
    let res = await this.raw(path, init);
    if (res.status === 401 && (await this.refresh())) res = await this.raw(path, init);
    if (res.status === 401) { await this.handleSignedOut(); throw await parseError(res); }
    if (!res.ok) throw await parseError(res);
    return res.json() as Promise<T>;
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
    if (await this.refresh()) await this.afterLogin();
    else this.set({ status: 'anonymous' });
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.resync());
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.resync(); });
    }
  }

  async login(email: string, password: string) {
    const res = await this.raw('/auth/login', { method: 'POST', json: { email, password, device: await this.device() } }, false);
    if (!res.ok) throw await parseError(res);
    await this.applyAuth(await res.json());
    await this.afterLogin();
  }

  async signup(input: { name: string; email: string; password: string; orgName?: string; orgInviteToken?: string; title?: string }) {
    const res = await this.raw('/auth/signup', { method: 'POST', json: { ...input, device: await this.device() } }, false);
    if (!res.ok) throw await parseError(res);
    await this.applyAuth(await res.json());
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
    const codeVerifier = await this.opts.storage.get<string>('sso:verifier');
    await this.opts.storage.del('sso:verifier');
    if (!codeVerifier) throw Object.assign(new Error('Vuelve a iniciar sesión desde esta app.'), { code: 'sso_state' });
    const res = await this.raw('/auth/sso/exchange', { method: 'POST', json: { code, codeVerifier, device: await this.device() } }, false);
    if (!res.ok) throw await parseError(res);
    await this.applyAuth(await res.json());
    await this.afterLogin();
  }

  /** Refresco con vuelo único; en navegador se serializa entre pestañas con Web Locks. */
  private refresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    const run = async () => {
      const stored = this.opts.secrets ? await this.opts.secrets.get() : undefined;
      if (this.opts.secrets && !stored) return false;
      const res = await this.raw('/auth/refresh', { method: 'POST', json: stored ? { refreshToken: stored } : {} }, false).catch(() => null);
      if (!res) return !!this.accessToken; // sin red: conserva la sesión local
      if (!res.ok) { this.accessToken = null; return false; }
      await this.applyAuth(await res.json());
      return true;
    };
    const locks = (globalThis.navigator as any)?.locks;
    this.refreshing = (locks ? locks.request('tiecoms-refresh', run) : run()).finally(() => { this.refreshing = null; });
    return this.refreshing!;
  }

  async logout() {
    try { await this.request('/auth/logout', { method: 'POST', json: {} }); } catch {}
    await this.handleSignedOut();
  }

  private async handleSignedOut() {
    const userId = this.state.data?.me.id;
    this.socket?.disconnect();
    this.socket = null;
    this.accessToken = null;
    await this.opts.secrets?.set(null);
    if (userId) await this.opts.storage.clearPrefix(`u:${userId}:`);
    this.state = { status: 'anonymous', connection: 'offline', data: null, conversations: {}, pending: [], typing: {}, issues: {}, pins: {}, reminders: [], events: {}, waRevision: 0, driveRevision: 0 };
    this.listeners.forEach((l) => l());
  }

  private async afterLogin() {
    await this.loadBootstrap();
    const me = this.state.data!.me.id;
    const pending = (await this.opts.storage.get<PendingMessage[]>(`u:${me}:outbox`)) ?? [];
    this.set({ status: 'ready', pending: pending.map((p) => ({ ...p, status: p.status === 'sending' ? 'pending' : p.status })) });
    this.connect();
    this.scheduleFlush(0);
    void this.loadReminders().catch(() => {});
  }

  // ---------- Snapshot ----------
  async loadBootstrap() {
    const data = await this.request<BootstrapDTO>('/bootstrap');
    this.set({ data });
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
    try {
      await this.loadBootstrap();
      for (const c of this.state.data?.conversations ?? []) {
        const local = this.state.conversations[c.id];
        if (local?.loaded && c.lastEventSeq > local.lastEventSeq) void this.catchUp(c.id);
      }
    } catch {}
    this.scheduleFlush(0);
  }

  private onAccountEvent(e: AccountEvent) {
    if (e.type === 'scope.changed') this.scheduleBootstrap();
    if (e.type === 'prefs.updated') this.scheduleBootstrap();
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
      if (c && e.seq > c.lastReadSeq) this.patchConversationMeta(c.id, { lastReadSeq: e.seq, unread: Math.max(0, c.lastMessageSeq - Math.max(e.seq, c.historyFromSeq)) });
    }
  }

  private onConversationEvent(e: ConversationEvent) {
    const local = this.state.conversations[e.conversationId];
    const meta = this.state.data?.conversations.find((c) => c.id === e.conversationId);
    if (!meta) { this.scheduleBootstrap(); return; }
    // Los asuntos se actualizan aunque la conversación no esté abierta.
    if (e.type === 'issue.updated') { this.putIssues([e.issue]); this.recountIssues(e.conversationId); }
    if (e.type === 'pins.changed') this.set({ pins: { ...this.state.pins, [e.conversationId]: e.messageIds } });
    if (e.type === 'calendar.updated') this.set({ events: { ...this.state.events, [e.event.id]: e.event } });
    if (e.type === 'message.created' && e.message.authorId !== this.state.data?.me.id && e.message.kind === 'text'
      && !(meta.mutedUntil && Date.parse(meta.mutedUntil) > Date.now())) this.opts.onNotice?.({ kind: 'message', conversationId: e.conversationId, message: e.message });
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
    const lastReadSeq = mine ? m.seq : c.lastReadSeq;
    this.patchConversationMeta(c.id, {
      lastMessageSeq: m.seq, lastMessageAt: m.createdAt, lastMessagePreview: m.body.slice(0, 140), lastReadSeq,
      unread: Math.max(0, m.seq - Math.max(lastReadSeq, c.historyFromSeq)),
    });
    // Reordena para que la conversación con actividad suba.
    const d = this.state.data!;
    this.set({ data: { ...d, conversations: [...d.conversations].sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '')) } });
  }

  private applyEvent(e: ConversationEvent) {
    const local = this.state.conversations[e.conversationId]!;
    let messages = local.messages;
    if (e.type === 'message.created' || e.type === 'message.updated') messages = upsertMessage(messages, e.message);
    if (e.type === 'members.changed') { this.patchConversationMeta(e.conversationId, { memberIds: e.memberIds }); this.scheduleBootstrap(); }
    if (e.type === 'issue.updated') this.putIssues([e.issue]);
    if (e.type === 'message.updated') this.patchPreviewIfLast(e.message);
    this.setConv(e.conversationId, { messages, lastEventSeq: e.eventSeq });
    if (e.type === 'message.created') this.dropPending(e.message);
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

  // ---------- Conversaciones ----------
  async openConversation(id: string, force = false) {
    const local = this.state.conversations[id];
    if (local?.loaded && !force) { void this.catchUp(id); return; }
    if (local?.loading) return;
    this.setConv(id, { loading: true });
    try {
      const page = await this.request<{ messages: MessageDTO[]; hasMore: boolean; lastEventSeq: number }>(`/conversations/${id}/messages?limit=50`);
      this.setConv(id, { messages: page.messages, hasMore: page.hasMore, lastEventSeq: page.lastEventSeq, loaded: true, loading: false });
      // Eventos que llegaron mientras cargábamos.
      void this.catchUp(id);
    } catch (e) {
      this.setConv(id, { loading: false });
      throw e;
    }
  }

  async loadOlder(id: string) {
    const local = this.state.conversations[id];
    if (!local?.loaded || !local.hasMore || local.loading) return;
    const before = local.messages[0]?.seq;
    if (!before) return;
    this.setConv(id, { loading: true });
    try {
      const page = await this.request<{ messages: MessageDTO[]; hasMore: boolean }>(`/conversations/${id}/messages?before=${before}&limit=50`);
      const cur = this.state.conversations[id]!;
      this.setConv(id, { messages: [...page.messages, ...cur.messages], hasMore: page.hasMore, loading: false });
    } catch { this.setConv(id, { loading: false }); }
  }

  private readTimers = new Map<string, ReturnType<typeof setTimeout>>();
  markRead(id: string) {
    const c = this.state.data?.conversations.find((x) => x.id === id);
    if (!c || c.lastMessageSeq <= c.lastReadSeq) return;
    this.patchConversationMeta(id, { lastReadSeq: c.lastMessageSeq, unread: 0 });
    clearTimeout(this.readTimers.get(id));
    this.readTimers.set(id, setTimeout(() => {
      const seq = this.state.data?.conversations.find((x) => x.id === id)?.lastReadSeq ?? 0;
      void this.request(`/conversations/${id}/read`, { method: 'POST', json: { seq } }).catch(() => {});
    }, 400));
  }

  typing(conversationId: string) { this.socket?.emit(SOCKET_EVENTS.typing, { conversationId }); }

  // ---------- Envío con cola persistente ----------
  async send(conversationId: string, body: string, replyTo: string | null = null, forwarded: ForwardedInfo | null = null,
    extra: { attachments?: AttachmentDTO[]; forwardAttachmentIds?: string[] } = {}) {
    const text = body.trim();
    if (!text && !extra.attachments?.length && !extra.forwardAttachmentIds?.length) return;
    const p: PendingMessage = {
      clientMessageId: uid(), conversationId, body: text, replyTo, forwarded, createdAt: new Date().toISOString(),
      ...(extra.attachments?.length ? { attachments: extra.attachments } : {}),
      ...(extra.forwardAttachmentIds?.length ? { forwardAttachmentIds: extra.forwardAttachmentIds } : {}),
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
    };
    const payload = { conversationId: p.conversationId, clientMessageId: p.clientMessageId, body: p.body, replyTo: p.replyTo, forwarded: p.forwarded ?? null, ...files };
    if (this.socket?.connected) {
      try {
        const r: any = await this.socket.timeout(8000).emitWithAck(SOCKET_EVENTS.send, payload);
        if (r?.ok) return r.message;
        const status = r?.error?.code === 'forbidden' ? 403 : r?.error?.code === 'not_found' ? 404 : r?.error?.code === 'conflict' ? 409 : r?.error?.code === 'bad_request' ? 400 : 503;
        throw new ApiRequestError(status, r?.error?.code ?? 'error', r?.error?.message ?? 'No se pudo enviar');
      } catch (e) {
        if (e instanceof ApiRequestError) throw e;
        // Timeout del socket: se reintenta por HTTP con el mismo identificador.
      }
    }
    const r = await this.request<{ message: MessageDTO }>(`/conversations/${p.conversationId}/messages`, {
      method: 'POST', json: { clientMessageId: p.clientMessageId, body: p.body, replyTo: p.replyTo, forwarded: p.forwarded ?? null, ...files },
    });
    return r.message;
  }

  // ---------- Asuntos ----------
  private putIssues(list: IssueDTO[]) {
    if (!list.length) return;
    const next = { ...this.state.issues };
    for (const i of list) next[i.id] = i;
    this.set({ issues: next });
  }
  private recountIssues(conversationId: string) {
    const n = Object.values(this.state.issues).filter((i) => i.conversationId === conversationId && i.status !== 'done' && i.status !== 'cancelled').length;
    this.patchConversationMeta(conversationId, { openIssues: n });
  }
  async loadIssues(filter: { workspaceId?: string; conversationId?: string; mine?: boolean; open?: boolean } = {}) {
    const q = new URLSearchParams();
    if (filter.workspaceId) q.set('workspaceId', filter.workspaceId);
    if (filter.conversationId) q.set('conversationId', filter.conversationId);
    if (filter.mine) q.set('mine', '1');
    if (filter.open) q.set('open', '1');
    const r = await this.request<{ issues: IssueDTO[] }>(`/issues?${q}`);
    this.putIssues(r.issues);
    return r.issues;
  }
  async createIssue(conversationId: string, input: { title: string; ownerId?: string | null; dueDate?: string | null; originMessageId?: string | null }) {
    const i = await this.request<IssueDTO>(`/conversations/${conversationId}/issues`, { method: 'POST', json: input });
    this.putIssues([i]); this.recountIssues(conversationId);
    return i;
  }
  async updateIssue(id: string, patch: Partial<Pick<IssueDTO, 'title' | 'status' | 'ownerId' | 'dueDate' | 'waitingOnOrgId'>>) {
    const i = await this.request<IssueDTO>(`/issues/${id}`, { method: 'PATCH', json: patch });
    this.putIssues([i]); this.recountIssues(i.conversationId);
    return i;
  }
  async issueDetail(id: string) {
    const r = await this.request<{ issue: IssueDTO; events: IssueEventDTO[] }>(`/issues/${id}`);
    this.putIssues([r.issue]);
    return r;
  }
  async commentIssue(id: string, body: string) {
    const i = await this.request<IssueDTO>(`/issues/${id}/comments`, { method: 'POST', json: { body } });
    this.putIssues([i]);
    return i;
  }

  // ---------- Preferencias, fijados, no leído, edición ----------
  async setConversationPrefs(id: string, prefs: { pinned?: boolean; mutedUntil?: string | null }) {
    const patch: Partial<ConversationDTO> = {};
    if (prefs.pinned !== undefined) patch.pinnedAt = prefs.pinned ? new Date().toISOString() : null;
    if (prefs.mutedUntil !== undefined) patch.mutedUntil = prefs.mutedUntil;
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
  async markConversationRead(conversationId: string) {
    const c = this.state.data?.conversations.find((x) => x.id === conversationId);
    if (!c) return;
    this.patchConversationMeta(conversationId, { lastReadSeq: c.lastMessageSeq, unread: 0 });
    await this.request(`/conversations/${conversationId}/read`, { method: 'POST', json: { seq: c.lastMessageSeq } });
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
  async editMessage(id: string, body: string) { const m = await this.request<MessageDTO>(`/messages/${id}`, { method: 'PATCH', json: { body } }); this.upsertLocal(m); }
  async deleteMessage(id: string) { const m = await this.request<MessageDTO>(`/messages/${id}`, { method: 'DELETE' }); this.upsertLocal(m); }
  async setMessagePinned(m: MessageDTO, pinned: boolean) {
    const r = await this.request<{ messageIds: string[] }>(`/messages/${m.id}/pin`, { method: pinned ? 'POST' : 'DELETE' });
    this.set({ pins: { ...this.state.pins, [m.conversationId]: r.messageIds } });
  }
  async loadPins(conversationId: string) {
    const r = await this.request<{ messages: MessageDTO[] }>(`/conversations/${conversationId}/pins`);
    this.set({ pins: { ...this.state.pins, [conversationId]: r.messages.map((m) => m.id) } });
    return r.messages;
  }

  // ---------- Recordatorios ----------
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
    const r = await this.request<{ events: CalendarEventDTO[] }>(`/events?${q}`);
    this.putEvents(r.events);
    return r.events;
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
  uploadAttachment(conversationId: string, file: Blob, name: string, voice?: { durationMs: number; waveform?: number[] }) {
    return this.request<AttachmentDTO>(`/conversations/${conversationId}/attachments`, {
      method: 'POST', body: file,
      headers: {
        'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name), 'x-file-type': file.type || 'application/octet-stream',
        ...(voice ? { 'x-voice-note': '1', 'x-duration-ms': String(Math.round(voice.durationMs)), ...(voice.waveform?.length ? { 'x-waveform': voice.waveform.map((v) => v.toFixed(2)).join(',') } : {}) } : {}),
      },
    });
  }
  /** Vuelve a pedir la transcripción de una nota de voz que falló. */
  retryTranscription(attachmentId: string) {
    return this.request<AttachmentDTO>(`/attachments/${attachmentId}/transcribe`, { method: 'POST', json: {} });
  }
  /** Miniatura opcional (JPEG/PNG/WebP ≤ 512 KB) de un adjunto aún pendiente. */
  uploadAttachmentThumb(id: string, thumb: Blob) {
    return this.request<AttachmentDTO>(`/attachments/${id}/thumb`, { method: 'POST', body: thumb, headers: { 'content-type': 'application/octet-stream' } });
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
  async openSide(conversationId: string, input: { messageId: string; userIds: string[]; question?: string }) {
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
  async openDirect(userId: string) {
    const r = await this.request<{ id: string }>('/directs', { method: 'POST', json: { userId } });
    await this.loadBootstrap();
    return r;
  }
  createInvitation(workspaceId: string, input: { email?: string; role: 'member' | 'guest' | 'admin'; conversationIds: string[]; expiresInDays?: number; accessUntil?: string; history?: 'now' | 'all'; lang?: 'es' | 'en' }) {
    return this.request<{ id: string; token: string; expiresAt: string; emailSent: boolean; emailStatus: 'sent' | 'failed' | 'skipped' | null }>(`/workspaces/${workspaceId}/invitations`, { method: 'POST', json: input });
  }
  async previewInvitation(token: string): Promise<InvitationPreviewDTO> {
    const res = await this.raw(`/invitations/${encodeURIComponent(token)}`, {}, false);
    if (!res.ok) throw await parseError(res);
    return res.json();
  }
  async acceptInvitation(token: string) {
    const r = await this.request<{ workspaceId: string; conversationIds: string[] }>(`/invitations/${encodeURIComponent(token)}/accept`, { method: 'POST', json: {} });
    await this.loadBootstrap();
    return r;
  }
  createOrgInvitation(orgId: string, input: { email?: string; role?: 'member' | 'admin'; lang?: 'es' | 'en' } = {}) {
    return this.request<{ id: string; token: string; expiresAt: string; emailSent: boolean; emailStatus: 'sent' | 'failed' | 'skipped' | null }>(`/organizations/${orgId}/invitations`, { method: 'POST', json: input });
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
