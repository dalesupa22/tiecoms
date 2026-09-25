import SwiftUI
import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }

/// SPEC-v4 G: Sidechats (sugerencias, conector, conteo de respuestas, push TC_SIDE) y reproducción continua de voz.
final class V5SidechatTests: XCTestCase {
    private func boot() throws -> BootstrapDTO {
        try dec(BootstrapDTO.self, #"""
        {"contract":"x","serverTime":"","me":{"id":"me","name":"Ana","kind":"human","primaryOrgId":"oA"},
         "organizations":[{"id":"oA","name":"Xertify","myRole":"owner"}],
         "workspaces":[],
         "conversations":[
           {"id":"c1","kind":"multi","memberIds":["me","bob","col"],"lastMessageAt":"2026-09-25T10:00:00Z"},
           {"id":"c2","kind":"direct","memberIds":["me","dan"],"lastMessageAt":"2026-09-25T12:00:00Z"},
           {"id":"s1","kind":"multi","memberIds":["me","bob"],"parentId":"c1","parentMessageId":"m1","deriveKind":"side","lastMessageSeq":5}],
         "people":[{"id":"me","name":"Ana","kind":"human","orgId":"oA"},{"id":"bob","name":"Bob Ruiz","kind":"human","orgId":"oA"},
                   {"id":"col","name":"Carla Núñez","kind":"human","orgId":"oA"},{"id":"dan","name":"Dani","kind":"human","orgId":"oA"}]}
        """#)
    }

    func testSuggestionsAuthorMentionsFrequent() throws {
        let d = try boot()
        let cand = d.people.filter { $0.id != "me" }
        let m = MessageDTO(id: "m1", conversationId: "c1", seq: 1, authorId: "bob", clientMessageId: nil, kind: "text", body: "Le pregunto a @Carla mañana", createdAt: "")
        let s = SideLogic.suggestions(d, candidates: cand, message: m).map(\.id)
        XCTAssertEqual(s.first, "bob", "primero el autor")
        XCTAssertEqual(s[1], "col", "luego la gente mencionada")
        XCTAssertTrue(s.contains("dan"), "y colegas frecuentes")
        XCTAssertFalse(s.contains("me"))
        let mine = MessageDTO(id: "m2", conversationId: "c1", seq: 2, authorId: "me", clientMessageId: nil, kind: "text", body: "hola", createdAt: "")
        XCTAssertFalse(SideLogic.suggestions(d, candidates: cand, message: mine).contains { $0.id == "me" })
        XCTAssertLessThanOrEqual(SideLogic.suggestions(d, candidates: cand, message: m, limit: 2).count, 2)
    }

    func testReplyCount() throws {
        let side = try boot().conversations[2]
        XCTAssertEqual(SideLogic.replyCount(side, loaded: nil), 3, "sin cargar: seq − sistema − pregunta")
        let msgs = [
            try dec(MessageDTO.self, #"{"id":"a","seq":1,"authorId":"me","kind":"system","body":"{}","createdAt":""}"#),
            MessageDTO(id: "b", conversationId: "s1", seq: 2, authorId: "me", clientMessageId: nil, kind: "text", body: "¿?", createdAt: ""),
            MessageDTO(id: "c", conversationId: "s1", seq: 3, authorId: "bob", clientMessageId: nil, kind: "text", body: "Sí", createdAt: ""),
        ]
        XCTAssertEqual(SideLogic.replyCount(side, loaded: msgs), 1)
        XCTAssertEqual(SideLogic.replyCount(side, loaded: []), 0)
        XCTAssertEqual(SideLogic.messageCount(side), 4, "chip-hilo como la web: lastMessageSeq − 1")
    }

    func testConnectorGeometry() {
        let target = CGPoint(x: 600, y: 120)
        let on = SideLogic.connector(anchor: CGRect(x: 40, y: 300, width: 200, height: 40), target: target, chatHeight: 800, lastY: nil)
        XCTAssertTrue(on.visible)
        XCTAssertEqual(on.start, CGPoint(x: 244, y: 320), "sale del borde derecho de la burbuja")
        XCTAssertEqual(on.end, target)
        XCTAssertEqual(on.c1.y, on.start.y); XCTAssertEqual(on.c2.y, target.y)
        let gone = SideLogic.connector(anchor: nil, target: target, chatHeight: 800, lastY: 700)
        XCTAssertFalse(gone.visible)
        XCTAssertEqual(gone.start.y, 794, "el ancla quedó abajo: apunta al borde inferior")
        let above = SideLogic.connector(anchor: CGRect(x: 0, y: -200, width: 100, height: 40), target: target, chatHeight: 800, lastY: nil)
        XCTAssertEqual(above.start.y, 6, "fuera por arriba: borde superior")
    }

    func testRoutedConnectorStaysInTheLane() {
        var p = Path()
        SideLogic.routedPath(&p, start: CGPoint(x: 300, y: 700), end: CGPoint(x: 520, y: 120), laneX: 480)
        let b = p.boundingRect
        XCTAssertEqual(b.minX, 300, accuracy: 0.5); XCTAssertEqual(b.maxX, 520, accuracy: 0.5)
        XCTAssertFalse(p.contains(CGPoint(x: 400, y: 400)), "no cruza el contenido del chat")
        XCTAssertLessThanOrEqual(p.currentPoint?.y ?? 0, 120.5)
    }

    func testSidePush() {
        let p = PushPayload(userInfo: ["type": "side", "conversationId": "s1", "messageId": "m9", "authorId": "bob", "authorName": "Bob",
                                       "sideOf": ["conversationId": "c1", "messageId": "m1", "excerpt": "¿Confirmamos?"],
                                       "aps": ["alert": ["title": "💬 Sidechat de Bob", "subtitle": "Sobre: «¿Confirmamos?»", "body": "¿Llegas?"],
                                               "category": "TC_SIDE", "thread-id": "s1"]])
        XCTAssertEqual(p?.kind, .side)
        XCTAssertEqual(p?.conversationId, "s1")
        XCTAssertEqual(p?.sideOfConversationId, "c1")
        XCTAssertEqual(p?.sideOfMessageId, "m1")
        XCTAssertEqual(p?.sideOfExcerpt, "¿Confirmamos?")
        XCTAssertEqual(p?.category, PushPayload.sideCategory)
        XCTAssertTrue(PushRegistration.categories().contains { $0.identifier == "TC_SIDE" && $0.actions.contains { $0.identifier == PushRegistration.replyAction } },
                      "Responder en línea")
    }

    @MainActor
    func testOpenSideFromPush() throws {
        let s = AppStore(baseURL: URL(string: "http://127.0.0.1:9")!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: nil)
        s.seedForTesting(try boot())
        s.openSide(origin: "c1", side: "s1")
        XCTAssertEqual(s.sideToOpen["c1"], "s1", "puedo leer el origen: se abre con el sidechat desplegado")
        s.openSide(origin: "ajeno", side: "s1")
        XCTAssertNil(s.sideToOpen["ajeno"], "sin acceso al origen: el sidechat a pantalla completa")
    }

    func testVoiceContinuousPlayback() {
        func voice(_ id: String) -> AttachmentDTO { AttachmentDTO(id: id, name: "n.m4a", contentType: "audio/mp4", sizeBytes: 1, url: "/u", kind: "voice") }
        func msg(_ id: String, _ atts: [AttachmentDTO], kind: String = "text") -> MessageDTO {
            var m = MessageDTO(id: id, conversationId: "c", seq: 1, authorId: "u", clientMessageId: nil, kind: kind, body: "", createdAt: "")
            m.attachments = atts; return m
        }
        let photo = AttachmentDTO(id: "p", name: "a.jpg", contentType: "image/jpeg", sizeBytes: 1, url: "/u")
        let list = [msg("1", [voice("v1"), voice("v2")]), msg("2", [voice("v3")]), msg("s", [], kind: "system"), msg("3", [photo]), msg("4", [voice("v4")])]
        XCTAssertEqual(VoicePlayer.next(after: "v1", in: list)?.id, "v2", "otra nota del mismo mensaje")
        XCTAssertEqual(VoicePlayer.next(after: "v2", in: list)?.id, "v3", "la del mensaje siguiente")
        XCTAssertNil(VoicePlayer.next(after: "v3", in: list), "el siguiente mensaje no es una nota: se detiene")
        XCTAssertNil(VoicePlayer.next(after: "v4", in: list))
        XCTAssertNil(VoicePlayer.next(after: "nope", in: list))
    }

    func testMergedKindAndOldSideNames() throws {
        let m = try dec(MessageDTO.self, #"{"id":"x","seq":3,"authorId":"me","body":"Sí llegamos","createdAt":"","mergedFrom":"s1","mergedKind":"side"}"#)
        XCTAssertEqual(m.mergedKind, "side")
        var d = try boot()
        d.conversations[2].name = "Consulta · ¿Confirmamos?"
        XCTAssertEqual(Naming.title(d, d.conversations[2]), L("side.defaultName", ["excerpt": "¿Confirmamos?"]))
        d.conversations[2].name = "Sidechat · Otro"
        XCTAssertEqual(Naming.title(d, d.conversations[2]), "Sidechat · Otro")
    }
}
