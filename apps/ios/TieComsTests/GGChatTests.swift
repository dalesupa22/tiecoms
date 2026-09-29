import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }

/// gg como chat y «Tú» (docs/GG-CHAT.md): la tarjeta gg.actions nunca cruda, «Tú» y gg con su nombre.
@MainActor
final class GGChatTests: XCTestCase {
    private let actionsBody = #"{"k":"gg.actions","forUserId":"a","actions":[{"id":"x1","kind":"send_message","status":"pending","target":"Laura Pineda","text":"¿Llegó el pago?","token":"tok"},{"id":"x2","kind":"create_issue","status":"done","target":"Ventas","text":"Cobrar a Uniandes","undoToken":"u"}],"suggestions":["Sí, envíalo","Mejor mañana"]}"#

    func testActionsPayloadParses() throws {
        let m = MessageDTO(id: "m1", conversationId: "c1", seq: 3, authorId: GG.id, clientMessageId: nil, kind: "system", body: actionsBody, createdAt: "")
        let p = try XCTUnwrap(GG.actions(m))
        XCTAssertEqual(p.forUserId, "a"); XCTAssertEqual(p.actions.count, 2); XCTAssertEqual(p.suggestions, ["Sí, envíalo", "Mejor mañana"])
        XCTAssertEqual(p.actions[0].status, .pending); XCTAssertEqual(p.actions[0].token, "tok"); XCTAssertEqual(p.actions[0].kind, .sendMessage)
        XCTAssertEqual(p.actions[1].undoToken, "u")
        // Un mensaje de texto con el mismo cuerpo no es tarjeta; un gg.actions roto tampoco.
        XCTAssertNil(GG.actions(MessageDTO(id: "m2", conversationId: "c1", seq: 4, authorId: "a", clientMessageId: nil, kind: "text", body: actionsBody, createdAt: "")))
        XCTAssertNil(GG.actions(MessageDTO(id: "m3", conversationId: "c1", seq: 5, authorId: GG.id, clientMessageId: nil, kind: "system", body: #"{"k":"gg.actions","#, createdAt: "")))
        // Nunca crudo en la vista previa de la lista.
        let saved = L10n.choice; defer { L10n.choice = saved }
        L10n.choice = .es
        XCTAssertEqual(L10n.systemText(actionsBody), "✦ gg dejó algo listo para confirmar")
        XCTAssertFalse(L10n.systemText(String(actionsBody.prefix(140))).hasPrefix("{"))
    }

    func testSelfDirectIsTuAndGGHasName() throws {
        let saved = L10n.choice; defer { L10n.choice = saved }
        L10n.choice = .es
        let d = try dec(BootstrapDTO.self, #"""
        {"contract":"x","serverTime":"","me":{"id":"a","name":"Ana Márquez"},"assistantId":"0a9a9a9a-0000-4000-8000-000000000066",
         "people":[{"id":"a","name":"Ana Márquez"},{"id":"b","name":"Bruno"}],
         "conversations":[{"id":"s","kind":"direct","memberIds":["a"]},{"id":"g","kind":"direct","memberIds":["a","0a9a9a9a-0000-4000-8000-000000000066"]},{"id":"d","kind":"direct","memberIds":["a","b"]}]}
        """#)
        let byId = Dictionary(uniqueKeysWithValues: d.conversations.map { ($0.id, $0) })
        XCTAssertTrue(GG.isSelf(d, byId["s"]!))
        XCTAssertEqual(Naming.title(d, byId["s"]!), "Tú", "el directo conmigo mismo se llama «Tú»")
        XCTAssertEqual(Naming.otherInDirect(d, byId["s"]!)?.id, "a", "con mi avatar")
        XCTAssertEqual(Naming.title(d, byId["g"]!), "gg", "gg aunque no venga en people")
        XCTAssertEqual(Naming.person(d, GG.id)?.kind, "agent")
        XCTAssertEqual(Naming.title(d, byId["d"]!), "Bruno")
        XCTAssertFalse(GG.isSelf(d, byId["d"]!))
    }
}
