import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }

/// 1.6.6 · Pendientes del árbol y «Marcar como leído» (docs/TANDA-LECTURA-REUNIONES.md §1).
/// El caso de Danny: «Estudio Norte · General» leído (unread 0) con dos derivadas nunca abiertas que suman 11.
@MainActor
final class TreeReadTests: XCTestCase {
    private let json = #"""
    {"contract":"2026-09-28","serverTime":"","me":{"id":"me","name":"Danny","kind":"human","primaryOrgId":"oA"},
     "organizations":[{"id":"oA","name":"Xertify","myRole":"owner"},{"id":"oN","name":"Estudio Norte"}],
     "workspaces":[{"id":"wN","name":"Estudio Norte","owningOrgId":"oA","organizationIds":["oA","oN"],"memberIds":["me","bo"],"myRole":"lead","createdAt":"2026-09-01"}],
     "conversations":[
       {"id":"gen","workspaceId":"wN","kind":"group","name":"General","memberIds":["me","bo"],"lastMessageSeq":40,"lastReadSeq":40,"unread":0,"lastMessageAt":"2026-09-27T10:00:00Z"},
       {"id":"diag","workspaceId":"wN","kind":"internal","name":"Diagnóstico · notificaciones duplicadas","parentId":"gen","deriveKind":"internal","memberIds":["me"],"lastMessageSeq":5,"lastReadSeq":0,"unread":5,"lastMessageAt":"2026-09-26T10:00:00Z"},
       {"id":"dec","workspaceId":"wN","kind":"group","name":"Decisión · fecha de salida","parentId":"gen","deriveKind":"directive","memberIds":["me","bo"],"lastMessageSeq":6,"lastReadSeq":0,"unread":6,"unreadMentions":1,"lastMessageAt":"2026-09-25T10:00:00Z"},
       {"id":"old","workspaceId":"wN","kind":"group","name":"Hilo · leído","parentId":"gen","deriveKind":"same","memberIds":["me","bo"],"lastMessageSeq":3,"lastReadSeq":3,"unread":0},
       {"id":"side","workspaceId":"wN","kind":"multi","name":"Sidechat · ¿llega?","parentId":"gen","deriveKind":"side","memberIds":["me","bo"],"lastMessageSeq":3,"lastReadSeq":0,"unread":3},
       {"id":"otro","workspaceId":"wN","kind":"group","name":"Pagos","memberIds":["me","bo"],"lastMessageSeq":9,"lastReadSeq":9,"unread":0,"lastMessageAt":"2026-09-20T10:00:00Z"}],
     "people":[{"id":"me","name":"Danny","kind":"human","orgId":"oA"},{"id":"bo","name":"Bo","kind":"human","orgId":"oN"}]}
    """#

    private func boot() throws -> BootstrapDTO { try dec(BootstrapDTO.self, json) }

    func testDannysCaseCountsTheTreeEverywhere() throws {
        let d = try boot()
        let gen = try XCTUnwrap(d.conversations.first { $0.id == "gen" })
        let t = ReadTree.pending(d, gen)
        XCTAssertEqual(t.unread, 11, "5 + 6 de las derivadas; el sidechat (3) no cuenta: vive en DMs")
        XCTAssertEqual(t.mentions, 1)
        XCTAssertEqual(t.derivedCount, 2, "la derivada ya leída no cuenta")
        XCTAssertTrue(t.canMarkRead, "el menú ofrece «Marcar como leído», no «Marcar como no leído»")
        XCTAssertEqual(HomeFilter.unread.groupCount(d), 1, "el filtro «No leídos» deja de decir 0")
        XCTAssertEqual(HomeFilter.mentions.groupCount(d), 1, "la mención del árbol cuenta")
        XCTAssertEqual(Naming.groupsUnread(d), 11, "globo de Grupos: el mismo número que la fila")
        let rows = Naming.groupsList(d, tab: .unread)
        XCTAssertEqual(rows.map(\.id), ["gen"], "la sección y el filtro «No leídos» usan la misma regla")
        XCTAssertEqual(rows.first?.threadUnread, 11, "chip «⑂ 11»")
        XCTAssertEqual(InboxBucket.split(Naming.groupsList(d), conv: \.conv, extraUnread: { $0.tree.derivedUnread }).first { $0.bucket == .unread }?.items.map(\.id), ["gen"])
    }

    func testReadTreeItemsUseKnownSeqAndSkipSidechatsAndReadOnes() throws {
        let d = try boot()
        let gen = try XCTUnwrap(d.conversations.first { $0.id == "gen" })
        let items = ReadTree.items(d, gen)
        XCTAssertEqual(items, [.init(conversationId: "gen", seq: 40), .init(conversationId: "dec", seq: 6), .init(conversationId: "diag", seq: 5)],
                       "el grupo siempre; luego la derivada con mención y la de más sin leer; nunca el sidechat ni la ya leída")
        XCTAssertEqual(items.map(\.json).first?["seq"] as? Int, 40)
    }

    func testMessageArrivingWhileMarkingStaysUnread() throws {
        var dec = try XCTUnwrap(try boot().conversations.first { $0.id == "dec" })
        let known = dec.lastMessageSeq            // 6: lo que el cliente conoce al tocar «Marcar como leído»
        dec.lastMessageSeq = 8; dec.unread = 8    // llegan dos mensajes nuevos antes de la respuesta
        ReadTree.applyRead(&dec, seq: known)
        XCTAssertEqual(dec.lastReadSeq, 6)
        XCTAssertEqual(dec.unread, 2, "lo que llegó después sigue sin leer (sin carrera)")
        XCTAssertEqual(dec.unreadMentions, 1, "sin llegar al final no se borra la mención")
        ReadTree.applyRead(&dec, seq: 5)
        XCTAssertEqual(dec.lastReadSeq, 6, "el cursor nunca retrocede")
        ReadTree.applyRead(&dec, seq: 8)
        XCTAssertEqual(dec.unread, 0); XCTAssertEqual(dec.unreadMentions, 0)
    }

    func testOldMentionInMutedThreadStillCounts() throws {
        var d = try boot()
        let i = try XCTUnwrap(d.conversations.firstIndex { $0.id == "dec" })
        d.conversations[i].mutedUntil = "2099-01-01T00:00:00Z"
        d.conversations[i].unread = 1
        if let j = d.conversations.firstIndex(where: { $0.id == "diag" }) { d.conversations[j].unread = 0 }
        let gen = try XCTUnwrap(d.conversations.first { $0.id == "gen" })
        let t = ReadTree.pending(d, gen)
        XCTAssertEqual(t.pending, 1, "silenciado, pero con mención: cuenta")
        XCTAssertTrue(t.isUnread)
        XCTAssertEqual(HomeFilter.unread.groupCount(d), 1)
        XCTAssertEqual(HomeFilter.mentions.groupCount(d), 1, "una mención antigua en un hilo sigue visible desde fuera")
    }

    func testMutedThreadWithoutMentionDoesNotCountButCanBeMarked() throws {
        var d = try boot()
        for id in ["dec", "diag"] {
            let i = try XCTUnwrap(d.conversations.firstIndex { $0.id == id })
            d.conversations[i].mutedUntil = "2099-01-01T00:00:00Z"; d.conversations[i].unreadMentions = 0
        }
        let gen = try XCTUnwrap(d.conversations.first { $0.id == "gen" })
        let t = ReadTree.pending(d, gen)
        XCTAssertEqual(t.pending, 0, "silenciadas sin mención: no suman en la bandeja ni en el globo")
        XCTAssertEqual(Naming.groupsUnread(d), 0)
        XCTAssertTrue(t.canMarkRead, "pero se pueden marcar como leídas")
    }

    func testNothingPendingOffersMarkUnread() throws {
        let d = try boot()
        let otro = try XCTUnwrap(d.conversations.first { $0.id == "otro" })
        XCTAssertFalse(ReadTree.pending(d, otro).canMarkRead)
        XCTAssertEqual(ReadTree.items(d, otro), [.init(conversationId: "otro", seq: 9)])
    }

    func testChatThreadsCountInDMsRow() throws {
        let d = try dec(BootstrapDTO.self, #"""
        {"me":{"id":"me","name":"A","kind":"human"},"organizations":[],"workspaces":[],"people":[],
         "conversations":[{"id":"dm","kind":"direct","memberIds":["me","b"],"lastMessageSeq":4,"lastReadSeq":4},
                          {"id":"th","kind":"multi","parentId":"dm","deriveKind":"same","memberIds":["me","b"],"lastMessageSeq":3,"unread":3},
                          {"id":"sd","kind":"multi","parentId":"dm","deriveKind":"side","memberIds":["me","b"],"lastMessageSeq":2,"unread":2}]}
        """#)
        XCTAssertEqual(Naming.chatThreadUnread(d)["dm"], 3, "el hilo cuenta en la fila del directo; el sidechat tiene su propia fila")
    }

    // MARK: Cursor de lectura: solo lo visto

    private func message(_ conv: String, _ seq: Int, mention: Bool = false) throws -> MessageDTO {
        try dec(MessageDTO.self, #"{"id":"m\#(seq)","conversationId":"\#(conv)","seq":\#(seq),"authorId":"bo","kind":"text","body":"hola","createdAt":"2026-09-27T10:00:00.000Z"\#(mention ? #","mentions":[{"userId":"me","start":0,"length":4}]"# : "")}"#)
    }

    func testPartialReadOnlyAdvancesToWhatWasSeen() throws {
        let s = AppStore(baseURL: URL(string: "http://127.0.0.1:9")!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: nil)
        var d = try boot()
        let i = try XCTUnwrap(d.conversations.firstIndex { $0.id == "gen" })
        // 70 mensajes, leídos hasta el 30, con una mención en el 55 (fuera de la primera pantalla).
        d.conversations[i].lastMessageSeq = 70; d.conversations[i].lastReadSeq = 30; d.conversations[i].unread = 40; d.conversations[i].unreadMentions = 1
        let msgs = try (21...70).map { try message("gen", $0, mention: $0 == 55) }
        s.seedForTesting(d, conversations: ["gen": ConversationState(messages: msgs, lastEventSeq: 70, hasMore: true, loaded: true)])
        s.markRead("gen", upTo: 38)
        XCTAssertEqual(s.meta("gen")?.lastReadSeq, 38)
        XCTAssertEqual(s.meta("gen")?.unread, 32, "lo que no se vio sigue sin leer")
        XCTAssertEqual(s.meta("gen")?.unreadMentions, 1, "la mención del 55 no se vio")
        s.markRead("gen", upTo: 35)
        XCTAssertEqual(s.meta("gen")?.lastReadSeq, 38, "nunca retrocede")
        s.markRead("gen", upTo: 60)
        XCTAssertEqual(s.meta("gen")?.unreadMentions, 0, "ya pasó la mención")
        s.markRead("gen")
        XCTAssertEqual(s.meta("gen")?.unread, 0)
    }
}
