import Foundation

/// Versión del contrato que habla esta app (ver packages/contracts).
enum Contract {
    static let version = "2026-09-23"
}

// MARK: - Decodificación tolerante
//
// Regla del contrato: el API solo hace cambios aditivos. Una app instalada debe
// seguir funcionando cuando aparezcan campos nuevos o un opcional llegue nulo,
// así que cada DTO ignora claves desconocidas (comportamiento por defecto de
// Codable) y usa valores por defecto cuando falta un campo, llega null o llega
// con otro tipo.

struct AnyKey: CodingKey {
    var stringValue: String
    var intValue: Int?
    init(_ s: String) { stringValue = s }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { stringValue = String(intValue); self.intValue = intValue }
}

extension KeyedDecodingContainer where K == AnyKey {
    /// Valor o `fallback` si falta, es null o tiene otro tipo.
    func v<T: Decodable>(_ key: String, _ fallback: T) -> T {
        (try? decodeIfPresent(T.self, forKey: AnyKey(key))) ?? fallback
    }
    /// Opcional tolerante.
    func o<T: Decodable>(_ key: String) -> T? {
        (try? decodeIfPresent(T.self, forKey: AnyKey(key))) ?? nil
    }
    /// Número entero aunque llegue como Double o String.
    func int(_ key: String, _ fallback: Int = 0) -> Int {
        if let i = try? decodeIfPresent(Int.self, forKey: AnyKey(key)) { return i }
        if let d = try? decodeIfPresent(Double.self, forKey: AnyKey(key)) { return Int(d) }
        if let s = try? decodeIfPresent(String.self, forKey: AnyKey(key)), let i = Int(s) { return i }
        return fallback
    }
    func intOpt(_ key: String) -> Int? {
        if let i = try? decodeIfPresent(Int.self, forKey: AnyKey(key)) { return i }
        if let d = try? decodeIfPresent(Double.self, forKey: AnyKey(key)) { return Int(d) }
        return nil
    }
}

private func container(_ d: Decoder) throws -> KeyedDecodingContainer<AnyKey> {
    try d.container(keyedBy: AnyKey.self)
}

// MARK: - Entidades

struct UserDTO: Codable, Equatable, Sendable {
    var id: String
    var name: String
    var email: String?
    var kind: String
    var title: String?
    var area: String?
    var primaryOrgId: String?

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = try c.decode(String.self, forKey: AnyKey("id"))
        name = c.v("name", "")
        email = c.o("email")
        kind = c.v("kind", "human")
        title = c.o("title")
        area = c.o("area")
        primaryOrgId = c.o("primaryOrgId")
    }
}

struct OrganizationDTO: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var name: String
    var mark: String
    var colorBg: String
    var colorFg: String
    var myRole: String?

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = try c.decode(String.self, forKey: AnyKey("id"))
        name = c.v("name", "")
        mark = c.v("mark", "")
        colorBg = c.v("colorBg", "#E0DACE")
        colorFg = c.v("colorFg", "#5C554C")
        myRole = c.o("myRole")
    }
}

struct PersonDTO: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var name: String
    var kind: String
    var orgId: String?
    var title: String?
    var area: String?
    var guest: Bool
    var guestUntil: String?

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = try c.decode(String.self, forKey: AnyKey("id"))
        name = c.v("name", "")
        kind = c.v("kind", "human")
        orgId = c.o("orgId")
        title = c.o("title")
        area = c.o("area")
        guest = c.v("guest", false)
        guestUntil = c.o("guestUntil")
    }
}

struct WorkspaceDTO: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var name: String
    var department: String?
    var glyph: String?
    var owningOrgId: String
    var organizationIds: [String]
    var memberIds: [String]
    var myRole: String
    var createdAt: String

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = try c.decode(String.self, forKey: AnyKey("id"))
        name = c.v("name", "")
        department = c.o("department")
        glyph = c.o("glyph")
        owningOrgId = c.v("owningOrgId", "")
        organizationIds = c.v("organizationIds", [])
        memberIds = c.v("memberIds", [])
        myRole = c.v("myRole", "member")
        createdAt = c.v("createdAt", "")
    }
}

enum ConversationKind: String, Codable, Sendable { case group, `internal`, direct }

struct ConversationDTO: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var workspaceId: String?
    var kind: ConversationKind
    var level: String?
    var name: String?
    var internalOrgId: String?
    var memberIds: [String]
    var lastMessageSeq: Int
    var lastEventSeq: Int
    var lastMessageAt: String?
    var lastMessagePreview: String?
    var lastReadSeq: Int
    var unread: Int
    var canPost: Bool
    var canManage: Bool
    var historyFromSeq: Int
    // Campos nuevos (bifurcaciones/issues): opcionales para convivir con API antiguos.
    var parentId: String?
    var deriveKind: String?
    var openIssues: Int
    /// Preferencia personal: silenciada hasta esta fecha (no avisa).
    var mutedUntil: String?

    var isMuted: Bool { (ISODate.parse(mutedUntil) ?? .distantPast) > Date() }

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = try c.decode(String.self, forKey: AnyKey("id"))
        workspaceId = c.o("workspaceId")
        // Un tipo desconocido se trata como grupo: se ve y se puede leer.
        kind = ConversationKind(rawValue: c.v("kind", "group")) ?? .group
        level = c.o("level")
        name = c.o("name")
        internalOrgId = c.o("internalOrgId")
        memberIds = c.v("memberIds", [])
        lastMessageSeq = c.int("lastMessageSeq")
        lastEventSeq = c.int("lastEventSeq")
        lastMessageAt = c.o("lastMessageAt")
        lastMessagePreview = c.o("lastMessagePreview")
        lastReadSeq = c.int("lastReadSeq")
        unread = c.int("unread")
        canPost = c.v("canPost", true)
        canManage = c.v("canManage", false)
        historyFromSeq = c.int("historyFromSeq")
        parentId = c.o("parentId")
        deriveKind = c.o("deriveKind")
        openIssues = c.int("openIssues")
        mutedUntil = c.o("mutedUntil")
    }
}

struct MessageDTO: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var conversationId: String
    var seq: Int
    var authorId: String
    var clientMessageId: String?
    var kind: String
    var body: String
    var replyTo: String?
    var mergedFrom: String?
    var createdAt: String
    var editedAt: String?
    var deletedAt: String?

    var isSystem: Bool { kind == "system" }

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = try c.decode(String.self, forKey: AnyKey("id"))
        conversationId = c.v("conversationId", "")
        seq = c.int("seq")
        authorId = c.v("authorId", "")
        clientMessageId = c.o("clientMessageId")
        kind = c.v("kind", "text")
        body = c.v("body", "")
        replyTo = c.o("replyTo")
        mergedFrom = c.o("mergedFrom")
        createdAt = c.v("createdAt", "")
        editedAt = c.o("editedAt")
        deletedAt = c.o("deletedAt")
    }

    init(id: String, conversationId: String, seq: Int, authorId: String, clientMessageId: String?, kind: String = "text",
         body: String, createdAt: String) {
        self.id = id; self.conversationId = conversationId; self.seq = seq; self.authorId = authorId
        self.clientMessageId = clientMessageId; self.kind = kind; self.body = body; self.createdAt = createdAt
    }
}

struct BootstrapDTO: Codable, Equatable, Sendable {
    var contract: String
    var serverTime: String
    var me: UserDTO
    var organizations: [OrganizationDTO]
    var workspaces: [WorkspaceDTO]
    var conversations: [ConversationDTO]
    var people: [PersonDTO]

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        contract = c.v("contract", "")
        serverTime = c.v("serverTime", "")
        me = try c.decode(UserDTO.self, forKey: AnyKey("me"))
        organizations = c.lossyArray("organizations")
        workspaces = c.lossyArray("workspaces")
        conversations = c.lossyArray("conversations")
        people = c.lossyArray("people")
    }
}

struct AuthResult: Decodable, Sendable {
    var accessToken: String
    var accessExpiresAt: String
    var refreshToken: String?
    var sessionId: String
    var user: UserDTO

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        accessToken = try c.decode(String.self, forKey: AnyKey("accessToken"))
        accessExpiresAt = c.v("accessExpiresAt", "")
        refreshToken = c.o("refreshToken")
        sessionId = c.v("sessionId", "")
        user = try c.decode(UserDTO.self, forKey: AnyKey("user"))
    }
}

struct MessagesPage: Decodable, Sendable {
    var messages: [MessageDTO]
    var hasMore: Bool
    var lastEventSeq: Int
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        messages = c.lossyArray("messages")
        hasMore = c.v("hasMore", false)
        lastEventSeq = c.int("lastEventSeq")
    }
}

struct SendResult: Decodable, Sendable {
    var message: MessageDTO
    var duplicate: Bool
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        message = try c.decode(MessageDTO.self, forKey: AnyKey("message"))
        duplicate = c.v("duplicate", false)
    }
}

struct InvitationPreviewDTO: Decodable, Equatable, Sendable {
    var workspaceName: String
    var invitedByName: String
    var invitedByOrg: String
    var role: String
    var email: String?
    var expiresAt: String
    var valid: Bool
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        workspaceName = c.v("workspaceName", "")
        invitedByName = c.v("invitedByName", "")
        invitedByOrg = c.v("invitedByOrg", "")
        role = c.v("role", "member")
        email = c.o("email")
        expiresAt = c.v("expiresAt", "")
        valid = c.v("valid", false)
    }
}

struct OrgInvitationPreviewDTO: Decodable, Equatable, Sendable {
    var orgName: String
    var invitedByName: String
    var email: String?
    var expiresAt: String
    var valid: Bool
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        orgName = c.v("orgName", "")
        invitedByName = c.v("invitedByName", "")
        email = c.o("email")
        expiresAt = c.v("expiresAt", "")
        valid = c.v("valid", false)
    }
}

struct AcceptInvitationResult: Decodable, Sendable {
    var workspaceId: String
    var conversationIds: [String]
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        workspaceId = c.v("workspaceId", "")
        conversationIds = c.v("conversationIds", [])
    }
}

// MARK: - Eventos

/// Evento durable de una conversación. Los tipos que esta versión no conoce
/// (p. ej. `issue.updated`) o que no traen datos útiles (`redacted`) se
/// conservan como `.other` para que su `eventSeq` avance el cursor.
enum ConversationEvent: Decodable, Equatable, Sendable {
    case messageCreated(conversationId: String, eventSeq: Int, message: MessageDTO)
    case messageUpdated(conversationId: String, eventSeq: Int, message: MessageDTO)
    case membersChanged(conversationId: String, eventSeq: Int, memberIds: [String])
    case other(type: String, conversationId: String, eventSeq: Int)

    var conversationId: String {
        switch self {
        case .messageCreated(let c, _, _), .messageUpdated(let c, _, _), .membersChanged(let c, _, _), .other(_, let c, _): return c
        }
    }
    var eventSeq: Int {
        switch self {
        case .messageCreated(_, let s, _), .messageUpdated(_, let s, _), .membersChanged(_, let s, _), .other(_, _, let s): return s
        }
    }

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        let type: String = c.v("type", "")
        let conv: String = c.v("conversationId", "")
        let seq = c.int("eventSeq")
        switch type {
        case "message.created":
            if let m: MessageDTO = c.o("message") { self = .messageCreated(conversationId: conv, eventSeq: seq, message: m); return }
        case "message.updated":
            if let m: MessageDTO = c.o("message") { self = .messageUpdated(conversationId: conv, eventSeq: seq, message: m); return }
        case "members.changed":
            self = .membersChanged(conversationId: conv, eventSeq: seq, memberIds: c.v("memberIds", [])); return
        default: break
        }
        self = .other(type: type, conversationId: conv, eventSeq: seq)
    }
}

enum AccountEvent: Decodable, Equatable, Sendable {
    case scopeChanged(reason: String)
    case readUpdated(conversationId: String, seq: Int)
    case other(type: String)

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        let type: String = c.v("type", "")
        switch type {
        case "scope.changed": self = .scopeChanged(reason: c.v("reason", ""))
        case "read.updated": self = .readUpdated(conversationId: c.v("conversationId", ""), seq: c.int("seq"))
        default: self = .other(type: type)
        }
    }
}

struct EventsPage: Decodable, Sendable {
    var events: [ConversationEvent]
    var resetRequired: Bool
    var lastEventSeq: Int
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        events = c.lossyArray("events")
        resetRequired = c.v("resetRequired", false)
        lastEventSeq = c.int("lastEventSeq")
    }
}

struct TypingEvent: Decodable, Sendable {
    var conversationId: String
    var userId: String
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        conversationId = c.v("conversationId", "")
        userId = c.v("userId", "")
    }
}

struct ApiErrorBody: Decodable {
    var code: String
    var message: String
    var details: [ErrorDetail]
    struct ErrorDetail: Decodable { var path: String? }
    init(from decoder: Decoder) throws {
        let root = try container(decoder)
        let c = try root.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("error"))
        code = c.v("code", "")
        message = c.v("message", "")
        details = c.v("details", [])
    }
}

// MARK: - Arreglos con elementos defectuosos

private struct Lossy<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

extension KeyedDecodingContainer where K == AnyKey {
    /// Un elemento que no se puede leer se descarta en vez de invalidar toda la respuesta.
    func lossyArray<T: Decodable>(_ key: String) -> [T] {
        ((try? decodeIfPresent([Lossy<T>].self, forKey: AnyKey(key))) ?? nil)?.compactMap(\.value) ?? []
    }
}

// MARK: - Fechas ISO-8601

enum ISODate {
    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()
    private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; return f
    }()
    static func parse(_ s: String?) -> Date? {
        guard let s, !s.isEmpty else { return nil }
        return withFraction.date(from: s) ?? plain.date(from: s)
    }
    static func string(_ d: Date = Date()) -> String { withFraction.string(from: d) }
}
