import XCTest

/// Temas del chat (docs/TEMAS.md) en el simulador contra un API de PRUEBAS con la rama `temas`.
///
/// Fixture por el entorno del runner: `TEST_RUNNER_TC_TEMAS_FIXTURE=/ruta/fx.json` con
/// `{ apiUrl, email, password, conversationId, topicName }` (el chat ya debe tener ese tema activo).
/// Con `TEST_RUNNER_TC_SHOTS=/dir` las capturas se guardan como PNG.
final class TemasUITests: XCTestCase {
    struct Fixture: Decodable {
        var apiUrl: String
        var email: String
        var password: String
        var conversationId: String
        var topicName: String
    }

    override func setUp() { continueAfterFailure = false }

    private func fixture() throws -> Fixture {
        guard let path = ProcessInfo.processInfo.environment["TC_TEMAS_FIXTURE"], !path.isEmpty else { throw XCTSkip("Sin TC_TEMAS_FIXTURE") }
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
        for surface in [springboard, app] {
            for label in ["Not Now", "Ahora no"] where surface.buttons[label].waitForExistence(timeout: 1) { surface.buttons[label].tap() }
            for label in ["Permitir", "Allow"] where surface.alerts.buttons[label].waitForExistence(timeout: 1) { surface.alerts.buttons[label].tap() }
        }
    }

    /// Inicia sesión y abre el chat del fixture; devuelve la fila de banderitas.
    @discardableResult
    private func openChat(_ app: XCUIApplication, _ f: Fixture) -> XCUIElement {
        XCTAssertFalse(f.apiUrl.contains("app.chaggu.com") || f.apiUrl.contains("app.tiecoms.com"), "no se prueba contra producción")
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES",
                               "-TCOpenConversation", f.conversationId, "-AppleLanguages", "(es)", "-AppleLocale", "es_CO"]
        app.launch()

        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 15))
        email.tap(); email.typeText(f.email)
        let password = app.secureTextFields["login.password"]
        password.tap(); password.typeText(f.password)
        app.buttons["login.submit"].tap()
        dismissSystemPrompts(app)

        // La fila de banderitas va bajo la barra de accesos (Fijados · Tareas · Hilos · Agenda).
        let dock = app.descendants(matching: .any)["topic.dock"]
        if !dock.waitForExistence(timeout: 15) {
            // Sin -TCOpenConversation aplicado: abrir el chat desde Inicio.
            let row = app.buttons["conv.row.\(f.conversationId)"]
            XCTAssertTrue(row.waitForExistence(timeout: 10), "el chat aparece en Inicio")
            row.tap()
            XCTAssertTrue(dock.waitForExistence(timeout: 10), "la fila de temas aparece en el chat")
        }
        return dock
    }

    /// Banderita → el chat se filtra, el campo dice «Mensaje en X» y lo que envío sale con la etiqueta del tema.
    func testFlagFiltersAndSendsWithTopic() throws {
        let f = try fixture()
        let app = XCUIApplication()
        openChat(app, f)
        XCTAssertTrue(app.buttons["chat.bar.issues"].label.contains("Tareas"), "el chip dice Tareas")
        XCTAssertTrue(app.buttons["topic.all"].exists)
        XCTAssertTrue(app.buttons["topic.new"].exists)
        let flag = app.buttons["topic.flag.\(f.topicName)"]
        XCTAssertTrue(flag.waitForExistence(timeout: 10), "banderita \(f.topicName)")
        flag.tap()
        XCTAssertTrue(flag.isSelected, "la banderita queda elegida")

        let field = app.descendants(matching: .any)["composer.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        let text = "Desde iOS en \(f.topicName) \(Int(Date().timeIntervalSince1970) % 10000)"
        field.tap()
        field.typeText(text)
        app.buttons["composer.send"].tap()
        let sent = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
        XCTAssertTrue(sent.waitForExistence(timeout: 15), "el mensaje enviado se ve en el chat filtrado")
        // La burbuja lleva la etiqueta del tema en su texto accesible.
        let tagged = NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", text, "Tema: \(f.topicName)")
        XCTAssertTrue(app.descendants(matching: .any).matching(tagged).firstMatch.waitForExistence(timeout: 10), "el mensaje sale con el tema")
        app.tap() // cierra el teclado
        sleep(1)
        shot("ios-temas")

        // Mantener presionada la banderita: Renombrar, Cambiar color, Archivar y Quitar tema.
        flag.press(forDuration: 1.0)
        XCTAssertTrue(app.buttons["Archivar"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Quitar tema"].exists)
        XCTAssertTrue(app.buttons["Renombrar"].exists)
        shot("ios-temas-menu")
        // Tocar fuera cierra el menú sin elegir nada.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
        sleep(1)

        // «Todo» quita el filtro (la fila se desplazó hacia la banderita elegida).
        app.descendants(matching: .any)["topic.dock"].swipeRight()
        app.buttons["topic.all"].tap()
        XCTAssertTrue(app.buttons["topic.all"].isSelected)
    }

    /// Tarjeta de tarea en el chat: reemplaza «Creó la tarea…», se ve al filtrar por su tema y se comenta ahí mismo.
    func testTaskCardInChatAndComment() throws {
        let f = try fixture()
        let app = XCUIApplication()
        openChat(app, f)
        let card = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "msg.taskCard.")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 10), "hay tarjetas de tarea en el chat")
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Creó la tarea")).firstMatch.exists, "sin la línea de sistema")
        // Filtrar por el tema: aparece la tarjeta de la tarea de ese tema.
        app.buttons["topic.flag.\(f.topicName)"].tap()
        let untag = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "taskCard.untag.")).firstMatch
        XCTAssertTrue(untag.waitForExistence(timeout: 10), "la tarjeta de la tarea del tema se ve filtrada, con su ✕")
        let field = app.textFields.matching(NSPredicate(format: "identifier BEGINSWITH %@", "taskCard.comment.")).firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5), "campo «Comenta esta tarea…»")
        let text = "Comentario iOS \(Int(Date().timeIntervalSince1970) % 10000)"
        field.tap()
        field.typeText(text)
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "taskCard.send.")).firstMatch.tap()
        let comment = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
        XCTAssertTrue(comment.waitForExistence(timeout: 10), "el comentario aparece en la tarjeta")
        sleep(1)
        shot("ios-temas-tarea")
    }
}
