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
        var orgA: String
        var pagosId: String
        var ventasId: String
        var joinCode: String
        /// Grupo general de la relación con un hilo colgando de un mensaje (fixtures nuevos).
        var generalId: String?
        var threadId: String?
        /// Asunto vencido de «Pagos» (fixtures nuevos).
        var overdueIssue: String?
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

    private func login(_ f: Fixture) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES",
                               "-AppleLanguages", "(es)", "-AppleLocale", "es_CO"]
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
        XCTAssertTrue(app.buttons["home.section.mine"].exists)
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
        app.buttons["home.newGroup"].tap()
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
        XCTAssertTrue(ventas.waitForExistence(timeout: 8))
        shot("07-supervision")
        ventas.tap()
        XCTAssertTrue(app.descendants(matching: .any)["ovs.banner"].waitForExistence(timeout: 8), "franja de solo lectura")
        XCTAssertFalse(app.textViews["composer.field"].exists, "sin compositor")
        sleep(1)
        shot("08-solo-lectura")
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
        // Punto de partida: todo contraído desde el menú «…».
        app.buttons["home.more"].tap()
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
        app.buttons["home.more"].tap()
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
        XCTAssertTrue(app.buttons["grp.moreIssues.\(f.pagosId)"].waitForExistence(timeout: 5), "reabierto: vuelve bajo el grupo")
        // Deja el estado por defecto para las demás pruebas.
        app.buttons["home.more"].tap()
        app.buttons["home.fold.hideIssues"].tap()
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
