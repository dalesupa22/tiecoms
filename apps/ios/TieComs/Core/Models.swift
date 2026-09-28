import Foundation

/// Versión del contrato que habla esta app (ver packages/contracts).
enum Contract {
    static let version = "2026-09-28"
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

func container(_ d: Decoder) throws -> KeyedDecodingContainer<AnyKey> {
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
    /// Ruta relativa de la foto (/api/v1/avatars/<uuid>) o nil.
    var avatarUrl: String?
    /// «No molestar» hasta esta fecha (bootstrap `me.dndUntil`; null o ausente = apagado). SPEC-silencio §3.
    var dndUntil: String?
    /// Modo sueño (bootstrap `me.sleep`, evento `me.sleep`); ausente = servidor anterior. docs/PROGRAMADOS.md.
    var sleep: SleepDTO?

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = try c.decode(String.self, forKey: AnyKey("id"))
        sleep = c.o("sleep")
        name = c.v("name", "")
        email = c.o("email")
        kind = c.v("kind", "human")
        title = c.o("title")
        area = c.o("area")
        primaryOrgId = c.o("primaryOrgId")
        avatarUrl = c.o("avatarUrl")
        dndUntil = c.o("dndUntil")
    }
}

/// Modo sueño: todas las noches, de `start` a `end` (HH:MM en `tz`), no suena nada.
struct SleepDTO: Codable, Equatable, Sendable {
    var on: Bool
    var start: String
    var end: String
    var tz: String
    var tzAuto: Bool
    init(on: Bool = true, start: String = "22:00", end: String = "07:00", tz: String = "America/Bogota", tzAuto: Bool = true) {
        self.on = on; self.start = start; self.end = end; self.tz = tz; self.tzAuto = tzAuto
    }
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        on = c.v("on", true); start = c.v("start", "22:00"); end = c.v("end", "07:00")
        tz = c.v("tz", "America/Bogota"); tzAuto = c.v("tzAuto", true)
    }
    var window: SleepWindow? { on ? SleepWindow(start: start, end: end, tz: tz) : nil }
}

/// Ventana de descanso de otra persona (`people[].sleep`).
struct SleepWindow: Codable, Equatable, Sendable {
    var start: String
    var end: String
    var tz: String
    init(start: String, end: String, tz: String) { self.start = start; self.end = end; self.tz = tz }
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        start = c.v("start", "22:00"); end = c.v("end", "07:00"); tz = c.v("tz", "America/Bogota")
    }
}

struct OrganizationDTO: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var name: String
    var mark: String
    var colorBg: String
    var colorFg: String
    var myRole: String?
    /// none | idp | dns
    var verification: String
    var verifiedDomain: String?
    /// 👀 y ✅ con acción para la gente de esta empresa (docs/REACCIONES_ENLACES.md). Activas por defecto.
    var reactionActions = true

    var canAdmin: Bool { myRole == "owner" || myRole == "admin" }

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = try c.decode(String.self, forKey: AnyKey("id"))
        verification = c.v("verification", "none")
        verifiedDomain = c.o("verifiedDomain")
        name = c.v("name", "")
        mark = c.v("mark", "")
        colorBg = c.v("colorBg", "#E0DACE")
        colorFg = c.v("colorFg", "#5C554C")
        myRole = c.o("myRole")
        reactionActions = c.v("reactionActions", true)
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
    /// Ruta relativa de la foto (/api/v1/avatars/<uuid>) o nil: se muestran iniciales.
    var avatarUrl: String?
    /// Su horario de descanso (`people[].sleep`), o nil si lo tiene apagado.
    var sleep: SleepWindow?

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = try c.decode(String.self, forKey: AnyKey("id"))
        sleep = c.o("sleep")
        name = c.v("name", "")
        kind = c.v("kind", "human")
        orgId = c.o("orgId")
        title = c.o("title")
        area = c.o("area")
        guest = c.v("guest", false)
        guestUntil = c.o("guestUntil")
        avatarUrl = c.o("avatarUrl")
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
    var pinnedAt: String?
    /// Espacio casa de la empresa («Tu organización»): sus grupos van sin cabecera de espacio. API viejo: false.
    var isOrgHome: Bool = false
    /// Empresa invitada que aún no entra: la relación se muestra con este nombre y como pendiente.
    var counterpartName: String?

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = try c.decode(String.self, forKey: AnyKey("id"))
        isOrgHome = c.v("isOrgHome", false)
        counterpartName = c.o("counterpartName")
        name = c.v("name", "")
        department = c.o("department")
        glyph = c.o("glyph")
        owningOrgId = c.v("owningOrgId", "")
        organizationIds = c.v("organizationIds", [])
        memberIds = c.v("memberIds", [])
        myRole = c.v("myRole", "member")
        createdAt = c.v("createdAt", "")
        pinnedAt = c.o("pinnedAt")
    }
}

/// `multi` = chat grupal entre personas (de una o varias empresas) que no vive en un espacio.
enum ConversationKind: String, Codable, Sendable { case group, `internal`, direct, multi
    /// Directos y chats grupales van juntos en la lista (no pertenecen a un espacio).
    var isChat: Bool { self == .direct || self == .multi }
}

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
    /// Sidechat abierto desde un asunto: las tareas creadas aquí son hijas de él (docs/TAREAS.md).
    var sideIssueId: String?
    var parentMessageId: String?
    var parentMessageSeq: Int?
    var deriveKind: String?
    var deriveReason: String?
    var returnedAt: String?
    var openIssues: Int
    /// Preferencia personal: fijada arriba.
    var pinnedAt: String?
    /// Foto del grupo (/api/v1/avatars/<id>), si tiene.
    var avatarUrl: String?
    /// Último mensaje de una persona (el API lo manda para que la lista no muestre mensajes de sistema).
    var lastHumanPreview: HumanPreview?
    /// Preferencia personal: silenciada hasta esta fecha (no avisa).
    var mutedUntil: String?
    /// Menciones a mí (o @todos) sin leer (SPEC-v4 H).
    var unreadMentions: Int = 0
    /// Admins explícitos del grupo (orden de ingreso). Solo en group/internal/multi; nil = servidor anterior
    /// (docs/ADMINS-INTEGRACIONES.md §1).
    var adminIds: [String]? = nil
    /// Quien creó el grupo: no se le quita el admin ni se le saca. nil = servidor anterior.
    var createdBy: String? = nil

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
        sideIssueId = c.o("sideIssueId")
        parentMessageId = c.o("parentMessageId")
        parentMessageSeq = c.intOpt("parentMessageSeq")
        deriveKind = c.o("deriveKind")
        deriveReason = c.o("deriveReason")
        returnedAt = c.o("returnedAt")
        pinnedAt = c.o("pinnedAt")
        avatarUrl = c.o("avatarUrl")
        lastHumanPreview = c.o("lastHumanPreview")
        unreadMentions = c.int("unreadMentions")
        openIssues = c.int("openIssues")
        mutedUntil = c.o("mutedUntil")
        adminIds = c.o("adminIds")
        createdBy = c.o("createdBy")
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
    /// 'side' | 'same' | 'internal' | 'directive' (qué tipo de conversación se llevó al hilo).
    var mergedKind: String?
    var forwarded: ForwardedInfo?
    /// Vista previa del primer enlace; llega después del envío con `message.updated`.
    var linkPreview: LinkPreviewDTO?
    /// Adjuntos (vacío en mensajes viejos).
    var attachments: [AttachmentDTO] = []
    /// Menciones válidas, ordenadas por start (offsets UTF-16 sobre body).
    var mentions: [Mention] = []
    /// Reacciones (orden de la primera). Llegan en vivo con `message.updated`: no suben no leídos ni marcan «editado».
    var reactions: [ReactionDTO] = []
    /// Tema del mensaje (docs/TEMAS.md). nil = sin tema o servidor anterior que no lo manda.
    var topicId: String?
    /// Quién le puso el tema (cualquiera del chat puede).
    var topicBy: String?
    var createdAt: String
    var editedAt: String?
    var deletedAt: String?

    var isSystem: Bool { kind == "system" }
    /// Mensaje de sistema estructurado ({"k": …}).
    var systemPayload: [String: Any]? {
        guard isSystem, body.hasPrefix("{"), let d = body.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
    }

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
        mergedKind = c.o("mergedKind")
        forwarded = c.o("forwarded")
        linkPreview = c.o("linkPreview")
        attachments = c.lossyArray("attachments")
        mentions = c.lossyArray("mentions")
        reactions = c.lossyArray("reactions")
        topicId = c.o("topicId")
        topicBy = c.o("topicBy")
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

// Temas del chat (docs/TEMAS.md). Aquí y no en Topics.swift: la extensión Compartir compila este archivo.
/// Tema fijo de una conversación. `archivedAt` ≠ nil = archivado (sale de la fila, sus mensajes quedan en gris).
struct TopicDTO: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var conversationId: String
    var name: String
    /// Uno de `TopicRules.colors`; un color que esta versión no conoce se pinta azul.
    var color: String
    var icon: String
    var position: Int
    var archivedAt: String?
    var createdBy: String
    var createdAt: String

    var isArchived: Bool { archivedAt != nil }

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = try c.decode(String.self, forKey: AnyKey("id"))
        conversationId = c.v("conversationId", "")
        name = c.v("name", "")
        color = c.v("color", "blue")
        icon = c.v("icon", "#")
        position = c.int("position")
        archivedAt = c.o("archivedAt")
        createdBy = c.v("createdBy", "")
        createdAt = c.v("createdAt", "")
    }

    init(id: String, conversationId: String, name: String, color: String = "blue", icon: String = "#", position: Int = 0,
         archivedAt: String? = nil, createdBy: String = "", createdAt: String = "") {
        self.id = id; self.conversationId = conversationId; self.name = name; self.color = color; self.icon = icon
        self.position = position; self.archivedAt = archivedAt; self.createdBy = createdBy; self.createdAt = createdAt
    }
}

/// `{ topics }` (GET, PATCH, DELETE) o `{ topic, topics }` (POST).
struct TopicsResult: Decodable, Sendable {
    var topic: TopicDTO?
    var topics: [TopicDTO]
    var cleared: Int?
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        topic = c.o("topic")
        topics = c.lossyArray("topics")
        cleared = c.intOpt("cleared")
    }
}

/// Vista previa de un enlace. `imageUrl` es relativa al API (/api/v1/previews/<uuid>), pública y cacheable.
struct LinkPreviewDTO: Codable, Equatable, Sendable {
    var url: String
    var title: String?
    var description: String?
    var siteName: String?
    var imageUrl: String?

    init(url: String, title: String? = nil, description: String? = nil, siteName: String? = nil, imageUrl: String? = nil) {
        self.url = url; self.title = title; self.description = description; self.siteName = siteName; self.imageUrl = imageUrl
    }

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        url = try c.decode(String.self, forKey: AnyKey("url"))
        title = c.o("title")
        description = c.o("description")
        siteName = c.o("siteName")
        imageUrl = c.o("imageUrl")
    }

    /// Sitio para mostrar: siteName o el host sin «www.».
    var host: String {
        if let s = siteName, !s.isEmpty { return s }
        let h = URL(string: url)?.host ?? url
        return h.hasPrefix("www.") ? String(h.dropFirst(4)) : h
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
    var droppedMentions: [String]
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        message = try c.decode(MessageDTO.self, forKey: AnyKey("message"))
        duplicate = c.v("duplicate", false)
        droppedMentions = c.v("droppedMentions", [])
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
    /// Grupos a los que entra la persona (API viejo: vacío).
    var groupNames: [String] = []
    /// Enlace o código para varias personas.
    var multiUse = false
    /// Invitación a un grupo interno de una empresa (se entra como invitado de fuera).
    var orgHome = false
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        groupNames = c.v("groupNames", [String]()).filter { !$0.isEmpty }
        multiUse = c.v("multiUse", false)
        orgHome = c.v("orgHome", false)
        // Invitación a una empresa (kind 'org', SPEC-invitar): sin espacio, se nombra la empresa.
        workspaceName = c.v("workspaceName", "")
        if workspaceName.isEmpty { workspaceName = c.v("orgName", "") }
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
    /// `adminIds` llega desde la migración 030; nil = servidor anterior (no cambia los admins conocidos).
    case membersChanged(conversationId: String, eventSeq: Int, memberIds: [String], adminIds: [String]? = nil)
    case issueUpdated(conversationId: String, eventSeq: Int, issue: IssueDTO)
    case pinsChanged(conversationId: String, eventSeq: Int, messageIds: [String])
    /// Temas del chat: trae la lista completa (activos y archivados) y reemplaza la local.
    case topicsChanged(conversationId: String, eventSeq: Int, topics: [TopicDTO])
    case calendarUpdated(conversationId: String, eventSeq: Int, event: CalendarEventDTO)
    case other(type: String, conversationId: String, eventSeq: Int)

    var conversationId: String {
        switch self {
        case .messageCreated(let c, _, _), .messageUpdated(let c, _, _), .membersChanged(let c, _, _, _), .issueUpdated(let c, _, _),
             .pinsChanged(let c, _, _), .topicsChanged(let c, _, _), .calendarUpdated(let c, _, _), .other(_, let c, _): return c
        }
    }
    var eventSeq: Int {
        switch self {
        case .messageCreated(_, let s, _), .messageUpdated(_, let s, _), .membersChanged(_, let s, _, _), .issueUpdated(_, let s, _),
             .pinsChanged(_, let s, _), .topicsChanged(_, let s, _), .calendarUpdated(_, let s, _), .other(_, _, let s): return s
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
            self = .membersChanged(conversationId: conv, eventSeq: seq, memberIds: c.v("memberIds", []), adminIds: c.o("adminIds")); return
        case "issue.updated":
            if let i: IssueDTO = c.o("issue") { self = .issueUpdated(conversationId: conv, eventSeq: seq, issue: i); return }
        case "pins.changed":
            self = .pinsChanged(conversationId: conv, eventSeq: seq, messageIds: c.v("messageIds", [])); return
        case "topics.changed":
            self = .topicsChanged(conversationId: conv, eventSeq: seq, topics: c.lossyArray("topics")); return
        case "calendar.updated":
            if let e: CalendarEventDTO = c.o("event") { self = .calendarUpdated(conversationId: conv, eventSeq: seq, event: e); return }
        default: break
        }
        self = .other(type: type, conversationId: conv, eventSeq: seq)
    }
}

enum AccountEvent: Decodable, Equatable, Sendable {
    case scopeChanged(reason: String)
    case readUpdated(conversationId: String, seq: Int)
    case reminderDue(ReminderDTO)
    /// Aviso de reunión (10 min antes). SPEC-v4 E.
    case eventSoon(CalendarEventDTO, minutes: Int)
    case prefsUpdated(conversationId: String?, workspaceId: String?)
    case whatsappUpdated(accountId: String)
    case driveUpdated
    /// 👀/✅ en otro dispositivo crearon o cerraron recordatorios: volver a pedir GET /reminders.
    case remindersChanged
    /// «No molestar» cambió en otra sesión (PUT /me/dnd): `{ type: "me.dnd", dndUntil }`.
    case dndChanged(until: String?)
    /// Un mensaje programado mío cambió en cualquier dispositivo (docs/PROGRAMADOS.md).
    case scheduledUpdated(ScheduledMessageDTO)
    /// Cambió mi modo sueño (desde este u otro dispositivo).
    case sleepChanged(SleepDTO)
    /// Un asunto restringido que puedo ver cambió (no viaja por la conversación; sin eventSeq).
    case issueUpdated(IssueDTO)
    /// Mi asunto personal cambió (sin conversación; solo llega a mi cuenta). Contrato 2026-09-28.
    case issuePersonal(IssueDTO)
    /// Perdí acceso a un asunto: sacarlo de la lista.
    case issueHidden(issueId: String, conversationId: String)
    case other(type: String)

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        let type: String = c.v("type", "")
        switch type {
        case "scope.changed": self = .scopeChanged(reason: c.v("reason", ""))
        case "read.updated": self = .readUpdated(conversationId: c.v("conversationId", ""), seq: c.int("seq"))
        case "reminder.due":
            if let r: ReminderDTO = c.o("reminder") { self = .reminderDue(r) } else { self = .other(type: type) }
        case "event.soon":
            if let e: CalendarEventDTO = c.o("event") { self = .eventSoon(e, minutes: c.intOpt("minutes") ?? 10) } else { self = .other(type: type) }
        case "prefs.updated": self = .prefsUpdated(conversationId: c.o("conversationId"), workspaceId: c.o("workspaceId"))
        case "whatsapp.updated": self = .whatsappUpdated(accountId: c.v("accountId", ""))
        case "drive.updated": self = .driveUpdated
        case "reminders.changed": self = .remindersChanged
        case "me.dnd": self = .dndChanged(until: c.o("dndUntil"))
        case "issue.updated":
            if let i: IssueDTO = c.o("issue") { self = .issueUpdated(i) } else { self = .other(type: type) }
        case "issue.personal":
            if let i: IssueDTO = c.o("issue") { self = .issuePersonal(i) } else { self = .other(type: type) }
        case "issue.hidden": self = .issueHidden(issueId: c.v("issueId", ""), conversationId: c.v("conversationId", ""))
        case "me.sleep":
            if let x: SleepDTO = c.o("sleep") { self = .sleepChanged(x) } else { self = .other(type: type) }
        case "scheduled.updated":
            if let x: ScheduledMessageDTO = c.o("scheduled") { self = .scheduledUpdated(x) } else { self = .other(type: type) }
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
    /// details.userIds (p. ej. side_outsider: quienes no se pueden sumar).
    var userIds: [String]
    var meetingId: String?
    struct ErrorDetail: Decodable { var path: String? }
    init(from decoder: Decoder) throws {
        let root = try container(decoder)
        let c = try root.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("error"))
        code = c.v("code", "")
        message = c.v("message", "")
        details = c.v("details", [])
        meetingId = (try? c.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("details")))?.o("meetingId")
        userIds = ((try? c.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("details")))?.v("userIds", [String]())) ?? []
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
