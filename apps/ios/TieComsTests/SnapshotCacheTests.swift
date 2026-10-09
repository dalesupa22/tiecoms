import XCTest
@testable import TieComs

/// 1.7.0 · Velocidad: la caché local se guarda y se lee igual (por usuario y servidor), recorta a 30 chats × 50 mensajes
/// y la precarga elige los chats con no leídos o fijados.
@MainActor
final class SnapshotCacheTests: XCTestCase {
    private func boot() throws -> BootstrapDTO {
        try JSONDecoder().decode(BootstrapDTO.self, from: Data(#"""
        {"contract":"2026-09-29","me":{"id":"u-snap","name":"Ana","messageSound":"gota"},"features":{"calls":true},
         "organizations":[{"id":"o1","name":"Xertify"}],
         "conversations":[
           {"id":"c1","kind":"direct","memberIds":["u-snap","b"],"unread":3,"lastMessageAt":"2026-09-29T10:00:00Z","canPost":true,"sound":"none"},
           {"id":"c2","kind":"group","name":"Pagos","memberIds":["u-snap"],"pinnedAt":"2026-09-01T00:00:00Z","lastMessageAt":"2026-09-28T10:00:00Z"},
           {"id":"c3","kind":"group","name":"Leído","memberIds":["u-snap"],"lastMessageAt":"2026-09-27T10:00:00Z"}],
         "people":[{"id":"b","name":"Bruno"}]}
        """#.utf8))
    }

    func testRoundTripPerUserAndServer() throws {
        let d = try boot()
        var m = MessageDTO(id: "m1", conversationId: "c1", seq: 7, authorId: "b", clientMessageId: nil, body: "Ver #Pagos", createdAt: "2026-09-29T10:00:00Z")
        m.refs = [MessageRef(conversationId: "c2", name: "Pagos", start: 4, length: 6)]
        m.mentions = [Mention(userId: "u-snap", start: 0, length: 3)]
        let many = (1...80).map { MessageDTO(id: "x\($0)", conversationId: "c2", seq: $0, authorId: "b", clientMessageId: nil, body: "n\($0)", createdAt: "") }
        let snap = SnapshotCache.make(d, blocked: ["z"], conversations: [
            "c1": ConversationState(messages: [m], lastEventSeq: 9, hasMore: false, loaded: true),
            "c2": ConversationState(messages: many, lastEventSeq: 80, hasMore: false, loaded: true),
            "c3": ConversationState(messages: [], lastEventSeq: 0, hasMore: true, loaded: false),
        ])
        XCTAssertEqual(snap.conversations["c2"]?.messages.count, 50, "los últimos 50")
        XCTAssertEqual(snap.conversations["c2"]?.messages.first?.seq, 31)
        XCTAssertEqual(snap.conversations["c2"]?.hasMore, true, "recortado: hay más atrás")
        XCTAssertNil(snap.conversations["c3"], "sin mensajes cargados no se guarda")
        let data = try JSONEncoder().encode(snap)
        let back = try JSONDecoder().decode(AppSnapshot.self, from: data)
        XCTAssertEqual(back.bootstrap.me.id, "u-snap"); XCTAssertEqual(back.bootstrap.me.messageSound, "gota")
        XCTAssertTrue(back.bootstrap.callsEnabled)
        XCTAssertEqual(back.bootstrap.conversations.map(\.id), ["c1", "c2", "c3"])
        XCTAssertEqual(back.bootstrap.conversations.first?.unread, 3); XCTAssertEqual(back.bootstrap.conversations.first?.sound, "none")
        XCTAssertEqual(back.conversations["c1"]?.messages.first?.refs.first?.name, "Pagos", "los mensajes vuelven con refs y menciones")
        XCTAssertEqual(back.conversations["c1"]?.messages.first?.mentions.first?.userId, "u-snap")
        XCTAssertEqual(back.blocked, ["z"])
        XCTAssertNotEqual(SnapshotCache.file("u", apiHost: "a.com"), SnapshotCache.file("u", apiHost: "b.com"), "por servidor")
    }

    func testRestoreFromDiskAndPrefetchCandidates() throws {
        let d = try boot()
        let host = "synthetic.invalid"
        let snap = SnapshotCache.make(d, blocked: [], conversations: [
            "c1": ConversationState(messages: [MessageDTO(id: "m1", conversationId: "c1", seq: 1, authorId: "b", clientMessageId: nil, body: "hola", createdAt: "")],
                                    lastEventSeq: 1, hasMore: false, loaded: true)])
        try JSONEncoder().encode(snap).write(to: SnapshotCache.file("u-snap", apiHost: host))
        let saved = Prefs.lastUserId
        defer { Prefs.lastUserId = saved; try? FileManager.default.removeItem(at: SnapshotCache.file("u-snap", apiHost: host)) }
        Prefs.lastUserId = "u-snap"
        let s = try ControlledURLProtocol.store()
        XCTAssertTrue(s.restoreSnapshot())
        XCTAssertEqual(s.data?.me.id, "u-snap")
        XCTAssertEqual(s.conversations["c1"]?.messages.first?.body, "hola")
        XCTAssertEqual(s.conversations["c1"]?.loaded, true, "abre al instante y luego solo pide lo nuevo (catch-up)")
        XCTAssertEqual(AppStore.prefetchCandidates(d, loaded: ["c1"]), ["c2"], "no leídos o fijados, sin los ya cargados")
        XCTAssertEqual(AppStore.prefetchCandidates(d, loaded: []), ["c1", "c2"])
        Prefs.lastUserId = "otra"
        XCTAssertFalse(s.restoreSnapshot(), "de otra cuenta, nada")
    }
}
