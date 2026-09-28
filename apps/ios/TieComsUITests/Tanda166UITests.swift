import XCTest

/// 1.6.6 en la interfaz contra el API de PRUEBAS local: pendientes del árbol, asuntos compactos y personales,
/// reuniones (proveedor MOCK) y calendario Día / Semana / Mes.
///
/// Fixture: `tools/fixtures/tanda166-fixture.mjs` por `TEST_RUNNER_TC_FIXTURE166`; capturas con `TEST_RUNNER_TC_SHOTS=/dir`.
final class Tanda166UITests: XCTestCase {
    struct Fixture: Decodable {
        struct Person: Decodable { var email: String; var id: String; var name: String? }
        var apiUrl: String
        var password: String
        var a: Person
        var b: Person
        var generalId: String
        var diagId: String
        var decisionId: String
        var longId: String
        var sharedIssueId: String
        var personalIssueId: String
        var eventIds: [String]
    }

    override func setUp() { continueAfterFailure = false }

    func fixture() throws -> Fixture {
        guard let path = ProcessInfo.processInfo.environment["TC_FIXTURE166"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE166") }
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        XCTAssertFalse(f.apiUrl.contains("app.chaggu.com") || f.apiUrl.contains("app.tiecoms.com"), "no se prueba contra producción")
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

    func login(_ f: Fixture, lang: String = "es", extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES",
                               "-AppleLanguages", "(\(lang))", "-AppleLocale", lang == "es" ? "es_CO" : "en_US", "-TCResetLanguage", "YES"] + extra
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

    /// Espera la lista de Grupos (la sesión ya cargó) y cambia de pestaña.
    func tab(_ app: XCUIApplication, _ label: String, _ f: Fixture) {
        XCTAssertTrue(waitFor(app.buttons["conv.row.\(f.generalId)"], 20, app), "sesión lista")
        let b = app.tabBars.buttons[label]
        XCTAssertTrue(b.waitForExistence(timeout: 5), "pestaña \(label): \(app.tabBars.buttons.allElementsBoundByIndex.map(\.label))")
        b.tap()
    }

    func back(_ app: XCUIApplication) { app.navigationBars.buttons.element(boundBy: 0).tap() }

    func waitFor(_ el: XCUIElement, _ timeout: TimeInterval = 10, _ app: XCUIApplication) -> Bool {
        let until = Date().addingTimeInterval(timeout)
        while Date() < until { if el.exists { return true }; dismissSystemPrompts(app); usleep(300_000) }
        return el.exists
    }

    // MARK: 1. Pendientes del árbol

    func test1TreePendingChipStripSheetAndMarkRead() throws {
        let f = try fixture()
        let app = login(f)
        let row = app.buttons["conv.row.\(f.generalId)"]
        XCTAssertTrue(waitFor(row, 20, app), "fila de General")
        if app.buttons["home.tab.all"].exists { app.buttons["home.tab.all"].tap() }
        let seg = app.segmentedControls["grp.viewMode"]
        if seg.exists { seg.buttons["Lista"].tap() }
        // General está leído, pero sus dos derivadas suman 11: la fila lo dice con «⑂ 11».
        XCTAssertTrue(row.label.contains("11 sin leer en hilos y ramas"), row.label)
        XCTAssertTrue(app.buttons["home.tab.unread"].label.hasSuffix(", 2"), "«No leídos» ya no dice 0: \(app.buttons["home.tab.unread"].label)")
        XCTAssertTrue(app.buttons["home.tab.mentions"].label.hasSuffix(", 2"), "la mención antigua del hilo cuenta: \(app.buttons["home.tab.mentions"].label)")
        shot("1-01-arbol-chip-lista")

        // En el chat: la franja y la lista de derivadas.
        row.tap()
        let strip = app.buttons["chat.treeStrip"]
        XCTAssertTrue(strip.waitForExistence(timeout: 10), "franja «⑂ 11 sin leer en 2 conversaciones de este grupo · Ver»")
        XCTAssertTrue(strip.label.contains("11 sin leer en 2 conversaciones de este grupo"), strip.label)
        shot("1-02-arbol-franja")
        strip.tap()
        XCTAssertTrue(app.buttons["tree.item.\(f.decisionId)"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["tree.item.\(f.diagId)"].exists)
        shot("1-03-arbol-lista-derivadas")
        // Cada una lleva a su conversación; abrir la interna no marca las demás.
        app.buttons["tree.item.\(f.diagId)"].tap()
        sleep(2)
        shot("1-04-arbol-abre-derivada")
        // Un hilo se abre al lado (hoja en iPhone): se cierra con la X y se vuelve a Grupos.
        if app.buttons["side.close"].waitForExistence(timeout: 3) { app.buttons["side.close"].tap(); sleep(1) }
        if app.navigationBars.buttons.count > 0 && !app.buttons["home.tab.all"].exists { back(app) }

        // Menú de la fila: «Marcar como leído» (read-tree); después ofrece «Marcar como no leído».
        XCTAssertTrue(row.waitForExistence(timeout: 8))
        row.press(forDuration: 1.2)
        let markRead = app.buttons["menu.markRead"]
        XCTAssertTrue(markRead.waitForExistence(timeout: 4), "«Marcar como leído» en la fila de un grupo leído con derivadas pendientes")
        markRead.tap()
        let until = Date().addingTimeInterval(8)
        while Date() < until && row.label.contains("hilos y ramas") { usleep(300_000) }
        XCTAssertFalse(row.label.contains("hilos y ramas"), "sin chip tras marcar: \(row.label)")
        XCTAssertTrue(app.buttons["home.tab.unread"].label.hasSuffix(", 1"), "solo queda la Cohorte larga: \(app.buttons["home.tab.unread"].label)")
        shot("1-05-arbol-marcado-leido")
        row.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["menu.markUnread"].waitForExistence(timeout: 4), "ya leído: «Marcar como no leído»")
        shot("1-05b-arbol-menu-no-leido")
        // Cerrar el menú tocando fuera (arriba, sobre el fondo atenuado).
        for _ in 0..<3 where app.buttons["menu.markUnread"].exists { app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.2)).tap(); sleep(1) }

        // Chat largo paginado: abrir en el primer no leído y salir sin recorrerlo no lo marca todo.
        let long = app.buttons["conv.row.\(f.longId)"]
        XCTAssertTrue(long.waitForExistence(timeout: 5))
        XCTAssertTrue(long.label.contains("40 sin leer"), long.label)
        long.tap()
        sleep(4)
        shot("1-06-chat-largo-primer-no-leido")
        back(app)
        XCTAssertTrue(long.waitForExistence(timeout: 5))
        sleep(1)
        XCTAssertTrue(long.label.contains("sin leer"), "lo que no se vio sigue sin leer: \(long.label)")
        XCTAssertFalse(long.label.contains("40 sin leer"), "lo visto sí avanzó: \(long.label)")
        shot("1-07-chat-largo-sigue-pendiente")
    }

    // MARK: 2. Asuntos compactos

    func test2SubjectsWithoutExplanatoryParagraph() throws {
        let f = try fixture()
        let app = login(f)
        tab(app, "Asuntos", f)
        let filter = app.segmentedControls["issues.filter"]
        XCTAssertTrue(filter.waitForExistence(timeout: 8))
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Lo que quedó pendiente")).firstMatch.exists, "sin el párrafo issue.pageSub")
        XCTAssertTrue(app.segmentedControls["issues.groupBy"].exists, "Por grupo / Por responsable se conservan")
        // Los filtros quedan pegados al título: arriba de la primera cuarta parte de la pantalla.
        XCTAssertLessThan(filter.frame.minY, app.frame.height * 0.3, "filtros cerca del título: \(filter.frame)")
        shot("2-01-asuntos-compactos")
    }

    // MARK: 3. Asuntos personales

    func test3PersonalSubjectCreateSectionAndDetail() throws {
        let f = try fixture()
        let app = login(f)
        tab(app, "Asuntos", f)
        // La sección «Personal · solo tú» con el asunto del fixture, 🔒 en la fila.
        let section = app.staticTexts["issues.section.__personal"]
        let found = section.waitForExistence(timeout: 15)
        XCTAssertTrue(found, "sección Personal · solo tú")
        XCTAssertTrue(section.label.contains("Personal · solo tú"), section.label)
        let row = app.buttons["issue.row.\(f.personalIssueId)"]
        XCTAssertTrue(row.exists)
        XCTAssertTrue(row.label.contains("🔒") || (row.value as? String)?.contains("Personal") == true, row.label)

        // Alta rápida: sin chat, la primera opción de «¿Dónde?» es «🔒 Personal · solo tú».
        let field = app.textFields["issue.quickField"]
        field.tap(); field.typeText("Revisar mi plan de carrera")
        XCTAssertTrue(app.buttons["issue.quickWhere"].waitForExistence(timeout: 3))
        let whereValue = app.buttons["issue.quickWhere"].value as? String ?? ""
        XCTAssertTrue(whereValue.contains("Personal"), "por defecto, Personal: \(whereValue)")
        XCTAssertFalse(app.buttons["issue.quickOwner"].exists, "un personal no elige responsable")
        shot("3-01-personal-alta-rapida")
        app.buttons["issue.quickWhere"].tap()
        sleep(1)
        shot("3-02-personal-donde-primera-opcion")
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Personal · solo tú")).firstMatch.tap()
        app.buttons["issue.quickAdd"].tap()
        let created = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Revisar mi plan de carrera")).firstMatch
        XCTAssertTrue(created.waitForExistence(timeout: 8))
        if app.keyboards.count > 0 { app.swipeDown() }
        shot("3-03-personal-seccion-por-grupo")

        // Detalle: sin «¿Quién lo hace?», sin tareas ni sidechat.
        row.tap()
        XCTAssertTrue(app.textViews["issue.titleEdit"].waitForExistence(timeout: 6) || app.textFields["issue.titleEdit"].exists)
        XCTAssertFalse(app.staticTexts["¿Quién lo hace?"].exists)
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "issue.who.")).firstMatch.exists)
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "task.")).firstMatch.exists, "sin tareas")
        XCTAssertTrue(app.buttons["issue.markDone"].exists)
        shot("3-04-personal-detalle")
        back(app)
        // Pulsación larga: sin «Tarea derivada» ni «Hablar aparte».
        row.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["issue.menu.complete"].waitForExistence(timeout: 4))
        XCTAssertFalse(app.buttons["issue.menu.addTask"].exists)
        XCTAssertFalse(app.buttons["issue.menu.sidechat"].exists)
        shot("3-05-personal-menu")
    }

    // MARK: 4. Reuniones (proveedor MOCK; no demuestra OAuth real)

    /// Acepta la alerta del sistema de ASWebAuthenticationSession («… quiere usar “localhost” para iniciar sesión»).
    func acceptWebAuthAlert() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let b = springboard.buttons.matching(NSPredicate(format: "label IN %@", ["Continuar", "Continue"])).firstMatch
        if b.waitForExistence(timeout: 8) { b.tap() }
    }

    func test4MeetingDialogConnectCreateShareAndSettings() throws {
        let f = try fixture()
        let app = login(f)
        let row = app.buttons["conv.row.\(f.generalId)"]
        XCTAssertTrue(waitFor(row, 20, app))
        sleep(1)
        row.tap()
        let plus = app.buttons["composer.attach"]
        XCTAssertTrue(plus.waitForExistence(timeout: 10))
        plus.tap()
        XCTAssertTrue(app.buttons["composer.plus.meetNow"].waitForExistence(timeout: 4), "«📹 Reunión ahora» en el ＋")
        XCTAssertTrue(app.buttons["composer.plus.meetSchedule"].exists, "«📅 Agendar reunión con enlace»")
        shot("4-01-menu-mas-reuniones")
        app.buttons["composer.plus.meetNow"].tap()

        // Chips con su estado: Zoom sin app OAuth en este servidor → «No disponible» con el motivo, sin botón.
        let zoom = app.buttons["meet.chip.zoom"]
        XCTAssertTrue(zoom.waitForExistence(timeout: 8))
        XCTAssertTrue(zoom.label.contains("No disponible"), zoom.label)
        zoom.tap()
        sleep(1)
        shot("4-02-dialogo-zoom-no-disponible")
        let reason = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "OAuth")).firstMatch
        XCTAssertTrue(reason.waitForExistence(timeout: 3), "se explica el motivo (unavailableReason)")
        XCTAssertFalse(app.buttons["meet.create"].isEnabled, "sin botón que no funciona")

        // Google (MOCK): Conectar con ASWebAuthenticationSession y vuelta por chaggu://meetings/connected.
        let google = app.buttons["meet.chip.google"]
        google.tap()
        XCTAssertTrue(google.label.contains("Conectar"), google.label)
        XCTAssertTrue(app.buttons["meet.connect.google"].waitForExistence(timeout: 3))
        app.buttons["meet.connect.google"].tap()
        acceptWebAuthAlert()
        let until = Date().addingTimeInterval(20)
        while Date() < until && !google.label.contains("mock.google@example.com") { usleep(500_000) }
        XCTAssertTrue(google.label.contains("mock.google@example.com"), "conectado (MOCK): \(google.label)")
        XCTAssertEqual(app.segmentedControls["meet.when"].buttons["Ahora"].isSelected, true)
        shot("4-03-dialogo-google-conectado-mock")

        // Crear y compartir: el enlace que devolvió el proveedor (MOCK), «Abrir en Meet» y «Copiar».
        app.buttons["meet.create"].tap()
        let link = app.staticTexts["meet.link"]
        XCTAssertTrue(link.waitForExistence(timeout: 15))
        XCTAssertTrue(link.label.hasPrefix("https://meet.google.com/mock-"), link.label)
        XCTAssertTrue(app.buttons["meet.open"].label.contains("Abrir en Meet"))
        XCTAssertTrue(app.buttons["meet.copy"].exists)
        shot("4-04-reunion-creada-mock")
        app.buttons["meet.copy"].tap()
        app.buttons["Cerrar"].firstMatch.tap()
        let msg = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "meet.google.com/mock-")).firstMatch
        XCTAssertTrue(msg.waitForExistence(timeout: 10), "el mensaje con el enlace real quedó en el chat")
        shot("4-05-mensaje-en-el-chat-mock")

        // Agendar: fecha y hora, duración y título.
        plus.tap()
        XCTAssertTrue(app.buttons["composer.plus.meetSchedule"].waitForExistence(timeout: 4))
        app.buttons["composer.plus.meetSchedule"].tap()
        XCTAssertTrue(app.datePickers["meet.startsAt"].waitForExistence(timeout: 6), "fecha y hora")
        XCTAssertTrue(app.segmentedControls["meet.duration"].buttons["45 min"].exists)
        app.segmentedControls["meet.duration"].buttons["45 min"].tap()
        shot("4-06-agendar-reunion")
        app.buttons["Cancelar"].firstMatch.tap()

        // Ajustes › Reuniones: Desconectar Google, Conectar Teams, Zoom no disponible.
        back(app)
        tab(app, "Tú", f)
        let g = app.buttons["meet.settings.disconnect.google"]
        for _ in 0..<6 where !g.exists { app.swipeUp() }
        XCTAssertTrue(g.waitForExistence(timeout: 5), "Desconectar Google")
        XCTAssertTrue(app.buttons["meet.settings.connect.microsoft"].exists, "Conectar Teams")
        shot("4-07-ajustes-reuniones-mock")
    }

    // MARK: 5. Calendario Día / Semana / Mes

    func test5CalendarDayWeekMonthAndLargeText() throws {
        let f = try fixture()
        let app = login(f)
        tab(app, "Calendario", f)
        let mode = app.segmentedControls["cal.mode"]
        XCTAssertTrue(mode.waitForExistence(timeout: 8))
        XCTAssertTrue(mode.buttons["Semana"].isSelected, "Semana por defecto")
        XCTAssertTrue(app.buttons["cal.today"].exists && app.buttons["cal.prev"].exists && app.buttons["cal.next"].exists, "‹ Hoy ›")
        let meet = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "📹 Llamada con Estudio Norte")).firstMatch
        XCTAssertTrue(meet.waitForExistence(timeout: 8), "la reunión con enlace de Meet lleva 📹")
        shot("5-01-calendario-semana")

        mode.buttons["Mes"].tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "cal.day.")).count == 42, "cuadrícula 6×7")
        let more = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "+")).firstMatch
        _ = more
        shot("5-02-calendario-mes")
        app.buttons["cal.next"].tap(); sleep(1)
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "cal.day.")).count, 42)
        shot("5-03-calendario-mes-siguiente")
        app.buttons["cal.today"].tap(); sleep(1)

        // Tocar un día abre la vista Día (el de hoy: tiene dos reuniones).
        let today = Date()
        let f2 = DateFormatter(); f2.dateFormat = "yyyy-MM-dd"; f2.locale = Locale(identifier: "en_US_POSIX")
        app.buttons["cal.day.\(f2.string(from: today))"].tap()
        XCTAssertTrue(mode.buttons["Día"].waitForExistence(timeout: 3))
        XCTAssertTrue(mode.buttons["Día"].isSelected)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Revisión semanal")).firstMatch.waitForExistence(timeout: 5))
        shot("5-04-calendario-dia")
        // Crear desde un hueco: la hoja trae esa hora.
        let slot = app.buttons["cal.slot.17"]
        for _ in 0..<4 where !slot.isHittable { app.swipeUp() }
        slot.tap()
        XCTAssertTrue(app.textFields["event.titleField"].waitForExistence(timeout: 5), "crear desde el hueco")
        shot("5-05-calendario-crear-desde-hueco")
        app.buttons["Cancelar"].firstMatch.tap()

        // Recordado: al volver a abrir, sigue en la última vista (Día).
        app.terminate()
        let again = XCUIApplication()
        again.launchArguments = ["-TCApiURL", f.apiUrl, "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES", "-AppleLanguages", "(es)", "-AppleLocale", "es_CO"]
        again.launch()
        tab(again, "Calendario", f)
        XCTAssertTrue(again.segmentedControls["cal.mode"].buttons["Día"].waitForExistence(timeout: 8))
        XCTAssertTrue(again.segmentedControls["cal.mode"].buttons["Día"].isSelected, "la vista se recuerda en el dispositivo")
        again.segmentedControls["cal.mode"].buttons["Semana"].tap()
        again.terminate()
    }

    /// Texto «Máximo» (tamaño de accesibilidad): el mes muestra puntos, los títulos se cortan sin desbordar.
    func test6CalendarMonthWithLargestText() throws {
        let f = try fixture()
        let app = login(f, extra: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        tab(app, "Calendario", f)
        let mode = app.segmentedControls["cal.mode"]
        XCTAssertTrue(mode.waitForExistence(timeout: 8))
        shot("5-06-calendario-semana-texto-maximo")
        mode.buttons["Mes"].tap()
        sleep(1)
        let cells = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "cal.day."))
        XCTAssertEqual(cells.count, 42)
        let w = app.frame.width
        for i in [0, 6, 41] { let fr = cells.element(boundBy: i).frame; XCTAssertTrue(fr.minX >= -1 && fr.maxX <= w + 1, "sin desbordar: \(fr)") }
        shot("5-07-calendario-mes-texto-maximo")
        mode.buttons["Semana"].tap()
    }
}

extension Tanda166UITests {
    /// Synthetic local group owned by A, with B as an ordinary member. No external invitations or provider calls.
    func test7GroupAdminConfirmationAndBadge() throws {
        let f = try fixture()
        guard let name = f.b.name else { throw XCTSkip("Admin UI fixture requires a named synthetic member") }
        let app = login(f)
        defer { app.terminate() }
        let row = app.buttons["conv.row.\(f.generalId)"]
        XCTAssertTrue(waitFor(row, 20, app))
        row.tap()
        let header = app.buttons["chat.header"]
        XCTAssertTrue(header.waitForExistence(timeout: 8))
        header.tap()
        let member = app.staticTexts[name]
        for _ in 0..<5 where !member.exists || !member.isHittable { app.swipeUp() }
        XCTAssertTrue(member.waitForExistence(timeout: 3))
        let badge = app.staticTexts["person.badge.\(f.b.id)"]
        XCTAssertFalse(badge.exists, "the synthetic member starts without admin rights")
        member.press(forDuration: 1.1)
        let make = app.buttons["person.makeAdmin.\(f.b.id)"]
        XCTAssertTrue(make.waitForExistence(timeout: 5))
        shot("admins-01-member-menu")
        make.tap()
        let confirm = app.buttons["person.confirm.makeAdmin"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        shot("admins-02-explicit-confirmation")
        if app.buttons["Cancelar"].exists { app.buttons["Cancelar"].firstMatch.tap() }
        else { app.navigationBars.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
        XCTAssertFalse(badge.exists, "cancelling the confirmation does not promote anyone")
        member.press(forDuration: 1.1)
        XCTAssertTrue(make.waitForExistence(timeout: 5))
        make.tap()
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        XCTAssertTrue(badge.waitForExistence(timeout: 10))
        XCTAssertEqual(badge.label, "Admin")
        shot("admins-03-promoted-member")
        member.press(forDuration: 1.1)
        let remove = app.buttons["person.removeAdmin.\(f.b.id)"]
        XCTAssertTrue(remove.waitForExistence(timeout: 5))
        remove.tap()
        let confirmRemove = app.buttons["person.confirm.removeAdmin"].firstMatch
        XCTAssertTrue(confirmRemove.waitForExistence(timeout: 5))
        confirmRemove.tap()
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline && badge.exists { usleep(200_000) }
        XCTAssertFalse(badge.exists, "confirmed removal restores the member's original role")
        shot("admins-04-restored-member")
    }
}
