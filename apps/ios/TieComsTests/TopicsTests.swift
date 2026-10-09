import XCTest
@testable import TieComs

/// Temas del chat (docs/TEMAS.md): decodificación tolerante, evento topics.changed y reglas de la fila.
final class TopicsTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    static let topicJSON = #"""
    {"id":"t1","conversationId":"c1","name":"Finanzas","color":"green","icon":"💰","position":2,
     "archivedAt":null,"createdBy":"u1","createdAt":"2026-09-28T10:00:00.000Z","campoNuevo":true}
    """#

    func testTopicDTO() throws {
        let t = try decode(TopicDTO.self, Self.topicJSON)
        XCTAssertEqual(t.id, "t1")
        XCTAssertEqual(t.conversationId, "c1")
        XCTAssertEqual(t.name, "Finanzas")
        XCTAssertEqual(t.color, "green")
        XCTAssertEqual(t.icon, "💰")
        XCTAssertEqual(t.position, 2)
        XCTAssertFalse(t.isArchived)
        XCTAssertEqual(t.createdBy, "u1")
    }

    func testTopicDTOMinimalAndArchived() throws {
        let t = try decode(TopicDTO.self, #"{"id":"t2","name":"Viejo","position":"3","archivedAt":"2026-09-28T11:00:00Z","color":null}"#)
        XCTAssertEqual(t.color, "blue", "sin color se pinta azul")
        XCTAssertEqual(t.icon, "#")
        XCTAssertEqual(t.position, 3)
        XCTAssertTrue(t.isArchived)
        XCTAssertThrowsError(try decode(TopicDTO.self, #"{"name":"sin id"}"#))
    }

    func testMessageWithTopic() throws {
        let m = try decode(MessageDTO.self, #"""
        {"id":"m1","conversationId":"c1","seq":4,"authorId":"u1","kind":"text","body":"hola",
         "topicId":"t1","topicBy":"u2","createdAt":"2026-09-28T10:00:00.000Z","editedAt":null,"deletedAt":null}
        """#)
        XCTAssertEqual(m.topicId, "t1")
        XCTAssertEqual(m.topicBy, "u2")
    }

    func testMessageWithoutTopicOrNull() throws {
        let old = try decode(MessageDTO.self, #"{"id":"m2","conversationId":"c1","seq":5,"authorId":"u1","body":"servidor anterior","createdAt":""}"#)
        XCTAssertNil(old.topicId, "servidor anterior: sin tema")
        XCTAssertNil(old.topicBy)
        let none = try decode(MessageDTO.self, #"{"id":"m3","seq":6,"authorId":"u1","body":"x","topicId":null,"topicBy":null}"#)
        XCTAssertNil(none.topicId)
        let wrong = try decode(MessageDTO.self, #"{"id":"m4","seq":7,"authorId":"u1","body":"x","topicId":42}"#)
        XCTAssertNil(wrong.topicId, "un tipo inesperado no invalida el mensaje")
    }

    func testTopicsChangedEvent() throws {
        let e = try decode(ConversationEvent.self, #"""
        {"type":"topics.changed","conversationId":"c1","eventSeq":12,
         "topics":[\#(Self.topicJSON),{"id":"t9","name":"Archivado","archivedAt":"2026-09-28T11:00:00Z"},{"sinId":true}]}
        """#)
        guard case .topicsChanged(let conv, let seq, let topics) = e else { return XCTFail("\(e)") }
        XCTAssertEqual(conv, "c1")
        XCTAssertEqual(seq, 12)
        XCTAssertEqual(topics.map(\.id), ["t1", "t9"], "el elemento roto se descarta sin perder el evento")
        XCTAssertEqual(e.eventSeq, 12)
        XCTAssertEqual(e.conversationId, "c1")
    }

    func testTopicsChangedWithoutListIsEmpty() throws {
        let e = try decode(ConversationEvent.self, #"{"type":"topics.changed","conversationId":"c1","eventSeq":3}"#)
        XCTAssertEqual(e, .topicsChanged(conversationId: "c1", eventSeq: 3, topics: []))
    }

    func testMessageUpdatedCarriesTopic() throws {
        let e = try decode(ConversationEvent.self, #"""
        {"type":"message.updated","conversationId":"c1","eventSeq":13,
         "message":{"id":"m1","conversationId":"c1","seq":4,"authorId":"u1","body":"hola","topicId":"t1","topicBy":"u1"}}
        """#)
        guard case .messageUpdated(_, _, let m) = e else { return XCTFail("\(e)") }
        XCTAssertEqual(m.topicId, "t1")
    }

    func testTopicsResult() throws {
        let created = try decode(TopicsResult.self, #"{"topic":\#(Self.topicJSON),"topics":[\#(Self.topicJSON)]}"#)
        XCTAssertEqual(created.topic?.id, "t1")
        XCTAssertEqual(created.topics.count, 1)
        let removed = try decode(TopicsResult.self, #"{"topics":[],"cleared":4}"#)
        XCTAssertNil(removed.topic)
        XCTAssertEqual(removed.cleared, 4)
    }

    func testPendingMessageKeepsTopicAndOldOutboxDecodes() throws {
        let p = PendingMessage(clientMessageId: "cm1", conversationId: "c1", body: "hola", replyTo: nil, topicId: "t1",
                               createdAt: "2026-09-28T10:00:00Z", attempts: 0, status: .pending, error: nil, nextAttemptAt: 0)
        let back = try JSONDecoder().decode(PendingMessage.self, from: JSONEncoder().encode(p))
        XCTAssertEqual(back.topicId, "t1")
        // Cola guardada por una versión anterior (sin topicId).
        let old = try decode(PendingMessage.self, #"{"clientMessageId":"cm2","conversationId":"c1","body":"x","createdAt":"","attempts":1,"status":"pending","nextAttemptAt":0}"#)
        XCTAssertNil(old.topicId)
    }

    // MARK: Reglas

    private func topic(_ id: String, _ position: Int, archived: Bool = false, color: String = "blue", icon: String = "🌐") -> TopicDTO {
        TopicDTO(id: id, conversationId: "c1", name: id, color: color, icon: icon, position: position, archivedAt: archived ? "2026-09-28T00:00:00Z" : nil)
    }
    private func msg(_ id: String, topic: String?, by: String? = nil, author: String = "u1", deleted: Bool = false) -> MessageDTO {
        var m = MessageDTO(id: id, conversationId: "c1", seq: 1, authorId: author, clientMessageId: nil, body: id, createdAt: "")
        m.topicId = topic; m.topicBy = by
        if deleted { m.deletedAt = "2026-09-28T00:00:00Z" }
        return m
    }

    func testActiveArchivedAndFilter() {
        let list = [topic("b", 1), topic("a", 0), topic("z", 2, archived: true)]
        XCTAssertEqual(TopicRules.active(list).map(\.id), ["a", "b"], "en el orden de la fila")
        XCTAssertEqual(TopicRules.archived(list).map(\.id), ["z"])
        XCTAssertEqual(TopicRules.effectiveFilter("a", in: list), "a")
        XCTAssertNil(TopicRules.effectiveFilter("z", in: list), "archivado: el chat vuelve a Todo")
        XCTAssertNil(TopicRules.effectiveFilter("quitado", in: list))
        XCTAssertNil(TopicRules.effectiveFilter(nil, in: list))
    }

    func testNoPracticalLimit() {
        // 60 temas activos: la fila los muestra todos (el tope de 50 es del servidor y responde 409).
        let many = (0..<60).map { topic("t\($0)", $0) }
        XCTAssertEqual(TopicRules.active(many).count, 60)
    }

    func testCountsAndMatches() {
        let ms = [msg("1", topic: "a"), msg("2", topic: "a"), msg("3", topic: "b"), msg("4", topic: nil), msg("5", topic: "a", deleted: true)]
        XCTAssertEqual(TopicRules.counts(ms), ["a": 2, "b": 1], "los eliminados no cuentan")
        XCTAssertEqual(ms.filter { TopicRules.matches($0, filter: "a") }.map(\.id), ["1", "2", "5"])
        XCTAssertEqual(ms.filter { TopicRules.matches($0, filter: nil) }.count, 5)
    }

    func testSuggestionsSkipUsed() {
        let list = [topic("a", 0, color: "blue", icon: "🌐"), topic("b", 1, color: "green", icon: "🌱")]
        XCTAssertEqual(TopicRules.suggestedColor(list), "orange")
        XCTAssertEqual(TopicRules.suggestedIcon(list), "💰")
        XCTAssertEqual(TopicRules.colors.count, 8)
        XCTAssertEqual(TopicRules.icons.count, 12)
    }

    func testByLine() {
        L10n.choice = .es
        defer { L10n.choice = .system }
        let names = ["u2": "Laura Gómez", "u3": "Mateo Ruiz"]
        XCTAssertNil(TopicRules.byLine(msg("1", topic: "a", by: "u1", author: "u1"), me: "u9") { names[$0] }, "lo puso el autor")
        XCTAssertEqual(TopicRules.byLine(msg("2", topic: "a", by: "u2", author: "u1"), me: "u9") { names[$0] }, "tema puesto por Laura")
        XCTAssertEqual(TopicRules.byLine(msg("3", topic: "a", by: "u9", author: "u1"), me: "u9") { names[$0] }, "tema puesto por Tú")
        XCTAssertNil(TopicRules.byLine(msg("4", topic: nil, by: "u2"), me: "u9") { names[$0] })
    }

    func testStringsAndTasksRename() {
        L10n.choice = .es
        defer { L10n.choice = .system }
        XCTAssertEqual(L("topic.placeholder", ["name": "Finanzas"]), "Mensaje en Finanzas")
        XCTAssertEqual(L("topic.removeConfirm", ["name": "Finanzas", "n": 3]), "¿Quitar «Finanzas»? 3 mensajes quedan sin tema. No se borra ningún mensaje.")
        XCTAssertEqual(L("bar.issues"), "Tareas")
        XCTAssertEqual(L("menu.issue"), "Crear tarea")
        XCTAssertEqual(L("bar.threads"), "Hilos", "los hilos no se quitan")
        L10n.choice = .en
        XCTAssertEqual(L("topic.all"), "All")
        XCTAssertEqual(L("bar.issues"), "Tasks")
    }
}

/// Tarjeta de tarea en el chat (docs/TEMAS.md): qué mensajes la muestran, filtro por tema y comentarios.
final class TaskCardTests: XCTestCase {
    private func sys(_ body: String) -> MessageDTO {
        MessageDTO(id: UUID().uuidString, conversationId: "c1", seq: 1, authorId: "u1", clientMessageId: nil, kind: "system", body: body, createdAt: "")
    }
    private func issue(_ json: String) throws -> IssueDTO { try JSONDecoder().decode(IssueDTO.self, from: Data(json.utf8)) }

    func testOnlyTopLevelIssueCreated() {
        XCTAssertEqual(TaskCard.issueId(sys(#"{"k":"issue.created","issueId":"i1","title":"Pagar"}"#)), "i1")
        XCTAssertNil(TaskCard.issueId(sys(#"{"k":"issue.created","issueId":"i2","parentIssueId":"i1"}"#)), "las derivadas siguen como línea")
        XCTAssertEqual(TaskCard.issueId(sys(#"{"k":"issue.created","issueId":"i3","parentIssueId":null}"#)), "i3")
        XCTAssertNil(TaskCard.issueId(sys(#"{"k":"issue.closed","issueId":"i1"}"#)))
        XCTAssertNil(TaskCard.issueId(sys(#"{"k":"issue.created"}"#)))
        var text = sys(#"{"k":"issue.created","issueId":"i1"}"#); text.kind = "text"
        XCTAssertNil(TaskCard.issueId(text), "solo mensajes de sistema")
    }

    func testIssueTopicIdTolerant() throws {
        XCTAssertEqual(try issue(#"{"id":"i1","title":"x","topicId":"t1"}"#).topicId, "t1")
        XCTAssertNil(try issue(#"{"id":"i1","title":"x"}"#).topicId, "servidor anterior")
        XCTAssertNil(try issue(#"{"id":"i1","title":"x","topicId":null}"#).topicId)
    }

    func testFilterIncludesCardsOfThatTopic() throws {
        let issues = ["i1": try issue(#"{"id":"i1","title":"x","topicId":"t1"}"#), "i2": try issue(#"{"id":"i2","title":"y"}"#)]
        let card1 = sys(#"{"k":"issue.created","issueId":"i1"}"#), card2 = sys(#"{"k":"issue.created","issueId":"i2"}"#)
        let other = sys(#"{"k":"members.added","names":"Ana"}"#)
        var m = MessageDTO(id: "m", conversationId: "c1", seq: 2, authorId: "u1", clientMessageId: nil, body: "hola", createdAt: ""); m.topicId = "t1"
        XCTAssertTrue(TaskCard.matches(card1, filter: "t1", issues: issues))
        XCTAssertFalse(TaskCard.matches(card2, filter: "t1", issues: issues))
        XCTAssertFalse(TaskCard.matches(other, filter: "t1", issues: issues))
        XCTAssertTrue(TaskCard.matches(m, filter: "t1", issues: issues))
        XCTAssertTrue(TaskCard.matches(other, filter: nil, issues: issues), "sin filtro, todo")
    }

    func testLastTwoCommentsAndEdge() throws {
        let d = try JSONDecoder().decode(IssueDetail.self, from: Data(#"""
        {"issue":{"id":"i1","title":"x","status":"open","commentCount":3},"children":[],
         "events":[{"id":1,"kind":"created","actorId":"u1","payload":{}},{"id":2,"kind":"comment","actorId":"u1","payload":{"body":"uno"}},
                   {"id":3,"kind":"comment","actorId":"u2","payload":{"body":"dos"}},{"id":4,"kind":"status","actorId":"u1","payload":{}},
                   {"id":5,"kind":"comment","actorId":"u1","payload":{"body":"tres"}}]}
        """#.utf8))
        XCTAssertEqual(TaskCard.lastComments(d.events).map(TaskCard.commentBody), ["dos", "tres"])
        XCTAssertEqual(TaskCard.edge(try issue(#"{"id":"a","title":"x","status":"done"}"#)), .done)
        XCTAssertEqual(TaskCard.edge(try issue(#"{"id":"b","title":"x","status":"open","dueDate":"2020-01-01"}"#)), .overdue)
        XCTAssertEqual(TaskCard.edge(try issue(#"{"id":"c","title":"x","status":"open"}"#)), .normal)
    }

    func testTaskStrings() {
        L10n.choice = .es
        defer { L10n.choice = .system }
        XCTAssertEqual(L("task.card", ["name": "Laura"]), "Tarea de Laura")
        XCTAssertEqual(L10n.systemText(#"{"k":"issue.closed","title":"Pagar"}"#), "Cerró la tarea «Pagar».")
    }
}
