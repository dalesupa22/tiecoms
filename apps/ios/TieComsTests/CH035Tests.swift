import XCTest
@testable import TieComs

/// CH035 (fluidez, tanda 1): índices de conversaciones, payload de sistema, identidad de fila al confirmar un envío,
/// regla de resync al volver al frente, snapshot sin cambios y cola de envío fuera del hilo principal.
@MainActor
final class CH035Tests: XCTestCase {
    private func bootstrap(serverTime: String = "2026-11-18T10:00:00Z", extra: String = "") throws -> BootstrapDTO {
        let json = #"""
        {"contract":"2026-09-29.1","serverTime":"\#(serverTime)","me":{"id":"me","name":"Ana","kind":"human","primaryOrgId":"o1"},
         "organizations":[{"id":"o1","name":"A","mark":"A","colorBg":"#000000","colorFg":"#ffffff","myRole":"owner"}],
         "workspaces":[],
         "conversations":[
           {"id":"c1","kind":"group","name":"General","memberIds":["me","bob"],"lastMessageSeq":9,"lastEventSeq":9,"lastReadSeq":9,"unread":0,"canPost":true,"historyFromSeq":0,"lastMessageAt":"2026-11-18T09:00:00Z"},
           {"id":"t1","kind":"group","name":"Hilo viejo","memberIds":["me","bob"],"parentId":"c1","parentMessageId":"m1","lastMessageSeq":3,"lastEventSeq":3,"lastReadSeq":3,"unread":0,"canPost":true,"historyFromSeq":0,"lastMessageAt":"2026-11-18T08:00:00Z"},
           {"id":"t2","kind":"group","name":"Hilo nuevo","memberIds":["me","bob"],"parentId":"c1","parentMessageId":"m1","lastMessageSeq":3,"lastEventSeq":3,"lastReadSeq":3,"unread":0,"canPost":true,"historyFromSeq":0,"lastMessageAt":"2026-11-18T09:30:00Z"},
           {"id":"t3","kind":"group","name":"Otro","memberIds":["me","bob"],"parentId":"c1","parentMessageId":"m2","lastMessageSeq":1,"lastEventSeq":1,"lastReadSeq":1,"unread":0,"canPost":true,"historyFromSeq":0,"lastMessageAt":"2026-11-18T07:00:00Z"},
           {"id":"x1","kind":"group","name":"De otro chat","memberIds":["me"],"parentId":"c9","parentMessageId":"m1","lastMessageSeq":1,"lastEventSeq":1,"lastReadSeq":1,"unread":0,"canPost":true,"historyFromSeq":0}
         ],
         "people":[{"id":"me","name":"Ana","kind":"human","orgId":"o1","guest":false},{"id":"bob","name":"Bob","kind":"human","orgId":"o1","guest":false}]\#(extra)}
        """#
        return try JSONDecoder().decode(BootstrapDTO.self, from: jsonData(json))
    }

    private func message(_ id: String, seq: Int, cid: String? = nil, kind: String = "text", body: String = "hola") -> MessageDTO {
        MessageDTO(id: id, conversationId: "c1", seq: seq, authorId: "me", clientMessageId: cid, kind: kind, body: body, createdAt: "2026-11-18T10:00:00.000Z")
    }

    // MARK: Índices

    func testConversationIndexMatchesLinearSearch() throws {
        let d = try bootstrap()
        for id in ["c1", "t1", "t2", "t3", "x1"] { XCTAssertEqual(d.conversation(id: id), d.conversations.first { $0.id == id }) }
        XCTAssertNil(d.conversation(id: "nope"))
        XCTAssertEqual(d.conversationIndex(id: "t2"), 2)
    }

    func testIndexFollowsMutations() throws {
        var d = try bootstrap()
        XCTAssertEqual(d.conversation(id: "t3")?.name, "Otro")
        d.conversations[3].name = "Renombrado"
        XCTAssertEqual(d.conversation(id: "t3")?.name, "Renombrado")
        d.conversations.removeAll { $0.id == "t1" }
        XCTAssertNil(d.conversation(id: "t1"))
        XCTAssertEqual(d.conversations(parentMessageId: "m1").map(\.id), ["t2", "x1"])
        // Una copia que cambia no altera el índice de la original.
        let copy = d
        d.conversations.sort { $0.id > $1.id }
        XCTAssertEqual(copy.conversationIndex(id: "c1"), 0)
        XCTAssertEqual(d.conversationIndex(id: "c1"), d.conversations.firstIndex { $0.id == "c1" })
    }

    func testThreadsByMessageKeepOrderAndScope() throws {
        let d = try bootstrap()
        // Lo mismo que el filtro de antes: solo los de esta conversación, por actividad.
        XCTAssertEqual(ChatThreads.of(d, "c1", messageId: "m1").map(\.id), ["t2", "t1"])
        XCTAssertEqual(ChatThreads.of(d, "c1", messageId: "m2").map(\.id), ["t3"])
        XCTAssertEqual(ChatThreads.of(d, "c1", messageId: "m9").map(\.id), [])
        XCTAssertEqual(ChatThreads.of(d, "c1").map(\.id), ["t2", "t1", "t3"])
        XCTAssertEqual(ChatThreads.of(d, "c9").map(\.id), ["x1"])
    }

    func testSystemPayloadIsParsedOncePerBodyAndStaysCorrect() {
        let a = message("s1", seq: 1, kind: "system", body: #"{"k":"issue.created","issueId":"i1"}"#)
        XCTAssertEqual(a.systemPayload?["k"] as? String, "issue.created")
        XCTAssertEqual(a.systemPayload?["issueId"] as? String, "i1")
        XCTAssertNil(message("s2", seq: 2, kind: "system", body: "{roto").systemPayload)
        XCTAssertNil(message("s2", seq: 2, kind: "system", body: "{roto").systemPayload)
        XCTAssertNil(message("m3", seq: 3, body: #"{"k":"issue.created"}"#).systemPayload, "solo los mensajes de sistema")
    }

    func testTypedGgRangesUnchanged() {
        XCTAssertEqual(GGMention.typedRanges(in: "hola @gg y @GG.").count, 2)
        XCTAssertTrue(GGMention.typedRanges(in: "ana@gg.com y @ggg").isEmpty)
        XCTAssertTrue(GGMention.typedRanges(in: "sin arroba").isEmpty)
        XCTAssertEqual(excerpt("  uno \n\n dos\t tres  "), "uno dos tres")
        XCTAssertEqual(excerpt(String(repeating: "a", count: 130)), String(repeating: "a", count: 120) + "…")
    }

    // MARK: Identidad de fila

    func testRowIdStaysWhenMySendIsConfirmed() {
        SentRows.reset()
        let cid = "cid-1"
        let pending = SentRows.pendingId(cid)
        // Antes de enviar en esta sesión (o de otro dispositivo): id del mensaje.
        XCTAssertEqual(SentRows.rowId(message("m7", seq: 7, cid: cid)), "m7")
        SentRows.note(cid)
        XCTAssertEqual(SentRows.rowId(message("m7", seq: 7, cid: cid)), pending)
        XCTAssertEqual(SentRows.rowId(message("m8", seq: 8, cid: "otro")), "m8")
        XCTAssertEqual(SentRows.rowId(message("m9", seq: 9)), "m9")
        let loaded = [message("m7", seq: 7, cid: cid), message("m8", seq: 8)]
        XCTAssertEqual(SentRows.rowId(messageId: "m7", in: loaded), pending)
        XCTAssertEqual(SentRows.rowId(messageId: "m8", in: loaded), "m8")
        XCTAssertEqual(SentRows.rowId(messageId: "chat.bottom", in: loaded), "chat.bottom")
        SentRows.reset()
    }

    // MARK: Volver al frente

    func testResyncRule() {
        XCTAssertTrue(ResyncRule.skipBootstrap(away: 0, socketConnected: true, waAccounts: false))
        XCTAssertTrue(ResyncRule.skipBootstrap(away: 59, socketConnected: true, waAccounts: false))
        XCTAssertFalse(ResyncRule.skipBootstrap(away: 60, socketConnected: true, waAccounts: false))
        XCTAssertFalse(ResyncRule.skipBootstrap(away: 5, socketConnected: false, waAccounts: false))
        XCTAssertFalse(ResyncRule.skipBootstrap(away: 5, socketConnected: true, waAccounts: true))
    }

    func testSameContentIgnoresServerTimeButSeesEverythingElse() throws {
        let a = try bootstrap()
        XCTAssertTrue(a.sameContent(as: try bootstrap(serverTime: "2026-11-18T10:05:00Z")))
        var b = a
        b.conversations[0].unread = 3
        XCTAssertFalse(a.sameContent(as: b))
        // Lo que `==` no compara también cuenta.
        XCTAssertFalse(a.sameContent(as: try bootstrap(extra: #","missedCalls":2"#)))
        var c = a
        c.people[1].name = "Roberto"
        XCTAssertFalse(a.sameContent(as: c))
    }

    // MARK: Cola de envío

    func testOutboxKeepsOrderAndIsOnDiskAfterDrain() async {
        let box = OutboxStore(directory: tempDir())
        func p(_ id: String) -> PendingMessage {
            PendingMessage(clientMessageId: id, conversationId: "c1", body: id, replyTo: nil, forwarded: nil, attachmentIds: nil, forwardAttachmentIds: nil,
                           attachments: nil, mentions: nil, topicId: nil, viewOnce: nil, createdAt: "2026-11-18T10:00:00.000Z", attempts: 0, status: .pending, error: nil, nextAttemptAt: 0)
        }
        var list: [PendingMessage] = []
        for i in 0..<40 { list.append(p("m\(i)")); box.save(list, userId: "u") }
        box.save([p("ultimo")], userId: "u")
        // La lectura pasa por la misma cola: ve la última escritura sin esperar.
        XCTAssertEqual(box.load(userId: "u").map(\.clientMessageId), ["ultimo"])
        await box.drained()
        XCTAssertEqual(box.load(userId: "u").map(\.clientMessageId), ["ultimo"])
        box.save(list, userId: "u")
        box.clear(userId: "u")
        XCTAssertTrue(box.load(userId: "u").isEmpty)
    }

    func testSendIsOnDiskOnceDrained() async {
        SentRows.reset()
        let dir = tempDir()
        let box = OutboxStore(directory: dir)
        let store = AppStore(baseURL: URL(string: "http://127.0.0.1:9")!, secrets: MemorySecretStore(), outbox: box, feedback: nil)
        store.seedForTesting(try! bootstrap(), conversations: ["c1": ConversationState(messages: [], lastEventSeq: 9, hasMore: false, loaded: true)])
        guard let sent = store.send("c1", body: "hola") else { return XCTFail("no se encoló") }
        XCTAssertEqual(store.pendingFor("c1").map(\.clientMessageId), [sent.clientMessageId])
        await box.drained()
        // Otra instancia sobre la misma carpeta (como al reabrir la app) lo encuentra.
        XCTAssertEqual(OutboxStore(directory: dir).load(userId: "me").map(\.clientMessageId), [sent.clientMessageId])
        // Y su burbuja conserva la identidad cuando el servidor lo confirma.
        XCTAssertEqual(SentRows.rowId(message("srv", seq: 10, cid: sent.clientMessageId)), SentRows.pendingId(sent.clientMessageId))
        SentRows.reset()
    }

    // MARK: Imágenes

    func testRemoteImageDecodeDownscalesHugeImages() async {
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let big = UIGraphicsImageRenderer(size: CGSize(width: 3000, height: 1500), format: format).image { ctx in
            UIColor.red.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 3000, height: 1500))
        }
        let img = await RemoteImageCache.decode(big.pngData()!)
        XCTAssertEqual(img.map { max($0.size.width * $0.scale, $0.size.height * $0.scale) }, RemoteImageCache.maxPixels)
        XCTAssertEqual(img.map { $0.size.width / $0.size.height }, 2)
        let small = UIGraphicsImageRenderer(size: CGSize(width: 60, height: 60), format: format).image { _ in }
        let kept = await RemoteImageCache.decode(small.pngData()!)
        XCTAssertEqual(kept?.size.width, 60)
        let bad = await RemoteImageCache.decode(Data([1, 2, 3]))
        XCTAssertNil(bad)
    }

    func testTabAvatarIsDrawnOncePerInput() {
        let before = TabAvatar.draws
        let a = TabAvatar.memoized(name: "Ana Paz", photo: nil, fill: .red, fillId: "ch035-a", selected: false, moon: false)
        let b = TabAvatar.memoized(name: "Ana Paz", photo: nil, fill: .red, fillId: "ch035-a", selected: false, moon: false)
        XCTAssertTrue(a === b)
        XCTAssertEqual(TabAvatar.draws, before + 1)
        let c = TabAvatar.memoized(name: "Ana Paz", photo: nil, fill: .red, fillId: "ch035-a", selected: false, moon: true)
        XCTAssertFalse(a === c)
        XCTAssertEqual(TabAvatar.draws, before + 2)
    }
}
