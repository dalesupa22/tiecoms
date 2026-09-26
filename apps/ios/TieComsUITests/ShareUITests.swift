import XCTest

/// SPEC-v4 en el simulador (nunca en los de Danny): compartir una foto desde Fotos a Chaggu, la sugerencia
/// en la fila de arriba, la foto en la burbuja, el visor y las pestañas de Inicio.
/// Entorno: TEST_RUNNER_TC_FIXTURE4=<fx.json>, TEST_RUNNER_TC_SHOTS=<carpeta>; antes: `xcrun simctl addmedia <sim> foto.png`.
final class ShareUITests: XCTestCase {
    struct Fixture: Decodable {
        struct Person: Decodable { var email: String; var id: String; var name: String }
        var apiUrl: String; var password: String; var conversationId: String; var a: Person; var b: Person
    }

    override func setUp() { continueAfterFailure = false }
    override func tearDown() { shot("zz-final-state") }

    private func fixture() throws -> Fixture {
        guard let path = ProcessInfo.processInfo.environment["TC_FIXTURE4"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE4") }
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
    }

    private func shot(_ name: String) {
        let s = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: s); a.name = name; a.lifetime = .keepAlways; add(a)
        if let dir = ProcessInfo.processInfo.environment["TC_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    private func dismissSystemPrompts(_ apps: [XCUIApplication]) {
        for surface in apps {
            for label in ["Not Now", "Ahora no", "Continue", "Continuar", "Later", "Más tarde"]
            where surface.buttons[label].exists && surface.buttons[label].isHittable { surface.buttons[label].tap() }
        }
    }

    func testShareFromPhotosToTwoConversations() throws {
        let f = try fixture()
        XCTAssertFalse((f.apiUrl.contains("app.chaggu.com") || f.apiUrl.contains("app.tiecoms.com")))
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES",
                               "-AppleLanguages", "(es)", "-AppleLocale", "es_CO"]
        app.launch()
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        email.tap(); email.typeText(f.a.email)
        let pw = app.secureTextFields["login.password"]
        pw.tap(); pw.typeText(f.password)
        app.buttons["login.submit"].tap()
        let row = app.buttons["conv.row.\(f.conversationId)"]
        let until = Date().addingTimeInterval(15)
        while Date() < until && !row.isHittable {
            if app.buttons["push.later"].exists { app.buttons["push.later"].tap() }
            dismissSystemPrompts([app, springboard])
            usleep(300_000)
        }
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        // La pantalla previa al permiso de notificaciones puede llegar un instante después.
        if app.buttons["push.later"].waitForExistence(timeout: 4) { app.buttons["push.later"].tap() }
        sleep(1)
        dismissSystemPrompts([app, springboard])

        // Pestañas de Inicio con contador; la selección se recuerda.
        XCTAssertTrue(app.buttons["home.tab.all"].exists)
        shot("v4-01-inicio-pestanas")
        app.buttons["home.tab.chats"].tap()
        shot("v4-02-inicio-chats")
        app.buttons["home.tab.sides"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["home.tab.emptyState"].waitForExistence(timeout: 3), "estado vacío amable")
        shot("v4-03-inicio-vacio")
        app.buttons["home.tab.all"].tap()

        // Abrir la conversación la dona como sugerencia para la hoja de compartir.
        row.tap()
        XCTAssertTrue(app.buttons["composer.attach"].waitForExistence(timeout: 10), "clip en el compositor")
        app.buttons["composer.attach"].tap()
        shot("v4-04-menu-adjuntar")
        app.tap()   // cierra el menú
        sleep(1)

        // Fotos → Compartir → Chaggu.
        let photos = XCUIApplication(bundleIdentifier: "com.apple.mobileslideshow")
        photos.launch()
        sleep(2)
        dismissSystemPrompts([photos, springboard])
        let shareBtn = photos.buttons.matching(NSPredicate(format: "label == 'Share' OR label == 'Compartir' OR identifier == 'Share'")).firstMatch
        // Fotos recuerda la última vista: si quedó en una foto, se vuelve a la biblioteca.
        if shareBtn.waitForExistence(timeout: 4) {
            let back = photos.navigationBars.buttons.firstMatch
            if back.exists { back.tap(); sleep(1) }
        }
        // La más reciente (añadida con simctl addmedia) queda al final de la cuadrícula.
        let imgs = photos.images.allElementsBoundByIndex.filter { $0.frame.width > 60 && $0.frame.width < 200 }
        if let last = imgs.max(by: { ($0.frame.minY, $0.frame.minX) < ($1.frame.minY, $1.frame.minX) }) { last.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
        else { photos.coordinate(withNormalizedOffset: CGVector(dx: 0.17, dy: 0.515)).tap() }
        sleep(1)
        let share = photos.buttons.matching(NSPredicate(format: "label == 'Share' OR label == 'Compartir' OR identifier == 'Share'")).firstMatch
        XCTAssertTrue(share.waitForExistence(timeout: 8))
        share.tap()
        sleep(2)
        shot("v4-05-hoja-compartir-sugerencia")
        // La hoja de compartir es un proceso remoto: se busca en Fotos y en SpringBoard; si no, por coordenadas
        // (Chaggu es el segundo ícono de la fila de apps, visible en la captura v4-05).
        let tie = [photos, springboard].map { $0.buttons.matching(NSPredicate(format: "label == 'Chaggu'")).firstMatch }.first { $0.exists }
        if let tie { tie.tap() } else { photos.coordinate(withNormalizedOffset: CGVector(dx: 0.386, dy: 0.55)).tap() }
        let ext = XCUIApplication(bundleIdentifier: "com.tiecoms.app.share")
        func q(_ id: String) -> XCUIElement {
            for surface in [photos, ext, springboard] { let e = surface.descendants(matching: .any)[id]; if e.exists { return e } }
            return photos.descendants(matching: .any)[id]
        }
        var waited = 0
        while !q("share.target.\(f.conversationId)").exists && waited < 40 { usleep(500_000); waited += 1 }
        shot("v4-06-extension")
        let target = q("share.target.\(f.conversationId)")
        XCTAssertTrue(target.exists, "la extensión ve la sesión y los destinos del App Group")
        XCTAssertTrue(q("share.preview").exists, "vista previa de la foto")
        target.tap()
        let others = (ext.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'share.target.'")).count > 0 ? ext : photos).buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'share.target.' AND identifier != %@", "share.target.\(f.conversationId)"))
        if others.count > 0 { others.firstMatch.tap() }
        let comment = q("share.comment")
        comment.tap(); comment.typeText("Captura desde Fotos")
        shot("v4-07-extension-seleccion")
        q("share.send").firstMatch.tap()
        sleep(4)
        shot("v4-08-enviado")

        // De vuelta en Chaggu: la foto en la burbuja y el visor.
        app.activate()
        let medias = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'att.media.'"))
        XCTAssertTrue(medias.firstMatch.waitForExistence(timeout: 20), "la foto aparece en el chat")
        let media = medias.element(boundBy: medias.count - 1)   // la más reciente (abajo)
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Captura desde Fotos'")).firstMatch.exists)
        shot("v4-09-chat-foto")
        media.tap()
        XCTAssertTrue(app.buttons["viewer.close"].waitForExistence(timeout: 8))
        sleep(1)
        shot("v4-10-visor")
        app.buttons["viewer.close"].tap()
    }

    /// D, E y F en el simulador: Nuevo chat con «Grupo en un espacio», asuntos de chats, nota de voz con transcripción.
    /// Requiere haber corrido IntegrationV4Tests (deja una nota de voz y un asunto en el directo con B).
    func testSpaceGroupVoiceAndChatIssues() throws {
        let f = try fixture()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES",
                               "-AppleLanguages", "(es)", "-AppleLocale", "es_CO"]
        app.launch()
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        email.tap(); email.typeText(f.a.email)
        let pw = app.secureTextFields["login.password"]
        pw.tap(); pw.typeText(f.password)
        app.buttons["login.submit"].tap()
        let row = app.buttons["conv.row.\(f.conversationId)"]
        let until = Date().addingTimeInterval(15)
        while Date() < until && !row.isHittable {
            if app.buttons["push.later"].exists { app.buttons["push.later"].tap() }
            dismissSystemPrompts([app, springboard])
            usleep(300_000)
        }
        if app.buttons["push.later"].waitForExistence(timeout: 3) { app.buttons["push.later"].tap() }
        sleep(1); dismissSystemPrompts([app, springboard])
        shot("v4-11-inicio-orden")

        // D. Nuevo chat → «Grupo en un espacio».
        app.buttons["home.newChat"].tap()
        let mode = app.segmentedControls["newChat.mode"]
        XCTAssertTrue(mode.waitForExistence(timeout: 5))
        shot("v4-12-nuevo-chat-persona")
        mode.buttons.element(boundBy: 1).tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'newChat.space.'")).firstMatch.waitForExistence(timeout: 5))
        let name = app.textFields["newChat.spaceGroupName"]
        name.tap(); name.typeText("Comité de lanzamiento")
        app.swipeUp()
        shot("v4-13-nuevo-chat-espacio")
        let member = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'newChat.member.'")).firstMatch
        if member.exists { member.tap() }
        app.buttons["newChat.createSpaceGroup"].tap()
        XCTAssertTrue(app.buttons["composer.mic"].waitForExistence(timeout: 10), "abre el grupo creado; micrófono con el compositor vacío")
        shot("v4-14-grupo-creado-microfono")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // F. Nota de voz en el directo con B: burbuja, transcripción y chip «Crear asunto».
        app.buttons["home.tab.chats"].tap()
        let direct = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'conv.row.' AND label BEGINSWITH %@", f.b.name)).firstMatch
        // Con muchos sidechats el directo puede quedar más abajo en la lista.
        for _ in 0..<5 where !direct.waitForExistence(timeout: 2) { app.swipeUp() }
        XCTAssertTrue(direct.waitForExistence(timeout: 4))
        direct.tap()
        let plays = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'voice.play.'"))
        XCTAssertTrue(plays.firstMatch.waitForExistence(timeout: 10), "burbuja de voz")
        let play = plays.element(boundBy: plays.count - 1)   // la más reciente (abajo)
        let toggles = app.buttons.matching(identifier: "voice.transcriptToggle")
        if toggles.firstMatch.waitForExistence(timeout: 5) { toggles.element(boundBy: toggles.count - 1).tap() }
        sleep(1)
        shot("v4-15-nota-de-voz")
        play.tap()
        sleep(1)
        shot("v4-16-nota-reproduciendo")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        for _ in 0..<5 where !app.buttons["home.tab.all"].exists { app.swipeDown() }
        app.buttons["home.tab.all"].tap()

        // E. Asuntos: sección «Chats» después de las empresas.
        app.tabBars.buttons.element(boundBy: 1).tap()
        sleep(2)
        let seg = app.segmentedControls["issues.filter"]
        if seg.exists { seg.buttons.element(boundBy: 2).tap() }
        app.swipeUp()
        sleep(1)
        shot("v4-17-asuntos-chats")
    }
}
