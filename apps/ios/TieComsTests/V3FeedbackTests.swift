import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }

/// Feedback de TestFlight (SPEC-v3): campos nuevos, color por persona, rachas, push, jerarquía, recorte.
final class V3FeedbackTests: XCTestCase {
    func testNewFieldsDecode() throws {
        let c = try dec(ConversationDTO.self, #"{"id":"s1","kind":"multi","avatarUrl":"/api/v1/avatars/abc","parentId":"c1","parentMessageId":"m1","deriveKind":"side","nuevo":{"x":1}}"#)
        XCTAssertEqual(c.avatarUrl, "/api/v1/avatars/abc")
        XCTAssertTrue(Naming.isSide(c))
        let unknownKind = try dec(ConversationDTO.self, #"{"id":"x","kind":"canal","deriveKind":"futuro"}"#)
        XCTAssertEqual(unknownKind.kind, .group)
        XCTAssertFalse(Naming.isSide(unknownKind))
        let m = try dec(MessageDTO.self, #"{"id":"m","seq":1,"authorId":"u","body":"ok","createdAt":"","forwarded":{"source":"tiecoms","author":"Ana","sentAt":"2026-09-25T10:00:00Z","fromConversationId":"c1","messageId":"m0"}}"#)
        XCTAssertEqual(m.forwarded?.messageId, "m0")
        let srv = try dec(MessageDTO.self, #"{"id":"m2","seq":2,"authorId":"u","body":"ok","createdAt":"","forwarded":{"source":"tiecoms","fromConversationId":"c1","messageId":"m0","messageSeq":42,"excerpt":"¿Cuándo sale?"}}"#)
        XCTAssertEqual(srv.forwarded?.messageSeq, 42, "el servidor agrega el número del original")
        XCTAssertEqual(srv.forwarded?.excerpt, "¿Cuándo sale?")
        XCTAssertNil(srv.forwarded!.json["excerpt"], "el cliente no manda el extracto")
        XCTAssertEqual(DeepLink.messageSeq(URL(string: "https://app.tiecoms.com/c/c1?m=42")!), 42)
        XCTAssertEqual(ForwardedInfo(source: .tiecoms, fromConversationId: "c1", messageId: "m0").json["messageId"] as? String, "m0")
        XCTAssertNil(ForwardedInfo(source: .other).json["messageId"], "sin messageId no se envía el campo")
        let e = APIClient.parseError(Data(#"{"error":{"code":"side_outsider","message":"no","details":{"userIds":["u9","u8"]}}}"#.utf8), status: 403)
        XCTAssertEqual(e.code, "side_outsider")
        XCTAssertEqual(e.userIds, ["u9", "u8"])
    }

    func testPersonColorMatchesWeb() {
        // Vectores de la web (apps/web/src/ui.tsx personColor).
        XCTAssertEqual(PersonColor.index("00000000-0000-0000-0000-000000000000"), 1)
        XCTAssertEqual(PersonColor.pair("00000000-0000-0000-0000-000000000000").light, 0x1E8E5A)
        XCTAssertEqual(PersonColor.index("3f2b8c1e-9a4d-4e21-8b7a-1c2d3e4f5a6b"), 3)
        XCTAssertEqual(PersonColor.pair("3f2b8c1e-9a4d-4e21-8b7a-1c2d3e4f5a6b").light, 0x0B8793)
        XCTAssertEqual(PersonColor.index("ffffffff-ffff-ffff-ffff-ffffffffffff"), 1)
        XCTAssertEqual(PersonColor.index("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"), 1, "no depende de mayúsculas")
        XCTAssertEqual(PersonColor.fnv1a(""), 0x811C9DC5)
        XCTAssertEqual(PersonColor.fnv1a("a"), 0xE40C292C)
        XCTAssertEqual(PersonColor.hexes, [0x2F6FDB, 0x1E8E5A, 0x7C4DDB, 0x0B8793, 0xB83280, 0x4C51BF, 0x52606D, 0xC53030])
        for p in PersonColor.palette {
            let r = (p.light >> 16) & 0xFF, g = (p.light >> 8) & 0xFF, b = p.light & 0xFF
            XCTAssertFalse(r > 0xC0 && g > 0x50 && g < 0xA0 && b < 0x40, "sin naranja: \(String(p.light, radix: 16))")
            func lin(_ c: UInt32) -> Double { let v = Double(c) / 255; return v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
            let lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
            XCTAssertGreaterThanOrEqual(1.05 / (lum + 0.05), 3.0, "iniciales blancas legibles: \(String(p.light, radix: 16))")
        }
    }

    private func msg(_ id: String, author: String, at: String, kind: String = "text", reply: String? = nil) -> MessageDTO {
        var m = MessageDTO(id: id, conversationId: "c", seq: 1, authorId: author, clientMessageId: nil, kind: kind, body: "x", createdAt: at)
        m.replyTo = reply
        return m
    }

    func testRunsGroupByAuthorWithin5Minutes() {
        let a1 = msg("1", author: "a", at: "2026-09-25T10:00:00Z")
        let a2 = msg("2", author: "a", at: "2026-09-25T10:04:59Z")
        let a3 = msg("3", author: "a", at: "2026-09-25T10:10:00Z")
        let b1 = msg("4", author: "b", at: "2026-09-25T10:10:30Z")
        let sys = msg("5", author: "a", at: "2026-09-25T10:10:40Z", kind: "system")
        XCTAssertTrue(ChatGrouping.startsRun(previous: nil, current: a1))
        XCTAssertFalse(ChatGrouping.startsRun(previous: a1, current: a2))
        XCTAssertTrue(ChatGrouping.startsRun(previous: a2, current: a3), "≥ 5 min abre racha")
        XCTAssertTrue(ChatGrouping.startsRun(previous: a3, current: b1))
        XCTAssertTrue(ChatGrouping.startsRun(previous: sys, current: msg("6", author: "a", at: "2026-09-25T10:10:50Z")))
        XCTAssertTrue(ChatGrouping.startsRun(previous: a1, current: msg("7", author: "a", at: "2026-09-25T10:00:10Z", reply: "1")), "una respuesta muestra autor")
        XCTAssertFalse(ChatGrouping.showsAvatars(.direct))
        XCTAssertTrue(ChatGrouping.showsAvatars(.group) && ChatGrouping.showsAvatars(.multi))
    }

    func testPushPayloadParsing() {
        let group: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "Comité directivo", "subtitle": "Mateo Rivas · Estudio Norte", "body": "Hola"], "badge": 7,
                    "sound": "tc_notify.caf", "thread-id": "c1", "category": "TC_MESSAGE", "mutable-content": 1],
            "type": "message", "conversationId": "c1", "messageId": "m1", "authorId": "u1", "authorName": "Mateo Rivas",
            "authorAvatarUrl": "/api/v1/avatars/f1", "futuro": true,
        ]
        let p = PushPayload(userInfo: group)!
        XCTAssertEqual(p.kind, .message)
        XCTAssertTrue(p.isGroup)
        XCTAssertEqual(p.badge, 7)
        XCTAssertEqual(p.threadId, "c1")
        XCTAssertEqual(p.category, PushPayload.messageCategory)
        XCTAssertEqual(p.avatarURL(base: URL(string: "https://app.tiecoms.com/"))?.absoluteString, "https://app.tiecoms.com/api/v1/avatars/f1")
        let direct = PushPayload(userInfo: ["aps": ["alert": ["title": "Ana", "body": "¿Listo?"]], "conversationId": "d1", "authorId": "u2", "authorAvatarUrl": ""])!
        XCTAssertFalse(direct.isGroup)
        XCTAssertNil(direct.avatarURL(base: URL(string: "https://app.tiecoms.com")), "sin foto")
        let rem = PushPayload(userInfo: ["aps": ["alert": ["title": "Recordatorio", "subtitle": "General", "body": "Llamar"], "category": "TC_REMINDER"],
                                         "type": "reminder", "conversationId": "c1", "reminderId": "r1"])!
        XCTAssertEqual(rem.kind, .reminder)
        XCTAssertEqual(rem.reminderId, "r1")
        XCTAssertEqual(PushPayload(userInfo: ["type": "algo.nuevo", "conversationId": "c9"])?.kind, .message, "tipo desconocido → mensaje")
        XCTAssertNil(PushPayload(userInfo: ["aps": ["alert": "x"]]), "sin conversationId no es de TieComs")
        #if DEBUG
        XCTAssertEqual(PushEnvironment.current, "sandbox")
        #endif
        XCTAssertEqual(PushEnvironment.hex(Data([0x0A, 0xFF, 0x00])), "0aff00")
    }

    func testCommunicationIntentFromPush() {
        let p = PushPayload(userInfo: ["aps": ["alert": ["title": "Comité directivo", "subtitle": "Mateo Rivas · Estudio Norte", "body": "Hola"]],
                                       "conversationId": "c1", "authorId": "u1", "authorName": "Mateo Rivas"])!
        let i = CommunicationNotification.intent(payload: p, authorId: "u1", image: nil)
        XCTAssertEqual(i.sender?.displayName, "Mateo Rivas")
        XCTAssertEqual(i.speakableGroupName?.spokenPhrase, "Comité directivo", "grupo: nombre del chat")
        XCTAssertEqual(i.conversationIdentifier, "c1")
        XCTAssertEqual(i.content, "Hola")
        let d = PushPayload(userInfo: ["aps": ["alert": ["title": "Ana", "body": "¿Listo?"]], "conversationId": "d1", "authorId": "u2"])!
        let di = CommunicationNotification.intent(payload: d, authorId: "u2", image: nil)
        XCTAssertNil(di.speakableGroupName, "directo: sin nombre de grupo")
        XCTAssertEqual(di.sender?.displayName, "Ana")
        let content = UNMutableNotificationContent(); content.title = "Ana"; content.body = "¿Listo?"
        let updated = CommunicationNotification.update(content, payload: d, authorId: "u2", image: nil)
        print("[resultado] content.updating(from:) en el proceso de pruebas: \(updated == nil ? "rechazado (sin entitlement)" : "aceptado")")
    }

    func testTruncatedSystemPreviewIsReadable() {
        let cut = #"{"k":"event.created","title":"Decisión de la fecha de salida","eventId":"72faeb3f"#
        let s = L10n.systemText(cut)
        XCTAssertFalse(s.hasPrefix("{"), s)
        XCTAssertTrue(s.contains("Decisión de la fecha de salida"), s)
        XCTAssertFalse(s.contains("{"), "sin variables sin rellenar: \(s)")
        XCTAssertFalse(L10n.systemText(#"{"k":"group.photo_changed"}"#).hasPrefix("{"))
        XCTAssertEqual(L10n.systemText("{no es json"), "{no es json")
    }

    func testCropMathCoversCircle() {
        let img = CGSize(width: 4000, height: 3000), side: CGFloat = 300
        XCTAssertEqual(CropMath.baseScale(image: img, side: side), 0.1, accuracy: 1e-9)
        let centered = CropMath.cropRect(image: img, side: side, zoom: 1, offset: .zero)
        XCTAssertEqual(centered, CGRect(x: 500, y: 0, width: 3000, height: 3000))
        // Zoom ×2: la mitad del lado, centrado.
        XCTAssertEqual(CropMath.cropRect(image: img, side: side, zoom: 2, offset: .zero), CGRect(x: 1250, y: 750, width: 1500, height: 1500))
        // Desplazar a la derecha muestra la parte izquierda y no se sale del borde.
        let left = CropMath.cropRect(image: img, side: side, zoom: 1, offset: CGSize(width: 10_000, height: 10_000))
        XCTAssertEqual(left.minX, 0, accuracy: 1e-6)
        XCTAssertEqual(left.minY, 0, accuracy: 1e-6)
        let small = UIGraphicsImageRenderer(size: CGSize(width: 800, height: 600)).image { ctx in UIColor.red.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 800, height: 600)) }
        let jpeg = CropMath.render(small, crop: CropMath.cropRect(image: small.size, side: side, zoom: 1, offset: .zero))
        XCTAssertNotNil(jpeg)
        XCTAssertLessThanOrEqual(jpeg!.count, AppStore.maxAvatarBytes)
        XCTAssertEqual(UIImage(data: jpeg!)?.size.width, 512)
    }
}

/// Jerarquía de Inicio y de Asuntos (sin red).
@MainActor
final class HierarchyTests: XCTestCase {
    private let json = #"""
    {"contract":"x","serverTime":"","me":{"id":"me","name":"Ana","kind":"human","primaryOrgId":"oA"},
     "organizations":[{"id":"oA","name":"Xertify","mark":"X","colorBg":"#112233","colorFg":"#ffffff","myRole":"owner"},
                      {"id":"oB","name":"Estudio Norte","mark":"EN","colorBg":"#aa3366","colorFg":"#ffffff"}],
     "workspaces":[{"id":"w1","name":"Lanzamiento","owningOrgId":"oA","organizationIds":["oA","oB"],"memberIds":["me","bob"],"myRole":"lead","createdAt":""},
                   {"id":"w2","name":"Interno","owningOrgId":"oA","organizationIds":["oA"],"memberIds":["me"],"myRole":"lead","createdAt":""}],
     "conversations":[
       {"id":"c1","workspaceId":"w1","kind":"group","name":"Comité directivo","memberIds":["me","bob"],"lastMessageAt":"2026-09-25T10:00:00Z","unread":2,"openIssues":3},
       {"id":"c2","workspaceId":"w1","kind":"internal","name":"Equipo interno","memberIds":["me"],"lastMessageAt":"2026-09-24T10:00:00Z","unread":1,"mutedUntil":"2099-01-01T00:00:00Z"},
       {"id":"c3","workspaceId":"w2","kind":"group","name":"Planeación","memberIds":["me"],"lastMessageAt":"2026-09-23T10:00:00Z"},
       {"id":"s1","workspaceId":null,"kind":"multi","name":"Consulta · fecha","memberIds":["me","col"],"parentId":"c1","parentMessageId":"m1","deriveKind":"side","unread":4},
       {"id":"d1","workspaceId":null,"kind":"direct","memberIds":["me","bob"],"lastMessageAt":"2026-09-25T11:00:00Z"}],
     "people":[{"id":"me","name":"Ana","kind":"human","orgId":"oA"},{"id":"bob","name":"Bob","kind":"human","orgId":"oB"},{"id":"col","name":"Carla","kind":"human","orgId":"oA"}]}
    """#

    func testHomeTreeMatchesWebSidebar() throws {
        let d = try JSONDecoder().decode(BootstrapDTO.self, from: Data(json.utf8))
        let t = Naming.homeTree(d)
        // w1 va con la contraparte (Estudio Norte); w2 (solo mi empresa) con la dueña (Xertify).
        XCTAssertEqual(t.companies.map { $0.org?.name ?? "" }, ["Estudio Norte", "Xertify"])
        XCTAssertEqual(t.companies[0].workspaces.map(\.ws.name), ["Lanzamiento"])
        XCTAssertEqual(t.companies[0].workspaces[0].convs.map(\.conv.id), ["c1", "c2"])
        XCTAssertEqual(t.companies[0].workspaces[0].convs[0].sides.map(\.id), ["s1"], "la lateral cuelga de su origen")
        XCTAssertEqual(t.chats.map(\.conv.id), ["d1"], "las laterales no se mezclan con los chats")
        let all = t.companies[0].workspaces.flatMap { $0.convs.flatMap { [$0.conv] + $0.sides } }
        XCTAssertEqual(Naming.unreadCount(all), 6, "no leídos agregados sin contar la silenciada")
        XCTAssertEqual(Naming.route(d, d.conversations[0]), "Estudio Norte · Lanzamiento")
        XCTAssertNil(Naming.route(d, d.conversations[4]))
        let search = Naming.homeTree(d, query: "planea")
        XCTAssertEqual(search.companies.flatMap { $0.workspaces.flatMap { $0.convs.map(\.conv.id) } }, ["c3"])
    }

    func testIssueTreeAndFilters() throws {
        let d = try JSONDecoder().decode(BootstrapDTO.self, from: Data(json.utf8))
        func issue(_ id: String, conv: String, ws: String, status: String, owner: String) throws -> IssueDTO {
            try JSONDecoder().decode(IssueDTO.self, from: Data(#"{"id":"\#(id)","workspaceId":"\#(ws)","conversationId":"\#(conv)","title":"\#(id)","status":"\#(status)","ownerId":"\#(owner)"}"#.utf8))
        }
        let list = [try issue("i1", conv: "c1", ws: "w1", status: "open", owner: "me"), try issue("i2", conv: "c1", ws: "w1", status: "done", owner: "me"),
                    try issue("i3", conv: "c3", ws: "w2", status: "waiting", owner: "bob"), try issue("i4", conv: "zz", ws: "w1", status: "open", owner: "me")]
        XCTAssertEqual(IssueTree.filter(list, .mine, me: "me").map(\.id), ["i1", "i4"])
        XCTAssertEqual(IssueTree.filter(list, .open, me: "me").map(\.id), ["i1", "i3", "i4"])
        XCTAssertEqual(IssueTree.filter(list, .all, me: "me").count, 4)
        let tree = IssueTree.group(d, IssueTree.filter(list, .all, me: "me"))
        XCTAssertEqual(tree.map { $0.org?.name ?? "" }, ["Estudio Norte", "Xertify"])
        XCTAssertEqual(tree[0].workspaces[0].convs.map(\.id), ["c1"], "asuntos de conversaciones fuera de mi alcance no aparecen")
        XCTAssertEqual(tree[0].workspaces[0].convs[0].issues.map(\.id).sorted(), ["i1", "i2"])
    }

    func testSideCandidatesAndPrivateReply() throws {
        let d = try JSONDecoder().decode(BootstrapDTO.self, from: Data(json.utf8))
        let s = AppStore(baseURL: URL(string: "http://127.0.0.1:9")!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: nil)
        s.seedForTesting(d)
        let c = s.sideCandidates("c1")
        XCTAssertEqual(c.members.map(\.id), ["bob"])
        XCTAssertEqual(c.colleagues.map(\.id), ["col"], "colegas de mi empresa que no están en el origen")
        XCTAssertEqual(s.sides(of: "m1").map(\.id), ["s1"])
        XCTAssertTrue(ConversationDetailsView.canChangePhoto(d.conversations[4]) == false, "directo: sin foto de grupo")
        XCTAssertTrue(ConversationDetailsView.canChangePhoto(d.conversations[3]), "chat grupal: cualquier miembro")
        let draft = PrivateReplyDraft(conversationId: "d1", fromConversationId: "c1", messageId: "m1", author: "Bob", sentAt: "2026-09-25T10:00:00Z", excerpt: "hola")
        s.privateReplies["d1"] = draft
        s.sendPrivateReply(draft, body: "te respondo aparte")
        XCTAssertNil(s.privateReplies["d1"])
        let p = try XCTUnwrap(s.pending.last)
        XCTAssertEqual(p.forwarded?.messageId, "m1")
        XCTAssertEqual(p.forwarded?.fromConversationId, "c1")
        XCTAssertEqual(p.forwarded?.source, .tiecoms)
        XCTAssertEqual(s.badgeCount, 6, "badge = no leídos de conversaciones no silenciadas")
    }
}
