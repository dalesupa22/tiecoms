import Foundation
import Network
import Observation
import UserNotifications

/// Estado local de una conversación con mensajes cargados.
struct ConversationState: Equatable {
    var messages: [MessageDTO] = []
    /// Cursor continuo: nunca avanza sobre un hueco.
    var lastEventSeq: Int = 0
    var hasMore: Bool = true
    var loaded: Bool = false
    var loading: Bool = false
    var error: String?
}

struct TypingEntry: Equatable { var userId: String; var until: Date }

enum Route: Hashable {
    case conversation(String)
    case details(String)
    case issue(String)
    case event(String)
    case trazo
    case reminders
    case whatsapp
    case domains(String)
    case deleteAccount
    case workspace(String)
    case profile
    /// Archivos: raíz (lista de ámbitos) o una carpeta de un ámbito (workspaceId nil = «Mis archivos»).
    case files
    case drive(workspaceId: String?, folderId: String?)
}

enum AppTab: Hashable { case home, issues, agenda, settings }

struct AppAlert: Identifiable, Equatable {
    let id = UUID()
    var title: String
    var message: String?
}

/// Cliente TieComs para iOS: sesión, snapshot, tiempo real, cola de envío y
/// navegación. Imita `packages/client-core/src/client.ts` para que web y móvil
/// se comporten igual.
@MainActor
@Observable
final class AppStore {
    enum Status: Equatable { case loading, anonymous, unreachable, ready }
    enum Connection: Equatable { case offline, connecting, online }

    // MARK: Estado observable
    private(set) var status: Status = .loading
    private(set) var connection: Connection = .offline
    private(set) var data: BootstrapDTO?
    private(set) var conversations: [String: ConversationState] = [:]
    private(set) var pending: [PendingMessage] = []
    private(set) var typing: [String: [TypingEntry]] = [:]
    /// Asuntos conocidos por id (se cargan por filtro y se actualizan en vivo).
    var issues: [String: IssueDTO] = [:]
    /// Mensajes fijados por conversación.
    var pins: [String: [String]] = [:]
    var reminders: [ReminderDTO] = []
    var events: [String: CalendarEventDTO] = [:]
    /// Bloqueos sincronizados antes de mostrar el contenido de la sesión.
    var blockedUserIds: Set<String> = []
    /// Sube cuando WhatsApp trae novedades: la pantalla vuelve a pedir la lista.
    var waRevision = 0
    /// Sube cuando cambia algún árbol de archivos visible (drive.updated).
    var driveRevision = 0
    /// Aviso breve (toast).
    var toast: String?
    /// Salto pendiente a un mensaje (?m=<seq>) por conversación.
    var jumpTo: [String: Int] = [:]
    /// Respuestas en privado pendientes por conversación directa (cita sobre el compositor).
    var privateReplies: [String: PrivateReplyDraft] = [:]
    /// Texto compartido hacia TieComs (tiecoms://share?text=…).
    var shareText: String?

    var tab: AppTab = .home
    /// La app se abrió en frío por un enlace (splash corto).
    var launchedByLink = false
    var myOpenIssues: Int { guard let me = me?.id else { return 0 }; return issues.values.filter { $0.ownerId == me && !$0.status.closed }.count }
    func show(_ message: String) { toast = message }
    var homePath: [Route] = []
    var issuesPath: [Route] = []
    var agendaPath: [Route] = []
    var settingsPath: [Route] = []
    var workspaceFilter: String?
    /// Abre una pantalla en la pila de la pestaña visible.
    func push(_ r: Route) {
        switch tab {
        case .home: homePath.append(r)
        case .issues: issuesPath.append(r)
        case .agenda: agendaPath.append(r)
        case .settings: settingsPath.append(r)
        }
    }
    var alert: AppAlert?
    /// Invitación a un espacio abierta por enlace (hoja modal).
    var inviteToken: String?
    /// Registro con invitación de empresa (?org=token).
    var signupOrgToken: String?
    var showSignup = false
    /// Conversación que está en pantalla (la fija la vista).
    var openConversationId: String?
    var appActive = true

    // MARK: Dependencias
    let api: APIClient
    @ObservationIgnored let socket: SocketIOClient
    @ObservationIgnored private let outbox: OutboxStore
    @ObservationIgnored private weak var feedback: FeedbackSink?
    @ObservationIgnored private var pendingLink: DeepLink?
    @ObservationIgnored private var flushTask: Task<Void, Never>?
    @ObservationIgnored private var flushing = false
    @ObservationIgnored private var bootstrapTask: Task<Void, Never>?
    @ObservationIgnored private var catchingUp: Set<String> = []
    @ObservationIgnored private var readTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var lastTypingSent: [String: Date] = [:]
    @ObservationIgnored private var pathMonitor: NWPathMonitor?
    @ObservationIgnored private var lastPathSatisfied = true
    /// Contadores para pruebas/diagnóstico.
    @ObservationIgnored private(set) var liveEventsApplied = 0
    @ObservationIgnored private(set) var catchUpEventsApplied = 0
    @ObservationIgnored private(set) var deliveredViaSocket = 0
    @ObservationIgnored private(set) var deliveredViaHTTP = 0
    @ObservationIgnored var remindersDue = 0
    @ObservationIgnored private var badgeTask: Task<Void, Never>?
    /// Último token APNs registrado en el API (pruebas y diagnóstico).
    @ObservationIgnored var registeredPushToken: String?
    /// Pantalla previa al permiso de notificaciones.
    var showPushPrompt = false
    @ObservationIgnored var onLiveMessage: ((MessageDTO) -> Void)?
    @ObservationIgnored var onReady: (() -> Void)?

    init(baseURL: URL, secrets: SecretStore, outbox: OutboxStore = OutboxStore(), feedback: FeedbackSink?, session: URLSession? = nil) {
        api = APIClient(baseURL: baseURL, secrets: secrets, session: session)
        socket = SocketIOClient(baseURL: baseURL)
        self.outbox = outbox
        self.feedback = feedback
        api.onSignedOut = { [weak self] in self?.handleSignedOut() }
        socket.tokenProvider = { [weak self] in await self?.api.freshAccessToken() }
        socket.onStateChange = { [weak self] s in
            guard let self else { return }
            // "online" llega con el evento `ready` (salas ya unidas).
            if s == .disconnected { self.connection = .offline } else if s == .connecting { self.connection = .connecting }
        }
        socket.onConnectError = { [weak self] msg in
            guard let self, msg == "unauthorized" else { return }
            Task { @MainActor in
                if await self.api.refresh() == .unauthorized { self.handleSignedOut() }
            }
        }
        socket.onEvent = { [weak self] name, payload in self?.onSocketEvent(name, payload) }
    }

    var me: UserDTO? { data?.me }

    // MARK: - Sesión

    /// Arranque: intenta reanudar la sesión guardada en el Keychain.
    func start() async {
        status = .loading
        guard api.hasStoredSession else { status = .anonymous; return }
        switch await api.refresh() {
        case .ok:
            do { try await afterLogin() } catch { status = api.accessToken == nil ? .anonymous : .unreachable }
        case .unauthorized:
            api.clearCredentials()
            status = .anonymous
        case .network:
            status = .unreachable
        }
    }

    func login(email: String, password: String) async throws {
        _ = try await api.login(email: email.trimmingCharacters(in: .whitespacesAndNewlines), password: password)
        try await afterLogin()
    }

    func signup(name: String, email: String, password: String, orgName: String?, orgInviteToken: String?, title: String?) async throws {
        var input: [String: Any] = ["name": name, "email": email.trimmingCharacters(in: .whitespacesAndNewlines), "password": password]
        if let orgInviteToken { input["orgInviteToken"] = orgInviteToken } else if let orgName { input["orgName"] = orgName }
        if let title, !title.isEmpty { input["title"] = title }
        _ = try await api.signup(input)
        try await afterLogin()
    }

    /// SSO con Google/Microsoft: PKCE S256 + ASWebAuthenticationSession + canje del código.
    /// Devuelve normalmente si el usuario cancela (no hay nada que mostrar).
    func loginWithSSO(_ provider: SSOProvider, orgInviteToken: String? = nil, orgName: String? = nil, authenticator: SSOAuthenticator? = nil) async throws {
        let authenticator = authenticator ?? SSOAuthenticator()
        let pkce = PKCE.generate()
        let url = SSOAuthenticator.startURL(base: api.baseURL, provider: provider, deviceId: Prefs.deviceId, pkce: pkce,
                                            orgInviteToken: orgInviteToken, orgName: orgName)
        let code: String
        do { code = try await authenticator.authenticate(url: url) } catch SSOError.cancelled { return }
        try await completeSSO(code: code, verifier: pkce.verifier)
    }

    func completeSSO(code: String, verifier: String) async throws {
        _ = try await api.ssoExchange(code: code, verifier: verifier)
        try await afterLogin()
    }

    private func afterLogin() async throws {
        try await loadBootstrap()
        guard let me = data?.me.id else { return }
        pending = outbox.load(userId: me).map { var p = $0; if p.status == .sending { p.status = .pending }; return p }
        status = .ready
        showSignup = false
        signupOrgToken = nil
        socket.connect()
        startPathMonitor()
        scheduleFlush(0)
        consumePendingLink()
        #if DEBUG
        // Solo pruebas/diagnóstico: abrir una conversación al entrar (-TCOpenConversation <id>).
        if let id = AppConfig.launchValue("TCOpenConversation") { navigate(to: .conversation(id)) }
        #endif
        Task { try? await loadReminders() }
        onReady?()
    }

    func logout() async {
        // El logout del API ya borra el token de la sesión; se borra antes por si falla la red después.
        await unregisterPush()
        await api.logout()
        handleSignedOut()
    }

    /// Borra credenciales y estado local (tras eliminar la cuenta o si el servidor la cierra).
    func signOutLocally() async {
        api.clearCredentials()
        handleSignedOut()
    }

    private func handleSignedOut() {
        ShareTargets.clear()
        Donations.deleteAll()
        socket.disconnect()
        pathMonitor?.cancel(); pathMonitor = nil
        api.clearCredentials()
        status = .anonymous
        connection = .offline
        data = nil
        conversations = [:]
        pending = []
        typing = [:]
        issues = [:]; pins = [:]; reminders = []; events = [:]
        blockedUserIds = []
        homePath = []; issuesPath = []; agendaPath = []; settingsPath = []
        tab = .home
        workspaceFilter = nil
        openConversationId = nil
    }

    // MARK: - Snapshot

    func loadBootstrap() async throws {
        try await loadBlockedUsers()
        var d: BootstrapDTO = try await api.request("/bootstrap")
        d.conversations.sort { ($0.lastMessageAt ?? "") > ($1.lastMessageAt ?? "") }
        defer { scheduleBadge() }
        data = d
        // Conversaciones que ya no están en mi alcance se purgan de la caché local.
        let allowed = Set(d.conversations.map(\.id))
        conversations = conversations.filter { allowed.contains($0.key) }
        func keep(_ p: [Route]) -> [Route] {
            p.filter { if case .conversation(let id) = $0 { return allowed.contains(id) }; if case .details(let id) = $0 { return allowed.contains(id) }; return true }
        }
        if keep(homePath) != homePath { homePath = keep(homePath) }
        if keep(issuesPath) != issuesPath { issuesPath = keep(issuesPath) }
        if keep(agendaPath) != agendaPath { agendaPath = keep(agendaPath) }
        ShareTargets.save(d, apiURL: api.baseURL)
    }

    func scheduleBootstrap() {
        guard bootstrapTask == nil else { return }
        bootstrapTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard let self else { return }
            self.bootstrapTask = nil
            try? await self.loadBootstrap()
        }
    }

    func refreshAll() async {
        guard status == .ready else { return }
        await resync()
    }

    // MARK: - Tiempo real

    private func onSocketEvent(_ name: String, _ payload: Any?) {
        switch name {
        case "ready":
            connection = .online
            Task { await resync() }
        case "conv.event":
            if let e = JSONBridge.decode(ConversationEvent.self, from: payload) { onConversationEvent(e, live: true) }
        case "account.event":
            if let e = JSONBridge.decode(AccountEvent.self, from: payload) { onAccountEvent(e) }
        case "typing":
            if let e = JSONBridge.decode(TypingEvent.self, from: payload) { onTyping(e) }
        default:
            break // eventos desconocidos: se ignoran
        }
    }

    /// Tras reconectar o volver del segundo plano: snapshot + recuperación de huecos + cola.
    func resync() async {
        guard status == .ready else { return }
        do {
            try await loadBootstrap()
            for c in data?.conversations ?? [] {
                guard let local = conversations[c.id], local.loaded else { continue }
                if c.lastEventSeq > local.lastEventSeq || c.id == openConversationId { await catchUp(c.id) }
            }
        } catch {}
        scheduleFlush(0)
    }

    private func onAccountEvent(_ e: AccountEvent) {
        switch e {
        case .scopeChanged: scheduleBootstrap()
        case .readUpdated(let id, let seq):
            guard let c = meta(id), seq > c.lastReadSeq else { return }
            patchMeta(id) { $0.lastReadSeq = seq; $0.unread = max(0, $0.lastMessageSeq - max(seq, $0.historyFromSeq)) }
        case .reminderDue(let r):
            reminders = (reminders.filter { $0.id != r.id } + [r]).sorted { $0.remindAt < $1.remindAt }
            remindersDue += 1
            if let d = data {
                let conv = meta(r.conversationId)
                feedback?.notifyIncoming(conversationId: r.conversationId, title: L("rem.alert"),
                                         author: conv.map { Naming.title(d, $0) } ?? "", body: r.note ?? "")
            }
        case .prefsUpdated: scheduleBootstrap()
        case .whatsappUpdated: waRevision += 1
        case .driveUpdated: driveRevision += 1
        case .other: break
        }
    }

    private func onTyping(_ e: TypingEvent) {
        guard e.userId != me?.id else { return }
        let now = Date()
        var list = (typing[e.conversationId] ?? []).filter { $0.until > now && $0.userId != e.userId }
        list.append(TypingEntry(userId: e.userId, until: now.addingTimeInterval(4)))
        typing[e.conversationId] = list
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 4_100_000_000)
            guard let self else { return }
            let n = Date()
            self.typing[e.conversationId] = (self.typing[e.conversationId] ?? []).filter { $0.until > n }
        }
    }

    /// Efectos que no dependen de tener los mensajes cargados (idempotentes).
    private func sideEffects(_ e: ConversationEvent, live: Bool) {
        switch e {
        case .issueUpdated(let cid, _, let issue):
            issues[issue.id] = issue
            recountIssues(cid)
        case .pinsChanged(let cid, _, let ids):
            pins[cid] = ids
        case .calendarUpdated(let cid, _, let ev):
            let isNewEvent = events[ev.id] == nil
            events[ev.id] = ev
            // Reunión nueva de otra persona en vivo → aviso con tc_notify (salvo silenciada).
            if live, isNewEvent, ev.organizerId != me?.id, !ev.isCancelled, let d = data, let c = meta(cid), !c.isMuted {
                feedback?.notifyIncoming(conversationId: cid, title: ev.title, author: Naming.title(d, c), body: L10n.eventWhen(ev))
            }
        case .messageUpdated(_, _, let m):
            patchPreviewIfLast(m)
        default: break
        }
    }

    func recountIssues(_ conversationId: String) {
        let n = issues.values.filter { $0.conversationId == conversationId && !$0.status.closed }.count
        patchMeta(conversationId) { $0.openIssues = n }
    }

    func patchPreviewIfLast(_ m: MessageDTO) {
        guard let c = meta(m.conversationId), c.lastMessageSeq == m.seq else { return }
        patchMeta(m.conversationId) { $0.lastMessagePreview = String((m.deletedAt != nil ? L("chat.deleted") : m.body).prefix(140)) }
    }

    func onConversationEvent(_ e: ConversationEvent, live: Bool) {
        guard let m = meta(e.conversationId) else { scheduleBootstrap(); return }
        sideEffects(e, live: live)
        var isNew = false
        if case .messageCreated(_, _, let msg) = e { isNew = bumpMeta(msg) }
        guard let local = conversations[e.conversationId], local.loaded else {
            patchMeta(e.conversationId) { $0.lastEventSeq = max(m.lastEventSeq, e.eventSeq) }
            if live, isNew, case .messageCreated(_, _, let msg) = e { announce(msg) }
            return
        }
        if e.eventSeq <= local.lastEventSeq { return } // duplicado de transporte
        if e.eventSeq > local.lastEventSeq + 1 { Task { await catchUp(e.conversationId) }; return } // hueco
        apply(e)
        if live {
            liveEventsApplied += 1
            if case .messageCreated(_, _, let msg) = e { announce(msg); onLiveMessage?(msg) }
        }
    }

    /// Sonido/aviso por un mensaje recibido en vivo (nunca en el catch-up ni por mensajes de sistema).
    private func announce(_ msg: MessageDTO) {
        guard msg.authorId != me?.id, !blockedUserIds.contains(msg.authorId), !msg.isSystem, let d = data else { return }
        if msg.conversationId == openConversationId && appActive {
            feedback?.playReceive()
        } else if let c = meta(msg.conversationId), !c.isMuted {
            let author = Naming.person(d, msg.authorId)?.name ?? L("common.participant")
            feedback?.notifyIncoming(conversationId: c.id, title: Naming.title(d, c), author: author, body: msg.body)
        }
    }

    @discardableResult
    private func bumpMeta(_ m: MessageDTO) -> Bool {
        guard let c = meta(m.conversationId), m.seq > c.lastMessageSeq else { return false }
        let mine = m.authorId == me?.id
        patchMeta(c.id) {
            $0.lastMessageSeq = m.seq
            $0.lastMessageAt = m.createdAt
            $0.lastMessagePreview = String(L10n.messagePreview(m).prefix(140))
            if mine { $0.lastReadSeq = m.seq }
            $0.unread = max(0, m.seq - max($0.lastReadSeq, $0.historyFromSeq))
        }
        // Reordena para que la conversación con actividad suba.
        data?.conversations.sort { ($0.lastMessageAt ?? "") > ($1.lastMessageAt ?? "") }
        return true
    }

    private func apply(_ e: ConversationEvent) {
        guard var local = conversations[e.conversationId] else { return }
        switch e {
        case .messageCreated(_, _, let m), .messageUpdated(_, _, let m):
            local.messages = AppStore.upsert(local.messages, m)
        case .membersChanged(let id, _, let ids):
            patchMeta(id) { $0.memberIds = ids }
            scheduleBootstrap()
        case .issueUpdated, .pinsChanged, .calendarUpdated:
            break // sus efectos van en sideEffects (también sin mensajes cargados)
        case .other:
            break // redacted o tipos futuros: solo avanzan el cursor
        }
        local.lastEventSeq = e.eventSeq
        conversations[e.conversationId] = local
        if case .messageCreated(_, _, let m) = e { dropPending(m) }
    }

    func catchUp(_ id: String) async {
        guard !catchingUp.contains(id) else { return }
        catchingUp.insert(id)
        defer { catchingUp.remove(id) }
        do {
            while true {
                guard let local = conversations[id] else { return }
                let page: EventsPage = try await api.request("/conversations/\(id)/events?after=\(local.lastEventSeq)&limit=200")
                if page.resetRequired {
                    catchingUp.remove(id)
                    try await openConversation(id, force: true)
                    return
                }
                for e in page.events where e.eventSeq > (conversations[id]?.lastEventSeq ?? 0) {
                    if case .messageCreated(_, _, let m) = e { bumpMeta(m) }
                    sideEffects(e, live: false)
                    apply(e)
                    catchUpEventsApplied += 1
                }
                if page.events.count < 200 { return }
            }
        } catch {}
    }

    // MARK: - Conversaciones

    func meta(_ id: String) -> ConversationDTO? { data?.conversations.first { $0.id == id } }

    func patchMeta(_ id: String, _ f: (inout ConversationDTO) -> Void) {
        guard let i = data?.conversations.firstIndex(where: { $0.id == id }) else { return }
        f(&data!.conversations[i])
        scheduleBadge()
    }

    /// Badge del ícono = no leídos de las conversaciones NO silenciadas (igual que el servidor).
    var badgeCount: Int { Naming.unreadCount(data?.conversations ?? []) }

    func scheduleBadge() {
        badgeTask?.cancel()
        badgeTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard let self, !Task.isCancelled else { return }
            try? await UNUserNotificationCenter.current().setBadgeCount(self.status == .ready ? self.badgeCount : 0)
        }
    }

    func patchWorkspace(_ id: String, _ f: (inout WorkspaceDTO) -> Void) {
        guard let i = data?.workspaces.firstIndex(where: { $0.id == id }) else { return }
        f(&data!.workspaces[i])
    }

    /// Mensaje local ya conocido (actualiza la lista y la vista previa).
    func upsertLocal(_ m: MessageDTO) {
        if var local = conversations[m.conversationId], local.loaded {
            local.messages = AppStore.upsert(local.messages, m)
            conversations[m.conversationId] = local
        }
        patchPreviewIfLast(m)
    }

    func openConversation(_ id: String, force: Bool = false) async throws {
        if let local = conversations[id], local.loaded, !force { await catchUp(id); return }
        if conversations[id]?.loading == true { return }
        conversations[id, default: ConversationState()].loading = true
        conversations[id]?.error = nil
        do {
            let page: MessagesPage = try await api.request("/conversations/\(id)/messages?limit=50")
            conversations[id] = ConversationState(messages: page.messages.sorted { $0.seq < $1.seq }, lastEventSeq: page.lastEventSeq,
                                                  hasMore: page.hasMore, loaded: true, loading: false)
            // Eventos que llegaron mientras cargábamos.
            await catchUp(id)
        } catch {
            conversations[id]?.loading = false
            conversations[id]?.error = L10n.errorText(error)
            throw error
        }
    }

    func loadOlder(_ id: String) async {
        guard let local = conversations[id], local.loaded, local.hasMore, !local.loading, let before = local.messages.first?.seq else { return }
        conversations[id]?.loading = true
        do {
            let page: MessagesPage = try await api.request("/conversations/\(id)/messages?before=\(before)&limit=50")
            let cur = conversations[id]?.messages ?? []
            let known = Set(cur.map(\.id))
            conversations[id]?.messages = page.messages.filter { !known.contains($0.id) }.sorted { $0.seq < $1.seq } + cur
            conversations[id]?.hasMore = page.hasMore
        } catch {}
        conversations[id]?.loading = false
    }

    /// Marca como leído con debounce (400 ms).
    func markRead(_ id: String) {
        guard let c = meta(id), c.lastMessageSeq > c.lastReadSeq else { return }
        patchMeta(id) { $0.lastReadSeq = $0.lastMessageSeq; $0.unread = 0 }
        readTasks[id]?.cancel()
        readTasks[id] = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard let self, !Task.isCancelled else { return }
            let seq = self.meta(id)?.lastReadSeq ?? 0
            _ = try? await self.api.requestData("/conversations/\(id)/read", method: "POST", json: ["seq": seq])
        }
        AppFeedback.shared.clearNotifications(conversationId: id)
    }

    /// Aviso de "escribiendo", como máximo cada 2 s.
    func userIsTyping(_ id: String) {
        let now = Date()
        if let last = lastTypingSent[id], now.timeIntervalSince(last) < 2 { return }
        lastTypingSent[id] = now
        socket.emit("typing", ["conversationId": id])
    }

    func typingNames(_ id: String) -> [String] {
        guard let d = data else { return [] }
        let now = Date()
        return (typing[id] ?? []).filter { $0.until > now }.compactMap { Naming.person(d, $0.userId)?.name }
    }

    // MARK: - Envío con cola persistente

    @discardableResult
    func send(_ conversationId: String, body: String, replyTo: String? = nil, forwarded: ForwardedInfo? = nil,
              attachments: [AttachmentDTO] = [], forwardAttachments: [AttachmentDTO] = [],
              clientMessageId: String = UUID().uuidString.lowercased()) -> PendingMessage? {
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        // Con adjuntos el texto puede ir vacío.
        guard !text.isEmpty || !attachments.isEmpty || !forwardAttachments.isEmpty else { return nil }
        let p = PendingMessage(clientMessageId: clientMessageId, conversationId: conversationId, body: String(text.prefix(8000)), replyTo: replyTo,
                               forwarded: forwarded, attachmentIds: attachments.isEmpty ? nil : attachments.map(\.id),
                               forwardAttachmentIds: forwardAttachments.isEmpty ? nil : forwardAttachments.map(\.id),
                               attachments: (attachments + forwardAttachments).isEmpty ? nil : attachments + forwardAttachments,
                               createdAt: ISODate.string(), attempts: 0, status: .pending, error: nil, nextAttemptAt: 0)
        Donations.donate(self, conversationId: conversationId)
        // Primero se guarda localmente: si la app se cierra, el mensaje sigue en la cola.
        savePending(pending + [p])
        scheduleFlush(0)
        return p
    }

    func retry(_ clientMessageId: String) {
        savePending(pending.map { var p = $0; if p.clientMessageId == clientMessageId { p.status = .pending; p.nextAttemptAt = 0; p.error = nil }; return p })
        scheduleFlush(0)
    }

    func discard(_ clientMessageId: String) {
        savePending(pending.filter { $0.clientMessageId != clientMessageId })
    }

    private func savePending(_ list: [PendingMessage]) {
        pending = list
        if let me = me?.id { outbox.save(list, userId: me) }
    }

    private func dropPending(_ m: MessageDTO) {
        guard m.authorId == me?.id, let cid = m.clientMessageId, pending.contains(where: { $0.clientMessageId == cid }) else { return }
        savePending(pending.filter { $0.clientMessageId != cid })
    }

    private func scheduleFlush(_ seconds: Double) {
        flushTask?.cancel()
        flushTask = Task { @MainActor [weak self] in
            if seconds > 0 { try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }
            guard let self, !Task.isCancelled else { return }
            self.flushTask = nil
            await self.flush()
        }
    }

    private func flush() async {
        guard !flushing, status == .ready else { return }
        flushing = true
        defer { flushing = false }
        // En orden: dentro de una conversación, los mensajes salen uno tras otro.
        for p in pending {
            guard p.status != .failed, p.nextAttemptAt <= Date().timeIntervalSince1970 * 1000 else { continue }
            guard pending.contains(where: { $0.clientMessageId == p.clientMessageId }) else { continue }
            updatePending(p.clientMessageId) { $0.status = .sending }
            do {
                let message = try await deliver(p)
                feedback?.playSend()
                if var local = conversations[p.conversationId], local.loaded {
                    local.messages = AppStore.upsert(local.messages, message)
                    conversations[p.conversationId] = local
                }
                bumpMeta(message)
                savePending(pending.filter { $0.clientMessageId != p.clientMessageId })
            } catch {
                let e = error as? ApiRequestError
                let permanent = e?.permanent ?? false
                let attempts = p.attempts + 1
                let backoff = min(30_000, 500 * pow(2, Double(attempts))) * (0.5 + Double.random(in: 0..<1))
                updatePending(p.clientMessageId) {
                    $0.attempts = attempts
                    if permanent { $0.status = .failed; $0.error = e.map(L10n.errorText) }
                    else { $0.status = .pending; $0.nextAttemptAt = Date().timeIntervalSince1970 * 1000 + backoff }
                }
                if !permanent { savePending(pending); scheduleFlush(backoff / 1000); return }
            }
        }
        savePending(pending)
    }

    private func updatePending(_ id: String, _ f: (inout PendingMessage) -> Void) {
        guard let i = pending.firstIndex(where: { $0.clientMessageId == id }) else { return }
        f(&pending[i])
    }

    /// Socket con ACK si está conectado; HTTP como respaldo. Mismo clientMessageId = idempotente.
    func deliver(_ p: PendingMessage) async throws -> MessageDTO {
        var payload: [String: Any] = ["conversationId": p.conversationId, "clientMessageId": p.clientMessageId, "body": p.body,
                                      "replyTo": p.replyTo ?? NSNull(), "forwarded": p.forwarded?.json ?? NSNull()]
        if let ids = p.attachmentIds, !ids.isEmpty { payload["attachmentIds"] = ids }
        if let ids = p.forwardAttachmentIds, !ids.isEmpty { payload["forwardAttachmentIds"] = ids }
        if socket.state == .connected {
            do {
                let r = try await socket.emitWithAck("message.send", payload, timeout: 8) as? [String: Any]
                if r?["ok"] as? Bool == true, let m = JSONBridge.decode(MessageDTO.self, from: r?["message"]) { deliveredViaSocket += 1; return m }
                if let err = r?["error"] as? [String: Any] {
                    let code = err["code"] as? String ?? "error"
                    let status = ["forbidden": 403, "not_found": 404, "conflict": 409, "bad_request": 400][code] ?? 503
                    throw ApiRequestError(status: status, code: code, message: err["message"] as? String ?? "")
                }
            } catch let e as ApiRequestError {
                throw e
            } catch {
                // Timeout o caída del socket: se reintenta por HTTP con el mismo identificador.
            }
        }
        var body = payload
        body.removeValue(forKey: "conversationId")
        let r: SendResult = try await api.request("/conversations/\(p.conversationId)/messages", method: "POST", json: body)
        deliveredViaHTTP += 1
        return r.message
    }

    static func upsert(_ list: [MessageDTO], _ m: MessageDTO) -> [MessageDTO] {
        if let i = list.firstIndex(where: { $0.id == m.id }) { var c = list; c[i] = m; return c }
        if list.last.map({ $0.seq < m.seq }) ?? true { return list + [m] }
        return (list + [m]).sorted { $0.seq < $1.seq }
    }

    /// Pendientes aún no reconciliados de una conversación.
    func pendingFor(_ id: String) -> [PendingMessage] {
        let known = Set(conversations[id]?.messages.compactMap(\.clientMessageId) ?? [])
        return pending.filter { $0.conversationId == id && !known.contains($0.clientMessageId) }
    }

    // MARK: - Invitaciones

    func previewInvitation(_ token: String) async throws -> InvitationPreviewDTO {
        try await api.publicRequest("/invitations/\(token.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? token)")
    }

    func previewOrgInvitation(_ token: String) async throws -> OrgInvitationPreviewDTO {
        try await api.publicRequest("/org-invitations/\(token.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? token)")
    }

    func acceptInvitation(_ token: String) async throws {
        let r: AcceptInvitationResult = try await api.request("/invitations/\(token.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? token)/accept", method: "POST", json: [:])
        try await loadBootstrap()
        inviteToken = nil
        if let first = r.conversationIds.first { navigate(to: .conversation(first)) } else { navigate(to: .workspace(r.workspaceId)) }
    }

    // MARK: - Enlaces

    func handle(url: URL) {
        // tiecoms://auth/* es del flujo SSO (lo recibe ASWebAuthenticationSession), no es navegación.
        guard !SSOCallback.isReserved(url), let link = DeepLink.parse(url) else { return }
        if case .conversation(let id) = link, let seq = DeepLink.messageSeq(url) { jumpTo[id] = seq }
        handle(link)
    }

    func handle(_ link: DeepLink) {
        switch link {
        case .invite(let token):
            // La vista previa es pública: se muestra aunque no haya sesión.
            inviteToken = token
        case .signup(let org):
            if status == .ready { return }
            signupOrgToken = org
            showSignup = true
        case .share(let text):
            shareText = text ?? ""
            if status != .ready { pendingLink = link }
        default:
            if status == .ready { navigate(to: link) } else { pendingLink = link }
        }
    }

    /// Si no hay sesión se guarda y se abre al entrar.
    func rememberAfterLogin(_ link: DeepLink) { pendingLink = link }

    private func consumePendingLink() {
        guard let l = pendingLink else { return }
        pendingLink = nil
        navigate(to: l)
    }

    func navigate(to link: DeepLink) {
        guard status == .ready, let d = data else { pendingLink = link; return }
        switch link {
        case .conversation(let id):
            guard d.conversations.contains(where: { $0.id == id }) else {
                alert = AppAlert(title: L("link.noAccess"), message: nil)
                return
            }
            tab = .home
            homePath = [.conversation(id)]
        case .workspace(let id):
            guard d.workspaces.contains(where: { $0.id == id }) else {
                alert = AppAlert(title: L("link.noAccessSpace"), message: nil)
                return
            }
            tab = .home
            homePath = []
            workspaceFilter = id
        case .invite(let t): inviteToken = t
        case .signup: break
        case .issues: tab = .issues; issuesPath = []
        case .agenda: tab = .agenda; agendaPath = []
        case .trazo: tab = .home; homePath = [.trazo]
        case .whatsapp: tab = .settings; settingsPath = [.whatsapp]
        case .share(let text): shareText = text ?? ""
        }
    }

    // MARK: - Ciclo de vida

    func becameActive() {
        appActive = true
        guard status == .ready else {
            if status == .unreachable { Task { await start() } }
            return
        }
        socket.reconnectNow()
        Task { await resync() }
    }

    func enteredBackground() { appActive = false }

    private func startPathMonitor() {
        guard pathMonitor == nil else { return }
        let m = NWPathMonitor()
        m.pathUpdateHandler = { [weak self] path in
            let ok = path.status == .satisfied
            Task { @MainActor in
                guard let self else { return }
                if ok && !self.lastPathSatisfied { self.socket.reconnectNow() }
                self.lastPathSatisfied = ok
            }
        }
        m.start(queue: DispatchQueue(label: "tiecoms.path"))
        pathMonitor = m
    }
}

#if DEBUG
extension AppStore {
    /// Solo pruebas: fija un snapshot sin red.
    func seedForTesting(_ d: BootstrapDTO, conversations: [String: ConversationState] = [:]) {
        data = d
        self.conversations = conversations
        status = .ready
    }
}
#endif
