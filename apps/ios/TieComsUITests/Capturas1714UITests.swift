import XCTest

/// 1.7.14 en el simulador (nunca en los de Danny), contra un API local con S3 falso (apps/api/test/fake-s3.mjs):
/// la ✕ de gg con «Deshacer», el visor de un PDF con gg / Crear tarea / Compartir, y los archivos de una tarea.
/// `TEST_RUNNER_TC_FIXTURE_1714=<fx.json> TEST_RUNNER_TC_SHOTS=<carpeta> [TEST_RUNNER_TC_SHOT_SUFFIX=-oscuro]`.
final class Capturas1714UITests: XCTestCase {
    struct Fixture: Decodable {
        struct P: Decodable { var email: String; var id: String }
        var apiUrl: String; var password: String; var a: P; var b: P; var generalId: String; var dmBrunoId: String; var pagosId: String
        var pdfAttachmentId: String; var domainIssueId: String
    }

    override func setUp() { continueAfterFailure = true }

    private var suffix: String { ProcessInfo.processInfo.environment["TC_SHOT_SUFFIX"] ?? "" }

    private func fixture() throws -> Fixture {
        guard let path = ProcessInfo.processInfo.environment["TC_FIXTURE_1714"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE_1714") }
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

    func test1PildoraConDeshacer() throws {
        let f = try fixture()
        let app = login(f)
        openChat(app, f.dmBrunoId)
        XCTAssertTrue(app.buttons["chat.gg"].waitForExistence(timeout: 15))
        app.buttons["gg.pill.hide"].tap()
        let undo = app.buttons["Deshacer"]
        XCTAssertTrue(undo.waitForExistence(timeout: 4), "aviso con Deshacer")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Preguntar a gg")).firstMatch.exists, "dice dónde recuperarla")
        shot("50-gg-oculto-deshacer")
        undo.tap()
        XCTAssertTrue(app.buttons["chat.gg"].waitForExistence(timeout: 4), "Deshacer la trae de vuelta")
    }

    func test2VisorPdfConAcciones() throws {
        let f = try fixture()
        let app = login(f)
        openChat(app, f.dmBrunoId)
        let chip = app.buttons["att.file.\(f.pdfAttachmentId)"]
        XCTAssertTrue(chip.waitForExistence(timeout: 15), "PDF en el chat")
        for _ in 0..<3 where !chip.isHittable { app.swipeDown() }
        chip.tap()
        let create = app.buttons["viewer.createTask"]
        XCTAssertTrue(create.waitForExistence(timeout: 10), "barra del visor")
        XCTAssertTrue(app.buttons["viewer.askGg"].exists, "Preguntar a gg")
        XCTAssertTrue(app.buttons["viewer.share"].exists, "Compartir")
        sleep(2)
        shot("51-visor-pdf-acciones")
        app.buttons["viewer.share"].tap()
        XCTAssertTrue(app.buttons["viewer.forward"].waitForExistence(timeout: 4), "Reenviar a un chat")
        shot("52-visor-compartir")
        app.buttons["viewer.shareSystem"].tap()
        sleep(3)
        shot("53-visor-hoja-sistema")
        // Se cierra la hoja del sistema deslizando (su ✕ y la del visor se llaman igual).
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
        sleep(2)
        XCTAssertTrue(create.waitForExistence(timeout: 5))
        create.tap()
        let title = app.textViews["issue.titleField"].exists ? app.textViews["issue.titleField"] : app.textFields["issue.titleField"]
        XCTAssertTrue(title.waitForExistence(timeout: 8), "nueva tarea")
        XCTAssertTrue(((title.value as? String) ?? "").contains("Contrato Nestlé 2026"), "título del nombre del archivo: \(title.value ?? "")")
        XCTAssertTrue(app.descendants(matching: .any)["issue.newFile.\(f.pdfAttachmentId)"].exists, "el archivo va adjunto")
        shot("54-crear-tarea-desde-archivo")
        app.buttons["sheet.submit"].tap()
        sleep(4)
        shot("55-tarea-creada")
        // ✨ Preguntar a gg desde el visor (sigue abierto tras crear la tarea): abre gg de este chat citando el mensaje.
        XCTAssertTrue(app.buttons["viewer.askGg"].waitForExistence(timeout: 10))
        app.buttons["viewer.askGg"].tap()
        sleep(3)
        shot("56-gg-desde-archivo")
    }

    func test3ArchivosDeLaTarea() throws {
        let f = try fixture()
        let app = login(f)
        selectTab(app, "tab.issues")
        let seg = app.segmentedControls["issues.filter"]
        XCTAssertTrue(seg.waitForExistence(timeout: 10))
        seg.buttons.element(boundBy: 1).tap()
        let row = app.buttons["issue.row.\(f.domainIssueId)"]
        for _ in 0..<5 where !(row.exists && row.isHittable) { app.swipeUp() }
        row.tap()
        let attach = app.buttons["taskFiles.attach"]
        for _ in 0..<5 where !(attach.exists && attach.isHittable) { app.swipeUp() }
        XCTAssertTrue(attach.waitForExistence(timeout: 8), "Adjuntar en el detalle")
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'att.media.'")).firstMatch.exists, "la foto de la tarea")
        sleep(2)
        shot("57-tarea-archivos")
        attach.tap()
        sleep(1)
        shot("58-tarea-adjuntar-menu")
        let photos = app.buttons["Fotos y videos"]
        if photos.waitForExistence(timeout: 3) {
            photos.tap()
            sleep(3)
            // Selector de Fotos del sistema: la primera foto y «Añadir».
            let img = app.images.matching(NSPredicate(format: "label CONTAINS[c] 'photo' OR label CONTAINS[c] 'foto' OR label CONTAINS[c] 'imagen'")).firstMatch
            if img.waitForExistence(timeout: 5) { img.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() } else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.17, dy: 0.3)).tap() }
            sleep(1)
            let add = app.buttons.matching(NSPredicate(format: "label IN %@", ["Add", "Añadir", "Agregar", "Listo", "Done", "Hecho"])).firstMatch
            if add.exists && add.isHittable { add.tap() } else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.89, dy: 0.163)).tap() }
            sleep(2)
            shot("59a-tarea-subiendo")
            sleep(5)
            shot("59-tarea-archivo-subido")
        }
    }

    func test4AnadirTareaConArchivo() throws {
        let f = try fixture()
        let app = login(f)
        selectTab(app, "tab.issues")
        let field = app.textFields["issue.quickField"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap(); field.typeText("Revisar el contrato firmado")
        XCTAssertTrue(app.buttons["taskFiles.attach"].waitForExistence(timeout: 4), "Adjuntar antes de guardar")
        sleep(1)
        shot("60-anadir-tarea-con-adjuntar")
        app.buttons["taskFiles.attach"].tap()
        let photos = app.buttons["Fotos y videos"]
        XCTAssertTrue(photos.waitForExistence(timeout: 3))
        photos.tap()
        sleep(3)
        let img = app.images.matching(NSPredicate(format: "label CONTAINS[c] 'photo' OR label CONTAINS[c] 'foto' OR label CONTAINS[c] 'imagen'")).firstMatch
        if img.waitForExistence(timeout: 5) { img.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
        sleep(1)
        let add = app.buttons.matching(NSPredicate(format: "label IN %@", ["Add", "Añadir", "Agregar", "Listo", "Done", "Hecho"])).firstMatch
        if add.exists && add.isHittable { add.tap() } else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.89, dy: 0.163)).tap() }
        sleep(2)
        XCTAssertTrue(app.buttons["taskFiles.attach"].label.contains("1"), "un archivo listo: \(app.buttons["taskFiles.attach"].label)")
        shot("61-anadir-tarea-con-archivo")
        app.buttons["issue.quickAdd"].tap()
        sleep(5)
        shot("62-tarea-creada-con-archivo")
    }
}
