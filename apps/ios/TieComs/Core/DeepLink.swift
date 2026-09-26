import Foundation

/// Enlaces que abre la app: https://{app.,www.,}chaggu.com/..., los viejos de tiecoms.com y chaggu://...
/// (también se entiende tiecoms://..., aunque la app ya no registra ese esquema).
enum DeepLink: Equatable, Hashable {
    case conversation(String)
    case workspace(String)
    case invite(String)
    case signup(orgToken: String?)
    case issues
    case agenda
    case trazo
    case whatsapp
    case share(text: String?)

    static let hosts: Set<String> = ["app.chaggu.com", "chaggu.com", "www.chaggu.com",
                                     // Dominio anterior de la marca: los enlaces ya compartidos siguen abriendo la app.
                                     "app.tiecoms.com", "tiecoms.com", "www.tiecoms.com"]

    /// Esquema propio (registrado en Info.plist) y el de la app anterior.
    static let customSchemes: Set<String> = ["chaggu", "tiecoms"]

    /// ?m=<seq> en /c/<id>: saltar a ese mensaje.
    static func messageSeq(_ url: URL) -> Int? {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "m" }?.value.flatMap(Int.init)
    }

    static func parse(_ url: URL) -> DeepLink? {
        guard let scheme = url.scheme?.lowercased() else { return nil }
        var parts: [String]
        if customSchemes.contains(scheme) {
            // El host `auth` está reservado para el callback de SSO.
            if url.host?.lowercased() == "auth" { return nil }
            // chaggu://c/<id> → host "c", ruta "/<id>". También se acepta chaggu:///c/<id>.
            parts = (url.host.map { [$0] } ?? []) + url.pathComponents.filter { $0 != "/" }
        } else if scheme == "https" || scheme == "http" {
            guard let host = url.host?.lowercased(), hosts.contains(host) else { return nil }
            parts = url.pathComponents.filter { $0 != "/" }
        } else { return nil }
        parts = parts.filter { !$0.isEmpty }
        guard let head = parts.first?.lowercased() else { return nil }
        let arg = parts.count > 1 ? parts[1].removingPercentEncoding ?? parts[1] : nil
        switch head {
        case "c": return arg.flatMap { valid($0) ? .conversation($0) : nil }
        case "w": return arg.flatMap { valid($0) ? .workspace($0) : nil }
        case "invite": return arg.flatMap { $0.count <= 300 ? .invite($0) : nil }
        case "asuntos", "issues": return .issues
        case "agenda": return .agenda
        case "trazo": return .trazo
        case "whatsapp": return .whatsapp
        case "share":
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let text = ["title", "text", "url"].compactMap { k in items.first(where: { $0.name == k })?.value }.filter { !$0.isEmpty }.joined(separator: "\n")
            return .share(text: text.isEmpty ? nil : text)
        case "signup":
            let org = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "org" })?.value
            return .signup(orgToken: org?.isEmpty == false ? org : nil)
        default: return nil
        }
    }

    private static func valid(_ id: String) -> Bool {
        id.count <= 64 && id.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" }
    }
}
