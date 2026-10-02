import XCTest

/// Grupos (docs/GRUPOS.md) contra el API de PRUEBAS: 5 pestañas, árbol de Grupos, DMs, Nuevo grupo con
/// pantalla de compartir, «Tú», unirme con código y supervisión.
///
/// Fixture (JSON) por `TEST_RUNNER_TC_FIXTURE_GRUPOS`; con `TEST_RUNNER_TC_SHOTS=/dir` guarda capturas PNG.
final class GroupsUITests: XCTestCase {
    struct Fixture: Decodable {
        struct Person: Decodable { var email: String; var id: String }
        var apiUrl: String
        var password: String
        var a: Person
        var b: Person?
        var c: Person?
        var orgA: String
        var pagosId: String
        var ventasId: String
        var joinCode: String
        /// Grupo general de la relación con un hilo colgando de un mensaje (fixtures nuevos).
        var generalId: String?
        var threadId: String?
        /// Asunto vencido de «Pagos» (fixtures nuevos).
        var overdueIssue: String?
        /// 1.6.4: chat largo con 40 no leídos y una mención; grupo fijado.
        var longId: String?
        var pinnedId: String?
        /// 1.6.4 (21): seed-tareas-programados.mjs (API con migraciones 025–027).
        var dmBrunoId: String?
        var parentIssueId: String?
        var taskIds: [String]?
        var sideId: String?
    }

    override func setUp() { continueAfterFailure = false }

    private func fixture() throws -> Fixture {
        guard let path = ProcessInfo.processInfo.environment["TC_FIXTURE_GRUPOS"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE_GRUPOS") }
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
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

    private func dismissSystemPrompts(_ app: XCUIApplication) {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if app.buttons["push.later"].exists { app.buttons["push.later"].tap() }
        for surface in [app, springboard] {
            for label in ["Not Now", "Ahora no"] where surface.buttons[label].exists { surface.buttons[label].tap() }
        }
    }

    /// El chip de asuntos de un grupo. La fila combina su accesibilidad y XCUITest puede ver el identificador dos veces:
    /// se toma el elemento más pequeño (el chip, no la fila).
    private func issuesChip(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        let q = app.buttons.matching(identifier: "grp.issuesToggle.\(id)")
        let all = q.allElementsBoundByIndex
        return all.min { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height } ?? q.firstMatch
    }

    /// Cierra la búsqueda activa (en iOS 26 es una «X» junto al campo).
    private func closeSearch(_ app: XCUIApplication) {
        for label in ["Cancelar", "Cerrar", "Close", "Cancel"] where app.buttons[label].exists { app.buttons[label].firstMatch.tap(); return }
    }

    /// Vista de Grupos: «Lista» o «Árbol» (1.7.7: un ícono junto a ≡ que alterna; su valor dice la vista actual).
    private func setView(_ app: XCUIApplication, _ label: String) {
        let toggle = app.buttons["grp.viewMode"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5), "alternar Lista / Árbol")
        if (toggle.value as? String) != label { toggle.tap() }
        XCTAssertEqual(toggle.value as? String, label)
    }

    /// Plegar/desplegar: botón de vista arriba a la izquierda (ya no hay «…»).
    private func foldMenu(_ app: XCUIApplication) {
        XCTAssertTrue(app.buttons["home.fold"].waitForExistence(timeout: 5))
        app.buttons["home.fold"].tap()
    }

    private func login(_ f: Fixture, resetLanguage: Bool = true) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES",
                               "-AppleLanguages", "(es)", "-AppleLocale", "es_CO"] + (resetLanguage ? ["-TCResetLanguage", "YES"] : [])
        app.launch()
        let email = app.textFields["login.email"]
        // En un build sin firmar el Keychain del simulador puede conservar la sesión de la prueba anterior (misma persona).
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline && !email.exists && !app.tabBars.firstMatch.exists { usleep(300_000) }
        if app.tabBars.firstMatch.exists && !email.exists { return app }
        XCTAssertTrue(email.waitForExistence(timeout: 2))
        email.tap(); email.typeText(f.a.email)
        let pw = app.secureTextFields["login.password"]
        pw.tap(); pw.typeText(f.password)
        app.buttons["login.submit"].tap()
        // «¿Guardar contraseña?» del sistema llega un momento después del login y tapa la lista.
        let notNow = app.buttons.matching(NSPredicate(format: "label IN %@", ["Not Now", "Ahora no"])).firstMatch
        if notNow.waitForExistence(timeout: 5) { notNow.tap() }
        return app
    }

    func testGroupsTabsNewGroupShareAndYou() throws {
        let f = try fixture()
        XCTAssertFalse((f.apiUrl.contains("app.chaggu.com") || f.apiUrl.contains("app.tiecoms.com")), "no se prueba contra producción")
        let app = login(f)

        // 1. Grupos: Tu organización · Relaciones · Invitado en, con los asuntos bajo cada grupo.
        let pagos = app.buttons["conv.row.\(f.pagosId)"]
        let until = Date().addingTimeInterval(20)
        while Date() < until && !pagos.exists { dismissSystemPrompts(app); usleep(300_000) }
        dismissSystemPrompts(app)
        if app.buttons["home.tab.all"].exists { app.buttons["home.tab.all"].tap() }
        XCTAssertTrue(pagos.waitForExistence(timeout: 10), "grupo interno en Tu organización")
        setView(app, "Árbol")
        XCTAssertTrue(app.buttons["home.section.mine"].waitForExistence(timeout: 5))
        // Los asuntos van plegados: el chip «◆ 4» en la fila los despliega (3 y «+1 asuntos»).
        XCTAssertTrue(app.buttons["grp.issuesToggle.\(f.pagosId)"].firstMatch.waitForExistence(timeout: 5), "chip de asuntos en la fila del grupo")
        if !app.buttons["grp.moreIssues.\(f.pagosId)"].exists { issuesChip(app, f.pagosId).tap() }
        XCTAssertTrue(app.buttons["grp.moreIssues.\(f.pagosId)"].waitForExistence(timeout: 3), "4 asuntos: se ven 3 y «+1 asuntos»")
        sleep(1)
        shot("01-grupos")
        // Más abajo: Relaciones (con la pendiente) e Invitado en.
        let pending = app.descendants(matching: .any)["home.pending"]
        for _ in 0..<4 where !pending.exists { app.swipeUp() }
        XCTAssertTrue(pending.exists, "relación pendiente con Nestlé")
        XCTAssertTrue(app.buttons["home.section.relations"].exists)
        for _ in 0..<2 where !app.buttons["home.section.guest"].exists { app.swipeUp() }
        XCTAssertTrue(app.buttons["home.section.guest"].exists, "Invitado en")
        sleep(1)
        shot("01b-grupos-relaciones")
        app.swipeDown(); app.swipeDown(); app.swipeDown()

        // 2. DMs: directos y el sidechat con su burbuja.
        app.tabBars.buttons["DMs"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["dm.sideTag"].waitForExistence(timeout: 8), "sidechat en DMs")
        sleep(1)
        shot("02-dms")

        // 3. Nuevo grupo con otra empresa (relación existente) y enlace para compartir.
        app.tabBars.buttons["Grupos"].tap()
        app.buttons["quick.create"].tap()
        app.buttons["create.group"].tap()
        XCTAssertTrue(app.textFields["grp.name"].waitForExistence(timeout: 5))
        app.segmentedControls["grp.forWhom"].buttons["Con otra empresa"].tap()
        let name = app.textFields["grp.name"]
        name.tap(); name.typeText("Pagos y facturación Q4")
        app.swipeDown(velocity: .slow)
        sleep(1)
        shot("03-nuevo-grupo")
        app.buttons["sheet.submit"].tap()

        // 4. Pantalla de compartir: el código en grande.
        XCTAssertTrue(app.staticTexts["share.code"].waitForExistence(timeout: 10), "código para compartir")
        sleep(1)
        shot("04-compartir")
        app.buttons["share.done"].tap()
        XCTAssertTrue(app.navigationBars.buttons.firstMatch.waitForExistence(timeout: 8))

        // 5. Tú: perfil, unirme con código y supervisión.
        app.tabBars.buttons["Tú"].tap()
        XCTAssertTrue(app.buttons["you.joinCode"].waitForExistence(timeout: 8))
        sleep(1)
        shot("05-tu")

        // 6. Unirme con código (en minúsculas y sin guion) → abre el grupo.
        app.buttons["you.joinCode"].tap()
        let code = app.textFields["join.code"]
        XCTAssertTrue(code.waitForExistence(timeout: 5))
        code.tap(); code.typeText(f.joinCode.lowercased().replacingOccurrences(of: "-", with: ""))
        XCTAssertTrue(app.descendants(matching: .any)["join.preview"].waitForExistence(timeout: 8), "vista previa con los grupos")
        shot("06-unirme-codigo")
        app.buttons["join.accept"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat.header"].waitForExistence(timeout: 10), "abre el grupo de la invitación")

        // 7. Supervisión: el grupo de Carlos se abre en solo lectura.
        app.tabBars.buttons["Tú"].tap()
        let ovs = app.buttons["you.oversight.\(f.orgA)"]
        XCTAssertTrue(ovs.waitForExistence(timeout: 5))
        ovs.tap()
        let ventas = app.buttons["ovs.group.\(f.ventasId)"]
        // Con el fixture de 1.6.4 hay más grupos (más recientes) antes de «Ventas regionales».
        let listed = Date().addingTimeInterval(8)
        while Date() < listed && !app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'ovs.group.'")).firstMatch.exists { usleep(300_000) }
        for _ in 0..<5 where !ventas.isHittable { app.swipeUp() }
        XCTAssertTrue(ventas.waitForExistence(timeout: 3))
        shot("07-supervision")
        ventas.tap()
        XCTAssertTrue(app.descendants(matching: .any)["ovs.banner"].waitForExistence(timeout: 8), "franja de solo lectura")
        XCTAssertFalse(app.textViews["composer.field"].exists, "sin compositor")
        sleep(1)
        shot("08-solo-lectura")
        // Deja la vista por defecto para las demás pruebas (el segundo toque vuelve a la raíz de Grupos).
        app.tabBars.buttons["Grupos"].tap()
        if !app.buttons["grp.viewMode"].waitForExistence(timeout: 2) { app.tabBars.buttons["Grupos"].tap() }
        setView(app, "Lista")
    }

    /// 1.6.4: Lista (por defecto, «Empresa · Grupo», Fijados · Sin leer · Recientes) y Árbol; los asuntos van contraídos
    /// y se abren como sub-filas compactas con el chip, sin entrar al chat.
    func testListTreeAndCompactIssues() throws {
        let f = try fixture()
        XCTAssertFalse((f.apiUrl.contains("app.chaggu.com") || f.apiUrl.contains("app.tiecoms.com")), "no se prueba contra producción")
        guard let pinnedId = f.pinnedId else { throw XCTSkip("Fixture sin grupo fijado (1.6.4)") }
        let app = login(f)
        let pagos = app.buttons["conv.row.\(f.pagosId)"]
        let until = Date().addingTimeInterval(20)
        while Date() < until && !pagos.exists { dismissSystemPrompts(app); usleep(300_000) }
        dismissSystemPrompts(app)
        if app.buttons["home.tab.all"].exists { app.buttons["home.tab.all"].tap() }
        setView(app, "Lista")
        foldMenu(app)
        app.buttons["home.fold.hideIssues"].tap()
        // Lista: separadores, fijado arriba y «Empresa · Grupo».
        XCTAssertTrue(app.descendants(matching: .any)["grp.bucket.pinned"].waitForExistence(timeout: 5), "separador Fijados")
        XCTAssertTrue(app.descendants(matching: .any)["grp.bucket.unread"].exists, "separador Sin leer")
        XCTAssertTrue(app.buttons["conv.row.\(pinnedId)"].exists)
        XCTAssertFalse(app.buttons["home.section.mine"].exists, "sin cabeceras de sección en la Lista")
        XCTAssertTrue(pagos.label.contains("Xertify QA") && pagos.label.contains("Pagos y facturación"), "«Empresa · Grupo»: \(pagos.label)")
        XCTAssertLessThan(app.buttons["conv.row.\(pinnedId)"].frame.minY, pagos.frame.minY, "el fijado va arriba aunque no tenga no leídos")
        sleep(1)
        shot("01-grupos-lista")
        // Chip → sub-filas compactas (sin abrir el chat).
        issuesChip(app, f.pagosId).tap()
        let more = app.buttons["grp.moreIssues.\(f.pagosId)"]
        XCTAssertTrue(more.waitForExistence(timeout: 3))
        XCTAssertFalse(app.descendants(matching: .any)["chat.header"].exists, "el chip no abre el chat")
        if let overdue = f.overdueIssue {
            let line = app.buttons["grp.issue.\(overdue)"]
            XCTAssertTrue(line.exists)
            XCTAssertLessThan(line.frame.height, 34, "sub-fila compacta (antes 44 pt)")
        }
        sleep(1)
        shot("03-asuntos-expandidos-lista")
        issuesChip(app, f.pagosId).tap()
        XCTAssertTrue(more.waitForNonExistence(timeout: 3), "el chip vuelve a contraer")
        // Árbol: lo de siempre, con los fijados arriba dentro de cada sección.
        setView(app, "Árbol")
        XCTAssertTrue(app.buttons["home.section.mine"].waitForExistence(timeout: 5))
        sleep(1)
        shot("02-grupos-arbol")
        shot("05-asuntos-contraidos-arbol")
        issuesChip(app, f.pagosId).tap()
        XCTAssertTrue(more.waitForExistence(timeout: 3))
        sleep(1)
        shot("04-asuntos-expandidos-arbol")
        issuesChip(app, f.pagosId).tap()
        XCTAssertTrue(more.waitForNonExistence(timeout: 3))
        // Se recuerda la vista.
        app.terminate()
        let again = login(f)
        XCTAssertTrue(again.buttons["home.section.mine"].waitForExistence(timeout: 20), "sigue en Árbol tras reabrir")
        setView(again, "Lista")
        // DMs: Fijados · Sin leer · Recientes.
        again.tabBars.buttons["DMs"].tap()
        XCTAssertTrue(again.descendants(matching: .any)["dm.bucket.unread"].waitForExistence(timeout: 8))
        sleep(1)
        shot("09-dms-separadores")
    }

    /// 1.6.4: un chat largo abre en el primer no leído con «N mensajes nuevos»; ⌄ baja al final, «@» salta a la mención
    /// y, desde arriba, vuelve el ⌄.
    func testLongChatOpensAtFirstUnread() throws {
        let f = try fixture()
        XCTAssertFalse((f.apiUrl.contains("app.chaggu.com") || f.apiUrl.contains("app.tiecoms.com")), "no se prueba contra producción")
        guard let longId = f.longId else { throw XCTSkip("Fixture sin chat largo (1.6.4)") }
        let app = login(f)
        let row = app.buttons["conv.row.\(longId)"]
        let until = Date().addingTimeInterval(20)
        while Date() < until && !row.exists { dismissSystemPrompts(app); usleep(300_000) }
        dismissSystemPrompts(app)
        if app.buttons["home.tab.all"].exists { app.buttons["home.tab.all"].tap() }
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        let divider = app.descendants(matching: .any)["chat.newDivider"]
        XCTAssertTrue(divider.waitForExistence(timeout: 10), "línea de no leídos")
        XCTAssertTrue(app.staticTexts["40 mensajes nuevos"].exists)
        sleep(1)
        XCTAssertTrue(divider.isHittable, "abre en el primer no leído (la línea se ve)")
        XCTAssertTrue(app.staticTexts["Avance 31 de la cohorte: todo en orden por aquí"].exists, "el primer no leído")
        XCTAssertTrue(app.buttons["chat.jumpLatest"].exists, "⌄ Ir al final")
        XCTAssertTrue(app.buttons["chat.jumpMention"].exists, "@ a la mención")
        shot("06-chat-mensajes-nuevos")
        app.buttons["chat.jumpMention"].tap()
        XCTAssertTrue(app.buttons["chat.jumpMention"].waitForNonExistence(timeout: 3), "sin más menciones")
        sleep(1)
        shot("07-chat-mencion")
        app.buttons["chat.jumpLatest"].tap()
        XCTAssertTrue(app.buttons["chat.jumpLatest"].waitForNonExistence(timeout: 4), "al final se oculta el ⌄")
        XCTAssertTrue(app.staticTexts["Avance 70 de la cohorte: todo en orden por aquí"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["chat.jumpNew"].exists, "«↑ 40 nuevos» con la línea por encima")
        sleep(1)
        shot("08-chat-al-final")
        for _ in 0..<3 { app.swipeDown(velocity: .fast) }
        XCTAssertTrue(app.buttons["chat.jumpLatest"].waitForExistence(timeout: 3), "arriba vuelve el ⌄")
        sleep(1)
        shot("10-chat-boton-final")
        // Bruno escribe mientras Ana lee arriba: no la arrastra al final y el ⌄ lleva el globo con los nuevos.
        guard let b = f.b else { return }
        let visible = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Avance '")).firstMatch.label
        try postAs(f, email: b.email, conversationId: longId, body: "Nuevo aviso 1 mientras lees")
        try postAs(f, email: b.email, conversationId: longId, body: "Nuevo aviso 2 mientras lees")
        let jump = app.buttons["chat.jumpLatest"]
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline && !jump.label.contains(",") { usleep(300_000) }
        XCTAssertTrue(jump.label.contains("2"), "globo con 2 nuevos: \(jump.label)")
        XCTAssertTrue(app.staticTexts[visible].exists, "los mensajes nuevos no arrastran al final")
        sleep(1)
        shot("11-chat-nuevos-mientras-lees")
        jump.tap()
        sleep(1)
        shot("12-chat-tras-ir-al-final")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Nuevo aviso 2'")).firstMatch.waitForExistence(timeout: 5), "⌄ baja hasta lo nuevo")
        XCTAssertTrue(jump.waitForNonExistence(timeout: 3))
    }

    /// Publica un mensaje como otra persona del fixture (misma contraseña) directo contra el API de pruebas.
    private func postAs(_ f: Fixture, email: String, conversationId: String, body: String) throws {
        func call(_ path: String, token: String? = nil, json: [String: Any]) throws -> [String: Any] {
            var req = URLRequest(url: URL(string: f.apiUrl.replacingOccurrences(of: "//localhost", with: "//127.0.0.1") + "/api/v1" + path)!)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
            req.httpBody = try JSONSerialization.data(withJSONObject: json)
            var out: [String: Any] = [:]
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: req) { data, _, _ in
                out = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
                done.fulfill()
            }.resume()
            wait(for: [done], timeout: 10)
            return out
        }
        let login = try call("/auth/login", json: ["email": email, "password": f.password,
                                                   "device": ["deviceId": UUID().uuidString, "name": "UITest peer", "platform": "agent"]])
        let token = try XCTUnwrap(login["accessToken"] as? String, "login de la otra persona: \(login)")
        // El fixture acaba de publicar 70 mensajes como esta persona: el API puede responder 429 un rato.
        let cid = UUID().uuidString
        var sent: [String: Any] = [:]
        for _ in 0..<20 {
            sent = try call("/conversations/\(conversationId)/messages", token: token, json: ["clientMessageId": cid, "body": body])
            if sent["error"] == nil { break }
            sleep(3)
        }
        XCTAssertNotNil(sent["message"] ?? sent["id"], "mensaje enviado: \(sent)")
    }

    /// 1.6.1: los asuntos de cada grupo se pliegan con su chip (recordado al volver a abrir la app), se muestran o
    /// contraen todos desde «…», y mantener presionado un asunto lo completa (sale al instante) o lo reabre en Asuntos.
    func testIssuesFoldPersistAndQuickComplete() throws {
        let f = try fixture()
        XCTAssertFalse((f.apiUrl.contains("app.chaggu.com") || f.apiUrl.contains("app.tiecoms.com")), "no se prueba contra producción")
        var app = login(f)
        let toggle = app.buttons["grp.issuesToggle.\(f.pagosId)"].firstMatch
        let until = Date().addingTimeInterval(20)
        while Date() < until && !toggle.exists { dismissSystemPrompts(app); usleep(300_000) }
        dismissSystemPrompts(app)
        if app.buttons["home.tab.all"].exists { app.buttons["home.tab.all"].tap() }
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        // Punto de partida: todo contraído desde el menú de la cabecera (mantener presionado).
        foldMenu(app)
        XCTAssertTrue(app.buttons["home.fold.hideIssues"].waitForExistence(timeout: 3))
        app.buttons["home.fold.hideIssues"].tap()
        let more = app.buttons["grp.moreIssues.\(f.pagosId)"]
        XCTAssertFalse(more.waitForExistence(timeout: 1), "contraídos: ni asuntos ni «+N»")
        sleep(1)
        shot("15-grupos-asuntos-plegados")
        // Tocar el chip despliega sin entrar al chat.
        issuesChip(app, f.pagosId).tap()
        XCTAssertTrue(more.waitForExistence(timeout: 3))
        XCTAssertFalse(app.descendants(matching: .any)["chat.header"].exists, "el chip no abre el chat")
        shot("16-grupos-asuntos-abiertos")
        // Se recuerda en el dispositivo.
        app.terminate()
        app = login(f)
        XCTAssertTrue(app.buttons["grp.moreIssues.\(f.pagosId)"].waitForExistence(timeout: 20), "sigue desplegado tras reabrir la app")
        issuesChip(app, f.pagosId).tap()
        XCTAssertFalse(app.buttons["grp.moreIssues.\(f.pagosId)"].waitForExistence(timeout: 1))
        // «Mostrar todos los asuntos».
        foldMenu(app)
        app.buttons["home.fold.showIssues"].tap()
        XCTAssertTrue(app.buttons["grp.moreIssues.\(f.pagosId)"].waitForExistence(timeout: 3))
        // Mantener presionado el asunto vencido → Completar: sale al instante (quedan 3, sin «+N») y baja el chip.
        guard let overdue = f.overdueIssue else { throw XCTSkip("Fixture sin asunto vencido") }
        let line = app.buttons["grp.issue.\(overdue)"]
        XCTAssertTrue(line.waitForExistence(timeout: 5))
        line.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["issue.menu.complete"].waitForExistence(timeout: 4), "«Completar» en la pulsación larga")
        shot("17-completar-asunto")
        app.buttons["issue.menu.complete"].tap()
        XCTAssertTrue(line.waitForNonExistence(timeout: 5), "el asunto completado sale de Grupos")
        XCTAssertFalse(app.buttons["grp.moreIssues.\(f.pagosId)"].exists, "3 activos: ya no hay «+N asuntos»")
        // Deshacer desde Asuntos › Todos: Reabrir.
        app.tabBars.buttons["Asuntos"].tap()
        let seg = app.segmentedControls["issues.filter"]
        XCTAssertTrue(seg.waitForExistence(timeout: 5))
        seg.buttons.element(boundBy: 2).tap()
        let row = app.descendants(matching: .any).matching(identifier: "issue.row.\(overdue)").firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 8))
        row.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["issue.menu.reopen"].waitForExistence(timeout: 4))
        app.buttons["issue.menu.reopen"].tap()
        app.tabBars.buttons["Grupos"].tap()
        // El aviso de sistema al cerrar/reabrir sube la actividad del grupo: puede quedar más abajo en la Lista.
        let back = app.buttons["grp.moreIssues.\(f.pagosId)"]
        _ = back.waitForExistence(timeout: 3)
        for _ in 0..<5 where !(back.exists && back.isHittable) { app.swipeUp() }
        XCTAssertTrue(back.waitForExistence(timeout: 5), "reabierto: vuelve bajo el grupo")
        for _ in 0..<5 { app.swipeDown() }
        // Deja el estado por defecto para las demás pruebas.
        foldMenu(app)
        app.buttons["home.fold.hideIssues"].tap()
    }

    /// 1.6.4 (20): asuntos como tareas. El círculo completa con «Deshacer» (Grupos, Asuntos y el chat), alta rápida con
    /// Return, «Completados · N» plegable, Por grupo / Por responsable y el detalle con botones de un toque.
    func testIssueTasksCheckQuickAddAndDetail() throws {
        let f = try fixture()
        XCTAssertFalse((f.apiUrl.contains("app.chaggu.com") || f.apiUrl.contains("app.tiecoms.com")), "no se prueba contra producción")
        guard let overdue = f.overdueIssue else { throw XCTSkip("Fixture sin asunto vencido") }
        let app = login(f)
        let toggle = app.buttons["grp.issuesToggle.\(f.pagosId)"].firstMatch
        let until = Date().addingTimeInterval(20)
        while Date() < until && !toggle.exists { dismissSystemPrompts(app); usleep(300_000) }
        dismissSystemPrompts(app)
        if app.buttons["home.tab.all"].exists { app.buttons["home.tab.all"].tap() }
        setView(app, "Árbol")

        // 1. Árbol de Grupos: el círculo reemplaza al ◆ y completa sin entrar; «Deshacer» lo devuelve.
        foldMenu(app)
        app.buttons["home.fold.showIssues"].tap()
        let line = app.buttons["grp.issue.\(overdue)"]
        _ = line.waitForExistence(timeout: 3)
        for _ in 0..<6 where !(line.exists && line.isHittable) { app.swipeUp() }
        XCTAssertTrue(line.waitForExistence(timeout: 5))
        let check = app.buttons["issue.check.\(overdue)"]
        XCTAssertTrue(check.exists, "círculo para completar en la sub-fila")
        XCTAssertEqual(check.label, "Completar")
        XCTAssertLessThan(line.frame.height, 34, "la sub-fila sigue compacta")
        sleep(1)
        shot("01-grupos-arbol-circulo")
        check.tap()
        XCTAssertTrue(line.waitForNonExistence(timeout: 5), "completado: sale de Grupos")
        let undo = app.buttons["toast.undo"]
        XCTAssertTrue(undo.waitForExistence(timeout: 3), "aviso con «Deshacer»")
        XCTAssertTrue(app.staticTexts["Asunto completado"].exists)
        shot("02-grupos-completado-deshacer")
        undo.tap()
        XCTAssertTrue(line.waitForExistence(timeout: 5), "Deshacer lo devuelve")
        foldMenu(app)
        app.buttons["home.fold.hideIssues"].tap()
        setView(app, "Lista")

        // 2. Pestaña Asuntos: Míos / Abiertos / Completados con contador, Por grupo / Por responsable.
        app.tabBars.buttons["Asuntos"].tap()
        let seg = app.segmentedControls["issues.filter"]
        XCTAssertTrue(seg.waitForExistence(timeout: 5))
        XCTAssertTrue(seg.buttons.element(boundBy: 0).label.hasPrefix("Míos"))
        XCTAssertTrue(seg.buttons.element(boundBy: 2).label.hasPrefix("Completados"))
        seg.buttons.element(boundBy: 1).tap()
        let groupBy = app.segmentedControls["issues.groupBy"]
        XCTAssertTrue(groupBy.exists)
        groupBy.buttons["Por grupo"].tap()
        let row = app.buttons["issue.row.\(overdue)"]
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'issue.row.'")).firstMatch.waitForExistence(timeout: 8))
        sleep(1)
        shot("03-asuntos-por-grupo")
        groupBy.buttons["Por responsable"].tap()
        // Según el API, un asunto sin responsable queda de quien lo creó o en «Sin responsable».
        let mineSection = app.descendants(matching: .any)["issues.section.\(f.a.id)"]
        let noneSection = app.descendants(matching: .any)["issues.section.__none"]
        let sectionsBy = Date().addingTimeInterval(4)
        while Date() < sectionsBy && !mineSection.exists && !noneSection.exists { usleep(300_000) }
        XCTAssertTrue(mineSection.exists || noneSection.exists, "secciones por responsable")
        if mineSection.exists {
            XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Ana Márquez (tú)'")).firstMatch.exists, "yo primero, marcado «(tú)»")
        }
        sleep(1)
        shot("04-asuntos-por-responsable")
        groupBy.buttons["Por grupo"].tap()

        // 3. Alta rápida: responsable y fecha aparecen al escribir; Return crea y deja el campo listo.
        let quick = app.textFields["issue.quickField"]
        XCTAssertTrue(quick.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["issue.quickOwner"].exists, "vacío: una sola línea")
        let openBefore = seg.buttons.element(boundBy: 1).label
        quick.tap(); quick.typeText("Llamar al banco")
        XCTAssertTrue(app.buttons["issue.quickOwner"].waitForExistence(timeout: 3), "responsable al escribir")
        XCTAssertTrue(app.buttons["issue.quickDue"].exists, "fecha al escribir")
        XCTAssertTrue(app.buttons["issue.quickOwner"].label.contains("Yo") || app.buttons["issue.quickOwner"].staticTexts["Yo"].exists, "Yo por defecto")
        shot("05-alta-rapida")
        quick.typeText("\n")
        // Va al grupo o chat más reciente (puede quedar fuera de la pantalla): lo confirma el contador de «Abiertos».
        let createdBy = Date().addingTimeInterval(8)
        while Date() < createdBy && seg.buttons.element(boundBy: 1).label == openBefore { usleep(300_000) }
        XCTAssertNotEqual(seg.buttons.element(boundBy: 1).label, openBefore, "creado con Return (\(openBefore))")
        XCTAssertFalse(app.buttons["issue.quickOwner"].exists, "vacío otra vez: una sola línea")
        XCTAssertEqual((quick.value as? String) ?? "", "Añadir asunto…", "el campo queda vacío")
        XCTAssertTrue(app.keyboards.firstMatch.exists, "listo para el siguiente")
        app.swipeDown()

        // 4. Detalle: el título es el grupo; preguntas con botones de un toque; botón grande para terminar.
        // Los asuntos creados en corridas anteriores pueden dejar «Pagos» más abajo.
        for _ in 0..<8 where !(row.exists && row.isHittable) { app.swipeUp() }
        row.tap()
        XCTAssertTrue(app.navigationBars["Pagos y facturación"].waitForExistence(timeout: 8), "título = nombre del grupo")
        let markDone = app.buttons["issue.markDone"]
        XCTAssertTrue(markDone.waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any)["issue.alert"].label.contains("Se venció el"), "aviso en lenguaje simple")
        XCTAssertTrue(app.staticTexts["¿Quién lo hace?"].exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH '¿Para cuándo? · '")).firstMatch.exists, "con la fecha elegida")
        XCTAssertTrue(app.staticTexts["¿Cómo va?"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["issue.statusPicker"].exists, "sin selector de 5 estados")
        if let c = f.c {
            let carlos = app.buttons["issue.who.\(c.id)"]
            XCTAssertTrue(carlos.exists, "chip con el primer nombre")
            XCTAssertEqual(carlos.label, "Carlos")
            carlos.tap()
            XCTAssertTrue(app.buttons["issue.who.none"].waitForExistence(timeout: 5), "con responsable aparece «Sin responsable»")
        }
        app.buttons["issue.when.issue.dTomorrow"].tap()
        let whenDone = Date().addingTimeInterval(5)
        while Date() < whenDone && app.descendants(matching: .any)["issue.alert"].exists { usleep(300_000) }
        XCTAssertFalse(app.descendants(matching: .any)["issue.alert"].exists, "con fecha de mañana ya no está vencido")
        app.buttons["issue.how.in_progress"].tap()
        XCTAssertTrue(app.buttons["issue.how.in_progress"].waitForExistence(timeout: 3))
        sleep(2)
        shot("06-detalle")
        let field = app.descendants(matching: .any)["issue.commentField"]
        field.tap(); field.typeText("Hablé con tesorería, sale el lunes.")
        app.buttons["issue.commentSend"].tap()
        XCTAssertTrue(app.staticTexts["Hablé con tesorería, sale el lunes."].waitForExistence(timeout: 8), "comentario en Novedades")
        app.swipeUp()
        let history = app.buttons["issue.historyToggle"]
        if history.waitForExistence(timeout: 3) { history.tap() }
        sleep(1)
        shot("07-detalle-novedades-cambios")
        app.swipeDown(); app.swipeDown()
        markDone.tap()
        XCTAssertTrue(app.descendants(matching: .any)["issue.doneBanner"].waitForExistence(timeout: 5), "banner «✓ Hecho»")
        XCTAssertFalse(markDone.exists)
        sleep(1)
        shot("08-detalle-hecho")
        app.buttons["issue.reopenBtn"].tap()
        XCTAssertTrue(markDone.waitForExistence(timeout: 5), "reabierto")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // 5. Lista del chat: completar con el círculo → «Completados · 1» plegable.
        app.tabBars.buttons["Grupos"].tap()
        let pagos = app.buttons["conv.row.\(f.pagosId)"]
        XCTAssertTrue(pagos.waitForExistence(timeout: 8))
        pagos.tap()
        let bar = app.buttons["chat.bar.issues"]
        XCTAssertTrue(bar.waitForExistence(timeout: 8))
        bar.tap()
        let chatCheck = app.buttons["issue.check.\(overdue)"]
        XCTAssertTrue(chatCheck.waitForExistence(timeout: 5))
        XCTAssertTrue(app.textFields["issue.quickField"].exists, "alta rápida en la lista del chat")
        sleep(1)
        shot("09-lista-chat")
        chatCheck.tap()
        let doneToggle = app.buttons["issues.doneToggle"]
        XCTAssertTrue(doneToggle.waitForExistence(timeout: 5), "«Completados · N»")
        XCTAssertTrue(doneToggle.label.contains("Completados · "))
        XCTAssertTrue(app.buttons["toast.undo"].waitForExistence(timeout: 3), "Deshacer también sobre la hoja")
        doneToggle.tap()
        XCTAssertTrue(app.buttons["issue.check.\(overdue)"].waitForExistence(timeout: 3))
        XCTAssertEqual(app.buttons["issue.check.\(overdue)"].label, "Reabrir")
        sleep(1)
        shot("10-lista-chat-completados")
        app.buttons["issue.check.\(overdue)"].tap()
        XCTAssertTrue(app.buttons["issue.check.\(overdue)"].waitForExistence(timeout: 3))
        let reopened = Date().addingTimeInterval(5)
        while Date() < reopened && app.buttons["issue.check.\(overdue)"].label != "Completar" { usleep(300_000) }
        XCTAssertEqual(app.buttons["issue.check.\(overdue)"].label, "Completar", "reabierto desde Completados")
    }

    /// 1.6.4 (20): «Tamaño del texto» en Tú: 5 pasos, vista previa en vivo y toda la app (Grupos) cambia al instante.
    /// Con «Máximo» las filas no se cortan y la barra de pestañas queda limitada.
    func testTextSizeSetting() throws {
        let f = try fixture()
        XCTAssertFalse((f.apiUrl.contains("app.chaggu.com") || f.apiUrl.contains("app.tiecoms.com")), "no se prueba contra producción")
        let app = login(f)
        let pagos = app.buttons["conv.row.\(f.pagosId)"]
        let until = Date().addingTimeInterval(20)
        while Date() < until && !pagos.exists { dismissSystemPrompts(app); usleep(300_000) }
        dismissSystemPrompts(app)
        func setSize(_ step: Int, _ name: String) {
            app.tabBars.buttons["Tú"].tap()
            let slider = app.sliders["settings.textSize"]
            for _ in 0..<6 where !slider.isHittable { app.swipeUp() }
            XCTAssertTrue(slider.waitForExistence(timeout: 5), "control de tamaño en Tú")
            // adjust(toNormalizedSliderPosition:) no es exacto en un Slider con pasos: se corrige hasta dar con el paso.
            let names = ["Pequeño", "Normal", "Grande", "Más grande", "Máximo"]
            let value = app.staticTexts["settings.textSize.value"]
            var pos = CGFloat(step) / 4
            for _ in 0..<8 {
                if step == 4 {
                    // Arrastrar el pulgar más allá del extremo derecho.
                    let from = CGFloat(names.firstIndex(of: value.label) ?? 0) / 4
                    slider.coordinate(withNormalizedOffset: CGVector(dx: 0.04 + from * 0.92, dy: 0.5))
                        .press(forDuration: 0.2, thenDragTo: slider.coordinate(withNormalizedOffset: CGVector(dx: 1.3, dy: 0.5)))
                } else { slider.adjust(toNormalizedSliderPosition: pos) }
                usleep(400_000)
                guard let now = names.firstIndex(of: value.label), now != step else { break }
                pos = min(1, max(0, pos + (now < step ? 0.06 : -0.06)))
            }
            XCTAssertEqual(value.label, name)
        }
        func groupsShot(_ name: String) {
            app.tabBars.buttons["Grupos"].tap()
            if !app.buttons["grp.viewMode"].waitForExistence(timeout: 2) { app.tabBars.buttons["Grupos"].tap() }
            for _ in 0..<3 { app.swipeDown() }
            sleep(1)
            shot(name)
        }
        setSize(1, "Normal")
        XCTAssertTrue(app.descendants(matching: .any)["settings.textSize.preview"].exists, "vista previa")
        sleep(1)
        shot("11-tamano-texto-ajuste")
        groupsShot("12-grupos-texto-normal")
        let normalHeight = app.buttons["conv.row.\(f.pagosId)"].frame.height
        setSize(2, "Grande")
        sleep(1)
        shot("13-tamano-texto-grande-ajuste")
        groupsShot("14-grupos-texto-grande")
        let largeRow = app.buttons["conv.row.\(f.pagosId)"]
        XCTAssertGreaterThan(largeRow.frame.height, normalHeight, "Grande: la fila crece (\(normalHeight) → \(largeRow.frame.height))")
        setSize(4, "Máximo")
        groupsShot("15-grupos-texto-maximo")
        let tab = app.tabBars.firstMatch
        XCTAssertTrue(tab.buttons["Grupos"].isHittable, "la barra de pestañas sigue visible con «Máximo»")
        XCTAssertLessThan(tab.frame.height, 140, "barra de pestañas limitada: \(tab.frame.height)")
        // Vuelve a Normal para las demás pruebas.
        setSize(1, "Normal")
        app.tabBars.buttons["Grupos"].tap()
    }

    /// 1.6.4 (21): mensajes programados, «No molestar todas las noches» y tareas derivadas (docs/PROGRAMADOS.md, TAREAS.md).
    func testScheduledSleepAndTasks() throws {
        let f = try fixture()
        XCTAssertFalse((f.apiUrl.contains("app.chaggu.com") || f.apiUrl.contains("app.tiecoms.com")), "no se prueba contra producción")
        guard let dm = f.dmBrunoId, let parent = f.parentIssueId, let tasks = f.taskIds, let side = f.sideId else { throw XCTSkip("Fixture sin seed-tareas-programados") }
        let app = login(f)
        let until = Date().addingTimeInterval(20)
        while Date() < until && !app.tabBars.firstMatch.exists { dismissSystemPrompts(app); usleep(300_000) }
        dismissSystemPrompts(app)

        // 1. Directo con Bruno (descansando): franja de programados y aviso.
        app.tabBars.buttons["DMs"].tap()
        let row = app.buttons["conv.row.\(dm)"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        let strip = app.buttons["sched.strip"]
        XCTAssertTrue(strip.waitForExistence(timeout: 10), "franja de programados")
        XCTAssertTrue(strip.label.hasPrefix("🕒 ") && strip.label.contains("el próximo sale"), strip.label)
        let before = strip.label
        let notice = app.descendants(matching: .any)["sleep.notice.text"]
        XCTAssertTrue(notice.waitForExistence(timeout: 5), "aviso de descanso")
        XCTAssertTrue(notice.label.hasPrefix("Bruno está descansando: le llega sin sonar. Lo verá"), notice.label)
        XCTAssertFalse(app.buttons["sleep.scheduleWake"].exists, "el botón sale solo mientras escribo")
        sleep(1)
        shot("16-chat-programados-y-descansando")
        let field = app.descendants(matching: .any)["composer.field"]
        field.tap(); field.typeText("Te cuento mañana cómo quedó el cierre")
        XCTAssertTrue(app.buttons["composer.schedule"].waitForExistence(timeout: 3), "🕒 junto a enviar con texto")
        XCTAssertTrue(app.buttons["sleep.scheduleWake"].waitForExistence(timeout: 3), "🕒 Enviar a las …")
        XCTAssertTrue(app.buttons["sleep.scheduleWake"].label.contains("Enviar a las"))
        shot("17-compositor-programar-y-despertar")
        app.buttons["composer.schedule"].tap()
        let tomorrow = app.buttons["sched.opt.sched.tomorrowMorning"]
        XCTAssertTrue(tomorrow.waitForExistence(timeout: 3), "menú de programar")
        XCTAssertTrue(app.buttons["sched.opt.sched.inHour"].exists)
        XCTAssertTrue(app.buttons["sched.opt.pick"].exists)
        sleep(1)
        shot("18-menu-programar")
        tomorrow.tap()
        XCTAssertTrue(app.buttons["toast.undo"].waitForExistence(timeout: 5), "aviso con Deshacer")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH '🕒 Programado para mañana'")).firstMatch.exists)
        let two = Date().addingTimeInterval(5)
        while Date() < two && strip.label == before { usleep(300_000) }
        XCTAssertTrue(strip.label.contains("mensajes programados") && strip.label != before, "uno más: \(before) → \(strip.label)")
        let inChat = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'sched.sendNow.'"))
        shot("19-programado-con-deshacer")
        strip.tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'sched.sendNow.'")).firstMatch.waitForExistence(timeout: 5))
        XCTAssertGreaterThanOrEqual(inChat.count, 2)
        sleep(1)
        shot("20-programados-del-chat")
        app.buttons["Cerrar"].firstMatch.tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // 2. Tú: «Todas las noches» dentro de No molestar y la pantalla Programados.
        app.tabBars.buttons["Tú"].tap()
        let dnd = app.buttons["settings.dnd"]
        for _ in 0..<5 where !(dnd.exists && dnd.isHittable) { app.swipeUp() }
        XCTAssertTrue(app.buttons["settings.sleep"].exists, "fila Todas las noches")
        dnd.tap()
        let nightly = app.buttons["dnd.opt.sleep"]
        XCTAssertTrue(nightly.waitForExistence(timeout: 3), "«Todas las noches» dentro de No molestar")
        sleep(1)
        shot("21-no-molestar-todas-las-noches")
        nightly.tap()
        XCTAssertTrue(app.switches["sleep.switch"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any)["sleep.from"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["sleep.to"].exists)
        sleep(1)
        shot("22-todas-las-noches-desde-hasta")
        app.buttons["sleep.save"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'No molestar todas las noches de'")).firstMatch.waitForExistence(timeout: 5))
        let schedRow = app.buttons["settings.scheduled"]
        for _ in 0..<5 where !(schedRow.exists && schedRow.isHittable) { app.swipeUp() }
        XCTAssertTrue(schedRow.label.hasPrefix("Programados · "), schedRow.label)
        schedRow.tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'sched.sendNow.'")).firstMatch.waitForExistence(timeout: 5))
        sleep(1)
        shot("23-pantalla-programados")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // 3. Tareas derivadas: chapita ☑, tareas sangradas, 🔒, menú y alta con ¿Quién la ve?
        app.tabBars.buttons["Asuntos"].tap()
        let seg = app.segmentedControls["issues.filter"]
        XCTAssertTrue(seg.waitForExistence(timeout: 5))
        seg.buttons.element(boundBy: 1).tap()
        app.segmentedControls["issues.groupBy"].buttons["Por grupo"].tap()
        let parentRow = app.buttons["issue.row.\(parent)"]
        for _ in 0..<6 where !(parentRow.exists && parentRow.isHittable) { app.swipeUp() }
        XCTAssertTrue(parentRow.waitForExistence(timeout: 5))
        XCTAssertTrue(parentRow.label.contains("1 de 4 tareas hechas"), "chapita de avance: \(parentRow.label)")
        let orgTask = app.buttons["issue.row.\(tasks[1])"]
        XCTAssertTrue(orgTask.exists, "tarea sangrada bajo el asunto")
        XCTAssertTrue(orgTask.label.contains("🔒"), orgTask.label)
        sleep(1)
        shot("24-asuntos-con-tareas")
        parentRow.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["issue.menu.addTask"].waitForExistence(timeout: 4), "＋ Tarea derivada")
        XCTAssertTrue(app.buttons["issue.menu.sidechat"].exists, "💬 Hablar aparte")
        shot("25-menu-tarea-derivada")
        app.buttons["issue.menu.addTask"].tap()
        let tf = app.textFields["task.quickField"]
        XCTAssertTrue(tf.waitForExistence(timeout: 5), "hoja de tareas del asunto")
        tf.tap(); tf.typeText("Llamar al banco")
        XCTAssertTrue(app.buttons["task.vis.org"].waitForExistence(timeout: 3), "¿Quién la ve?")
        XCTAssertTrue(app.buttons["task.vis.all"].isSelected, "Pagos es de una sola empresa: por defecto, todo el chat")
        XCTAssertTrue(app.buttons["task.otherPerson"].exists, "＋ Otra persona")
        sleep(1)
        shot("26-alta-tarea-quien-la-hace-quien-la-ve")
        tf.typeText("\n")
        let created = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'issue.row.' AND label CONTAINS 'Llamar al banco'")).firstMatch
        XCTAssertTrue(created.waitForExistence(timeout: 8), "tarea creada en la hoja")
        app.buttons["task.sheetDone"].tap()
        XCTAssertTrue(parentRow.waitForExistence(timeout: 5))
        let five = Date().addingTimeInterval(5)
        while Date() < five && !parentRow.label.contains("1 de 5 tareas hechas") { usleep(300_000) }
        XCTAssertTrue(parentRow.label.contains("1 de 5 tareas hechas"), parentRow.label)
        parentRow.tap()
        XCTAssertTrue(app.descendants(matching: .any)["task.section"].waitForExistence(timeout: 8), "sección Tareas en el asunto")
        app.swipeUp()
        sleep(1)
        shot("27-detalle-asunto-tareas")
        let child = app.buttons["issue.row.\(tasks[1])"]
        for _ in 0..<3 where !(child.exists && child.isHittable) { app.swipeUp() }
        child.tap()
        XCTAssertTrue(app.buttons["task.partOf"].waitForExistence(timeout: 8), "↑ Parte de «asunto»")
        XCTAssertTrue(app.descendants(matching: .any)["issue.requested"].label.contains("🔒"), "🔒 Solo mi empresa")
        sleep(1)
        shot("28-tarea-parte-de")
        app.buttons["task.partOf"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["task.section"].waitForExistence(timeout: 5), "vuelve al asunto")

        // 4. Sidechat desde el asunto: franja «◆ asunto · ☑ · ＋ Tarea».
        app.tabBars.buttons["DMs"].tap()
        let sideRow = app.buttons["conv.row.\(side)"]
        for _ in 0..<4 where !sideRow.exists { app.swipeUp() }
        XCTAssertTrue(sideRow.waitForExistence(timeout: 8), "sidechat en DMs")
        sideRow.tap()
        let sideStrip = app.buttons["side.issue"]
        XCTAssertTrue(sideStrip.waitForExistence(timeout: 10), "franja del asunto en el sidechat")
        XCTAssertTrue(sideStrip.label.hasPrefix("◆ Cerrar facturación"), sideStrip.label)
        XCTAssertTrue(app.buttons["side.addTask"].exists, "＋ Tarea")
        sleep(1)
        shot("29-sidechat-desde-el-asunto")
        app.buttons["side.addTask"].tap()
        XCTAssertTrue(app.buttons["task.sheetDone"].waitForExistence(timeout: 5))
        let sf = app.textFields["task.quickField"]
        sf.tap(); sf.typeText("Confirmar fecha")
        XCTAssertTrue(app.buttons["task.vis.all"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["task.vis.all"].label.contains("Solo este sidechat"), app.buttons["task.vis.all"].label)
        shot("30-tarea-en-el-sidechat")
        app.buttons["task.sheetDone"].tap()
    }

    /// Barra de arriba (✏️ y «＋») en las cuatro pestañas, chat rápido desde «Mensaje nuevo» y búsqueda que encuentra
    /// personas sin directo (tocar = escribirle) y grupos.
    func testQuickComposeCreateAndSearch() throws {
        let f = try fixture()
        XCTAssertFalse((f.apiUrl.contains("app.chaggu.com") || f.apiUrl.contains("app.tiecoms.com")), "no se prueba contra producción")
        let app = login(f)
        dismissSystemPrompts(app)
        XCTAssertTrue(app.buttons["quick.compose"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["home.more"].exists, "sin «…» en Grupos")
        shot("20-grupos-barra")

        // «＋»: grupo, asunto, reunión y código, igual en todas las pestañas.
        for tab in ["Grupos", "DMs", "Asuntos", "Calendario"] {
            app.tabBars.buttons[tab].tap()
            XCTAssertTrue(app.buttons["quick.compose"].waitForExistence(timeout: 5), "✏️ en \(tab)")
            app.buttons["quick.create"].tap()
            for id in ["create.group", "create.issue", "create.event", "create.join"] {
                XCTAssertTrue(app.buttons[id].waitForExistence(timeout: 3), "\(id) en \(tab)")
            }
            if tab == "Asuntos" { shot("21-crear-menu") }
            app.buttons["create.issue"].tap()
            XCTAssertTrue(app.descendants(matching: .any)["issue.where"].waitForExistence(timeout: 5), "asunto: elegir grupo o chat")
            if tab == "Asuntos" { shot("22-nuevo-asunto") }
            app.buttons["Cancelar"].firstMatch.tap()
        }

        // Buscar en DMs: Bruno (ya con directo) sale en Chats y no se repite; Gloria, sin directo, sale en Personas.
        app.tabBars.buttons["DMs"].tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap(); search.typeText("Bruno")
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'search.person.' AND label CONTAINS 'Bruno'")).firstMatch.waitForExistence(timeout: 2), "con directo no se repite en Personas")
        if search.buttons.firstMatch.exists { search.buttons.firstMatch.tap() }
        search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 8) + "Gloria")
        // Sin directo sale en Personas; si una corrida anterior ya lo abrió (sesión conservada), en Chats.
        let gloria = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'search.person.' OR identifier BEGINSWITH 'conv.row.'")).firstMatch
        XCTAssertTrue(gloria.waitForExistence(timeout: 5), "Gloria en la búsqueda")
        shot("23-dms-buscar-persona")
        gloria.tap()
        XCTAssertTrue(app.descendants(matching: .any)["composer.field"].waitForExistence(timeout: 10), "abre el directo")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        closeSearch(app)

        // Buscar en Grupos: también personas.
        app.tabBars.buttons["Grupos"].tap()
        let gsearch = app.searchFields.firstMatch
        XCTAssertTrue(gsearch.waitForExistence(timeout: 5))
        gsearch.tap(); gsearch.typeText("Carlos")
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'search.conv.'")).firstMatch.waitForExistence(timeout: 5), "Carlos (con directo) en Chats")
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'search.person.' AND label CONTAINS 'Carlos'")).firstMatch.exists, "sin repetirlo en Personas")
        if gsearch.buttons.firstMatch.exists { gsearch.buttons.firstMatch.tap() }
        gsearch.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 6) + "Gloria")
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'search.person.' OR identifier BEGINSWITH 'search.conv.'")).firstMatch.waitForExistence(timeout: 5), "personas al buscar en Grupos")
        shot("24-grupos-buscar-persona")
        closeSearch(app)

        // ✏️ Mensaje nuevo: un toque en la persona abre el chat.
        app.buttons["quick.compose"].tap()
        // Por nombre: el simulador puede conservar la sesión de un fixture anterior (otros ids, mismos nombres).
        let carlos = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'picker.person.' AND label CONTAINS 'Carlos'")).firstMatch
        XCTAssertTrue(carlos.waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any)["compose.tip"].exists, "1.6.10: tocar marca; el 💬 abre el directo")
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'compose.recent.' AND label CONTAINS 'Bruno'")).firstMatch.exists, "Bruno en Recientes")
        shot("25-mensaje-nuevo")
        let field = app.textFields["compose.search"]
        field.tap(); field.typeText("Pagos")
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'compose.group.'")).firstMatch.waitForExistence(timeout: 3), "grupos al buscar en Mensaje nuevo")
        shot("26-mensaje-nuevo-buscar-grupo")
        app.buttons["Borrar"].tap()
        let carlosDirect = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'compose.direct.' AND label CONTAINS 'Carlos'")).firstMatch
        carlosDirect.tap()
        XCTAssertTrue(app.descendants(matching: .any)["composer.field"].waitForExistence(timeout: 10), "el 💬 abre el directo")
        shot("27-directo-abierto")
    }

    /// Reacciones: chips bajo la burbuja (con las del fixture) y la barra rápida de la pulsación larga.
    func testReactionChipsAndQuickBar() throws {
        let f = try fixture()
        guard let general = f.generalId else { throw XCTSkip("Fixture sin grupo general") }
        XCTAssertFalse((f.apiUrl.contains("app.chaggu.com") || f.apiUrl.contains("app.tiecoms.com")))
        let app = login(f)
        let row = app.buttons["conv.row.\(general)"]
        let until = Date().addingTimeInterval(20)
        while Date() < until && !row.exists { dismissSystemPrompts(app); usleep(300_000) }
        dismissSystemPrompts(app)
        for _ in 0..<4 where !row.isHittable { app.swipeUp() }
        row.tap()
        let anyChip = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "react.chip.")).firstMatch
        guard anyChip.waitForExistence(timeout: 8) else { throw XCTSkip("El fixture no trae reacciones (sembrarlas con react-probe)") }
        sleep(1)
        shot("18-reacciones")
        // Barra rápida: mantener presionado un mensaje.
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Movemos la mentoría")).firstMatch.press(forDuration: 1.0)
        XCTAssertTrue(app.buttons["menu.thread"].waitForExistence(timeout: 5))
        sleep(1)
        shot("19-barra-rapida")
        let thumbs = app.buttons["👍"].firstMatch
        if thumbs.exists {
            thumbs.tap()
            let mine = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND identifier ENDSWITH %@", "react.chip.", "👍"))
            XCTAssertTrue(mine.firstMatch.waitForExistence(timeout: 5), "el 👍 aparece bajo el mensaje")
        } else {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.04, dy: 0.55)).tap()
        }
    }

    /// Splash con la línea «Conexión cifrada…» en español e inglés (fotograma congelado tras el eslogan).
    func testSplashSecurityLineInBothLanguages() throws {
        for lang in ["es", "en"] {
            let app = XCUIApplication()
            app.launchArguments = ["-TCSplashFreeze", "2.3", "-TCResetSession", "YES", "-TCResetLanguage", "YES", "-TCApiURL", "http://127.0.0.1:9", "-AppleLanguages", "(\(lang))"]
            app.launch()
            let splash = app.descendants(matching: .any)["splash"]
            XCTAssertTrue(splash.waitForExistence(timeout: 5))
            XCTAssertTrue(splash.label.contains(lang == "es" ? "Conexión cifrada para proteger tu información" : "Encrypted connection to help protect your information"), splash.label)
            sleep(1)
            shot("23-splash-\(lang)")
            app.terminate()
        }
    }

    /// Tú › Idioma: cambia al instante (sin reiniciar); en inglés los asuntos son «Subjects».
    func testInAppLanguageSwitch() throws {
        let f = try fixture()
        let app = login(f)
        let youTab = app.tabBars.buttons.element(boundBy: 4)
        XCTAssertTrue(youTab.waitForExistence(timeout: 20))
        dismissSystemPrompts(app)
        youTab.tap()
        let picker = app.buttons["settings.language"]
        for _ in 0..<6 where !picker.isHittable { app.swipeUp() }
        picker.tap()
        app.buttons["English"].tap()
        sleep(1)
        XCTAssertTrue(app.tabBars.buttons["Subjects"].waitForExistence(timeout: 5), "la barra cambia a inglés al instante")
        shot("24-idioma-en-ajustes")
        app.tabBars.buttons.element(boundBy: 0).tap()
        sleep(1)
        shot("25-grupos-en")
        // Vuelve a automático (español en estas pruebas).
        app.tabBars.buttons.element(boundBy: 4).tap()
        let picker2 = app.buttons["settings.language"]
        for _ in 0..<6 where !picker2.isHittable { app.swipeUp() }
        picker2.tap()
        let auto = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Automatic")).firstMatch
        if !auto.waitForExistence(timeout: 4) { shot("dbg-idioma") }
        auto.tap()
        XCTAssertTrue(app.tabBars.buttons["Asuntos"].waitForExistence(timeout: 5))
        shot("26-idioma-es")
    }

    /// Elegir un idioma en Tú › Idioma (el nombre de cada idioma se ve igual en ambos).
    private func pickLanguage(_ app: XCUIApplication, _ label: String) {
        app.tabBars.buttons.element(boundBy: 4).tap()
        let picker = app.buttons["settings.language"]
        for _ in 0..<6 where !picker.isHittable { app.swipeUp() }
        picker.tap()
        let option = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", label)).firstMatch
        XCTAssertTrue(option.waitForExistence(timeout: 4), label)
        option.tap()
        sleep(1)
    }

    /// El idioma elegido sobrevive a cerrar y volver a abrir la app (sin borrar preferencias).
    func testLanguagePersistsAcrossRelaunch() throws {
        let f = try fixture()
        var app = login(f)
        XCTAssertTrue(app.tabBars.buttons.element(boundBy: 4).waitForExistence(timeout: 20))
        dismissSystemPrompts(app)
        pickLanguage(app, "English")
        XCTAssertTrue(app.tabBars.buttons["Subjects"].waitForExistence(timeout: 5))
        app.terminate()
        app = login(f, resetLanguage: false)
        XCTAssertTrue(app.tabBars.buttons["Subjects"].waitForExistence(timeout: 20), "sigue en inglés tras reabrir (aunque el sistema diga es)")
        app.tabBars.buttons.element(boundBy: 4).tap()
        let picker = app.buttons["settings.language"]
        for _ in 0..<6 where !picker.isHittable { app.swipeUp() }
        XCTAssertTrue(picker.label.contains("English") || (picker.value as? String)?.contains("English") == true, "Ajustes muestra English: \(picker.label)")
        shot("27-idioma-en-tras-reabrir")
        pickLanguage(app, "Español")
        XCTAssertTrue(app.tabBars.buttons["Asuntos"].waitForExistence(timeout: 5))
        app.terminate()
        app = login(f, resetLanguage: false)
        XCTAssertTrue(app.tabBars.buttons["Asuntos"].waitForExistence(timeout: 20), "sigue en español tras reabrir")
        shot("28-idioma-es-tras-reabrir")
        pickLanguage(app, "Autom")
    }

    /// Mantener presionada una burbuja (su parte visible si la tapa la barra del chat) hasta que aparezca `until`.
    private func openMenu(_ target: XCUIElement, until: XCUIElement) {
        for _ in 0..<3 where !until.exists {
            sleep(1)
            let dy: CGFloat = target.frame.minY < 250 ? 0.9 : 0.5
            target.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: dy)).press(forDuration: 1.2)
            _ = until.waitForExistence(timeout: 3)
        }
    }

    /// Reaccionar a mensajes con imágenes (sin texto, con texto, varias; míos y ajenos) no debe cerrar la app:
    /// barra rápida, cambiar de emoji, quitar con el chip. Ids por TEST_RUNNER_TC_IMAGES (seed-images.mjs).
    func testReactToImageMessagesDoesNotCrash() throws {
        let f = try fixture()
        let env = ProcessInfo.processInfo.environment
        guard let general = f.generalId, let path = env["TC_IMAGES"], !path.isEmpty else {
            // Para una entrega (TC_REQUIRE_IMAGES=1) no vale omitirla: tiene que correr.
            if env["TC_REQUIRE_IMAGES"] == "1" { XCTFail("TC_REQUIRE_IMAGES=1 sin TC_IMAGES o sin grupo general"); return }
            throw XCTSkip("Sin TC_IMAGES")
        }
        let ids = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        let app = login(f)
        let row = app.buttons["conv.row.\(general)"]
        let until = Date().addingTimeInterval(20)
        while Date() < until && !row.exists { dismissSystemPrompts(app); usleep(300_000) }
        for _ in 0..<4 where !row.isHittable { app.swipeUp() }
        let header = app.descendants(matching: .any)["chat.header"]
        for _ in 0..<3 where !header.exists { sleep(1); dismissSystemPrompts(app); if row.isHittable { row.tap() }; _ = header.waitForExistence(timeout: 4) }
        // Los cinco casos son obligatorios: un fixture incompleto falla en vez de pasar sin probar nada.
        let cases = [("bFile", "archivo PDF ajeno"), ("bMany", "3 imágenes ajenas"), ("aImage", "imagen mía"),
                     ("bCaption", "imagen con texto"), ("bImage", "imagen ajena sin texto")]
        var evidence: [String] = []
        for (key, what) in cases {
            let id = try XCTUnwrap(ids[key], "falta el caso \(key) (\(what)) en TC_IMAGES")
            let msg = app.descendants(matching: .any).matching(identifier: "msg.\(id)").firstMatch
            for _ in 0..<6 where !msg.isHittable { app.swipeDown(velocity: .slow) }
            XCTAssertTrue(msg.waitForExistence(timeout: 5), key)
            let media = msg.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "att.media.")).firstMatch
            let target = media.exists ? media : msg
            let thumbs = app.buttons["👍"].firstMatch
            openMenu(target, until: thumbs)
            XCTAssertTrue(thumbs.exists, "barra rápida sobre \(key)")
            thumbs.tap()
            XCTAssertEqual(app.state, .runningForeground, "no se cierra al reaccionar a \(key)")
            let chip = app.buttons.matching(identifier: "react.chip.\(id).👍").firstMatch
            XCTAssertTrue(chip.waitForExistence(timeout: 6), "chip 👍 bajo \(key)")
            // Cambiar a otro emoji y quitarlo con el chip.
            sleep(1)
            let heart = app.buttons["❤️"].firstMatch
            openMenu(target, until: heart)
            XCTAssertTrue(heart.exists, "barra rápida otra vez sobre \(key)")
            heart.tap()
            XCTAssertTrue(app.buttons.matching(identifier: "react.chip.\(id).❤️").firstMatch.waitForExistence(timeout: 6))
            sleep(2)   // que termine de cerrarse el menú
            app.buttons.matching(identifier: "react.chip.\(id).❤️").firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            XCTAssertTrue(app.buttons.matching(identifier: "react.chip.\(id).❤️").firstMatch.waitForNonExistence(timeout: 6), "se quita con el chip")
            // Y el 👍 también, con su chip: el mensaje queda sin reacciones mías.
            let thumbChip = app.buttons.matching(identifier: "react.chip.\(id).👍").firstMatch
            XCTAssertTrue(thumbChip.exists, "el 👍 sigue tras sumar ❤️")
            thumbChip.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            XCTAssertTrue(thumbChip.waitForNonExistence(timeout: 6), "se quita el 👍")
            XCTAssertEqual(app.state, .runningForeground)
            shot("22-reaccion-\(key)")
            evidence.append("\(key) (\(what)), mensaje \(id): 👍 aparece → se suma ❤️ → ❤️ y 👍 se quitan con su chip; la app sigue abierta")
        }
        XCTAssertEqual(evidence.count, cases.count)
        let log = XCTAttachment(string: evidence.joined(separator: "\n"))
        log.name = "reacciones-imagenes"
        log.lifetime = .keepAlways
        add(log)
        if let dir = ProcessInfo.processInfo.environment["TC_SHOTS"], !dir.isEmpty {
            try? (evidence.joined(separator: "\n") + "\n").write(toFile: dir + "/reacciones-imagenes.txt", atomically: true, encoding: .utf8)
        }
    }

    /// Dentro del chat: barra de accesos, chip del hilo bajo su mensaje, el hilo al lado y el «＋» del compositor.
    func testChatBarThreadsAndPlus() throws {
        let f = try fixture()
        guard let general = f.generalId, let thread = f.threadId else { throw XCTSkip("Fixture sin hilo") }
        XCTAssertFalse((f.apiUrl.contains("app.chaggu.com") || f.apiUrl.contains("app.tiecoms.com")))
        let app = login(f)
        let row = app.buttons["conv.row.\(general)"]
        let until = Date().addingTimeInterval(20)
        while Date() < until && !row.exists { dismissSystemPrompts(app); usleep(300_000) }
        dismissSystemPrompts(app)
        for _ in 0..<4 where !row.isHittable { app.swipeUp() }
        row.tap()
        XCTAssertTrue(app.buttons["chat.bar.threads"].waitForExistence(timeout: 8), "barra de accesos")
        let chip = app.buttons["thread.chip.\(thread)"]
        XCTAssertTrue(chip.waitForExistence(timeout: 8), "chip del hilo bajo su mensaje")
        XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "derivó")).firstMatch.exists)
        sleep(1)
        shot("09-chat-barra")
        // Menú del mensaje: responder / en privado, y aparte, hilo / sidechat privado.
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Movemos la mentoría")).firstMatch.press(forDuration: 1.0)
        XCTAssertTrue(app.buttons["menu.thread"].waitForExistence(timeout: 5), "«Responder en un hilo»")
        XCTAssertTrue(app.buttons["menu.sidechat"].exists, "«Sidechat privado»")
        XCTAssertTrue(app.buttons["menu.privateReply"].exists, "«Responder en privado» aparte")
        sleep(1)
        shot("09b-menu-mensaje")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.04, dy: 0.55)).tap()
        sleep(1)
        chip.tap()
        XCTAssertTrue(app.buttons["thread.resolve"].waitForExistence(timeout: 8), "el hilo se abre al lado con «Resolver»")
        sleep(1)
        shot("10-hilo-al-lado")
        app.buttons["side.close"].firstMatch.tap()
        sleep(1)
        app.buttons["chat.bar.threads"].tap()
        XCTAssertTrue(app.buttons["thread.row.\(thread)"].waitForExistence(timeout: 5))
        shot("11-hilos")
        app.buttons["Cerrar"].firstMatch.tap()
        sleep(1)
        app.buttons["composer.attach"].tap()
        XCTAssertTrue(app.buttons["composer.plus.issue"].waitForExistence(timeout: 5), "«＋» con evento y asunto")
        shot("12-mas")
    }

    /// Mencionar dentro de un sidechat abierto en hoja (el caso del choque en el iPhone): «@», elegir, seguir escribiendo,
    /// borrar sobre el token, emojis y tildes antes del «@».
    func testMentionInsideSidechatSheet() throws {
        let f = try fixture()
        guard let general = f.generalId else { throw XCTSkip("Fixture sin grupo general") }
        XCTAssertFalse((f.apiUrl.contains("app.chaggu.com") || f.apiUrl.contains("app.tiecoms.com")))
        let app = login(f)
        let row = app.buttons["conv.row.\(general)"]
        let until = Date().addingTimeInterval(20)
        while Date() < until && !row.exists { dismissSystemPrompts(app); usleep(300_000) }
        dismissSystemPrompts(app)
        for _ in 0..<4 where !row.isHittable { app.swipeUp() }
        row.tap()
        let chip = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "side.chip.")).firstMatch
        XCTAssertTrue(chip.waitForExistence(timeout: 8))
        chip.tap()
        XCTAssertTrue(app.otherElements["side.panel"].waitForExistence(timeout: 8) || app.descendants(matching: .any)["side.anchor"].waitForExistence(timeout: 4))
        // El del sidechat (la hoja) es el primero; el del chat de atrás, el segundo.
        let field = app.textViews.matching(identifier: "composer.field").element(boundBy: 0)
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        sleep(1)
        field.typeText("@")
        XCTAssertTrue(app.descendants(matching: .any)["mention.picker"].waitForExistence(timeout: 5), "buscador de menciones")
        shot("13-sidechat-mencion")
        let pick = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND identifier != %@", "mention.pick.", "mention.pick.all")).firstMatch
        XCTAssertTrue(pick.waitForExistence(timeout: 3))
        pick.tap()
        field.typeText("¿llegas a tiempo? 😀 ")
        field.typeText(XCUIKeyboardKey.delete.rawValue)
        field.typeText("é @")
        if app.buttons["mention.pick.all"].waitForExistence(timeout: 3) { app.buttons["mention.pick.all"].tap() }
        // Retroceso sobre el token recién puesto: se borra entero.
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 3))
        field.typeText("ñ@Br")
        sleep(1)
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 40))
        field.typeText("@")
        sleep(1)
        XCTAssertTrue(app.state == .runningForeground, "la app sigue viva")
        shot("14-sidechat-mencion-despues")
    }
}
