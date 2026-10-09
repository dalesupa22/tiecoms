import XCTest

/// Tanda 1.7 contra el API local con la migración 037 (fixture `tools/fixtures/tanda17-fixture.mjs`,
/// `TEST_RUNNER_TC_FIXTURE_17`): tarjetas de tareas y eventos, #grupos, buscar en el chat y una sola vista. Capturas en TC_SHOTS.
final class Tanda17UITests: XCTestCase {
    struct Fixture: Decodable {
        struct Person: Decodable { var email: String; var id: String }
        var apiUrl: String
        var password: String
        var a: Person
        var dmId: String
        var pagosId: String
        var secretoId: String
        var viewOnceId: String
        var lateIssue: String
        var eventId: String
    }
    override func setUp() { continueAfterFailure = false }
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    private func shot(_ name: String) {
        let s = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: s); a.name = name; a.lifetime = .keepAlways; add(a)
        if let dir = env["TC_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    private func login() throws -> (XCUIApplication, Fixture) {
        guard let path = env["TC_FIXTURE_17"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE_17") }
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES", "-TCResetLanguage", "YES",
                               "-AppleLanguages", "(es)", "-AppleLocale", "es_CO"]
        app.launch()
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 15))
        email.tap(); email.typeText(f.a.email)
        let pw = app.secureTextFields["login.password"]; pw.tap(); pw.typeText(f.password)
        app.buttons["login.submit"].tap()
        let notNow = app.buttons.matching(NSPredicate(format: "label IN %@", ["Not Now", "Ahora no"])).firstMatch
        if notNow.waitForExistence(timeout: 5) { notNow.tap() }
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 15))
        // «¿Guardar contraseña?» del sistema: Not Now.
        let spring = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for _ in 0..<10 {
            let b = [app.buttons["Not Now"], spring.buttons["Not Now"], app.buttons["Ahora no"], spring.buttons["Ahora no"]].first { $0.exists }
            if let b { b.tap(); break }
            usleep(300_000)
        }
        return (app, f)
    }

    private func any(_ app: XCUIApplication, _ text: String) -> XCUIElement {
        app.descendants(matching: .any).containing(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    func testCardsRefsSearchAndViewOnce() throws {
        let (app, f) = try login()
        // Grupo: tarjetas de tarea hecha, vencida (con botones), comentarios, evento de hoy y comentarios del evento.
        let group = app.buttons["conv.row.\(f.pagosId)"].firstMatch
        XCTAssertTrue(group.waitForExistence(timeout: 10))
        for _ in 0..<20 where !group.isHittable { usleep(300_000) }
        if !group.isHittable { shot("39-no-hittable") }
        group.tap()
        XCTAssertTrue(app.textViews["composer.field"].waitForExistence(timeout: 10))
        sleep(2)
        // Arrastrar sobre los mensajes (el primer scrollView es la fila de banderitas).
        func drag(up: Bool) {
            let a = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: up ? 0.75 : 0.35))
            a.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: up ? 0.35 : 0.75)))
        }
        XCTAssertTrue(any(app, "ES HOY").waitForExistence(timeout: 8), "«Es hoy»")
        for _ in 0..<4 { drag(up: true) }
        sleep(1); shot("40-grupo-es-hoy")
        drag(up: false)
        sleep(1)
        XCTAssertTrue(app.buttons["card.newDate.\(f.lateIssue)"].waitForExistence(timeout: 5), "tarea vencida con Nueva fecha")
        XCTAssertTrue(app.buttons["card.reassign.\(f.lateIssue)"].exists)
        XCTAssertTrue(any(app, "No cumplimos").exists)
        shot("41-tarea-vencida")
        drag(up: false); sleep(1)
        XCTAssertTrue(any(app, "completó la tarea").exists, "tarea completada")
        shot("42-tarea-hecha")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // DM: #grupos (uno abre, el otro avisa), búsqueda y una sola vista.
        app.buttons["tab.dms"].firstMatch.tap()
        let dm = app.buttons["conv.row.\(f.dmId)"].firstMatch
        XCTAssertTrue(dm.waitForExistence(timeout: 10))
        dm.tap()
        XCTAssertTrue(app.textViews["composer.field"].waitForExistence(timeout: 10))
        let vo = app.buttons["msg.\(f.viewOnceId)"].firstMatch
        XCTAssertTrue(vo.waitForExistence(timeout: 8), "burbuja cerrada de una sola vista")
        XCTAssertFalse(any(app, "chaggu2026").exists, "sin el contenido")
        shot("43-dm-ref-una-vista")
        vo.tap()
        XCTAssertTrue(app.descendants(matching: .any)["vo.text"].waitForExistence(timeout: 8), "visor con el texto")
        shot("44-visor-una-vista")
        app.buttons["vo.close"].tap()
        XCTAssertTrue(any(app, "Abierto").waitForExistence(timeout: 5), "queda «Abierto»")
        // Buscar: «presupuesto» sin mayúsculas ni tildes → 3 resultados.
        app.buttons["chat.search"].firstMatch.tap()
        let field = app.textFields["chat.searchField"]
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        field.typeText("presupuesto")
        let counter = app.staticTexts["chat.searchCounter"]
        XCTAssertTrue(counter.waitForExistence(timeout: 8))
        XCTAssertTrue(NSPredicate(format: "label == %@", "1 de 3").evaluate(with: counter) || counter.label.hasSuffix("de 3"), counter.label)
        app.buttons["chat.searchOlder"].tap()
        XCTAssertTrue(counter.label.hasPrefix("2 de"))
        shot("45-buscar")
        app.buttons["chat.searchClose"].tap()
        // # en el compositor: sugiere conversaciones.
        let composer = app.textViews["composer.field"].firstMatch
        composer.tap(); composer.typeText("Miren #Pag")
        XCTAssertTrue(app.buttons["ref.pick.\(f.pagosId)"].waitForExistence(timeout: 5), "sugerencia #Pagos 1.7")
        shot("46-sugerir-grupo")
        app.buttons["ref.pick.\(f.pagosId)"].tap()
        // ① y enviar: sale como una sola vista.
        app.buttons["composer.viewOnce"].tap()
        XCTAssertTrue(app.buttons["composer.viewOnce"].isSelected)
        app.buttons["composer.send"].tap()
        XCTAssertTrue(any(app, "una vista").waitForExistence(timeout: 10), "mi mensaje de una vista")
        shot("47-enviado-una-vista")
        // La ref del mensaje de Bruno a un grupo sin acceso avisa y no navega.
        let noAccess = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "#Junta privada")).firstMatch
        if noAccess.exists {
            noAccess.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.5)).tap()
            _ = any(app, "No tienes acceso").waitForExistence(timeout: 3)
            shot("48-sin-acceso")
        }
    }
}
