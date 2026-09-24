import Foundation

/// Funciones de paridad con la web (packages/client-core): edición, fijados,
/// preferencias, asuntos, agenda, recordatorios, bifurcaciones, dominios,
/// WhatsApp y eliminación de la cuenta.
extension AppStore {
    private func enc(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? s }

    // MARK: Mensajes

    func editMessage(_ id: String, body: String) async throws {
        let m: MessageDTO = try await api.request("/messages/\(id)", method: "PATCH", json: ["body": body])
        upsertLocal(m)
    }

    func deleteMessage(_ id: String) async throws {
        let m: MessageDTO = try await api.request("/messages/\(id)", method: "DELETE")
        upsertLocal(m)
    }

    struct PinIds: Decodable { var messageIds: [String]; init(from d: Decoder) throws { messageIds = (try container(d)).v("messageIds", []) } }

    func setMessagePinned(_ m: MessageDTO, _ pinned: Bool) async throws {
        let r: PinIds = try await api.request("/messages/\(m.id)/pin", method: pinned ? "POST" : "DELETE")
        pins[m.conversationId] = r.messageIds
    }

    @discardableResult
    func loadPins(_ conversationId: String) async throws -> [MessageDTO] {
        let r: ListOf<MessageDTO> = try await api.request("/conversations/\(conversationId)/pins")
        pins[conversationId] = r.items.map(\.id)
        return r.items
    }

    struct LastRead: Decodable { var lastReadSeq: Int; init(from d: Decoder) throws { lastReadSeq = (try container(d)).int("lastReadSeq") } }

    func markUnread(_ conversationId: String, seq: Int) async throws {
        let r: LastRead = try await api.request("/conversations/\(conversationId)/unread", method: "POST", json: ["seq": seq])
        patchMeta(conversationId) { $0.lastReadSeq = r.lastReadSeq; $0.unread = max(0, $0.lastMessageSeq - max(r.lastReadSeq, $0.historyFromSeq)) }
    }

    func markConversationRead(_ conversationId: String) async throws {
        guard let c = meta(conversationId) else { return }
        patchMeta(conversationId) { $0.lastReadSeq = c.lastMessageSeq; $0.unread = 0 }
        try await api.requestData("/conversations/\(conversationId)/read", method: "POST", json: ["seq": c.lastMessageSeq])
    }

    // MARK: Preferencias

    /// Fijar arriba y silenciar (mutedUntil = nil reactiva). Optimista; el servidor confirma con prefs.updated.
    func setConversationPrefs(_ id: String, pinned: Bool? = nil, mutedUntil: Date?? = nil) async throws {
        var body: [String: Any] = [:]
        if let pinned { body["pinned"] = pinned }
        if let mutedUntil { body["mutedUntil"] = mutedUntil.map { ISODate.string($0) } ?? NSNull() }
        patchMeta(id) {
            if let pinned { $0.pinnedAt = pinned ? ISODate.string() : nil }
            if let mutedUntil { $0.mutedUntil = mutedUntil.map { ISODate.string($0) } }
        }
        try await api.requestData("/conversations/\(id)/prefs", method: "PUT", json: body)
    }

    func setWorkspacePinned(_ id: String, _ pinned: Bool) async throws {
        patchWorkspace(id) { $0.pinnedAt = pinned ? ISODate.string() : nil }
        try await api.requestData("/workspaces/\(id)/prefs", method: "PUT", json: ["pinned": pinned])
    }

    static func muteUntil(_ option: MuteOption, now: Date = Date()) -> Date {
        switch option {
        case .hour: return now.addingTimeInterval(3600)
        case .eightHours: return now.addingTimeInterval(8 * 3600)
        case .week: return now.addingTimeInterval(7 * 86400)
        case .forever: return ISODate.parse("2099-12-31T00:00:00.000Z")!
        }
    }

    // MARK: Recordatorios

    func loadReminders() async throws {
        let r: ListOf<ReminderDTO> = try await api.request("/reminders")
        reminders = r.items.sorted { $0.remindAt < $1.remindAt }
    }

    @discardableResult
    func createReminder(conversationId: String, messageId: String?, note: String?, at: Date) async throws -> ReminderDTO {
        var body: [String: Any] = ["conversationId": conversationId, "remindAt": ISODate.string(at)]
        body["messageId"] = messageId ?? NSNull()
        body["note"] = note.map { String($0.prefix(300)) } ?? NSNull()
        let r: ReminderDTO = try await api.request("/reminders", method: "POST", json: body)
        reminders = (reminders + [r]).sorted { $0.remindAt < $1.remindAt }
        return r
    }

    func completeReminder(_ id: String) async throws {
        try await api.requestData("/reminders/\(id)/done", method: "POST", json: [:])
        reminders.removeAll { $0.id == id }
    }

    func snoozeReminder(_ id: String, until: Date) async throws {
        try await api.requestData("/reminders/\(id)/snooze", method: "POST", json: ["until": ISODate.string(until)])
        reminders = reminders.map { r in
            guard r.id == id else { return r }
            var x = r; x.remindAt = ISODate.string(until); x.firedAt = nil; return x
        }.sorted { $0.remindAt < $1.remindAt }
    }

    // MARK: Asuntos

    @discardableResult
    func loadIssues(workspaceId: String? = nil, conversationId: String? = nil, mine: Bool = false, open: Bool = false) async throws -> [IssueDTO] {
        var q: [String] = []
        if let workspaceId { q.append("workspaceId=\(workspaceId)") }
        if let conversationId { q.append("conversationId=\(conversationId)") }
        if mine { q.append("mine=1") }
        if open { q.append("open=1") }
        let r: ListOf<IssueDTO> = try await api.request("/issues?\(q.joined(separator: "&"))")
        for i in r.items { issues[i.id] = i }
        return r.items
    }

    @discardableResult
    func createIssue(conversationId: String, title: String, ownerId: String?, dueDate: String?, originMessageId: String?) async throws -> IssueDTO {
        let body: [String: Any] = ["title": title, "ownerId": ownerId ?? NSNull(), "dueDate": dueDate ?? NSNull(), "originMessageId": originMessageId ?? NSNull()]
        let i: IssueDTO = try await api.request("/conversations/\(conversationId)/issues", method: "POST", json: body)
        issues[i.id] = i
        recountIssues(conversationId)
        return i
    }

    @discardableResult
    func updateIssue(_ id: String, _ patch: [String: Any]) async throws -> IssueDTO {
        let i: IssueDTO = try await api.request("/issues/\(id)", method: "PATCH", json: patch)
        issues[i.id] = i
        recountIssues(i.conversationId)
        return i
    }

    func issueDetail(_ id: String) async throws -> IssueDetail {
        let r: IssueDetail = try await api.request("/issues/\(id)")
        issues[r.issue.id] = r.issue
        return r
    }

    func commentIssue(_ id: String, body: String) async throws {
        let i: IssueDTO = try await api.request("/issues/\(id)/comments", method: "POST", json: ["body": body])
        issues[i.id] = i
    }

    // MARK: Agenda

    @discardableResult
    func loadEvents(from: Date, to: Date, conversationId: String? = nil) async throws -> [CalendarEventDTO] {
        var q = "from=\(ISODate.string(from).addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")&to=\(ISODate.string(to).addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")"
        if let conversationId { q += "&conversationId=\(conversationId)" }
        let r: ListOf<CalendarEventDTO> = try await api.request("/events?\(q)")
        for e in r.items { events[e.id] = e }
        return r.items
    }

    func loadEvent(_ id: String) async throws -> CalendarEventDTO {
        let e: CalendarEventDTO = try await api.request("/events/\(id)")
        events[e.id] = e
        return e
    }

    @discardableResult
    func createEvent(conversationId: String, _ input: [String: Any]) async throws -> CalendarEventDTO {
        let e: CalendarEventDTO = try await api.request("/conversations/\(conversationId)/events", method: "POST", json: input)
        events[e.id] = e
        return e
    }

    @discardableResult
    func updateEvent(_ id: String, _ patch: [String: Any]) async throws -> CalendarEventDTO {
        let e: CalendarEventDTO = try await api.request("/events/\(id)", method: "PATCH", json: patch)
        events[e.id] = e
        return e
    }

    @discardableResult
    func cancelEvent(_ id: String) async throws -> CalendarEventDTO {
        let e: CalendarEventDTO = try await api.request("/events/\(id)", method: "DELETE")
        events[e.id] = e
        return e
    }

    @discardableResult
    func rsvp(_ id: String, _ answer: Rsvp) async throws -> CalendarEventDTO {
        let e: CalendarEventDTO = try await api.request("/events/\(id)/rsvp", method: "POST", json: ["rsvp": answer.rawValue])
        events[e.id] = e
        return e
    }

    // MARK: Bifurcaciones

    struct IdResult: Decodable { var id: String; init(from d: Decoder) throws { id = (try container(d)).v("id", "") } }
    struct ReturnOut: Decodable {
        var parentId: String; var messageId: String
        init(from d: Decoder) throws { let c = (try container(d)); parentId = c.v("parentId", ""); messageId = c.v("messageId", "") }
    }

    func derive(_ conversationId: String, messageId: String, kind: String, name: String?, reason: String?) async throws -> String {
        var body: [String: Any] = ["messageId": messageId, "kind": kind]
        if let name, !name.isEmpty { body["name"] = name }
        if let reason, !reason.isEmpty { body["reason"] = reason }
        let r: IdResult = try await api.request("/conversations/\(conversationId)/derive", method: "POST", json: body)
        try await loadBootstrap()
        return r.id
    }

    func returnResult(_ conversationId: String, summary: String) async throws -> String {
        let r: ReturnOut = try await api.request("/conversations/\(conversationId)/return", method: "POST", json: ["summary": summary])
        try await loadBootstrap()
        return r.parentId
    }

    /// Reenvía un mensaje a otra conversación conservando autor y origen.
    func forward(_ source: MessageDTO, to target: String, comment: String?) {
        guard let d = data else { return }
        if let comment, !comment.trimmingCharacters(in: .whitespaces).isEmpty { send(target, body: comment) }
        let author = Naming.person(d, source.authorId)?.name
        send(target, body: source.body, forwarded: ForwardedInfo(source: .tiecoms, author: author, sentAt: source.createdAt, fromConversationId: source.conversationId))
    }

    // MARK: Dominios de empresa

    func listDomains(_ orgId: String) async throws -> [OrgDomainDTO] {
        let r: ListOf<OrgDomainDTO> = try await api.request("/organizations/\(orgId)/domains")
        return r.items
    }

    func addDomain(_ orgId: String, _ domain: String) async throws -> OrgDomainDTO {
        try await api.request("/organizations/\(orgId)/domains", method: "POST", json: ["domain": domain])
    }

    func verifyDomain(_ orgId: String, _ domain: String) async throws -> OrgDomainDTO {
        try await api.request("/organizations/\(orgId)/domains/\(enc(domain))/verify", method: "POST", json: [:])
    }

    // MARK: WhatsApp

    func waAccounts() async throws -> (accounts: [WaAccountDTO], max: Int) {
        let r: ListOf<WaAccountDTO> = try await api.request("/whatsapp/accounts")
        return (r.items, r.max ?? 5)
    }

    func waCreate(label: String, kind: String, pairPhone: String?) async throws -> WaAccountDTO {
        try await api.request("/whatsapp/accounts", method: "POST", json: ["label": label, "kind": kind, "pairPhone": pairPhone ?? NSNull()])
    }

    func waRelink(_ id: String, pairPhone: String?) async throws -> WaAccountDTO {
        try await api.request("/whatsapp/accounts/\(id)/relink", method: "POST", json: ["pairPhone": pairPhone ?? NSNull()])
    }

    func waRemove(_ id: String) async throws {
        try await api.requestData("/whatsapp/accounts/\(id)", method: "DELETE")
    }

    func waChats(accountId: String?, category: WaCategory?, onlyGroups: Bool, showHidden: Bool, query: String) async throws -> WaChatsPage {
        var q: [String] = []
        if let accountId { q.append("accountId=\(accountId)") }
        if let category { q.append("category=\(category.rawValue)") }
        if onlyGroups { q.append("groups=1") }
        if showHidden { q.append("hidden=1") }
        let t = query.trimmingCharacters(in: .whitespaces)
        if !t.isEmpty { q.append("q=\(t.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")") }
        return try await api.request("/whatsapp/chats?\(q.joined(separator: "&"))")
    }

    func waPatchChat(_ c: WaChatDTO, _ patch: [String: Any]) async throws -> WaChatDTO {
        try await api.request("/whatsapp/chats/\(c.accountId)/\(enc(c.jid))", method: "PATCH", json: patch)
    }

    func waMessages(_ c: WaChatDTO) async throws -> [WaMessageDTO] {
        let r: ListOf<WaMessageDTO> = try await api.request("/whatsapp/chats/\(c.accountId)/\(enc(c.jid))/messages?limit=80")
        return r.items
    }

    struct Organized: Decodable { var changed: Int; init(from d: Decoder) throws { changed = (try container(d)).int("changed") } }

    func waOrganize() async throws -> Int {
        let r: Organized = try await api.request("/whatsapp/organize", method: "POST", json: [:])
        return r.changed
    }

    // MARK: Cuenta

    /// DELETE /api/v1/account {confirmEmail, password?}. 400: el correo no coincide; 403: contraseña incorrecta o requerida.
    func deleteAccount(confirmEmail: String, password: String?) async throws {
        var body: [String: Any] = ["confirmEmail": confirmEmail.trimmingCharacters(in: .whitespacesAndNewlines)]
        if let password, !password.isEmpty { body["password"] = password }
        try await api.requestData("/account", method: "DELETE", json: body)
        await signOutLocally()
    }
}

enum MuteOption: CaseIterable { case hour, eightHours, week, forever
    var labelKey: String { ["mute.1h", "mute.8h", "mute.week", "mute.forever"][MuteOption.allCases.firstIndex(of: self)!] }
}

/// Tiempos rápidos de "Recordarme" (como quickTimes() de la web).
enum QuickTimes {
    struct Option: Identifiable { var key: String; var labelKey: String; var date: Date; var id: String { key } }

    static func list(now: Date = Date(), calendar: Calendar = .current) -> [Option] {
        func at9(_ days: Int) -> Date {
            let d = calendar.date(byAdding: .day, value: days, to: now)!
            return calendar.date(bySettingHour: 9, minute: 0, second: 0, of: d)!
        }
        // Días hasta el próximo lunes (1..7), igual que la web: ((8 - getDay()) % 7) || 7.
        let weekday = calendar.component(.weekday, from: now) - 1 // 0 = domingo
        let toMonday = ((8 - weekday) % 7) == 0 ? 7 : (8 - weekday) % 7
        return [
            Option(key: "20m", labelKey: "when.20m", date: now.addingTimeInterval(20 * 60)),
            Option(key: "1h", labelKey: "when.1h", date: now.addingTimeInterval(3600)),
            Option(key: "3h", labelKey: "when.3h", date: now.addingTimeInterval(3 * 3600)),
            Option(key: "tomorrow", labelKey: "when.tomorrow", date: at9(1)),
            Option(key: "monday", labelKey: "when.monday", date: at9(toMonday)),
        ]
    }
}
