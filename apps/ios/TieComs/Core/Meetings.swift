import AuthenticationServices
import Foundation
import UIKit

// Reuniones reales con Google Meet, Microsoft Teams o Zoom, con la cuenta de cada persona
// (docs/TANDA-LECTURA-REUNIONES.md §4). El enlace SOLO sale del proveedor: sin confirmación no hay enlace ni mensaje.

enum MeetingProvider: String, CaseIterable, Identifiable, Sendable, Codable {
    case google, microsoft, zoom
    var id: String { rawValue }
    /// Nombre del producto (chips y Ajustes).
    var label: String {
        switch self { case .google: return "Google Meet"; case .microsoft: return "Microsoft Teams"; case .zoom: return "Zoom" }
    }
    /// «Abrir en Meet / Teams / Zoom».
    var appName: String {
        switch self { case .google: return "Meet"; case .microsoft: return "Teams"; case .zoom: return "Zoom" }
    }
    var systemImage: String { self == .zoom ? "video.circle" : self == .google ? "video" : "video.bubble" }
}

/// GET /meetings/connections → { connections }. available=false: falta configurarlo en el servidor (unavailableReason).
struct MeetingConnectionDTO: Decodable, Equatable, Identifiable, Sendable {
    enum Status: String, Sendable { case none, active, reconnect }
    var provider: MeetingProvider
    var label: String
    var available: Bool
    var unavailableReason: String?
    var status: Status
    var accountEmail: String?
    var id: String { provider.rawValue }

    init(provider: MeetingProvider, available: Bool = true, unavailableReason: String? = nil, status: Status = .none, accountEmail: String? = nil) {
        self.provider = provider; label = provider.label; self.available = available
        self.unavailableReason = unavailableReason; self.status = status; self.accountEmail = accountEmail
    }
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        guard let p = MeetingProvider(rawValue: c.v("provider", "")) else {
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "proveedor desconocido"))
        }
        provider = p
        label = c.v("label", p.label)
        available = c.v("available", false)
        unavailableReason = c.o("unavailableReason")
        status = Status(rawValue: c.v("status", "none")) ?? .none
        accountEmail = c.o("accountEmail")
    }

    /// Lo que dice el chip: conectado (correo), «Conectar», «Reconectar» o «No disponible».
    enum ChipState: Equatable { case connected(String?), connect, reconnect, unavailable(String?) }
    var chipState: ChipState {
        if !available { return .unavailable(unavailableReason) }
        switch status {
        case .active: return .connected(accountEmail)
        case .reconnect: return .reconnect
        case .none: return .connect
        }
    }
    var canCreate: Bool { available && status == .active }
}

struct MeetingConnectionsList: Decodable, Sendable {
    var connections: [MeetingConnectionDTO]
    init(from d: Decoder) throws { connections = (try container(d)).lossyArray("connections") }
}

/// POST /meetings → MeetingDTO. `joinUrl` es el enlace real del proveedor (nunca inventado).
struct MeetingDTO: Decodable, Equatable, Identifiable, Sendable {
    var id: String
    var provider: MeetingProvider
    var status: String
    var title: String
    var startsAt: String
    var endsAt: String
    var timezone: String
    var joinUrl: String?
    var conversationId: String?
    var calendarEventId: String?
    var messageId: String?
    /// Se creó en el proveedor pero compartirlo en el chat falló: el enlace se copia a mano.
    var error: String?

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = c.v("id", "")
        provider = MeetingProvider(rawValue: c.v("provider", "google")) ?? .google
        status = c.v("status", "unknown")
        title = c.v("title", "")
        startsAt = c.v("startsAt", "")
        endsAt = c.v("endsAt", "")
        timezone = c.v("timezone", "UTC")
        joinUrl = c.o("joinUrl")
        conversationId = c.o("conversationId")
        calendarEventId = c.o("calendarEventId")
        messageId = c.o("messageId")
        error = c.o("error")
    }

    /// Solo un enlace https confirmado cuenta como reunión creada.
    var confirmedURL: URL? {
        guard status == "created", let s = joinUrl, let u = URL(string: s), u.scheme?.lowercased() == "https", u.host?.isEmpty == false else { return nil }
        return u
    }
    var shared: Bool { messageId != nil }
}

/// Llave de idempotencia del diálogo: un UUID por toque de «Crear y compartir»; si falla, el reintento usa la misma
/// (así un doble toque, un reintento o una respuesta perdida no crean dos reuniones). Mientras crea, no hay otra.
struct MeetingIdempotency: Equatable {
    private(set) var pendingKey: String?
    private(set) var inFlight = false

    /// Llave para este toque, o nil si ya hay una creación en curso (el botón está desactivado).
    mutating func begin(newKey: () -> String = { UUID().uuidString.lowercased() }) -> String? {
        guard !inFlight else { return nil }
        inFlight = true
        if let k = pendingKey { return k }
        let k = newKey()
        pendingKey = k
        return k
    }
    /// Falló (red, proveedor, permiso): la llave queda para el reintento.
    mutating func failed() { inFlight = false }
    /// Creada: la próxima reunión usa otra llave.
    mutating func succeeded() { inFlight = false; pendingKey = nil }
}

/// Errores del API que el diálogo explica (sin botones que no funcionan).
enum MeetingError: Equatable {
    case notConnected, reconnectRequired, noTeams
    case unavailable(String)
    case provider(String)
    case network
    case other(String)

    init(_ e: Error) {
        guard let a = e as? ApiRequestError else { self = .other(L10n.errorText(e)); return }
        if a.code == "meeting_storage" { self = .other(a.message); return }
        if a.isNetwork { self = .network; return }
        switch a.code {
        case "meeting_in_progress", "meeting_pending", "meeting_uncertain", "idempotency_mismatch": self = .other(L("meet.ios.pendingHint"))
        case "not_connected": self = .notConnected
        case "reconnect_required": self = .reconnectRequired
        case "no_teams": self = .noTeams
        case "provider_unavailable": self = .unavailable(a.message)
        default: self = a.status >= 500 ? .provider(a.message) : .other(a.message)
        }
    }

    /// Se arregla conectando (el diálogo ofrece «Conectar» o «Reconectar»).
    var needsConnect: Bool { self == .notConnected || self == .reconnectRequired }

    func text(_ p: MeetingProvider) -> String {
        switch self {
        case .notConnected: return L("meet.err.notConnected", ["provider": p.label])
        case .reconnectRequired: return L("meet.err.reconnect", ["provider": p.label])
        case .noTeams: return L("meet.err.noTeams")
        case .unavailable(let why): return L("meet.unavailable") + ": " + why
        case .provider(let m): return m
        case .network: return L("meet.ios.network")
        case .other(let m): return m
        }
    }
}

/// The redirect is only a receipt. It never proves that an account was connected.
enum MeetingCallback: Equatable {
    case receipt(MeetingProvider, String)
    case connected(MeetingProvider?)
    case failed(MeetingProvider?, code: String)

    static func parse(_ url: URL) -> MeetingCallback? {
        guard let s = url.scheme?.lowercased(), SSOCallback.acceptedSchemes.contains(s), url.host?.lowercased() == "meetings",
              url.pathComponents.filter({ $0 != "/" }).first == "connected" else { return nil }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard Set(items.map(\.name)).count == items.count else { return .failed(nil, code: "invalid_callback") }
        let q = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        let p = q["provider"].flatMap(MeetingProvider.init(rawValue:))
        if let e = q["error"], !e.isEmpty { return .failed(p, code: e) }
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        guard let p, let receipt = q["receipt"], receipt.count == 43,
              receipt.unicodeScalars.allSatisfy(allowed.contains) else { return .failed(p, code: "invalid_callback") }
        return .receipt(p, receipt)
    }
    static func isMeetings(_ url: URL) -> Bool {
        url.scheme.map { SSOCallback.acceptedSchemes.contains($0.lowercased()) } == true && url.host?.lowercased() == "meetings"
    }
}

/// Frozen request: changing any field requires a new operation, never a retry under the old key.
struct MeetingPayload: Equatable, Codable {
    let provider: MeetingProvider
    let conversationId: String?
    let title: String
    let startsAt: Date?
    let durationMin: Int
    let timezone: String
    let share: Bool
    var json: [String: Any] {
        var value: [String: Any] = ["provider": provider.rawValue, "title": String(title.prefix(200)), "durationMin": durationMin,
                                  "timezone": timezone, "share": share, "conversationId": conversationId ?? NSNull()]
        if let startsAt { value["startsAt"] = ISODate.string(startsAt) }
        return value
    }
}
struct MeetingAttempt: Equatable, Codable {
    let key: String
    let payload: MeetingPayload
    var inFlight = false
    var meetingId: String?
}

@MainActor
final class MeetingAuthorization {
    let id = UUID()
    let stamp: AppStore.SessionStamp
    let provider: MeetingProvider
    let proof: PKCE
    let connector: MeetingConnector
    var confirming = false
    init(stamp: AppStore.SessionStamp, provider: MeetingProvider, connector: MeetingConnector) {
        self.stamp = stamp; self.provider = provider; self.connector = connector
        var bytes = [UInt8](repeating: 0, count: 32)
        precondition(SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess)
        proof = PKCE(verifier: PKCE.base64url(Data(bytes)))
    }
}

/// Abrir el enlace: primero la app del proveedor (universal link); si no está instalada, Safari.
@MainActor
enum MeetingOpener {
    static func open(_ url: URL) {
        UIApplication.shared.open(url, options: [.universalLinksOnly: true]) { opened in
            if !opened { UIApplication.shared.open(url) }
        }
    }
}

/// Conectar: la URL del proveedor en ASWebAuthenticationSession (navegador del sistema), de vuelta por `chaggu://`.
@MainActor
final class MeetingConnector: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    private var completion: CheckedContinuation<MeetingCallback, Never>?

    func run(_ url: URL) async -> MeetingCallback {
        await withTaskCancellationHandler {
            await withCheckedContinuation { cont in
                guard !Task.isCancelled else { cont.resume(returning: .failed(nil, code: "cancelled")); return }
                completion = cont
                let s = ASWebAuthenticationSession(url: url, callbackURLScheme: SSOCallback.scheme) { [weak self] callback, error in
                    Task { @MainActor in
                        if let callback { self?.receive(callback) }
                        else {
                            let cancelled = (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin
                            self?.finish(.failed(nil, code: cancelled ? "cancelled" : "session"))
                        }
                    }
                }
                s.presentationContextProvider = self
                s.prefersEphemeralWebBrowserSession = false
                session = s
                if !s.start() { finish(.failed(nil, code: "session")) }
            }
        } onCancel: { Task { @MainActor [weak self] in self?.cancel() } }
    }

    func receive(_ url: URL) { finish(MeetingCallback.parse(url) ?? .failed(nil, code: "invalid_callback")) }
    func cancel() { session?.cancel(); finish(.failed(nil, code: "cancelled")) }
    private func finish(_ value: MeetingCallback) {
        let continuation = completion
        completion = nil; session = nil
        continuation?.resume(returning: value)
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.first.map { UIWindow(windowScene: $0) } ?? ASPresentationAnchor()
        }
    }
}

extension AppStore {
    func loadMeetingConnections() async throws -> [MeetingConnectionDTO] {
        let stamp = sessionStamp
        let r: MeetingConnectionsList = try await api.request("/meetings/connections")
        try requireSession(stamp)
        return r.connections
    }
    struct UrlResult: Decodable { var url: String }
    private struct ConfirmMeetingConnection: Decodable { let ok: Bool; let provider: MeetingProvider }

    func cancelMeetingAuthorization() {
        let old = meetingAuthorization
        meetingAuthorization = nil
        old?.connector.cancel()
    }

    func connectMeetings(_ p: MeetingProvider, connector: MeetingConnector? = nil) async throws -> MeetingCallback {
        cancelMeetingAuthorization()
        let flow = MeetingAuthorization(stamp: sessionStamp, provider: p, connector: connector ?? MeetingConnector())
        guard flow.stamp.userId != nil else { throw CancellationError() }
        meetingAuthorization = flow
        defer { if meetingAuthorization?.id == flow.id { meetingAuthorization = nil } }
        let r: UrlResult = try await api.request("/meetings/connect/\(p.rawValue)", method: "POST", json: [
            "platform": "ios", "redirectScheme": SSOCallback.scheme, "proofChallenge": flow.proof.challenge])
        try requireMeetingAuthorization(flow)
        guard let url = URL(string: r.url), url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(url.host ?? "")) else {
            throw ApiRequestError(status: 502, code: "bad_url", message: L("meet.err.connect"))
        }
        let callback = await flow.connector.run(url)
        return try await confirmMeetingCallback(callback, flow: flow)
    }

    private func requireMeetingAuthorization(_ flow: MeetingAuthorization) throws {
        try requireSession(flow.stamp)
        guard meetingAuthorization?.id == flow.id else { throw CancellationError() }
    }

    func confirmMeetingCallback(_ callback: MeetingCallback, flow: MeetingAuthorization) async throws -> MeetingCallback {
        try requireMeetingAuthorization(flow)
        guard case .receipt(let provider, let receipt) = callback else {
            if case .failed = callback { return callback }
            return .failed(flow.provider, code: "invalid_callback")
        }
        guard provider == flow.provider, !flow.confirming else { return .failed(flow.provider, code: "invalid_callback") }
        flow.confirming = true
        let result: ConfirmMeetingConnection = try await api.request("/meetings/connect/confirm", method: "POST", json: ["receipt": receipt, "proofVerifier": flow.proof.verifier])
        try requireMeetingAuthorization(flow)
        guard result.ok, result.provider == provider else { return .failed(provider, code: "invalid_callback") }
        meetingsRevision += 1
        return .connected(provider)
    }

    func disconnectMeetings(_ p: MeetingProvider) async throws {
        let stamp = sessionStamp
        try await api.requestData("/meetings/connections/\(p.rawValue)", method: "DELETE")
        try requireSession(stamp)
        meetingsRevision += 1
    }

    func performMeetingAttempt(_ payload: MeetingPayload) async throws -> MeetingDTO {
        let stamp = sessionStamp
        guard stamp.userId != nil, !meetingAttemptStorageError else { throw ApiRequestError(status: 0, code: "meeting_storage", message: L("meet.ios.storage")) }
        let scope = payload.conversationId ?? "personal"
        var attempt = meetingAttempts[scope] ?? MeetingAttempt(key: UUID().uuidString.lowercased(), payload: payload)
        guard attempt.payload == payload else { throw ApiRequestError(status: 409, code: "idempotency_mismatch", message: L("meet.ios.pendingHint")) }
        guard !attempt.inFlight else { throw ApiRequestError(status: 409, code: "meeting_in_progress", message: L("meet.ios.pendingHint")) }
        attempt.inFlight = true
        meetingAttempts[scope] = attempt
        defer {
            if stamp == sessionStamp {
                meetingAttempts[scope]?.inFlight = false
                try? persistMeetingAttempts()
            }
        }
        do {
            // Save the key and exact payload before a provider can receive the operation.
            do { try persistMeetingAttempts() }
            catch { throw ApiRequestError(status: 0, code: "meeting_storage", message: L("meet.ios.storage")) }
            if let id = attempt.meetingId {
                let known: MeetingDTO = try await api.request("/meetings/\(id)")
                try requireSession(stamp)
                if known.confirmedURL != nil { meetingAttempts[scope] = nil; return known }
            }
            let m = try await createMeeting(payload.provider, conversationId: payload.conversationId, idempotencyKey: attempt.key,
                title: payload.title, startsAt: payload.startsAt, durationMin: payload.durationMin, timezone: payload.timezone, share: payload.share)
            try requireSession(stamp)
            guard m.confirmedURL != nil else {
                meetingAttempts[scope]?.meetingId = m.id
                throw ApiRequestError(status: 409, code: "meeting_pending", message: L("meet.ios.pendingHint"), meetingId: m.id)
            }
            meetingAttempts[scope] = nil
            return m
        } catch {
            try requireSession(stamp)
            if let e = error as? ApiRequestError {
                if let id = e.meetingId { meetingAttempts[scope]?.meetingId = id }
                // These failures precede a provider create. Other failures remain an unresolved operation.
                if ["provider_unavailable", "validation"].contains(e.code), e.meetingId == nil {
                    meetingAttempts[scope] = nil
                }
            }
            throw error
        }
    }

    func createMeeting(_ p: MeetingProvider, conversationId: String?, idempotencyKey: String, title: String, startsAt: Date?,
                       durationMin: Int, timezone: String = TimeZone.current.identifier, share: Bool = true) async throws -> MeetingDTO {
        let stamp = sessionStamp
        let payload = MeetingPayload(provider: p, conversationId: conversationId, title: title, startsAt: startsAt, durationMin: durationMin, timezone: timezone, share: share)
        if let previous = meetingPayloads[idempotencyKey], previous != payload {
            throw ApiRequestError(status: 409, code: "idempotency_mismatch", message: L("meet.ios.pendingHint"))
        }
        meetingPayloads[idempotencyKey] = payload
        var body = payload.json
        body["idempotencyKey"] = idempotencyKey
        let m: MeetingDTO = try await api.request("/meetings", method: "POST", json: body)
        try requireSession(stamp)
        if let conversationId, m.calendarEventId != nil {
            Task {
                guard stamp == self.sessionStamp else { return }
                _ = try? await self.loadEvents(from: Date().addingTimeInterval(-86400), to: Date().addingTimeInterval(120 * 86400), conversationId: conversationId)
            }
        }
        return m
    }
}
