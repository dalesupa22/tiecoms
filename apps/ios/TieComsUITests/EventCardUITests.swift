import XCTest

/// Tarjeta del evento en el chat contra el API de PRUEBAS (chat General con «Revisión de precios con el equipo»).
/// Fixture: `TEST_RUNNER_TC_TEMAS_FIXTURE` (el de TemasUITests).
final class EventCardUITests: XCTestCase {
    struct Fixture: Decodable { var apiUrl: String; var email: String; var password: String; var conversationId: String }
    override func setUp() { continueAfterFailure = false }

    func testEventCardShowsAndAnswers() throws {
        guard let path = ProcessInfo.processInfo.environment["TC_TEMAS_FIXTURE"], !path.isEmpty else { throw XCTSkip("Sin TC_TEMAS_FIXTURE") }
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        XCTAssertFalse(f.apiUrl.contains("app.chaggu.com") || f.apiUrl.contains("app.tiecoms.com"), "no se prueba contra producción")
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES",
                               "-TCOpenConversation", f.conversationId, "-AppleLanguages", "(es)", "-AppleLocale", "es_CO"]
        app.launch()
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 15))
        email.tap(); email.typeText(f.email)
        let password = app.secureTextFields["login.password"]
        password.tap(); password.typeText(f.password)
        app.buttons["login.submit"].tap()
        for label in ["Not Now", "Ahora no"] {
            let b = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons[label]
            if b.waitForExistence(timeout: 2) { b.tap() }
        }
        XCTAssertTrue(app.descendants(matching: .any)["composer.field"].waitForExistence(timeout: 20))
        let card = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "msg.eventCard.")).firstMatch
        // La tarjeta está más arriba en el historial: se sube hasta verla.
        for _ in 0..<12 where !(card.exists && card.isHittable) { app.swipeDown(velocity: .slow) }
        XCTAssertTrue(card.waitForExistence(timeout: 5), "tarjeta del evento en el chat")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "📅 EVENTO DE")).firstMatch.exists)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Agendó")).firstMatch.exists, "sin la línea «Agendó…»")
        let yes = app.buttons["eventCard.rsvp.yes"]
        if yes.exists {
            yes.tap()
            let pred = NSPredicate(format: "isSelected == true")
            expectation(for: pred, evaluatedWith: yes)
            waitForExpectations(timeout: 10)
        }
        sleep(1)
        let s = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: s); a.name = "ios-evento"; a.lifetime = .keepAlways; add(a)
        if let dir = ProcessInfo.processInfo.environment["TC_SHOTS"], !dir.isEmpty {
            try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("ios-evento.png"))
        }
    }
}
