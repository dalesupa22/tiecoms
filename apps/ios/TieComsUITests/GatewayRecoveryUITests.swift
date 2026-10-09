import XCTest

/// Incidencia Alicia → Danny (28-sep-2026): al abrir un DM durante un despliegue se veía «bad gateway» y el chat
/// quedaba vacío. Ahora: «Reconectando…» o «chaggu se está actualizando, reintentando…», reintento solo y el borrador intacto.
///
/// Contra el API sintético local `tools/fixtures/gateway502-api.mjs` (502 HTML las primeras FAIL veces). Nunca producción.
/// Fixture por `TEST_RUNNER_TC_FIXTURE_502`; capturas en `TEST_RUNNER_TC_SHOTS`.
final class GatewayRecoveryUITests: XCTestCase {
    struct Fixture: Decodable { var apiUrl: String; var email: String; var password: String; var dmId: String; var fail: Int }

    override func setUp() { continueAfterFailure = false }

    private var env: [String: String] { ProcessInfo.processInfo.environment }

    private func fixture() throws -> Fixture {
        guard let path = env["TC_FIXTURE_502"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE_502") }
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        let host = URL(string: f.apiUrl)?.host ?? ""
        XCTAssertTrue(host == "127.0.0.1" || host == "localhost", "solo un API local")
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
            try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    private func element(_ app: XCUIApplication, containing text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@", text)).firstMatch
    }

    private func stats(_ f: Fixture) -> [String: Int] {
        guard let data = try? Data(contentsOf: URL(string: f.apiUrl + "/__stats")!) else { return [:] }
        return (try? JSONDecoder().decode([String: Int].self, from: data)) ?? [:]
    }

    func testDMAfter502RetriesKeepsDraftAndNeverShowsBadGateway() throws {
        let f = try fixture()
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES",
                               "-TCResetLanguage", "YES", "-TCOpenConversation", f.dmId, "-AppleLanguages", "(es)", "-AppleLocale", "es_CO"]
        app.launch()
        // Con el Keychain del simulador sin firmar la sesión sintética anterior puede seguir: entonces no hay login.
        let email = app.textFields["login.email"]
        let composer = app.descendants(matching: .any)["composer.field"]
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline && !email.exists && !composer.exists { usleep(200_000) }
        if email.exists {
            email.tap(); email.typeText(f.email)
            let pw = app.secureTextFields["login.password"]
            pw.tap(); pw.typeText(f.password)
            app.buttons["login.submit"].tap()
        }
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

        // 1. Mientras el API responde 502: aviso de reintento, nunca «bad gateway».
        let reconnecting = app.descendants(matching: .any)["chat.reconnecting"]
        let until = Date().addingTimeInterval(20)
        while Date() < until && !reconnecting.exists {
            for s in [app, springboard] { for l in ["Not Now", "Ahora no"] where s.buttons[l].exists && s.buttons[l].isHittable { s.buttons[l].tap() } }
            usleep(200_000)
        }
        XCTAssertTrue(reconnecting.exists, "estado «Reconectando…» tras el 502")
        XCTAssertTrue(element(app, containing: "Reconectando").exists || element(app, containing: "chaggu se está actualizando").exists)
        XCTAssertFalse(element(app, containing: "bad gateway").exists)
        XCTAssertTrue(app.buttons["chat.retry"].exists, "botón Reintentar")
        shot("502-01-reconectando")
        app.buttons["chat.retry"].tap() // reutiliza el intento retenido; no crea una segunda carga

        // 2. El borrador escrito durante los reintentos no se pierde.
        let field = app.descendants(matching: .any)["composer.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap(); field.typeText("Borrador durante el 502")

        // 3. Se recupera sola: aparece el mensaje y sigue el borrador.
        XCTAssertTrue(element(app, containing: "Mensaje sintético después del 502").waitForExistence(timeout: 30), "chat cargado tras reintentar")
        XCTAssertFalse(reconnecting.exists)
        XCTAssertFalse(element(app, containing: "bad gateway").exists)
        let value = (field.value as? String) ?? ""
        XCTAssertTrue(value.contains("Borrador durante el 502"), "borrador conservado: \(value)")
        shot("502-02-recuperado-con-borrador")
        let hits = stats(f)["/api/v1/conversations/\(f.dmId)/messages"] ?? 0
        // Solo los GET: 502 × FAIL y un 200. Ningún POST: el borrador no se envió solo.
        XCTAssertEqual(hits, f.fail + 1, "\(f.fail) × 502 y luego 200")
        XCTAssertEqual(stats(f)["messagePOSTs"] ?? 0, 0, "el borrador no se envía")
    }
}

/// Native UI proof against tools/fixtures/fluidez1716-api.mjs only.
final class Fluidez1716UITests: XCTestCase {
    func testPreservesTabsActionsAndCompoundTaskFilters() throws {
        let env = ProcessInfo.processInfo.environment
        guard let file = env["TC_FIXTURE_FLUIDEZ"] else { throw XCTSkip("Local fixture required") }
        let f = try JSONDecoder().decode(GatewayRecoveryUITests.Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: file)))
        guard URL(string: f.apiUrl)?.host == "127.0.0.1" else { throw XCTSkip("Local fixture only") }
        continueAfterFailure = false
        let initialReadCount = fixtureStats(f.apiUrl)["/api/v1/conversations/" + f.dmId + "/read"] ?? 0
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES", "-TCResetLanguage", "YES", "-AppleLanguages", "(es)", "-AppleLocale", "es_CO"]
        app.launch()
        let email = app.textFields["login.email"]
        if email.waitForExistence(timeout: 12) {
            email.tap(); email.typeText(f.email)
            app.secureTextFields["login.password"].tap(); app.secureTextFields["login.password"].typeText(f.password)
            app.buttons["login.submit"].tap()
        }
        XCTAssertTrue(app.buttons["tab.home"].waitForExistence(timeout: 20))
        for id in ["home", "dms", "issues", "agenda", "calls", "settings"] { XCTAssertTrue(app.buttons["tab." + id].exists, id) }
        app.buttons["tab.dms"].tap()
        let chat = app.buttons["conv.row." + f.dmId]
        XCTAssertTrue(chat.waitForExistence(timeout: 8)); chat.tap()
        XCTAssertTrue(app.buttons["composer.attach"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["chat.gg"].waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["chat.retryUnread"].exists)
        let readDeadline = Date().addingTimeInterval(4)
        while Date() < readDeadline && (fixtureStats(f.apiUrl)["/api/v1/conversations/" + f.dmId + "/read"] ?? 0) <= initialReadCount { usleep(100_000) }
        XCTAssertGreaterThan(fixtureStats(f.apiUrl)["/api/v1/conversations/" + f.dmId + "/read"] ?? 0, initialReadCount, "Visible initial unread messages are acknowledged after positioning")
        save("ios-chat-gg", env)
        app.buttons["composer.attach"].tap()
        for id in ["photos", "files", "whatsapp", "gifs", "event", "issue", "mail", "meetNow", "meetSchedule", "format"] {
            XCTAssertTrue(app.buttons["composer.plus." + id].waitForExistence(timeout: 3), id)
        }
        save("ios-plus-grid", env)
        app.buttons["composer.plus.event"].tap()
        XCTAssertTrue(app.textFields["event.titleField"].waitForExistence(timeout: 5))
        app.buttons["Cancelar"].tap()
        XCTAssertTrue(app.buttons["composer.attach"].waitForExistence(timeout: 5))
        let draft = app.textViews["composer.field"]
        draft.tap(); draft.typeText("Borrador para WhatsApp")
        let beforeFormat = draft.value as? String ?? ""
        app.buttons["composer.attach"].tap()
        XCTAssertTrue(app.scrollViews["composer.actions"].waitForExistence(timeout: 5))
        let format = app.buttons["composer.plus.format"]
        if !format.isHittable { app.scrollViews["composer.actions"].swipeUp() }
        format.tap()
        app.buttons["composer.format.**"].tap()
        XCTAssertTrue(draft.waitForExistence(timeout: 5))
        let draftedText = draft.value as? String
        XCTAssertNotEqual(draftedText, beforeFormat, "Format applies to the composer after the actions sheet closes")
        app.buttons["composer.attach"].tap()
        XCTAssertTrue(app.buttons["composer.plus.whatsappShare"].waitForExistence(timeout: 3))
        save("ios-whatsapp-draft-action", env)
        app.buttons["Cerrar"].tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(chat.waitForExistence(timeout: 5)); chat.tap()
        XCTAssertTrue(draft.waitForExistence(timeout: 5))
        XCTAssertEqual(draft.value as? String, draftedText)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["tab.issues"].waitForExistence(timeout: 5))
        app.buttons["tab.issues"].tap()
        XCTAssertTrue(app.buttons["issues.filter.assignee"].waitForExistence(timeout: 5))
        app.buttons["issues.filter.assignee"].tap()
        app.buttons["Todos"].tap()
        app.buttons["issues.filter.assignee"].tap()
        app.buttons["Lorena"].tap()
        app.buttons["issues.filter.status"].tap()
        app.buttons["Completadas"].tap()
        XCTAssertTrue(app.staticTexts["Lorena completada"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Lorena cancelada"].exists)
        XCTAssertFalse(app.staticTexts["Lorena pendiente"].exists)
        XCTAssertFalse(app.staticTexts["Mi tarea pendiente"].exists)
        save("ios-lorena-completed", env)
        app.terminate()
    }
    private func fixtureStats(_ base: String) -> [String:Int] {
        guard let bytes = try? Data(contentsOf: URL(string: base + "/__stats")!) else { return [:] }
        return (try? JSONDecoder().decode([String:Int].self, from: bytes)) ?? [:]
    }
    private func save(_ name: String, _ env: [String:String]) {
        let shot = XCUIScreen.main.screenshot(), attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
        if let dir = env["TC_SHOTS"] { try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true); try? shot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name + ".png")) }
    }
}
