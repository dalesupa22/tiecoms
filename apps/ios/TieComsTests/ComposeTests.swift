import XCTest
@testable import TieComs

/// 1.6.10 · «Mensaje nuevo» como WhatsApp/Slack: tocar marca, chips en «Para:», 1 = directo, 2+ = chat grupal.
final class ComposeTests: XCTestCase {
    func testToggleBackspaceAndAction() {
        var p: [String] = []
        XCTAssertEqual(ComposeRules.action(p), .none, "sin selección: Cancelar y «Grupo en un espacio»")
        p = ComposeRules.toggle(p, "b")
        XCTAssertEqual(ComposeRules.action(p), .openDirect("b"))
        p = ComposeRules.toggle(p, "g")
        XCTAssertEqual(p, ["b", "g"], "en el orden en que se eligen")
        XCTAssertEqual(ComposeRules.action(p), .createChat(["b", "g"]))
        XCTAssertEqual(ComposeRules.toggle(p, "b"), ["g"], "tocar otra vez desmarca")
        XCTAssertEqual(ComposeRules.backspace(p, query: ""), ["b"], "borrar en vacío quita el último chip")
        XCTAssertEqual(ComposeRules.backspace(p, query: "Ana"), ["b", "g"], "con texto, borra texto")
        XCTAssertEqual(ComposeRules.backspace([], query: ""), [])
    }

    func testTexts() {
        let saved = L10n.choice; defer { L10n.choice = saved }
        L10n.choice = .es
        XCTAssertEqual(L("compose.openWith", ["name": "Bruno"]), "Abrir chat con Bruno")
        XCTAssertEqual(L("compose.tip"), "Toca una o varias personas. El 💬 abre su chat directo.")
        XCTAssertEqual(L("chat.createGroup", ["n": 3]), "Crear chat de 3")
        L10n.choice = .en
        XCTAssertEqual(L("compose.openWith", ["name": "Bruno"]), "Open chat with Bruno")
        XCTAssertEqual(L("compose.to"), "To:")
    }
}
