import Foundation

/// Payload de un push de TieComs (APNs): `aps` + datos (PushData del contrato).
/// Tolerante: campos o tipos desconocidos no rompen; `type` desconocido → .message.
struct PushPayload: Equatable {
    enum Kind: String { case message, reminder, event }

    var kind: Kind
    var conversationId: String
    var messageId: String?
    var authorId: String?
    var authorName: String?
    /// Ruta relativa (/api/v1/avatars/…) o nil.
    var authorAvatarPath: String?
    var reminderId: String?
    var eventId: String?
    var title: String
    var subtitle: String?
    var body: String
    var threadId: String?
    var category: String?
    var badge: Int?

    static let messageCategory = "TC_MESSAGE"
    static let reminderCategory = "TC_REMINDER"
    static let eventCategory = "TC_EVENT"

    init?(userInfo: [AnyHashable: Any]) {
        func str(_ k: String) -> String? {
            if let s = userInfo[k] as? String { return s.isEmpty ? nil : s }
            if let n = userInfo[k] as? NSNumber { return n.stringValue }
            return nil
        }
        guard let conv = str("conversationId") else { return nil }
        conversationId = conv
        kind = Kind(rawValue: str("type") ?? "message") ?? .message
        messageId = str("messageId")
        authorId = str("authorId")
        authorName = str("authorName")
        authorAvatarPath = str("authorAvatarUrl")
        reminderId = str("reminderId")
        eventId = str("eventId")
        let aps = userInfo["aps"] as? [String: Any] ?? [:]
        if let alert = aps["alert"] as? [String: Any] {
            title = alert["title"] as? String ?? ""
            subtitle = (alert["subtitle"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            body = alert["body"] as? String ?? ""
        } else {
            title = str("title") ?? ""
            subtitle = str("subtitle")
            body = (aps["alert"] as? String) ?? str("body") ?? ""
        }
        threadId = aps["thread-id"] as? String ?? str("threadId") ?? conv
        category = aps["category"] as? String ?? str("category")
        badge = (aps["badge"] as? NSNumber)?.intValue
    }

    /// Grupo (título = nombre del chat, subtítulo = «Autor · Empresa») frente a directo (título = autor, sin subtítulo).
    var isGroup: Bool { subtitle != nil }

    /// URL absoluta de la foto del autor, con la base del API.
    func avatarURL(base: URL?) -> URL? {
        guard let p = authorAvatarPath, let base else { return nil }
        if p.hasPrefix("http://") || p.hasPrefix("https://") { return URL(string: p) }
        return URL(string: base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + (p.hasPrefix("/") ? p : "/" + p))
    }
}

/// Entorno de APNs según la compilación: Debug (Xcode) = sandbox; Release/TestFlight/App Store = production.
enum PushEnvironment {
    static var current: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    static func hex(_ token: Data) -> String { token.map { String(format: "%02x", $0) }.joined() }
}
