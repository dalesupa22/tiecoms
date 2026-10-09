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
        var b: Person
        var g: Person
        var dmId: String
        var multiId: String
        var endedCallId: String
        var liveCallId: String
        var missedCallId: String?
        var sleepDmId: String?
        var dndDmId: String?
        var bToken: String?
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
        // «General»: lo de los temas no se ve; lo sin tema y los avisos de la llamada sí.
        app.buttons["topic.general"].tap()
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
        // La videollamada de Gloria que nadie contestó me sonó a mí: desde la migración 042 es «Perdida» (en rojo), no «Sin respuesta».
        if let missed = f.missedCallId {
            let row = app.buttons["calls.row.\(missed)"].firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 5))
            XCTAssertTrue(row.label.contains("Perdida"), "perdida para mí: \(row.label)")
        }
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

    /// Regla fija (1.6.9 → 1.7.0): el descanso o «No molestar» del destinatario NUNCA impide escribir. Sin barra de pestañas en
    /// el chat; con el aviso visible, la barra de búsqueda abierta y el teclado, el campo y enviar se ven y se tocan.
    /// En un directo con modo sueño, en uno con «No molestar» y en un chat grupal.
    func testChatHidesTabBarAndSleepingRecipientCanBeWritten() throws {
        let f = try fixture()
        guard let sleepId = f.sleepDmId, let dndId = f.dndDmId else { throw XCTSkip("Fixture sin sleepDmId/dndDmId") }
        let app = login(f)
        for (n, conv, text) in [(0, sleepId, "Hola Gloria, lo vemos mañana"), (1, dndId, "Hugo, te dejo esto"), (2, f.multiId, "Comité: listo el acta")] {
            let row = app.buttons["conv.row.\(conv)"].firstMatch
            for _ in 0..<3 where !row.exists { goTab(app, "dms"); _ = row.waitForExistence(timeout: 4) }
            XCTAssertTrue(row.waitForExistence(timeout: 6), "fila \(conv)")
            if n == 0 { shot("20-dms-barra") }
            row.tap()
            let field = app.textViews["composer.field"].firstMatch
            XCTAssertTrue(field.waitForExistence(timeout: 10))
            if n == 0 {
                XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "descansando")).firstMatch.waitForExistence(timeout: 5), "aviso de descanso")
            }
            XCTAssertFalse(app.tabBars.firstMatch.exists && app.tabBars.firstMatch.isHittable, "sin barra de pestañas dentro del chat")
            // Arreglo de la prueba, no del producto: en un simulador recién arrancado, la primera vez que se abre la búsqueda
            // el campo no toma el foco ni sale el teclado, y el toque siguiente en el compositor tampoco lo toma
            // («Neither element nor any descendant has keyboard focus»; pasa igual en 791f219 y 59f6195). Un toque previo en el
            // compositor despierta el teclado; después la búsqueda y el compositor toman el foco normalmente.
            field.tap(); sleep(2)
            // Barra de búsqueda abierta (1.7) + teclado en el compositor.
            app.buttons["chat.search"].firstMatch.tap()
            XCTAssertTrue(app.textFields["chat.searchField"].waitForExistence(timeout: 3))
            XCTAssertTrue(app.buttons["composer.viewOnce"].exists, "① visible")
            field.tap()
            field.typeText(text)
            let send = app.buttons["composer.send"].firstMatch
            XCTAssertTrue(send.waitForExistence(timeout: 3))
            XCTAssertTrue(field.isHittable, "el campo se ve y se toca con aviso + búsqueda + teclado")
            XCTAssertTrue(send.isHittable, "enviar se ve y se toca")
            shot("2\(n + 1)-escribiendo-\(n == 0 ? "sueno" : n == 1 ? "dnd" : "grupo")")
            send.tap()
            XCTAssertTrue(app.staticTexts[text].waitForExistence(timeout: 10), "se envió")
            app.buttons["chat.searchClose"].firstMatch.tap()
            app.navigationBars.buttons.element(boundBy: 0).tap()
            XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 5), "de vuelta en la lista, la barra vuelve")
        }
        shot("24-enviados")
    }

    /// 1.6.10 · Mensaje nuevo: marcar dos personas y crear el chat; el 💬 abre el directo de una vez.
    func testNewChatPickTwoAndDirectShortcut() throws {
        let f = try fixture()
        let app = login(f)
        app.buttons["tab.dms"].firstMatch.tap()
        let compose = app.buttons["quick.compose"].firstMatch
        XCTAssertTrue(compose.waitForExistence(timeout: 10))
        compose.tap()
        XCTAssertTrue(app.descendants(matching: .any)["compose.tip"].waitForExistence(timeout: 5), "texto de ayuda")
        XCTAssertFalse(app.buttons["compose.multi"].exists, "ya no hay «Chat con varias personas»")
        XCTAssertTrue(app.buttons["compose.space"].exists, "sin selección: «Grupo en un espacio»")
        shot("30-mensaje-nuevo")
        let bruno = app.buttons["picker.person.\(f.b.id)"].firstMatch
        XCTAssertTrue(bruno.waitForExistence(timeout: 5))
        bruno.tap()
        XCTAssertTrue(app.buttons["picker.chip.\(f.b.id)"].waitForExistence(timeout: 3), "chip en «Para:»")
        XCTAssertTrue(app.buttons["newChat.create"].label.contains("Bruno"), "con 1: «Abrir chat con Bruno»")
        shot("31-uno-marcado")
        // Buscar a Gloria y marcarla: la búsqueda se limpia para seguir eligiendo.
        let field = app.textFields["compose.search"]
        field.tap(); field.typeText("Glor")
        let gloria = app.buttons["picker.person.\(f.g.id)"].firstMatch
        XCTAssertTrue(gloria.waitForExistence(timeout: 5))
        gloria.tap()
        XCTAssertEqual(field.value as? String == "Glor", false, "se limpió la búsqueda")
        XCTAssertTrue(app.textFields["newChat.name"].waitForExistence(timeout: 3), "con 2+: nombre opcional")
        app.textFields["newChat.name"].tap(); app.textFields["newChat.name"].typeText("Comité QA")
        shot("32-dos-marcados")
        XCTAssertTrue(app.buttons["newChat.create"].label.contains("3"))
        app.buttons["newChat.create"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["composer.field"].waitForExistence(timeout: 10), "abre el chat creado")
        shot("33-chat-creado")
        goTab(app, "dms")
        app.buttons["quick.compose"].firstMatch.tap()
        let direct = app.buttons["compose.direct.\(f.b.id)"].firstMatch
        XCTAssertTrue(direct.waitForExistence(timeout: 5))
        direct.tap()
        XCTAssertTrue(app.descendants(matching: .any)["composer.field"].waitForExistence(timeout: 10), "💬 abre el directo")
        XCTAssertTrue(app.staticTexts["Bruno Ortega"].exists || app.buttons["chat.header"].label.contains("Bruno"))
        shot("34-directo")
    }

    /// POST a la API de pruebas como Bruno (fixture); devuelve el JSON de la respuesta.
    @discardableResult
    private func asBruno(_ f: Fixture, _ path: String, _ body: String) -> [String: Any]? {
        guard let tok = f.bToken, let url = URL(string: f.apiUrl + "/api/v1" + path) else { return nil }
        var req = URLRequest(url: url); req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type"); req.setValue("Bearer \(tok)", forHTTPHeaderField: "authorization")
        req.httpBody = Data(body.utf8)
        var out: [String: Any]?
        let done = expectation(description: path)
        URLSession.shared.dataTask(with: req) { data, _, _ in
            out = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
        return out
    }

    /// 30-sep-2026: Bruno me llama y cuelga sin que conteste → la pestaña Llamadas queda en rojo con el número (llega por
    /// el evento calls.missed con la app abierta); al abrirla se quita y el historial muestra «Perdida».
    func testMissedCallRedBadgeClearsOnOpen() throws {
        let f = try fixture()
        guard f.bToken != nil else { throw XCTSkip("Fixture sin bToken") }
        let app = login(f)
        goTab(app, "dms")
        let call = asBruno(f, "/conversations/\(f.dmId)/call", #"{"kind":"audio","deviceKey":"fixture2"}"#)?["call"] as? [String: Any]
        let callId = try XCTUnwrap(call?["id"] as? String, "llamada de Bruno")
        sleep(2)
        asBruno(f, "/calls/\(callId)/end", #"{"deviceKey":"fixture2"}"#)
        let tab = app.buttons["tab.calls"].firstMatch
        let red = NSPredicate(format: "value CONTAINS %@", "perdida")
        expectation(for: red, evaluatedWith: tab); waitForExpectations(timeout: 15)
        sleep(1); shot("60-llamadas-rojo")
        tab.tap()
        // La etiqueta va dentro del botón de la fila (VoiceOver lee la fila entera).
        let row = app.buttons["calls.row.\(callId)"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), "fila de la llamada")
        XCTAssertTrue(row.label.contains("Perdida"), "«Perdida» en el historial: \(row.label)")
        XCTAssertFalse(row.label.contains("Sin respuesta"), "en lugar de «Sin respuesta»")
        expectation(for: NSPredicate(format: "value == %@", ""), evaluatedWith: tab); waitForExpectations(timeout: 5)
        shot("61-historial-perdida")
        // Vuelve a Grupos: ya no hay número.
        goTab(app, "home")
        XCTAssertEqual(tab.value as? String ?? "", "", "se quitó al abrirla")
    }

    /// 1.7.1: «En curso ahora», altavoz, «Agregar» con texto, cámara en plena llamada (cuadrícula) y cambiar cámara.
    func testLiveNowSpeakerAddAndCamera() throws {
        let f = try fixture()
        // Una llamada en curso fresca de Bruno en el chat grupal (el worker cierra las que no laten).
        var liveId = f.liveCallId
        if let tok = f.bToken, let url = URL(string: f.apiUrl + "/api/v1/conversations/\(f.multiId)/call") {
            var req = URLRequest(url: url); req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "content-type"); req.setValue("Bearer \(tok)", forHTTPHeaderField: "authorization")
            req.httpBody = Data(#"{"kind":"audio","deviceKey":"fixture1"}"#.utf8)
            let done = expectation(description: "llamada")
            URLSession.shared.dataTask(with: req) { data, _, _ in
                if let data, let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let c = j["call"] as? [String: Any], let id = c["id"] as? String { liveId = id }
                done.fulfill()
            }.resume()
            wait(for: [done], timeout: 10)
        }
        let app = login(f)
        goTab(app, "calls")
        let live = app.descendants(matching: .any)["calls.active.\(liveId)"]
        XCTAssertTrue(live.waitForExistence(timeout: 10), "«En curso ahora»")
        XCTAssertTrue(app.buttons["calls.active.add.\(liveId)"].exists, "Agregar también desde «En curso ahora»")
        shot("50-en-curso-ahora")
        app.buttons["calls.active.join.\(liveId)"].tap()
        let speaker = app.buttons["call.speaker"]
        XCTAssertTrue(speaker.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["call.addButton"].label.contains("Agregar") || app.buttons["call.addButton"].staticTexts["Agregar"].exists, "«Agregar» con texto")
        XCTAssertFalse(speaker.isSelected, "voz: empieza en el auricular")
        shot("51-llamada-voz")
        speaker.tap()
        XCTAssertTrue(speaker.isSelected, "🔊 altavoz")
        // Cámara en plena llamada: cuadrícula con mi recuadro y el avatar de quien no tiene video.
        app.buttons["call.camera"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["call.video.\(f.a.id)"].waitForExistence(timeout: 5), "mi video en la cuadrícula")
        XCTAssertTrue(app.buttons["call.switchCamera"].exists, "cambiar cámara")
        shot("52-camara-cuadricula")
        app.buttons["call.addButton"].tap()
        XCTAssertTrue(app.buttons["call.add.send"].waitForExistence(timeout: 5))
        shot("53-agregar")
        app.buttons.matching(NSPredicate(format: "label IN %@", ["Cancelar", "Cancel"])).firstMatch.tap()
        app.buttons["call.camera"].tap()
        XCTAssertFalse(app.descendants(matching: .any)["call.video.\(f.a.id)"].waitForExistence(timeout: 2), "sin cámara vuelve el avatar")
        app.buttons["call.hangUp"].tap()
    }
}
