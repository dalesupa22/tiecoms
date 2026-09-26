import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }

/// 1.6.1: asuntos plegables en Grupos, completar con pulsación larga y reacciones (docs/REACCIONES_ENLACES.md).
@MainActor
final class V7GroupsReactionsTests: XCTestCase {
    private let bootJSON = #"""
    {"contract":"2026-09-26","serverTime":"","me":{"id":"me","name":"Ana Ruiz","kind":"human","primaryOrgId":"oA"},
     "organizations":[{"id":"oA","name":"Xertify","myRole":"owner"},{"id":"oB","name":"Ongoing","reactionActions":false}],
     "workspaces":[
       {"id":"wHome","name":"Xertify","owningOrgId":"oA","organizationIds":["oA"],"memberIds":["me","col"],"myRole":"member","isOrgHome":true,"createdAt":"2026-09-01"},
       {"id":"wRel","name":"Mentorías","owningOrgId":"oB","organizationIds":["oB","oA"],"memberIds":["me","bob"],"myRole":"member","createdAt":"2026-09-01"}],
     "conversations":[
       {"id":"g1","workspaceId":"wHome","kind":"group","name":"Pagos","memberIds":["me","col"],"openIssues":2,"canPost":true,"lastMessageSeq":1,"lastEventSeq":1,"lastReadSeq":1},
       {"id":"g2","workspaceId":"wHome","kind":"group","name":"Ventas","memberIds":["me","col"],"canPost":true},
       {"id":"r1","workspaceId":"wRel","kind":"group","name":"Mentoría","memberIds":["me","bob"],"canPost":true}],
     "people":[{"id":"me","name":"Ana Ruiz","kind":"human","orgId":"oA"},{"id":"col","name":"Laura","kind":"human","orgId":"oA"},
               {"id":"bob","name":"Beto","kind":"human","orgId":"oB"}]}
    """#

    private func boot() throws -> BootstrapDTO { try dec(BootstrapDTO.self, bootJSON) }

    private func issue(_ id: String, conv: String = "g1", status: String = "open", due: String? = nil, title: String = "Factura") throws -> IssueDTO {
        try dec(IssueDTO.self, #"{"id":"\#(id)","conversationId":"\#(conv)","workspaceId":"wHome","title":"\#(title)","status":"\#(status)","dueDate":\#(due.map { "\"\($0)\"" } ?? "null"),"statusSince":"2026-09-26T10:00:00.000Z","createdAt":"2026-09-20T10:00:00.000Z","updatedAt":"2026-09-26T10:00:00.000Z"}"#)
    }

    // MARK: Asuntos plegables

    func testIssuesCollapsedByDefaultAndToggleKeys() throws {
        var s: Set<String> = ["sec:relations"]
        XCTAssertFalse(HomeCollapse.issuesOpen(s, "g1"), "por defecto plegados")
        s.insert(HomeCollapse.issuesKey("g1"))
        XCTAssertTrue(HomeCollapse.issuesOpen(s, "g1"))
        XCTAssertEqual(HomeCollapse.issuesKey("g1"), "iss:g1")
        XCTAssertFalse(HomeCollapse.issuesOpen(s, "g2"))
    }

    func testShowHideExpandAndCollapseAll() throws {
        let tree = Naming.groupsTree(try boot())
        let ids = HomeCollapse.groupIds(tree)
        XCTAssertEqual(Set(ids), ["g1", "g2", "r1"])
        var s: Set<String> = []
        HomeCollapse.setIssues(&s, ids, open: true)
        XCTAssertTrue(ids.allSatisfy { HomeCollapse.issuesOpen(s, $0) })
        HomeCollapse.setIssues(&s, ids, open: false)
        XCTAssertTrue(s.isEmpty)
        // «Plegar todo»: empresas de Relaciones y asuntos.
        HomeCollapse.setIssues(&s, ["g1"], open: true)
        HomeCollapse.collapseAll(&s, tree)
        XCTAssertFalse(HomeCollapse.issuesOpen(s, "g1"))
        XCTAssertTrue(s.contains("org:oB"), "la empresa de la relación queda plegada: \(s)")
        // «Expandir todo»: secciones, empresas y asuntos.
        s.insert("sec:relations")
        HomeCollapse.expandAll(&s, tree)
        XCTAssertFalse(s.contains("org:oB"))
        XCTAssertFalse(s.contains("sec:relations"))
        XCTAssertTrue(ids.allSatisfy { HomeCollapse.issuesOpen(s, $0) })
    }

    func testCollapseStatePersistsPerDevice() throws {
        let suite = "tc.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertTrue(HomeCollapse.load(defaults).isEmpty)
        HomeCollapse.save(["iss:g1", "org:oB"], defaults)
        XCTAssertEqual(HomeCollapse.load(defaults), ["iss:g1", "org:oB"])
    }

    func testChipCountsOnlyActiveIssuesAndOverdue() throws {
        let list = [try issue("i1", due: "2020-01-01"), try issue("i2", status: "in_progress"), try issue("i3", status: "waiting", due: "2020-02-01"),
                    try issue("i4", status: "done"), try issue("i5", status: "cancelled")]
        let s = GroupIssues.summary(list, serverCount: 9)
        XCTAssertEqual(s.count, 3, "solo open / in_progress / waiting")
        XCTAssertEqual(s.overdue, 2)
        // Sin asuntos cargados todavía: el conteo del servidor.
        XCTAssertEqual(GroupIssues.summary([], serverCount: 4).count, 4)
        XCTAssertTrue(IssueStatus.done.closed && IssueStatus.cancelled.closed)
        XCTAssertFalse(IssueStatus.open.closed || IssueStatus.in_progress.closed || IssueStatus.waiting.closed)
    }

    func testSearchMatchesIssueTitlesIgnoringAccents() throws {
        let list = [try issue("i1", title: "Facturación de octubre"), try issue("i2", title: "Contrato")]
        XCTAssertEqual(GroupIssues.matching(list, query: "facturacion").map(\.id), ["i1"])
        XCTAssertTrue(GroupIssues.matching(list, query: "  ").isEmpty)
    }

    // MARK: Completar con pulsación larga (optimista)

    private func mockStore() throws -> AppStore {
        MockURLProtocol.routes = [:]
        MockURLProtocol.requests = []
        MockURLProtocol.httpRequests = []
        let s = AppStore(baseURL: URL(string: "https://mock.chaggu.test")!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()),
                         feedback: nil, session: MockURLProtocol.session())
        let msg = #"{"id":"m1","conversationId":"g1","seq":1,"authorId":"me","kind":"text","body":"Listo el informe","createdAt":"2026-09-26T10:00:00.000Z"}"#
        s.seedForTesting(try boot(), conversations: ["g1": ConversationState(messages: [try dec(MessageDTO.self, msg)], lastEventSeq: 1, hasMore: false, loaded: true)])
        return s
    }

    func testCompleteIssueIsOptimisticAndDropsFromCount() async throws {
        let s = try mockStore()
        s.issues = ["i1": try issue("i1"), "i2": try issue("i2")]
        s.recountIssues("g1")
        XCTAssertEqual(s.meta("g1")?.openIssues, 2)
        var done = try issue("i1", status: "done")
        done.updatedAt = "2026-09-26T11:00:00.000Z"
        MockURLProtocol.routes["/api/v1/issues/i1"] = (200, String(data: try JSONEncoder().encode(done), encoding: .utf8)!)
        try await s.setIssueStatus("i1", .done)
        XCTAssertEqual(s.issues["i1"]?.status, .done)
        XCTAssertEqual(s.meta("g1")?.openIssues, 1, "el chip baja al instante")
        let req = try XCTUnwrap(MockURLProtocol.httpRequests.last)
        XCTAssertEqual(req.httpMethod, "PATCH")
        XCTAssertEqual(MockURLProtocol.requests.last?.body["status"] as? String, "done")
    }

    func testCompleteIssueRollsBackOnError() async throws {
        let s = try mockStore()
        s.issues = ["i1": try issue("i1")]
        s.recountIssues("g1")
        MockURLProtocol.routes["/api/v1/issues/i1"] = (403, #"{"error":{"code":"forbidden","message":"no"}}"#)
        do { try await s.setIssueStatus("i1", .done); XCTFail("debió fallar") } catch {}
        XCTAssertEqual(s.issues["i1"]?.status, .open)
        XCTAssertEqual(s.meta("g1")?.openIssues, 1)
    }

    // MARK: Reacciones

    func testNormalizeEmojiLikeContract() {
        XCTAssertEqual(Reactions.normalize("❤"), "❤️")
        XCTAssertEqual(Reactions.normalize("👍\u{FE0F}"), "👍")
        XCTAssertEqual(Reactions.normalize(" 👍 "), "👍")
        XCTAssertEqual(Reactions.normalize("1\u{20E3}"), "1\u{FE0F}\u{20E3}")
        XCTAssertEqual(Reactions.normalize("👍🏽"), "👍🏽")
        XCTAssertEqual(Reactions.normalize("👩‍💻"), "👩‍💻")
        XCTAssertEqual(Reactions.normalize("🇨🇴"), "🇨🇴")
        XCTAssertEqual(Reactions.normalize("✅"), "✅")
        XCTAssertEqual(Reactions.normalize("☺"), "☺️")
        XCTAssertNil(Reactions.normalize("a"))
        XCTAssertNil(Reactions.normalize("1"))
        XCTAssertNil(Reactions.normalize("👍👍"))
        XCTAssertNil(Reactions.normalize(""))
        for e in Reactions.quick { XCTAssertEqual(Reactions.normalize(e), e, "la barra rápida ya está en forma canónica: \(e)") }
        for e in Reactions.common { XCTAssertNotNil(Reactions.normalize(e), "selector: \(e)") }
    }

    func testJumboOnlyForOneToThreeEmoji() {
        XCTAssertTrue(Reactions.isJumbo("😂"))
        XCTAssertTrue(Reactions.isJumbo(" 👍 👍 "))
        XCTAssertTrue(Reactions.isJumbo("🇨🇴🎉❤️"))
        XCTAssertFalse(Reactions.isJumbo("👍👍👍👍"))
        XCTAssertFalse(Reactions.isJumbo("ok 👍"))
        XCTAssertFalse(Reactions.isJumbo("12"))
        XCTAssertFalse(Reactions.isJumbo(""))
    }

    func testDecodeReactionsAndReactionActions() throws {
        let m = try dec(MessageDTO.self, #"{"id":"m1","conversationId":"c","seq":1,"authorId":"a","kind":"text","body":"x","createdAt":"","reactions":[{"emoji":"👍","userIds":["me","bob"]},{"emoji":"🙏","userIds":[],"external":[{"name":"Pedro","source":"whatsapp"}]},{"bad":1}]}"#)
        XCTAssertEqual(m.reactions.map(\.emoji), ["👍", "🙏"])
        XCTAssertEqual(m.reactions[1].count, 1)
        XCTAssertEqual(m.reactions[1].external.first?.source, .whatsapp)
        XCTAssertTrue(try dec(MessageDTO.self, #"{"id":"m2","createdAt":""}"#).reactions.isEmpty, "clientes viejos: sin reacciones")
        let d = try boot()
        XCTAssertTrue(d.organizations.first { $0.id == "oA" }!.reactionActions, "activas por defecto")
        XCTAssertFalse(d.organizations.first { $0.id == "oB" }!.reactionActions)
        XCTAssertTrue(Reactions.actionsEnabled(d))
        // Round-trip (caché local de mensajes).
        let back = try JSONDecoder().decode(MessageDTO.self, from: JSONEncoder().encode(m))
        XCTAssertEqual(back.reactions, m.reactions)
    }

    func testToggledIsOptimisticLikeWeb() {
        let base = [ReactionDTO(emoji: "👍", userIds: ["bob"]), ReactionDTO(emoji: "❤️", userIds: ["me"])]
        XCTAssertEqual(Reactions.toggled(base, emoji: "👍", me: "me", on: true).first?.userIds, ["bob", "me"])
        XCTAssertEqual(Reactions.toggled(base, emoji: "❤️", me: "me", on: false).map(\.emoji), ["👍"], "sin nadie, el chip desaparece")
        XCTAssertEqual(Reactions.toggled(base, emoji: "🙏", me: "me", on: true).map(\.emoji), ["👍", "❤️", "🙏"])
        let ext = [ReactionDTO(emoji: "🙏", userIds: ["me"], external: [.init(name: "Pedro", source: .whatsapp)])]
        XCTAssertEqual(Reactions.toggled(ext, emoji: "🙏", me: "me", on: false).first?.count, 1, "queda la de WhatsApp")
    }

    func testReactorsTextAndLookReminder() throws {
        let d = try boot()
        let r = ReactionDTO(emoji: "👍", userIds: ["col", "bob", "me"], external: [.init(name: "Pedro", source: .whatsapp)])
        XCTAssertEqual(Reactions.reactorsText(d, r), "Laura, Beto (Ongoing), \(L("common.youShort")) \(L("common.and")) Pedro · WhatsApp")
        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "America/Bogota")!
        let morning = cal.date(from: DateComponents(year: 2026, month: 9, day: 26, hour: 10))!
        XCTAssertEqual(Reactions.lookRemindAt(morning, calendar: cal), cal.date(from: DateComponents(year: 2026, month: 9, day: 26, hour: 13)))
        let evening = cal.date(from: DateComponents(year: 2026, month: 9, day: 26, hour: 17))!
        XCTAssertEqual(Reactions.lookRemindAt(evening, calendar: cal), cal.date(from: DateComponents(year: 2026, month: 9, day: 27, hour: 9)))
    }

    func testReactPutsEncodedEmojiAndAppliesServerMessage() async throws {
        let s = try mockStore()
        let server = #"{"message":{"id":"m1","conversationId":"g1","seq":1,"authorId":"me","kind":"text","body":"Listo el informe","createdAt":"2026-09-26T10:00:00.000Z","reactions":[{"emoji":"👍","userIds":["me","col"]}]}}"#
        MockURLProtocol.routes["/api/v1/messages/m1/reactions/👍"] = (200, server)
        let m = try XCTUnwrap(s.conversations["g1"]?.messages.first)
        try await s.react(m, emoji: "👍\u{FE0F}", on: true)
        let req = try XCTUnwrap(MockURLProtocol.httpRequests.last)
        XCTAssertEqual(req.httpMethod, "PUT")
        XCTAssertTrue(req.url!.absoluteString.hasSuffix("/api/v1/messages/m1/reactions/%F0%9F%91%8D"), req.url!.absoluteString)
        XCTAssertEqual(req.value(forHTTPHeaderField: "content-type"), "application/json", "PUT con {}")
        XCTAssertEqual(s.conversations["g1"]?.messages.first?.reactions.first?.userIds, ["me", "col"])
        XCTAssertNil(s.conversations["g1"]?.messages.first?.editedAt)
    }

    func testReactRollsBackOn409AndDeleteHasNoBody() async throws {
        let s = try mockStore()
        MockURLProtocol.routes["/api/v1/messages/m1/reactions/🎉"] = (409, #"{"error":{"code":"conflict","message":"20"}}"#)
        let m = try XCTUnwrap(s.conversations["g1"]?.messages.first)
        do { try await s.react(m, emoji: "🎉", on: true); XCTFail("409") } catch let e as ApiRequestError { XCTAssertEqual(e.status, 409) }
        XCTAssertTrue(s.conversations["g1"]?.messages.first?.reactions.isEmpty == true, "se revierte")
        MockURLProtocol.routes["/api/v1/messages/m1/reactions/🎉"] = (200, #"{"message":null,"closedReminderIds":[]}"#)
        try await s.react(m, emoji: "🎉", on: false)
        let req = try XCTUnwrap(MockURLProtocol.httpRequests.last)
        XCTAssertEqual(req.httpMethod, "DELETE")
        XCTAssertNil(req.value(forHTTPHeaderField: "content-type"), "DELETE sin cuerpo")
    }

    func testLookReactionSendsRemindAtAndStoresReminder() async throws {
        let s = try mockStore()
        let server = #"{"message":{"id":"m1","conversationId":"g1","seq":1,"authorId":"me","kind":"text","body":"x","createdAt":"","reactions":[{"emoji":"👀","userIds":["me"]}]},"reminder":{"id":"r1","conversationId":"g1","messageId":"m1","remindAt":"2026-09-26T18:00:00.000Z","createdAt":""}}"#
        MockURLProtocol.routes["/api/v1/messages/m1/reactions/👀"] = (200, server)
        let m = try XCTUnwrap(s.conversations["g1"]?.messages.first)
        let r = try await s.react(m, emoji: "👀", on: true)
        XCTAssertNotNil(MockURLProtocol.requests.last?.body["remindAt"] as? String)
        XCTAssertEqual(r.reminder?.id, "r1")
        XCTAssertEqual(s.reminders.map(\.id), ["r1"])
    }

    func testReactionUpdateDoesNotBumpUnreadOrMarkEdited() throws {
        let s = try mockStore()
        let before = s.meta("g1")?.unread
        let json = #"{"type":"message.updated","conversationId":"g1","eventSeq":2,"message":{"id":"m1","conversationId":"g1","seq":1,"authorId":"me","kind":"text","body":"Listo el informe","createdAt":"2026-09-26T10:00:00.000Z","reactions":[{"emoji":"🙏","userIds":["col"]}]}}"#
        s.onConversationEvent(try dec(ConversationEvent.self, json), live: true)
        XCTAssertEqual(s.conversations["g1"]?.messages.first?.reactions.first?.emoji, "🙏")
        XCTAssertEqual(s.meta("g1")?.unread, before)
        XCTAssertNil(s.conversations["g1"]?.messages.first?.editedAt)
        XCTAssertEqual(s.toast?.contains("🙏"), true, "aviso breve: reaccionaron a un mensaje mío")
    }

    func testReactionPushAndRemindersChangedEvent() throws {
        let p = try XCTUnwrap(PushPayload(userInfo: ["type": "reaction", "conversationId": "g1", "messageId": "m1", "aps": ["alert": ["title": "Laura reaccionó 👍", "body": "Listo"]]]))
        XCTAssertEqual(p.kind, .reaction)
        XCTAssertEqual(p.messageId, "m1")
        XCTAssertEqual(try dec(AccountEvent.self, #"{"type":"reminders.changed"}"#), .remindersChanged)
    }

    func testChatThreadsStayOutOfDMsButCountOnParent() throws {
        let d = try dec(BootstrapDTO.self, #"""
        {"contract":"2026-09-26","serverTime":"","me":{"id":"me","name":"Ana","kind":"human","primaryOrgId":"oA"},"organizations":[{"id":"oA","name":"X"}],"workspaces":[],
         "conversations":[{"id":"d1","kind":"direct","memberIds":["me","bob"]},
                          {"id":"t1","kind":"multi","name":"Hilo · x","parentId":"d1","parentMessageId":"m1","deriveKind":"same","memberIds":["me","bob"],"unread":2,"lastMessageSeq":2},
                          {"id":"s1","kind":"multi","name":"Sidechat · y","parentId":"d1","deriveKind":"side","memberIds":["me","bob"]}],
         "people":[{"id":"me","name":"Ana","kind":"human"},{"id":"bob","name":"Beto","kind":"human"}]}
        """#)
        XCTAssertEqual(Set(Naming.dms(d).map(\.id)), ["d1", "s1"], "el hilo del directo vive en la barra del chat, el sidechat sí va en DMs")
        XCTAssertEqual(Naming.chatThreadUnread(d)["d1"].map { $0 > 0 }, true)
    }
}
