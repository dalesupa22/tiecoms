import Foundation
import UIKit

struct ApiRequestError: Error, Equatable, LocalizedError {
    var status: Int
    var code: String
    var message: String
    var paths: [String] = []

    /// Errores que no se arreglan reintentando (permiso, validación, conflicto).
    var permanent: Bool { status >= 400 && status < 500 && status != 408 && status != 429 && status != 401 }
    var isNetwork: Bool { status == 0 }
    var errorDescription: String? { message }

    static func network(_ e: Error) -> ApiRequestError {
        ApiRequestError(status: 0, code: "network", message: (e as NSError).localizedDescription)
    }
}

/// Rutas de autenticación. La base queda en una constante porque el backend
/// podría terminar sirviéndola en `/api/auth` en vez de `/api/v1/auth`.
enum AuthRoutes {
    static let base = "/api/v1/auth"
    static var login: String { base + "/login" }
    static var signup: String { base + "/signup" }
    static var refresh: String { base + "/refresh" }
    static var logout: String { base + "/logout" }
    static var ssoExchange: String { base + "/sso/exchange" }
    static func ssoStart(_ provider: SSOProvider) -> String { base + "/\(provider.rawValue)/start" }
}

enum SSOProvider: String, CaseIterable, Identifiable {
    case google, microsoft
    var id: String { rawValue }
    var label: String { L(self == .google ? "auth.withGoogle" : "auth.withMicrosoft") }
}

enum AppConfig {
    static let defaultAPI = "https://app.tiecoms.com"

    /// Orden: argumento de lanzamiento `-TCApiURL` > URL de depuración guardada > producción.
    static var apiBaseURL: URL {
        if let arg = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)["TCApiURL"] as? String,
           let u = URL(string: arg), u.scheme != nil { return u }
        if let custom = Prefs.customAPIURL, let u = URL(string: custom), u.scheme != nil { return u }
        return URL(string: defaultAPI)!
    }

    static var isRunningUnitTests: Bool { ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil }

    static func launchValue(_ name: String) -> String? {
        UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)[name] as? String
    }

    static func launchFlag(_ name: String) -> Bool {
        (UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)[name] as? String).map { $0 == "YES" || $0 == "1" || $0 == "true" } ?? false
    }

    static var appVersion: String {
        let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let b = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        return "\(v) (\(b))"
    }

    /// Modelo del dispositivo, p. ej. "iPhone16,1" (en simulador, el modelo simulado).
    static var deviceModelName: String {
        if let sim = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return "\(sim) (Simulator)" }
        var info = utsname()
        uname(&info)
        let id = withUnsafeBytes(of: &info.machine) { raw in
            String(decoding: raw.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
        return id.isEmpty ? UIDevice.current.model : id
    }
}

/// HTTP del API con renovación de sesión: un único refresh en vuelo, reintento
/// una vez ante 401 y cierre de sesión si el refresh también devuelve 401.
@MainActor
final class APIClient {
    enum RefreshOutcome { case ok, unauthorized, network }

    let baseURL: URL
    private let session: URLSession
    private let secrets: SecretStore
    private(set) var accessToken: String?
    private var accessExp: Date = .distantPast
    private var refreshing: Task<RefreshOutcome, Never>?
    /// Se llama cuando el servidor da la sesión por terminada.
    var onSignedOut: (() -> Void)?

    init(baseURL: URL, secrets: SecretStore, session: URLSession? = nil) {
        self.baseURL = baseURL
        self.secrets = secrets
        if let session { self.session = session } else {
            let cfg = URLSessionConfiguration.default
            cfg.timeoutIntervalForRequest = 20
            cfg.waitsForConnectivity = false
            cfg.httpShouldSetCookies = false
            self.session = URLSession(configuration: cfg)
        }
    }

    var hasStoredSession: Bool { secrets.get() != nil }

    func device() -> [String: Any] {
        ["deviceId": Prefs.deviceId, "name": String(AppConfig.deviceModelName.prefix(120)), "platform": "ios", "contract": Contract.version]
    }

    /// Rutas relativas a /api/v1; las que empiezan por /api/ (p. ej. AuthRoutes) se usan tal cual.
    private func url(_ path: String) -> URL {
        let base = baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return URL(string: base + (path.hasPrefix("/api/") ? path : "/api/v1" + path))!
    }

    private func raw(_ path: String, method: String = "GET", json: [String: Any]? = nil, auth: Bool = true) async throws -> (Data, HTTPURLResponse) {
        var req = URLRequest(url: url(path))
        req.httpMethod = method
        req.setValue("ios", forHTTPHeaderField: "x-tiecoms-client")
        req.setValue(Contract.version, forHTTPHeaderField: "x-tiecoms-contract")
        req.setValue("application/json", forHTTPHeaderField: "accept")
        if let json {
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try JSONSerialization.data(withJSONObject: json)
        }
        if auth, let t = accessToken { req.setValue("Bearer \(t)", forHTTPHeaderField: "authorization") }
        do {
            let (data, resp) = try await session.data(for: req)
            guard let http = resp as? HTTPURLResponse else { throw ApiRequestError(status: 0, code: "network", message: "Sin respuesta") }
            return (data, http)
        } catch let e as ApiRequestError { throw e } catch { throw ApiRequestError.network(error) }
    }

    nonisolated static func parseError(_ data: Data, status: Int) -> ApiRequestError {
        if let body = try? JSONDecoder().decode(ApiErrorBody.self, from: data) {
            return ApiRequestError(status: status, code: body.code.isEmpty ? "http_\(status)" : body.code, message: body.message,
                                   paths: body.details.compactMap(\.path))
        }
        return ApiRequestError(status: status, code: "http_\(status)", message: HTTPURLResponse.localizedString(forStatusCode: status))
    }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        do { return try JSONDecoder().decode(T.self, from: data) } catch {
            throw ApiRequestError(status: 200, code: "decode", message: "Respuesta inesperada del servidor")
        }
    }

    /// Petición autenticada. Renueva el access token si está por vencer y reintenta una vez ante 401.
    func request<T: Decodable>(_ path: String, method: String = "GET", json: [String: Any]? = nil) async throws -> T {
        let data = try await requestData(path, method: method, json: json)
        return try decode(data)
    }

    @discardableResult
    func requestData(_ path: String, method: String = "GET", json: [String: Any]? = nil) async throws -> Data {
        if accessToken == nil || Date() > accessExp.addingTimeInterval(-30) { _ = await refresh() }
        var (data, res) = try await raw(path, method: method, json: json)
        if res.statusCode == 401 {
            let r = await refresh()
            if r == .ok { (data, res) = try await raw(path, method: method, json: json) }
        }
        if res.statusCode == 401 {
            signedOut()
            throw APIClient.parseError(data, status: 401)
        }
        guard (200..<300).contains(res.statusCode) else { throw APIClient.parseError(data, status: res.statusCode) }
        return data
    }

    /// Petición pública (sin token).
    func publicRequest<T: Decodable>(_ path: String) async throws -> T {
        let (data, res) = try await raw(path, auth: false)
        guard (200..<300).contains(res.statusCode) else { throw APIClient.parseError(data, status: res.statusCode) }
        return try decode(data)
    }

    // MARK: Sesión

    func login(email: String, password: String) async throws -> AuthResult {
        let (data, res) = try await raw(AuthRoutes.login, method: "POST", json: ["email": email, "password": password, "device": device()], auth: false)
        guard (200..<300).contains(res.statusCode) else { throw APIClient.parseError(data, status: res.statusCode) }
        let r: AuthResult = try decode(data)
        apply(r)
        return r
    }

    func signup(_ input: [String: Any]) async throws -> AuthResult {
        var body = input
        body["device"] = device()
        let (data, res) = try await raw(AuthRoutes.signup, method: "POST", json: body, auth: false)
        guard (200..<300).contains(res.statusCode) else { throw APIClient.parseError(data, status: res.statusCode) }
        let r: AuthResult = try decode(data)
        apply(r)
        return r
    }

    /// SSO: canjea el código de un solo uso (60 s) con el verifier PKCE.
    func ssoExchange(code: String, verifier: String) async throws -> AuthResult {
        let (data, res) = try await raw(AuthRoutes.ssoExchange, method: "POST",
                                        json: ["code": code, "code_verifier": verifier, "device": device()], auth: false)
        guard (200..<300).contains(res.statusCode) else { throw APIClient.parseError(data, status: res.statusCode) }
        let r: AuthResult = try decode(data)
        apply(r)
        return r
    }

    private func apply(_ r: AuthResult) {
        accessToken = r.accessToken
        accessExp = ISODate.parse(r.accessExpiresAt) ?? Date().addingTimeInterval(10 * 60)
        if let rt = r.refreshToken { secrets.set(rt) }
    }

    /// Vuelo único: llamadas concurrentes esperan el mismo refresh.
    func refresh() async -> RefreshOutcome {
        if let refreshing { return await refreshing.value }
        let t = Task { @MainActor () -> RefreshOutcome in
            guard let stored = self.secrets.get() else { return .unauthorized }
            do {
                let (data, res) = try await self.raw(AuthRoutes.refresh, method: "POST", json: ["refreshToken": stored], auth: false)
                if res.statusCode == 401 || res.statusCode == 403 {
                    self.accessToken = nil
                    return .unauthorized
                }
                guard (200..<300).contains(res.statusCode), let r = try? JSONDecoder().decode(AuthResult.self, from: data) else { return .network }
                self.apply(r)
                return .ok
            } catch {
                return .network
            }
        }
        refreshing = t
        let out = await t.value
        refreshing = nil
        return out
    }

    /// Token vigente para el socket (renueva si está por vencer).
    func freshAccessToken() async -> String? {
        if accessToken == nil || Date() > accessExp.addingTimeInterval(-30) { _ = await refresh() }
        return accessToken
    }

    func logout() async {
        if accessToken != nil { _ = try? await raw(AuthRoutes.logout, method: "POST", json: [:]) }
        clearCredentials()
    }

    func clearCredentials() {
        accessToken = nil
        accessExp = .distantPast
        secrets.set(nil)
    }

    private func signedOut() {
        clearCredentials()
        onSignedOut?()
    }
}
