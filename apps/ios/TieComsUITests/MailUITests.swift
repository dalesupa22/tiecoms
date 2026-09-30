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

    /// Toque por coordenada: en la lista de Grupos la ventana de avisos a veces tapa los botones para XCTest.
    func tapC(_ e: XCUIElement) { if e.isHittable { e.tap() } else { e.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() } }

    func openChat(_ app: XCUIApplication, _ f: Fixture) {
        let field = app.descendants(matching: .any)["composer.field"]
        if field.waitForExistence(timeout: 12) { return } // -TCOpenConversation ya lo abrió
        let row = app.buttons["conv.row.\(f.chatId)"]
        XCTAssertTrue(waitFor(row, 25, app), "fila del grupo")
        // Otra ventana (avisos) a veces tapa la fila para XCTest: se toca por coordenada y se reintenta.
        for _ in 0..<3 where !field.exists {
            sleep(1)
            if row.exists { tapC(row) }
            _ = field.waitForExistence(timeout: 6)
        }
        if !field.exists { shot("correo-00-no-abrio") }
        XCTAssertTrue(field.exists, "se abrió el chat")
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
        let app = login(f, as: f.a, extra: ["-TCOpenConversation", f.chatId])
        openChat(app, f)
        // mail.shared: mensaje de quien lo trajo, con su comentario, y la tarjeta (Gmail, ↙, Por responder, adjuntos).
        let card = el(app, "mailCard.\(f.g1)")
        if !waitFor(card, 15, app) { shot("correo-00-sin-tarjeta") }
        XCTAssertTrue(card.exists, "tarjeta del comité")
        XCTAssertTrue(app.staticTexts["¿Cómo le respondemos a Jorge?"].exists, "el comentario de quien lo trajo")
        XCTAssertTrue(app.staticTexts["Solicitud de presentación para el comité del jueves"].exists || app.buttons["mailCard.subject"].exists)
        shot("correo-01a-tarjeta")
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "📎 Requisitos_comite.pdf")).firstMatch.exists, "chips de adjuntos")
        // Comentarios en la tarjeta (los 2 últimos) y el aviso mail.comments como una línea corta, sin repetir la tarjeta.
        XCTAssertTrue(waitFor(el(app, "commentsLine"), 8, app), "línea «💬 2 comentarios nuevos · …»")
        XCTAssertTrue(el(app, "commentsLine").label.contains("2 comentarios nuevos"), el(app, "commentsLine").label)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Precios por volumen en la diapositiva 3")).firstMatch.exists, "último comentario en la tarjeta")
        XCTAssertFalse(app.buttons["mailCard.comments"].exists, "sin el botón 💬")
        // Comentar en la tarjeta, ahí mismo.
        let inline = card.textFields["mailCard.commentField"]
        XCTAssertTrue(inline.waitForExistence(timeout: 5), "«Comenta este correo…»")
        for _ in 0..<3 where !app.keyboards.firstMatch.exists { tapC(inline); _ = app.keyboards.firstMatch.waitForExistence(timeout: 3) }
        app.typeText("Lo reviso hoy\n")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Lo reviso hoy")).firstMatch.waitForExistence(timeout: 10), "el comentario queda en la tarjeta")
        XCTAssertTrue(card.buttons["mailCard.allComments"].waitForExistence(timeout: 8), "«Ver los 3 comentarios»")
        if app.keyboards.firstMatch.exists { app.swipeDown() }
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
    // MARK: 2. ＋ › Correo: la lista con pestañas y filtros, vista previa y «Comentar aquí»

    func test2ShareFromList() throws {
        let f = try fixture()
        let app = login(f, as: f.a, extra: ["-TCOpenConversation", f.chatId])
        openChat(app, f)
        let plus = app.buttons["composer.attach"]
        XCTAssertTrue(plus.waitForExistence(timeout: 10))
        plus.tap()
        let mail = app.buttons["composer.plus.mail"]
        XCTAssertTrue(mail.waitForExistence(timeout: 5), "＋ › Correo")
        XCTAssertTrue(app.buttons["composer.plus.whatsapp"].exists, "＋ › Mensaje de WhatsApp")
        mail.tap()

        // Dos cuentas: selector Gmail/Outlook; Recibidos › Principal por defecto (sin la promoción ni el pago).
        XCTAssertTrue(el(app, "mail.provider").waitForExistence(timeout: 15), "selector Gmail/Outlook")
        XCTAssertTrue(app.buttons["mail.row.g1"].waitForExistence(timeout: 15), "el comité está en Principal")
        XCTAssertFalse(app.buttons["mail.row.g3"].exists, "sin promociones")
        XCTAssertFalse(app.buttons["mail.row.g2"].exists, "el pago va en Notificaciones")
        XCTAssertTrue(el(app, "mail.header").label.contains("Principal"), el(app, "mail.header").label)
        shot("correo-06-lista-principal")

        // Buscar sin elegir pestaña: todas (category=any, se marca «Todo»), también lo de 2025; filtro Con adjuntos.
        let search = app.textFields["mail.search"]
        search.tap(); search.typeText("presentación")
        XCTAssertTrue(app.buttons["mail.row.g5"].waitForExistence(timeout: 10), "la búsqueda llega a lo de 2025")
        XCTAssertTrue(app.buttons["mail.cat.any"].isSelected, "al buscar, la pestaña pasa a Todo")
        app.buttons["mail.f.attachments"].tap()
        let until = Date().addingTimeInterval(8)
        while Date() < until && app.buttons["mail.row.g5"].exists { usleep(300_000) }
        XCTAssertFalse(app.buttons["mail.row.g5"].exists, "con adjuntos: solo el comité")
        XCTAssertTrue(app.buttons["mail.row.g1"].exists)
        XCTAssertTrue(el(app, "mail.header").label.contains("resultados"), el(app, "mail.header").label)
        shot("correo-07-lista-busqueda-filtros")
        app.buttons["mail.clear"].tap()
        app.buttons["mail.cat.updates"].tap()
        XCTAssertTrue(app.buttons["mail.row.g2"].waitForExistence(timeout: 10), "Notificaciones")

        // Enviados: ↗ en las filas.
        el(app, "mail.box").buttons["Enviados"].tap()
        XCTAssertTrue(app.buttons["mail.row.g4"].waitForExistence(timeout: 10))
        el(app, "mail.box").buttons["Recibidos"].tap()

        // Vista previa (GET /mail/messages/…) y «Comentar aquí» en este chat.
        let pago = app.buttons["mail.row.g2"]
        XCTAssertTrue(pago.waitForExistence(timeout: 10))
        pago.tap()
        XCTAssertTrue(el(app, "mail.previewBody").waitForExistence(timeout: 10))
        let pick = app.buttons["mail.pick"]
        XCTAssertTrue(pick.waitForExistence(timeout: 5))
        XCTAssertEqual(pick.label, "Comentar aquí")
        pick.tap()
        let comment = app.textFields["mail.shareComment"].exists ? app.textFields["mail.shareComment"] : app.textViews["mail.shareComment"]
        XCTAssertTrue(comment.waitForExistence(timeout: 5))
        comment.tap(); comment.typeText("Ya llegó el pago de Uniandes")
        XCTAssertTrue(el(app, "mail.whoSees").exists, "aviso de quiénes lo verán")
        shot("correo-08-compartir")
        app.buttons["mail.shareSend"].tap()
        // Vuelve al chat con la tarjeta nueva.
        XCTAssertTrue(app.staticTexts["Ya llegó el pago de Uniandes"].waitForExistence(timeout: 15), "el comentario de quien lo trajo")
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Recibiste un pago")).firstMatch.waitForExistence(timeout: 10))
        shot("correo-09-tarjeta-nueva")
    }

    // MARK: 3. Hoy (Grupos): «Comenta tus correos con el equipo · Conectar» y Tú › Correo

    func test3TodayNudgeAndSettings() throws {
        let f = try fixture()
        let app = login(f, as: f.c)
        let nudge = el(app, "mail.nudge")
        XCTAssertTrue(waitFor(nudge, 20, app), "sin correo conectado: la invitación")
        shot("correo-10-hoy-invitacion")
        // ✕ la cierra y no vuelve.
        let close = app.buttons["mail.nudge.close"]
        shot("correo-10b-antes-de-cerrar")
        for _ in 0..<3 where nudge.exists {
            tapC(close)
            let until = Date().addingTimeInterval(4)
            while Date() < until && nudge.exists { usleep(300_000) }
        }
        if nudge.exists { shot("correo-10c-no-cerro") }
        XCTAssertFalse(nudge.exists, "✕ la cierra")

        // Tú › Correo · Gmail y Outlook: tarjetas para conectar.
        tapC(app.tabBars.buttons.element(boundBy: app.tabBars.buttons.count - 1))
        let row = app.buttons["settings.mail"]
        for _ in 0..<5 where !row.exists { app.swipeUp() }
        XCTAssertTrue(row.exists, "Tú › Correo")
        tapC(row)
        XCTAssertTrue(app.buttons["mail.connect.google"].waitForExistence(timeout: 10), "tarjetas para conectar")
        XCTAssertTrue(app.buttons["mail.connect.microsoft"].exists)
        shot("correo-11-conectar")
        // Conectar Gmail (proveedor FALSO: redirige solo): ASWebAuthenticationSession → chaggu://mail/connected → confirm.
        tapC(app.buttons["mail.connect.google"])
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let cont = springboard.buttons.matching(NSPredicate(format: "label IN %@", ["Continuar", "Continue"])).firstMatch
        if cont.waitForExistence(timeout: 8) { cont.tap() }
        XCTAssertTrue(app.buttons["mail.accounts"].waitForExistence(timeout: 20), "Gmail conectado: aparece la lista")
        XCTAssertTrue(app.buttons["mail.row.g1"].waitForExistence(timeout: 15), "la lista en vivo")
        shot("correo-12-conectado-lista")
    }
}
