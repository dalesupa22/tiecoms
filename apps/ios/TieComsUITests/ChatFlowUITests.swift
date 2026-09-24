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

    /// iOS puede pedir confirmación ("¿Abrir en TieComs?") al abrir un esquema propio.
    private func confirmOpenIfAsked() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for label in ["Abrir", "Open"] {
            let b = springboard.buttons[label]
            if b.waitForExistence(timeout: 2) { b.tap(); return }
        }
    }

    private func element(_ app: XCUIApplication, containing text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    func testLoginSendEchoAndDeepLinks() throws {
        guard ProcessInfo.processInfo.environment["TC_UI_V1"] == "1" else { throw XCTSkip("Recorrido v1: TEST_RUNNER_TC_UI_V1=1") }
        let f = try fixture()
        XCTAssertFalse(f.apiUrl.contains("app.tiecoms.com"), "no se prueba contra producción")
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-AppleLanguages", "(es)", "-AppleLocale", "es_CO"]
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
        // Por el sistema (como un enlace tocado en otra app): XCUIApplication.open relanzaría la app
        // con -TCResetSession y perdería la sesión.
        XCUIDevice.shared.system.open(URL(string: "tiecoms://c/\(f.conversationId)")!)
        confirmOpenIfAsked()
        XCTAssertTrue(app.descendants(matching: .any)["composer.field"].waitForExistence(timeout: 10), "tiecoms://c/<id> abre la conversación")
        shot(app, "04-deeplink-esquema")

        // 5. Enlace universal https (sin verificación de dominio en el simulador)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        XCUIDevice.shared.system.open(URL(string: "https://app.tiecoms.com/c/\(f.conversationId)")!)
        confirmOpenIfAsked()
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

    // MARK: v2

    private func shotNamed(_ name: String) {
        let s = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: s); a.name = name; a.lifetime = .keepAlways; add(a)
        if let dir = ProcessInfo.processInfo.environment["TC_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    /// Fotogramas del splash (≈0,7 s, 1,5 s, 2,3 s) congelados con -TCSplashFreeze.
    func testSplashFrames() throws {
        for t in ["0.7", "1.5", "2.3"] {
            let app = XCUIApplication()
            app.launchArguments = ["-TCSplashFreeze", t, "-TCResetSession", "YES", "-TCApiURL", "http://127.0.0.1:9", "-AppleLanguages", "(es)"]
            app.launch()
            XCTAssertTrue(app.otherElements["splash"].waitForExistence(timeout: 5))
            sleep(1)
            shotNamed("splash-\(t)")
            app.terminate()
        }
    }

    /// Splash → login (≤ 3 s) → conversación → pulsación larga → fijar y editar → el par responde en vivo.
    func testV2SplashPinEditLive() throws {
        let f = try fixture()
        XCTAssertFalse(f.apiUrl.contains("app.tiecoms.com"))
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-AppleLanguages", "(es)", "-AppleLocale", "es_CO"]
        app.launchArguments += ["-TCMetrics", "YES"]
        app.launch()
        // La app mide cuánto estuvo el splash en pantalla (XCUITest espera a que la app quede quieta
        // y la animación lo retrasa, así que no se cronometra desde aquí).
        let metric = app.staticTexts["metrics.splash"]
        XCTAssertTrue(metric.waitForExistence(timeout: 10))
        let raw = [metric.label, metric.value as? String ?? ""].joined(separator: " ")
        let splashMs = Int(raw.filter(\.isNumber)) ?? 99_999
        print("[medida] métrica cruda: \(raw)")
        print("[medida] UI v2: splash en pantalla hasta el login = \(splashMs) ms")
        XCTAssertLessThanOrEqual(splashMs, 3000, "el splash termina y aparece el login en ≤ 3 s")
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 5) && email.isHittable)
        shotNamed("v2-01-login")

        email.tap(); email.typeText(f.a.email)
        let password = app.secureTextFields["login.password"]
        password.tap(); password.typeText(f.password)
        app.buttons["login.submit"].tap()
        allowNotificationsIfAsked()

        let row = app.buttons["conv.row.\(f.conversationId)"]
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        shotNamed("v2-02-inicio")
        row.tap()

        let field = app.descendants(matching: .any)["composer.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        let text = "hola v2 desde iOS \(Int.random(in: 100...999))"
        field.tap(); field.typeText(text)
        app.buttons["composer.send"].tap()
        XCTAssertTrue(element(app, containing: "eco: \(text)").waitForExistence(timeout: 10), "eco del par")

        // Pulsación larga sobre mi mensaje → Fijar mensaje
        let mine = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", "Tú", text)).firstMatch
        XCTAssertTrue(mine.waitForExistence(timeout: 5))
        mine.press(forDuration: 1.0)
        let pin = app.buttons["Fijar mensaje"]
        XCTAssertTrue(pin.waitForExistence(timeout: 5), "menú de acciones del mensaje")
        shotNamed("v2-03-menu")
        pin.tap()
        XCTAssertTrue(element(app, containing: "vi fijados:").waitForExistence(timeout: 10), "el par ve el fijado")
        XCTAssertTrue(app.buttons["chat.pinsBar"].waitForExistence(timeout: 5), "barra de fijados")

        // Pulsación larga → Editar → guardar
        mine.press(forDuration: 1.0)
        let edit = app.buttons["Editar"]
        XCTAssertTrue(edit.waitForExistence(timeout: 5))
        edit.tap()
        XCTAssertTrue(app.descendants(matching: .any)["composer.editBar"].waitForExistence(timeout: 5))
        field.typeText(" (editado)")
        app.buttons["composer.send"].tap()
        XCTAssertTrue(element(app, containing: "vi edición: \(text) (editado)").waitForExistence(timeout: 10), "el par ve la edición en vivo")
        XCTAssertTrue(element(app, containing: "(editado)").exists)
        shotNamed("v2-04-fijado-editado")

        // Pestañas nuevas (atrás cierra el teclado)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.tabBars.buttons["Asuntos"].tap()
        XCTAssertTrue(app.navigationBars["Asuntos"].waitForExistence(timeout: 5))
        shotNamed("v2-05-asuntos")
        app.tabBars.buttons["Agenda"].tap()
        XCTAssertTrue(app.navigationBars["Agenda"].waitForExistence(timeout: 5))
        shotNamed("v2-06-agenda")
        app.tabBars.buttons["Ajustes"].tap()
        shotNamed("v2-07-ajustes")
    }
}
