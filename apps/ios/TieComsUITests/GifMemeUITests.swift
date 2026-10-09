import XCTest

/// Local fixture only. Browse/customize/stage without pressing Send.
final class GifMemeUITests: XCTestCase {
    struct Fixture: Decodable { let apiUrl: String; let email: String; let password: String; let conversationId: String }
    override func setUp() { continueAfterFailure = false }
    private func tap(_ element: XCUIElement) {
        element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }
    private func shot(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
        if let directory = ProcessInfo.processInfo.environment["TC_SHOTS"] {
            try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: directory).appendingPathComponent(name + ".png"))
        }
    }
    func testCatalogAndLocalMemeKeepDraftUntilSend() throws {
        guard let path = ProcessInfo.processInfo.environment["TC_FIXTURE_GIFS"] else { throw XCTSkip("No local GIF fixture") }
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        let host = try XCTUnwrap(URL(string: f.apiUrl)?.host)
        XCTAssertTrue(["localhost", "127.0.0.1"].contains(host), "Local fixture only")
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES",
                               "-AppleLanguages", "(es)", "-AppleLocale", "es_CO", "-TCResetLanguage", "YES", "-TCOpenConversation", f.conversationId]
        app.launch()
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 20)); email.tap(); email.typeText(f.email)
        let password = app.secureTextFields["login.password"]; password.tap(); password.typeText(f.password)
        app.buttons["login.submit"].tap()
        let composer = app.textViews["composer.field"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30))
        for surface in [app, XCUIApplication(bundleIdentifier: "com.apple.springboard")] {
            for title in ["Not Now", "Ahora no"] where surface.buttons[title].exists { surface.buttons[title].tap() }
        }
        composer.tap(); composer.typeText("Borrador conservado")
        tap(app.descendants(matching: .any)["composer.attach"]); XCTAssertTrue(app.descendants(matching: .any)["composer.plus.gifs"].waitForExistence(timeout: 8)); tap(app.descendants(matching: .any)["composer.plus.gifs"])
        let first = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gifs.item.")).firstMatch
        XCTAssertTrue(first.waitForExistence(timeout: 40)); shot("01-gif-picker")
        first.tap()
        XCTAssertTrue(app.descendants(matching: .any)["gifs.staged"].waitForExistence(timeout: 10))
        XCTAssertTrue((composer.value as? String)?.contains("Borrador conservado") == true)
        shot("02-gif-staged-draft")
        tap(app.descendants(matching: .any)["composer.attach"]); XCTAssertTrue(app.descendants(matching: .any)["composer.plus.gifs"].waitForExistence(timeout: 8)); tap(app.descendants(matching: .any)["composer.plus.gifs"])
        app.segmentedControls.buttons["Memes"].tap()
        XCTAssertTrue(first.waitForExistence(timeout: 40)); shot("03-meme-templates"); first.tap()
        let top = app.descendants(matching: .any)["meme.top"]
        XCTAssertTrue(app.images["meme.preview"].waitForExistence(timeout: 40)); shot("04-meme-loaded")
        XCTAssertTrue(top.waitForExistence(timeout: 10)); top.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap(); top.typeText("EQUIPO LISTO")
        XCTAssertTrue(app.buttons["keyboard.done"].waitForExistence(timeout: 5)); tap(app.buttons["keyboard.done"])
        let bottom = app.descendants(matching: .any)["meme.bottom"]; bottom.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap(); bottom.typeText("CON UN MEME LOCAL")
        XCTAssertTrue(app.buttons["keyboard.done"].waitForExistence(timeout: 5)); tap(app.buttons["keyboard.done"])
        XCTAssertTrue(app.images["meme.preview"].waitForExistence(timeout: 40)); shot("04-meme-local-preview")
        let add = app.buttons["meme.add"]
        if !add.isHittable { app.swipeUp() }
        XCTAssertTrue(add.isEnabled); add.tap()
        XCTAssertTrue(app.buttons["composer.attach"].waitForExistence(timeout: 10))
        XCTAssertTrue((composer.value as? String)?.contains("Borrador conservado") == true)
        XCTAssertTrue(app.buttons["composer.send"].isEnabled)
        shot("05-gif-and-meme-staged")
    }
}
