import Foundation

// Correo y WhatsApp en el chat (docs/CORREO.md). Modelos, parseo de los avisos del chat y reglas puras
// (filtros de la lista, CC por defecto, título de la tarea, horas para programar). Paridad con
// apps/web/src/screens/Mail.tsx y packages/client-core. Este archivo también lo compila la extensión
// Compartir (el evento en vivo `mail.updated` trae un SharedMailDTO).

/// Proveedor de correo: Gmail (google) u Outlook (microsoft). `whatsapp` solo aparece en un SharedMailDTO: un mensaje de
/// WhatsApp llevado al chat (migración 040), con hilo y tarea como un correo, pero sin responder desde chaggu.
enum MailProvider: String, Codable, CaseIterable, Sendable, Hashable, Identifiable {
    case google, microsoft, whatsapp
    var id: String { rawValue }
    var label: String { self == .google ? "Gmail" : self == .microsoft ? "Outlook" : "WhatsApp" }
    var isWhatsApp: Bool { self == .whatsapp }
    /// Pestañas de Recibidos; la primera es la de por defecto.
    var categories: [String] { self == .microsoft ? ["focused", "other", "any"] : ["primary", "updates", "promotions", "social", "forums", "any"] }
}

struct MailAddressDTO: Codable, Equatable, Hashable, Sendable {
    var name: String?
    var email: String
    init(name: String?, email: String) { self.name = name; self.email = email }
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        name = c.o("name")
        email = c.v("email", "")
    }
    /// Nombre o, si no hay, el correo.
    var display: String { (name?.isEmpty == false ? name : nil) ?? email }
    /// «Nombre <correo>» para los metadatos.
    var full: String { name?.isEmpty == false ? "\(name!) <\(email)>" : email }
}

struct MailAttachmentInfoDTO: Codable, Equatable, Hashable, Identifiable, Sendable {
    var id: String
    var name: String
    var size: Int
    var contentType: String
    init(id: String, name: String, size: Int, contentType: String) { self.id = id; self.name = name; self.size = size; self.contentType = contentType }
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = c.v("id", "")
        name = c.v("name", "")
        size = c.int("size")
        contentType = c.v("contentType", "application/octet-stream")
    }
}

struct MailConnectionDTO: Codable, Equatable, Identifiable, Sendable {
    var provider: MailProvider
    var label: String
    var available: Bool
    var unavailableReason: String?
    /// none | active | reconnect
    var status: String
    var accountEmail: String?
    var id: String { provider.rawValue }
    var isActive: Bool { status == "active" }
    init(provider: MailProvider, label: String? = nil, available: Bool, unavailableReason: String? = nil, status: String, accountEmail: String? = nil) {
        self.provider = provider; self.label = label ?? provider.label; self.available = available
        self.unavailableReason = unavailableReason; self.status = status; self.accountEmail = accountEmail
    }
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        provider = try c.decode(MailProvider.self, forKey: AnyKey("provider"))
        label = c.v("label", provider.label)
        available = c.v("available", false)
        unavailableReason = c.o("unavailableReason")
        status = c.v("status", "none")
        accountEmail = c.o("accountEmail")
    }
}

/// Fila de la lista (en vivo, no se guarda).
struct MailListItemDTO: Codable, Equatable, Identifiable, Sendable {
    var provider: MailProvider
    var id: String
    var threadId: String?
    var from: MailAddressDTO?
    var to: [MailAddressDTO]
    var subject: String
    var snippet: String
    var date: String?
    var unread: Bool
    var hasAttachments: Bool
    /// inbox | sent
    var box: String
    var isSent: Bool { box == "sent" }
    /// La otra persona: el destinatario si lo envié yo, el remitente si lo recibí.
    var other: MailAddressDTO? { isSent ? to.first : from }
    init(provider: MailProvider, id: String, from: MailAddressDTO?, to: [MailAddressDTO], subject: String, snippet: String, date: String?,
         unread: Bool = false, hasAttachments: Bool = false, box: String = "inbox") {
        self.provider = provider; self.id = id; self.from = from; self.to = to; self.subject = subject; self.snippet = snippet
        self.date = date; self.unread = unread; self.hasAttachments = hasAttachments; self.box = box
    }
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        provider = c.v("provider", .google)
        id = try c.decode(String.self, forKey: AnyKey("id"))
        threadId = c.o("threadId")
        from = c.o("from")
        to = c.lossyArray("to")
        subject = c.v("subject", "")
        snippet = c.v("snippet", "")
        date = c.o("date")
        unread = c.v("unread", false)
        hasAttachments = c.v("hasAttachments", false)
        box = c.v("box", "inbox")
    }
}

struct MailListDTO: Decodable, Equatable, Sendable {
    var items: [MailListItemDTO]
    var nextPage: String?
    var accountEmail: String?
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        items = c.lossyArray("items")
        nextPage = c.o("nextPage")
        accountEmail = c.o("accountEmail")
    }
}

/// Correo completo leído en vivo (vista previa antes de compartir).
struct MailMessageDTO: Decodable, Equatable, Sendable {
    var item: MailListItemDTO
    var cc: [MailAddressDTO]
    var body: String
    var attachments: [MailAttachmentInfoDTO]
    init(from decoder: Decoder) throws {
        item = try MailListItemDTO(from: decoder)
        let c = try container(decoder)
        cc = c.lossyArray("cc")
        body = c.v("body", "")
        attachments = c.lossyArray("attachments")
    }
}

struct SharedMailCommentDTO: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var emailId: String
    var authorId: String
    var body: String
    var createdAt: String
    init(id: String, emailId: String, authorId: String, body: String, createdAt: String) {
        self.id = id; self.emailId = emailId; self.authorId = authorId; self.body = body; self.createdAt = createdAt
    }
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = c.v("id", "")
        emailId = c.v("emailId", "")
        authorId = c.v("authorId", "")
        body = c.v("body", "")
        createdAt = c.v("createdAt", "")
    }
}

struct ScheduledReplyDTO: Codable, Equatable, Sendable {
    var id: String
    var sendAt: String
}

/// Datos del WhatsApp compartido (provider `whatsapp`).
struct SharedWaInfo: Codable, Equatable, Sendable {
    var chatName: String?
    var isGroup: Bool
    /// personal | business
    var accountKind: String
    var accountId: String
    var jid: String
    init(chatName: String?, isGroup: Bool, accountKind: String, accountId: String, jid: String) {
        self.chatName = chatName; self.isGroup = isGroup; self.accountKind = accountKind; self.accountId = accountId; self.jid = jid
    }
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        chatName = c.o("chatName")
        isGroup = c.v("isGroup", false)
        accountKind = c.v("accountKind", "personal")
        accountId = c.v("accountId", "")
        jid = c.v("jid", "")
    }
}

/// El correo que alguien llevó a un chat (la tarjeta). `body` solo llega con `?full=1`.
struct SharedMailDTO: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var conversationId: String
    var sharedBy: String
    var provider: MailProvider
    var accountEmail: String?
    /// in | out
    var direction: String
    var from: MailAddressDTO?
    var to: [MailAddressDTO]
    var cc: [MailAddressDTO]
    var subject: String
    var snippet: String
    var body: String
    var full: Bool
    /// Se guardó solo lo nuevo: el historial citado y la firma se piden aparte (GET …/original).
    var trimmed: Bool
    var sentAt: String?
    var attachments: [MailAttachmentInfoDTO]
    var messageId: String?
    var comment: String?
    /// pending | scheduled | replied
    var status: String
    var repliedAt: String?
    var repliedBy: String?
    /// Respuesta programada pendiente (solo la ve quien la programó).
    var scheduledReply: ScheduledReplyDTO?
    var issueId: String?
    var commentCount: Int
    var lastComments: [SharedMailCommentDTO]
    var createdAt: String
    var webLink: String?
    /// Solo con provider `whatsapp`.
    var wa: SharedWaInfo?
    var chagguAttachments: [AttachmentDTO] = []
    var mediaStatus: String?

    var isOut: Bool { direction == "out" }
    /// La otra persona de la tarjeta: el primer destinatario si lo envié, el remitente si lo recibí.
    var other: MailAddressDTO? { isOut ? to.first : from }

    init(id: String, conversationId: String, sharedBy: String, provider: MailProvider = .google, accountEmail: String? = nil, direction: String = "in",
         from: MailAddressDTO? = nil, to: [MailAddressDTO] = [], cc: [MailAddressDTO] = [], subject: String = "", snippet: String = "", body: String = "",
         full: Bool = false, trimmed: Bool = false, sentAt: String? = nil, attachments: [MailAttachmentInfoDTO] = [], messageId: String? = nil,
         comment: String? = nil, status: String = "pending", repliedAt: String? = nil, repliedBy: String? = nil, scheduledReply: ScheduledReplyDTO? = nil,
         issueId: String? = nil, commentCount: Int = 0, lastComments: [SharedMailCommentDTO] = [], createdAt: String = "", webLink: String? = nil) {
        self.id = id; self.conversationId = conversationId; self.sharedBy = sharedBy; self.provider = provider; self.accountEmail = accountEmail
        self.direction = direction; self.from = from; self.to = to; self.cc = cc; self.subject = subject; self.snippet = snippet; self.body = body
        self.full = full; self.trimmed = trimmed; self.sentAt = sentAt; self.attachments = attachments; self.messageId = messageId; self.comment = comment
        self.status = status; self.repliedAt = repliedAt; self.repliedBy = repliedBy; self.scheduledReply = scheduledReply; self.issueId = issueId
        self.commentCount = commentCount; self.lastComments = lastComments; self.createdAt = createdAt; self.webLink = webLink
    }

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = try c.decode(String.self, forKey: AnyKey("id"))
        conversationId = c.v("conversationId", "")
        sharedBy = c.v("sharedBy", "")
        provider = c.v("provider", .google)
        accountEmail = c.o("accountEmail")
        direction = c.v("direction", "in")
        from = c.o("from")
        to = c.lossyArray("to")
        cc = c.lossyArray("cc")
        subject = c.v("subject", "")
        snippet = c.v("snippet", "")
        body = c.v("body", "")
        full = c.v("full", false)
        trimmed = c.v("trimmed", false)
        sentAt = c.o("sentAt")
        attachments = c.lossyArray("attachments")
        messageId = c.o("messageId")
        comment = c.o("comment")
        status = c.v("status", "pending")
        repliedAt = c.o("repliedAt")
        repliedBy = c.o("repliedBy")
        scheduledReply = c.o("scheduledReply")
        issueId = c.o("issueId")
        commentCount = c.int("commentCount")
        lastComments = c.lossyArray("lastComments")
        createdAt = c.v("createdAt", "")
        webLink = c.o("webLink")
        wa = c.o("wa")
        chagguAttachments = c.lossyArray("chagguAttachments")
        mediaStatus = c.o("mediaStatus")
    }

    /// Une lo que llega (tarjeta, evento en vivo o respuesta de una acción) con lo que ya había:
    /// una tarjeta sin cuerpo no borra el cuerpo ya cargado, y el evento en vivo (que viaja sin
    /// `scheduledReply` ni `webLink`, iguales para todos) no borra los que solo ve su dueño.
    static func merge(_ incoming: SharedMailDTO, into prev: SharedMailDTO?, live: Bool = false) -> SharedMailDTO {
        guard let prev else { return incoming }
        var m = incoming
        if !m.full && prev.full { m.body = prev.body; m.full = true }
        if live {
            m.scheduledReply = m.status == "scheduled" ? prev.scheduledReply : nil
            m.webLink = prev.webLink
        }
        return m
    }
}

/// Respuesta de compartir: {emails:[…]} (varios chats) o, en servidores anteriores, un SharedMailDTO o {message}.
enum MailShareResult {
    static func decode(_ data: Data) -> [SharedMailDTO] {
        struct Many: Decodable { var emails: [SharedMailDTO]? }
        if let m = try? JSONDecoder().decode(Many.self, from: data), let e = m.emails { return e }
        if let one = try? JSONDecoder().decode(SharedMailDTO.self, from: data) { return [one] }
        return []
    }
}

// MARK: - Avisos del chat

/// Mensaje de sistema «wa.shared»: un mensaje de WhatsApp comentado en chaggu.
struct WaSharedPayload: Equatable, Sendable {
    var accountId: String
    var jid: String
    var waMessageId: String
    /// personal | business
    var accountKind: String
    var chatName: String?
    var isGroup: Bool
    var author: String?
    var fromMe: Bool
    var text: String
    var sentAt: String?
    var comment: String?
    /// Desde la 040 el mensaje compartido tiene registro propio (SharedMailDTO con hilo y tarea); los viejos no.
    var emailId: String? = nil
    var forwardedFrom: String? = nil
}

/// Franja de comentarios agrupados (`mail.comments`).
struct MailCommentsInfo: Equatable, Sendable { var count: Int; var lastById: String?; var lastByName: String; var lastExcerpt: String; var title = "" }

/// Qué dibuja un mensaje de sistema de correo o WhatsApp.
enum MailChatKind: Equatable {
    /// `forwardedFrom`: la conversación de donde se reenvió (POST /mail/shared/:id/forward).
    case shared(emailId: String, comment: String?, forwardedFrom: String? = nil)
    /// Aviso agrupado de comentarios: una línea que abre el hilo. `provider` elige el icono (✉ o WhatsApp).
    case comments(emailId: String, MailCommentsInfo, provider: String?)
    case replied(emailId: String)
    case replyFailed(emailId: String)
    case waShared(WaSharedPayload)

    var emailId: String? {
        switch self {
        case .shared(let id, _, _), .comments(let id, _, _), .replied(let id), .replyFailed(let id): return id
        case .waShared(let p): return p.emailId
        }
    }

    static func parse(_ p: [String: Any]?) -> MailChatKind? {
        guard let p, let k = p["k"] as? String, k.hasPrefix("mail.") || k.hasPrefix("wa.") else { return nil }
        func str(_ key: String) -> String? { (p[key] as? String).flatMap { $0.isEmpty ? nil : $0 } }
        switch k {
        case "mail.shared": return str("emailId").map { .shared(emailId: $0, comment: str("comment"), forwardedFrom: str("forwardedFrom")) }
        case "mail.comments":
            guard let id = str("emailId") else { return nil }
            let n = (p["count"] as? NSNumber)?.intValue ?? Int(str("count") ?? "") ?? 1
            return .comments(emailId: id, .init(count: max(1, n), lastById: str("lastById"), lastByName: str("lastByName") ?? "", lastExcerpt: str("lastExcerpt") ?? "",
                                                title: str("title") ?? ""), provider: str("provider"))
        case "mail.replied": return str("emailId").map { .replied(emailId: $0) }
        case "mail.reply_failed": return str("emailId").map { .replyFailed(emailId: $0) }
        case "wa.shared":
            guard let text = p["text"] as? String else { return nil }
            return .waShared(.init(accountId: str("accountId") ?? "", jid: str("jid") ?? "", waMessageId: str("waMessageId") ?? "",
                                   accountKind: str("accountKind") ?? "personal", chatName: str("chatName"), isGroup: (p["isGroup"] as? Bool) ?? false,
                                   author: str("author"), fromMe: (p["fromMe"] as? Bool) ?? false, text: text, sentAt: str("sentAt"), comment: str("comment"),
                                   emailId: str("emailId"), forwardedFrom: str("forwardedFrom")))
        default: return nil
        }
    }
}

// MARK: - Filtros de la lista

/// Rango de fechas de los filtros (Hoy, 7 días, 30 días, Este año, Más de un año o Entre fechas).
enum MailDateRange: String, CaseIterable, Sendable {
    case today, week = "7", month = "30", year, older, custom
}

/// Filtros de la lista: van tal cual al proveedor (GET /mail/messages); nada se guarda.
struct MailFilters: Equatable, Sendable {
    /// inbox | sent | all
    var box = "inbox"
    var q = ""
    var from = ""
    var to = ""
    /// yyyy-MM-dd
    var after = ""
    var before = ""
    var attachments = false
    var unread = false
    var label = ""
    var range: MailDateRange?
    /// Pestaña elegida a mano (nil = la de por defecto, o «any» al buscar).
    var category: String?

    /// Hay búsqueda o algún filtro (el encabezado dice «N resultados»).
    var filtered: Bool { !q.isEmpty || !from.isEmpty || !to.isEmpty || !after.isEmpty || !before.isEmpty || attachments || unread || !label.isEmpty }

    /// Pestaña efectiva: solo en Recibidos. Por defecto Principal/Prioritarios; al buscar, todas, salvo que se haya elegido una.
    func effectiveCategory(_ p: MailProvider) -> String? {
        guard box == "inbox" else { return nil }
        if let category { return category }
        return !q.isEmpty || !from.isEmpty || !to.isEmpty || !label.isEmpty ? "any" : p.categories[0]
    }

    func queryItems(_ p: MailProvider, page: String? = nil, fresh: Bool = false) -> [URLQueryItem] {
        var out = [URLQueryItem(name: "provider", value: p.rawValue), URLQueryItem(name: "box", value: box)]
        if let c = effectiveCategory(p) { out.append(.init(name: "category", value: c)) }
        for (k, v) in [("q", q), ("from", from), ("to", to), ("after", after), ("before", before), ("label", label)] where !v.isEmpty {
            out.append(.init(name: k, value: v))
        }
        if attachments { out.append(.init(name: "attachments", value: "1")) }
        if unread { out.append(.init(name: "unread", value: "1")) }
        if let page, !page.isEmpty { out.append(.init(name: "page", value: page)) }
        if fresh { out.append(.init(name: "fresh", value: "1")) }
        return out
    }

    /// Ruta con la consulta; `+` se codifica (los tokens de página de Gmail lo traen).
    func path(_ p: MailProvider, page: String? = nil, fresh: Bool = false) -> String {
        var c = URLComponents()
        c.queryItems = queryItems(p, page: page, fresh: fresh)
        let q = (c.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B")
        return "/mail/messages?\(q)"
    }

    /// Aplica un rango rápido (como el menú Fecha de la web).
    mutating func setRange(_ r: MailDateRange?, now: Date = Date(), calendar: Calendar = .current) {
        let today = calendar.startOfDay(for: now)
        func back(_ days: Int) -> String { MailText.ymd(calendar.date(byAdding: .day, value: -days, to: today) ?? today, calendar) }
        range = r
        switch r {
        case .today: after = back(0); before = ""
        case .week: after = back(7); before = ""
        case .month: after = back(30); before = ""
        case .year: after = "\(calendar.component(.year, from: now))-01-01"; before = ""
        case .older: after = ""; before = back(365)
        case .custom: break
        case nil: after = ""; before = ""
        }
    }

    /// Limpiar la búsqueda: se conserva la carpeta.
    mutating func clear() { self = MailFilters(box: box) }
}

// MARK: - Reglas de texto y tiempo

enum MailText {
    /// Cómo se cita la tarjeta de un correo o un WhatsApp compartido al responderla (como cardQuote de la web):
    /// «✉ asunto · remitente» o «WhatsApp · chat: texto». Tolera el cuerpo cortado a 140 caracteres. nil si no es una tarjeta.
    static func cardQuote(kind: String, body: String) -> String? {
        guard kind == "system", body.hasPrefix("{\"k\":\"mail.shared\"") || body.hasPrefix("{\"k\":\"wa.shared\"") else { return nil }
        let p: [String: Any]? = (body.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? L10n.lenientSystemObject(body)
        guard let p, let k = p["k"] as? String else { return nil }
        func s(_ key: String) -> String? { (p[key] as? String).flatMap { $0.isEmpty ? nil : $0 } }
        if k == "mail.shared" { return "✉ " + (s("subject") ?? L("mail.noSubject")) + (s("from").map { " · \($0)" } ?? "") }
        if k == "wa.shared" { return "WhatsApp" + (s("chatName").map { " · \($0)" } ?? "") + ": " + (s("text") ?? "") }
        return nil
    }

    /// Texto para citar cualquier mensaje: la tarjeta como arriba, un aviso de sistema con su texto (nunca JSON) o el cuerpo.
    static func quoteText(kind: String, body: String) -> String {
        if let q = cardQuote(kind: kind, body: body) { return q }
        return kind == "system" ? L10n.systemText(body) : body
    }

    static func ymd(_ d: Date, _ calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: d)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// «12 KB» / «1.4 MB».
    static func size(_ n: Int) -> String {
        n >= 1024 * 1024 ? String(format: "%.1f MB", Double(n) / 1024 / 1024) : "\(max(1, Int((Double(n) / 1024).rounded()))) KB"
    }

    /// Quita RE:/RV:/FW:/FWD:/AW: del principio del asunto.
    static func stripPrefixes(_ subject: String) -> String {
        subject.replacingOccurrences(of: #"^\s*((re|rv|fw|fwd|aw)\s*:\s*)+"#, with: "", options: [.regularExpression, .caseInsensitive])
    }

    /// Título por defecto de la tarea: «Responder a Jorge: asunto» (recibido) o el asunto (enviado). Máx. 200.
    static func taskTitle(_ e: SharedMailDTO, prefix: String) -> String {
        let t = e.isOut ? e.subject : "\(prefix) \(e.from?.display.split(separator: " ").first.map(String.init) ?? ""): \(stripPrefixes(e.subject))"
        return String(t.prefix(200))
    }

    /// A quién sale la respuesta: los mismos destinatarios si lo envié yo, el remitente si lo recibí.
    static func replyTo(_ e: SharedMailDTO) -> [MailAddressDTO] { e.isOut ? e.to : (e.from.map { [$0] } ?? []) }

    /// CC por defecto: todos (Para + CC) menos yo y el destinatario, sin repetir.
    static func defaultCc(_ e: SharedMailDTO) -> [String] {
        let me = (e.accountEmail ?? "").lowercased()
        let to = Set(replyTo(e).map { $0.email.lowercased() })
        var seen = Set<String>(), out: [String] = []
        for a in e.to + e.cc {
            let x = a.email.lowercased()
            guard x != me, !to.contains(x), seen.insert(x).inserted else { continue }
            out.append(a.email)
        }
        return out
    }

    static func parseCc(_ s: String) -> [String] {
        s.split(whereSeparator: { ",; \n\t".contains($0) }).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
    static func validEmail(_ s: String) -> Bool { s.range(of: #"^[^@\s]+@[^@\s]+\.[^@\s]+$"#, options: .regularExpression) != nil }

    /// Programar envío: En 1 hora, En 3 horas, Mañana a las 9:00, El lunes a las 9:00 (el próximo lunes).
    enum Quick: String, CaseIterable { case in1h, in3h, tomorrow9, monday9 }
    static func quickDate(_ q: Quick, now: Date = Date(), calendar: Calendar = .current) -> Date {
        switch q {
        case .in1h: return now.addingTimeInterval(3600)
        case .in3h: return now.addingTimeInterval(3 * 3600)
        case .tomorrow9:
            let d = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)) ?? now
            return calendar.date(bySettingHour: 9, minute: 0, second: 0, of: d) ?? d
        case .monday9:
            var d = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)) ?? now
            while calendar.component(.weekday, from: d) != 2 { d = calendar.date(byAdding: .day, value: 1, to: d) ?? d }
            return calendar.date(bySettingHour: 9, minute: 0, second: 0, of: d) ?? d
        }
    }
}

// MARK: - Vuelta de conectar el correo

/// chaggu://mail/connected?mail=1&provider=…&receipt=… (o &error=…). La URL es solo un recibo: nunca conecta nada sola.
enum MailCallback: Equatable {
    case receipt(MailProvider, String)
    case connected(MailProvider?)
    case failed(MailProvider?, code: String)

    static let schemes: Set<String> = ["chaggu", "tiecoms"]
    static func isMail(_ url: URL) -> Bool {
        url.scheme.map { schemes.contains($0.lowercased()) } == true && url.host?.lowercased() == "mail"
    }
    static func parse(_ url: URL) -> MailCallback? {
        guard isMail(url), url.pathComponents.filter({ $0 != "/" }).first == "connected" else { return nil }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard Set(items.map(\.name)).count == items.count else { return .failed(nil, code: "invalid_callback") }
        let q = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        let p = q["provider"].flatMap(MailProvider.init(rawValue:))
        if let e = q["error"], !e.isEmpty { return .failed(p, code: e) }
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        guard let p, let receipt = q["receipt"], receipt.count >= 32, receipt.count <= 64,
              receipt.unicodeScalars.allSatisfy(allowed.contains) else { return .failed(p, code: "invalid_callback") }
        return .receipt(p, receipt)
    }
}
