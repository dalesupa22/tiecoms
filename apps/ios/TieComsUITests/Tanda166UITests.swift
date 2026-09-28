import XCTest

/// 1.6.6 en la interfaz contra el API de PRUEBAS local: pendientes del árbol, asuntos compactos y personales,
/// reuniones (proveedor MOCK) y calendario Día / Semana / Mes.
///
/// Fixture: `tools/fixtures/tanda166-fixture.mjs` por `TEST_RUNNER_TC_FIXTURE166`; capturas con `TEST_RUNNER_TC_SHOTS=/dir`.
final class Tanda166UITests: XCTestCase {
    struct Fixture: Decodable {
        struct Person: Decodable { var email: String; var id: String }
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
}
