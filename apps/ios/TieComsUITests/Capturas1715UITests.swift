import XCTest

/// 1.7.15 en el simulador (nunca en los de Danny), contra un API local con S3 falso: la extensión «Compartir en chaggu»
/// con pantalla de acciones (Enviar, Firmar, Analizar con gg, Crear tarea, Guardar) y el selector nuevo.
/// Antes: `xcrun simctl addmedia <sim> foto.jpg`. `TEST_RUNNER_TC_FIXTURE_1715=<fx.json> TEST_RUNNER_TC_SHOTS=<carpeta>`.
final class Capturas1715UITests: XCTestCase {
    struct Fixture: Decodable {
        struct P: Decodable { var email: String; var id: String }
        var apiUrl: String; var password: String; var a: P; var b: P; var generalId: String; var dmBrunoId: String; var pagosId: String
        var pdfAttachmentId: String; var domainIssueId: String
    }

    override func setUp() { continueAfterFailure = true }

    private var suffix: String { ProcessInfo.processInfo.environment["TC_SHOT_SUFFIX"] ?? "" }

    private func fixture() throws -> Fixture {
        guard let path = ProcessInfo.processInfo.environment["TC_FIXTURE_1715"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE_1715") }
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

    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    private let photos = XCUIApplication(bundleIdentifier: "com.apple.mobileslideshow")
    private let ext = XCUIApplication(bundleIdentifier: "com.chaggu.app.share")

    private func q(_ id: String, _ app: XCUIApplication) -> XCUIElement {
        for surface in [app, photos, ext, springboard] { let e = surface.descendants(matching: .any)[id]; if e.exists { return e } }
        return app.descendants(matching: .any)[id]
    }

    /// Fotos › la foto más reciente › Compartir › chaggu.
    private func shareFromPhotos(_ app: XCUIApplication) {
        photos.launch()
        for _ in 0..<5 {
            sleep(1)
            for l in ["Not Now", "Ahora no", "Continue", "Continuar"] where photos.buttons[l].exists && photos.buttons[l].isHittable { photos.buttons[l].tap() }
        }
        let shareQ = NSPredicate(format: "label == 'Share' OR label == 'Compartir' OR identifier == 'Share'")
        if !photos.buttons.matching(shareQ).firstMatch.exists {
            let imgs = photos.images.allElementsBoundByIndex.filter { $0.frame.width > 60 && $0.frame.width < 200 }
            if let last = imgs.max(by: { ($0.frame.minY, $0.frame.minX) < ($1.frame.minY, $1.frame.minX) }) { last.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
            sleep(1)
        }
        let share = photos.buttons.matching(shareQ).firstMatch
        XCTAssertTrue(share.waitForExistence(timeout: 8))
        share.tap()
        sleep(2)
        tapChagguInShareSheet(host: photos)
    }

    /// La fila de apps de la hoja del sistema tarda en salir: se espera a «chaggu» (si no aparece, la posición de la captura).
    private func tapChagguInShareSheet(host: XCUIApplication, fallback: CGVector = CGVector(dx: 0.387, dy: 0.68)) {
        let pred = NSPredicate(format: "label == 'chaggu'")
        for _ in 0..<16 {
            if let tie = [host, springboard].map({ $0.descendants(matching: .any).matching(pred).firstMatch }).first(where: { $0.exists && $0.isHittable }) {
                tie.tap(); return
            }
            usleep(500_000)
        }
        host.coordinate(withNormalizedOffset: fallback).tap()
    }

    private func waitAction(_ app: XCUIApplication, _ a: String) -> XCUIElement {
        var waited = 0
        while !q("share.action.\(a)", app).exists && waited < 40 { usleep(500_000); waited += 1 }
        return q("share.action.\(a)", app)
    }

    func test1AccionesYSelector() throws {
        let f = try fixture()
        let app = login(f)
        selectTab(app, "tab.dms"); sleep(2)
        shareFromPhotos(app)
        let send = waitAction(app, "send")
        XCTAssertTrue(send.exists, "pantalla de acciones")
        XCTAssertTrue(q("share.action.analyze", app).exists)
        XCTAssertFalse(q("share.action.sign", app).exists, "firmar solo con PDF")
        sleep(1)
        shot("70-compartir-acciones-foto")
        send.tap()
        XCTAssertTrue(q("share.search", app).waitForExistence(timeout: 5), "buscador arriba")
        XCTAssertTrue(q("share.recents", app).exists, "recientes con avatares")
        sleep(1)
        shot("71-compartir-selector")
        q("share.recent.\(f.dmBrunoId)", app).tap()
        sleep(1)
        shot("72-compartir-elegido")
        q("share.search", app).tap(); q("share.search", app).typeText("pagos")
        sleep(1)
        shot("73-compartir-buscar")
        q("share.back", app).tap()
        sleep(1)
        let cancel = [ext, photos, springboard].map { $0.buttons.matching(NSPredicate(format: "label == 'Cancelar' OR label == 'Cancel'")).firstMatch }.first { $0.exists }
        cancel?.tap()
    }

    func test2AnalizarConGgYGuardar() throws {
        let f = try fixture()
        let app = login(f)
        selectTab(app, "tab.dms"); sleep(2)
        shareFromPhotos(app)
        let save = waitAction(app, "save")
        XCTAssertTrue(save.exists)
        save.tap()
        sleep(2)
        shot("74-compartir-guardado")
        sleep(2)
        shareFromPhotos(app)
        let analyze = waitAction(app, "analyze")
        analyze.tap()
        sleep(1)
        shot("75-compartir-gg-enviando")
        // La app se abre en el chat con gg.
        sleep(5)
        shot("76-gg-con-el-archivo")
    }

    /// PDF desde el visor de chaggu (Compartir › Compartir… › chaggu): Firmar y Crear tarea abren la app.
    private func sharePdfFromChaggu(_ app: XCUIApplication, _ f: Fixture) {
        app.activate()
        openChat(app, f.dmBrunoId)
        let chip = app.buttons["att.file.\(f.pdfAttachmentId)"]
        XCTAssertTrue(chip.waitForExistence(timeout: 15))
        for _ in 0..<3 where !chip.isHittable { app.swipeDown() }
        chip.tap()
        XCTAssertTrue(app.buttons["viewer.share"].waitForExistence(timeout: 10))
        app.buttons["viewer.share"].tap()
        app.buttons["viewer.shareSystem"].tap()
        sleep(3)
        tapChagguInShareSheet(host: app, fallback: CGVector(dx: 0.16, dy: 0.27))
    }

    func test3PdfFirmarYCrearTarea() throws {
        let f = try fixture()
        let app = login(f)
        sharePdfFromChaggu(app, f)
        let sign = waitAction(app, "sign")
        XCTAssertTrue(sign.exists, "firmar con un PDF")
        sleep(1)
        shot("77-compartir-acciones-pdf")
        sign.tap()
        sleep(6)
        shot("78-firmar-desde-compartir")
        XCTAssertTrue(app.buttons["sign.close"].waitForExistence(timeout: 8), "la app abrió el firmador")
        for _ in 0..<4 where app.buttons["sign.close"].exists { app.buttons["sign.close"].tap(); sleep(2) }
        // Sigue abierto el visor del PDF del que se compartió: se cierra también.
        for _ in 0..<2 where app.buttons["sign.close"].exists { app.buttons["sign.close"].tap(); sleep(1) }
        // Se empieza de nuevo para «Crear tarea» (la app quedó en «Tú», donde se guardó el PDF).
        app.terminate()
        let again = login(f)
        sharePdfFromChaggu(again, f)
        let task = waitAction(again, "task")
        task.tap()
        let title = again.textViews["issue.titleField"].exists ? again.textViews["issue.titleField"] : again.textFields["issue.titleField"]
        XCTAssertTrue(title.waitForExistence(timeout: 12), "hoja de tarea nueva en la app")
        sleep(1)
        shot("79-crear-tarea-desde-compartir")
    }
}
