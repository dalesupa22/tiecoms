import XCTest
@testable import TieComs

/// Reglas de sincronización del store sin red: duplicados, huecos, tipos
/// desconocidos, reconciliación y sonidos solo en vivo.
@MainActor
final class StoreSyncTests: XCTestCase {
    var store: AppStore!
    var spy: FeedbackSpy!

    private let bootstrapJSON = #"""
    {"contract":"2026-09-23","serverTime":"2026-09-23T10:00:00Z","me":{"id":"me","name":"Ana","kind":"human","primaryOrgId":"o1"},
     "organizations":[{"id":"o1","name":"A","mark":"A","colorBg":"#000000","colorFg":"#ffffff","myRole":"owner"},{"id":"o2","name":"B","mark":"B","colorBg":"#ffffff","colorFg":"#000000"}],
     "workspaces":[{"id":"w1","name":"Obra","owningOrgId":"o1","organizationIds":["o1","o2"],"memberIds":["me","bob"],"myRole":"lead","createdAt":"2026-09-01T00:00:00Z"}],
     "conversations":[
       {"id":"c1","workspaceId":"w1","kind":"group","name":"General","memberIds":["me","bob"],"lastMessageSeq":2,"lastEventSeq":5,"lastReadSeq":2,"unread":0,"canPost":true,"historyFromSeq":0,"lastMessageAt":"2026-09-23T09:00:00Z"},
       {"id":"c2","workspaceId":"w1","kind":"internal","name":"Equipo interno","memberIds":["me"],"lastMessageSeq":0,"lastEventSeq":0,"lastReadSeq":0,"unread":0,"canPost":true,"historyFromSeq":0}
     ],
     "people":[{"id":"me","name":"Ana","kind":"human","orgId":"o1","guest":false},{"id":"bob","name":"Bob","kind":"human","orgId":"o2","guest":false}]}
    """#

    override func setUp() async throws {
        spy = FeedbackSpy()
        // Puerto cerrado: cualquier catch-up falla rápido sin tocar ningún servidor.
        store = AppStore(baseURL: URL(string: "http://127.0.0.1:9")!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: spy)
        let d = try JSONDecoder().decode(BootstrapDTO.self, from: jsonData(bootstrapJSON))
        store.seedForTesting(d, conversations: ["c1": ConversationState(messages: [], lastEventSeq: 5, hasMore: false, loaded: true)])
        store.openConversationId = "c1"
    }

    private func created(_ conv: String, _ eventSeq: Int, seq: Int, author: String = "bob", kind: String = "text", body: String = "hola", cid: String? = nil) -> ConversationEvent {
        let cidJSON = cid.map { "\"\($0)\"" } ?? "null"
        let json = #"{"type":"message.created","conversationId":"\#(conv)","eventSeq":\#(eventSeq),"message":{"id":"m\#(conv)\#(seq)","conversationId":"\#(conv)","seq":\#(seq),"authorId":"\#(author)","clientMessageId":\#(cidJSON),"kind":"\#(kind)","body":"\#(body)","createdAt":"2026-09-23T10:00:00.000Z"}}"#
        return try! JSONDecoder().decode(ConversationEvent.self, from: jsonData(json))
    }

    private func other(_ type: String, _ seq: Int) -> ConversationEvent {
        try! JSONDecoder().decode(ConversationEvent.self, from: jsonData(#"{"type":"\#(type)","conversationId":"c1","eventSeq":\#(seq)}"#))
    }

    func testContinuousEventIsAppliedAndPlaysReceive() {
        store.onConversationEvent(created("c1", 6, seq: 3), live: true)
        XCTAssertEqual(store.conversations["c1"]?.lastEventSeq, 6)
        XCTAssertEqual(store.conversations["c1"]?.messages.map(\.seq), [3])
        XCTAssertEqual(store.meta("c1")?.lastMessageSeq, 3)
        XCTAssertEqual(spy.receives, 1)
        XCTAssertTrue(spy.notifications.isEmpty)
    }

    func testBlockedAuthorsDoNotPlaySoundsOrNotifyButKeepEventCursor() {
        store.blockedUserIds = ["bob"]
        store.onConversationEvent(created("c1", 6, seq: 3), live: true)
        store.openConversationId = nil
        store.onConversationEvent(created("c1", 7, seq: 4), live: true)
        XCTAssertEqual(spy.receives, 0)
        XCTAssertTrue(spy.notifications.isEmpty)
        XCTAssertEqual(store.conversations["c1"]?.lastEventSeq, 7)
    }

    func testDuplicateEventIsDiscarded() {
        store.onConversationEvent(created("c1", 6, seq: 3), live: true)
        store.onConversationEvent(created("c1", 6, seq: 3), live: true)
        store.onConversationEvent(created("c1", 4, seq: 1), live: true)
        XCTAssertEqual(store.conversations["c1"]?.messages.count, 1)
        XCTAssertEqual(spy.receives, 1, "un duplicado no vuelve a sonar")
    }

    func testGapDoesNotAdvanceCursor() {
        store.onConversationEvent(created("c1", 9, seq: 3), live: true)
        XCTAssertEqual(store.conversations["c1"]?.lastEventSeq, 5, "con hueco no se aplica: se pide catch-up por REST")
        XCTAssertTrue(store.conversations["c1"]?.messages.isEmpty ?? false)
    }

    func testUnknownRedactedAndIssueEventsAdvanceCursor() {
        store.onConversationEvent(other("issue.updated", 6), live: true)
        store.onConversationEvent(other("redacted", 7), live: true)
        store.onConversationEvent(other("tipo.del.futuro", 8), live: true)
        XCTAssertEqual(store.conversations["c1"]?.lastEventSeq, 8)
        store.onConversationEvent(created("c1", 9, seq: 3), live: true)
        XCTAssertEqual(store.conversations["c1"]?.messages.count, 1)
    }

    func testSystemMessagesAndOwnMessagesDoNotSound() {
        store.onConversationEvent(created("c1", 6, seq: 3, kind: "system", body: #"{\"k\":\"group.created\",\"name\":\"x\"}"#), live: true)
        store.onConversationEvent(created("c1", 7, seq: 4, author: "me"), live: true)
        XCTAssertEqual(spy.receives, 0)
        XCTAssertTrue(spy.notifications.isEmpty)
    }

    func testOtherConversationNotifiesAndCountsUnread() {
        store.onConversationEvent(created("c2", 1, seq: 1, body: "¿listo?"), live: true)
        XCTAssertEqual(spy.notifications.map(\.conversationId), ["c2"])
        XCTAssertEqual(store.meta("c2")?.unread, 1)
        XCTAssertEqual(spy.receives, 0)
        // Conversaciones con actividad suben al principio.
        XCTAssertEqual(store.data?.conversations.first?.id, "c2")
    }

    func testCatchUpEventsDoNotSound() {
        store.onConversationEvent(created("c1", 6, seq: 3), live: false)
        XCTAssertEqual(spy.receives, 0)
        XCTAssertEqual(store.conversations["c1"]?.messages.count, 1)
    }

    func testOwnMessageReconcilesPendingByClientMessageId() {
        let p = store.send("c1", body: "desde la cola")!
        XCTAssertEqual(store.pendingFor("c1").count, 1)
        store.onConversationEvent(created("c1", 6, seq: 3, author: "me", body: "desde la cola", cid: p.clientMessageId), live: true)
        XCTAssertEqual(store.pendingFor("c1").count, 0)
        XCTAssertTrue(store.pending.isEmpty, "el message.created propio reconcilia la cola sin duplicar")
        XCTAssertEqual(store.conversations["c1"]?.messages.count, 1)
    }

    func testUpsertKeepsOrderAndReplaces() throws {
        let a = try JSONDecoder().decode(MessageDTO.self, from: jsonData(#"{"id":"a","seq":1,"authorId":"x","body":"1","createdAt":""}"#))
        let b = try JSONDecoder().decode(MessageDTO.self, from: jsonData(#"{"id":"b","seq":3,"authorId":"x","body":"3","createdAt":""}"#))
        let c = try JSONDecoder().decode(MessageDTO.self, from: jsonData(#"{"id":"c","seq":2,"authorId":"x","body":"2","createdAt":""}"#))
        var list = AppStore.upsert([], a)
        list = AppStore.upsert(list, b)
        list = AppStore.upsert(list, c)
        XCTAssertEqual(list.map(\.seq), [1, 2, 3])
        var edited = c; edited.body = "editado"
        list = AppStore.upsert(list, edited)
        XCTAssertEqual(list.count, 3)
        XCTAssertEqual(list[1].body, "editado")
    }

    func testNamingAndSections() throws {
        let d = store.data!
        XCTAssertEqual(Naming.title(d, store.meta("c1")!), "General")
        let sections = Naming.sections(d, filterWorkspace: nil, query: "")
        XCTAssertEqual(sections.first?.title, "Obra")
        XCTAssertEqual(Naming.sections(d, filterWorkspace: nil, query: "bob").flatMap(\.conversations).map(\.id), ["c1"])
        XCTAssertEqual(Naming.subtitle(d, store.meta("c1")!), "A · B")
    }

    func testDeepLinkWithoutAccessShowsAlert() {
        store.navigate(to: .conversation("no-es-mia"))
        XCTAssertNotNil(store.alert)
        XCTAssertTrue(store.homePath.isEmpty)
        store.alert = nil
        store.navigate(to: .conversation("c1"))
        XCTAssertEqual(store.homePath, [.conversation("c1")])
        store.navigate(to: .workspace("w1"))
        XCTAssertEqual(store.workspaceFilter, "w1")
    }
}
