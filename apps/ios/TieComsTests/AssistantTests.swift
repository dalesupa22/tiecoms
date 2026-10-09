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
        let keys = ["ai.open", "ai.subtitle", "ai.sentOne", "ai.redo", "ai.redoAsk", "ai.retry", "ai.bubbleHint", "ai.hello", "ai.intro", "ai.voiceHint", "ai.s.report", "ai.s.pending", "ai.s.due",
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

    // MARK: Siguientes pasos, Otra versión, Reintentar y confirmación local

    func testSuggestionsDecodeAndOldHistoryStillLoads() throws {
        let t = try JSONDecoder().decode(AssistantTurnDTO.self, from: Data(#"{"reply":"ok","actions":[],"suggestions":["Dame un reporte"," ","¿Qué vence hoy?"]}"#.utf8))
        XCTAssertEqual(t.suggestions, ["Dame un reporte", "¿Qué vence hoy?"])
        XCTAssertEqual(try JSONDecoder().decode(AssistantTurnDTO.self, from: Data(#"{"reply":"ok","actions":[]}"#.utf8)).suggestions, [])
        // Un turno guardado antes de este cambio (sin suggestions) se sigue leyendo.
        let old = #"[{"id":"6F9619FF-8B86-D011-B42D-00C04FC964FF","role":"assistant","content":"hola","at":780000000}]"#
        let turns = try JSONDecoder().decode([AssistantTurn].self, from: Data(old.utf8))
        XCTAssertNil(turns[0].suggestions)
    }

    func testNextStepsOnlyUnderLastAnswerWhenIdle() {
        let answer = AssistantTurn(role: .assistant, content: "listo", suggestions: ["Envíalos", "Dame un reporte"])
        XCTAssertEqual(Assistant.nextSteps([answer], busy: false, listening: false), ["Envíalos", "Dame un reporte"])
        XCTAssertEqual(Assistant.nextSteps([answer], busy: true, listening: false), [], "no mientras piensa")
        XCTAssertEqual(Assistant.nextSteps([answer], busy: false, listening: true), [], "no mientras escucha")
        XCTAssertEqual(Assistant.nextSteps([answer, AssistantTurn(role: .user, content: "otra cosa")], busy: false, listening: false), [])
    }

    func testLocalConfirmationText() {
        let saved = L10n.choice
        defer { L10n.choice = saved }
        L10n.choice = .es
        XCTAssertEqual(Assistant.sentText(1), "Listo, lo envié.")
        XCTAssertEqual(Assistant.sentText(3), "Listo, envié los 3.")
        L10n.choice = .en
        XCTAssertEqual(Assistant.sentText(1), "Done, sent.")
        XCTAssertEqual(Assistant.sentText(2), "Done, I sent all 2.")
        XCTAssertEqual(L("ai.redoAsk", ["name": "Laura"]), "Write another version of the message for Laura")
    }

    private func mockAPI() -> APIClient {
        MockURLProtocol.requests = []
        return APIClient(baseURL: URL(string: "https://mock.tiecoms.test")!, secrets: MemorySecretStore(), session: MockURLProtocol.session())
    }

    func testRetryResendsLastQuestionWithoutDuplicating() async {
        let api = mockAPI()
        let m = AssistantModel()
        MockURLProtocol.routes["/api/v1/assistant/turn"] = (502, #"{"error":{"code":"assistant_failed","message":"no respondió"}}"#)
        await m.ask("¿Qué vence hoy?", api: api)
        await m.allowConsent()
        XCTAssertNotNil(m.error)
        XCTAssertTrue(m.canRetry)
        XCTAssertEqual(m.turns.map(\.content), ["¿Qué vence hoy?"])

        MockURLProtocol.routes["/api/v1/assistant/turn"] = (200, #"{"reply":"El asunto «Factura».","actions":[],"suggestions":["Dame un reporte"]}"#)
        await m.retry(api: api)
        MockURLProtocol.routes["/api/v1/assistant/turn"] = nil
        XCTAssertNil(m.error)
        XCTAssertFalse(m.canRetry)
        XCTAssertEqual(m.turns.map(\.role), [.user, .assistant], "la pregunta no se repite")
        XCTAssertEqual(m.turns.last?.suggestions, ["Dame un reporte"])
        let sent = MockURLProtocol.requests.filter { $0.path == "/api/v1/assistant/turn" }.last?.body["messages"] as? [[String: String]]
        XCTAssertEqual(sent?.map { $0["content"] ?? "" }, ["¿Qué vence hoy?"])
    }

    func testRedoDiscardsDraftAndAsksForAnotherVersion() async {
        let saved = L10n.choice
        defer { L10n.choice = saved }
        L10n.choice = .es
        let api = mockAPI()
        let m = AssistantModel()
        let draft = AssistantActionDTO(id: "d1", kind: .sendMessage, status: .pending, target: "Laura Méndez", text: "Hola", token: "tok-123456")
        m.turns = [AssistantTurn(role: .assistant, content: "Preparé esto", actions: [draft])]
        MockURLProtocol.routes["/api/v1/assistant/turn"] = (200, #"{"reply":"Otra versión:","actions":[{"id":"d2","kind":"send_message","status":"pending","target":"Laura Méndez","text":"Hola, Laura","token":"tok-654321"}]}"#)
        await m.redo(draft, api: api)
        await m.allowConsent()
        MockURLProtocol.routes["/api/v1/assistant/turn"] = nil
        XCTAssertEqual(m.turns[0].actions?.first?.status, .undone)
        XCTAssertNil(m.turns[0].actions?.first?.token)
        XCTAssertEqual(m.turns[1].content, "Redacta otra versión del mensaje para Laura Méndez")
        XCTAssertEqual(m.pending.map(\.id), ["d2"])
    }

    func testSendItConfirmsLocallyWithoutCallingTurn() async {
        let saved = L10n.choice
        defer { L10n.choice = saved }
        L10n.choice = .es
        let api = mockAPI()
        let m = AssistantModel()
        m.turns = [AssistantTurn(role: .assistant, content: "Listo", actions: [
            AssistantActionDTO(id: "d1", kind: .sendMessage, status: .pending, target: "Laura", text: "Hola", token: "tok-123456"),
        ])]
        MockURLProtocol.routes["/api/v1/assistant/run"] = (200, #"{"id":"d1","kind":"send_message","status":"done","target":"Laura","text":"Hola","undoToken":"u-1","link":"/c/abc"}"#)
        await m.ask("envíalo", api: api)
        MockURLProtocol.routes["/api/v1/assistant/run"] = nil
        XCTAssertEqual(m.turns.last?.content, "Listo, lo envié.")
        XCTAssertEqual(m.turns[0].actions?.first?.status, .done)
        XCTAssertEqual(m.turns[0].actions?.first?.undoToken, "u-1")
        XCTAssertFalse(MockURLProtocol.requests.contains { $0.path == "/api/v1/assistant/turn" })
    }

    func testConsentCancelPreservesDraftAndSendsNoRequest() async {
        let api = mockAPI()
        let m = AssistantModel()
        m.text = "  Ayúdame con el informe  "
        await m.ask(m.text, api: api)
        XCTAssertTrue(m.showConsentPrompt)
        XCTAssertFalse(m.hasAIConsent)
        XCTAssertTrue(m.turns.isEmpty)
        XCTAssertTrue(MockURLProtocol.requests.isEmpty)
        m.cancelConsent()
        await m.allowConsent() // A late callback from a dismissed prompt must not send.
        XCTAssertFalse(m.hasAIConsent)
        XCTAssertFalse(m.showConsentPrompt)
        XCTAssertEqual(m.text, "  Ayúdame con el informe  ")
        XCTAssertTrue(m.turns.isEmpty)
        XCTAssertTrue(MockURLProtocol.requests.isEmpty)
    }

    func testConsentIncludesExplicitFlagAndExpiresWhenPanelCloses() async {
        let api = mockAPI()
        let m = AssistantModel()
        m.speakOn = false
        MockURLProtocol.routes["/api/v1/assistant/turn"] = (200, #"{"reply":"Listo","actions":[]}"#)
        defer { MockURLProtocol.routes["/api/v1/assistant/turn"] = nil }
        await m.ask("Primera pregunta", api: api)
        XCTAssertTrue(MockURLProtocol.requests.isEmpty)
        await m.allowConsent()
        XCTAssertTrue(m.hasAIConsent)
        XCTAssertEqual(MockURLProtocol.requests.count, 1)
        XCTAssertEqual(MockURLProtocol.requests.last?.body["aiConsent"] as? Bool, true)
        await m.ask("Segunda pregunta", api: api)
        XCTAssertEqual(MockURLProtocol.requests.count, 2, "One explicit choice covers this open panel only")
        m.close()
        m.present(listen: false)
        await m.ask("Después de volver a abrir", api: api)
        XCTAssertFalse(m.hasAIConsent)
        XCTAssertTrue(m.showConsentPrompt)
        XCTAssertEqual(MockURLProtocol.requests.count, 2)
        XCTAssertFalse(AssistantModel().hasAIConsent, "A new signed-in view never inherits permission")
    }

    func testChangingAccountInvalidatesPendingConsent() async {
        let api = mockAPI()
        let m = AssistantModel()
        m.bind("consent-test-user-a")
        await m.ask("Borrador privado de A", api: api)
        m.bind("consent-test-user-b")
        await m.allowConsent()
        XCTAssertFalse(m.hasAIConsent)
        XCTAssertFalse(m.showConsentPrompt)
        XCTAssertEqual(m.text, "")
        XCTAssertTrue(MockURLProtocol.requests.isEmpty)
    }

    func testCancelConsentForAnotherVersionKeepsExistingAction() async {
        let api = mockAPI()
        let m = AssistantModel()
        let draft = AssistantActionDTO(id: "draft", kind: .sendMessage, status: .pending, target: "Laura", text: "Hola", token: "test-token")
        m.turns = [AssistantTurn(role: .assistant, content: "Borrador", actions: [draft])]
        await m.redo(draft, api: api)
        m.cancelConsent()
        XCTAssertEqual(m.pending, [draft])
        XCTAssertEqual(m.turns.count, 1)
        XCTAssertTrue(MockURLProtocol.requests.isEmpty)
    }

    func testAPIRejectsMissingConsentBeforeNetworking() async {
        let api = mockAPI()
        do {
            _ = try await api.assistantTurn([AssistantTurn(role: .user, content: "privado")], aiConsent: false)
            XCTFail("Consent is mandatory even for non-UI callers")
        } catch let e as ApiRequestError { XCTAssertEqual(e.code, "ai_consent_required") }
        catch { XCTFail("Unexpected error: \(error)") }
        XCTAssertTrue(MockURLProtocol.requests.isEmpty)
    }

    func testConsentDisclosureNamesProviderAndDataInBothLanguages() {
        let saved = L10n.choice
        defer { L10n.choice = saved }
        for lang in [L10n.Choice.es, .en] {
            L10n.choice = lang
            XCTAssertTrue(L("ai.consentTitle").contains("DeepSeek"))
            XCTAssertTrue(L("ai.consentBody").contains("DeepSeek"))
            XCTAssertTrue(L("ai.consentBody").contains("20"))
            XCTAssertFalse(L("ai.consentAllow").hasPrefix("ai."))
            XCTAssertFalse(L("common.cancel").hasPrefix("common."))
        }
    }
}
