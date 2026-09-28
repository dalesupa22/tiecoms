import AuthenticationServices
import Foundation
import UIKit

// Reuniones reales con Google Meet, Microsoft Teams o Zoom, con la cuenta de cada persona
// (docs/TANDA-LECTURA-REUNIONES.md §4). El enlace SOLO sale del proveedor: sin confirmación no hay enlace ni mensaje.

enum MeetingProvider: String, CaseIterable, Identifiable, Sendable {
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
        status = c.v("status", "created")
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
        guard status == "created", let s = joinUrl, let u = URL(string: s), u.scheme?.lowercased() == "https" else { return nil }
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
        if a.isNetwork { self = .network; return }
        switch a.code {
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
        case .network: return L("meet.err.network")
        case .other(let m): return m
        }
    }
}

/// Vuelta de la conexión: chaggu://meetings/connected?provider=…&connected=1 (o &error=cancelled|denied|…).
enum MeetingCallback: Equatable {
    case connected(MeetingProvider?)
    case failed(MeetingProvider?, code: String)

    static func parse(_ url: URL) -> MeetingCallback? {
        guard let s = url.scheme?.lowercased(), SSOCallback.acceptedSchemes.contains(s), url.host?.lowercased() == "meetings",
              url.pathComponents.filter({ $0 != "/" }).first == "connected" else { return nil }
        let q = Dictionary((URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
        let p = q["provider"].flatMap(MeetingProvider.init(rawValue:))
        if let e = q["error"], !e.isEmpty { return .failed(p, code: e) }
        return q["connected"] == "1" ? .connected(p) : .failed(p, code: "invalid_callback")
    }
    static func isMeetings(_ url: URL) -> Bool {
        url.scheme.map { SSOCallback.acceptedSchemes.contains($0.lowercased()) } == true && url.host?.lowercased() == "meetings"
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

    func run(_ url: URL) async -> MeetingCallback {
        await withCheckedContinuation { (cont: CheckedContinuation<MeetingCallback, Never>) in
            let s = ASWebAuthenticationSession(url: url, callbackURLScheme: SSOCallback.scheme) { callback, error in
                if let error {
                    let cancelled = (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin
                    cont.resume(returning: .failed(nil, code: cancelled ? "cancelled" : "session"))
                    return
                }
                cont.resume(returning: callback.flatMap(MeetingCallback.parse) ?? .failed(nil, code: "invalid_callback"))
            }
            s.presentationContextProvider = self
            s.prefersEphemeralWebBrowserSession = false
            session = s
            if !s.start() { cont.resume(returning: .failed(nil, code: "session")) }
        }
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
        let r: MeetingConnectionsList = try await api.request("/meetings/connections")
        return r.connections
    }

    struct UrlResult: Decodable { var url: String; init(from d: Decoder) throws { url = (try container(d)).v("url", "") } }

    /// Conectar o reconectar: pide la URL al API y la abre en el navegador del sistema. Devuelve cómo volvió.
    func connectMeetings(_ p: MeetingProvider, connector: MeetingConnector? = nil) async throws -> MeetingCallback {
        let connector = connector ?? MeetingConnector()
        let r: UrlResult = try await api.request("/meetings/connect/\(p.rawValue)", method: "POST", json: ["platform": "ios", "redirectScheme": SSOCallback.scheme])
        guard let u = URL(string: r.url), ["https", "http"].contains(u.scheme?.lowercased() ?? "") else { throw ApiRequestError(status: 502, code: "bad_url", message: L("meet.err.connect")) }
        let out = await connector.run(u)
        meetingsRevision += 1
        return out
    }

    func disconnectMeetings(_ p: MeetingProvider) async throws {
        try await api.requestData("/meetings/connections/\(p.rawValue)", method: "DELETE")
        meetingsRevision += 1
    }

    /// Crea la reunión (sin `startsAt` = ahora). Solo con la confirmación del proveedor hay enlace y mensaje en el chat.
    func createMeeting(_ p: MeetingProvider, conversationId: String?, idempotencyKey: String, title: String, startsAt: Date?,
                       durationMin: Int, timezone: String = TimeZone.current.identifier, share: Bool = true) async throws -> MeetingDTO {
        var body: [String: Any] = ["provider": p.rawValue, "idempotencyKey": idempotencyKey, "title": String(title.prefix(200)),
                                   "durationMin": durationMin, "timezone": timezone, "share": share,
                                   "conversationId": conversationId ?? NSNull()]
        if let startsAt { body["startsAt"] = ISODate.string(startsAt) }
        let m: MeetingDTO = try await api.request("/meetings", method: "POST", json: body)
        // La reunión del calendario llega por calendar.updated; se pide por si el socket va atrasado.
        if let conversationId, m.calendarEventId != nil {
            Task { try? await self.loadEvents(from: Date().addingTimeInterval(-86400), to: Date().addingTimeInterval(120 * 86400), conversationId: conversationId) }
        }
        return m
    }
}
