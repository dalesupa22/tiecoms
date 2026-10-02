import XCTest

final class NightProofUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }
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
