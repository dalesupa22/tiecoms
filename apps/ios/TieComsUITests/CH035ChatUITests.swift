import XCTest

/// CH035 (fluidez, tanda 2): la pantalla del chat sigue haciendo lo mismo después de partirla en secciones — abre en el
/// divisor de no leídos y los marca leídos, la burbuja «enviando» pasa a enviada sin duplicarse, lo que llega aparece,
/// «escribiendo…» se ve, y el botón ⌄ sale al subir y vuelve al final.
/// Solo contra la API sintética `tools/fixtures/ch035-perf-api.mjs` (`TEST_RUNNER_TC_FIXTURE_CH035`).
final class CH035ChatUITests: XCTestCase {
    struct Fixture: Decodable {
        var apiUrl: String
        var email: String
        var password: String
        var dmId: String
        var otherId: String
    }
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    @discardableResult
    private func call(_ f: Fixture, _ path: String, _ body: [String: Any]? = nil) -> [String: Any] {
        var req = URLRequest(url: URL(string: "\(f.apiUrl)\(path)")!)
        if let body {
            req.httpMethod = "POST"
            req.httpBody = try? JSONSerialization.data(withJSONObject: body); req.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        let sem = DispatchSemaphore(value: 0)
        var out: [String: Any] = [:]
        URLSession.shared.dataTask(with: req) { data, _, _ in
            out = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }) ?? [:]
            sem.signal()
        }.resume()
        sem.wait()
        return out
    }

    private func reads(_ f: Fixture, _ conv: String) -> Int { call(f, "/__stats")["/api/v1/conversations/\(conv)/read"] as? Int ?? 0 }
    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }

    private func launch() throws -> (XCUIApplication, Fixture) {
        guard let path = env["TC_FIXTURE_CH035"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE_CH035") }
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        guard URL(string: f.apiUrl)?.host == "127.0.0.1" else { throw XCTSkip("Solo la API sintética local") }
        continueAfterFailure = false
        // Tres mensajes sin leer en el otro chat antes de entrar.
        for i in 1...3 { call(f, "/__say", ["conv": f.otherId, "body": "Pendiente \(i) de leer"]) }
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES", "-TCResetLanguage", "YES",
                               "-AppleLanguages", "(es)", "-AppleLocale", "es_CO"]
        app.launch()
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 15))
        email.tap(); email.typeText(f.email)
        let pw = app.secureTextFields["login.password"]; pw.tap(); pw.typeText(f.password)
        app.buttons["login.submit"].tap()
        let spring = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for _ in 0..<10 {
            let b = [app.buttons["Not Now"], spring.buttons["Not Now"], app.buttons["Ahora no"], spring.buttons["Ahora no"]].first { $0.exists }
            if let b { b.tap(); break }
            usleep(300_000)
        }
        let dms = app.buttons["tab.dms"].firstMatch
        XCTAssertTrue(dms.waitForExistence(timeout: 20))
        let row = app.buttons["conv.row.\(f.otherId)"].firstMatch
        for _ in 0..<4 where !row.exists { dms.tap(); _ = row.waitForExistence(timeout: 5) }
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        return (app, f)
    }

    func testUnreadDividerSendReceiveTypingAndReopen() throws {
        let (app, f) = try launch()
        let row = app.buttons["conv.row.\(f.otherId)"].firstMatch
        let before = reads(f, f.otherId)
        row.tap()
        let field = app.textViews["composer.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        // Abre en el divisor «3 mensajes nuevos» y, ya colocado, los marca leídos.
        XCTAssertTrue(any(app, "chat.newDivider").waitForExistence(timeout: 8), "divisor de no leídos al abrir")
        XCTAssertFalse(app.buttons["chat.retryUnread"].exists)
        let deadline = Date().addingTimeInterval(6)
        while Date() < deadline && reads(f, f.otherId) <= before { usleep(100_000) }
        XCTAssertGreaterThan(reads(f, f.otherId), before, "lo no leído a la vista se marca leído tras colocar el chat")

        // «Escribiendo…» de este chat.
        call(f, "/__typing", ["conv": f.otherId])
        XCTAssertTrue(any(app, "chat.typing").waitForExistence(timeout: 4), "línea de «escribiendo…»")

        // Enviar: la burbuja pendiente se vuelve la enviada (misma fila), sin quedar duplicada.
        field.tap(); field.typeText("Hola desde la prueba")
        app.buttons["composer.send"].tap()
        // Semilla: 1 mensaje + 3 pendientes de leer = 4; el mío es el quinto.
        XCTAssertTrue(any(app, "msg.\(f.otherId)-m5").waitForExistence(timeout: 8), "mi mensaje confirmado")
        XCTAssertEqual(app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'pending.'")).count, 0, "no queda burbuja pendiente")
        XCTAssertFalse((field.value as? String ?? "").contains("Hola desde la prueba"), "el compositor quedó vacío")

        // Llega uno a este chat: aparece al final.
        call(f, "/__say", ["conv": f.otherId, "body": "Respuesta en vivo"])
        XCTAssertTrue(any(app, "msg.\(f.otherId)-m6").waitForExistence(timeout: 8), "mensaje entrante en vivo")

        // Volver y reabrir: ya sin divisor (todo leído) y con el compositor listo.
        sleep(2)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        XCTAssertTrue(any(app, "msg.\(f.otherId)-m6").waitForExistence(timeout: 8))
        XCTAssertFalse(any(app, "chat.newDivider").exists, "sin no leídos no hay divisor")
    }

    func testJumpToLatestAppearsWhenScrolledUp() throws {
        let (app, f) = try launch()
        let row = app.buttons["conv.row.\(f.dmId)"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        XCTAssertTrue(app.textViews["composer.field"].waitForExistence(timeout: 15))
        sleep(2)
        let jump = app.buttons["chat.jumpLatest"]
        XCTAssertFalse(jump.exists, "al final no hay botón ⌄")
        let up = {
            for _ in 0..<2 {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.55, dy: 0.30)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.55, dy: 0.75)),
                                                                                         withVelocity: XCUIGestureVelocity(900), thenHoldForDuration: 0.05)
            }
        }
        up()
        XCTAssertTrue(jump.waitForExistence(timeout: 5), "a más de una pantalla del final sale ⌄")
        sleep(1)
        jump.tap()
        XCTAssertTrue(jump.waitForNonExistence(timeout: 6), "⌄ lleva al final y se oculta")
        // Arriba otra vez: uno nuevo no arrastra la vista y el botón sigue ahí.
        up()
        XCTAssertTrue(jump.waitForExistence(timeout: 5))
        call(f, "/__say", ["conv": f.dmId, "body": "Llegó mientras leías arriba"])
        sleep(2)
        XCTAssertTrue(jump.exists, "lo que llega no baja la vista de quien lee arriba")
        if let dir = env["TC_SHOTS"], !dir.isEmpty { try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("ch035-arriba-con-nuevo.png")) }
    }
}
