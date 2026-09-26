import XCTest

/// El teclado se cierra: en el login (tocar fuera y «Listo») y en un chat (deslizar la lista y tocar los mensajes).
/// Entorno: TEST_RUNNER_TC_KEYBOARD_FIXTURE=<fx.json de scripts/mobile-fixture.mjs> y TEST_RUNNER_TC_SHOTS=<carpeta>.
final class KeyboardUITests: XCTestCase {
    struct Fixture: Decodable {
        struct Person: Decodable { var email: String }
        var apiUrl: String
        var password: String
        var conversationId: String
        var a: Person
    }

    override func setUp() { continueAfterFailure = false }

    private func fixture() throws -> Fixture {
        guard let path = ProcessInfo.processInfo.environment["TC_KEYBOARD_FIXTURE"], !path.isEmpty else { throw XCTSkip("Sin TC_KEYBOARD_FIXTURE") }
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
    }

    private func shot(_ name: String) {
        let s = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: s); a.name = name; a.lifetime = .keepAlways; add(a)
        if let dir = ProcessInfo.processInfo.environment["TC_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    private func keyboardShown(_ app: XCUIApplication, _ shown: Bool, _ msg: String) {
        let p = NSPredicate(format: "count \(shown ? ">" : "==") 0")
        let e = expectation(for: p, evaluatedWith: app.keyboards)
        wait(for: [e], timeout: 4)
        XCTAssertEqual(app.keyboards.count > 0, shown, msg)
    }

    private func dismissSystemPrompts() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for surface in [springboard, XCUIApplication()] {
            for label in ["Not Now", "Ahora no"] where surface.buttons[label].waitForExistence(timeout: 1) { surface.buttons[label].tap() }
        }
    }

    func testKeyboardDismissesInLoginAndChat() throws {
        let f = try fixture()
        XCTAssertFalse(f.apiUrl.contains("chaggu.com") || f.apiUrl.contains("tiecoms.com"))
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES",
                               "-AppleLanguages", "(es)", "-AppleLocale", "es_CO"]
        app.launch()

        // Login: «Listo» en la barra del teclado y tocar fuera.
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        email.tap(); email.typeText(f.a.email)
        keyboardShown(app, true, "teclado abierto en el login")
        shot("teclado-01-login-abierto-con-listo")
        XCTAssertTrue(app.buttons["keyboard.done"].waitForExistence(timeout: 3), "botón Listo en la barra del teclado")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.13)).tap()
        keyboardShown(app, false, "tocar fuera cierra el teclado del login")
        shot("teclado-02-login-tocar-fuera")
        let password = app.secureTextFields["login.password"]
        password.tap(); password.typeText(f.password)
        keyboardShown(app, true, "teclado abierto en la contraseña")
        app.buttons["keyboard.done"].tap()
        keyboardShown(app, false, "Listo cierra el teclado")
        app.buttons["login.submit"].tap()
        dismissSystemPrompts()

        // Chat: deslizar la lista hacia abajo y tocar el área de mensajes.
        let row = app.buttons["conv.row.\(f.conversationId)"]
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.tap()
        let field = app.descendants(matching: .any)["composer.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap(); field.typeText("Borrador para el comité")
        keyboardShown(app, true, "teclado abierto en el chat")
        XCTAssertFalse(app.buttons["keyboard.done"].exists, "el compositor no lleva Listo")
        shot("teclado-03-chat-abierto")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.30))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.92)))
        keyboardShown(app, false, "deslizar la lista hacia abajo cierra el teclado")
        shot("teclado-04-chat-deslizar")

        field.tap()
        keyboardShown(app, true, "teclado abierto otra vez")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35)).tap()
        keyboardShown(app, false, "tocar el área de mensajes cierra el teclado")
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "value CONTAINS %@ OR label CONTAINS %@", "Borrador para el comité", "Borrador para el comité")).firstMatch.exists
                      || (field.value as? String)?.contains("Borrador") == true, "el borrador se conserva")
        shot("teclado-05-chat-tocar-fuera")

        // Los toques en mensajes siguen funcionando: pulsación larga abre el menú.
        let msg = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "La reunión queda para el jueves (24)")).firstMatch
        XCTAssertTrue(msg.waitForExistence(timeout: 5) && msg.isHittable)
        msg.press(forDuration: 1.0)
        XCTAssertTrue(app.buttons["Responder"].waitForExistence(timeout: 5), "menú del mensaje")
        shot("teclado-06-chat-menu-mensaje")
        app.buttons["Responder"].tap()
        keyboardShown(app, true, "Responder vuelve a abrir el teclado")
        shot("teclado-07-chat-responder")
    }
}
