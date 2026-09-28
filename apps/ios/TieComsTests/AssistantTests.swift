import XCTest
@testable import TieComs

/// gg, el asistente (docs/ASISTENTE.md): contrato, historial por persona, «envíalos», voz y dónde aparece la burbuja.
@MainActor
final class AssistantTests: XCTestCase {
    private var defaults: UserDefaults!
    private let suite = "tc-assistant-tests"

    override func setUp() {
        defaults = UserDefaults(suiteName: suite)
        defaults.removePersistentDomain(forName: suite)
    }
    override func tearDown() { defaults.removePersistentDomain(forName: suite) }

    func testDecodesTurnAndToleratesUnknownKinds() throws {
        let json = #"""
        {"reply":"Preparé 2 respuestas.","actions":[
          {"id":"a1","kind":"send_message","status":"pending","target":"Laura Méndez","text":"Hola","token":"tok-123456"},
          {"id":"a2","kind":"mark_read","status":"done","target":"Andes · Operación","text":"3 chats","undoToken":"u-1","link":"/c/abc-1"},
          {"id":"a3","kind":"future_kind","status":"weird","target":"x","text":"y","detail":null}
        ]}
        """#
        let t = try JSONDecoder().decode(AssistantTurnDTO.self, from: Data(json.utf8))
        XCTAssertEqual(t.reply, "Preparé 2 respuestas.")
        XCTAssertEqual(t.actions.map(\.kind), [.sendMessage, .markRead, .unknown])
        XCTAssertEqual(t.actions[0].status, .pending)
        XCTAssertEqual(t.actions[0].token, "tok-123456")
        XCTAssertEqual(t.actions[1].undoToken, "u-1")
        XCTAssertEqual(t.actions[2].status, .failed, "un estado desconocido no se muestra como pendiente")
        XCTAssertEqual(t.actions.map(\.icon), ["✉\u{FE0E}", "◉\u{FE0E}", "•"], "símbolo de texto, no emoji")
        XCTAssertEqual(t.actions[0].verbKey, "ai.send")
        XCTAssertEqual(AssistantActionDTO(id: "c", kind: .cancelEvent, status: .pending).verbKey, "ai.cancelEvent")
        XCTAssertEqual(AssistantActionDTO(id: "g", kind: .createGroup, status: .pending).verbKey, "ai.create")
    }

    func testHistoryIsPerUserAndDropsOtherAccounts() {
        let a = [AssistantTurn(role: .user, content: "hola"), AssistantTurn(role: .assistant, content: "¿en qué te ayudo?")]
        AssistantHistory.save("user-a", a, defaults: defaults)
        XCTAssertEqual(AssistantHistory.load("user-a", defaults: defaults).map(\.content), ["hola", "¿en qué te ayudo?"])
        XCTAssertNotNil(defaults.data(forKey: "assistant:user-a"), "clave assistant:<userId>")

        // Otra cuenta en el mismo dispositivo no ve lo de la primera, y lo de la primera se descarta.
        XCTAssertTrue(AssistantHistory.load("user-b", defaults: defaults).isEmpty)
        XCTAssertNil(defaults.data(forKey: "assistant:user-a"))
        XCTAssertTrue(AssistantHistory.load("user-a", defaults: defaults).isEmpty)
    }

    func testHistoryKeepsLast40AndClearsOnSignOut() {
        let many = (0..<55).map { AssistantTurn(role: $0 % 2 == 0 ? .user : .assistant, content: "t\($0)") }
        AssistantHistory.save("u", many, defaults: defaults)
        let back = AssistantHistory.load("u", defaults: defaults)
        XCTAssertEqual(back.count, 40)
        XCTAssertEqual(back.first?.content, "t15")
        AssistantHistory.clearAll(defaults: defaults)
        XCTAssertTrue(AssistantHistory.load("u", defaults: defaults).isEmpty)
    }

    func testPayloadSendsLast20WithActionSummaryWithoutTokens() {
        var turns = (0..<25).map { AssistantTurn(role: $0 % 2 == 0 ? .user : .assistant, content: "t\($0)") }
        turns.append(AssistantTurn(role: .assistant, content: "Listo", actions: [
            AssistantActionDTO(id: "1", kind: .sendMessage, status: .pending, target: "Laura", text: "Hola", token: "SECRET-TOKEN"),
            AssistantActionDTO(id: "2", kind: .markRead, status: .done, target: "Obra", text: "leído", undoToken: "SECRET-UNDO"),
        ]))
        let p = Assistant.payload(turns)
        XCTAssertEqual(p.count, 20)
        XCTAssertEqual(p.last?["role"], "assistant")
        XCTAssertEqual(p.last?["content"], "Listo\n[pending: send_message → Laura: Hola | done: mark_read → Obra: leído]")
        XCTAssertFalse(p.contains { ($0["content"] ?? "").contains("SECRET") })
    }

    func testSendAllPhrases() {
        for s in ["envíalos", "Envíalos.", "mándalos", "dale", "sí, envía", "Si envialos", "send them", "Send it!"] {
            XCTAssertTrue(Assistant.isSendAll(s), s)
        }
        for s in ["envíale a Laura que sí", "dale un reporte", "no los envíes", "márcalos todos como leídos"] {
            XCTAssertFalse(Assistant.isSendAll(s), s)
        }
    }

    func testPendingAndPatch() {
        var turns = [AssistantTurn(role: .assistant, content: "x", actions: [
            AssistantActionDTO(id: "1", kind: .sendMessage, status: .pending, token: "t1"),
            AssistantActionDTO(id: "2", kind: .sendMessage, status: .pending, token: "t2"),
            AssistantActionDTO(id: "3", kind: .createIssue, status: .done, undoToken: "u3"),
        ])]
        XCTAssertEqual(Assistant.pending(turns).map(\.id), ["1", "2"])
        Assistant.patch(&turns, "1") { $0.status = .undone; $0.token = nil }
        XCTAssertEqual(Assistant.pending(turns).map(\.id), ["2"])
    }

    func testSpeechSaysYiyi() {
        XCTAssertEqual(Assistant.speakable("Soy gg, ¿en qué te ayudo?"), "Soy yiyi, ¿en qué te ayudo?")
        XCTAssertEqual(Assistant.speakable("GG listo"), "yiyi listo")
        XCTAssertEqual(Assistant.speakable("eggs y huggg"), "eggs y huggg", "solo la palabra suelta")
    }

    func testLinksOpenChatOrCalendar() {
        XCTAssertEqual(Assistant.deepLink("/c/abc-123"), .conversation("abc-123"))
        XCTAssertEqual(Assistant.deepLink("/agenda"), .agenda)
        XCTAssertEqual(Assistant.deepLink("/asuntos"), .issues)
        XCTAssertNil(Assistant.deepLink("https://evil.example/c/x"))
        XCTAssertNil(Assistant.deepLink(nil))
    }

    func testBubbleOnlyOnLists() {
        XCTAssertTrue(Assistant.bubbleVisible(path: [], openConversationId: nil))
        XCTAssertFalse(Assistant.bubbleVisible(path: [.conversation("c1")], openConversationId: "c1"), "dentro de un chat no aparece")
        XCTAssertFalse(Assistant.bubbleVisible(path: [.issue("i1")], openConversationId: nil))
        XCTAssertFalse(Assistant.bubbleVisible(path: [], openConversationId: "c1"))
    }

    func testStringsExistInBothLanguages() {
        let keys = ["ai.open", "ai.subtitle", "ai.bubbleHint", "ai.hello", "ai.intro", "ai.voiceHint", "ai.s.report", "ai.s.pending", "ai.s.due",
                    "ai.s.write", "ai.s.group", "ai.s.meeting", "ai.s.issue", "ai.s.cancel", "ai.placeholder", "ai.send", "ai.talk",
                    "ai.stop", "ai.listening", "ai.sendAll", "ai.sentAll", "ai.create", "ai.confirm", "ai.cancelEvent", "ai.edit",
                    "ai.discard", "ai.done", "ai.undone", "ai.failed", "ai.undo", "ai.openIt", "ai.clear", "ai.speakOn", "ai.speakOff",
                    "ai.unavailable"]
        for lang in ["es", "en"] {
            let b = Bundle(path: Bundle.main.path(forResource: lang, ofType: "lproj")!)!
            for k in keys { XCTAssertNotEqual(b.localizedString(forKey: k, value: "∅", table: nil), "∅", "\(lang): \(k)") }
        }
        let es = Bundle(path: Bundle.main.path(forResource: "es", ofType: "lproj")!)!
        XCTAssertEqual(es.localizedString(forKey: "ai.s.pending", value: nil, table: nil), "Responde mis pendientes")
        XCTAssertNotNil(Bundle.main.object(forInfoDictionaryKey: "NSSpeechRecognitionUsageDescription"))
        XCTAssertNotNil(Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription"))
    }
}
