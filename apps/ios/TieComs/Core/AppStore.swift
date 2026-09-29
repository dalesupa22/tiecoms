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
    /// El error es pasajero (5xx, 502 de un despliegue, red): la vista reintenta sola y muestra «Reconectando…».
    var transient: Bool = false
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
    /// «Documentos que firmé» (historial de firmas y firmas guardadas).
    case signed
    /// Archivos: raíz (lista de ámbitos) o una carpeta de un ámbito (workspaceId nil = «Mis archivos»).
    case files
    case drive(workspaceId: String?, folderId: String?)
    /// Supervisión de una empresa (owner/admin) y visor de solo lectura de un grupo donde no soy miembro.
    case oversight(String)
    case oversightReader(conversationId: String, name: String)
    /// Mis mensajes programados (Tú › Programados).
    case scheduled
    /// Detalle de una llamada: resumen, transcripción y Compartir (docs/LLAMADAS.md).
    case callDetail(String)
}

/// Barra inferior (docs/GRUPOS.md): Grupos (`home`) · DMs · Asuntos · Calendario · Llamadas (solo con `features.calls`) · Tú (`settings`).
enum AppTab: Hashable, CaseIterable { case home, dms, issues, agenda, calls, settings }

struct AppAlert: Identifiable, Equatable {
    let id = UUID()
    var title: String
    var message: String?
}

/// Cliente Chaggu para iOS: sesión, snapshot, tiempo real, cola de envío y
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
    /// Temas por conversación (activos y archivados), en el orden de la fila (docs/TEMAS.md).
    var topics: [String: [TopicDTO]] = [:]
    /// Últimos comentarios de cada tarjeta de tarea del chat (y con cuántos comentarios se pidieron). Vive en el store:
    /// la LazyVStack recrea la tarjeta al volver a verla y, con @State, su alto cambiaba y la lista no dejaba de reubicarse.
    var taskCardComments: [String: TaskCardComments] = [:]
    var reminders: [ReminderDTO] = []
    var events: [String: CalendarEventDTO] = [:]
    /// Mis mensajes programados pendientes, enviándose o fallidos (docs/PROGRAMADOS.md), por hora de salida.
    var scheduled: [ScheduledMessageDTO] = []
    /// Sube cada minuto (MainView): la ventana de descanso y sus avisos entran y salen solos.
    var clockTick = 0
    /// Hoja «Todas las noches» (desde «No molestar» o Tú).
    var showSleepSettings = false
    /// Push de tarea tocado antes de tener sesión.
    var pendingIssue: PendingIssue?
    /// «＋ Tarea derivada» / «💬 Hablar aparte» desde el menú de un asunto.
    var issueSheet: IssueSheet?
    var issueSheetHost: String?
    /// Bloqueos sincronizados antes de mostrar el contenido de la sesión.
    var blockedUserIds: Set<String> = []
    /// Sube cuando WhatsApp trae novedades: la pantalla vuelve a pedir la lista.
    var waRevision = 0
    /// Sube cuando cambia algún árbol de archivos visible (drive.updated).
    var driveRevision = 0
    /// Cambió una conexión de reuniones (Meet/Teams/Zoom): el diálogo y Ajustes vuelven a pedir el estado.
    var meetingsRevision = 0
    /// Aviso breve (toast).
    var toast: String?
    /// «Deshacer» del aviso actual (completar o descartar un asunto); se borra al cambiar el aviso.
    var toastUndo: (() -> Void)?
    /// Hojas abiertas que muestran su propio aviso (el de la pestaña queda tapado).
    /// Salto pendiente a un mensaje (?m=<seq>) por conversación.
    var jumpTo: [String: Int] = [:]
    /// Sidechat a desplegar al abrir una conversación de origen (push TC_SIDE).
    var sideToOpen: [String: String] = [:]
    /// Salto pendiente a un mensaje por id (push de reacción: no trae el seq).
    var jumpToMessage: [String: String] = [:]
    /// Respuestas en privado pendientes por conversación directa (cita sobre el compositor).
    var privateReplies: [String: PrivateReplyDraft] = [:]
    /// Texto compartido hacia Chaggu (chaggu://share?text=…).
    var shareText: String?

    var tab: AppTab = .home
    /// La app se abrió en frío por un enlace (splash corto).
    var launchedByLink = false
    var myOpenIssues: Int { guard let me = me?.id else { return 0 }; return issues.values.filter { $0.ownerId == me && !$0.status.closed }.count }
    /// Sube con cada aviso: el mismo texto dos veces seguidas vuelve a contar su tiempo.
    var toastSeq = 0
    func show(_ message: String) { toastUndo = nil; toast = message; toastSeq += 1 }
    /// Aviso con «Deshacer» (dura un poco más).
    func show(_ message: String, undo: @escaping () -> Void) { toastUndo = undo; toast = message; toastSeq += 1 }
    var homePath: [Route] = []
    var dmsPath: [Route] = []
    var issuesPath: [Route] = []
    var agendaPath: [Route] = []
    var settingsPath: [Route] = []
    var callsPath: [Route] = []
    var workspaceFilter: String?
    /// Pila de la pestaña visible.
    var currentPath: [Route] {
        switch tab {
        case .home: return homePath
        case .dms: return dmsPath
        case .issues: return issuesPath
        case .agenda: return agendaPath
        case .calls: return callsPath
        case .settings: return settingsPath
        }
    }
    /// Abre una pantalla en la pila de la pestaña visible.
    func push(_ r: Route) {
        switch tab {
        case .home: homePath.append(r)
        case .dms: dmsPath.append(r)
        case .issues: issuesPath.append(r)
        case .agenda: agendaPath.append(r)
        case .calls: callsPath.append(r)
        case .settings: settingsPath.append(r)
        }
    }
    /// Volver a tocar la pestaña visible: vuelve a su raíz.
    func popToRoot(_ t: AppTab) {
        switch t {
        case .home: homePath = []
        case .dms: dmsPath = []
        case .issues: issuesPath = []
        case .agenda: agendaPath = []
        case .calls: callsPath = []
        case .settings: settingsPath = []
        }
    }
    var alert: AppAlert?
    /// Invitación a un espacio abierta por enlace (hoja modal).
    var inviteToken: String?
    /// Registro con invitación de empresa (?org=token).
    var signupOrgToken: String?
    var showSignup = false
    /// Conversación que está en pantalla (la fija la vista).
    var openConversationId: String? {
        didSet {
            if oldValue != openConversationId, let oldValue { cancelConversationRecovery(oldValue) }
        }
    }
    /// La conversación que de verdad se está viendo: en pantalla, app activa y mensajes cargados.
    /// Una pantalla vacía por un 502 no cuenta: sus avisos deben salir.
    var visibleConversationId: String? {
        guard appActive, let id = openConversationId, conversations[id]?.loaded == true else { return nil }
        return id
    }
    /// Mensajes que ya pasaron por la decisión de aviso en primer plano (socket o push remoto).
    @ObservationIgnored var announced = AnnouncedLedger(capacity: 300)
    var appActive = true {
        didSet { if !appActive { feedback?.cancelPendingMessages() } }
    }
    /// «No molestar» guardado solo en el dispositivo (el API respondió 404 a PUT /me/dnd: servidor viejo).
    var localDndUntil: Date?
    /// El último cambio de «No molestar» quedó solo en este dispositivo (se avisa en silencio en Tú).
    var dndLocalOnly = false
    /// Sube cuando vence «No molestar» para que la interfaz (lunita, franja) se redibuje sola.
    var dndTick = 0
    @ObservationIgnored var dndExpiryTask: Task<Void, Never>?

    /// Every asynchronous account-scoped result must still belong to this login, including a login to the same account.
    struct SessionStamp: Equatable { let generation: UUID; let userId: String? }
    private var sessionGeneration = UUID()
    var sessionStamp: SessionStamp { SessionStamp(generation: sessionGeneration, userId: me?.id) }
    var foregroundOwner: String { "\(sessionGeneration.uuidString)|\(me?.id ?? "")" }
    var foregroundSilenced: Bool { dndActive || sleepActive }
    func requireSession(_ stamp: SessionStamp) throws {
        guard stamp == sessionStamp, !Task.isCancelled else { throw CancellationError() }
    }
    private func invalidateSessionWork() {
        sessionGeneration = UUID()
        feedback?.cancelPendingMessages()
        api.invalidateRequests()
        bootstrapTask?.cancel(); bootstrapTask = nil
        bootstrapRefreshing = false; bootstrapNeedsRefresh = false; bootstrapSignals = []
        for id in Set(recoveryJobs.keys).union(conversationLoads.keys) { cancelConversationRecovery(id) }
        catchUpOwners = [:]
        announced.removeAll()
        cancelMeetingAuthorization()
        if let userId = me?.id { outbox.clearMeetingAttempts(userId: userId) }
        restoredMeetingUserId = nil
        meetingAttemptStorageError = false
        meetingAttempts = [:]
        meetingPayloads = [:]
        issues = [:]; events = [:]
        for task in readTasks.values { task.cancel() }
        readTasks = [:]; readTargets = [:]; readFailures = []
    }
    @ObservationIgnored private var restoredMeetingUserId: String?
    var meetingAttemptStorageError = false
    func restoreMeetingAttempts() {
        guard let userId = me?.id, restoredMeetingUserId != userId else { return }
        restoredMeetingUserId = userId
        do {
            let saved = try outbox.loadMeetingAttempts(userId: userId)
            meetingAttempts = try saved.map { try JSONDecoder().decode([String: MeetingAttempt].self, from: $0) } ?? [:]
            for key in meetingAttempts.keys { meetingAttempts[key]?.inFlight = false }
        } catch { meetingAttemptStorageError = true }
    }
    func persistMeetingAttempts() throws {
        guard let userId = me?.id else { throw CancellationError() }
        try outbox.saveMeetingAttempts(JSONEncoder().encode(meetingAttempts), userId: userId)
    }
    var meetingPayloads: [String: MeetingPayload] = [:]
    /// Llamada activa por conversación (docs/LLAMADAS.md); sin clave = no hay o no se ha preguntado (ver callsChecked).
    var liveCalls: [String: CallDTO] = [:]
    @ObservationIgnored var callsChecked: Set<String> = []
    /// Sube con cada cambio de una llamada (el historial se vuelve a pedir).
    var callsRevision = 0
    /// La llamada de este dispositivo y el aviso de llamada entrante.
    let callCenter = CallCenter()
    /// «Contestar» desde el push con la app cerrada: se entra al tener sesión.
    @ObservationIgnored var pendingCallJoin: String?

    /// Push de llamada (TC_CALL): Contestar entra con /calls/:id/join (ya o al terminar de abrir).
    func answerCallFromPush(_ callId: String) {
        guard status == .ready else { pendingCallJoin = callId; return }
        pendingCallJoin = nil
        callCenter.dismissRing()
        let center = callCenter
        Task { do { try await center.join(callId, camera: false) } catch { show(L10n.errorText(error)) } }
    }
    var meetingAttempts: [String: MeetingAttempt] = [:]
    @ObservationIgnored var meetingAuthorization: MeetingAuthorization?

    // MARK: Dependencias
    let api: APIClient
    @ObservationIgnored let socket: SocketIOClient
    @ObservationIgnored private let outbox: OutboxStore
    @ObservationIgnored private weak var feedback: FeedbackSink?
    @ObservationIgnored private var pendingLink: DeepLink?
    @ObservationIgnored private var flushTask: Task<Void, Never>?
    @ObservationIgnored private var flushing = false
    @ObservationIgnored private var bootstrapTask: Task<Void, Never>?
    @ObservationIgnored private var bootstrapRefreshing = false
    @ObservationIgnored private var bootstrapNeedsRefresh = false
    @ObservationIgnored private var bootstrapSignals: Set<String> = []
    @ObservationIgnored private var catchUpOwners: [String: UUID] = [:]
    private struct RecoveryJob { let owner: UUID; let task: Task<Bool, Never> }
    private struct ConversationLoad { let owner: UUID; let task: Task<Void, Error> }
    @ObservationIgnored private var recoveryJobs: [String: RecoveryJob] = [:]
    @ObservationIgnored private var conversationLoads: [String: ConversationLoad] = [:]
    @ObservationIgnored private var readTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var readTargets: [String: Int] = [:]
    var readFailures: Set<String> = []
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
    var registeredPushToken: String? { pushTokenSync.registeredToken }
    /// Sube al cambiar el idioma en Tú › Idioma: la interfaz se vuelve a dibujar con los textos nuevos.
    var languageRevision = 0

    /// Cambia el idioma de la app al instante, lo recuerda y avisa al servidor (push en ese idioma; Accept-Language
    /// ya sale de L10n.lang en cada petición).
    func setLanguage(_ choice: L10n.Choice) {
        guard choice != L10n.choice else { return }
        L10n.choice = choice
        languageRevision += 1
        pushTokenSync.resendToken()
        Task { await pushTokenSync.synchronize() }
    }
    @ObservationIgnored let pushTokenSync: PushTokenSync
    @ObservationIgnored var pushSigningOut = false
    /// Pantalla previa al permiso de notificaciones.
    var showPushPrompt = false
    @ObservationIgnored var onLiveMessage: ((MessageDTO) -> Void)?
    /// Tarea completada o vencida que llegó en vivo con su chat a la vista (confeti / carita triste, tanda 1.7).
    struct LiveBurst: Equatable { var messageId: String; var conversationId: String; var kind: ChatCards.Burst }
    var liveBurst: LiveBurst?
    @ObservationIgnored var onReady: (() -> Void)?

    init(baseURL: URL, secrets: SecretStore, outbox: OutboxStore = OutboxStore(), feedback: FeedbackSink?, session: URLSession? = nil) {
        let api = APIClient(baseURL: baseURL, secrets: secrets, session: session)
        self.api = api
        pushTokenSync = PushTokenSync { operation in
            switch operation {
            case .register(let token):
                try await api.requestData("/push/token", method: "PUT",
                                          json: ["provider": "apns", "token": token, "environment": PushEnvironment.current, "lang": L10n.lang])
            case .unregister:
                try await api.requestData("/push/token", method: "DELETE")
            }
        }
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
        callCenter.store = self
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
        invalidateSessionWork()
        let stamp = sessionStamp
        _ = try await api.login(email: email.trimmingCharacters(in: .whitespacesAndNewlines), password: password)
        try requireSession(stamp)
        try await afterLogin()
    }

    func signup(name: String, email: String, password: String, orgName: String?, orgInviteToken: String?, title: String?) async throws {
        invalidateSessionWork()
        let stamp = sessionStamp
        var input: [String: Any] = ["name": name, "email": email.trimmingCharacters(in: .whitespacesAndNewlines), "password": password]
        if let orgInviteToken { input["orgInviteToken"] = orgInviteToken } else if let orgName { input["orgName"] = orgName }
        if let title, !title.isEmpty { input["title"] = title }
        _ = try await api.signup(input)
        try requireSession(stamp)
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
        invalidateSessionWork()
        let stamp = sessionStamp
        _ = try await api.ssoExchange(code: code, verifier: verifier)
        try requireSession(stamp)
        try await afterLogin()
    }

    private func afterLogin() async throws {
        let generation = sessionGeneration
        try await loadBootstrap()
        guard generation == sessionGeneration else { throw CancellationError() }
        guard let me = data?.me.id else { return }
        pending = outbox.load(userId: me).map { var p = $0; if p.status == .sending { p.status = .pending }; return p }
        status = .ready
        pushSigningOut = false
        pushTokenSync.startSession()
        showSignup = false
        signupOrgToken = nil
        socket.connect()
        startPathMonitor()
        scheduleFlush(0)
        consumePendingLink()
        if let callId = pendingCallJoin { answerCallFromPush(callId) }
        #if DEBUG
        // Solo pruebas/diagnóstico: abrir una conversación al entrar (-TCOpenConversation <id>).
        if let id = AppConfig.launchValue("TCOpenConversation") { navigate(to: .conversation(id)) }
        #endif
        Task { try? await loadReminders() }
        Task { await loadOpenIssues() }
        Task { await loadScheduled() }
        Task { await syncSleepTimeZone() }
        onReady?()
        Task { await retryPushRegistration() }
    }

    func logout() async {
        invalidateSessionWork()
        let stamp = sessionStamp
        pushSigningOut = true
        // El logout del API ya borra el token de la sesión; se borra antes por si falla la red después.
        await unregisterPush()
        guard stamp == sessionStamp else { return }
        await api.logout()
        guard stamp == sessionStamp else { return }
        handleSignedOut()
    }

    /// Borra credenciales y estado local (tras eliminar la cuenta o si el servidor la cierra).
    func signOutLocally() async {
        api.clearCredentials()
        handleSignedOut()
    }

    private func handleSignedOut() {
        invalidateSessionWork()
        pushSigningOut = true
        pushTokenSync.endSession()
        PushRegistration.unregister()
        ShareTargets.clear()
        Donations.deleteAll()
        // El historial de gg vive solo en el dispositivo y se borra al cerrar sesión.
        AssistantHistory.clearAll()
        socket.disconnect()
        pathMonitor?.cancel(); pathMonitor = nil
        api.clearCredentials()
        status = .anonymous
        connection = .offline
        data = nil
        conversations = [:]
        pending = []
        typing = [:]
        issues = [:]; pins = [:]; topics = [:]; taskCardComments = [:]; reminders = []; events = [:]; scheduled = []
        blockedUserIds = []
        localDndUntil = nil; dndLocalOnly = false; dndExpiryTask?.cancel(); dndExpiryTask = nil
        homePath = []; dmsPath = []; issuesPath = []; agendaPath = []; settingsPath = []; callsPath = []
        callCenter.reset(); liveCalls = [:]; callsChecked = []
        tab = .home
        workspaceFilter = nil
        openConversationId = nil
        announced.removeAll()
    }

    // MARK: - Snapshot

    func loadBootstrap() async throws {
        let stamp = sessionStamp
        try await loadBlockedUsers()
        try requireSession(stamp)
        var d: BootstrapDTO = try await api.request("/bootstrap")
        try requireSession(stamp)
        d.conversations.sort { ($0.lastMessageAt ?? "") > ($1.lastMessageAt ?? "") }
        defer { scheduleBadge() }
        data = d
        restoreMeetingAttempts()
        loadLocalDnd()
        // Conversaciones que ya no están en mi alcance se purgan de la caché local.
        let allowed = Set(d.conversations.map(\.id))
        conversations = conversations.filter { allowed.contains($0.key) }
        func keep(_ p: [Route]) -> [Route] {
            p.filter { if case .conversation(let id) = $0 { return allowed.contains(id) }; if case .details(let id) = $0 { return allowed.contains(id) }; return true }
        }
        if keep(homePath) != homePath { homePath = keep(homePath) }
        if keep(dmsPath) != dmsPath { dmsPath = keep(dmsPath) }
        if keep(issuesPath) != issuesPath { issuesPath = keep(issuesPath) }
        if keep(agendaPath) != agendaPath { agendaPath = keep(agendaPath) }
        if keep(callsPath) != callsPath { callsPath = keep(callsPath) }
        // Sin llamadas en el servidor no hay pestaña: se vuelve a Grupos y se cuelga lo que hubiera.
        if !d.callsEnabled {
            if tab == .calls { tab = .home }
            if callCenter.view != nil || callCenter.ringing != nil { callCenter.reset() }
        }
        ShareTargets.save(d, apiURL: api.baseURL)
        ChatSounds.shareRingtone(d.me.ringtone)
    }

    func scheduleBootstrap(signal: String? = nil) {
        if let signal, !bootstrapSignals.insert(signal).inserted { return }
        if bootstrapTask != nil {
            // Un id nuevo llegó después de iniciarse el snapshot: pedir una vuelta más al terminar.
            // Los duplicados del mismo mensaje no generan peticiones adicionales.
            if bootstrapRefreshing { bootstrapNeedsRefresh = true }
            return
        }
        let stamp = sessionStamp
        bootstrapTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                if stamp == self.sessionStamp {
                    self.bootstrapTask = nil
                    self.bootstrapRefreshing = false
                    self.bootstrapNeedsRefresh = false
                    self.bootstrapSignals = []
                }
            }
            do {
                try await Task.sleep(nanoseconds: 250_000_000)
                try self.requireSession(stamp)
                repeat {
                    self.bootstrapNeedsRefresh = false
                    self.bootstrapRefreshing = true
                    try await self.loadBootstrap()
                    try self.requireSession(stamp)
                    self.bootstrapRefreshing = false
                } while self.bootstrapNeedsRefresh
            } catch {}
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
        case "me.dnd":
            // Por si el servidor lo emite como evento propio y no dentro de account.event.
            if let p = payload as? [String: Any] { applyServerDnd(p["dndUntil"] as? String) }
        default:
            break // eventos desconocidos: se ignoran
        }
    }

    /// Tras reconectar o volver del segundo plano: snapshot + recuperación de huecos + cola.
    func resync() async {
        guard status == .ready else { return }
        let stamp = sessionStamp
        do {
            try requireSession(stamp)
            try await loadBootstrap()
            try requireSession(stamp)
            Task { await loadOpenIssues() }
            Task { await loadScheduled() }
            for c in data?.conversations ?? [] {
                try requireSession(stamp)
                guard let local = conversations[c.id], local.loaded else { continue }
                if c.lastEventSeq > local.lastEventSeq || c.id == openConversationId { await catchUp(c.id) }
                try requireSession(stamp)
            }
            if let id = openConversationId, meta(id) != nil, conversations[id]?.loaded != true {
                _ = await openConversationRecovering(id)
                try requireSession(stamp)
            }
        } catch {}
        guard stamp == sessionStamp, !Task.isCancelled else { return }
        scheduleFlush(0)
    }

    private func onAccountEvent(_ e: AccountEvent) {
        switch e {
        case .scopeChanged:
            scheduleBootstrap()
            // Grupos nuevos o invitaciones aceptadas: sus asuntos abiertos van bajo cada grupo.
            Task { await loadOpenIssues() }
        case .readUpdated(let id, let seq):
            guard let c = meta(id), seq > c.lastReadSeq else { return }
            patchMeta(id) { $0.lastReadSeq = seq; $0.unread = max(0, $0.lastMessageSeq - max(seq, $0.historyFromSeq)) }
        case .reminderDue(let r):
            reminders = (reminders.filter { $0.id != r.id } + [r]).sorted { $0.remindAt < $1.remindAt }
            remindersDue += 1
            if NotifyRule.accountAlert(dnd: dndActive), let d = data {
                let conv = meta(r.conversationId)
                feedback?.notifyIncoming(conversationId: r.conversationId, title: L("rem.alert"),
                                         author: conv.map { Naming.notificationTitle(d, $0) } ?? "", body: r.note ?? "")
            }
        case .eventSoon(let e, let minutes):
            events[e.id] = e
            guard !e.isCancelled, NotifyRule.accountAlert(dnd: dndActive), let d = data else { return }
            let conv = meta(e.conversationId)
            // Ignora el silencio de la conversación: es un aviso de reunión, como en el push.
            feedback?.notifyEventSoon(conversationId: e.conversationId, eventId: e.id,
                                      title: L("cal.soon", ["n": minutes, "title": e.title]),
                                      subtitle: conv.flatMap { $0.kind == .direct ? nil : Naming.notificationTitle(d, $0) },
                                      body: e.start.formatted(date: .omitted, time: .shortened))
        case .prefsUpdated: scheduleBootstrap()
        case .whatsappUpdated: waRevision += 1
        case .driveUpdated: driveRevision += 1
        case .remindersChanged: Task { try? await loadReminders() }
        case .dndChanged(let until): applyServerDnd(until)
        case .scheduledUpdated(let x): putScheduled(x)
        case .sleepChanged(let s): patchMe { $0.sleep = s }
        // Asuntos restringidos ('org' o 'private') llegan por la cuenta, no por la conversación.
        case .issueUpdated(let i):
            guard canCacheIssue(i) else { return }
            issues[i.id] = i
            recountIssues(i.conversationId)
        // Mis asuntos personales (sin conversación): solo llegan a mi cuenta y no cuentan en ningún chat.
        case .issuePersonal(let i):
            guard canCacheIssue(i) else { return }
            issues[i.id] = i
        case .issueHidden(let id, let conv):
            issues[id] = nil
            recountIssues(conv)
        case .callRinging(let call, let title, let caller):
            guard data?.callsEnabled == true else { return }
            putCall(call)
            if NotifyRule.accountAlert(dnd: dndActive) { callCenter.showIncoming(call, callerName: caller, title: title) }
        case .callUpdated(let call):
            guard data?.callsEnabled == true else { return }
            putCall(call)
        case .callProcessing(let callId, let userId, let segId):
            callCenter.onTranscriptEvent(callId: callId, userId: userId, segId: segId, segments: nil)
        case .callTranscript(let callId, let userId, let segId, let segments, _):
            callCenter.onTranscriptEvent(callId: callId, userId: userId, segId: segId, segments: segments)
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
        case .topicsChanged(let cid, _, let list):
            topics[cid] = list
        case .calendarUpdated(let cid, _, let ev):
            let isNewEvent = events[ev.id] == nil
            events[ev.id] = ev
            // Reunión nueva de otra persona en vivo → aviso con tc_notify (salvo silenciada).
            if live, isNewEvent, ev.organizerId != me?.id, !ev.isCancelled, let d = data, let c = meta(cid),
               NotifyRule.accountAlert(dnd: dndActive, muted: c.isMuted, respectsMute: true) {
                feedback?.notifyIncoming(conversationId: cid, title: ev.title, author: Naming.notificationTitle(d, c), body: L10n.eventWhen(ev))
            }
        case .callUpdated(_, _, let call):
            putCall(call)
        case .messageUpdated(let cid, _, let m):
            // Antes de aplicar: se compara con la versión que tenía para avisar de una reacción nueva a un mensaje mío.
            if live { noticeReaction(conversations[cid]?.messages.first { $0.id == m.id }, m) }
            patchPreviewIfLast(m)
        default: break
        }
    }

    /// Aviso breve: alguien reaccionó a un mensaje mío (no si estoy viendo esa conversación). La reacción no suma no leídos.
    private func noticeReaction(_ before: MessageDTO?, _ after: MessageDTO) {
        guard let before, let d = data, after.authorId == d.me.id else { return }
        if after.conversationId == openConversationId && appActive { return }
        let had = Set(before.reactions.flatMap { r in r.userIds.map { "\(r.emoji)|\($0)" } })
        for r in after.reactions {
            for u in r.userIds where u != d.me.id && !blockedUserIds.contains(u) && !had.contains("\(r.emoji)|\(u)") {
                show(L("react.notice", ["name": Naming.person(d, u)?.name ?? L("common.participant"), "emoji": r.emoji, "excerpt": excerpt(after.body, 60)]))
                return
            }
        }
    }

    /// Asuntos abiertos de una conversación (su chip ◆). Un asunto personal no tiene conversación: no cuenta en ninguna.
    func recountIssues(_ conversationId: String?) {
        guard let conversationId else { return }
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
            if case .messageCreated(_, _, let msg) = e {
                announce(msg); onLiveMessage?(msg)
                if let b = ChatCards.burst(msg), msg.conversationId == openConversationId, appActive {
                    liveBurst = LiveBurst(messageId: msg.id, conversationId: msg.conversationId, kind: b)
                }
            }
        }
    }

    /// Sonido sólo para el mensaje concreto aplicado; avisos locales se consumen en willPresent.
    private func announce(_ msg: MessageDTO) {
        guard let d = data, let c = meta(msg.conversationId), !announced.contains(msg.id) else { return }
        let outcome = NotifyRule.incoming(.init(
            mine: msg.authorId == d.me.id, system: msg.isSystem, blocked: blockedUserIds.contains(msg.authorId),
            openAndActive: messageIsVisible(msg.id, in: msg.conversationId),
            muted: c.isMuted, mutedForever: MentionText.mutedForever(c),
            mentionsMe: MentionText.mentionsMe(msg.mentions, me: d.me.id, authorId: msg.authorId), dnd: foregroundSilenced))
        let author = Naming.person(d, msg.authorId)?.name ?? L("common.participant")
        // Sonido del chat (docs/SONIDOS.md): el suyo, el predeterminado o ninguno; la mención, una quinta más aguda.
        let sound = soundFor(c)
        switch outcome {
        case .none: announced.record(msg.id, .none)
        case .sound: receiveOnce(msg.id, sound: sound)
        case .mention, .notify:
            var notice = ForegroundMessage(conversationId: c.id, messageId: msg.id, authorId: msg.authorId,
                                           mention: outcome == .mention, owner: foregroundOwner)
            notice.soundFile = ChatSounds.file(sound, mention: outcome == .mention)
            feedback?.notifyMessage(notice,
                title: outcome == .mention ? L("mention.mentionedYou", ["name": author]) : Naming.notificationTitle(d, c),
                author: outcome == .mention ? Naming.notificationTitle(d, c) : author, body: msg.body)
        }
    }

    private func messageIsVisible(_ id: String, in conversationId: String) -> Bool {
        conversationId == visibleConversationId && conversations[conversationId]?.messages.contains(where: { $0.id == id }) == true
    }

    private func receiveOnce(_ id: String, sound: String = ChatSounds.defaultMessage) {
        guard !announced.contains(id) else { return }
        // Deshabilitado (o «Sin sonido» en el chat) es un silencio intencional. Un sink ausente no equivale a sonido emitido.
        guard Prefs.soundsEnabled, sound != ChatSounds.none else { announced.record(id, .none); return }
        guard let feedback else { return }
        announced.record(id, .sound)
        feedback.playReceive(sound: sound, mention: false)
    }

    /// Admisión común de willPresent. Un callback local de otra generación no consume el push vigente.
    /// Los push remotos actuales no traen destinatario: sólo se pueden aplicar las reglas de la sesión actual.
    func presentsForegroundPush(_ p: PushPayload, localOwner: String? = nil, soundAlreadyPlayed: Bool = false) -> Bool {
        guard let mid = p.messageId else { return true }
        if let localOwner, localOwner != foregroundOwner { return false }
        guard me != nil else { return false }
        let c = meta(p.conversationId)
        let local = conversations[p.conversationId]
        let message = local?.messages.first { $0.id == mid }
        // El push es también señal de datos faltantes, incluso si su banner resulta duplicado/silenciado.
        if localOwner == nil, c == nil || local?.loaded != true { scheduleBootstrap(signal: mid) }
        else if localOwner == nil, message == nil {
            let stamp = sessionStamp
            Task { [weak self] in
                guard let self, stamp == self.sessionStamp, !Task.isCancelled else { return }
                await self.catchUp(p.conversationId)
            }
        }
        let input = ForegroundPush.Input(
            alreadyAnnounced: announced.contains(mid), dnd: foregroundSilenced,
            openActiveLoaded: messageIsVisible(mid, in: p.conversationId),
            muted: c?.isMuted ?? false, mutedForever: c.map(MentionText.mutedForever) ?? false,
            mentionsMe: p.kind == .mention, blocked: p.authorId.map(blockedUserIds.contains) ?? false,
            mine: p.authorId != nil && p.authorId == me?.id, system: message?.isSystem ?? false)
        let decision = ForegroundPush.decide(input)
        if let outcome = decision.outcome {
            if outcome == .sound {
                if soundAlreadyPlayed { announced.record(mid, .sound) } else { receiveOnce(mid) }
            } else { announced.record(mid, outcome) }
        }
        return decision.present
    }

    @discardableResult
    private func bumpMeta(_ m: MessageDTO) -> Bool {
        guard let c = meta(m.conversationId), m.seq > c.lastMessageSeq else { return false }
        // Se lee antes: dentro del closure `data` está en acceso exclusivo y leer `me` aborta.
        let myId = me?.id
        let mine = m.authorId == myId
        patchMeta(c.id) {
            $0.lastMessageSeq = m.seq
            $0.lastMessageAt = m.createdAt
            $0.lastMessagePreview = String(L10n.messagePreview(m).prefix(140))
            if mine, max(c.lastReadSeq, c.historyFromSeq) >= c.lastMessageSeq, m.seq == c.lastMessageSeq + 1 { $0.lastReadSeq = m.seq }
            $0.unread = max(0, m.seq - max($0.lastReadSeq, $0.historyFromSeq))
            if let me = myId, MentionText.mentionsMe(m.mentions, me: me, authorId: m.authorId) { $0.unreadMentions += 1 }
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
        case .membersChanged(let id, _, let ids, let admins):
            patchMeta(id) { $0.memberIds = ids; if let admins { $0.adminIds = admins } }
            scheduleBootstrap()
        case .issueUpdated, .pinsChanged, .topicsChanged, .calendarUpdated, .callUpdated:
            break // sus efectos van en sideEffects (también sin mensajes cargados)
        case .other:
            break // redacted o tipos futuros: solo avanzan el cursor
        }
        local.lastEventSeq = e.eventSeq
        conversations[e.conversationId] = local
        if case .messageCreated(_, _, let m) = e { dropPending(m) }
    }

    func catchUp(_ id: String) async {
        guard catchUpOwners[id] == nil, !Task.isCancelled else { return }
        let owner = UUID(), stamp = sessionStamp
        catchUpOwners[id] = owner
        defer { if catchUpOwners[id] == owner { catchUpOwners[id] = nil } }
        do {
            while true {
                try requireSession(stamp)
                guard catchUpOwners[id] == owner, let local = conversations[id] else { return }
                let page: EventsPage = try await api.request("/conversations/\(id)/events?after=\(local.lastEventSeq)&limit=200")
                try requireSession(stamp)
                guard catchUpOwners[id] == owner else { return }
                if page.resetRequired {
                    // Renovar la página aquí evita esperar nuestra propia Task de carga.
                    let refreshed: MessagesPage = try await api.request("/conversations/\(id)/messages?limit=50")
                    try requireSession(stamp)
                    guard catchUpOwners[id] == owner else { return }
                    conversations[id] = ConversationState(messages: refreshed.messages.sorted { $0.seq < $1.seq },
                        lastEventSeq: refreshed.lastEventSeq, hasMore: refreshed.hasMore, loaded: true,
                        loading: conversationLoads[id] != nil)
                    continue
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
        // Copia, cambio y escritura: el closure puede leer el store (`me`, `data`) sin abrir un acceso exclusivo a `data`
        // (leerlo dentro de `f(&data!…)` aborta por exclusividad de Swift).
        var c = data!.conversations[i]
        f(&c)
        guard let j = data?.conversations.firstIndex(where: { $0.id == id }) else { return }
        data!.conversations[j] = c
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

    /// Cambia mi usuario del snapshot (p. ej. `dndUntil`).
    func patchMe(_ f: (inout UserDTO) -> Void) {
        guard var me = data?.me else { return }
        f(&me)
        data?.me = me
    }

    func patchWorkspace(_ id: String, _ f: (inout WorkspaceDTO) -> Void) {
        guard let i = data?.workspaces.firstIndex(where: { $0.id == id }) else { return }
        var w = data!.workspaces[i]
        f(&w)
        guard let j = data?.workspaces.firstIndex(where: { $0.id == id }) else { return }
        data!.workspaces[j] = w
    }

    /// Mensaje local ya conocido (actualiza la lista y la vista previa).
    func upsertLocal(_ m: MessageDTO) {
        if var local = conversations[m.conversationId], local.loaded {
            local.messages = AppStore.upsert(local.messages, m)
            conversations[m.conversationId] = local
        }
        patchPreviewIfLast(m)
    }

    /// Quitar un tema: sus mensajes cargados quedan sin etiqueta sin esperar los message.updated.
    func clearTopicLocally(_ topicId: String, in conversationId: String) {
        guard var local = conversations[conversationId], local.loaded else { return }
        local.messages = local.messages.map { m in
            guard m.topicId == topicId else { return m }
            var x = m; x.topicId = nil; x.topicBy = nil; return x
        }
        conversations[conversationId] = local
    }

    func openConversation(_ id: String, force: Bool = false) async throws {
        let stamp = sessionStamp
        try requireSession(stamp)
        if let load = conversationLoads[id] {
            try await load.task.value
            try requireSession(stamp)
            return
        }
        if let local = conversations[id], local.loaded, !force {
            await catchUp(id)
            try requireSession(stamp)
            return
        }
        let owner = UUID()
        conversations[id, default: ConversationState()].loading = true
        conversations[id]?.error = nil
        let task = Task { @MainActor [weak self] in
            guard let self else { throw CancellationError() }
            do {
                try self.requireSession(stamp)
                guard self.conversationLoads[id]?.owner == owner else { throw CancellationError() }
                let page: MessagesPage = try await self.api.request("/conversations/\(id)/messages?limit=50")
                try self.requireSession(stamp)
                guard self.conversationLoads[id]?.owner == owner else { throw CancellationError() }
                self.conversations[id] = ConversationState(messages: page.messages.sorted { $0.seq < $1.seq }, lastEventSeq: page.lastEventSeq,
                                                           hasMore: page.hasMore, loaded: true, loading: true)
                await self.catchUp(id)
                try self.requireSession(stamp)
                guard self.conversationLoads[id]?.owner == owner else { throw CancellationError() }
                self.conversations[id]?.loading = false
                self.conversationLoads[id] = nil
            } catch {
                if stamp == self.sessionStamp, self.conversationLoads[id]?.owner == owner {
                    self.conversationLoads[id] = nil
                    self.conversations[id]?.loading = false
                    if !(error is CancellationError), !Task.isCancelled {
                        self.conversations[id]?.error = L10n.errorText(error)
                        self.conversations[id]?.transient = (error as? ApiRequestError)?.isTransient ?? false
                    }
                }
                throw error
            }
        }
        conversationLoads[id] = ConversationLoad(owner: owner, task: task)
        try await withTaskCancellationHandler {
            try await task.value
            try requireSession(stamp)
        } onCancel: {
            task.cancel()
        }
    }

    nonisolated static let openRetryDelays: [TimeInterval] = [1, 2, 4, 8, 15]

    /// Botón y reconexión reutilizan una sola Task retenida por conversación.
    @discardableResult
    func startConversationRecovery(_ id: String, delays: [TimeInterval] = AppStore.openRetryDelays) -> Task<Bool, Never> {
        if let job = recoveryJobs[id] { return job.task }
        let owner = UUID(), stamp = sessionStamp
        let task = Task { @MainActor [weak self] in
            guard let self else { return false }
            defer { if self.recoveryJobs[id]?.owner == owner { self.recoveryJobs[id] = nil } }
            var attempt = 0
            do {
                while true {
                    try self.requireSession(stamp)
                    guard self.recoveryJobs[id]?.owner == owner else { return false }
                    do { try await self.openConversation(id) }
                    catch is CancellationError { return false }
                    catch {}
                    try self.requireSession(stamp)
                    guard self.recoveryJobs[id]?.owner == owner else { return false }
                    if self.conversations[id]?.loaded == true, self.conversations[id]?.loading != true { return true }
                    guard self.conversations[id]?.transient == true, attempt < delays.count else {
                        self.conversations[id]?.transient = false
                        return false
                    }
                    try await Task.sleep(nanoseconds: UInt64(max(0, delays[attempt]) * 1_000_000_000))
                    try self.requireSession(stamp)
                    guard self.recoveryJobs[id]?.owner == owner else { return false }
                    attempt += 1
                }
            } catch { return false }
        }
        recoveryJobs[id] = RecoveryJob(owner: owner, task: task)
        return task
    }

    func cancelConversationRecovery(_ id: String) {
        recoveryJobs.removeValue(forKey: id)?.task.cancel()
        conversationLoads.removeValue(forKey: id)?.task.cancel()
        catchUpOwners[id] = nil
        conversations[id]?.loading = false
        conversations[id]?.transient = false
    }

    @discardableResult
    func openConversationRecovering(_ id: String, delays: [TimeInterval] = AppStore.openRetryDelays) async -> Bool {
        guard !Task.isCancelled else { return false }
        let stamp = sessionStamp
        let task = startConversationRecovery(id, delays: delays)
        let owner = recoveryJobs[id]?.owner
        return await withTaskCancellationHandler {
            let result = await task.value
            return result && stamp == sessionStamp && !Task.isCancelled
        } onCancel: {
            task.cancel()
            Task { @MainActor [weak self] in
                guard let self, self.recoveryJobs[id]?.owner == owner else { return }
                self.cancelConversationRecovery(id)
            }
        }
    }

    @discardableResult
    func loadOlder(_ id: String) async -> Bool {
        let stamp = sessionStamp
        guard let local = conversations[id], local.loaded, local.hasMore, !local.loading, let before = local.messages.first?.seq else { return false }
        conversations[id]?.loading = true
        defer { if stamp == sessionStamp { conversations[id]?.loading = false } }
        do {
            let page: MessagesPage = try await api.request("/conversations/\(id)/messages?before=\(before)&limit=50")
            try requireSession(stamp)
            let cur = conversations[id]?.messages ?? []
            let known = Set(cur.map(\.id))
            let older = page.messages.filter { !known.contains($0.id) && $0.seq < before }.sorted { $0.seq < $1.seq }
            guard !older.isEmpty || !page.hasMore else { throw ChatNav.PositionError.historyGap }
            conversations[id]?.messages = older + cur
            conversations[id]?.hasMore = page.hasMore
            conversations[id]?.error = nil
            return true
        } catch {
            if stamp == sessionStamp { conversations[id]?.error = L("chat.ios.unreadRetry") }
            return false
        }
    }

    /// Debounce candidates without moving the local cursor until the server confirms this exact sequence.
    func markRead(_ id: String, upTo: Int? = nil) {
        guard let c = meta(id) else { return }
        let target = min(upTo ?? c.lastMessageSeq, c.lastMessageSeq)
        guard target > max(c.lastReadSeq, readTargets[id] ?? 0) else { return }
        let stamp = sessionStamp
        readTargets[id] = target
        readTasks[id]?.cancel()
        readTasks[id] = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                if stamp == self.sessionStamp, self.readTargets[id] == target { self.readTargets[id] = nil; self.readTasks[id] = nil }
            }
            do {
                try await Task.sleep(nanoseconds: 400_000_000)
                try self.requireSession(stamp)
                try await self.api.requestData("/conversations/\(id)/read", method: "POST", json: ["seq": target])
                try self.requireSession(stamp)
                let previous = self.meta(id)?.lastReadSeq ?? target
                let newlySeenMentions = (self.conversations[id]?.messages ?? []).filter {
                    $0.seq > previous && $0.seq <= target && $0.deletedAt == nil && MentionText.mentionsMe($0.mentions, me: stamp.userId ?? "", authorId: $0.authorId)
                }.count
                self.patchMeta(id) {
                    ReadTree.applyRead(&$0, seq: target)
                    if target < $0.lastMessageSeq { $0.unreadMentions = max(0, $0.unreadMentions - newlySeenMentions) }
                }
                self.readFailures.remove(id)
                if target >= (self.meta(id)?.lastMessageSeq ?? Int.max) { AppFeedback.shared.clearNotifications(conversationId: id) }
            } catch {
                if stamp == self.sessionStamp, !Task.isCancelled { self.readFailures.insert(id) }
            }
        }
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
              attachments: [AttachmentDTO] = [], forwardAttachments: [AttachmentDTO] = [], mentions: [Mention] = [],
              topicId: String? = nil, viewOnce: Bool = false, clientMessageId: String = UUID().uuidString.lowercased()) -> PendingMessage? {
        // El servidor recorta el texto: se recorta aquí y se corren las menciones.
        let (text, mentionsTrimmed) = MentionText.trimmed(body, mentions: mentions)
        // Con adjuntos el texto puede ir vacío.
        guard !text.isEmpty || !attachments.isEmpty || !forwardAttachments.isEmpty else { return nil }
        let p = PendingMessage(clientMessageId: clientMessageId, conversationId: conversationId, body: String(text.prefix(8000)), replyTo: replyTo,
                               forwarded: forwarded, attachmentIds: attachments.isEmpty ? nil : attachments.map(\.id),
                               forwardAttachmentIds: forwardAttachments.isEmpty ? nil : forwardAttachments.map(\.id),
                               attachments: (attachments + forwardAttachments).isEmpty ? nil : attachments + forwardAttachments,
                               mentions: mentionsTrimmed.isEmpty ? nil : MentionText.valid(mentionsTrimmed, in: String(text.prefix(8000))),
                               topicId: topicId, viewOnce: viewOnce ? true : nil, createdAt: ISODate.string(), attempts: 0, status: .pending, error: nil, nextAttemptAt: 0)
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
        if let ms = p.mentions, !ms.isEmpty {
            let parts = RefText.split(ms)
            if !parts.mentions.isEmpty { payload["mentions"] = parts.mentions.map(\.json) }
            if !parts.refs.isEmpty { payload["refs"] = parts.refs.map(RefText.json) }
        }
        if p.viewOnce == true { payload["viewOnce"] = true }
        if let t = p.topicId { payload["topicId"] = t }
        if socket.state == .connected {
            do {
                let r = try await socket.emitWithAck("message.send", payload, timeout: 8) as? [String: Any]
                if r?["ok"] as? Bool == true, let m = JSONBridge.decode(MessageDTO.self, from: r?["message"]) {
                    deliveredViaSocket += 1
                    reportDroppedMentions(r?["droppedMentions"] as? [String] ?? [])
                    return m
                }
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
        reportDroppedMentions(r.droppedMentions)
        return r.message
    }

    /// El servidor descartó menciones (no están en el chat, @todos no permitido): aviso sutil.
    func reportDroppedMentions(_ ids: [String]) {
        guard !ids.isEmpty, let d = data else { return }
        let names = ids.map { $0 == Mention.all ? L("mention.allLabel") : (Naming.person(d, $0)?.name ?? "?") }
        show(L("mention.dropped", ["names": names.joined(separator: ", ")]))
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
        if let first = r.conversationIds.first { navigate(to: .conversation(first)) } else if !r.workspaceId.isEmpty { navigate(to: .workspace(r.workspaceId)) }
    }

    // MARK: - Enlaces

    func handle(url: URL) {
        // chaggu://auth/* es del flujo SSO (lo recibe ASWebAuthenticationSession), no es navegación.
        // chaggu://meetings/connected?… vuelve de conectar Meet/Teams/Zoom (normalmente lo recibe la sesión web).
        if MeetingCallback.isMeetings(url) {
            // A URL alone cannot connect an account. Only the in-memory flow may consume its receipt.
            meetingAuthorization?.connector.receive(url)
            return
        }
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

    /// Push de sidechat: si puedo leer el origen, lo abro con el sidechat desplegado; si no, el sidechat a pantalla completa.
    func openSide(origin: String, side: String) {
        guard status == .ready else { pendingLink = .conversation(side); return }
        if meta(origin) != nil {
            sideToOpen[origin] = side
            navigate(to: .conversation(origin))
        } else {
            navigate(to: .conversation(side))
        }
    }

    /// Push de reacción: abre la conversación y salta al mensaje (se resuelve su seq al abrir).
    func openMessage(_ conversationId: String, messageId: String) {
        jumpToMessage[conversationId] = messageId
        handle(.conversation(conversationId))
    }

    /// Push «te asignó una tarea»: abre el asunto; con `inChat`, encima de su chat; si no, solo el asunto (no leo el chat).
    func openIssue(_ issueId: String, conversationId: String, inChat: Bool) {
        guard status == .ready, let d = data else { pendingIssue = PendingIssue(id: issueId, conversationId: conversationId, inChat: inChat); return }
        if inChat, let c = d.conversations.first(where: { $0.id == conversationId }) {
            if c.kind.isChat { tab = .dms; dmsPath = [.conversation(c.id), .issue(issueId)] } else { tab = .home; homePath = [.conversation(c.id), .issue(issueId)] }
        } else {
            tab = .issues
            issuesPath = [.issue(issueId)]
        }
        Task { _ = try? await issueDetail(issueId) }
    }

    struct PendingIssue: Equatable { var id: String; var conversationId: String; var inChat: Bool }

    /// Si no hay sesión se guarda y se abre al entrar.
    func rememberAfterLogin(_ link: DeepLink) { pendingLink = link }

    private func consumePendingLink() {
        if let i = pendingIssue { pendingIssue = nil; openIssue(i.id, conversationId: i.conversationId, inChat: i.inChat) }
        guard let l = pendingLink else { return }
        pendingLink = nil
        navigate(to: l)
    }

    func navigate(to link: DeepLink) {
        guard status == .ready, let d = data else { pendingLink = link; return }
        switch link {
        case .conversation(let id):
            guard let c = d.conversations.first(where: { $0.id == id }) else {
                alert = AppAlert(title: L("link.noAccess"), message: nil)
                return
            }
            // Directos, chats y sidechats viven en DMs; los grupos, en Grupos.
            if c.kind.isChat { tab = .dms; dmsPath = [.conversation(id)] } else { tab = .home; homePath = [.conversation(id)] }
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
        Task { await retryPushRegistration() }
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
                let recovered = ok && !self.lastPathSatisfied
                self.lastPathSatisfied = ok
                if recovered {
                    self.socket.reconnectNow()
                    await self.retryPushRegistration()
                }
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
        if me?.id != d.me.id { invalidateSessionWork() }
        data = d
        restoreMeetingAttempts()
        self.conversations = conversations
        status = .ready
    }

    func waitForReadForTesting(_ id: String) async { await readTasks[id]?.value }

    /// Un evento del socket tal como llega (nombre + JSON), sin red.
    func socketEventForTesting(_ name: String, _ json: String) {
        onSocketEvent(name, try? JSONSerialization.jsonObject(with: Data(json.utf8)))
    }
}
#endif
