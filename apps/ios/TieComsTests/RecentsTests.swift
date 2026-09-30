import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }

/// «Recientes»: al enviar o recibir, el chat sube y su vista previa y hora se actualizan (lastHumanPreview en bumpMeta,
/// como humanPreviewOf de client-core, web 51b7536, y TieComsClient.bumpMeta de Android).
@MainActor
final class RecentsTests: XCTestCase {
    private func store() throws -> AppStore {
        let d = try dec(BootstrapDTO.self, #"""
        {"contract":"x","serverTime":"","me":{"id":"me","name":"Ana","kind":"human","primaryOrgId":"o1"},"organizations":[],
         "conversations":[
          {"id":"fidel","kind":"direct","memberIds":["me","f"],"lastMessageSeq":5,"lastEventSeq":5,"lastReadSeq":5,"canPost":true,"lastMessageAt":"2026-09-29T10:00:00Z",
           "lastHumanPreview":{"messageId":"mf","seq":5,"authorId":"f","body":"Nos vemos","createdAt":"2026-09-29T10:00:00Z"}},
          {"id":"harold","kind":"direct","memberIds":["me","h"],"lastMessageSeq":3,"lastEventSeq":3,"lastReadSeq":3,"canPost":true,"lastMessageAt":"2026-09-29T09:00:00Z",
           "lastHumanPreview":{"messageId":"mh","seq":3,"authorId":"h","body":"Hola","createdAt":"2026-09-29T09:00:00Z"}}],
         "people":[{"id":"me","name":"Ana"},{"id":"f","name":"Fidel"},{"id":"h","name":"Harold"}]}
        """#)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("recents-\(UUID().uuidString)")
        let s = AppStore(baseURL: URL(string: "https://mock.chaggu.test")!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: dir), feedback: nil)
        s.seedForTesting(d)
        return s
    }
    private func event(_ conv: String, seq: Int, author: String, body: String, kind: String = "text", at: String, viewOnce: Bool = false) throws -> ConversationEvent {
        try dec(ConversationEvent.self, #"{"type":"message.created","conversationId":"\#(conv)","eventSeq":\#(seq),"message":{"id":"m\#(conv)\#(seq)","conversationId":"\#(conv)","seq":\#(seq),"authorId":"\#(author)","kind":"\#(kind)","body":"\#(body)","createdAt":"\#(at)","viewOnce":\#(viewOnce)}}"#)
    }
    private func ordered(_ s: AppStore) -> [String] { (s.data?.conversations ?? []).sorted(by: HomeOrder.before).map(\.id) }

    func testMyMessageBringsChatUpWithFreshPreview() throws {
        let s = try store()
        XCTAssertEqual(ordered(s), ["fidel", "harold"], "Fidel es más reciente")
        s.onConversationEvent(try event("harold", seq: 4, author: "me", body: "¿Llegó el pago?", at: "2026-09-29T11:00:00Z"), live: true)
        XCTAssertEqual(ordered(s), ["harold", "fidel"], "mi mensaje sube a Harold")
        let h = try XCTUnwrap(s.meta("harold"))
        XCTAssertEqual(HomeOrder.activity(h), "2026-09-29T11:00:00Z", "actividad nueva")
        XCTAssertEqual(h.lastHumanPreview?.body, "¿Llegó el pago?"); XCTAssertEqual(h.lastHumanPreview?.authorId, "me"); XCTAssertEqual(h.lastHumanPreview?.seq, 4)
        XCTAssertEqual(L10n.listPreview(h), "¿Llegó el pago?", "la vista previa es la mía")
        // Un aviso de sistema no cambia lastHumanPreview ni la actividad.
        s.onConversationEvent(try event("harold", seq: 5, author: "h", body: #"{\"k\":\"members.added\"}"#, kind: "system", at: "2026-09-29T12:00:00Z"), live: true)
        XCTAssertEqual(s.meta("harold")?.lastHumanPreview?.body, "¿Llegó el pago?")
        XCTAssertEqual(HomeOrder.activity(s.meta("harold")!), "2026-09-29T11:00:00Z")
        // Una sola vista: sin el contenido.
        s.onConversationEvent(try event("fidel", seq: 6, author: "f", body: "secreto", at: "2026-09-29T13:00:00Z", viewOnce: true), live: true)
        XCTAssertEqual(ordered(s).first, "fidel")
        XCTAssertEqual(s.meta("fidel")?.lastHumanPreview?.body, ""); XCTAssertTrue(s.meta("fidel")?.lastHumanPreview?.viewOnce == true)
    }
}
