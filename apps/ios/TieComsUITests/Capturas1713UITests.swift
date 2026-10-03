import XCTest

/// 1.7.13 en el simulador (nunca en los de Danny): menú de reacciones con «＋» visible, gg abajo como píldora (cabecera
/// sin gg), la ✕ que la esconde, ⋯ › Preguntar a gg, la ✨ en el «＋» y la pantalla de Tareas por fecha.
/// Fixture: grupos-fixture.mjs + directos con Bruno (descansando) y Carlos y tareas con fechas.
/// `TEST_RUNNER_TC_FIXTURE_1713=<fx.json> TEST_RUNNER_TC_SHOTS=<carpeta> [TEST_RUNNER_TC_SHOT_SUFFIX=-oscuro]`.
final class Capturas1713UITests: XCTestCase {
    struct Fixture: Decodable {
        struct P: Decodable { var email: String; var id: String }
        var apiUrl: String; var password: String; var a: P; var b: P; var generalId: String; var dmBrunoId: String; var pagosId: String
    }

    override func setUp() { continueAfterFailure = true }

    private var suffix: String { ProcessInfo.processInfo.environment["TC_SHOT_SUFFIX"] ?? "" }

    private func fixture() throws -> Fixture {
        guard let path = ProcessInfo.processInfo.environment["TC_FIXTURE_1713"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE_1713") }
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        guard f.apiUrl.contains("localhost") || f.apiUrl.contains("127.0.0.1") else { throw XCTSkip("solo API local") }
        return f
    }

    private func shot(_ name: String) {
        let s = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: s); a.name = name + suffix; a.lifetime = .keepAlways; add(a)
        if let dir = ProcessInfo.processInfo.environment["TC_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name)\(suffix).png"))
        }
    }

    private func login(_ f: Fixture) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES",
                               "-AppleLanguages", "(es)", "-AppleLocale", "es_CO", "-TCNoAnimations", "YES"]
        app.launch()
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 15))
        email.tap(); email.typeText(f.a.email)
        let pw = app.secureTextFields["login.password"]
        pw.tap(); pw.typeText(f.password)
        app.buttons["login.submit"].tap()
        let until = Date().addingTimeInterval(20)
        while Date() < until && !app.buttons["tab.home"].exists {
            for l in ["Not Now", "Ahora no", "push.later"] where app.buttons[l].exists { app.buttons[l].tap() }
            usleep(300_000)
        }
        if app.buttons["push.later"].waitForExistence(timeout: 3) { app.buttons["push.later"].tap() }
        return app
    }

    /// La barra de pestañas propia: se toca hasta que quede elegida (la hoja de notificaciones puede llegar tarde).
    private func selectTab(_ app: XCUIApplication, _ id: String) {
        let b = app.buttons[id]
        _ = b.waitForExistence(timeout: 10)
        for _ in 0..<5 where !b.isSelected {
            if app.buttons["push.later"].exists { app.buttons["push.later"].tap() }
            b.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4)).tap()
            sleep(1)
        }
    }

    private func openChat(_ app: XCUIApplication, _ id: String) {
        for tab in ["tab.dms", "tab.home"] {
            selectTab(app, tab)
            if app.buttons["conv.row.\(id)"].waitForExistence(timeout: 5) { break }
        }
        app.buttons["conv.row.\(id)"].tap()
    }

    func test1ChatGgAbajoYReacciones() throws {
        let f = try fixture()
        let app = login(f)
        openChat(app, f.dmBrunoId)
        let pill = app.buttons["chat.gg"]
        XCTAssertTrue(pill.waitForExistence(timeout: 15), "píldora gg abajo")
        sleep(2)
        let header = app.descendants(matching: .any)["chat.header"]
        XCTAssertGreaterThan(pill.frame.minY, header.frame.maxY + 100, "gg abajo, no en la cabecera")
        XCTAssertTrue(app.buttons["gg.pill.hide"].exists, "✕ de la píldora")
        XCTAssertFalse(app.buttons["composer.ggReplies"].exists, "sin ✨ suelta en la barra")
        shot("01-chat-gg-abajo")

        // Mantener presionado un mensaje: 5 emojis y el «＋» visibles sin scroll.
        let msgs = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "cotización de Nestlé"))
        let msg = msgs.allElementsBoundByIndex.first(where: \.isHittable) ?? msgs.firstMatch
        msg.press(forDuration: 1.2)
        let more = app.buttons["react.quick.more"]
        XCTAssertTrue(more.waitForExistence(timeout: 5))
        XCTAssertTrue(more.isHittable, "«＋» visible sin hacer scroll")
        XCTAssertLessThanOrEqual(more.frame.maxX, app.frame.width, "«＋» dentro de la pantalla: \(more.frame)")
        sleep(1)
        shot("02-menu-reacciones")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
        sleep(1)

        // ✨ Ideas de respuesta, ahora en el «＋».
        app.buttons["composer.attach"].tap()
        sleep(1)
        shot("03-mas-con-ideas-gg")
        XCTAssertTrue(app.buttons["composer.ggReplies"].exists, "✨ ideas de respuesta en el «＋»")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
        sleep(1)

        // La ✕ la esconde en este chat; ⋯ › Preguntar a gg sigue ahí.
        app.buttons["gg.pill.hide"].tap()
        sleep(1)
        XCTAssertFalse(app.buttons["chat.gg"].exists, "píldora escondida")
        shot("04-chat-sin-pildora")
        app.buttons["chat.menu"].tap()
        XCTAssertTrue(app.buttons["chat.menu.gg"].waitForExistence(timeout: 4), "⋯ › Preguntar a gg")
        sleep(1)
        shot("05-menu-preguntar-a-gg")
        app.buttons["chat.menu.ggShowPill"].tap()
        XCTAssertTrue(app.buttons["chat.gg"].waitForExistence(timeout: 4), "se vuelve a mostrar")

        // Grupo: la misma píldora; la cabecera solo con 📞 · 🔎 · ⋯.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        selectTab(app, "tab.home")
        let pagos = app.buttons["conv.row.\(f.pagosId)"]
        for _ in 0..<4 where !(pagos.exists && pagos.isHittable) { app.swipeUp() }
        pagos.tap()
        XCTAssertTrue(app.buttons["chat.gg"].waitForExistence(timeout: 10))
        sleep(2)
        shot("06-grupo-gg-abajo")
    }

    func test2Tareas() throws {
        let f = try fixture()
        let app = login(f)
        selectTab(app, "tab.issues")
        let seg = app.segmentedControls["issues.filter"]
        XCTAssertTrue(seg.waitForExistence(timeout: 10))
        XCTAssertTrue(seg.buttons.element(boundBy: 0).label.hasPrefix("Mías"))
        let overdue = app.descendants(matching: .any)["issues.section.due.overdue"]
        XCTAssertTrue(overdue.waitForExistence(timeout: 10), "Vencidas")
        sleep(2)
        shot("10-tareas-mias")
        seg.buttons.element(boundBy: 1).tap()
        sleep(1)
        shot("11-tareas-abiertas")
        app.buttons["issues.groupBy"].tap()
        sleep(1)
        shot("12-tareas-menu-orden")
        if app.buttons["Por grupo"].exists { app.buttons["Por grupo"].tap() }
        sleep(1)
        shot("13-tareas-por-grupo")
        app.buttons["issues.groupBy"].tap()
        if app.buttons["Por fecha"].waitForExistence(timeout: 3) { app.buttons["Por fecha"].tap() }
        seg.buttons.element(boundBy: 2).tap()
        sleep(1)
        shot("14-tareas-hechas-vacio")
        seg.buttons.element(boundBy: 0).tap()
    }

    /// Cambiar responsable y fecha desde la lista (mantener presionado) y los campos en el detalle.
    func test3EditarTarea() throws {
        let f = try fixture()
        let app = login(f)
        selectTab(app, "tab.issues")
        let seg = app.segmentedControls["issues.filter"]
        XCTAssertTrue(seg.waitForExistence(timeout: 10))
        func row(_ title: String) -> XCUIElement {
            app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'issue.row.' AND label CONTAINS %@", title)).firstMatch
        }
        let r = row("Renovar el dominio")
        for _ in 0..<4 where !(r.exists && r.isHittable) { app.swipeUp() }
        r.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["issue.menu.owner"].waitForExistence(timeout: 5), "Cambiar responsable")
        shot("20-tarea-menu")
        app.buttons["issue.menu.owner"].tap()
        let bruno = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Carlos'")).firstMatch
        XCTAssertTrue(bruno.waitForExistence(timeout: 5))
        shot("21-tarea-cambiar-responsable")
        bruno.tap()
        sleep(2)
        // Ya no es mía: se ve en Abiertas con el avatar de Carlos.
        for _ in 0..<4 where !(seg.exists && seg.isHittable) { app.swipeDown() }
        seg.buttons.element(boundBy: 1).tap()
        sleep(1)
        let r2 = row("Renovar el dominio")
        for _ in 0..<4 where !(r2.exists && r2.isHittable) { app.swipeUp() }
        r2.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["issue.menu.due"].waitForExistence(timeout: 5), "Cambiar fecha")
        app.buttons["issue.menu.due"].tap()
        let tomorrow = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Mañana'")).firstMatch
        XCTAssertTrue(tomorrow.waitForExistence(timeout: 5))
        shot("22-tarea-cambiar-fecha")
        tomorrow.tap()
        sleep(2)
        shot("23-tarea-movida-a-esta-semana")
        // Detalle: campos del grupo (Prioridad, Horas, Facturable).
        let r3 = row("Renovar el dominio")
        for _ in 0..<4 where !(r3.exists && r3.isHittable) { app.swipeUp() }
        r3.tap()
        let fields = app.descendants(matching: .any)["issue.fields"]
        for _ in 0..<4 where !fields.exists { app.swipeUp() }
        XCTAssertTrue(fields.waitForExistence(timeout: 8), "campos del grupo")
        app.swipeUp()
        let prio = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Sin valor'")).firstMatch
        XCTAssertTrue(prio.waitForExistence(timeout: 3), "lista Prioridad")
        prio.tap()
        let alta = app.buttons["Alta"]
        XCTAssertTrue(alta.waitForExistence(timeout: 3), "opciones de la lista")
        alta.tap()
        sleep(2)
        shot("24-tarea-detalle-campos")
    }

    /// Compartir desde Fotos con 2 directos: botón grande abajo, «Enviar por separado» y «Enviar en un grupo».
    /// Antes: `xcrun simctl addmedia <sim> foto.png`. No envía nada.
    func test4CompartirDosDirectos() throws {
        struct F: Decodable { var dmCarlosId: String }
        let f = try fixture()
        let extra = try JSONDecoder().decode(F.self, from: Data(contentsOf: URL(fileURLWithPath: ProcessInfo.processInfo.environment["TC_FIXTURE_1713"]!)))
        let app = login(f)
        selectTab(app, "tab.dms")
        sleep(2)   // la app deja los destinos (con la persona de cada directo) en el App Group
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let photos = XCUIApplication(bundleIdentifier: "com.apple.mobileslideshow")
        photos.launch()
        // «Novedades en Fotos» y otros avisos del primer arranque.
        for _ in 0..<6 {
            sleep(1)
            for l in ["Not Now", "Ahora no", "Continue", "Continuar"] where photos.buttons[l].exists && photos.buttons[l].isHittable { photos.buttons[l].tap() }
        }
        let shareQ = NSPredicate(format: "label == 'Share' OR label == 'Compartir' OR identifier == 'Share'")
        if photos.buttons.matching(shareQ).firstMatch.waitForExistence(timeout: 3) {
            let back = photos.navigationBars.buttons.firstMatch
            if back.exists { back.tap(); sleep(1) }
        }
        let imgs = photos.images.allElementsBoundByIndex.filter { $0.frame.width > 60 && $0.frame.width < 200 }
        if let last = imgs.max(by: { ($0.frame.minY, $0.frame.minX) < ($1.frame.minY, $1.frame.minX) }) { last.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
        else { photos.coordinate(withNormalizedOffset: CGVector(dx: 0.17, dy: 0.515)).tap() }
        sleep(1)
        let share = photos.buttons.matching(shareQ).firstMatch
        XCTAssertTrue(share.waitForExistence(timeout: 8))
        share.tap()
        sleep(2)
        // iOS 26: la hoja puede abrir con «No Items Selected»; se marca la foto visible.
        let chagguApp = NSPredicate(format: "label == 'chaggu'")
        if ![photos, springboard].contains(where: { $0.buttons.matching(chagguApp).firstMatch.exists }) {
            photos.coordinate(withNormalizedOffset: CGVector(dx: 0.23, dy: 0.565)).tap()
            sleep(2)
        }
        shot("29-hoja-compartir")
        let tie = [photos, springboard].map { $0.buttons.matching(NSPredicate(format: "label == 'chaggu'")).firstMatch }.first { $0.exists }
        // iOS 26.1: chaggu es el segundo ícono de la fila de apps (captura 29).
        if let tie { tie.tap() } else { photos.coordinate(withNormalizedOffset: CGVector(dx: 0.387, dy: 0.68)).tap() }
        let ext = XCUIApplication(bundleIdentifier: "com.chaggu.app.share")
        func q(_ id: String) -> XCUIElement {
            for surface in [photos, ext, springboard] { let e = surface.descendants(matching: .any)[id]; if e.exists { return e } }
            return photos.descendants(matching: .any)[id]
        }
        var waited = 0
        while !q("share.target.\(f.dmBrunoId)").exists && waited < 40 { usleep(500_000); waited += 1 }
        shot("30-compartir-sin-eleccion")
        q("share.target.\(f.dmBrunoId)").tap()
        sleep(1)
        shot("31-compartir-uno")
        // Bruno y Carlos son los dos chats más recientes del fixture (scripts de la sesión): ambos a la vista.
        q("share.target.\(extra.dmCarlosId)").tap()
        sleep(1)
        XCTAssertTrue(q("share.sendGroup").exists, "dos directos: «Enviar en un grupo»")
        XCTAssertTrue(q("share.send").exists, "«Enviar por separado»")
        shot("32-compartir-dos-directos")
        // «Enviar en un grupo» (solo contra el API local): crea o retoma el chat de Ana, Bruno y Carlos y envía una vez.
        q("share.comment").tap(); q("share.comment").typeText("Para los dos")
        q("share.sendGroup").tap()
        sleep(5)
        shot("33-compartir-enviado-al-grupo")
    }

    /// Reaccionar a una tarjeta de tarea (aviso issue.created): barra con «＋» arriba del menú y chips debajo.
    func test5ReaccionarTarjeta() throws {
        let f = try fixture()
        let app = login(f)
        openChat(app, f.dmBrunoId)
        let card = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'msg.taskCard.'")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 15), "tarjeta de tarea")
        sleep(1)
        let title = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'taskCard.title.'")).firstMatch
        (title.exists ? title : card).press(forDuration: 1.2)
        let thumbs = app.buttons["react.quick.0"]
        XCTAssertTrue(thumbs.waitForExistence(timeout: 5), "barra de reacciones en la tarjeta")
        XCTAssertTrue(app.buttons["react.quick.more"].isHittable, "«＋» visible")
        sleep(1)
        shot("40-tarjeta-menu-reacciones")
        thumbs.tap()
        let chips = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'card.reactions.'")).firstMatch
        XCTAssertTrue(chips.waitForExistence(timeout: 8), "👍 debajo de la tarjeta")
        sleep(2)
        shot("41-tarjeta-con-reaccion")
    }
}
