import XCTest

final class NightProofUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false; XCUIDevice.shared.orientation = .portrait }
    override func tearDown() { XCUIDevice.shared.orientation = .portrait; super.tearDown() }
    private func app() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-TCNightProof", "YES", "-TCApiURL", "http://127.0.0.1:39999", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES", "-AppleLanguages", "(es)", "-AppleLocale", "es_CO"]
        app.launch(); return app
    }
    private func shot(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
        if let dir = ProcessInfo.processInfo.environment["TC_SHOTS"] {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name + ".png"))
        }
    }
    func testHistoricalLongMessageHasCompleteIndependentReaderAndReturns() {
        let app = app()
        let more = app.buttons["msg.readMore.qa-long"]
        XCTAssertTrue(more.waitForExistence(timeout: 10))
        app.swipeUp(); more.tap()
        let text = app.textViews["longText.body"]
        XCTAssertTrue(text.waitForExistence(timeout: 5))
        XCTAssertTrue((text.value as? String)?.contains("FIN DEL MENSAJE ORIGINAL — 120 LÍNEAS") == true)
        shot("ios-N31-lector-inicio")
        for _ in 0..<12 { text.swipeUp() }
        shot("ios-N31-lector-final")
        XCTAssertTrue(app.buttons["longText.copy"].exists)
        app.buttons["longText.close"].tap()
        XCTAssertTrue(app.textViews["composer.field"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.keyboards.firstMatch.exists)
    }
    func testLeavingComposerDismissesKeyboardAndPreservesDraft() {
        let app = app()
        let field = app.textViews["composer.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap(); field.typeText("Borrador que debe seguir disponible")
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        shot("ios-N32-teclado-abierto")
        app.buttons["night.exit"].tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        XCTAssertEqual(field.value as? String, "Borrador que debe seguir disponible")
        shot("ios-N32-teclado-cerrado")
    }
    func testAnimatedGifCodeAndThreeAssigneesProof() {
        let app = app()
        XCTAssertTrue(app.descendants(matching: .any)["night.gif"].waitForExistence(timeout: 10))
        shot("ios-N01-N02-N14-chat")
        app.buttons["Tareas"].tap()
        app.descendants(matching: .any)["issue.assignees"].firstMatch.tap()
        for id in ["qa-a", "qa-b", "qa-c"] {
            let toggle = app.descendants(matching: .any)["issue.assignee.\(id)"].firstMatch
            XCTAssertTrue(toggle.waitForExistence(timeout: 5), app.debugDescription); toggle.tap()
        }
        XCTAssertTrue(app.staticTexts["night.assigneeCount"].label.contains("3"))
        shot("ios-N27-responsables")
    }
    func testVoicePreviewAndCalendarFormRequireExplicitSendOrConfirm() {
        let app = app()
        app.buttons["Voz"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["voice.preview"].waitForExistence(timeout: 5))
        shot("ios-N21-vista-previa-voz")
        app.buttons["Agenda"].tap(); app.buttons["night.calendar"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["gg.calendar"].waitForExistence(timeout: 5))
        shot("ios-N29-calendario-formulario")
        XCTAssertFalse(app.buttons["gg.calendar.created"].exists)
    }

}

extension NightProofUITests {
    private func composerApp(resume: Bool = false, large: Bool = false, extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-TCNightProof", "YES", "-TCComposerProof", "YES", "-TCApiURL", "http://127.0.0.1:39999", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES", "-AppleLanguages", "(es)", "-AppleLocale", "es_CO"]
        app.launchArguments += extra
        if resume { app.launchArguments += ["-TCComposerResume", "YES"] }
        if large { app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"] }
        app.launch(); return app
    }
    private func metric(_ app: XCUIApplication, _ key: String) -> Int {
        let tokens = app.staticTexts["proof.metrics"].label.split(separator: " ")
        return tokens.first { $0.hasPrefix(key + "=") }.flatMap { Int($0.split(separator: "=").last!) } ?? -1
    }
    private func expectCaret(_ app: XCUIApplication) {
        let visible = NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "caret=yes", "onscreen=yes")
        let result = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: visible, object: app.staticTexts["proof.metrics"])], timeout: 5)
        if result != .completed { shot("composer-caret-failure") }
        XCTAssertEqual(result, .completed, app.staticTexts["proof.metrics"].label)
    }
    func testRealConversationLongComposerScrollEditAndRestore() {
        let app = composerApp()
        let field = app.textViews["composer.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        field.typeText("Uno")
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        let small = field.frame.height
        field.typeText("\nDos\nTres\nCuatro\nCinco\nSeis")
        XCTAssertGreaterThan(field.frame.height, small)
        XCTAssertLessThan(field.frame.height, 160)
        expectCaret(app)
        shot("composer-6-lineas-sin-barra")
        app.buttons["proof.copy100"].tap()
        field.press(forDuration: 1.1)
        let selectAll = app.menuItems.matching(NSPredicate(format: "label IN %@", ["Select All", "Seleccionar todo"])).firstMatch
        for _ in 0..<4 where !selectAll.exists {
            let next = app.buttons.matching(NSPredicate(format: "label IN %@", ["Next", "Adelante"])).firstMatch
            if next.exists { next.tap() }
        }
        XCTAssertTrue(selectAll.waitForExistence(timeout: 5)); selectAll.tap()
        let paste = app.menuItems.matching(NSPredicate(format: "label IN %@", ["Paste", "Pegar"])).firstMatch
        XCTAssertTrue(paste.waitForExistence(timeout: 5), app.debugDescription)
        paste.tap()
        let allow = app.buttons.matching(NSPredicate(format: "label IN %@", ["Allow Paste", "Permitir pegar"])).firstMatch
        if allow.waitForExistence(timeout: 1) { allow.tap() }
        let original = (1...100).map { "Línea \($0): borrador QA 👋" }.joined(separator: "\n")
        let full = NSPredicate(format: "value == %@", original)
        expectation(for: full, evaluatedWith: field); waitForExpectations(timeout: 6)
        expectCaret(app)
        XCTAssertGreaterThan(metric(app, "y"), 0)
        XCTAssertLessThanOrEqual(field.frame.maxY, app.keyboards.firstMatch.frame.minY + 2)
        shot("composer-100-lineas-final")
        let history = app.descendants(matching: .any)["msg.qa-history-2"].firstMatch
        let historyFrame = history.frame
        let initialY = metric(app, "y")
        field.swipeDown(velocity: .fast)
        XCTAssertLessThan(metric(app, "y"), initialY)
        for _ in 0..<15 where metric(app, "y") > 1 { field.swipeDown(velocity: .fast) }
        XCTAssertLessThanOrEqual(metric(app, "y"), 1)
        XCTAssertEqual(field.value as? String, original)
        XCTAssertEqual(history.frame.minY, historyFrame.minY, accuracy: 1, "editor pan must not scroll the conversation history (allow pixel rounding)")
        XCTAssertEqual(history.frame.height, historyFrame.height, accuracy: 1)
        shot("composer-100-lineas-inicio-scroll")
        var expected = original
        for (button, needle, addition) in [("Inicio", "Línea 1:", "INICIO "), ("Medio", "Línea 50:", "MEDIO "), ("Final", "", " FINAL")] {
            app.buttons["proof." + button].tap(); expectCaret(app)
            field.typeText(addition)
            if needle.isEmpty { expected += addition } else { expected = expected.replacingOccurrences(of: needle, with: addition + needle) }
            XCTAssertEqual(field.value as? String, expected)
            expectCaret(app)
            shot("composer-editar-" + button)
        }
        XCUIDevice.shared.orientation = .landscapeLeft
        expectCaret(app); XCTAssertEqual(field.value as? String, expected)
        XCTAssertLessThanOrEqual(field.frame.maxY, app.keyboards.firstMatch.frame.minY + 2)
        XCTAssertTrue(app.buttons["composer.send"].isHittable)
        XCTAssertTrue(app.buttons["composer.attach"].isHittable)
        shot("composer-horizontal")
        XCUIDevice.shared.orientation = .portrait
        app.buttons["proof.route"].tap()
        XCTAssertFalse(app.textViews["composer.field"].exists)
        app.buttons["proof.route"].tap()
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        expectation(for: NSPredicate(format: "value == %@", expected), evaluatedWith: field); waitForExpectations(timeout: 5)
        app.terminate()
        let restored = composerApp(resume: true)
        let restoredField = restored.textViews["composer.field"]
        XCTAssertTrue(restoredField.waitForExistence(timeout: 5))
        expectation(for: NSPredicate(format: "value == %@", expected), evaluatedWith: restoredField); waitForExpectations(timeout: 5)
    }
    func testFormatThroughPlusPreservesKeyboardAndRendersLocalMessage() {
        let app = composerApp()
        let field = app.textViews["composer.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        app.buttons["composer.attach"].tap()
        app.buttons["composer.plus.format"].tap()
        shot("composer-plus-menu-formato")
        app.buttons["composer.format.**"].tap()
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        field.typeText("Negrita")
        XCTAssertEqual(field.value as? String, "**Negrita**")
        shot("composer-preview-negrita")
        app.buttons["proof.Final"].tap()
        field.typeText(" ")
        app.buttons["composer.attach"].tap(); app.buttons["composer.plus.format"].tap(); app.buttons["composer.format.`"].tap()
        field.typeText("let x = 1")
        XCTAssertEqual(field.value as? String, "**Negrita** `let x = 1`")
        shot("composer-preview-codigo")
        app.buttons["composer.send"].tap() // Intercepted in-process by ComposerProofTransport.
        let sent = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Negrita let x = 1")).firstMatch
        XCTAssertTrue(sent.waitForExistence(timeout: 5), app.debugDescription)
        shot("composer-formato-mensaje-local")
    }
}

extension NightProofUITests {
    func testLargeTypeLongComposer() {
        let app = composerApp(large: true)
        let field = app.textViews["composer.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap(); field.typeText("Texto" + String(repeating: "\nMás texto", count: 50))
        expectCaret(app)
        XCTAssertLessThanOrEqual(field.frame.maxY, app.keyboards.firstMatch.frame.minY + 2)
        XCTAssertTrue((field.value as? String)?.hasSuffix("Más texto") == true)
        shot("composer-dynamic-type-50-lineas")
    }
    func testNativeSelectionFormatMenu() {
        let app = composerApp()
        let field = app.textViews["composer.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap(); field.typeText("Texto")
        field.press(forDuration: 1.1)
        let selectAll = app.menuItems.matching(NSPredicate(format: "label IN %@", ["Select All", "Seleccionar todo"])).firstMatch
        XCTAssertTrue(selectAll.waitForExistence(timeout: 5)); selectAll.tap()
        let format = app.buttons["Formato"]
        for _ in 0..<5 where !format.exists {
            let next = app.buttons.matching(NSPredicate(format: "label IN %@", ["Next", "Adelante"])).firstMatch
            if next.exists { next.tap() }
        }
        XCTAssertEqual(app.buttons.matching(identifier: "Formato").count, 1, "one complete formatting menu")
        XCTAssertTrue(format.exists, app.debugDescription); format.tap()
        shot("composer-menu-nativo-formato")
        let bold = app.buttons["Negrita"]
        XCTAssertTrue(bold.waitForExistence(timeout: 5)); bold.tap()
        XCTAssertEqual(field.value as? String, "**Texto**")
        XCTAssertTrue(app.keyboards.firstMatch.exists)
    }
}


extension NightProofUITests {
    func testSelectedTextFormatFromPlusKeepsSelectionAndKeyboard() {
        let app = composerApp()
        let field = app.textViews["composer.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap(); field.typeText("Elegido")
        field.press(forDuration: 1.1)
        let selectAll = app.menuItems.matching(NSPredicate(format: "label IN %@", ["Select All", "Seleccionar todo"])).firstMatch
        for _ in 0..<4 where !selectAll.exists {
            let next = app.buttons.matching(NSPredicate(format: "label IN %@", ["Next", "Adelante"])).firstMatch
            if next.exists { next.tap() }
        }
        XCTAssertTrue(selectAll.waitForExistence(timeout: 5)); selectAll.tap()
        XCTAssertEqual(metric(app, "nsel"), 7)
        app.buttons["composer.attach"].tap()
        let format = app.buttons["composer.plus.format"]
        if !format.waitForExistence(timeout: 1) { app.buttons["composer.attach"].tap() }
        XCTAssertTrue(format.waitForExistence(timeout: 3)); format.tap()
        shot("composer-plus-menu-seleccion")
        app.buttons["composer.format.**"].tap()
        XCTAssertEqual(field.value as? String, "**Elegido**")
        XCTAssertEqual(metric(app, "sel"), 2)
        XCTAssertEqual(metric(app, "nsel"), 7)
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        shot("composer-negrita-seleccion-conservada")
    }
}


extension NightProofUITests {
    func testReadOnlyAndGgSelectionRemainAvailable() {
        var app = composerApp(extra: ["-TCProofReadOnly", "YES"])
        let readOnly = app.staticTexts["chat.readOnly"]
        XCTAssertTrue(readOnly.waitForExistence(timeout: 8))
        XCTAssertFalse(app.textViews["composer.field"].exists)
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(readOnly.isHittable)
        shot("composer-readonly-horizontal")
        XCUIDevice.shared.orientation = .portrait
        app.terminate()
        app = composerApp(extra: ["-TCProofGg", "YES"])
        let field = app.textViews["composer.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 8))
        field.tap(); field.typeText("Borrador conservado")
        let message = app.descendants(matching: .any)["msg.qa-history-2"].firstMatch
        message.press(forDuration: 1.1)
        let select = app.buttons["menu.select"]
        XCTAssertTrue(select.waitForExistence(timeout: 5)); select.tap()
        XCTAssertTrue(app.buttons["gg.select.cancel"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["gg.select.ask"].isHittable)
        XCTAssertFalse(app.textViews["composer.field"].exists)
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(app.buttons["gg.select.ask"].isHittable)
        shot("composer-gg-selection-horizontal")
        app.buttons["gg.select.cancel"].tap()
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        XCTAssertEqual(field.value as? String, "Borrador conservado")
        XCUIDevice.shared.orientation = .portrait
    }
}
