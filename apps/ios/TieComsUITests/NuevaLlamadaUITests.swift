import XCTest

/// «Nueva llamada» (1.7.6): botón grande en Llamadas → hoja corta → llamada → «Comparte el enlace» (Copiar, Compartir),
/// 🔗 dentro de la llamada, invitada con nombre y correo en Personas, y el aviso amable si el servidor responde 404.
///
/// Contra el API sintético local `tools/fixtures/instant-call-api.mjs` (contrato de POST /calls/instant, proveedor falso).
/// Fixture por `TEST_RUNNER_TC_FIXTURE_INSTANT`; capturas en `TEST_RUNNER_TC_SHOTS` (prefijo `TEST_RUNNER_TC_SHOT_TAG`).
final class NuevaLlamadaUITests: XCTestCase {
    struct Fixture: Decodable { var apiUrl: String; var email: String; var password: String }

    override func setUp() { continueAfterFailure = false }
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    private func fixture() throws -> Fixture {
        guard let path = env["TC_FIXTURE_INSTANT"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE_INSTANT") }
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        let host = URL(string: f.apiUrl)?.host ?? ""
        XCTAssertTrue(host == "127.0.0.1" || host == "localhost", "solo un API local")
        return f
    }

    private func shot(_ name: String) {
        let s = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: s); a.name = name; a.lifetime = .keepAlways; add(a)
        if let dir = env["TC_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            let tag = env["TC_SHOT_TAG"].map { $0 + "-" } ?? ""
            try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(tag)\(name).png"))
        }
    }

    private func setOld(_ f: Fixture, _ on: Bool) {
        var req = URLRequest(url: URL(string: f.apiUrl + "/__old")!)
        req.httpMethod = "POST"; req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = Data(#"{"on":\#(on)}"#.utf8)
        let done = expectation(description: "old")
        URLSession.shared.dataTask(with: req) { _, _, _ in done.fulfill() }.resume()
        wait(for: [done], timeout: 5)
    }

    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }

    private func launch(_ f: Fixture) -> XCUIApplication {
        let app = XCUIApplication()
        let lang = env["TC_LANG"] ?? "es"
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES",
                               "-TCResetLanguage", "YES", "-AppleLanguages", "(\(lang))", "-AppleLocale", lang == "es" ? "es_CO" : "en_US"]
        app.launch()
        let email = app.textFields["login.email"]
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline && !email.exists && !app.tabBars.firstMatch.exists { usleep(200_000) }
        if email.exists {
            email.tap(); email.typeText(f.email)
            let pw = app.secureTextFields["login.password"]
            pw.tap(); pw.typeText(f.password)
            app.buttons["login.submit"].tap()
        }
        let notNow = app.buttons.matching(NSPredicate(format: "label IN %@", ["Not Now", "Ahora no", "Don’t Allow", "No permitir"])).firstMatch
        if notNow.waitForExistence(timeout: 4) { notNow.tap() }
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 20), "entró")
        // El micrófono lo pide el sistema al entrar a la llamada (medios nulos: no se pide), por si acaso se acepta.
        addUIInterruptionMonitor(withDescription: "permisos") { alert in
            for l in ["Allow", "Permitir", "OK"] where alert.buttons[l].exists { alert.buttons[l].tap(); return true }
            return false
        }
        return app
    }

    func testNewCallSharesLinkShowsGuestEmailAndOldServerError() throws {
        let f = try fixture()
        setOld(f, false)
        let app = launch(f)
        let es = (env["TC_LANG"] ?? "es") == "es"

        app.buttons["tab.calls"].firstMatch.tap()
        let new = any(app, "calls.instant")
        XCTAssertTrue(new.waitForExistence(timeout: 10), "botón «Nueva llamada» arriba en Llamadas")
        XCTAssertTrue(app.staticTexts[es ? "Nueva llamada" : "New call"].exists)
        shot("01-llamadas")

        // Un toque → hoja corta con Voz por defecto → «Empezar».
        new.tap()
        let start = app.buttons["calls.instant.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 5))
        XCTAssertTrue(app.textFields["calls.instant.title"].exists)
        XCTAssertTrue(app.buttons[es ? "Voz" : "Voice"].isSelected, "voz por defecto")
        shot("02-hoja-nueva-llamada")
        start.tap()

        // Entra a la llamada y sale sola «Comparte el enlace».
        XCTAssertTrue(app.buttons["call.hangUp"].waitForExistence(timeout: 10), "pantalla de la llamada")
        XCTAssertTrue(app.staticTexts[es ? "Llamada de Danny" : "Danny's call"].waitForExistence(timeout: 5), "título automático en la cabecera")
        let url = any(app, "call.link.url")
        XCTAssertTrue(url.waitForExistence(timeout: 8), "hoja «Comparte el enlace»")
        XCTAssertTrue(url.label.contains("https://app.chaggu.com/llamada/tok_"), url.label)
        let text = any(app, "call.link.text")
        XCTAssertTrue(text.label.contains(es ? "Solo necesitas tu nombre y correo" : "You only need your name and email"), text.label)
        XCTAssertTrue(text.label.contains(url.label))
        shot("03-comparte-el-enlace")
        app.buttons["call.link.copy"].tap()
        XCTAssertTrue(app.buttons["call.link.copy"].label.contains(es ? "Copiado" : "Copied"))

        // Compartir abre la hoja del sistema (WhatsApp, Mensajes, Correo…).
        any(app, "call.link.share").tap()
        let activity = app.otherElements["ActivityListView"].firstMatch
        let close = app.buttons.matching(NSPredicate(format: "identifier == 'Close' OR label IN %@", ["Close", "Cerrar"])).firstMatch
        XCTAssertTrue(activity.waitForExistence(timeout: 8) || close.waitForExistence(timeout: 2), "hoja Compartir del sistema")
        sleep(1); shot("04-hoja-compartir-sistema")
        if close.exists { close.tap() } else { app.swipeDown(velocity: .fast) }
        XCTAssertTrue(app.buttons["call.link.done"].waitForExistence(timeout: 5))
        app.buttons["call.link.done"].tap()
        XCTAssertTrue(url.waitForNonExistence(timeout: 5))

        // 🔗 dentro de la llamada la vuelve a abrir.
        let again = app.buttons["call.link"]
        XCTAssertTrue(again.waitForExistence(timeout: 5), "🔗 en la llamada")
        shot("05-llamada-con-enlace")
        again.tap()
        XCTAssertTrue(any(app, "call.link.url").waitForExistence(timeout: 5))
        app.buttons["call.link.done"].tap()
        XCTAssertTrue(any(app, "call.link.url").waitForNonExistence(timeout: 5))

        // La invitada aparece con nombre y correo.
        XCTAssertTrue(any(app, "call.person.guest:g1").waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["laura@correo.test"].exists, "correo bajo el nombre en la llamada")
        app.buttons["call.peopleButton"].tap()
        let row = any(app, "call.people.guest:g1")
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        XCTAssertTrue(row.label.contains("Laura Invitada") && row.label.contains("laura@correo.test"), row.label)
        shot("06-personas")
        app.buttons["call.people.done"].tap()
        XCTAssertTrue(row.waitForNonExistence(timeout: 5))

        // Colgar: el enlace muere con la llamada.
        app.buttons["call.hangUp"].tap()
        XCTAssertTrue(app.buttons["call.hangUp"].waitForNonExistence(timeout: 8))
        XCTAssertTrue(new.waitForExistence(timeout: 5))

        // Servidor viejo (404): aviso amable, sin llamada.
        setOld(f, true)
        new.tap()
        XCTAssertTrue(app.buttons["calls.instant.start"].waitForExistence(timeout: 5))
        app.buttons["calls.instant.start"].tap()
        let err = any(app, "calls.instant.error")
        XCTAssertTrue(err.waitForExistence(timeout: 8))
        XCTAssertTrue(err.label.contains(es ? "Actualiza pronto: tu servidor aún no tiene llamadas rápidas" : "Update soon: your server doesn't have quick calls yet"), err.label)
        XCTAssertFalse(app.buttons["call.hangUp"].exists)
        shot("07-servidor-viejo")
        app.buttons["calls.instant.cancel"].tap()
        setOld(f, false)
    }
}
