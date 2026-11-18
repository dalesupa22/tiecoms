import XCTest
import Observation
@testable import TieComs

/// CH035 (fluidez, tanda 2): colocar el chat con lo que ya está en memoria, derivados memorizados, y lo que del snapshot
/// casi no cambia separado de `data` para que un mensaje en otro chat no vuelva a evaluar media app.
@MainActor
final class CH035Tanda2Tests: XCTestCase {
    private func bootstrap() throws -> BootstrapDTO {
        let json = #"""
        {"contract":"2026-09-29.1","serverTime":"2026-11-18T10:00:00Z","me":{"id":"me","name":"Ana","kind":"human","primaryOrgId":"o1"},
         "organizations":[{"id":"o1","name":"A","mark":"A","colorBg":"#000000","colorFg":"#ffffff","myRole":"owner"}],
         "workspaces":[],
         "conversations":[
           {"id":"c1","kind":"group","name":"General","memberIds":["me","bob"],"lastMessageSeq":3,"lastEventSeq":3,"lastReadSeq":3,"unread":0,"canPost":true,"historyFromSeq":0,"lastMessageAt":"2026-11-18T09:00:00Z"},
           {"id":"c2","kind":"group","name":"Otro","memberIds":["me","bob"],"lastMessageSeq":1,"lastEventSeq":1,"lastReadSeq":1,"unread":0,"canPost":true,"historyFromSeq":0,"lastMessageAt":"2026-11-18T08:00:00Z"}
         ],
         "people":[{"id":"me","name":"Ana","kind":"human","orgId":"o1","guest":false},{"id":"bob","name":"Bob","kind":"human","orgId":"o1","guest":false}]}
        """#
        return try JSONDecoder().decode(BootstrapDTO.self, from: jsonData(json))
    }

    private func message(_ seq: Int, author: String = "bob", kind: String = "text", topic: String? = nil, deleted: Bool = false) -> MessageDTO {
        var m = MessageDTO(id: "m\(seq)", conversationId: "c1", seq: seq, authorId: author, clientMessageId: nil, kind: kind, body: "hola \(seq)", createdAt: "2026-11-18T10:00:00.000Z")
        m.topicId = topic
        if deleted { m.deletedAt = "2026-11-18T10:01:00.000Z" }
        return m
    }

    private func store() throws -> AppStore {
        let s = AppStore(baseURL: URL(string: "http://127.0.0.1:9")!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: nil)
        s.seedForTesting(try bootstrap())
        return s
    }

    /// Un mensaje nuevo en `c2`, tal como llega por el socket.
    private func arrive(_ s: AppStore, seq: Int = 2) {
        s.socketEventForTesting("conv.event", #"{"type":"message.created","conversationId":"c2","eventSeq":\#(seq),"message":{"id":"x\#(seq)","conversationId":"c2","seq":\#(seq),"authorId":"bob","kind":"text","body":"nuevo","createdAt":"2026-11-18T10:05:00.000Z"}}"#)
    }

    // MARK: Colocar con lo que hay en memoria

    func testFirstUnreadInMemoryFindsTheFirstFromSomeoneElse() {
        let list = [message(1), message(2), message(3, author: "me"), message(4, kind: "system"), message(5, deleted: true), message(6), message(7)]
        let found = ChatNav.firstUnreadInMemory(list, snapshot: .init(lastReadSeq: 2, unread: 3), historyFromSeq: 0, lastMessageSeq: 7, me: "me", blocked: [])
        XCTAssertEqual(found??.id, "m6", "ni lo mío, ni avisos, ni borrados cuentan como primer no leído")
    }

    func testFirstUnreadInMemorySkipsBlockedAuthors() {
        let list = [message(1), message(2, author: "eve"), message(3)]
        let found = ChatNav.firstUnreadInMemory(list, snapshot: .init(lastReadSeq: 1, unread: 2), historyFromSeq: 0, lastMessageSeq: 3, me: "me", blocked: ["eve"])
        XCTAssertEqual(found??.id, "m3")
    }

    func testFirstUnreadInMemoryNothingUnread() {
        let none = ChatNav.firstUnreadInMemory([message(1)], snapshot: .init(lastReadSeq: 1, unread: 0), historyFromSeq: 0, lastMessageSeq: 1, me: "me", blocked: [])
        XCTAssertNotNil(none, "sin no leídos se sabe ya: va al final")
        XCTAssertNil(none!)
        // Lo no leído era solo mío o avisos, y está todo cargado: tampoco hay divisor.
        let mine = ChatNav.firstUnreadInMemory([message(1), message(2, author: "me")], snapshot: .init(lastReadSeq: 1, unread: 1), historyFromSeq: 0, lastMessageSeq: 2, me: "me", blocked: [])
        XCTAssertNotNil(mine)
        XCTAssertNil(mine!)
    }

    func testFirstUnreadInMemoryUndecidableWithoutHistory() {
        // Lo leído quedó antes de lo cargado: hay que pedir páginas (camino de siempre).
        XCTAssertNil(ChatNav.firstUnreadInMemory([message(8), message(9)], snapshot: .init(lastReadSeq: 3, unread: 6), historyFromSeq: 0, lastMessageSeq: 9, me: "me", blocked: []))
        // Un hueco en lo cargado.
        XCTAssertNil(ChatNav.firstUnreadInMemory([message(1), message(2, author: "me"), message(4)], snapshot: .init(lastReadSeq: 1, unread: 2), historyFromSeq: 0, lastMessageSeq: 4, me: "me", blocked: []))
        // Lo cargado no llega al último mensaje y nada de ello cuenta.
        XCTAssertNil(ChatNav.firstUnreadInMemory([message(1), message(2, author: "me")], snapshot: .init(lastReadSeq: 1, unread: 2), historyFromSeq: 0, lastMessageSeq: 5, me: "me", blocked: []))
        // Entré tarde: el suelo es `historyFromSeq`.
        let late = ChatNav.firstUnreadInMemory([message(6), message(7)], snapshot: .init(lastReadSeq: 0, unread: 2), historyFromSeq: 5, lastMessageSeq: 7, me: "me", blocked: [])
        XCTAssertEqual(late??.id, "m6")
    }

    func testOpenFilterInMemory() throws {
        let topics = try JSONDecoder().decode([TopicDTO].self, from: jsonData(#"[{"id":"t1","conversationId":"c1","name":"Obra","icon":"🚩","color":"orange","position":0},{"id":"t2","conversationId":"c1","name":"Viejo","icon":"🚩","color":"blue","position":1,"archivedAt":"2026-11-01T00:00:00Z"}]"#))
        let plain = [message(1), message(2)]
        let tagged = [message(1), message(2, topic: "t1")]
        let archived = [message(1), message(2, topic: "t2")]
        // Sin la lista de temas: se sabe solo si el primer no leído no trae tema.
        XCTAssertEqual(ChatNav.openFilterInMemory(plain, after: 1, me: "me", topics: nil), .some(nil))
        XCTAssertNil(ChatNav.openFilterInMemory(tagged, after: 1, me: "me", topics: nil), "trae tema y no se sabe si está activo: se espera")
        // Con la lista: la misma regla que `TopicRules.openFilter`.
        XCTAssertEqual(ChatNav.openFilterInMemory(tagged, after: 1, me: "me", topics: topics), .some("t1"))
        XCTAssertEqual(ChatNav.openFilterInMemory(archived, after: 1, me: "me", topics: topics), .some(nil))
        XCTAssertEqual(ChatNav.openFilterInMemory(plain, after: 1, me: "me", topics: topics), .some(nil))
    }

    // MARK: Derivados memorizados

    func testMemoRecomputesOnlyWhenTheKeyChanges() {
        let memo = Memo<[Int], Int>()
        var calls = 0
        let sum: ([Int]) -> Int = { list in memo(list) { calls += 1; return list.reduce(0, +) } }
        XCTAssertEqual(sum([1, 2, 3]), 6)
        XCTAssertEqual(sum([1, 2, 3]), 6)
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(sum([1, 2, 4]), 7)
        XCTAssertEqual(calls, 2)
    }

    // MARK: El snapshot y lo que casi no cambia

    /// ¿Cambia `read` (y avisa a quien lo observa) cuando pasa `change`?
    private func fires(_ read: @escaping () -> Void, when change: () -> Void) -> Bool {
        var fired = false
        withObservationTracking(read) { fired = true }
        change()
        return fired
    }

    func testMessageInAnotherChatDoesNotNotifyWhoOnlyReadsMe() throws {
        let s = try store()
        XCTAssertEqual(s.me?.id, "me")
        XCTAssertFalse(fires({ _ = s.me }, when: { arrive(s) }), "«yo» no cambió: quien solo lee `me` no se vuelve a evaluar")
        XCTAssertFalse(fires({ _ = s.mailEnabled }, when: { arrive(s, seq: 3) }))
        XCTAssertTrue(fires({ _ = s.data }, when: { arrive(s, seq: 4) }), "el snapshot sí cambió (no leídos y orden)")
        XCTAssertEqual(s.meta("c2")?.unread, 3)
    }

    func testMeFollowsTheSnapshot() throws {
        let s = try store()
        XCTAssertTrue(fires({ _ = s.me }, when: { s.patchMe { $0.name = "Ana María" } }))
        XCTAssertEqual(s.me?.name, "Ana María")
        XCTAssertEqual(s.data?.me.name, "Ana María")
    }

    func testHiddenListsFollowACoalescedCopy() async throws {
        let s = try store()
        XCTAssertEqual(s.listData?.conversations.first?.id, "c1", "el primer snapshot llega al momento")
        arrive(s)
        // A la vista: en vivo. Oculta: la copia, que todavía no se movió.
        XCTAssertEqual(s.data(visible: true)?.conversations.first?.id, "c2")
        XCTAssertEqual(s.data(visible: false)?.conversations.first?.id, "c1")
        XCTAssertFalse(fires({ _ = s.listData }, when: { arrive(s, seq: 3) }), "una ráfaga no mueve la copia mensaje a mensaje")
        try await Task.sleep(nanoseconds: AppStore.listDataInterval + 400_000_000)
        XCTAssertEqual(s.listData?.conversations.first?.id, "c2", "pasado el intervalo, la copia se pone al día")
        XCTAssertEqual(s.listData?.conversations.first?.unread, 2)
    }
}
