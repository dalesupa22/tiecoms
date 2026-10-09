import XCTest

/// 1.6.4 (18), SPEC-silencio: silenciar un chat (pulsación larga, «…» del encabezado y Detalles) y «No molestar»
/// en Tú (lunita en el ícono y franja arriba de Grupos y DMs), contra un API de PRUEBAS.
///
/// Fixture por `TEST_RUNNER_TC_FIXTURE_SILENCIO` (scratchpad/silencio-fixture.mjs). Con un API sin PUT /me/dnd
/// (servidor viejo, 404) `TEST_RUNNER_TC_DND_FALLBACK=1` comprueba que queda solo en el dispositivo.
/// Capturas en `TEST_RUNNER_TC_SHOTS`.
final class SilenceUITests: XCTestCase {
    struct Fixture: Decodable {
        struct Person: Decodable { var email: String; var id: String }
        var apiUrl: String
        var password: String
        var a: Person
        var pagosId: String
        var obraId: String
        var avisosId: String
        var dmId: String
        var aToken: String?
    }

    override func setUp() { continueAfterFailure = false }

    private var env: [String: String] { ProcessInfo.processInfo.environment }

    private func fixture() throws -> Fixture {
        guard let path = env["TC_FIXTURE_SILENCIO"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE_SILENCIO") }
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        XCTAssertFalse(f.apiUrl.contains("chaggu.com") || f.apiUrl.contains("tiecoms.com"), "no se prueba contra producción")
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

    private func login(_ f: Fixture, lang: String = "es") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES", "-TCResetLanguage", "YES",
                               "-AppleLanguages", "(\(lang))", "-AppleLocale", lang == "es" ? "es_CO" : "en_US"]
        app.launch()
        let email = app.textFields["login.email"]
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline && !email.exists && !app.tabBars.firstMatch.exists { usleep(300_000) }
        if app.tabBars.firstMatch.exists && !email.exists { return app }
        XCTAssertTrue(email.waitForExistence(timeout: 2))
        email.tap(); email.typeText(f.a.email)
        let pw = app.secureTextFields["login.password"]
        pw.tap(); pw.typeText(f.password)
        app.buttons["login.submit"].tap()
        let notNow = app.buttons.matching(NSPredicate(format: "label IN %@", ["Not Now", "Ahora no"])).firstMatch
        if notNow.waitForExistence(timeout: 5) { notNow.tap() }
        return app
    }

    private func tab(_ app: XCUIApplication, _ i: Int) { app.tabBars.buttons.element(boundBy: i).tap() }

    private func row(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.buttons["conv.row.\(id)"].firstMatch }

    private func label(_ e: XCUIElement) -> String { e.label }

    /// Estado de «No molestar» en el servidor (bootstrap `me.dndUntil`).
    private func serverDnd(_ f: Fixture) throws -> String? {
        guard let token = f.aToken else { throw XCTSkip("Fixture sin token") }
        var req = URLRequest(url: URL(string: f.apiUrl + "/api/v1/bootstrap")!)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        let done = expectation(description: "bootstrap")
        var value: String?
        URLSession.shared.dataTask(with: req) { data, _, _ in
            if let data, let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let me = j["me"] as? [String: Any] {
                value = me["dndUntil"] as? String
            }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
        return value
    }

    func testMuteChatFromListHeaderAndDetails() throws {
        let f = try fixture()
        let app = login(f)
        let pagos = row(app, f.pagosId)
        XCTAssertTrue(pagos.waitForExistence(timeout: 20), "grupo Pagos en la Lista")
        let obra = row(app, f.obraId)
        XCTAssertTrue(obra.waitForExistence(timeout: 5))
        XCTAssertTrue(label(obra).contains("Silenciado"), "Obra Norte llega silenciada: \(label(obra))")
        XCTAssertTrue(label(row(app, f.avisosId)).contains("Te mencionaron") || label(row(app, f.avisosId)).contains("mencion"),
                      "Avisos: silenciado pero con mención: \(label(row(app, f.avisosId)))")
        sleep(1)
        shot("01-grupos-silenciados-globo-gris")

        // 1. Pulsación larga en la fila → Silenciar → Por 1 hora.
        pagos.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["mute.menu"].waitForExistence(timeout: 4), "«Silenciar» en la pulsación larga")
        app.buttons["mute.menu"].tap()
        XCTAssertTrue(app.buttons["mute.opt.hour"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["mute.opt.forever"].exists, "«Hasta que lo reactive»")
        shot("02-pulsacion-larga-opciones")
        app.buttons["mute.opt.hour"].tap()
        let mutedPred = NSPredicate(format: "label CONTAINS %@", "Silenciado")
        expectation(for: mutedPred, evaluatedWith: pagos)
        waitForExpectations(timeout: 5)

        // 2. Chat: el «…» del encabezado ofrece «Reactivar notificaciones».
        pagos.tap()
        XCTAssertTrue(app.buttons["chat.menu"].waitForExistence(timeout: 8))
        app.buttons["chat.menu"].tap()
        XCTAssertTrue(app.buttons["mute.menu.unmute"].waitForExistence(timeout: 4), "chat silenciado: «Reactivar notificaciones»")
        shot("03-encabezado-reactivar")
        app.buttons["mute.menu.unmute"].tap()
        sleep(1)
        app.buttons["chat.menu"].tap()
        XCTAssertTrue(app.buttons["mute.menu"].waitForExistence(timeout: 4), "reactivado: vuelve «Silenciar»")
        app.buttons["mute.menu"].tap()
        XCTAssertTrue(app.buttons["mute.opt.8h"].waitForExistence(timeout: 3))
        shot("04-encabezado-silenciar-opciones")
        app.buttons["mute.opt.8h"].tap()
        sleep(1)

        // 3. Detalles: interruptor «Silenciar» encendido con «Silenciado hasta las …».
        app.buttons["chat.header"].tap()
        let toggle = app.switches["details.mute"].firstMatch
        XCTAssertTrue(toggle.waitForExistence(timeout: 6))
        XCTAssertEqual(toggle.value as? String, "1")
        let state = app.staticTexts["details.muteState"]
        XCTAssertTrue(state.waitForExistence(timeout: 3))
        XCTAssertTrue(state.label.hasPrefix("Silenciado hasta"), state.label)
        shot("05-detalles-silenciado-hasta")
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        expectation(for: NSPredicate(format: "value == '0'"), evaluatedWith: toggle)
        waitForExpectations(timeout: 5)
        XCTAssertFalse(state.exists)
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        XCTAssertTrue(app.buttons["details.mute.forever"].waitForExistence(timeout: 4), "al encender se elige cuánto")
        shot("06-detalles-elegir-tiempo")
        app.buttons["details.mute.forever"].firstMatch.tap()
        XCTAssertTrue(state.waitForExistence(timeout: 5))
        XCTAssertEqual(state.label, "Silenciado", "«Hasta que lo reactive» = solo «Silenciado»")
        shot("07-detalles-silenciado")
        // Deja el grupo como estaba.
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        expectation(for: NSPredicate(format: "value == '0'"), evaluatedWith: toggle)
        waitForExpectations(timeout: 5)

        // 4. DMs: pulsación larga también.
        tab(app, 1)
        let dm = row(app, f.dmId)
        XCTAssertTrue(dm.waitForExistence(timeout: 6))
        dm.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["mute.menu"].waitForExistence(timeout: 4), "«Silenciar» en DMs")
        app.buttons["mute.menu"].tap()
        app.buttons["mute.opt.week"].tap()
        expectation(for: mutedPred, evaluatedWith: dm)
        waitForExpectations(timeout: 5)
        sleep(1)
        shot("08-dms-silenciado")
        dm.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["mute.menu.unmute"].waitForExistence(timeout: 4))
        app.buttons["mute.menu.unmute"].tap()
    }

    func testDoNotDisturbFromYouTab() throws {
        let f = try fixture()
        let fallback = env["TC_DND_FALLBACK"] == "1"
        let lang = env["TC_LANG"] ?? "es"
        let es = lang == "es"
        let prefix = fallback ? "fallback-404-" : (es ? "" : "en-")
        let app = login(f, lang: lang)
        XCTAssertTrue(row(app, f.pagosId).waitForExistence(timeout: 20))
        XCTAssertFalse(app.descendants(matching: .any)["dnd.banner"].exists, "apagado: sin franja")

        tab(app, 4)
        let dndRow = app.buttons["settings.dnd"]
        XCTAssertTrue(dndRow.waitForExistence(timeout: 6))
        XCTAssertEqual(app.staticTexts["settings.dnd.state"].label, es ? "Desactivado" : "Off")
        dndRow.tap()
        XCTAssertTrue(app.buttons["dnd.opt.hour"].waitForExistence(timeout: 4))
        XCTAssertTrue(app.buttons["dnd.opt.tomorrow"].exists && app.buttons["dnd.opt.forever"].exists && app.buttons["dnd.opt.8h"].exists)
        shot("\(prefix)10-tu-no-molestar-opciones")
        app.buttons["dnd.opt.hour"].tap()
        let status = app.staticTexts["settings.dnd.state"]
        expectation(for: NSPredicate(format: "label BEGINSWITH %@", es ? "Activo hasta las" : "On until"), evaluatedWith: status)
        waitForExpectations(timeout: 6)
        let footer = app.staticTexts["settings.dnd.footer"]
        if fallback {
            XCTAssertTrue(footer.label.contains(es ? "solo en este dispositivo" : "this device only"), "404: aviso discreto en Tú: \(footer.label)")
        } else {
            XCTAssertFalse(footer.label.contains("solo en este dispositivo"), footer.label)
            if f.aToken != nil { XCTAssertNotNil(try serverDnd(f), "el servidor guardó me.dndUntil") }
        }
        sleep(1)
        shot("\(prefix)11-tu-no-molestar-activo-lunita")

        tab(app, 0)
        let banner = app.descendants(matching: .any)["dnd.banner"].firstMatch
        XCTAssertTrue(banner.waitForExistence(timeout: 5), "franja arriba de Grupos")
        sleep(1)
        shot("\(prefix)12-grupos-franja-no-molestar")
        tab(app, 1)
        XCTAssertTrue(app.descendants(matching: .any)["dnd.banner"].firstMatch.waitForExistence(timeout: 5), "franja arriba de DMs")
        sleep(1)
        shot("\(prefix)13-dms-franja-no-molestar")

        // «Reactivar» desde la franja lo apaga.
        app.buttons["dnd.banner.off"].firstMatch.tap()
        XCTAssertTrue(app.descendants(matching: .any)["dnd.banner"].firstMatch.waitForNonExistence(timeout: 5))
        if !fallback, f.aToken != nil { XCTAssertNil(try serverDnd(f), "apagado también en el servidor") }
        tab(app, 4)
        XCTAssertTrue(dndRow.waitForExistence(timeout: 6))
        expectation(for: NSPredicate(format: "label CONTAINS %@", es ? "Desactivado" : "Off"), evaluatedWith: dndRow)
        waitForExpectations(timeout: 5)
    }
}
