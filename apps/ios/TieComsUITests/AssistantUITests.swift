import XCTest

/// gg, el asistente (docs/ASISTENTE.md), contra un API de PRUEBAS con DeepSeek: la burbuja solo en las listas,
/// el panel con sugerencias, «Responde mis pendientes» con tarjetas, «Enviar todos» y «márcalos todos como leídos».
///
/// Fixture por `TEST_RUNNER_TC_FIXTURE_ASSISTANT` ({ apiUrl, email, pw }). Capturas en `TEST_RUNNER_TC_SHOTS`
/// (prefijo `TEST_RUNNER_TC_SHOTS_PREFIX`, por defecto `ios-`).
final class AssistantUITests: XCTestCase {
    struct Fixture: Decodable { var apiUrl: String; var email: String; var pw: String }

    override func setUp() { continueAfterFailure = false }

    private var env: [String: String] { ProcessInfo.processInfo.environment }

    private func fixture() throws -> Fixture {
        guard let path = env["TC_FIXTURE_ASSISTANT"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE_ASSISTANT") }
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        XCTAssertFalse(f.apiUrl.contains("chaggu.com") || f.apiUrl.contains("tiecoms.com"), "no se prueba contra producción")
        return f
    }

    private func shot(_ name: String) {
        let s = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: s)
        a.name = name
        a.lifetime = .keepAlways
        add(a)
        if let dir = env["TC_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            let file = (env["TC_SHOTS_PREFIX"] ?? "ios-") + name + ".png"
            try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent(file))
        }
    }

    private func login(_ f: Fixture, language: String = "es") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES", "-TCResetLanguage", "YES",
                               "-AppleLanguages", "(\(language))", "-AppleLocale", language == "es" ? "es_CO" : "en_US", "-tc.assistantSpeak", "NO", "-TCNoAnimations", "YES"]
        app.launch()
        let email = app.textFields["login.email"]
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline && !email.exists && !app.tabBars.firstMatch.exists { usleep(300_000) }
        if app.tabBars.firstMatch.exists && !email.exists { return app }
        XCTAssertTrue(email.waitForExistence(timeout: 2))
        email.tap(); email.typeText(f.email)
        let pw = app.secureTextFields["login.password"]
        pw.tap(); pw.typeText(f.pw)
        app.buttons["login.submit"].tap()
        let notNow = app.buttons.matching(NSPredicate(format: "label IN %@", ["Not Now", "Ahora no"])).firstMatch
        if notNow.waitForExistence(timeout: 5) { notNow.tap() }
        return app
    }

    private func allowAI(_ app: XCUIApplication) {
        let allow = app.buttons.matching(identifier: "assistant.consent.allow").firstMatch
        XCTAssertTrue(allow.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["assistant.consent.cancel"].exists)
        allow.tap()
    }

    private func count(_ app: XCUIApplication, _ id: String) -> Int {
        app.descendants(matching: .any).matching(identifier: id).count
    }

    /// Local fixture only; deliberately cancels every prompt, so no provider request or action is made.
    func testConsentCancelKeepsDraftInSpanishAndEnglish() throws {
        let f = try fixture()
        for language in ["es", "en"] {
            let app = login(f, language: language)
            let bubble = app.descendants(matching: .any)["assistant.bubble"]
            XCTAssertTrue(bubble.waitForExistence(timeout: 20))
            bubble.tap()
            let draft = "Consent draft 22"
            let input = app.textFields["assistant.input"].exists ? app.textFields["assistant.input"] : app.textViews["assistant.input"]
            XCTAssertTrue(input.waitForExistence(timeout: 5))
            input.tap(); input.typeText(draft)
            app.buttons["assistant.send"].tap()
            let cancel = app.buttons.matching(identifier: "assistant.consent.cancel").firstMatch
            XCTAssertTrue(cancel.waitForExistence(timeout: 5))
            XCTAssertTrue(app.buttons["assistant.consent.allow"].exists)
            XCTAssertTrue(app.alerts.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "DeepSeek")).firstMatch.exists)
            shot("consent-\(language)")
            cancel.tap()
            XCTAssertEqual(input.value as? String, draft)
            app.buttons["assistant.close"].tap()
            XCTAssertTrue(bubble.waitForExistence(timeout: 5))
            bubble.tap()
            let reopenedInput = app.textFields["assistant.input"].exists ? app.textFields["assistant.input"] : app.textViews["assistant.input"]
            XCTAssertTrue(reopenedInput.waitForExistence(timeout: 5))
            XCTAssertEqual(reopenedInput.value as? String, draft)
            app.buttons["assistant.send"].tap()
            XCTAssertTrue(cancel.waitForExistence(timeout: 5))
            cancel.tap()
            app.terminate()
        }
    }

    func testBubblePanelPendingRepliesSendAllAndMarkRead() throws {
        let f = try fixture()
        let app = login(f)
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 20))
        let bubble = app.descendants(matching: .any)["assistant.bubble"]
        XCTAssertTrue(bubble.waitForExistence(timeout: 10), "la burbuja está en Grupos")
        shot("01-burbuja-grupos")

        // En las otras listas sí.
        app.tabBars.buttons.element(boundBy: 1).tap()
        XCTAssertTrue(bubble.waitForExistence(timeout: 5), "la burbuja está en DMs")

        // Tocar abre el panel con el saludo y las sugerencias.
        bubble.tap()
        let clear = app.buttons["assistant.clear"]
        if clear.waitForExistence(timeout: 2) { clear.tap() }
        XCTAssertTrue(app.staticTexts["assistant.hello"].waitForExistence(timeout: 5))
        let chip = app.buttons["assistant.chip.ai.s.pending"]
        XCTAssertTrue(chip.exists)
        XCTAssertTrue(app.buttons["assistant.chip.ai.s.write"].exists)
        shot("03-panel-sugerencias")

        // «Responde mis pendientes» → tarjetas de mensajes por confirmar.
        chip.tap()
        allowAI(app)
        let thinking = app.descendants(matching: .any)["assistant.thinking"]
        _ = thinking.waitForExistence(timeout: 3)
        let answer = app.descendants(matching: .any).matching(identifier: "assistant.turn.assistant").firstMatch
        XCTAssertTrue(answer.waitForExistence(timeout: 120), "gg respondió")
        let run = app.buttons.matching(identifier: "assistant.card.run")
        XCTAssertTrue(run.firstMatch.waitForExistence(timeout: 5), "hay tarjetas pendientes: \(answer.label)")
        let pendingCount = run.count
        shot("04-tarjetas-pendientes")

        // Enviar todos (N) cuando hay más de uno; si no, el botón de la tarjeta.
        let sendAll = app.buttons["assistant.sendAll"]
        if pendingCount > 1 {
            XCTAssertTrue(sendAll.exists)
            XCTAssertTrue(sendAll.label.contains("\(pendingCount)"), sendAll.label)
            sendAll.tap()
        } else {
            run.firstMatch.tap()
        }
        let done = app.staticTexts.matching(identifier: "assistant.card.done")
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline && done.count < pendingCount { usleep(300_000) }
        XCTAssertGreaterThanOrEqual(done.count, pendingCount, "todas quedaron «Hecho»")
        XCTAssertFalse(sendAll.exists)
        XCTAssertEqual(app.buttons.matching(identifier: "assistant.card.run").count, 0)
        shot("05-enviados")

        // «márcalos todos como leídos» → marcar_leido se hace de una vez (con Deshacer).
        let answersBefore = app.descendants(matching: .any).matching(identifier: "assistant.turn.assistant").count
        let input = app.textFields["assistant.input"].exists ? app.textFields["assistant.input"] : app.textViews["assistant.input"]
        input.tap()
        input.typeText("márcalos todos como leídos")
        app.buttons["assistant.send"].tap()
        let later = Date().addingTimeInterval(120)
        while Date() < later && app.descendants(matching: .any).matching(identifier: "assistant.turn.assistant").count <= answersBefore { usleep(500_000) }
        XCTAssertGreaterThan(app.descendants(matching: .any).matching(identifier: "assistant.turn.assistant").count, answersBefore, "gg respondió")
        sleep(1)
        let marked = app.descendants(matching: .any).matching(identifier: "assistant.card.mark_read")
        XCTAssertGreaterThan(marked.count, 0, "hay una tarjeta de «leído»")
        shot("06-marcados-leidos")

        // Cerrar y volver: el historial sigue en el dispositivo.
        app.buttons["assistant.close"].tap()
        XCTAssertTrue(bubble.waitForExistence(timeout: 5))
        bubble.tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "assistant.card.mark_read").firstMatch.waitForExistence(timeout: 5),
                      "el historial se conserva al reabrir")
        XCTAssertFalse(app.staticTexts["assistant.hello"].exists)
        shot("07-historial")
        app.buttons["assistant.close"].tap()

        // Al final (abrir un chat lo marca leído): en DMs, dentro de un chat no aparece la burbuja.
        let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'conv.row.'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 8), "hay chats en DMs")
        do {
            row.tap()
            XCTAssertTrue(app.navigationBars.buttons.firstMatch.waitForExistence(timeout: 8))
            sleep(1)
            shot("08-chat-sin-burbuja")
            XCTAssertFalse(bubble.exists, "dentro de un chat no aparece la burbuja")
            app.navigationBars.buttons.firstMatch.tap()
            XCTAssertTrue(bubble.waitForExistence(timeout: 8), "al volver a la lista vuelve la burbuja")
        }
    }

    private func answers(_ app: XCUIApplication) -> Int {
        app.descendants(matching: .any).matching(identifier: "assistant.turn.assistant").count
    }

    /// Espera la siguiente respuesta de gg (hasta 2 min: DeepSeek real).
    private func waitAnswer(_ app: XCUIApplication, after n: Int) {
        let later = Date().addingTimeInterval(120)
        while Date() < later && answers(app) <= n { usleep(500_000) }
        XCTAssertGreaterThan(answers(app), n, "gg respondió")
        sleep(1)
    }

    private func type(_ app: XCUIApplication, _ text: String) {
        let input = app.textFields["assistant.input"].exists ? app.textFields["assistant.input"] : app.textViews["assistant.input"]
        input.tap()
        input.typeText(text)
        app.buttons["assistant.send"].tap()
    }

    /// Chips de siguiente paso, «Otra versión», «envíalos» con la confirmación local y botones de la tarjeta en una línea.
    func testNextStepsAnotherVersionAndSendIt() throws {
        let f = try fixture()
        let app = login(f)
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 20))
        app.tabBars.buttons.element(boundBy: 1).tap()
        let bubble = app.descendants(matching: .any)["assistant.bubble"]
        XCTAssertTrue(bubble.waitForExistence(timeout: 10))
        bubble.tap()
        let clear = app.buttons["assistant.clear"]
        if clear.waitForExistence(timeout: 2) { clear.tap() }
        XCTAssertTrue(app.staticTexts["assistant.hello"].waitForExistence(timeout: 5))

        app.buttons["assistant.chip.ai.s.pending"].tap()
        allowAI(app)
        waitAnswer(app, after: 0)
        let run = app.buttons.matching(identifier: "assistant.card.run").firstMatch
        XCTAssertTrue(run.waitForExistence(timeout: 5), "hay borradores")
        // Enviar · Editar · Otra versión · Descartar en una sola línea.
        let edit = app.buttons.matching(identifier: "assistant.card.edit").firstMatch
        let redo = app.buttons.matching(identifier: "assistant.card.redo").firstMatch
        let discard = app.buttons.matching(identifier: "assistant.card.discard").firstMatch
        XCTAssertTrue(redo.exists && edit.exists && discard.exists)
        XCTAssertEqual(redo.label, "Otra versión")
        for b in [edit, redo, discard] { XCTAssertEqual(b.frame.midY, run.frame.midY, accuracy: 3, "\(b.label) en la misma línea") }
        XCTAssertLessThanOrEqual(discard.frame.maxX, app.windows.firstMatch.frame.maxX - 12, "cabe en la tarjeta")
        shot("09-botones-compactos")

        // Chips de siguiente paso bajo la última respuesta.
        let next = app.buttons.matching(identifier: "assistant.next")
        XCTAssertTrue(next.firstMatch.waitForExistence(timeout: 3), "gg sugirió siguientes pasos")
        app.swipeUp()
        shot("10-siguientes-pasos")

        // «Otra versión»: descarta ese borrador y pide otro.
        let before = answers(app)
        let pendingBefore = app.buttons.matching(identifier: "assistant.card.run").count
        redo.tap()
        let ask = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Redacta otra versión del mensaje para '")).firstMatch
        XCTAssertTrue(ask.waitForExistence(timeout: 5), "se pidió otra versión")
        waitAnswer(app, after: before)
        let pendingNow = app.buttons.matching(identifier: "assistant.card.run").count
        XCTAssertGreaterThanOrEqual(pendingNow, 1, "hay un borrador nuevo")
        XCTAssertLessThanOrEqual(pendingNow, pendingBefore + 1)
        shot("11-otra-version")

        // «envíalos»: se confirman aquí mismo y gg lo dice.
        let n = app.buttons.matching(identifier: "assistant.card.run").count
        type(app, "envíalos")
        let expected = n == 1 ? "Listo, lo envié." : "Listo, envié los \(n)."
        XCTAssertTrue(app.staticTexts[expected].waitForExistence(timeout: 30), expected)
        XCTAssertEqual(app.buttons.matching(identifier: "assistant.card.run").count, 0)
        shot("12-envialos")

        // Tocar un chip de siguiente paso lo envía como si lo hubiera escrito.
        let before2 = answers(app)
        type(app, "Qué vence hoy")
        waitAnswer(app, after: before2)
        XCTAssertTrue(next.firstMatch.waitForExistence(timeout: 3), "gg sugirió siguientes pasos")
        shot("13-chips-tras-respuesta")
        let chipText = next.firstMatch.label
        let before3 = answers(app)
        next.firstMatch.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "identifier == 'assistant.turn.user' AND label == %@", chipText)).firstMatch.waitForExistence(timeout: 5),
                      "el chip se envió como pregunta")
        waitAnswer(app, after: before3)
        shot("14-chip-enviado")
        app.buttons["assistant.close"].tap()
    }
}
