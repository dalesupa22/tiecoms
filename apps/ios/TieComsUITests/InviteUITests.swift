import XCTest

/// SPEC-invitar: «Agregar al grupo» con buscador, invitar por correo, copiar enlace, Compartir…, tipo de persona y
/// pendientes, contra el API de PRUEBAS (fixture de Grupos por `TEST_RUNNER_TC_FIXTURE_GRUPOS`; capturas con
/// `TEST_RUNNER_TC_SHOTS=/dir`). El API de pruebas no envía correos reales.
final class InviteUITests: XCTestCase {
    struct Fixture: Decodable {
        struct Person: Decodable { var email: String; var id: String }
        var apiUrl: String
        var password: String
        var a: Person
        var pagosId: String
        var generalId: String?
    }

    override func setUp() { continueAfterFailure = false }

    private func fixture() throws -> Fixture {
        guard let path = ProcessInfo.processInfo.environment["TC_FIXTURE_GRUPOS"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE_GRUPOS") }
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        XCTAssertFalse(f.apiUrl.contains("app.chaggu.com") || f.apiUrl.contains("app.tiecoms.com"), "no se prueba contra producción")
        return f
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

    private func login(_ f: Fixture, lang: String = "es") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES",
                               "-AppleLanguages", "(\(lang))", "-AppleLocale", lang == "es" ? "es_CO" : "en_US", "-TCResetLanguage", "YES"]
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

    /// Abre «Agregar al grupo» desde los detalles del grupo.
    private func openAdd(_ app: XCUIApplication, _ conversationId: String) {
        let row = app.buttons["conv.row.\(conversationId)"]
        let until = Date().addingTimeInterval(20)
        while Date() < until && !row.exists { dismissSystemPrompts(app); usleep(300_000) }
        dismissSystemPrompts(app)
        if app.buttons["home.tab.all"].exists { app.buttons["home.tab.all"].tap() }
        XCTAssertTrue(row.waitForExistence(timeout: 10), "fila del grupo")
        for _ in 0..<4 where !row.isHittable { app.swipeUp() }
        row.tap()
        XCTAssertTrue(app.buttons["chat.header"].waitForExistence(timeout: 8))
        app.buttons["chat.header"].tap()
        let add = app.buttons["details.addPeople"]
        XCTAssertTrue(add.waitForExistence(timeout: 5), "«Agregar al grupo» en los detalles del grupo")
        add.tap()
        XCTAssertTrue(app.textFields["addMembers.search"].waitForExistence(timeout: 5), "buscador «Nombre o correo»")
    }

    private func kindChip(_ app: XCUIApplication, prefix: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "addMembers.kind.\(prefix)")).firstMatch
    }

    func testAddToGroupInviteByEmailLinkShareAndPending() throws {
        let f = try fixture()
        let app = login(f)

        // 1. Grupo de Tu organización: por defecto «De {mi empresa}».
        openAdd(app, f.pagosId)
        let mine = kindChip(app, prefix: "org.")
        XCTAssertTrue(mine.waitForExistence(timeout: 5), "chip «De {mi empresa}»")
        XCTAssertTrue(mine.isSelected, "en Tu organización se elige «De {mi empresa}»")
        XCTAssertTrue(app.buttons["addMembers.kind.guest"].exists, "chip Tercero")
        XCTAssertTrue(app.buttons["addMembers.copyLink"].exists)
        XCTAssertTrue(app.buttons["addMembers.share"].exists)
        XCTAssertFalse(app.staticTexts["Todas las personas del espacio ya están aquí. Para sumar a alguien nuevo, invítalo desde el espacio."].exists,
                       "sin el texto viejo")
        sleep(1)
        shot("01-agregar-tu-organizacion")

        // 2. «Invitar por correo» enfoca el buscador; un correo válido saca «✉ Invitar a {correo}».
        app.buttons["addMembers.byEmail"].tap()
        let search = app.textFields["addMembers.search"]
        let mail = "laura.\(Int(Date().timeIntervalSince1970) % 100000)@qa.tiecoms.test"
        search.typeText(mail)
        let send = app.buttons["addMembers.sendInvite"]
        XCTAssertTrue(send.waitForExistence(timeout: 5), "fila «Invitar a {correo}» con «Enviar invitación»")
        sleep(1)
        shot("02-invitar-correo")
        send.tap()
        XCTAssertTrue(app.staticTexts["addMembers.emailPending"].waitForExistence(timeout: 10), "la fila queda «Pendiente»")
        XCTAssertTrue(app.staticTexts["addMembers.sentNote"].exists, "«Invitación enviada a {correo}»")
        sleep(1)
        shot("03-invitacion-enviada")

        // 3. Copiar enlace: «Enlace copiado · vence el {fecha}» y el código con su botón.
        if app.keyboards.firstMatch.exists { app.swipeDown() }
        let copy = app.buttons["addMembers.copyLink"]
        for _ in 0..<3 where !copy.isHittable { app.swipeUp() }
        copy.tap()
        XCTAssertTrue(app.staticTexts["addMembers.linkCopied"].waitForExistence(timeout: 10) || app.descendants(matching: .any)["addMembers.linkCopied"].exists,
                      "«Enlace copiado · vence el…»")
        XCTAssertTrue(app.descendants(matching: .any)["addMembers.code"].exists, "código en pequeño")
        XCTAssertTrue(app.buttons["addMembers.copyCode"].exists)

        // 4. Pendientes plegados: «Invitaciones pendientes (N)».
        let pending = app.descendants(matching: .any)["addMembers.pending"].firstMatch
        for _ in 0..<3 where !pending.exists { app.swipeUp() }
        XCTAssertTrue(pending.waitForExistence(timeout: 8), "«Invitaciones pendientes (N)»")
        pending.tap()
        sleep(1)
        for _ in 0..<3 where !app.staticTexts[mail].exists { app.swipeUp() }
        XCTAssertTrue(app.staticTexts[mail].waitForExistence(timeout: 5), "el correo invitado aparece en pendientes")
        let revoke = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'addMembers.revoke.'")).firstMatch
        XCTAssertTrue(revoke.exists, "«Anular»")
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'addMembers.resend.'")).firstMatch.exists, "«Reenviar»")
        sleep(1)
        shot("04-enlace-copiado-y-pendientes")

        // 5. Compartir…: la hoja del sistema.
        let share = app.buttons["addMembers.share"]
        for _ in 0..<3 where !share.isHittable { app.swipeDown() }
        share.tap()
        let sheet = app.otherElements["ActivityListView"].firstMatch
        let shown = sheet.waitForExistence(timeout: 8) || app.navigationBars["UIActivityContentView"].waitForExistence(timeout: 2)
        XCTAssertTrue(shown, "hoja Compartir del sistema")
        sleep(1)
        shot("05-compartir")
        if app.buttons["Close"].exists { app.buttons["Close"].tap() } else if app.buttons["Cerrar"].exists { app.buttons["Cerrar"].tap() } else { app.swipeDown(velocity: .fast) }
        sleep(1)

        // 6. Anular la invitación: sale de pendientes y la fila del correo vuelve a «Enviar invitación».
        if app.keyboards.firstMatch.exists { app.swipeDown() }
        for _ in 0..<4 where !revoke.isHittable { app.swipeUp() }
        XCTAssertTrue(revoke.isHittable, "«Anular» visible")
        revoke.tap()
        XCTAssertTrue(app.buttons["addMembers.sendInvite"].waitForExistence(timeout: 8), "anulada: se puede invitar de nuevo")
        XCTAssertFalse(app.staticTexts[mail].exists, "ya no está en pendientes")
        sleep(1)
        shot("06-invitacion-anulada")
        app.buttons["Cancelar"].firstMatch.tap()

        // 7. Relación: por defecto la otra empresa.
        guard let general = f.generalId else { return }
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        openAdd(app, general)
        let other = kindChip(app, prefix: "company.")
        XCTAssertTrue(other.waitForExistence(timeout: 5), "chip «De {otra empresa}»")
        XCTAssertTrue(other.isSelected, "en una relación se elige la contraparte")
        sleep(1)
        shot("07-agregar-relacion")
    }

    func testAddToGroupInEnglish() throws {
        let f = try fixture()
        guard let general = f.generalId else { throw XCTSkip("Fixture sin grupo general") }
        let app = login(f, lang: "en")
        openAdd(app, general)
        XCTAssertTrue(app.staticTexts["Invite someone new"].exists || app.staticTexts["INVITE SOMEONE NEW"].exists, "sección en inglés")
        XCTAssertTrue(app.buttons["addMembers.kind.guest"].label.hasPrefix("Guest (advisor"))
        app.textFields["addMembers.search"].tap()
        app.textFields["addMembers.search"].typeText("nora@qa.tiecoms.test")
        XCTAssertTrue(app.buttons["addMembers.sendInvite"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Invite nora@qa.tiecoms.test"].exists)
        sleep(1)
        shot("08-add-to-group-english")
    }
}
