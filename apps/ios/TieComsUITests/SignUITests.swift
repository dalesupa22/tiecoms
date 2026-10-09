import XCTest

/// Firmar PDFs en el iPhone contra el API de PRUEBAS (rama firmar-pdf): abrir «✍️ Firmar» desde la burbuja, elegir la
/// firma guardada, arrastrarla con el dedo hasta otra página (desplazamiento automático al borde), duplicarla,
/// firmar y ver «✓ Firmado por …» en el chat; luego «Documentos que firmé» en Tú.
/// Entorno: TEST_RUNNER_TC_FIXTURE_SIGN=<json {apiUrl, email, password, conversationId}>; capturas con TEST_RUNNER_TC_SHOTS.
final class SignUITests: XCTestCase {
    struct Fixture: Decodable { var apiUrl: String; var email: String; var password: String; var conversationId: String }

    override func setUp() { continueAfterFailure = false }

    private func fixture() throws -> Fixture {
        guard let path = ProcessInfo.processInfo.environment["TC_FIXTURE_SIGN"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE_SIGN") }
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
        if let dir = ProcessInfo.processInfo.environment["TC_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    private func login(_ f: Fixture) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES",
                               "-AppleLanguages", "(es)", "-AppleLocale", "es_CO", "-TCResetLanguage", "YES",
                               "-TCOpenConversation", f.conversationId]
        app.launch()
        let email = app.textFields["login.email"]
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline && !email.exists && !app.tabBars.firstMatch.exists { usleep(300_000) }
        if email.exists {
            email.tap(); email.typeText(f.email)
            let pw = app.secureTextFields["login.password"]
            pw.tap(); pw.typeText(f.password)
            app.buttons["login.submit"].tap()
        }
        dismissPrompts(app, wait: 8)
        return app
    }

    /// «¿Guardar contraseña?» del sistema aparece unos segundos después de entrar.
    private func dismissPrompts(_ app: XCUIApplication, wait: TimeInterval) {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let until = Date().addingTimeInterval(wait)
        repeat {
            for surface in [app, springboard] {
                let b = surface.buttons.matching(NSPredicate(format: "label IN %@", ["Not Now", "Ahora no"])).firstMatch
                if b.exists { b.tap(); return }
            }
            usleep(400_000)
        } while Date() < until
    }

    func testDragSignatureToAnotherPageDuplicateAndSign() throws {
        let f = try fixture()
        let app = login(f)

        // El botón «✍️ Firmar» de un PDF sin firmar (el más reciente que se vea).
        let signButtons = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'att.sign.'"))
        XCTAssertTrue(signButtons.firstMatch.waitForExistence(timeout: 20), "botón Firmar en la burbuja del PDF")
        let before = app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH 'att.signed.'")).count
        dismissPrompts(app, wait: 2)
        shot("sign-01-chat")
        let target = signButtons.allElementsBoundByIndex.last { $0.isHittable } ?? signButtons.firstMatch
        target.tap()

        let stage = app.scrollViews["sign.stage"]
        XCTAssertTrue(stage.waitForExistence(timeout: 20), "visor del PDF")
        XCTAssertTrue(app.buttons["sign.tool.signature"].waitForExistence(timeout: 10), "modo firma")
        XCTAssertFalse(app.buttons["sign.finish"].isEnabled, "sin firmas no se puede firmar")
        let pageLabel = app.staticTexts["sign.pageLabel"]
        XCTAssertTrue(pageLabel.label.hasPrefix("Página 1 de"))
        shot("sign-02-editor")

        // Firma guardada (si no hay, la crea escribiendo el nombre).
        app.buttons["sign.tool.signature"].tap()
        let saved = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'sign.saved.'")).firstMatch
        if saved.waitForExistence(timeout: 4) {
            shot("sign-03-pick")
            saved.tap()
        } else {
            let tabs = app.segmentedControls["sign.create.tabs"]
            XCTAssertTrue(tabs.waitForExistence(timeout: 5))
            tabs.buttons.element(boundBy: 1).tap()
            app.buttons["sign.create.save"].tap()
        }
        let mark = app.descendants(matching: .any)["sign.mark"].firstMatch
        XCTAssertTrue(mark.waitForExistence(timeout: 10), "la firma aparece en la hoja")
        XCTAssertTrue(app.buttons["sign.tool.duplicate"].waitForExistence(timeout: 3), "barra de la marca elegida")
        shot("sign-04-placed")

        // Arrastrar con el dedo hasta el borde de abajo y sostener: la hoja baja sola y la firma pasa a otra página.
        let start = mark.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let bottom = stage.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.97))
        start.press(forDuration: 0.3, thenDragTo: bottom, withVelocity: .default, thenHoldForDuration: 3.5)
        let movedPage = NSPredicate(format: "NOT (label BEGINSWITH 'Página 1 de')")
        expectation(for: movedPage, evaluatedWith: pageLabel)
        waitForExpectations(timeout: 5)
        XCTAssertTrue(mark.exists, "la firma sigue en el documento")
        shot("sign-05-dragged-other-page")

        // Duplicar (pólizas con varias firmas) y agrandar con el asa.
        app.buttons["sign.tool.duplicate"].tap()
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "sign.mark").count, 2)
        let handle = app.descendants(matching: .any)["sign.mark.handle"].firstMatch
        if handle.exists {
            let h = handle.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            h.press(forDuration: 0.1, thenDragTo: h.withOffset(CGVector(dx: 40, dy: 0)))
        }
        shot("sign-06-duplicated")
        app.buttons["sign.tool.done"].tap()

        // Confirmar y enviar.
        let finish = app.buttons["sign.finish"]
        XCTAssertTrue(finish.isEnabled)
        XCTAssertTrue(finish.label.contains("(2)"), finish.label)
        finish.tap()
        let go = app.buttons["sign.confirm.go"]
        XCTAssertTrue(go.waitForExistence(timeout: 5))
        shot("sign-07-confirm")
        if app.switches["sign.confirm.accept"].exists { app.switches["sign.confirm.accept"].tap() }
        expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: go)
        waitForExpectations(timeout: 3)
        go.tap()

        // Vuelve al chat con el firmado.
        XCTAssertTrue(stage.waitForNonExistence(timeout: 30), "el visor se cierra al firmar")
        let signed = app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH 'att.signed.'"))
        expectation(for: NSPredicate(format: "count > %d", before), evaluatedWith: signed)
        waitForExpectations(timeout: 20)
        shot("sign-08-chat-signed")

        // Historial en Tú.
        app.tabBars.buttons.element(boundBy: app.tabBars.buttons.count - 1).tap()
        let entry = app.buttons["settings.signed"]
        XCTAssertTrue(entry.waitForExistence(timeout: 8))
        entry.tap()
        let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'signed.row.'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), "Documentos que firmé")
        shot("sign-09-history")
        row.tap()
        let view = app.buttons["signed.viewPdf"]
        for _ in 0..<4 where !view.exists { app.swipeUp() }
        XCTAssertTrue(view.waitForExistence(timeout: 5), "Ver PDF firmado")
        shot("sign-10-detail")
    }
}
