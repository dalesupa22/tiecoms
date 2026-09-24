import XCTest

/// Recorrido real en el simulador contra el API de PRUEBAS.
///
/// Credenciales: nunca en el código. Llegan por el entorno del test runner desde
/// el fixture (`TEST_RUNNER_TC_FIXTURE=/ruta/fx.json`). Con `TEST_RUNNER_TC_SHOTS=/dir`
/// las capturas también se guardan como PNG en ese directorio.
/// Requiere `scripts/realtime-peer.mjs` corriendo (responde "eco: …").
final class ChatFlowUITests: XCTestCase {
    struct Fixture: Decodable {
        struct Person: Decodable { var email: String; var id: String; var name: String }
        var apiUrl: String
        var password: String
        var conversationId: String
        var a: Person
        var b: Person
    }

    override func setUp() { continueAfterFailure = false }

    private func fixture() throws -> Fixture {
        guard let path = ProcessInfo.processInfo.environment["TC_FIXTURE"], !path.isEmpty else {
            throw XCTSkip("Sin TC_FIXTURE")
        }
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let s = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: s)
        a.name = name
        a.lifetime = .keepAlways
        add(a)
        if let dir = ProcessInfo.processInfo.environment["TC_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    private func allowNotificationsIfAsked() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for label in ["Permitir", "Allow"] {
            let b = springboard.alerts.buttons[label]
            if b.waitForExistence(timeout: 2) { b.tap(); return }
        }
    }

    private func element(_ app: XCUIApplication, containing text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    func testLoginSendEchoAndDeepLinks() throws {
        let f = try fixture()
        XCTAssertFalse(f.apiUrl.contains("app.tiecoms.com"), "no se prueba contra producción")
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-AppleLanguages", "(es)", "-AppleLocale", "es_CO"]
        app.launch()

        // 1. Login como A
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        shot(app, "01-login")
        email.tap()
        email.typeText(f.a.email)
        let password = app.secureTextFields["login.password"]
        password.tap()
        password.typeText(f.password)
        app.buttons["login.submit"].tap()

        // 2. Inicio → conversación
        allowNotificationsIfAsked()
        let row = app.buttons["conv.row.\(f.conversationId)"]
        XCTAssertTrue(row.waitForExistence(timeout: 15), "la conversación compartida aparece en Inicio")
        shot(app, "02-inicio")
        row.tap()

        // 3. Enviar "hola desde iOS" y ver el eco del par en vivo
        let field = app.descendants(matching: .any)["composer.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        let text = "hola desde iOS"
        field.tap()
        field.typeText(text)
        let t0 = Date()
        app.buttons["composer.send"].tap()
        let echo = element(app, containing: "eco: \(text)")
        XCTAssertTrue(echo.waitForExistence(timeout: 15), "llega la respuesta del par en vivo")
        print("[medida] UI: envío → eco visible = \(Int(Date().timeIntervalSince(t0) * 1000)) ms (incluye sondeo de XCUITest)")
        shot(app, "03-conversacion-eco")

        // 4. Volver a Inicio y abrir el deep link del esquema propio
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        app.open(URL(string: "tiecoms://c/\(f.conversationId)")!)
        XCTAssertTrue(app.descendants(matching: .any)["composer.field"].waitForExistence(timeout: 10), "tiecoms://c/<id> abre la conversación")
        shot(app, "04-deeplink-esquema")

        // 5. Enlace universal https (sin verificación de dominio en el simulador)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        XCUIDevice.shared.system.open(URL(string: "https://app.tiecoms.com/c/\(f.conversationId)")!)
        sleep(4)
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        let inApp = app.state == .runningForeground && app.descendants(matching: .any)["composer.field"].exists
        let inSafari = safari.state == .runningForeground
        print("[resultado] https://app.tiecoms.com/c/<id>: abrió en la app=\(inApp) · abrió Safari=\(inSafari)")
        shot(app, "05-enlace-universal")
        let note = XCTAttachment(string: "https link → app=\(inApp) safari=\(inSafari)")
        note.name = "universal-link-result"
        note.lifetime = .keepAlways
        add(note)
        XCTAssertTrue(inApp || inSafari, "el enlace https abre la app (dominio verificado) o Safari (sin verificación)")

        // Deja la app en primer plano para la captura final.
        app.activate()
        shot(app, "06-final")
    }
}
