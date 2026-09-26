import AuthenticationServices
import CryptoKit
import Foundation
import UIKit

/// PKCE (RFC 7636) con S256.
struct PKCE: Equatable {
    let verifier: String
    let challenge: String

    /// Verifier aleatorio de 64 caracteres base64url (48 bytes).
    static func generate() -> PKCE {
        var bytes = [UInt8](repeating: 0, count: 48)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        precondition(status == errSecSuccess, "SecRandomCopyBytes falló")
        return PKCE(verifier: base64url(Data(bytes)))
    }

    init(verifier: String) {
        self.verifier = verifier
        self.challenge = PKCE.base64url(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    static func base64url(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}

/// Resultado del callback `chaggu://auth/callback?...`.
enum SSOCallback: Equatable {
    case code(String)
    case error(code: String, message: String?)

    /// Esquema que registra la app (CFBundleURLSchemes) y que se pide al backend con `redirect_scheme`.
    static let scheme = "chaggu"
    /// Esquemas aceptados en el callback: el propio y, por si acaso, el de la app anterior (TieComs),
    /// que el backend usa cuando no recibe `redirect_scheme`.
    static let acceptedSchemes: Set<String> = [scheme, "tiecoms"]

    static func parse(_ url: URL) -> SSOCallback? {
        guard let s = url.scheme?.lowercased(), acceptedSchemes.contains(s), url.host?.lowercased() == "auth",
              url.pathComponents.filter({ $0 != "/" }).first == "callback",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        let q = Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
        if let e = q["error"], !e.isEmpty { return .error(code: e, message: q["message"].flatMap { $0.isEmpty ? nil : $0 }) }
        if let c = q["code"], !c.isEmpty { return .code(c) }
        return .error(code: "invalid_callback", message: nil)
    }

    /// El host `auth` del esquema propio queda reservado para SSO.
    static func isReserved(_ url: URL) -> Bool {
        url.scheme.map { acceptedSchemes.contains($0.lowercased()) } == true && url.host?.lowercased() == "auth"
    }
}

enum SSOError: Error, Equatable {
    case cancelled
    case provider(code: String, message: String?)
    case couldNotStart
}

/// Abre el proveedor con ASWebAuthenticationSession (nunca un WebView) y devuelve el código.
@MainActor
final class SSOAuthenticator: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    static func startURL(base: URL, provider: SSOProvider, deviceId: String, pkce: PKCE, orgInviteToken: String? = nil, orgName: String? = nil) -> URL {
        var c = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        let prefix = c.path.hasSuffix("/") ? String(c.path.dropLast()) : c.path
        c.path = prefix + AuthRoutes.ssoStart(provider)
        c.queryItems = [
            URLQueryItem(name: "platform", value: "ios"),
            URLQueryItem(name: "device_id", value: deviceId),
            URLQueryItem(name: "code_challenge", value: pkce.challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            // El backend redirige a chaggu://auth/callback?code=… (sin esto usaría tiecoms://).
            URLQueryItem(name: "redirect_scheme", value: SSOCallback.scheme),
        ]
        // Registro con SSO: unirse a una empresa por invitación o crear una nueva con este nombre.
        if let orgInviteToken { c.queryItems?.append(URLQueryItem(name: "org", value: orgInviteToken)) }
        else if let orgName, !orgName.isEmpty { c.queryItems?.append(URLQueryItem(name: "org_name", value: orgName)) }
        return c.url!
    }

    func authenticate(url: URL) async throws -> String {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<String, Error>) in
            let s = ASWebAuthenticationSession(url: url, callbackURLScheme: SSOCallback.scheme) { callback, error in
                if let error {
                    let cancelled = (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin
                    cont.resume(throwing: cancelled ? SSOError.cancelled : SSOError.provider(code: "session", message: error.localizedDescription))
                    return
                }
                switch callback.flatMap(SSOCallback.parse) {
                case .code(let code): cont.resume(returning: code)
                case .error(let code, let message): cont.resume(throwing: SSOError.provider(code: code, message: message))
                case nil: cont.resume(throwing: SSOError.provider(code: "invalid_callback", message: nil))
                }
            }
            s.presentationContextProvider = self
            s.prefersEphemeralWebBrowserSession = false
            session = s
            if !s.start() { cont.resume(throwing: SSOError.couldNotStart) }
        }
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.first.map { UIWindow(windowScene: $0) } ?? ASPresentationAnchor()
        }
    }
}
