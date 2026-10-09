import XCTest
import UIKit
@testable import TieComs

/// Contrato 0250fcd: vista previa de enlaces, chats `multi`, fotos de perfil y archivos.
final class ChatsProfileDecodingTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    func testMessageWithLinkPreview() throws {
        let m = try decode(MessageDTO.self, #"""
        {"id":"m1","conversationId":"c1","seq":3,"authorId":"u1","kind":"text","body":"mira https://www.ejemplo.com/a.",
         "createdAt":"2026-09-24T10:00:00Z","linkPreview":{"url":"https://www.ejemplo.com/a","title":"Ejemplo","description":null,
         "siteName":null,"imageUrl":"/api/v1/previews/8a1f","campoNuevo":1}}
        """#)
        XCTAssertEqual(m.linkPreview?.url, "https://www.ejemplo.com/a")
        XCTAssertEqual(m.linkPreview?.title, "Ejemplo")
        XCTAssertNil(m.linkPreview?.description)
        XCTAssertEqual(m.linkPreview?.host, "ejemplo.com", "sin siteName se muestra el host sin www.")
        XCTAssertEqual(MediaURL.absolute(m.linkPreview?.imageUrl, base: URL(string: "https://app.tiecoms.com")!)?.absoluteString,
                       "https://app.tiecoms.com/api/v1/previews/8a1f")
    }

    func testLinkPreviewNullMissingOrBroken() throws {
        let base = #""id":"m1","conversationId":"c1","seq":1,"authorId":"u1","body":"x","createdAt":"""#
        XCTAssertNil(try decode(MessageDTO.self, "{\(base),\"linkPreview\":null}").linkPreview)
        XCTAssertNil(try decode(MessageDTO.self, "{\(base)}").linkPreview)
        // Sin url la tarjeta no sirve: se descarta sin invalidar el mensaje.
        let m = try decode(MessageDTO.self, "{\(base),\"linkPreview\":{\"title\":\"sin url\"}}")
        XCTAssertNil(m.linkPreview)
        XCTAssertEqual(m.body, "x")
        let s = try decode(LinkPreviewDTO.self, #"{"url":"https://x.co","siteName":"X Corp"}"#)
        XCTAssertEqual(s.host, "X Corp")
    }

    func testMultiConversationKind() throws {
        let c = try decode(ConversationDTO.self, #"{"id":"c9","workspaceId":null,"kind":"multi","name":null,"memberIds":["me","u2","u3"],"canPost":true}"#)
        XCTAssertEqual(c.kind, .multi)
        XCTAssertNil(c.workspaceId)
        XCTAssertNil(c.name)
        XCTAssertTrue(c.kind.isChat)
        XCTAssertTrue(ConversationKind.direct.isChat)
        XCTAssertFalse(ConversationKind.group.isChat)
        let r = try decode(CreateChatResult.self, #"{"id":"c9","created":true,"kind":"multi"}"#)
        XCTAssertEqual(r.kind, .multi)
        XCTAssertEqual(try decode(CreateChatResult.self, #"{"id":"d1","created":false,"kind":"direct"}"#).kind, .direct)
    }

    func testAvatarUrlOnPersonAndUser() throws {
        let p = try decode(PersonDTO.self, #"{"id":"u2","name":"Mateo","kind":"human","orgId":"o2","title":null,"area":"Obra","guest":false,"guestUntil":null,"avatarUrl":"/api/v1/avatars/5b2c"}"#)
        XCTAssertEqual(p.avatarUrl, "/api/v1/avatars/5b2c")
        XCTAssertEqual(p.area, "Obra")
        XCTAssertNil(try decode(PersonDTO.self, #"{"id":"u3","name":"Sin foto","avatarUrl":null}"#).avatarUrl)
        XCTAssertNil(try decode(PersonDTO.self, #"{"id":"u3","name":"Tipo raro","avatarUrl":42}"#).avatarUrl, "otro tipo = sin foto")
        let u = try decode(UserDTO.self, #"{"id":"me","name":"Ana","kind":"human","primaryOrgId":"o1","avatarUrl":"/api/v1/avatars/aa"}"#)
        XCTAssertEqual(u.avatarUrl, "/api/v1/avatars/aa")
        XCTAssertEqual(MediaURL.absolute(u.avatarUrl, base: URL(string: "http://localhost:3041/")!)?.absoluteString, "http://localhost:3041/api/v1/avatars/aa")
        XCTAssertNil(MediaURL.absolute(nil))
        XCTAssertNil(MediaURL.absolute(""))
    }

    func testDriveTreeTolerant() throws {
        let t = try decode(DriveTreeDTO.self, #"""
        {"workspaceId":null,"canManageAll":true,
         "folders":[{"id":"f1","parentId":null,"name":"Contratos","createdBy":"me","createdAt":"2026-09-24T10:00:00Z"},
                    {"id":"f2","parentId":"f1","name":"2026"},{"sinId":1}],
         "files":[{"id":"a1","folderId":"f1","name":"b.pdf","contentType":"application/pdf","size":"2048","createdBy":"me","createdAt":""},
                  {"id":"a2","folderId":null,"name":"A.txt","size":10}]}
        """#)
        XCTAssertEqual(t.folders.count, 2)
        XCTAssertTrue(t.canManageAll)
        XCTAssertEqual(t.folders(in: nil).map(\.id), ["f1"])
        XCTAssertEqual(t.folders(in: "f1").map(\.id), ["f2"])
        XCTAssertEqual(t.files(in: "f1").first?.size, 2048)
        XCTAssertEqual(t.files(in: nil).first?.contentType, "application/octet-stream")
    }

    func testDriveUpdatedAccountEvent() throws {
        XCTAssertEqual(try decode(AccountEvent.self, #"{"type":"drive.updated","workspaceId":null}"#), .driveUpdated)
    }
}

/// Reglas de nombres, agrupación y reenvío sin red.
@MainActor
final class ChatsStoreTests: XCTestCase {
    var store: AppStore!

    static let bootstrap = #"""
    {"contract":"x","serverTime":"","me":{"id":"me","name":"Ana Ruiz","kind":"human","primaryOrgId":"o1"},
     "organizations":[{"id":"o1","name":"Constructora","mark":"C","colorBg":"#000000","colorFg":"#ffffff","myRole":"owner"},
                      {"id":"o2","name":"Acero","mark":"AC","colorBg":"#ffffff","colorFg":"#000000"},
                      {"id":"o3","name":"Bloques","mark":"B","colorBg":"#ff0000","colorFg":"#ffffff"}],
     "workspaces":[{"id":"w1","name":"Obra","owningOrgId":"o1","organizationIds":["o1","o2"],"memberIds":["me","u2"],"myRole":"lead","createdAt":""}],
     "conversations":[
       {"id":"g1","workspaceId":"w1","kind":"group","name":"General","memberIds":["me","u2"],"lastMessageSeq":1,"lastEventSeq":1,"canPost":true,"lastMessageAt":"2026-09-24T09:00:00Z"},
       {"id":"d1","workspaceId":null,"kind":"direct","memberIds":["me","u2"],"lastMessageSeq":1,"lastEventSeq":1,"canPost":true,"lastMessageAt":"2026-09-24T08:00:00Z"},
       {"id":"m1","workspaceId":null,"kind":"multi","name":null,"memberIds":["me","u2","u3","u4","u5","u6"],"lastMessageSeq":1,"lastEventSeq":1,"canPost":true,"lastMessageAt":"2026-09-24T10:00:00Z"},
       {"id":"m2","workspaceId":null,"kind":"multi","name":"Compras","memberIds":["me","u2","u3"],"lastMessageSeq":0,"lastEventSeq":0,"canPost":true}
     ],
     "people":[
       {"id":"me","name":"Ana Ruiz","kind":"human","orgId":"o1","guest":false},
       {"id":"u2","name":"Mateo Gil","kind":"human","orgId":"o2","title":"Jefe de compras","area":"Compras","guest":false,"avatarUrl":"/api/v1/avatars/x"},
       {"id":"u3","name":"Laura Paz","kind":"human","orgId":"o1","title":"Ingeniera","guest":false},
       {"id":"u4","name":"Carlos Díaz","kind":"human","orgId":"o3","guest":false},
       {"id":"u5","name":"Eva Sol","kind":"human","orgId":null,"guest":true},
       {"id":"u6","name":"Bruno Mar","kind":"human","orgId":"o2","guest":false},
       {"id":"bot","name":"Asistente","kind":"agent","orgId":"o1","guest":false}
     ]}
    """#

    override func setUp() async throws {
        store = AppStore(baseURL: URL(string: "http://127.0.0.1:9")!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: FeedbackSpy())
        let d = try JSONDecoder().decode(BootstrapDTO.self, from: Data(Self.bootstrap.utf8))
        let msg = try JSONDecoder().decode(MessageDTO.self, from: Data(#"{"id":"x1","conversationId":"g1","seq":1,"authorId":"u2","body":"ver https://ejemplo.com","createdAt":"2026-09-24T09:00:00Z"}"#.utf8))
        store.seedForTesting(d, conversations: ["g1": ConversationState(messages: [msg], lastEventSeq: 1, hasMore: false, loaded: true)])
    }

    func testMultiTitleAndSubtitle() {
        let d = store.data!
        XCTAssertEqual(Naming.title(d, store.meta("m1")!), "Mateo, Laura, Carlos " + L("chat.andMore", ["n": 2]))
        XCTAssertEqual(Naming.title(d, store.meta("m2")!), "Compras", "con nombre se usa el nombre")
        var three = store.meta("m1")!; three.memberIds = ["me", "u2", "u3"]
        XCTAssertEqual(Naming.title(d, three), "Mateo, Laura")
        var alone = store.meta("m1")!; alone.memberIds = ["me"]
        XCTAssertEqual(Naming.title(d, alone), L("chat.groupChat"))
        let sub = Naming.subtitle(d, store.meta("m2")!)
        XCTAssertTrue(sub.hasPrefix(L("chat.groupChat") + " · "), sub)
        XCTAssertTrue(sub.contains("Acero") && sub.contains("Constructora"), sub)
    }

    func testMultiGoesWithDirectsNotInOther() {
        let s = Naming.sections(store.data!, filterWorkspace: nil, query: "")
        XCTAssertNil(s.first { $0.id == "_other" }, "un multi no es un huérfano de espacio")
        XCTAssertEqual(s.first { $0.id == "_directs" }?.conversations.map(\.id), ["m1", "d1", "m2"])
        XCTAssertEqual(s.first { $0.id == "w1" }?.conversations.map(\.id), ["g1"])
    }

    func testPeopleGroupedByCompany() {
        let g = Naming.peopleByOrg(store.data!, query: "")
        XCTAssertEqual(g.map(\.id), ["o1", "o2", "o3", "_guests"], "mi empresa, luego por nombre, terceros al final")
        XCTAssertTrue(g[0].isMine)
        XCTAssertEqual(g[0].people.map(\.id), ["u3"], "sin mí ni agentes")
        XCTAssertEqual(g[1].people.map(\.id), ["u6", "u2"], "por nombre dentro de la empresa")
        XCTAssertEqual(Naming.peopleByOrg(store.data!, query: "compras").flatMap(\.people).map(\.id), ["u2"], "busca por cargo/área")
        XCTAssertEqual(Naming.peopleByOrg(store.data!, query: "bloques").flatMap(\.people).map(\.id), ["u4"], "busca por empresa")
        XCTAssertEqual(Naming.peopleByOrg(store.data!, query: "diaz").flatMap(\.people).map(\.id), ["u4"], "sin tildes")
        XCTAssertEqual(Naming.peopleByOrg(store.data!, query: "", exclude: ["u3"]).first?.id, "o2")
        XCTAssertEqual(Naming.roleLine(Naming.person(store.data!, "u2")!), "Jefe de compras · Compras")
    }

    func testForwardToManyQueuesCommentThenForwarded() {
        let src = store.conversations["g1"]!.messages[0]
        let n = store.forward(src, to: ["d1", "m1"], comment: "  mira esto ")
        XCTAssertEqual(n, 2)
        let p = store.pending
        XCTAssertEqual(p.map(\.conversationId), ["d1", "d1", "m1", "m1"])
        XCTAssertEqual(p[0].body, "mira esto")
        XCTAssertNil(p[0].forwarded)
        XCTAssertEqual(p[1].body, src.body)
        XCTAssertEqual(p[1].forwarded, ForwardedInfo(source: .tiecoms, author: "Mateo Gil", sentAt: src.createdAt, fromConversationId: "g1"))
        XCTAssertEqual(Set(p.map(\.clientMessageId)).count, 4, "cada envío con su propio clientMessageId")
    }

    func testForwardCapsAtTenAndSkipsEmptyComment() {
        let src = store.conversations["g1"]!.messages[0]
        let n = store.forward(src, to: (0..<12).map { "c\($0)" }, comment: "   ")
        XCTAssertEqual(n, 10)
        XCTAssertEqual(store.pending.count, 10, "sin comentario: solo el reenvío")
    }

    func testMessageUpdatedBringsLinkPreview() throws {
        let e = try JSONDecoder().decode(ConversationEvent.self, from: Data(#"""
        {"type":"message.updated","conversationId":"g1","eventSeq":2,"message":{"id":"x1","conversationId":"g1","seq":1,"authorId":"u2",
         "body":"ver https://ejemplo.com","createdAt":"2026-09-24T09:00:00Z","linkPreview":{"url":"https://ejemplo.com","title":"Ejemplo","imageUrl":"/api/v1/previews/p1"}}}
        """#.utf8))
        store.onConversationEvent(e, live: true)
        let m = store.conversations["g1"]!.messages[0]
        XCTAssertEqual(m.linkPreview?.title, "Ejemplo", "la tarjeta llega después del envío y reemplaza el mensaje")
        XCTAssertEqual(store.conversations["g1"]?.messages.count, 1)
        XCTAssertEqual(store.conversations["g1"]?.lastEventSeq, 2)
    }

    func testPushUsesVisibleTab() {
        store.tab = .settings
        store.push(.files)
        XCTAssertEqual(store.settingsPath, [.files])
        store.tab = .home
        store.push(.drive(workspaceId: nil, folderId: "f1"))
        XCTAssertEqual(store.homePath, [.drive(workspaceId: nil, folderId: "f1")])
    }
}

/// Utilidades puras de la interfaz.
final class LinkifyAndCropTests: XCTestCase {
    func testLinksStripTrailingPunctuation() {
        let text = "Mira https://ejemplo.com/a?b=1. y (http://otro.co/x) ¡listo!"
        XCTAssertEqual(Linkify.links(in: text).map(\.url.absoluteString), ["https://ejemplo.com/a?b=1", "http://otro.co/x"])
        XCTAssertTrue(Linkify.links(in: "sin enlaces, ejemplo.com").isEmpty)
        let a = Linkify.attributed("ver https://x.co")
        XCTAssertEqual(a.runs.compactMap { $0.link }.map(\.absoluteString), ["https://x.co"])
        XCTAssertEqual(String(a.characters), "ver https://x.co", "el texto no cambia")
    }

    func testSquareCropTo512Jpeg() throws {
        let src = UIGraphicsImageRenderer(size: CGSize(width: 1200, height: 800), format: { let f = UIGraphicsImageRendererFormat(); f.scale = 1; return f }()).image { ctx in
            UIColor.red.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 1200, height: 800))
        }
        let data = try XCTUnwrap(AvatarCrop.squareJPEG(src))
        XCTAssertEqual(Array(data.prefix(3)), [0xFF, 0xD8, 0xFF], "JPEG")
        XCTAssertLessThan(data.count, AppStore.maxAvatarBytes)
        let back = try XCTUnwrap(UIImage(data: data))
        XCTAssertEqual(back.size.width * back.scale, 512)
        XCTAssertEqual(back.size.height * back.scale, 512)
        // Una imagen chica no se agranda.
        let small = UIGraphicsImageRenderer(size: CGSize(width: 300, height: 200), format: { let f = UIGraphicsImageRendererFormat(); f.scale = 1; return f }()).image { _ in }
        let s = try XCTUnwrap(UIImage(data: try XCTUnwrap(AvatarCrop.squareJPEG(small))))
        XCTAssertEqual(s.size.width * s.scale, 200)
    }

    func testDriveSizeFormat() {
        XCTAssertEqual(DriveFormat.size(500), "500 B")
        XCTAssertEqual(DriveFormat.size(2048), "2 KB")
        XCTAssertEqual(DriveFormat.size(3 * 1024 * 1024 + 300_000), String(format: "%.1f MB", 3.29))
        XCTAssertEqual(DriveFormat.size(20 * 1024 * 1024), "20 MB")
    }
}
