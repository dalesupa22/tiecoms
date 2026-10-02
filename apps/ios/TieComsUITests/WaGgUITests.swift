import XCTest

/// 1.7.7 (docs/CONTRATO-GG-CHAT-WA-INBOX.md): WhatsApp en Grupos/DMs, cabecera compacta, accesos con logo y gg en el chat,
/// contra un API LOCAL con DeepSeek falso. Fixture: grupos-fixture.mjs + `waGroupKey`/`waDmKey` (chats de WhatsApp sembrados
/// con inbox_place). `TEST_RUNNER_TC_FIXTURE_WAGG=/ruta.json`, capturas con `TEST_RUNNER_TC_SHOTS=/dir`.
final class WaGgUITests: XCTestCase {
    struct Fixture: Decodable {
        struct Person: Decodable { var email: String; var id: String }
        var apiUrl: String
        var password: String
        var a: Person
        var generalId: String
        var waGroupKey: String
        var waDmKey: String
    }

    override func setUp() { continueAfterFailure = false }

    private func fixture() throws -> Fixture {
        guard let path = ProcessInfo.processInfo.environment["TC_FIXTURE_WAGG"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE_WAGG") }
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        guard f.apiUrl.contains("localhost") || f.apiUrl.contains("127.0.0.1") else { throw XCTSkip("solo API local") }
        return f
    }

    private func shot(_ name: String) {
        let s = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: s); a.name = name; a.lifetime = .keepAlways; add(a)
        if let dir = ProcessInfo.processInfo.environment["TC_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    private func login(_ f: Fixture) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES",
                               "-TCNoAnimations", "YES", "-AppleLanguages", "(es)", "-AppleLocale", "es_CO", "-TCResetLanguage", "YES"]
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
        if app.buttons["push.later"].waitForExistence(timeout: 2) { app.buttons["push.later"].tap() }
        return app
    }

    private func smallest(_ q: XCUIElementQuery) -> XCUIElement {
        q.allElementsBoundByIndex.min { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height } ?? q.firstMatch
    }

    func testWhatsAppInboxHeaderAndGgInChat() throws {
        let f = try fixture()
        let app = login(f)

        // 1. Grupos: cabecera compacta (Lista/Árbol junto a ≡, una fila de chips con el logo de WhatsApp) y la fila
        //    de WhatsApp mezclada con su contador verde.
        let waRow = app.buttons["wa.row.\(f.waGroupKey)"]
        XCTAssertTrue(waRow.waitForExistence(timeout: 25), "fila de WhatsApp en Grupos")
        XCTAssertTrue(app.buttons["grp.viewMode"].exists, "Lista/Árbol como ícono")
        XCTAssertFalse(app.segmentedControls["grp.viewMode"].exists, "sin el segmentado")
        XCTAssertTrue(app.buttons["access.whatsapp"].waitForExistence(timeout: 10), "acceso con logo de WhatsApp")
        sleep(1)
        shot("01-grupos-lista")

        app.buttons["grp.viewMode"].tap()
        XCTAssertEqual(app.buttons["grp.viewMode"].value as? String, "Árbol")
        sleep(1)
        shot("02-grupos-arbol")
        app.buttons["grp.viewMode"].tap()

        // 2. Deslizar a la derecha: Fijar.
        waRow.swipeRight()
        let pin = app.buttons["swipe.pin.\(f.waGroupKey)"]
        XCTAssertTrue(pin.waitForExistence(timeout: 5), "deslizar = Fijar")
        shot("03-deslizar-fijar")
        pin.tap()
        sleep(2)
        shot("04-wa-fijado")

        // 3. Pulsación larga: Quitar de fijados · Mover a DMs · Sacar de mi lista principal.
        app.buttons["wa.row.\(f.waGroupKey)"].press(forDuration: 1.0)
        XCTAssertTrue(app.buttons["wa.menu.moveDms"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["wa.menu.remove"].exists)
        shot("05-menu-fila-wa")
        app.buttons["wa.menu.pin"].tap() // quita el fijado
        sleep(1)

        // 4. DMs: el chat 1 a 1 fijado.
        app.tabBars.buttons["DMs"].tap()
        XCTAssertTrue(app.buttons["wa.row.\(f.waDmKey)"].waitForExistence(timeout: 10), "WhatsApp en DMs")
        sleep(1)
        shot("06-dms")

        // 5. Pantalla WhatsApp desde el acceso con logo: «Mover a mi lista principal».
        if let access = app.buttons.matching(identifier: "access.whatsapp").allElementsBoundByIndex.first(where: \.isHittable) {
            access.tap()
            // La pantalla abre en «Grupos» de WhatsApp: «Vecinos Edificio» no está en la bandeja.
            let vecinos = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Vecinos Edificio")).firstMatch
            if vecinos.waitForExistence(timeout: 10) {
                vecinos.press(forDuration: 1.0)
                if app.buttons["wa.inbox.move"].waitForExistence(timeout: 4) {
                    shot("07-wa-menu-mover")
                    app.buttons["wa.inbox.move"].tap()
                    XCTAssertTrue(app.buttons["wa.inbox.to.groups"].waitForExistence(timeout: 4))
                    shot("08-wa-submenu")
                    app.buttons["wa.inbox.to.groups"].tap()
                    sleep(1)
                }
            }
            let back = app.navigationBars.buttons.element(boundBy: 0)
            if back.exists { back.tap() }
            sleep(1)
        }

        // 6. Chat con gg: botón en el encabezado, hoja con saludo y pendientes, Responder por mí → borrador.
        if app.tabBars.buttons["Grupos"].exists { app.tabBars.buttons["Grupos"].tap() }
        sleep(1)
        shot("09-grupos-con-vecinos")
        let general = app.buttons["conv.row.\(f.generalId)"]
        XCTAssertTrue(general.waitForExistence(timeout: 10))
        general.tap()
        let ggButton = app.buttons["chat.gg"]
        XCTAssertTrue(ggButton.waitForExistence(timeout: 15), "botón gg en el encabezado")
        sleep(1)
        shot("10-chat-boton-gg")
        // 7. Pulsación larga en un mensaje: el menú de siempre + «✨ Preguntar a gg» y «Seleccionar».
        // Se cierra el teclado y se busca la burbuja de Bruno.
        let q = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'msg.' AND label CONTAINS %@", "Movemos la mentoría"))
        let msg = q.allElementsBoundByIndex.first(where: \.isHittable) ?? q.allElementsBoundByIndex.first
        XCTAssertNotNil(msg, "mensaje de Bruno a la vista")
        if let msg {
            msg.press(forDuration: 1.2)
            XCTAssertTrue(app.buttons["menu.askGg"].waitForExistence(timeout: 5), "✨ Preguntar a gg en el menú")
            shot("15-menu-mensaje")
            app.buttons["menu.select"].tap()
            XCTAssertTrue(app.buttons["gg.select.ask"].waitForExistence(timeout: 5))
            shot("16-seleccion")
            app.buttons["gg.select.ask"].tap()
            let task = app.buttons["gg.suggest.task"]
            XCTAssertTrue(task.waitForExistence(timeout: 15), "sugerencias con casilla")
            task.tap()
            shot("17-sugerencias")
            app.buttons["gg.suggest.do"].tap()
            XCTAssertTrue(app.textViews["issue.titleField"].waitForExistence(timeout: 8) || app.textFields["issue.titleField"].waitForExistence(timeout: 2), "diálogo de tarea ya lleno")
            sleep(1)
            shot("18-tarea-prellenada")
            // Nada se crea sin confirmar: se cancela el diálogo.
            app.buttons.matching(NSPredicate(format: "label IN %@", ["Cancelar", "Cancel"])).firstMatch.tap()
            sleep(1)
        }

        // 8. gg de este chat.
        ggButton.tap()
        let allow = app.buttons.matching(identifier: "gg.consent.allow").firstMatch
        if allow.waitForExistence(timeout: 8) { shot("11-gg-permiso"); allow.tap() }
        XCTAssertTrue(app.descendants(matching: .any)["gg.input"].waitForExistence(timeout: 10), "hoja de gg")
        XCTAssertTrue(app.buttons["gg.chip.reply"].waitForExistence(timeout: 15), "chips de arranque")
        sleep(1)
        shot("12-gg-hoja")
        app.buttons.matching(identifier: "gg.chip.reply").firstMatch.tap()
        XCTAssertTrue(app.buttons["gg.useDraft.warm"].firstMatch.waitForExistence(timeout: 15), "3 borradores")
        sleep(1)
        shot("13-gg-responder-por-mi")
        // El historial sigue de otras veces: se usa el último.
        (app.buttons.matching(identifier: "gg.useDraft.warm").allElementsBoundByIndex.last(where: \.isHittable) ?? app.buttons["gg.useDraft.warm"].firstMatch).tap()
        XCTAssertTrue(app.otherElements["gg.draftBar"].waitForExistence(timeout: 8) || app.staticTexts["Borrador de gg"].exists, "borrador en el compositor")
        sleep(1)
        shot("14-borrador-en-compositor")

    }

    /// 2-oct-2026: gg en TODOS los chats y la cabecera sin cortes feos (nombre con «…», 📞 🎥 🔍 ⋯ y gg visibles).
    /// Fixture: grupos-fixture.mjs + `longGroup` (un grupo de nombre largo). `TEST_RUNNER_TC_FIXTURE_CABECERA=/ruta.json`.
    func testCabeceraConGgEnTodosLosChats() throws {
        struct F: Decodable { struct P: Decodable { var email: String }; var apiUrl: String; var password: String; var a: P; var generalId: String; var longGroup: String; var pagosId: String }
        guard let path = ProcessInfo.processInfo.environment["TC_FIXTURE_CABECERA"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE_CABECERA") }
        let f = try JSONDecoder().decode(F.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        guard f.apiUrl.contains("localhost") || f.apiUrl.contains("127.0.0.1") else { throw XCTSkip("solo API local") }
        let app = login(Fixture(apiUrl: f.apiUrl, password: f.password, a: .init(email: f.a.email, id: ""), generalId: f.generalId, waGroupKey: "", waDmKey: ""))
        for (name, id) in [("largo", f.longGroup), ("general", f.generalId), ("pagos", f.pagosId)] {
            if app.tabBars.buttons["Grupos"].exists { app.tabBars.buttons["Grupos"].tap() }
            let row = app.buttons["conv.row.\(id)"]
            if !row.waitForExistence(timeout: 6), app.tabBars.buttons["DMs"].exists { app.tabBars.buttons["DMs"].tap() }
            XCTAssertTrue(row.waitForExistence(timeout: 12), "fila del chat \(name)")
            row.tap()
            XCTAssertTrue(app.buttons["chat.gg"].waitForExistence(timeout: 10), "botón gg en \(name)")
            sleep(1); shot("cabecera-\(name)")
            XCTAssertTrue(app.buttons["chat.search"].exists, "buscar en \(name)")
            XCTAssertTrue(app.buttons["chat.menu"].exists, "⋯ en \(name)")
            XCTAssertTrue(app.buttons["call.start"].exists, "📞 en \(name)")
            let header = app.descendants(matching: .any)["chat.header"]
            XCTAssertTrue(header.exists, "nombre en \(name)")
            // El nombre no se monta sobre ‹ ni sobre los botones.
            let back = app.navigationBars.buttons.element(boundBy: 0)
            if back.exists { XCTAssertGreaterThanOrEqual(header.frame.minX, back.frame.maxX - 1, "nombre sobre ‹ en \(name)") }
            XCTAssertLessThanOrEqual(header.frame.maxX, app.buttons["chat.gg"].frame.minX + 1, "nombre sobre gg en \(name)")
            if back.exists { back.tap() }
            sleep(1)
        }
    }

    /// 2-oct-2026: gg prepara la reunión y redacta el correo con el chat; nada se agenda ni se envía sin confirmar.
    /// Fixture: tools/fixtures/gg-acciones-fixture.mjs (API local + fake-mail.mjs MOCK). `TEST_RUNNER_TC_FIXTURE_GGACCIONES=/ruta.json`.
    func testGgAgendaYCorreoConConfirmacion() throws {
        struct F: Decodable { struct P: Decodable { var email: String }; var apiUrl: String; var fakeMail: String; var password: String; var a: P; var generalId: String }
        guard let path = ProcessInfo.processInfo.environment["TC_FIXTURE_GGACCIONES"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE_GGACCIONES") }
        let f = try JSONDecoder().decode(F.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        guard f.apiUrl.contains("localhost") || f.apiUrl.contains("127.0.0.1"), f.fakeMail.contains("localhost") else { throw XCTSkip("solo API local") }
        func sent() throws -> [[String: Any]] {
            let data = try Data(contentsOf: URL(string: "\(f.fakeMail)/sent")!)
            return (try JSONSerialization.jsonObject(with: data) as? [[String: Any]]) ?? []
        }
        let before = try sent().count
        let app = login(Fixture(apiUrl: f.apiUrl, password: f.password, a: .init(email: f.a.email, id: ""), generalId: f.generalId, waGroupKey: "", waDmKey: ""))
        if app.tabBars.buttons["Grupos"].exists { app.tabBars.buttons["Grupos"].tap() }
        let row = app.buttons["conv.row.\(f.generalId)"]
        if !row.waitForExistence(timeout: 8), app.tabBars.buttons["DMs"].exists { app.tabBars.buttons["DMs"].tap() }
        XCTAssertTrue(row.waitForExistence(timeout: 12), "fila del chat")
        row.tap()
        XCTAssertTrue(app.buttons["chat.gg"].waitForExistence(timeout: 10), "botón gg")
        app.buttons["chat.gg"].tap()
        func openFromGg(_ chip: String, _ menuItem: String) {
            let c = app.buttons[chip]
            if c.waitForExistence(timeout: 15) && c.isHittable { c.tap(); return }
            app.buttons["gg.menu"].tap()
            XCTAssertTrue(app.buttons[menuItem].waitForExistence(timeout: 5), menuItem)
            app.buttons[menuItem].tap()
        }

        // 1. Agendar: gg llena el formulario; nada se agenda (sin calendario conectado ni siquiera sale «Confirmar y agendar»).
        openFromGg("gg.chip.meeting", "gg.meeting.open")
        XCTAssertTrue(app.staticTexts["gg.meeting.notice"].waitForExistence(timeout: 20), "aviso de borrador de reunión")
        let title = app.descendants(matching: .any)["gg.meeting.title"]
        XCTAssertEqual(title.value as? String, "Revisión de la propuesta")
        XCTAssertTrue(app.descendants(matching: .any)["gg.meeting.invitee"].firstMatch.exists, "Beto como invitado del chat")
        XCTAssertTrue(app.staticTexts["Beto Ríos"].exists)
        XCTAssertEqual(app.descendants(matching: .any)["gg.meeting.emails"].value as? String, "jorge@cliente.com", "solo el correo escrito en el chat")
        XCTAssertTrue(app.descendants(matching: .any)["gg.meeting.missing"].firstMatch.exists, "aviso de quién falta")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Marta Gil")).firstMatch.exists, "no encontré a Marta")
        XCTAssertTrue((app.descendants(matching: .any)["gg.meeting.description"].value as? String ?? "").contains("https://docs.example.com/propuesta"), "enlace en la descripción")
        sleep(2); shot("gg-reunion-borrador")
        XCTAssertFalse(app.buttons["gg.meeting.create"].exists, "nada se agenda solo")
        // Quitar a Beto de los invitados.
        app.buttons["gg.meeting.invitee.remove"].firstMatch.tap()
        sleep(1); XCTAssertFalse(app.buttons["gg.meeting.invitee.remove"].exists, "Beto quitado")
        app.navigationBars.buttons[app.navigationBars.buttons["Cerrar"].exists ? "Cerrar" : "Close"].firstMatch.tap()

        // 2. Correo: borrador editable, aviso, validación, alerta de confirmación y envío una vez.
        openFromGg("gg.chip.mail", "gg.mail.open")
        XCTAssertTrue(app.staticTexts["gg.mail.notice"].waitForExistence(timeout: 20), "aviso de borrador de correo")
        XCTAssertTrue(app.descendants(matching: .any)["gg.mail.from"].firstMatch.exists, "Desde")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "@example.com")).firstMatch.exists, "Desde: el buzón conectado")
        let to = app.descendants(matching: .any)["gg.mail.to"]
        XCTAssertEqual(to.value as? String, "jorge@cliente.com", "solo correos escritos en el chat; hacker@malo.com no")
        XCTAssertTrue(app.descendants(matching: .any)["gg.mail.missing"].firstMatch.exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "No veo el correo de Marta Gil")).firstMatch.exists)
        XCTAssertEqual(app.descendants(matching: .any)["gg.mail.subject"].value as? String, "Propuesta para revisar")
        sleep(1); shot("gg-correo-borrador")
        let cc = app.descendants(matching: .any)["gg.mail.cc"]
        cc.tap(); cc.typeText("luis")
        app.buttons["gg.mail.send"].tap()
        sleep(1)
        // Si el toque solo cerró el teclado, un segundo toque.
        if !app.descendants(matching: .any)["gg.mail.validation"].firstMatch.exists && !app.alerts.firstMatch.exists { app.buttons["gg.mail.send"].tap() }
        shot("gg-correo-validacion")
        XCTAssertTrue(app.descendants(matching: .any)["gg.mail.validation"].firstMatch.waitForExistence(timeout: 3), "correo inválido")
        cc.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap(); sleep(1)
        cc.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 8))
        let ccValue = cc.value as? String ?? ""
        XCTAssertTrue(ccValue.isEmpty || ccValue == "Opcional", "copia vacía: \(ccValue)")
        XCTAssertFalse(app.descendants(matching: .any)["gg.mail.validation"].firstMatch.exists, "al editar se quita el aviso")
        app.buttons["gg.mail.send"].tap()
        if !app.alerts.firstMatch.waitForExistence(timeout: 2) { app.buttons["gg.mail.send"].tap() }
        let alert = app.alerts.firstMatch
        XCTAssertTrue(alert.waitForExistence(timeout: 5), "alerta de confirmación")
        XCTAssertTrue(alert.staticTexts.allElementsBoundByIndex.contains { $0.label.contains("jorge@cliente.com") }, "la alerta dice a quién")
        shot("gg-correo-confirmar")
        alert.buttons[alert.buttons["Cancelar"].exists ? "Cancelar" : "Cancel"].tap()
        sleep(1)
        XCTAssertEqual(try sent().count, before, "cancelar no envía")
        app.buttons["gg.mail.send"].tap()
        XCTAssertTrue(alert.waitForExistence(timeout: 5))
        alert.buttons["gg.mail.confirmSend"].firstMatch.exists ? alert.buttons["gg.mail.confirmSend"].firstMatch.tap() : alert.buttons["Enviar"].firstMatch.tap()
        XCTAssertTrue(app.descendants(matching: .any)["gg.mail.sent"].firstMatch.waitForExistence(timeout: 15), "✓ Enviado")
        shot("gg-correo-enviado")
        let out = try sent()
        XCTAssertEqual(out.count, before + 1, "salió una sola vez")
        let last = String(describing: out.last ?? [:])
        XCTAssertTrue(last.contains("jorge@cliente.com"), last)
        XCTAssertFalse(last.contains("hacker@malo.com"), last)
    }
}
