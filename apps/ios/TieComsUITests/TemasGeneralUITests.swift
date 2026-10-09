import XCTest

/// Temas con tres vistas (docs/TEMAS.md, 29-sep-2026): «💬 General» (así abre el chat, solo lo sin tema), «☰ Todo» (todo, con
/// su etiqueta) y un tema (solo lo suyo). Lo escrito en General va sin tema; saltar a un mensaje cambia al filtro de su tema.
///
/// Fixture: `tools/fixtures/temas-general-fixture.mjs` por `TEST_RUNNER_TC_FIXTURE_TEMAS_GENERAL`; capturas con `TEST_RUNNER_TC_SHOTS`.
final class TemasGeneralUITests: XCTestCase {
    struct Fixture: Decodable {
        struct Person: Decodable { var email: String; var id: String }
        var apiUrl: String
        var password: String
        var a: Person
        var conversationId: String
        struct Messages: Decodable { var extracto: String; var camion: String; var vemos: String }
        var messages: Messages?
    }

    override func setUp() { continueAfterFailure = false }

    func fixture() throws -> Fixture {
        guard let path = ProcessInfo.processInfo.environment["TC_FIXTURE_TEMAS_GENERAL"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE_TEMAS_GENERAL") }
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        XCTAssertFalse(f.apiUrl.contains("chaggu.com") || f.apiUrl.contains("tiecoms.com"), "no se prueba contra producción")
        return f
    }

    func shot(_ name: String) {
        let s = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: s); a.name = name; a.lifetime = .keepAlways; add(a)
        if let dir = ProcessInfo.processInfo.environment["TC_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    /// Toque que no falla si otra ventana tapa el botón para XCTest (se toca por coordenada).
    func tapC(_ e: XCUIElement) { if e.isHittable { e.tap() } else { e.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() } }

    func text(_ app: XCUIApplication, _ s: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", s)).firstMatch
    }

    func testGeneralAllAndTopicViews() throws {
        let f = try fixture()
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES",
                               "-AppleLanguages", "(es)", "-AppleLocale", "es_CO", "-TCResetLanguage", "YES", "-TCOpenConversation", f.conversationId]
        app.launch()
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 20))
        email.tap(); email.typeText(f.a.email)
        let pw = app.secureTextFields["login.password"]
        pw.tap(); pw.typeText(f.password)
        app.buttons["login.submit"].tap()
        let notNow = app.buttons.matching(NSPredicate(format: "label IN %@", ["Not Now", "Ahora no"])).firstMatch
        if notNow.waitForExistence(timeout: 5) { notNow.tap() }
        // -TCOpenConversation abre el chat; si no, se toca la fila (por coordenada: a veces otra ventana la tapa para XCTest).
        let general0 = app.buttons["topic.general"]
        let composer = app.descendants(matching: .any)["composer.field"]
        let opened = Date().addingTimeInterval(20)
        while Date() < opened && !general0.exists && !composer.exists { usleep(300_000) }
        if composer.exists { _ = general0.waitForExistence(timeout: 20) }
        if !general0.exists {
            if app.navigationBars.buttons.count > 0 && composer.exists { app.navigationBars.buttons.element(boundBy: 0).tap() }
            let row = app.buttons["conv.row.\(f.conversationId)"]
            XCTAssertTrue(row.waitForExistence(timeout: 25))
            for _ in 0..<3 where !general0.exists {
                row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                _ = general0.waitForExistence(timeout: 6)
            }
        }

        // El aviso del sistema «¿Guardar contraseña?» llega unos segundos después de entrar y tapa el chat: se cierra.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for _ in 0..<8 {
            for surface in [app, springboard] { for label in ["Not Now", "Ahora no"] where surface.buttons[label].exists { surface.buttons[label].tap() } }
            sleep(1)
        }
        // 1. (1.7.5) Abre en el tema del primer no leído: «Finanzas», en «Falta el extracto…».
        let general = app.buttons["topic.general"]
        XCTAssertTrue(general.waitForExistence(timeout: 10))
        let selected = NSPredicate(format: "isSelected == true")
        let fin0 = app.buttons["topic.flag.Finanzas"], ops0 = app.buttons["topic.flag.Operaciones"]
        expectation(for: selected, evaluatedWith: fin0); waitForExpectations(timeout: 10)
        XCTAssertTrue(text(app, "Falta el extracto de septiembre").waitForExistence(timeout: 8))
        XCTAssertFalse(text(app, "Nos vemos mañana en la oficina").exists, "filtrado en el tema")
        // Orden: General, Todo, luego los temas con no leídos. Leído Finanzas, Operaciones (sin leer) pasa adelante.
        XCTAssertLessThan(general.frame.maxX, app.buttons["topic.all"].frame.minX + 1)
        let reordered = Date().addingTimeInterval(12)
        while Date() < reordered && !(ops0.frame.minX < fin0.frame.minX) { usleep(300_000) }
        XCTAssertLessThan(ops0.frame.minX, fin0.frame.minX, "con no leídos primero: \(ops0.label) / \(fin0.label)")
        XCTAssertLessThan(app.buttons["topic.all"].frame.maxX, ops0.frame.minX + 1, "Todo sigue segunda")
        shot("temas-00-abre-en-tema")

        // «General»: solo lo sin tema, con su número de sin leer.
        tapC(general)
        expectation(for: selected, evaluatedWith: general); waitForExpectations(timeout: 8)
        XCTAssertTrue(general.label.hasPrefix("General"), general.label)
        XCTAssertTrue(general.label.contains("1 sin leer"), "sin leer sin tema: \(general.label)")
        XCTAssertTrue(text(app, "Nos vemos mañana en la oficina").waitForExistence(timeout: 8))
        XCTAssertTrue(text(app, "Hola Ana, ¿cómo vas?").exists)
        XCTAssertFalse(text(app, "Ya pagué la factura de agosto").exists, "con tema: no va en General")
        XCTAssertFalse(text(app, "Falta el extracto de septiembre").exists, "aunque no esté leído")
        XCTAssertFalse(text(app, "El camión llega el lunes").exists)
        shot("temas-01-general")

        // 2. «☰ Todo»: todo, con su etiqueta.
        let all = app.buttons["topic.all"]
        XCTAssertTrue(all.exists, "«Todo» aparece porque hay temas activos")
        tapC(all)
        XCTAssertTrue(text(app, "Falta el extracto de septiembre").waitForExistence(timeout: 5))
        XCTAssertTrue(text(app, "El camión llega el lunes").exists)
        XCTAssertTrue(text(app, "Nos vemos mañana en la oficina").exists)
        shot("temas-02-todo")

        // 3. Un tema: solo lo suyo; tocarlo otra vez vuelve a General.
        let fin = app.buttons["topic.flag.Finanzas"]
        // En «Todo» se lee todo: la fila vuelve al orden guardado (Finanzas antes de Operaciones). Se espera a que se
        // acomode antes de tocar (si no, el toque cae donde estaba la banderita).
        let settled = Date().addingTimeInterval(12)
        while Date() < settled && (ops0.label.contains("sin leer") || !(fin.frame.minX < ops0.frame.minX)) { usleep(300_000) }
        XCTAssertLessThan(fin.frame.minX, ops0.frame.minX, "leído: vuelve a su lugar")
        sleep(1)
        tapC(fin)
        XCTAssertTrue(text(app, "Falta el extracto de septiembre").waitForExistence(timeout: 5))
        XCTAssertFalse(text(app, "Nos vemos mañana en la oficina").exists)
        XCTAssertFalse(text(app, "El camión llega el lunes").exists)
        shot("temas-03-finanzas")
        tapC(fin)
        expectation(for: selected, evaluatedWith: general); waitForExpectations(timeout: 5)
        XCTAssertFalse(text(app, "Falta el extracto de septiembre").exists)

        // 4. Lo escrito en General va sin tema (se sigue viendo en General).
        let field = app.descendants(matching: .any)["composer.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        let mine = "Desde General \(Int(Date().timeIntervalSince1970) % 10000)"
        field.tap(); field.typeText(mine)
        app.buttons["composer.send"].tap()
        XCTAssertTrue(text(app, mine).waitForExistence(timeout: 10))
        XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", mine, "Tema:")).firstMatch.exists, "sin tema")

        // 5. Saltar a un mensaje con tema (búsqueda) cambia el filtro a su tema.
        app.buttons["chat.search"].tap()
        let search = app.textFields["chat.searchField"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap(); search.typeText("extracto de septiembre\n")
        expectation(for: selected, evaluatedWith: fin); waitForExpectations(timeout: 10)
        XCTAssertTrue(text(app, "Falta el extracto de septiembre").exists)
        shot("temas-04-salto-a-tema")
    }

    /// Fijas compactas (solo ícono si no están elegidas) y arrastrar una banderita para reordenar. Con un API sin
    /// PUT /topics/order (o si falla) vuelve el orden anterior y sale el aviso: así se prueba el gesto y la reversión.
    func testCompactFixedFlagsAndDragToReorder() throws {
        let f = try fixture()
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES",
                               "-AppleLanguages", "(es)", "-AppleLocale", "es_CO", "-TCResetLanguage", "YES", "-TCOpenConversation", f.conversationId]
        app.launch()
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 20))
        email.tap(); email.typeText(f.a.email)
        let pw = app.secureTextFields["login.password"]
        pw.tap(); pw.typeText(f.password)
        app.buttons["login.submit"].tap()
        let general = app.buttons["topic.general"]
        if !general.waitForExistence(timeout: 25) {
            let row = app.buttons["conv.row.\(f.conversationId)"]
            XCTAssertTrue(row.waitForExistence(timeout: 25))
            row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            XCTAssertTrue(general.waitForExistence(timeout: 10))
        }
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for _ in 0..<6 {
            for surface in [app, springboard] { for label in ["Not Now", "Ahora no"] where surface.buttons[label].exists { surface.buttons[label].tap() } }
            sleep(1)
        }
        // «General» elegida muestra su nombre; «Todo» sin elegir es solo ☰ (mismo alto que las demás sin elegir).
        let all = app.buttons["topic.all"]
        let fin = app.buttons["topic.flag.Finanzas"], ops = app.buttons["topic.flag.Operaciones"]
        XCTAssertTrue(fin.waitForExistence(timeout: 10) && ops.exists)
        // 1.7.5: los temas con no leídos van primero. Se lee todo en «Todo» para ver el orden guardado (de llegada).
        tapC(all)
        let allRead = Date().addingTimeInterval(15)
        while Date() < allRead && (fin.label.contains("sin leer") || ops.label.contains("sin leer")) { usleep(300_000) }
        XCTAssertFalse(fin.label.contains("sin leer") || ops.label.contains("sin leer"), "leído: \(fin.label) / \(ops.label)")
        tapC(app.buttons["topic.general"])
        sleep(1)
        XCTAssertEqual(all.label, "Todo", "accesibilidad con el nombre")
        XCTAssertLessThan(all.frame.width, general.frame.width, "compacta: solo el ícono")
        XCTAssertEqual(all.frame.height, fin.frame.height, accuracy: 1)
        XCTAssertLessThan(fin.frame.minX, ops.frame.minX, "orden de llegada: Finanzas primero")
        shot("temas-10-compactas")
        tapC(all)
        XCTAssertTrue(app.buttons["topic.all"].waitForExistence(timeout: 3))
        sleep(1)
        XCTAssertGreaterThan(app.buttons["topic.all"].frame.width, app.buttons["topic.general"].frame.width, "elegida: con su nombre")
        shot("temas-11-todo-elegida")
        tapC(app.buttons["topic.general"])
        sleep(1)

        // Mantener presionada Operaciones y soltarla sobre Finanzas.
        ops.press(forDuration: 1.2, thenDragTo: fin)
        let toast = app.descendants(matching: .any)["toast"]
        let moved = Date().addingTimeInterval(8)
        var sawToast = false
        while Date() < moved {
            if toast.exists { sawToast = true; break }
            if ops.frame.minX < fin.frame.minX { break }
            usleep(200_000)
        }
        shot("temas-12-arrastre")
        if sawToast {
            // Este API no tiene el endpoint: vuelve el orden de antes.
            sleep(1)
            XCTAssertLessThan(app.buttons["topic.flag.Finanzas"].frame.minX, app.buttons["topic.flag.Operaciones"].frame.minX, "revirtió")
        } else {
            XCTAssertLessThan(app.buttons["topic.flag.Operaciones"].frame.minX, app.buttons["topic.flag.Finanzas"].frame.minX, "reordenada")
        }
    }

    /// 1.7.5: tocar la burbuja / aviso de un mensaje (mismo camino que el push: `openMessage`) deja el chat en el tema
    /// del mensaje y en el mensaje, resaltado; un mensaje sin tema abre en «Todo». Antes quedaba siempre en «General».
    func testOpenFromBubbleLandsOnTopicAndMessage() throws {
        let f = try fixture()
        guard let ids = f.messages else { throw XCTSkip("Fixture sin ids de mensajes") }
        for (mid, flag, textShown, hidden) in [(ids.camion, "topic.flag.Operaciones", "El camión llega el lunes", "Falta el extracto de septiembre"),
                                               (ids.vemos, "topic.all", "Nos vemos mañana en la oficina", "")] {
            let app = XCUIApplication()
            app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES",
                                   "-AppleLanguages", "(es)", "-AppleLocale", "es_CO", "-TCResetLanguage", "YES",
                                   "-TCOpenMessage", "\(f.conversationId):\(mid)"]
            app.launch()
            let email = app.textFields["login.email"]
            XCTAssertTrue(email.waitForExistence(timeout: 20))
            email.tap(); email.typeText(f.a.email)
            let pw = app.secureTextFields["login.password"]
            pw.tap(); pw.typeText(f.password)
            app.buttons["login.submit"].tap()
            let target = app.buttons[flag]
            XCTAssertTrue(target.waitForExistence(timeout: 25), "abrió el chat")
            let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            for _ in 0..<4 {
                for surface in [app, springboard] { for label in ["Not Now", "Ahora no"] where surface.buttons[label].exists { surface.buttons[label].tap() } }
                sleep(1)
            }
            expectation(for: NSPredicate(format: "isSelected == true"), evaluatedWith: target); waitForExpectations(timeout: 10)
            XCTAssertFalse(app.buttons["topic.general"].isSelected, "no queda en General")
            let row = text(app, textShown)
            XCTAssertTrue(row.waitForExistence(timeout: 8))
            XCTAssertTrue(row.isHittable || app.windows.firstMatch.frame.intersects(row.frame), "el mensaje queda a la vista")
            if !hidden.isEmpty { XCTAssertFalse(text(app, hidden).exists, "filtrado en su tema") }
            shot("temas-20-burbuja-\(flag)")
            app.terminate()
        }
    }
}
