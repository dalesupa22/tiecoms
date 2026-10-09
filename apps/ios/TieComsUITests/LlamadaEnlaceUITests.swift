import XCTest

/// Enlaces de llamada para invitados (/llamada/<token>) contra el API real: un token que no existe responde 404 y la app
/// muestra «Este enlace ya no sirve» sin cerrarse. Arranque en frío (el sistema abre el enlace) y en caliente.
final class LlamadaEnlaceUITests: XCTestCase {
    private let token = "tokenInvalidoDePrueba123"

    override func setUp() { continueAfterFailure = false }

    private func makeApp() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES", "-AppleLanguages", "(es)", "-AppleLocale", "es_CO"]
        return app
    }

    /// El sistema pregunta «¿Abrir en chaggu?» para el esquema propio.
    private func acceptOpenPrompt() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let open = springboard.buttons["Open"].firstMatch.exists ? springboard.buttons["Open"] : springboard.buttons["Abrir"]
        if open.waitForExistence(timeout: 4) { open.tap() }
    }

    private func expectInvalid(_ app: XCUIApplication, _ name: String) {
        XCTAssertTrue(app.descendants(matching: .any)["guest.invalid"].waitForExistence(timeout: 20), "estado de enlace inválido")
        XCTAssertEqual(app.state, .runningForeground, "sin cerrarse")
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    func test1SchemeColdStart() {
        let app = makeApp()
        app.launch()
        app.terminate()
        XCUIDevice.shared.system.open(URL(string: "chaggu://llamada/\(token)")!)
        acceptOpenPrompt()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))
        expectInvalid(app, "esquema-frio")
    }

    func test2SchemeWarmAndUniversal() {
        let app = makeApp()
        app.launch()
        app.open(URL(string: "chaggu://llamada/\(token)")!)
        expectInvalid(app, "esquema-caliente")
        app.descendants(matching: .any)["guest.close"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["guest.invalid"].waitForNonExistence(timeout: 5), "se cierra")
        // Enlace universal entregado a la app (el AASA del servidor aún no tiene /llamada/*).
        app.open(URL(string: "https://app.chaggu.com/llamada/\(token)")!)
        expectInvalid(app, "universal-caliente")
    }
}
