import XCTest

/// Llamadas (docs/LLAMADAS.md) y «Todo» de temas (docs/TEMAS.md) contra una API de PRUEBAS con CALLS_ENABLED=true CALLS_PROVIDER=fake.
/// Fixture por `TEST_RUNNER_TC_FIXTURE_LLAMADAS` (tools/fixtures/llamadas-fixture.mjs); capturas en `TEST_RUNNER_TC_SHOTS`.
/// Con el proveedor falso no hay audio real: la app usa medios nulos y `-TCFakeCaptions YES` simula una frase de la transcripción.
final class LlamadasUITests: XCTestCase {
    struct Fixture: Decodable {
        struct Person: Decodable { var email: String; var id: String }
        var apiUrl: String
        var password: String
        var a: Person
        var dmId: String
        var multiId: String
        var endedCallId: String
        var liveCallId: String
        var sleepDmId: String?
    }

    override func setUp() { continueAfterFailure = false }
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    private func fixture() throws -> Fixture {
        guard let path = env["TC_FIXTURE_LLAMADAS"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE_LLAMADAS") }
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        XCTAssertFalse(f.apiUrl.contains("chaggu.com") || f.apiUrl.contains("tiecoms.com"), "no se prueba contra producción")
        return f
    }

    private func shot(_ name: String) {
        let s = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: s); a.name = name; a.lifetime = .keepAlways; add(a)
        if let dir = env["TC_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    private func login(_ f: Fixture) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES", "-TCResetLanguage", "YES",
                               "-TCFakeCaptions", "YES", "-AppleLanguages", "(es)", "-AppleLocale", "es_CO"]
        app.launch()
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 15))
        email.tap(); email.typeText(f.a.email)
        let pw = app.secureTextFields["login.password"]
        pw.tap(); pw.typeText(f.password)
        app.buttons["login.submit"].tap()
        let notNow = app.buttons.matching(NSPredicate(format: "label IN %@", ["Not Now", "Ahora no"])).firstMatch
        if notNow.waitForExistence(timeout: 5) { notNow.tap() }
        let ok = app.tabBars.firstMatch.waitForExistence(timeout: 15)
        if !ok, let dir = env["TC_SHOTS"] {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? app.debugDescription.write(toFile: dir + "/tree.txt", atomically: true, encoding: .utf8)
        }
        XCTAssertTrue(ok)
        return app
    }

    /// Dentro de una pantalla empujada no hay barra (1.6.9): se vuelve a la raíz con «atrás» y se toca la pestaña.
    private func goTab(_ app: XCUIApplication, _ id: String) {
        for _ in 0..<5 where !app.tabBars.firstMatch.exists {
            let back = app.navigationBars.buttons.element(boundBy: 0)
            if back.exists { back.tap() } else { break }
            _ = app.tabBars.firstMatch.waitForExistence(timeout: 2)
        }
        app.buttons["tab.\(id)"].firstMatch.tap()
        sleep(1)
    }

    func testCallsTabTopicsAndFakeCall() throws {
        let f = try fixture()
        let app = login(f)
        // Seis pestañas, sin «Más».
        let bar = app.tabBars.firstMatch
        XCTAssertEqual(bar.buttons.count, 6)
        XCTAssertTrue(bar.buttons["Llamadas"].exists)
        XCTAssertFalse(bar.buttons["Más"].exists || bar.buttons["More"].exists)

        // DMs › directo con todo lo no leído en «Finanzas»: abre filtrado ahí.
        let dm = app.buttons["conv.row.\(f.dmId)"].firstMatch
        for _ in 0..<3 where !dm.exists { bar.buttons["DMs"].tap(); _ = dm.waitForExistence(timeout: 4) }
        if !dm.waitForExistence(timeout: 6) { shot("00-sin-dm"); try? app.debugDescription.write(toFile: (env["TC_SHOTS"] ?? NSTemporaryDirectory()) + "/tree-dm.txt", atomically: true, encoding: .utf8) }
        XCTAssertTrue(dm.exists)
        shot("01-dms-preview")
        dm.tap()
        let fin = app.buttons["topic.flag.Finanzas"]
        XCTAssertTrue(fin.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["¿Lo apruebas antes del viernes?"].waitForExistence(timeout: 5))
        sleep(2); shot("02a-antes-de-elegir")
        let selected = NSPredicate(format: "isSelected == true")
        expectation(for: selected, evaluatedWith: fin); waitForExpectations(timeout: 5)
        XCTAssertTrue(app.buttons["call.start.audio"].exists, "📞 en el encabezado")
        shot("02-chat-auto-tema")
        // «Todo»: lo leído de los temas no se ve; lo sin tema y los avisos de la llamada sí.
        app.buttons["topic.all"].tap()
        XCTAssertTrue(app.staticTexts["Hola Ana, ¿cómo vas?"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Ya pagué la factura de agosto"].exists, "leído con tema: solo en su banderita")
        XCTAssertTrue(app.staticTexts["Quedó guardada la transcripción de la llamada."].exists)
        shot("03-chat-todo")
        app.buttons["call.transcriptOpen"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "presupuesto de octubre")).firstMatch.waitForExistence(timeout: 10))
        shot("04-detalle-transcripcion")
        app.buttons["call.share"].tap()
        XCTAssertTrue(app.buttons["call.share.chat.transcript"].waitForExistence(timeout: 3))
        shot("05-compartir")
        app.buttons["call.share.copy.transcript"].tap()

        // Pestaña «Llamadas».
        goTab(app, "calls")
        XCTAssertTrue(app.buttons["calls.row.\(f.endedCallId)"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["En curso"].exists)
        XCTAssertTrue(app.staticTexts["Sin respuesta"].exists || app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Sin respuesta")).firstMatch.exists)
        shot("06-pestana-llamadas")

        // Chat grupal: franja «Llamada en curso · Unirse» y la llamada (medios nulos).
        goTab(app, "dms")
        let multi = app.buttons["conv.row.\(f.multiId)"].firstMatch
        XCTAssertTrue(multi.waitForExistence(timeout: 10))
        multi.tap()
        let join = app.buttons["call.banner.join"]
        let joined = join.waitForExistence(timeout: 10)
        if !joined { shot("07-sin-franja") }
        XCTAssertTrue(joined)
        shot("07-franja-unirse")
        join.tap()
        XCTAssertTrue(app.buttons["call.hangUp"].waitForExistence(timeout: 10))
        shot("08-llamada")
        app.buttons["call.transcript"].tap()
        XCTAssertTrue(app.buttons["call.consent.start"].waitForExistence(timeout: 5))
        shot("09-consentimiento")
        app.buttons["call.consent.start"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "Se está transcribiendo: todos en la llamada lo ven")).firstMatch.waitForExistence(timeout: 10))
        // Pedazo falso («texto:…») → call.processing y call.transcript con la frase.
        XCTAssertTrue(app.descendants(matching: .any).containing(NSPredicate(format: "label CONTAINS %@", "Frase de prueba")).firstMatch.waitForExistence(timeout: 15))
        shot("10-transcribiendo")
        app.buttons["call.minimize"].tap()
        XCTAssertTrue(app.buttons["call.pill"].waitForExistence(timeout: 5))
        shot("11-pildora")
        app.buttons["call.pill"].tap()
        app.buttons["call.hangUp"].tap()
        XCTAssertFalse(app.buttons["call.pill"].waitForExistence(timeout: 2))

        // Sonidos (docs/SONIDOS.md): Detalles › Sonido y Tú › predeterminado y tono de llamada.
        app.buttons["chat.header"].tap()
        let soundRow = app.buttons["details.sound"]
        for _ in 0..<4 where !soundRow.isHittable { app.swipeUp() }
        XCTAssertTrue(soundRow.waitForExistence(timeout: 5))
        soundRow.tap()
        XCTAssertTrue(app.buttons["sound.pick.campana"].waitForExistence(timeout: 3))
        shot("12-detalles-sonido")
        app.buttons["sound.pick.campana"].tap()
        goTab(app, "settings")
        let ring = app.buttons["settings.ringtone"].firstMatch
        for _ in 0..<6 where !ring.exists || !ring.isHittable { app.swipeUp() }
        shot("13-ajustes-sonidos")
    }

    /// Solo capturas de la barra de pestañas (TEST_RUNNER_TC_LANG=es|en, TEST_RUNNER_TC_SHOT_TAG para el nombre).
    func testTabBarShots() throws {
        let f = try fixture()
        let lang = env["TC_LANG"] ?? "es"
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES", "-TCResetLanguage", "YES",
                               "-AppleLanguages", "(\(lang))", "-AppleLocale", lang == "es" ? "es_CO" : "en_US"]
        app.launch()
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 15))
        email.tap(); email.typeText(f.a.email)
        let pw = app.secureTextFields["login.password"]
        pw.tap(); pw.typeText(f.password)
        app.buttons["login.submit"].tap()
        let notNow = app.buttons.matching(NSPredicate(format: "label IN %@", ["Not Now", "Ahora no"])).firstMatch
        if notNow.waitForExistence(timeout: 5) { notNow.tap() }
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 15))
        sleep(3)
        let tag = env["TC_SHOT_TAG"] ?? lang
        shot("tabs-\(tag)-grupos")
        for _ in 0..<3 where !app.navigationBars["DMs"].exists { app.buttons["tab.dms"].firstMatch.tap(); sleep(1) }
        shot("tabs-\(tag)-dms")
    }

    /// 1.6.9: dentro de un chat no hay barra de pestañas (no tapa el compositor) y el aviso de descanso del otro no bloquea escribir.
    func testChatHidesTabBarAndSleepingRecipientCanBeWritten() throws {
        let f = try fixture()
        guard let sleepId = f.sleepDmId else { throw XCTSkip("Fixture sin sleepDmId") }
        let app = login(f)
        let bar = app.tabBars.firstMatch
        let row = app.buttons["conv.row.\(sleepId)"].firstMatch
        for _ in 0..<3 where !row.exists { app.buttons["tab.dms"].firstMatch.tap(); _ = row.waitForExistence(timeout: 4) }
        XCTAssertTrue(row.waitForExistence(timeout: 6))
        shot("20-dms-barra")
        row.tap()
        let field = app.textViews["composer.field"].firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "descansando")).firstMatch.waitForExistence(timeout: 5), "aviso de descanso")
        XCTAssertFalse(bar.exists && bar.isHittable, "sin barra de pestañas dentro del chat")
        XCTAssertTrue(field.isHittable, "el compositor no queda tapado")
        shot("21-chat-descansando")
        field.tap()
        field.typeText("Hola Gloria, lo vemos mañana")
        shot("22-escribiendo")
        let send = app.buttons["composer.send"].firstMatch
        XCTAssertTrue(send.waitForExistence(timeout: 3))
        send.tap()
        XCTAssertTrue(app.staticTexts["Hola Gloria, lo vemos mañana"].waitForExistence(timeout: 10))
        shot("23-enviado")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(bar.waitForExistence(timeout: 5), "de vuelta en la lista, la barra vuelve")
    }
}
