import Foundation

/// Funciones de paridad con la web (packages/client-core): edición, fijados,
/// preferencias, asuntos, agenda, recordatorios, bifurcaciones, dominios,
/// WhatsApp y eliminación de la cuenta.
extension AppStore {
    private func enc(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? s }

    // MARK: Seguridad

    struct BlockedUsers: Decodable { let userIds: [String] }

    func loadBlockedUsers() async throws {
        let result: BlockedUsers = try await api.request("/blocks")
        blockedUserIds = Set(result.userIds)
    }

    func setUserBlocked(_ userId: String, blocked: Bool) async throws {
        try await api.requestData("/blocks/\(enc(userId))", method: blocked ? "PUT" : "DELETE")
        if blocked { blockedUserIds.insert(userId) } else { blockedUserIds.remove(userId) }
    }

    func reportContent(userId: String? = nil, messageId: String? = nil, reason: String) async throws {
        var body: [String: Any] = ["reason": reason.trimmingCharacters(in: .whitespacesAndNewlines)]
        if let userId { body["userId"] = userId }
        if let messageId { body["messageId"] = messageId }
        try await api.requestData("/reports", method: "POST", json: body)
    }

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

    nonisolated static func muteUntil(_ option: MuteOption, now: Date = Date()) -> Date {
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
    /// Va por la cola persistente (`send`): cada envío tiene su clientMessageId y los reintentos lo reutilizan.
    func forward(_ source: MessageDTO, to target: String, comment: String?) {
        guard let d = data else { return }
        if let comment, !comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { send(target, body: comment) }
        let author = Naming.person(d, source.authorId)?.name
        send(target, body: source.body, forwarded: ForwardedInfo(source: .tiecoms, author: author, sentAt: source.createdAt, fromConversationId: source.conversationId))
    }

    /// Reenvío a varios chats (hasta 10, como la web). Devuelve cuántos destinos quedaron en cola.
    @discardableResult
    func forward(_ source: MessageDTO, to targets: [String], comment: String?) -> Int {
        let list = Array(targets.prefix(AppStore.maxForwardTargets))
        for t in list { forward(source, to: t, comment: comment) }
        return list.count
    }

    nonisolated static let maxForwardTargets = 10

    // MARK: Chats (directos y grupales entre empresas)

    /// POST /chats: con una persona devuelve el directo (existente o nuevo); con varias, un chat `multi`.
    /// Recarga el snapshot para que el chat ya esté en la lista al abrirlo.
    @discardableResult
    func createChat(userIds: [String], name: String?) async throws -> CreateChatResult {
        var body: [String: Any] = ["userIds": userIds]
        let n = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if userIds.count > 1, n.count >= 2 { body["name"] = String(n.prefix(120)) }
        let r: CreateChatResult = try await api.request("/chats", method: "POST", json: body)
        try await loadBootstrap()
        return r
    }

    // MARK: Push

    /// PUT /push/token {provider:'apns', token, environment, lang} (reemplaza el token anterior de la sesión).
    func registerPushToken(_ hex: String) async {
        guard status == .ready else { return }
        do {
            try await api.requestData("/push/token", method: "PUT",
                                      json: ["provider": "apns", "token": hex, "environment": PushEnvironment.current, "lang": L10n.lang])
            registeredPushToken = hex
        } catch { NSLog("[TieComs] no se pudo registrar el token push: \(error)") }
    }

    func unregisterPush() async {
        guard registeredPushToken != nil || PushRegistration.token != nil, api.accessToken != nil else { return }
        _ = try? await api.requestData("/push/token", method: "DELETE")
        registeredPushToken = nil
    }

    /// Acción «Responder» de la notificación: arranca la sesión si hace falta y envía por HTTP.
    func replyFromNotification(_ conversationId: String, text: String) async {
        if status != .ready { await start() }
        guard status == .ready else { return }
        let body: [String: Any] = ["clientMessageId": UUID().uuidString.lowercased(), "body": String(text.prefix(8000))]
        if let r: SendResult = try? await api.request("/conversations/\(conversationId)/messages", method: "POST", json: body) {
            upsertLocal(r.message)
            try? await markConversationRead(conversationId)
        }
    }

    func markReadFromNotification(_ conversationId: String) async {
        if status != .ready { await start() }
        guard status == .ready else { return }
        try? await loadBootstrap()
        try? await markConversationRead(conversationId)
        AppFeedback.shared.clearNotifications(conversationId: conversationId)
    }

    // MARK: Conversaciones laterales

    /// POST /conversations/:id/side → la lateral (multi privada que cuelga del mensaje).
    /// 403 side_outsider trae en `userIds` a quienes no se pueden sumar.
    func createSide(_ conversationId: String, messageId: String, userIds: [String], question: String?) async throws -> String {
        var body: [String: Any] = ["messageId": messageId, "userIds": userIds]
        if let q = question?.trimmingCharacters(in: .whitespacesAndNewlines), !q.isEmpty { body["question"] = String(q.prefix(4000)) }
        let r: IdResult = try await api.request("/conversations/\(conversationId)/side", method: "POST", json: body)
        try await loadBootstrap()
        return r.id
    }

    /// Carga hacia atrás hasta tener el mensaje con ese seq (ensureMessage de la web). Devuelve su id.
    func ensureMessage(_ conversationId: String, seq: Int) async -> String? {
        try? await openConversation(conversationId)
        for _ in 0..<40 {
            guard let c = conversations[conversationId], c.loaded else { return nil }
            if let m = c.messages.first(where: { $0.seq == seq }) { return m.id }
            if !c.hasMore || (c.messages.first?.seq ?? 0) <= seq { return nil }
            await loadOlder(conversationId)
        }
        return nil
    }

    /// Laterales visibles para mí que cuelgan de un mensaje.
    func sides(of messageId: String) -> [ConversationDTO] {
        (data?.conversations ?? []).filter { Naming.isSide($0) && $0.parentMessageId == messageId }
            .sorted { ($0.lastMessageAt ?? "") > ($1.lastMessageAt ?? "") }
    }

    /// Candidatos para una lateral: miembros del origen + colegas de mis empresas (sin mí, solo humanos).
    func sideCandidates(_ conversationId: String) -> (members: [PersonDTO], colleagues: [PersonDTO]) {
        guard let d = data, let c = meta(conversationId) else { return ([], []) }
        let myOrgs = Set(d.organizations.filter { $0.myRole != nil }.map(\.id)).union([d.me.primaryOrgId].compactMap { $0 })
        let members = Set(c.memberIds)
        let byName: (PersonDTO, PersonDTO) -> Bool = { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        let m = d.people.filter { members.contains($0.id) && $0.id != d.me.id && $0.kind == "human" }.sorted(by: byName)
        let col = d.people.filter { !members.contains($0.id) && $0.id != d.me.id && $0.kind == "human" && ($0.orgId.map(myOrgs.contains) ?? false) }.sorted(by: byName)
        return (m, col)
    }

    /// Nuevo espacio con un cliente. Devuelve el grupo general para abrirlo.
    struct CreatedWorkspace: Decodable {
        var id: String; var generalConversationId: String?
        init(from d: Decoder) throws { let c = try container(d); id = c.v("id", ""); generalConversationId = c.o("generalConversationId") }
    }

    func createWorkspace(name: String, department: String) async throws -> String? {
        var body: [String: Any] = ["name": name]
        let dep = department.trimmingCharacters(in: .whitespaces)
        if !dep.isEmpty { body["department"] = dep }
        let r: CreatedWorkspace = try await api.request("/workspaces", method: "POST", json: body)
        try await loadBootstrap()
        return r.generalConversationId
    }

    /// Responder en privado: abre (o crea) el directo con el autor y deja la cita lista sobre el compositor.
    /// El envío lleva `forwarded {source:'tiecoms', author, sentAt, fromConversationId, messageId}`.
    @discardableResult
    func startPrivateReply(to m: MessageDTO) async throws -> String {
        guard let d = data, m.authorId != d.me.id else { throw ApiRequestError(status: 400, code: "bad_request", message: "") }
        let r = try await createChat(userIds: [m.authorId], name: nil)
        privateReplies[r.id] = PrivateReplyDraft(conversationId: r.id, fromConversationId: m.conversationId, messageId: m.id,
                                                 author: Naming.person(d, m.authorId)?.name, sentAt: m.createdAt, excerpt: String(m.body.prefix(200)))
        navigate(to: .conversation(r.id))
        return r.id
    }

    /// Envía el texto como respuesta en privado (y limpia la cita).
    func sendPrivateReply(_ draft: PrivateReplyDraft, body: String) {
        send(draft.conversationId, body: body, forwarded: ForwardedInfo(source: .tiecoms, author: draft.author, sentAt: draft.sentAt,
                                                                        fromConversationId: draft.fromConversationId, messageId: draft.messageId))
        privateReplies[draft.conversationId] = nil
    }

    /// Suma personas a una conversación; ven desde ahora (history 'now').
    func addMembers(_ conversationId: String, userIds: [String]) async throws {
        try await api.requestData("/conversations/\(conversationId)/members", method: "POST", json: ["userIds": userIds, "history": "now"])
        try await loadBootstrap()
    }

    /// Salir de un chat grupal (DELETE de mi propia membresía).
    func leaveConversation(_ conversationId: String) async throws {
        guard let me = me?.id else { return }
        try await api.requestData("/conversations/\(conversationId)/members/\(me)", method: "DELETE")
        homePath.removeAll { $0 == .conversation(conversationId) || $0 == .details(conversationId) }
        try await loadBootstrap()
    }

    // MARK: Perfil

    func updateProfile(name: String, title: String?, area: String?) async throws {
        func clean(_ s: String?) -> Any { let t = s?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""; return t.isEmpty ? NSNull() : String(t.prefix(120)) }
        let _: UserDTO = try await api.request("/me", method: "PATCH", json: ["name": name.trimmingCharacters(in: .whitespacesAndNewlines), "title": clean(title), "area": clean(area)])
        try await loadBootstrap()
    }

    nonisolated static let maxAvatarBytes = 3 * 1024 * 1024

    /// Sube la foto ya recortada (JPEG 512×512) como cuerpo crudo.
    func uploadAvatar(jpeg: Data) async throws {
        guard jpeg.count <= AppStore.maxAvatarBytes else {
            throw ApiRequestError(status: 413, code: "bad_request", message: L("profile.tooBig"))
        }
        let _: UserDTO = try await api.upload("/me/avatar", body: .init(data: jpeg, contentType: "image/jpeg"))
        try await loadBootstrap()
    }

    struct AvatarUrlResult: Decodable { var avatarUrl: String?; init(from d: Decoder) throws { avatarUrl = (try container(d)).o("avatarUrl") } }

    /// Foto del grupo: POST /conversations/:id/avatar (bytes, ≤ 3 MB).
    func uploadConversationAvatar(_ id: String, jpeg: Data) async throws {
        guard jpeg.count <= AppStore.maxAvatarBytes else { throw ApiRequestError(status: 413, code: "bad_request", message: L("profile.tooBig")) }
        let r: AvatarUrlResult = try await api.upload("/conversations/\(id)/avatar", body: .init(data: jpeg, contentType: "image/jpeg"))
        patchMeta(id) { $0.avatarUrl = r.avatarUrl }
        try? await loadBootstrap()
    }

    func removeConversationAvatar(_ id: String) async throws {
        try await api.requestData("/conversations/\(id)/avatar", method: "DELETE")
        patchMeta(id) { $0.avatarUrl = nil }
        try? await loadBootstrap()
    }

    func removeAvatar() async throws {
        try await api.requestData("/me/avatar", method: "DELETE")
        try await loadBootstrap()
    }

    // MARK: Archivos

    nonisolated static let maxDriveFileBytes = 25 * 1024 * 1024

    func driveTree(workspaceId: String?) async throws -> DriveTreeDTO {
        try await api.request("/drive/tree" + (workspaceId.map { "?workspaceId=\($0)" } ?? ""))
    }

    @discardableResult
    func createDriveFolder(workspaceId: String?, parentId: String?, name: String) async throws -> DriveFolderDTO {
        let body: [String: Any] = ["workspaceId": workspaceId ?? NSNull(), "parentId": parentId ?? NSNull(), "name": String(name.prefix(120))]
        return try await api.request("/drive/folders", method: "POST", json: body)
    }

    /// POST /drive/files?name=&workspaceId=&folderId=: siempre octet-stream; el tipo real va en x-file-type.
    @discardableResult
    func uploadDriveFile(workspaceId: String?, folderId: String?, name: String, contentType: String, data: Data) async throws -> DriveFileDTO {
        var q = URLComponents()
        q.queryItems = [URLQueryItem(name: "name", value: String(name.prefix(400)))]
        if let workspaceId { q.queryItems?.append(URLQueryItem(name: "workspaceId", value: workspaceId)) }
        if let folderId { q.queryItems?.append(URLQueryItem(name: "folderId", value: folderId)) }
        let query = q.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B") ?? ""
        return try await api.upload("/drive/files?\(query)", body: .init(data: data, contentType: "application/octet-stream",
                                                                          headers: ["x-file-type": contentType.isEmpty ? "application/octet-stream" : contentType]))
    }

    struct DownloadLink: Decodable { var url: String; init(from d: Decoder) throws { url = (try container(d)).v("url", "") } }

    /// Enlace firmado (5 min) para descargar un archivo.
    func driveFileLink(_ id: String) async throws -> URL {
        let r: DownloadLink = try await api.request("/drive/files/\(id)/link")
        guard let u = URL(string: r.url) else { throw ApiRequestError(status: 200, code: "decode", message: L("common.error")) }
        return u
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

struct PrivateReplyDraft: Equatable {
    var conversationId: String
    var fromConversationId: String
    var messageId: String
    var author: String?
    var sentAt: String
    var excerpt: String
}
