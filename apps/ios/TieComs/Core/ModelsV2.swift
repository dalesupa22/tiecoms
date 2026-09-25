import Foundation

// DTO de asuntos, agenda, recordatorios, reenvíos, dominios y WhatsApp.
// Misma regla que Models.swift: decodificación tolerante (campos extra, nulos, tipos distintos).

/// Valor JSON arbitrario (payloads libres como el historial de asuntos).
enum JSONValue: Codable, Equatable, Sendable {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else if let o = try? c.decode([String: JSONValue].self) { self = .object(o) }
        else { self = .null }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .object(let o): try c.encode(o)
        case .array(let a): try c.encode(a)
        case .null: try c.encodeNil()
        }
    }

    var stringValue: String? {
        switch self { case .string(let s): return s; case .number(let n): return String(n); default: return nil }
    }
    subscript(key: String) -> JSONValue? { if case .object(let o) = self { return o[key] }; return nil }
}

enum ForwardSource: String, Codable, CaseIterable, Sendable { case whatsapp, slack, email, teams, tiecoms, other }

struct ForwardedInfo: Codable, Equatable, Sendable {
    var source: ForwardSource
    var author: String?
    var sentAt: String?
    var fromConversationId: String?
    /// Respuesta en privado: mensaje original al que se responde.
    var messageId: String?
    /// Los agrega el servidor cuando hay messageId: número del mensaje original y extracto (≤ 200). El cliente no los envía.
    var messageSeq: Int?
    var excerpt: String?

    init(source: ForwardSource, author: String? = nil, sentAt: String? = nil, fromConversationId: String? = nil, messageId: String? = nil) {
        self.source = source; self.author = author; self.sentAt = sentAt; self.fromConversationId = fromConversationId; self.messageId = messageId
    }

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        source = ForwardSource(rawValue: c.v("source", "other")) ?? .other
        author = c.o("author")
        sentAt = c.o("sentAt")
        fromConversationId = c.o("fromConversationId")
        messageId = c.o("messageId")
        messageSeq = c.intOpt("messageSeq")
        excerpt = c.o("excerpt")
    }

    var json: [String: Any] {
        var o: [String: Any] = ["source": source.rawValue]
        o["author"] = author ?? NSNull()
        o["sentAt"] = sentAt ?? NSNull()
        o["fromConversationId"] = fromConversationId ?? NSNull()
        if let messageId { o["messageId"] = messageId }
        return o
    }
}

struct ReminderDTO: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var conversationId: String
    var messageId: String?
    var messageSeq: Int?
    var note: String?
    var remindAt: String
    var firedAt: String?
    var doneAt: String?

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = try c.decode(String.self, forKey: AnyKey("id"))
        conversationId = c.v("conversationId", "")
        messageId = c.o("messageId")
        messageSeq = c.intOpt("messageSeq")
        note = c.o("note")
        remindAt = c.v("remindAt", "")
        firedAt = c.o("firedAt")
        doneAt = c.o("doneAt")
    }
}

enum Rsvp: String, Codable, CaseIterable, Sendable { case pending, yes, no, maybe }

struct CalendarEventDTO: Codable, Equatable, Identifiable, Sendable {
    struct Invitee: Codable, Equatable, Sendable {
        var userId: String
        var rsvp: Rsvp
        init(from decoder: Decoder) throws {
            let c = try container(decoder)
            userId = c.v("userId", "")
            rsvp = Rsvp(rawValue: c.v("rsvp", "pending")) ?? .pending
        }
    }
    var id: String
    /// nil en directos, multi y laterales (SPEC-v4 E).
    var workspaceId: String?
    var conversationId: String
    var originMessageId: String?
    var title: String
    var description: String?
    var location: String?
    var startsAt: String
    var endsAt: String
    var timezone: String
    var organizerId: String
    var invitees: [Invitee]
    var cancelledAt: String?
    var updatedAt: String

    var start: Date { ISODate.parse(startsAt) ?? .distantPast }
    var end: Date { ISODate.parse(endsAt) ?? .distantPast }
    var isCancelled: Bool { cancelledAt != nil }

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = try c.decode(String.self, forKey: AnyKey("id"))
        workspaceId = c.o("workspaceId")
        conversationId = c.v("conversationId", "")
        originMessageId = c.o("originMessageId")
        title = c.v("title", "")
        description = c.o("description")
        location = c.o("location")
        startsAt = c.v("startsAt", "")
        endsAt = c.v("endsAt", "")
        timezone = c.v("timezone", "UTC")
        organizerId = c.v("organizerId", "")
        invitees = c.lossyArray("invitees")
        cancelledAt = c.o("cancelledAt")
        updatedAt = c.v("updatedAt", "")
    }
}

enum IssueStatus: String, Codable, CaseIterable, Sendable {
    case open, in_progress, waiting, done, cancelled
    var closed: Bool { self == .done || self == .cancelled }
}

struct IssueDTO: Codable, Equatable, Identifiable, Sendable {
    var id: String
    /// nil en directos, multi y laterales (SPEC-v4 E).
    var workspaceId: String?
    var conversationId: String
    var originMessageId: String?
    var originMessageSeq: Int?
    var title: String
    var status: IssueStatus
    var waitingOnOrgId: String?
    var ownerId: String?
    var requestedBy: String?
    var dueDate: String?
    var createdBy: String
    var createdAt: String
    var updatedAt: String
    var statusSince: String
    var closedAt: String?
    var commentCount: Int

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = try c.decode(String.self, forKey: AnyKey("id"))
        workspaceId = c.o("workspaceId")
        conversationId = c.v("conversationId", "")
        originMessageId = c.o("originMessageId")
        originMessageSeq = c.intOpt("originMessageSeq")
        title = c.v("title", "")
        status = IssueStatus(rawValue: c.v("status", "open")) ?? .open
        waitingOnOrgId = c.o("waitingOnOrgId")
        ownerId = c.o("ownerId")
        requestedBy = c.o("requestedBy")
        dueDate = c.o("dueDate")
        createdBy = c.v("createdBy", "")
        createdAt = c.v("createdAt", "")
        updatedAt = c.v("updatedAt", "")
        statusSince = c.v("statusSince", createdAt)
        closedAt = c.o("closedAt")
        commentCount = c.int("commentCount")
    }
}

struct IssueEventDTO: Codable, Equatable, Identifiable, Sendable {
    var id: Int
    var issueId: String
    var actorId: String
    var kind: String
    var payload: JSONValue
    var createdAt: String

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = c.int("id")
        issueId = c.v("issueId", "")
        actorId = c.v("actorId", "")
        kind = c.v("kind", "")
        payload = c.v("payload", JSONValue.null)
        createdAt = c.v("createdAt", "")
    }
}

struct IssueDetail: Decodable, Sendable {
    var issue: IssueDTO
    var events: [IssueEventDTO]
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        issue = try c.decode(IssueDTO.self, forKey: AnyKey("issue"))
        events = c.lossyArray("events")
    }
}

struct OrgDomainDTO: Codable, Equatable, Identifiable, Sendable {
    var domain: String
    /// pending | idp | dns
    var status: String
    var txtName: String
    var txtValue: String
    var verifiedAt: String?
    var lastCheckedAt: String?
    var id: String { domain }

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        domain = try c.decode(String.self, forKey: AnyKey("domain"))
        status = c.v("status", "pending")
        txtName = c.v("txtName", "")
        txtValue = c.v("txtValue", "")
        verifiedAt = c.o("verifiedAt")
        lastCheckedAt = c.o("lastCheckedAt")
    }
}

// MARK: WhatsApp

enum WaCategory: String, Codable, CaseIterable, Sendable {
    case trabajo, clientes, familia, amigos, comunidad, otros
    var icon: String { ["trabajo": "💼", "clientes": "🤝", "familia": "🏠", "amigos": "🍻", "comunidad": "🏘", "otros": "◌"][rawValue] ?? "◌" }
}

struct WaAccountDTO: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var label: String
    var kind: String
    var status: String
    var phone: String?
    var pushName: String?
    var platform: String?
    var qr: String?
    var pairingCode: String?
    var lastError: String?
    var connectedAt: String?
    var lastSyncAt: String?
    var chats: Int
    var groups: Int
    var createdAt: String

    var isBusiness: Bool { kind == "business" || (platform ?? "").hasPrefix("smb") }
    var isWaiting: Bool { ["pending", "qr", "reconnecting"].contains(status) }

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = try c.decode(String.self, forKey: AnyKey("id"))
        label = c.v("label", "")
        kind = c.v("kind", "personal")
        status = c.v("status", "pending")
        phone = c.o("phone")
        pushName = c.o("pushName")
        platform = c.o("platform")
        qr = c.o("qr")
        pairingCode = c.o("pairingCode")
        lastError = c.o("lastError")
        connectedAt = c.o("connectedAt")
        lastSyncAt = c.o("lastSyncAt")
        chats = c.int("chats")
        groups = c.int("groups")
        createdAt = c.v("createdAt", "")
    }
}

struct WaChatDTO: Codable, Equatable, Identifiable, Sendable {
    var accountId: String
    var accountLabel: String
    var accountKind: String
    var jid: String
    var name: String
    var isGroup: Bool
    var participants: Int?
    var description: String?
    var lastMessageAt: String?
    var lastPreview: String?
    var unread: Int
    var category: WaCategory
    var categoryManual: Bool
    var pinned: Bool
    var hidden: Bool
    var archivedInWhatsApp: Bool
    var linkedConversationId: String?
    var id: String { "\(accountId)|\(jid)" }

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        accountId = c.v("accountId", "")
        accountLabel = c.v("accountLabel", "")
        accountKind = c.v("accountKind", "personal")
        jid = try c.decode(String.self, forKey: AnyKey("jid"))
        name = c.v("name", "")
        isGroup = c.v("isGroup", false)
        participants = c.intOpt("participants")
        description = c.o("description")
        lastMessageAt = c.o("lastMessageAt")
        lastPreview = c.o("lastPreview")
        unread = c.int("unread")
        category = WaCategory(rawValue: c.v("category", "otros")) ?? .otros
        categoryManual = c.v("categoryManual", false)
        pinned = c.v("pinned", false)
        hidden = c.v("hidden", false)
        archivedInWhatsApp = c.v("archivedInWhatsApp", false)
        linkedConversationId = c.o("linkedConversationId")
    }
}

struct WaMessageDTO: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var fromMe: Bool
    var author: String?
    var kind: String
    var body: String
    var sentAt: String
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = try c.decode(String.self, forKey: AnyKey("id"))
        fromMe = c.v("fromMe", false)
        author = c.o("author")
        kind = c.v("kind", "text")
        body = c.v("body", "")
        sentAt = c.v("sentAt", "")
    }
}

struct WaChatsPage: Decodable, Sendable {
    struct Count: Decodable, Sendable {
        var total: Int; var unread: Int
        init(from decoder: Decoder) throws { let c = try container(decoder); total = c.int("total"); unread = c.int("unread") }
    }
    var chats: [WaChatDTO]
    var categories: [String: Count]
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        chats = c.lossyArray("chats")
        categories = c.v("categories", [:])
    }
}

/// Envoltorios de listas del API.
struct ListOf<T: Decodable>: Decodable {
    var items: [T]
    var max: Int?
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        let key = c.allKeys.first { ["issues", "events", "reminders", "messages", "domains", "accounts"].contains($0.stringValue) }?.stringValue ?? ""
        items = c.lossyArray(key)
        max = c.intOpt("max")
    }
}

// MARK: - Archivos (árbol de carpetas)

struct DriveFolderDTO: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var parentId: String?
    var name: String
    var createdBy: String?
    var createdAt: String

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = try c.decode(String.self, forKey: AnyKey("id"))
        parentId = c.o("parentId")
        name = c.v("name", "")
        createdBy = c.o("createdBy")
        createdAt = c.v("createdAt", "")
    }
}

struct DriveFileDTO: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var folderId: String?
    var name: String
    var contentType: String
    var size: Int
    var createdBy: String?
    var createdAt: String

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = try c.decode(String.self, forKey: AnyKey("id"))
        folderId = c.o("folderId")
        name = c.v("name", "")
        contentType = c.v("contentType", "application/octet-stream")
        size = c.int("size")
        createdBy = c.o("createdBy")
        createdAt = c.v("createdAt", "")
    }
}

/// Un árbol completo: «Mis archivos» (workspaceId nil) o el de un espacio.
struct DriveTreeDTO: Decodable, Equatable, Sendable {
    var workspaceId: String?
    var folders: [DriveFolderDTO]
    var files: [DriveFileDTO]
    var canManageAll: Bool

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        workspaceId = c.o("workspaceId")
        folders = c.lossyArray("folders")
        files = c.lossyArray("files")
        canManageAll = c.v("canManageAll", false)
    }

    func folders(in parent: String?) -> [DriveFolderDTO] {
        folders.filter { $0.parentId == parent }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }
    func files(in folder: String?) -> [DriveFileDTO] {
        files.filter { $0.folderId == folder }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }
}

/// Resultado de POST /chats: con una persona, el directo existente; con varias, un chat grupal.
struct CreateChatResult: Decodable, Sendable {
    var id: String
    var kind: ConversationKind
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = try c.decode(String.self, forKey: AnyKey("id"))
        kind = ConversationKind(rawValue: c.v("kind", "multi")) ?? .multi
    }
}


// MARK: Adjuntos

struct AttachmentDTO: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var name: String
    var contentType: String
    var sizeBytes: Int
    var width: Int?
    var height: Int?
    /// /api/v1/attachments/<id> (autenticada con Bearer).
    var url: String
    var thumbUrl: String?
    /// 'voice' en notas de voz (SPEC-v4 F); los adjuntos normales no lo traen.
    var kind: String?
    var durationMs: Int?
    /// Hasta 64 valores 0…1.
    var waveform: [Double]?
    var transcript: VoiceTranscript?

    var isVoice: Bool { kind == "voice" }
    var isImage: Bool { !isVoice && contentType.hasPrefix("image/") }
    var isVideo: Bool { !isVoice && contentType.hasPrefix("video/") }
    var isMedia: Bool { isImage || isVideo }

    init(id: String, name: String, contentType: String, sizeBytes: Int, width: Int? = nil, height: Int? = nil, url: String, thumbUrl: String? = nil,
         kind: String? = nil, durationMs: Int? = nil, waveform: [Double]? = nil, transcript: VoiceTranscript? = nil) {
        self.id = id; self.name = name; self.contentType = contentType; self.sizeBytes = sizeBytes
        self.width = width; self.height = height; self.url = url; self.thumbUrl = thumbUrl
        self.kind = kind; self.durationMs = durationMs; self.waveform = waveform; self.transcript = transcript
    }

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = try c.decode(String.self, forKey: AnyKey("id"))
        name = c.v("name", "archivo")
        contentType = c.v("contentType", "application/octet-stream")
        sizeBytes = c.int("sizeBytes")
        width = c.intOpt("width")
        height = c.intOpt("height")
        url = c.v("url", "/api/v1/attachments/\(id)")
        thumbUrl = c.o("thumbUrl")
        kind = c.o("kind")
        durationMs = c.intOpt("durationMs")
        waveform = (c.o("waveform") as [Double]?).map { $0.prefix(64).map { min(1, max(0, $0)) } }
        transcript = c.o("transcript")
    }
}

/// Transcripción de una nota de voz: pending → done | failed; disabled si el servidor no tiene llave.
struct VoiceTranscript: Codable, Equatable, Sendable {
    enum Status: String, Codable, Sendable { case pending, done, failed, disabled }
    var status: Status
    var text: String?
    var language: String?
    var summary: String?
    /// Título para el chip «Crear asunto: …».
    var suggestedIssue: String?

    init(status: Status, text: String? = nil, language: String? = nil, summary: String? = nil, suggestedIssue: String? = nil) {
        self.status = status; self.text = text; self.language = language; self.summary = summary; self.suggestedIssue = suggestedIssue
    }
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        status = Status(rawValue: c.v("status", "pending")) ?? .pending
        text = c.o("text"); language = c.o("language"); summary = c.o("summary"); suggestedIssue = c.o("suggestedIssue")
    }
}

/// ConversationDTO.lastHumanPreview: el último mensaje de una persona.
struct HumanPreview: Codable, Equatable, Sendable {
    struct Counts: Codable, Equatable, Sendable {
        var count: Int; var images: Int; var videos: Int; var files: Int; var firstName: String?
        var voices: Int = 0; var voiceDurationMs: Int?
        init(count: Int, images: Int, videos: Int, files: Int, firstName: String?, voices: Int = 0, voiceDurationMs: Int? = nil) {
            self.count = count; self.images = images; self.videos = videos; self.files = files; self.firstName = firstName
            self.voices = voices; self.voiceDurationMs = voiceDurationMs
        }
        init(from decoder: Decoder) throws {
            let c = try container(decoder)
            count = c.int("count"); images = c.int("images"); videos = c.int("videos"); files = c.int("files"); firstName = c.o("firstName")
            voices = c.int("voices"); voiceDurationMs = c.intOpt("voiceDurationMs")
        }
    }
    var messageId: String?
    var seq: Int
    var authorId: String?
    var body: String
    var attachments: Counts?
    var createdAt: String?

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        messageId = c.o("messageId"); seq = c.int("seq"); authorId = c.o("authorId"); body = c.v("body", "")
        attachments = c.o("attachments"); createdAt = c.o("createdAt")
    }
}
