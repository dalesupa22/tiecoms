import Foundation
import SwiftUI

/// Funciones de paridad con la web (packages/client-core): edición, fijados,
/// preferencias, asuntos, agenda, recordatorios, bifurcaciones, dominios,
/// WhatsApp y eliminación de la cuenta.
extension AppStore {
    private func enc(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? s }

    // MARK: Seguridad

    struct BlockedUsers: Decodable { let userIds: [String] }

    func loadBlockedUsers() async throws {
        let stamp = sessionStamp
        let result: BlockedUsers = try await api.request("/blocks")
        try requireSession(stamp)
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

    /// Siempre manda las menciones (reemplazan a las anteriores).
    func editMessage(_ id: String, body: String, mentions: [Mention] = []) async throws {
        let (text, ms) = MentionText.trimmed(body, mentions: mentions)
        let parts = RefText.split(MentionText.valid(ms, in: text))
        let r: EditResult = try await api.request("/messages/\(id)", method: "PATCH",
                                                  json: ["body": text, "mentions": parts.mentions.map(\.json), "refs": parts.refs.map(RefText.json)])
        upsertLocal(r.message)
        reportDroppedMentions(r.droppedMentions)
    }

    /// PATCH /messages/:id devuelve el mensaje (o {message, droppedMentions}).
    struct EditResult: Decodable {
        var message: MessageDTO
        var droppedMentions: [String]
        init(from decoder: Decoder) throws {
            let c = try container(decoder)
            if let m: MessageDTO = c.o("message") { message = m } else { message = try MessageDTO(from: decoder) }
            droppedMentions = c.v("droppedMentions", [])
        }
    }

    /// Bandeja de menciones: GET /mentions?before&limit.
    func loadMentions(before: String? = nil, limit: Int = 30) async throws -> MentionsPage {
        var q = "limit=\(limit)"
        if let before, let e = before.addingPercentEncoding(withAllowedCharacters: .alphanumerics) { q += "&before=\(e)" }
        return try await api.request("/mentions?\(q)")
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

    struct LastRead: Decodable {
        var lastReadSeq: Int?
        var readRevision: Int?
        init(from d: Decoder) throws { let c = try container(d); lastReadSeq = c.intOpt("lastReadSeq"); readRevision = c.intOpt("readRevision") }
    }

    func readRevision(_ id: String) -> Int { max(readRevisions[id] ?? -1, meta(id)?.readRevision ?? -1) }

    /// HTTP and socket share the same monotonic revision gate. Legacy ACKs cannot undo a newer revision.
    @discardableResult func applyConfirmedRead(_ id: String, seq: Int, revision: Int?, legacyRevision: Int, allowLegacyLower: Bool = false) -> Bool {
        guard let current = meta(id) else { return false }
        if let revision {
            guard revision >= readRevision(id) else { return false }
            readRevisions[id] = revision
            patchMeta(id) {
                $0.readRevision = revision; $0.lastReadSeq = seq
                $0.unread = max(0, $0.lastMessageSeq - max(seq, $0.historyFromSeq))
                if seq >= $0.lastMessageSeq { $0.unreadMentions = 0 }
            }
        } else {
            guard readRevision(id) == legacyRevision else { scheduleBootstrap(); return false }
            if allowLegacyLower {
                patchMeta(id) { $0.lastReadSeq = seq; $0.unread = max(0, $0.lastMessageSeq - max(seq, $0.historyFromSeq)) }
            } else {
                guard seq >= current.lastReadSeq else { return false }
                patchMeta(id) { ReadTree.applyRead(&$0, seq: seq) }
            }
        }
        return true
    }

    func markUnread(_ conversationId: String, seq: Int) async throws {
        let stamp = sessionStamp, priorRevision = readRevision(conversationId)
        cancelPendingRead(conversationId)
        let r: LastRead = try await api.request("/conversations/\(conversationId)/unread", method: "POST", json: ["seq": seq])
        try requireSession(stamp)
        if let confirmed = r.lastReadSeq { applyConfirmedRead(conversationId, seq: confirmed, revision: r.readRevision, legacyRevision: priorRevision, allowLegacyLower: true) }
        else { scheduleBootstrap() }
    }

    func markConversationRead(_ conversationId: String) async throws {
        guard let c = meta(conversationId) else { return }
        let stamp = sessionStamp, priorRevision = readRevision(conversationId)
        let r: LastRead = try await api.request("/conversations/\(conversationId)/read", method: "POST", json: ["seq": c.lastMessageSeq])
        try requireSession(stamp)
        applyConfirmedRead(conversationId, seq: r.lastReadSeq ?? c.lastMessageSeq, revision: r.readRevision, legacyRevision: priorRevision)
    }

    // MARK: Preferencias

    /// Fijar arriba y silenciar (mutedUntil = nil reactiva). Optimista; el servidor confirma con prefs.updated.
    func setConversationPrefs(_ id: String, pinned: Bool? = nil, mutedUntil: Date?? = nil) async throws {
        var body: [String: Any] = [:]
        if let pinned { body["pinned"] = pinned }
        if let mutedUntil { body["mutedUntil"] = Silence.wire(mutedUntil) }
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
        case .forever: return Silence.forever
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

    func canCacheIssue(_ issue: IssueDTO) -> Bool {
        !issue.isPersonal || (me?.id != nil && issue.ownerId == me?.id)
    }

    // MARK: Asuntos

    @discardableResult
    func loadIssues(workspaceId: String? = nil, conversationId: String? = nil, mine: Bool = false, open: Bool = false) async throws -> [IssueDTO] {
        let stamp = sessionStamp
        var q: [String] = []
        if let workspaceId { q.append("workspaceId=\(workspaceId)") }
        if let conversationId { q.append("conversationId=\(conversationId)") }
        if mine { q.append("mine=1") }
        if open { q.append("open=1") }
        let r: ListOf<IssueDTO> = try await api.request("/issues?\(q.joined(separator: "&"))")
        try requireSession(stamp)
        let visible = r.items.filter(canCacheIssue)
        for i in visible { issues[i.id] = i }
        return visible
    }

    @discardableResult
    func createIssue(conversationId: String, title: String, ownerId: String?, dueDate: String?, originMessageId: String?, topicId: String? = nil, assigneeIds: [String]? = nil) async throws -> IssueDTO {
        let stamp = sessionStamp
        var body: [String: Any] = ["title": title, "ownerId": ownerId ?? NSNull(), "dueDate": dueDate ?? NSNull(), "originMessageId": originMessageId ?? NSNull()]
        if let assigneeIds { body["assigneeIds"] = Array(Set(assigneeIds)).sorted() }
        // Con una banderita elegida la tarea nace en ese tema; desde un mensaje con tema, el servidor lo hereda.
        if let topicId { body["topicId"] = topicId }
        let i: IssueDTO = try await api.request("/conversations/\(conversationId)/issues", method: "POST", json: body)
        try requireSession(stamp)
        guard canCacheIssue(i) else { throw CancellationError() }
        issues[i.id] = i
        recountIssues(conversationId)
        return i
    }

    /// Asunto personal (POST /issues): sin conversación y solo para mí; el servidor impone la privacidad.
    @discardableResult
    func createPersonalIssue(title: String, dueDate: String?) async throws -> IssueDTO {
        let stamp = sessionStamp
        let i: IssueDTO = try await api.request("/issues", method: "POST", json: ["title": title, "dueDate": dueDate ?? NSNull()])
        try requireSession(stamp)
        guard canCacheIssue(i) else { throw CancellationError() }
        issues[i.id] = i
        return i
    }

    @discardableResult
    func updateIssue(_ id: String, _ patch: [String: Any]) async throws -> IssueDTO {
        let stamp = sessionStamp
        let i: IssueDTO = try await api.request("/issues/\(id)", method: "PATCH", json: patch)
        try requireSession(stamp)
        guard canCacheIssue(i) else { throw CancellationError() }
        issues[i.id] = i
        recountIssues(i.conversationId)
        return i
    }

    /// Cambia el estado de un asunto (pulsación larga en Grupos y en las listas): optimista y animado; si el API
    /// falla se revierte. Un asunto cerrado sale de las listas de activos y del conteo del grupo al instante.
    func setIssueStatus(_ id: String, _ status: IssueStatus) async throws {
        let stamp = sessionStamp
        guard let prev = issues[id], prev.status != status else { return }
        var next = prev
        next.status = status
        next.statusSince = ISODate.string()
        withAnimation(.easeInOut(duration: 0.25)) {
            issues[id] = next
            recountIssues(prev.conversationId)
        }
        do {
            try await updateIssue(id, ["status": status.rawValue])
        } catch {
            try requireSession(stamp)
            withAnimation(.easeInOut(duration: 0.25)) {
                issues[id] = prev
                recountIssues(prev.conversationId)
            }
            throw error
        }
    }

    func issueDetail(_ id: String) async throws -> IssueDetail {
        let stamp = sessionStamp
        let r: IssueDetail = try await api.request("/issues/\(id)")
        try requireSession(stamp)
        guard canCacheIssue(r.issue), r.children.allSatisfy(canCacheIssue) else { throw CancellationError() }
        issues[r.issue.id] = r.issue
        for k in r.children { issues[k.id] = k }
        return r
    }

    func commentIssue(_ id: String, body: String) async throws {
        let stamp = sessionStamp
        let i: IssueDTO = try await api.request("/issues/\(id)/comments", method: "POST", json: ["body": body])
        try requireSession(stamp)
        guard canCacheIssue(i) else { throw CancellationError() }
        issues[i.id] = i
    }

    // MARK: Agenda

    @discardableResult
    func loadEvents(from: Date, to: Date, conversationId: String? = nil) async throws -> [CalendarEventDTO] {
        let stamp = sessionStamp
        var q = "from=\(ISODate.string(from).addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")&to=\(ISODate.string(to).addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")"
        if let conversationId { q += "&conversationId=\(conversationId)" }
        let r: ListOf<CalendarEventDTO> = try await api.request("/events?\(q)")
        try requireSession(stamp)
        for e in r.items { events[e.id] = e }
        return r.items
    }

    func loadEvent(_ id: String) async throws -> CalendarEventDTO {
        let stamp = sessionStamp
        let e: CalendarEventDTO = try await api.request("/events/\(id)")
        try requireSession(stamp)
        events[e.id] = e
        return e
    }

    @discardableResult
    func createEvent(conversationId: String, _ input: [String: Any]) async throws -> CalendarEventDTO {
        let stamp = sessionStamp
        let e: CalendarEventDTO = try await api.request("/conversations/\(conversationId)/events", method: "POST", json: input)
        try requireSession(stamp)
        events[e.id] = e
        return e
    }

    @discardableResult
    func updateEvent(_ id: String, _ patch: [String: Any]) async throws -> CalendarEventDTO {
        let stamp = sessionStamp
        let e: CalendarEventDTO = try await api.request("/events/\(id)", method: "PATCH", json: patch)
        try requireSession(stamp)
        events[e.id] = e
        return e
    }

    @discardableResult
    func cancelEvent(_ id: String) async throws -> CalendarEventDTO {
        let stamp = sessionStamp
        let e: CalendarEventDTO = try await api.request("/events/\(id)", method: "DELETE")
        try requireSession(stamp)
        events[e.id] = e
        return e
    }

    @discardableResult
    func rsvp(_ id: String, _ answer: Rsvp) async throws -> CalendarEventDTO {
        let stamp = sessionStamp
        let e: CalendarEventDTO = try await api.request("/events/\(id)/rsvp", method: "POST", json: ["rsvp": answer.rawValue])
        try requireSession(stamp)
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

    struct ReturnSuggestion: Decodable, Sendable {
        var summary: String
        var source: String
        var isAI: Bool { source == "ai" }
        init(summary: String, source: String) { self.summary = summary; self.source = source }
        init(from decoder: Decoder) throws { let c = try container(decoder); summary = c.v("summary", ""); source = c.v("source", "fallback") }
    }

    /// DeepSeek only receives conversation data after an explicit choice for this request.
    func suggestReturn(_ sideId: String, aiConsent: Bool = false) async throws -> ReturnSuggestion {
        try await api.request("/conversations/\(sideId)/return/suggest", method: "POST", json: ["aiConsent": aiConsent])
    }

    /// Resumen de respaldo local: las últimas respuestas (sin la pregunta inicial).
    func localReturnSummary(_ sideId: String) -> String {
        let msgs = (conversations[sideId]?.messages ?? []).filter { !$0.isSystem && $0.deletedAt == nil && !$0.body.isEmpty }
        let replies = msgs.count > 1 ? Array(msgs.dropFirst()) : msgs
        return replies.suffix(3).map { m in "\(data.flatMap { Naming.person($0, m.authorId)?.name } ?? ""): \(m.body)" }.joined(separator: "\n")
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
        // Con adjuntos, el servidor copia la referencia (forwardAttachmentIds).
        send(target, body: source.body, forwarded: ForwardedInfo(source: .tiecoms, author: author, sentAt: source.createdAt, fromConversationId: source.conversationId),
             forwardAttachments: source.attachments)
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

    /// Toque en una persona (búsqueda, «Recientes», «Mensaje nuevo»): abre su directo y, si no existe, lo crea.
    func openDirect(with personId: String) async throws {
        if let d = data, let c = QuickSearch.direct(d, with: personId) { navigate(to: .conversation(c.id)); return }
        let r = try await createChat(userIds: [personId], name: nil)
        navigate(to: .conversation(r.id))
    }

    /// «Grupo en un espacio»: POST /workspaces/:id/conversations {name, kind, level, memberIds}.
    func createWorkspaceConversation(workspaceId: String, name: String, isInternal: Bool, directive: Bool, memberIds: [String]) async throws -> CreateChatResult {
        let body: [String: Any] = ["name": String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(120)),
                                   "kind": isInternal ? "internal" : "group",
                                   "level": isInternal ? NSNull() : (directive ? "directivo" : "operativo"),
                                   "memberIds": memberIds]
        let r: CreateChatResult = try await api.request("/workspaces/\(workspaceId)/conversations", method: "POST", json: body)
        try await loadBootstrap()
        return r
    }

    // MARK: Push

    /// PUT /push/token {provider:'apns', token, environment, lang} (reemplaza el token anterior de la sesión).
    func registerPushToken(_ hex: String) async {
        pushTokenSync.receive(hex)
        guard status == .ready, !pushSigningOut else { return }
        pushTokenSync.setEnabled(Prefs.notificationsEnabled && AppFeedback.shared.authorized)
        await pushTokenSync.synchronize()
    }

    func unregisterPush() async {
        PushRegistration.unregister()
        pushTokenSync.setEnabled(false)
        guard api.accessToken != nil else { return }
        await pushTokenSync.synchronize()
    }

    /// Se llama al entrar, volver a primer plano y recuperar conectividad. No muestra el permiso.
    func retryPushRegistration() async {
        guard status == .ready, !pushSigningOut else { return }
        await AppFeedback.shared.refreshAuthorization()
        guard status == .ready, !pushSigningOut else { return }
        let enabled = Prefs.notificationsEnabled && AppFeedback.shared.authorized
        pushTokenSync.setEnabled(enabled)
        if enabled {
            if let token = PushRegistration.token { pushTokenSync.receive(token) }
            PushRegistration.registerIfEnabled()
        } else {
            PushRegistration.unregister()
        }
        await pushTokenSync.synchronize()
    }

    /// Aplica OFF inmediatamente, incluso si todavía se está enviando el token anterior.
    @discardableResult
    func setNotificationsEnabled(_ enabled: Bool) -> Task<Void, Never> {
        Prefs.notificationsEnabled = enabled
        if !enabled {
            pushTokenSync.setEnabled(false)
            PushRegistration.unregister()
        }
        return Task {
            if enabled && Prefs.notificationsEnabled { await AppFeedback.shared.requestAuthorizationIfNeeded() }
            await retryPushRegistration()
        }
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

    /// Carga hacia atrás (hasta 10 páginas) hasta tener el mensaje con ese id. Devuelve su seq.
    func ensureMessage(_ conversationId: String, id: String) async -> Int? {
        try? await openConversation(conversationId)
        for _ in 0..<10 {
            guard let c = conversations[conversationId], c.loaded else { return nil }
            if let m = c.messages.first(where: { $0.id == id }) { return m.seq }
            if !c.hasMore { return nil }
            await loadOlder(conversationId)
        }
        return nil
    }

    /// Conserva el pedido mientras carga: borrarlo antes del await cancelaría la `.task(id:)` de la vista.
    /// Un aviso más nuevo tiene prioridad y no debe ser consumido por la carga anterior.
    func resolveMessageJump(_ conversationId: String, messageId: String) async {
        guard jumpToMessage[conversationId] == messageId else { return }
        let seq = await ensureMessage(conversationId, id: messageId)
        guard !Task.isCancelled, jumpToMessage[conversationId] == messageId else { return }
        if let seq { jumpTo[conversationId] = seq }
        jumpToMessage[conversationId] = nil
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
                                                 author: Naming.person(d, m.authorId)?.name, sentAt: m.createdAt,
                                                 // La tarjeta de un correo o WhatsApp se cita con su asunto o texto, nunca como JSON.
                                                 excerpt: String(MailText.quoteText(kind: m.kind, body: m.body).prefix(200)))
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
    func addMembers(_ conversationId: String, userIds: [String], history: String = "now") async throws {
        try await api.requestData("/conversations/\(conversationId)/members", method: "POST", json: ["userIds": userIds, "history": history])
        try await loadBootstrap()
    }

    /// Nombrar o quitar admin (también «Dejar de ser admin» sobre mí): PUT …/members/{userId}/admin → `{ adminIds }`.
    /// Aplica los admins de la respuesta y refresca el bootstrap (docs/ADMINS-INTEGRACIONES.md §1).
    func setGroupAdmin(_ conversationId: String, userId: String, admin: Bool) async throws {
        let stamp = sessionStamp
        struct R: Decodable { var adminIds: [String]?; init(from d: Decoder) throws { adminIds = try container(d).o("adminIds") } }
        let r: R = try await api.request("/conversations/\(conversationId)/members/\(userId)/admin", method: "PUT", json: ["admin": admin])
        try requireSession(stamp)
        if let ids = r.adminIds { patchMeta(conversationId) { $0.adminIds = ids } }
        try await loadBootstrap()
        try requireSession(stamp)
    }

    /// Sacar a alguien del grupo (DELETE de su membresía; solo quien administra).
    func removeMember(_ conversationId: String, userId: String) async throws {
        let stamp = sessionStamp
        try await api.requestData("/conversations/\(conversationId)/members/\(userId)", method: "DELETE")
        try requireSession(stamp)
        try await loadBootstrap()
        try requireSession(stamp)
    }

    /// Ejecuta una acción del menú de un participante.
    func perform(_ action: GroupMemberAction, conversationId: String, userId: String, expectedSession: SessionStamp? = nil) async throws {
        let stamp = expectedSession ?? sessionStamp
        try requireSession(stamp)
        switch action {
        case .makeAdmin: try await setGroupAdmin(conversationId, userId: userId, admin: true)
        case .removeAdmin, .stepDown: try await setGroupAdmin(conversationId, userId: userId, admin: false)
        case .removeMember: try await removeMember(conversationId, userId: userId)
        }
        try requireSession(stamp)
    }

    /// Salir de un chat grupal (DELETE de mi propia membresía).
    func leaveConversation(_ conversationId: String) async throws {
        guard let me = me?.id else { return }
        try await api.requestData("/conversations/\(conversationId)/members/\(me)", method: "DELETE")
        Donations.delete(conversationId: conversationId)
        homePath.removeAll { $0 == .conversation(conversationId) || $0 == .details(conversationId) }
        dmsPath.removeAll { $0 == .conversation(conversationId) || $0 == .details(conversationId) }
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
        let stamp = sessionStamp, revision = waPrivacy.revision
        let r: ListOf<WaAccountDTO>
        do { r = try await api.request("/whatsapp/accounts") }
        catch { if let e = error as? ApiRequestError, [403, 404].contains(e.status) { denyWaListing() }; throw error }
        try requireSession(stamp)
        guard revision == waPrivacy.revision else { throw CancellationError() }
        for a in r.items {
            waPrivacy.knownAccounts.insert(a.id)
            if a.privacyReady == false, !waPrivacy.accounts.contains(a.id) { revokeWaPrivacy(accountId: a.id, reset: true) }
            else if a.privacyReady == true { let wasBlocked = waPrivacy.accounts.contains(a.id); waPrivacy.ready(a.id); if wasBlocked { waRevision += 1 } }
        }
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

    func waChats(accountId: String?, category: WaCategory?, onlyGroups: Bool, showHidden: Bool, query: String, limit: Int? = nil, cursor: String? = nil) async throws -> WaChatsPage {
        var q: [String] = []
        if let cursor { q.append("cursor=\(enc(cursor))") }
        if let limit { q.append("limit=\(limit)") }
        if let accountId { q.append("accountId=\(accountId)") }
        if let category { q.append("category=\(category.rawValue)") }
        if onlyGroups { q.append("groups=1") }
        if showHidden { q.append("hidden=1") }
        let t = query.trimmingCharacters(in: .whitespaces)
        if !t.isEmpty { q.append("q=\(t.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")") }
        let stamp = sessionStamp, revision = waPrivacy.revision
        var page: WaChatsPage
        do { page = try await api.request("/whatsapp/chats?\(q.joined(separator: "&"))") }
        catch { if let e = error as? ApiRequestError, [403, 404].contains(e.status) { denyWaListing(accountId: accountId) }; throw error }
        try requireSession(stamp)
        guard revision == waPrivacy.revision else { throw CancellationError() }
        waPrivacy.accept(page.chats)
        page.chats = page.chats.filter { waPrivacy.allows($0.inboxKey) }
        return page
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
    var id: String { ["hour", "8h", "week", "forever"][MuteOption.allCases.firstIndex(of: self)!] }
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

// MARK: - Tareas derivadas (docs/TAREAS.md)

extension AppStore {
    /// POST /issues/:id/children { title, ownerId?, dueDate?, visibility?, viewerIds?, conversationId? }.
    /// `conversationId` = un sidechat del chat del asunto (la tarea vive ahí y la ve solo el sidechat).
    @discardableResult
    func createChildIssue(_ parentId: String, title: String, ownerId: String?, dueDate: String? = nil, visibility: IssueVisibility,
                          viewerIds: [String] = [], conversationId: String? = nil, assigneeIds: [String]? = nil) async throws -> IssueDTO {
        let stamp = sessionStamp
        var body: [String: Any] = ["title": title, "ownerId": ownerId ?? NSNull(), "dueDate": dueDate ?? NSNull(), "visibility": visibility.rawValue]
        if !viewerIds.isEmpty { body["viewerIds"] = viewerIds }
        if let assigneeIds { body["assigneeIds"] = Array(Set(assigneeIds)).sorted() }
        if let conversationId { body["conversationId"] = conversationId }
        let i: IssueDTO = try await api.request("/issues/\(parentId)/children", method: "POST", json: body)
        try requireSession(stamp)
        guard canCacheIssue(i) else { throw CancellationError() }
        issues[i.id] = i
        recountIssues(i.conversationId)
        return i
    }

    /// «Hablar aparte»: sidechat desde el asunto con quienes elija (POST /conversations/:id/side { issueId, userIds }).
    func createSideFromIssue(_ issue: IssueDTO, userIds: [String], question: String?) async throws -> String {
        var body: [String: Any] = ["issueId": issue.id, "userIds": userIds]
        if let q = question?.trimmingCharacters(in: .whitespacesAndNewlines), !q.isEmpty { body["question"] = String(q.prefix(4000)) }
        // Un asunto personal no tiene chat del que salga un sidechat (la interfaz no lo ofrece).
        guard let cid = issue.conversationId else { throw ApiRequestError(status: 400, code: "personal_issue", message: L("issue.personalNoSide")) }
        let r: IdResult = try await api.request("/conversations/\(cid)/side", method: "POST", json: body)
        try await loadBootstrap()
        return r.id
    }
}
