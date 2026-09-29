import XCTest

/// Correo y WhatsApp en el chat (docs/CORREO.md) contra el API local con MAIL_ENABLED=true y el Gmail/Outlook FALSO.
///
/// Fixture: `tools/fixtures/correo-fixture.mjs` por `TEST_RUNNER_TC_FIXTURE_CORREO`; capturas con `TEST_RUNNER_TC_SHOTS=/dir`.
final class MailUITests: XCTestCase {
    struct Fixture: Decodable {
        struct Person: Decodable { var email: String; var id: String; var name: String }
        var apiUrl: String
        var password: String
        var a: Person
        var b: Person
        var c: Person
        var chatId: String
        var otherId: String
        var g1: String
        var g4: String
        var g6: String
    }

    override func setUp() { continueAfterFailure = false }

    func fixture() throws -> Fixture {
        guard let path = ProcessInfo.processInfo.environment["TC_FIXTURE_CORREO"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE_CORREO") }
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        XCTAssertFalse(f.apiUrl.contains("chaggu.com") || f.apiUrl.contains("tiecoms.com"), "no se prueba contra producción")
        return f
    }

    func shot(_ name: String) {
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

    func dismissSystemPrompts(_ app: XCUIApplication) {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if app.buttons["push.later"].exists { app.buttons["push.later"].tap() }
        for surface in [app, springboard] {
            for label in ["Not Now", "Ahora no"] where surface.buttons[label].exists { surface.buttons[label].tap() }
        }
    }

    func waitFor(_ el: XCUIElement, _ timeout: TimeInterval = 10, _ app: XCUIApplication) -> Bool {
        let until = Date().addingTimeInterval(timeout)
        while Date() < until { if el.exists { return true }; dismissSystemPrompts(app); usleep(300_000) }
        return el.exists
    }

    func login(_ f: Fixture, as p: Fixture.Person, extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES",
                               "-AppleLanguages", "(es)", "-AppleLocale", "es_CO", "-TCResetLanguage", "YES"] + extra
        app.launch()
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 20))
        email.tap(); email.typeText(p.email)
        let pw = app.secureTextFields["login.password"]
        pw.tap(); pw.typeText(f.password)
        app.buttons["login.submit"].tap()
        let notNow = app.buttons.matching(NSPredicate(format: "label IN %@", ["Not Now", "Ahora no"])).firstMatch
        if notNow.waitForExistence(timeout: 5) { notNow.tap() }
        return app
    }

    func el(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }

    func openChat(_ app: XCUIApplication, _ f: Fixture) {
        let row = app.buttons["conv.row.\(f.chatId)"]
        XCTAssertTrue(waitFor(row, 25, app), "fila del grupo")
        let until = Date().addingTimeInterval(6)
        while Date() < until && !row.isHittable { dismissSystemPrompts(app); usleep(300_000) }
        if !row.isHittable { shot("correo-00-fila-tapada") }
        row.tap()
    }

    /// Busca hacia arriba en el chat (la tarjeta más vieja queda arriba).
    func scrollUntil(_ app: XCUIApplication, _ e: XCUIElement, up: Bool = true, tries: Int = 8) -> Bool {
        for _ in 0..<tries {
            if e.exists && e.isHittable { return true }
            if up { app.swipeDown() } else { app.swipeUp() }
        }
        return e.exists
    }

    // MARK: 1. La tarjeta en el chat, abrir el correo y comentar

    func test1CardOpenAndComment() throws {
        let f = try fixture()
        let app = login(f, as: f.a)
        openChat(app, f)
        // mail.shared: mensaje de quien lo trajo, con su comentario, y la tarjeta (Gmail, ↙, Por responder, adjuntos).
        let card = el(app, "mailCard.\(f.g1)")
        XCTAssertTrue(waitFor(card, 15, app), "tarjeta del comité")
        XCTAssertTrue(app.staticTexts["¿Cómo le respondemos a Jorge?"].exists, "el comentario de quien lo trajo")
        XCTAssertTrue(app.staticTexts["Solicitud de presentación para el comité del jueves"].exists || app.buttons["mailCard.subject"].exists)
        shot("correo-01a-tarjeta")
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "📎 Requisitos_comite.pdf")).firstMatch.exists, "chips de adjuntos")
        // mail.comments: la franja con «2 comentarios nuevos».
        XCTAssertTrue(waitFor(el(app, "card.commentsStrip"), 8, app), "franja de comentarios")
        shot("correo-01-tarjeta-chat")

        // Abrir: cuerpo completo (?full=1), metadatos y adjuntos bajo demanda.
        let subject = card.buttons["mailCard.subject"]
        XCTAssertTrue(subject.waitForExistence(timeout: 5))
        subject.tap()
        let body = el(app, "mail.body")
        XCTAssertTrue(body.waitForExistence(timeout: 10))
        let until = Date().addingTimeInterval(8)
        while Date() < until && !(body.label.contains("precios por volumen")) { usleep(300_000) }
        XCTAssertTrue(body.label.contains("precios por volumen"), "el cuerpo llega con ?full=1: \(body.label)")
        XCTAssertTrue(app.staticTexts["Yo armo la presentación"].waitForExistence(timeout: 8), "el hilo")
        shot("correo-02-pantalla-correo")

        // Comentar al equipo.
        let field = app.textFields["mail.commentField"].exists ? app.textFields["mail.commentField"] : app.textViews["mail.commentField"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap(); field.typeText("Yo reviso los precios")
        app.buttons["mail.commentSend"].tap()
        XCTAssertTrue(app.staticTexts["Yo reviso los precios"].waitForExistence(timeout: 8), "el comentario queda en el hilo")

        // Responder: modo del compositor, CC por defecto y programar.
        if app.keyboards.firstMatch.exists { el(app, "mail.body").swipeDown() }
        let replyMode = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Responder a Jorge")).firstMatch
        XCTAssertTrue(replyMode.waitForExistence(timeout: 5), "modo «Responder a Jorge»")
        replyMode.tap()
        let cc = app.textFields["mail.cc"]
        XCTAssertTrue(cc.waitForExistence(timeout: 5))
        XCTAssertTrue((cc.value as? String ?? "").contains("oscar@uniandes.edu.co"), "CC: todos menos yo y el destinatario: \(cc.value ?? "")")
        let reply = app.textFields["mail.replyField"].exists ? app.textFields["mail.replyField"] : app.textViews["mail.replyField"]
        reply.tap(); reply.typeText("Hola Jorge, el jueves te enviamos la presentación.")
        if app.keyboards.firstMatch.exists { app.swipeDown() }
        app.buttons["mail.scheduleMenu"].tap()
        XCTAssertTrue(app.buttons["Mañana a las 9:00"].waitForExistence(timeout: 5), "Programar envío")
        shot("correo-03-responder-programar")
        app.buttons["Mañana a las 9:00"].tap()
        // Vuelve al chat: la tarjeta dice «Respuesta programada · …» y se puede cancelar desde el correo.
        let status = card.staticTexts["mail.status"]
        XCTAssertTrue(waitFor(status, 10, app))
        let t2 = Date().addingTimeInterval(8)
        while Date() < t2 && !status.label.hasPrefix("Respuesta programada") { usleep(300_000) }
        XCTAssertTrue(status.label.hasPrefix("Respuesta programada"), status.label)
        shot("correo-04-tarjeta-programada")
        card.buttons["mailCard.subject"].tap()
        let cancel = app.buttons["mail.cancelSchedule"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 8))
        shot("correo-05-hilo-cancelar-programado")
        cancel.tap()
        XCTAssertTrue(app.staticTexts["Por responder"].waitForExistence(timeout: 8) || el(app, "mail.status").label == "Por responder")
    }
}
