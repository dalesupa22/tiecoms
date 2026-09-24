import { io, type Socket } from 'socket.io-client';
import {
  CONTRACT_VERSION, SOCKET_EVENTS,
  type AccountEvent, type AuthResult, type BootstrapDTO, type ConversationDTO, type ConversationEvent, type DeviceInfo,
  type EventsPage, type InvitationPreviewDTO, type MessageDTO, type Platform,
} from '@tiecoms/contracts';
import { ApiRequestError, parseError } from './api.ts';
import type { KeyValueStorage, SecretStore } from './storage.ts';

export interface PendingMessage {
  clientMessageId: string;
  conversationId: string;
  body: string;
  replyTo: string | null;
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
}

export interface ClientOptions {
  /** Origen del API, p. ej. https://app.tiecoms.com. Vacío = mismo origen (web). */
  baseUrl: string;
  platform: Platform;
  deviceName: string;
  storage: KeyValueStorage;
  /** Nativo: dónde guardar el refresh token. Web: omitir (cookie httpOnly). */
  secrets?: SecretStore;
}

const uid = () => (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36));

/**
 * Cliente TieComs independiente de la interfaz. Toda la lógica de envío,
 * reintentos, orden, recuperación y no leídos vive aquí para que web,
 * escritorio y móvil se comporten igual.
 */
export class TieComsClient {
  private state: ClientState = { status: 'loading', connection: 'offline', data: null, conversations: {}, pending: [], typing: {} };
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

  async signup(input: { name: string; email: string; password: string; orgName: string; title?: string }) {
    const res = await this.raw('/auth/signup', { method: 'POST', json: { ...input, device: await this.device() } }, false);
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
    this.state = { status: 'anonymous', connection: 'offline', data: null, conversations: {}, pending: [], typing: {} };
    this.listeners.forEach((l) => l());
  }

  private async afterLogin() {
    await this.loadBootstrap();
    const me = this.state.data!.me.id;
    const pending = (await this.opts.storage.get<PendingMessage[]>(`u:${me}:outbox`)) ?? [];
    this.set({ status: 'ready', pending: pending.map((p) => ({ ...p, status: p.status === 'sending' ? 'pending' : p.status })) });
    this.connect();
    this.scheduleFlush(0);
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
    if (e.type === 'read.updated') {
      const c = this.state.data?.conversations.find((x) => x.id === e.conversationId);
      if (c && e.seq > c.lastReadSeq) this.patchConversationMeta(c.id, { lastReadSeq: e.seq, unread: Math.max(0, c.lastMessageSeq - Math.max(e.seq, c.historyFromSeq)) });
    }
  }

  private onConversationEvent(e: ConversationEvent) {
    const local = this.state.conversations[e.conversationId];
    const meta = this.state.data?.conversations.find((c) => c.id === e.conversationId);
    if (!meta) { this.scheduleBootstrap(); return; }
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
  async send(conversationId: string, body: string, replyTo: string | null = null) {
    const text = body.trim();
    if (!text) return;
    const p: PendingMessage = {
      clientMessageId: uid(), conversationId, body: text, replyTo, createdAt: new Date().toISOString(),
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
    const payload = { conversationId: p.conversationId, clientMessageId: p.clientMessageId, body: p.body, replyTo: p.replyTo };
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
      method: 'POST', json: { clientMessageId: p.clientMessageId, body: p.body, replyTo: p.replyTo },
    });
    return r.message;
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
  createInvitation(workspaceId: string, input: { email?: string; role: 'member' | 'guest' | 'admin'; conversationIds: string[]; expiresInDays?: number; accessUntil?: string; history?: 'now' | 'all' }) {
    return this.request<{ id: string; token: string; expiresAt: string }>(`/workspaces/${workspaceId}/invitations`, { method: 'POST', json: input });
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
  sessions() { return this.request<{ sessions: { id: string; deviceName: string; platform: string; lastSeenAt: string }[]; current: string }>('/sessions'); }
  revokeSession(id: string) { return this.request(`/sessions/${id}`, { method: 'DELETE' }); }
}

function upsertMessage(list: MessageDTO[], m: MessageDTO): MessageDTO[] {
  const i = list.findIndex((x) => x.id === m.id);
  if (i >= 0) { const copy = list.slice(); copy[i] = m; return copy; }
  if (!list.length || list[list.length - 1]!.seq < m.seq) return [...list, m];
  return [...list, m].sort((a, b) => a.seq - b.seq);
}
