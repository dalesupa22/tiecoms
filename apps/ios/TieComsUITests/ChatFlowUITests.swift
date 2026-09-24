import XCTest

/// Recorrido real en el simulador contra el API de PRUEBAS.
///
/// Credenciales: nunca en el código. Llegan por el entorno del test runner desde
/// el fixture (`TEST_RUNNER_TC_FIXTURE=/ruta/fx.json`). Con `TEST_RUNNER_TC_SHOTS=/dir`
/// las capturas también se guardan como PNG en ese directorio.
/// Requiere `scripts/realtime-peer.mjs` corriendo (responde "eco: …").
final class ChatFlowUITests: XCTestCase {
    struct Fixture: Decodable {
        struct Person: Decodable { var email: String; var id: String; var name: String }
        var apiUrl: String
        var password: String
        var conversationId: String
        var a: Person
        var b: Person
        /// Chat grupal entre empresas (lo crea el seed v3; opcional).
        var multiId: String?
    }

    override func setUp() { continueAfterFailure = false }

    private func fixture() throws -> Fixture {
        guard let path = ProcessInfo.processInfo.environment["TC_FIXTURE"], !path.isEmpty else {
            throw XCTSkip("Sin TC_FIXTURE")
        }
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
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

    private func allowNotificationsIfAsked() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        // El primer login también puede ofrecer guardar la contraseña sintética.
        for surface in [springboard, XCUIApplication()] {
            for label in ["Not Now", "Ahora no"] {
                let button = surface.buttons[label]
                if button.waitForExistence(timeout: 1) { button.tap() }
            }
            for label in ["Permitir", "Allow"] {
                let button = surface.alerts.buttons[label]
                if button.waitForExistence(timeout: 1) { button.tap() }
            }
        }
    }

    /// iOS puede pedir confirmación ("¿Abrir en TieComs?") al abrir un esquema propio.
    private func confirmOpenIfAsked() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for label in ["Abrir", "Open"] {
            let b = springboard.buttons[label]
            if b.waitForExistence(timeout: 2) { b.tap(); return }
        }
    }

    private func element(_ app: XCUIApplication, containing text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    func testLoginSendEchoAndDeepLinks() throws {
        guard ProcessInfo.processInfo.environment["TC_UI_V1"] == "1" else { throw XCTSkip("Recorrido v1: TEST_RUNNER_TC_UI_V1=1") }
        let f = try fixture()
        XCTAssertFalse(f.apiUrl.contains("app.tiecoms.com"), "no se prueba contra producción")
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-AppleLanguages", "(es)", "-AppleLocale", "es_CO"]
        app.launch()

        // 1. Login como A
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        shot(app, "01-login")
        email.tap()
        email.typeText(f.a.email)
        let password = app.secureTextFields["login.password"]
        password.tap()
        password.typeText(f.password)
        app.buttons["login.submit"].tap()

        // 2. Inicio → conversación
        allowNotificationsIfAsked()
        let row = app.buttons["conv.row.\(f.conversationId)"]
        XCTAssertTrue(row.waitForExistence(timeout: 15), "la conversación compartida aparece en Inicio")
        shot(app, "02-inicio")
        row.tap()

        // 3. Enviar "hola desde iOS" y ver el eco del par en vivo
        let field = app.descendants(matching: .any)["composer.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        let text = "hola desde iOS"
        field.tap()
        field.typeText(text)
        let t0 = Date()
        app.buttons["composer.send"].tap()
        let echo = element(app, containing: "eco: \(text)")
        XCTAssertTrue(echo.waitForExistence(timeout: 15), "llega la respuesta del par en vivo")
        print("[medida] UI: envío → eco visible = \(Int(Date().timeIntervalSince(t0) * 1000)) ms (incluye sondeo de XCUITest)")
        shot(app, "03-conversacion-eco")

        // 4. Volver a Inicio y abrir el deep link del esquema propio
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        // Por el sistema (como un enlace tocado en otra app): XCUIApplication.open relanzaría la app
        // con -TCResetSession y perdería la sesión.
        XCUIDevice.shared.system.open(URL(string: "tiecoms://c/\(f.conversationId)")!)
        confirmOpenIfAsked()
        XCTAssertTrue(app.descendants(matching: .any)["composer.field"].waitForExistence(timeout: 10), "tiecoms://c/<id> abre la conversación")
        shot(app, "04-deeplink-esquema")

        // 5. Enlace universal https (sin verificación de dominio en el simulador)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        XCUIDevice.shared.system.open(URL(string: "https://app.tiecoms.com/c/\(f.conversationId)")!)
        confirmOpenIfAsked()
        sleep(4)
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        let inApp = app.state == .runningForeground && app.descendants(matching: .any)["composer.field"].exists
        let inSafari = safari.state == .runningForeground
        print("[resultado] https://app.tiecoms.com/c/<id>: abrió en la app=\(inApp) · abrió Safari=\(inSafari)")
        shot(app, "05-enlace-universal")
        let note = XCTAttachment(string: "https link → app=\(inApp) safari=\(inSafari)")
        note.name = "universal-link-result"
        note.lifetime = .keepAlways
        add(note)
        XCTAssertTrue(inApp || inSafari, "el enlace https abre la app (dominio verificado) o Safari (sin verificación)")

        // Deja la app en primer plano para la captura final.
        app.activate()
        shot(app, "06-final")
    }

    // MARK: v2

    private func shotNamed(_ name: String) {
        let s = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: s); a.name = name; a.lifetime = .keepAlways; add(a)
        if let dir = ProcessInfo.processInfo.environment["TC_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    /// Fotogramas del splash (≈0,7 s, 1,5 s, 2,3 s) congelados con -TCSplashFreeze.
    func testSplashFrames() throws {
        for t in ["0.7", "1.5", "2.3"] {
            let app = XCUIApplication()
            app.launchArguments = ["-TCSplashFreeze", t, "-TCResetSession", "YES", "-TCApiURL", "http://127.0.0.1:9", "-AppleLanguages", "(es)"]
            app.launch()
            XCTAssertTrue(app.otherElements["splash"].waitForExistence(timeout: 5))
            sleep(1)
            shotNamed("splash-\(t)")
            app.terminate()
        }
    }

    /// Splash → login (≤ 3 s) → conversación → pulsación larga → fijar y editar → el par responde en vivo.
    func testV2SplashPinEditLive() throws {
        let f = try fixture()
        XCTAssertFalse(f.apiUrl.contains("app.tiecoms.com"))
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-AppleLanguages", "(es)", "-AppleLocale", "es_CO"]
        app.launchArguments += ["-TCMetrics", "YES"]
        app.launch()
        // La app mide cuánto estuvo el splash en pantalla (XCUITest espera a que la app quede quieta
        // y la animación lo retrasa, así que no se cronometra desde aquí).
        let metric = app.staticTexts["metrics.splash"]
        XCTAssertTrue(metric.waitForExistence(timeout: 10))
        let raw = [metric.label, metric.value as? String ?? ""].joined(separator: " ")
        let splashMs = Int(raw.filter(\.isNumber)) ?? 99_999
        print("[medida] métrica cruda: \(raw)")
        print("[medida] UI v2: splash en pantalla hasta el login = \(splashMs) ms")
        XCTAssertLessThanOrEqual(splashMs, 3000, "el splash termina y aparece el login en ≤ 3 s")
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 5) && email.isHittable)
        shotNamed("v2-01-login")

        email.tap(); email.typeText(f.a.email)
        let password = app.secureTextFields["login.password"]
        password.tap(); password.typeText(f.password)
        app.buttons["login.submit"].tap()
        allowNotificationsIfAsked()

        let row = app.buttons["conv.row.\(f.conversationId)"]
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        shotNamed("v2-02-inicio")
        row.tap()

        let field = app.descendants(matching: .any)["composer.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        let text = "hola v2 desde iOS \(Int.random(in: 100...999))"
        field.tap(); field.typeText(text)
        app.buttons["composer.send"].tap()
        XCTAssertTrue(element(app, containing: "eco: \(text)").waitForExistence(timeout: 10), "eco del par")

        // Pulsación larga sobre mi mensaje → Fijar mensaje
        let mine = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", "Tú", text)).firstMatch
        XCTAssertTrue(mine.waitForExistence(timeout: 5))
        mine.press(forDuration: 1.0)
        let pin = app.buttons["Fijar mensaje"]
        XCTAssertTrue(pin.waitForExistence(timeout: 5), "menú de acciones del mensaje")
        shotNamed("v2-03-menu")
        pin.tap()
        XCTAssertTrue(element(app, containing: "vi fijados:").waitForExistence(timeout: 10), "el par ve el fijado")
        XCTAssertTrue(app.buttons["chat.pinsBar"].waitForExistence(timeout: 5), "barra de fijados")

        // Pulsación larga → Editar → guardar
        mine.press(forDuration: 1.0)
        let edit = app.buttons["Editar"]
        XCTAssertTrue(edit.waitForExistence(timeout: 5))
        edit.tap()
        XCTAssertTrue(app.descendants(matching: .any)["composer.editBar"].waitForExistence(timeout: 5))
        field.typeText(" (editado)")
        app.buttons["composer.send"].tap()
        XCTAssertTrue(element(app, containing: "vi edición: \(text) (editado)").waitForExistence(timeout: 10), "el par ve la edición en vivo")
        XCTAssertTrue(element(app, containing: "(editado)").exists)
        shotNamed("v2-04-fijado-editado")

        // Pestañas nuevas (atrás cierra el teclado)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.tabBars.buttons["Asuntos"].tap()
        XCTAssertTrue(app.navigationBars["Asuntos"].waitForExistence(timeout: 5))
        shotNamed("v2-05-asuntos")
        app.tabBars.buttons["Agenda"].tap()
        XCTAssertTrue(app.navigationBars["Agenda"].waitForExistence(timeout: 5))
        shotNamed("v2-06-agenda")
        app.tabBars.buttons["Ajustes"].tap()
        shotNamed("v2-07-ajustes")
    }

    /// v3: chats grupales entre empresas, vista previa de enlaces, reenviar a varios chats, perfil y archivos.
    /// Requiere un fixture con `multiId` y mensajes con enlaces (vista previa ya generada por el worker).
    func testV3ChatsLinksForwardProfileFiles() throws {
        guard ProcessInfo.processInfo.environment["TC_UI_V3"] == "1" else { throw XCTSkip("Recorrido v3: TEST_RUNNER_TC_UI_V3=1") }
        let f = try fixture()
        XCTAssertFalse(f.apiUrl.contains("app.tiecoms.com"), "no se prueba contra producción")
        let multi = try XCTUnwrap(f.multiId, "el fixture v3 trae multiId")
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-AppleLanguages", "(es)", "-AppleLocale", "es_CO"]
        app.launch()
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        email.tap(); email.typeText(f.a.email)
        let password = app.secureTextFields["login.password"]
        password.tap(); password.typeText(f.password)
        app.buttons["login.submit"].tap()
        allowNotificationsIfAsked()

        // Inicio: el chat grupal va con los directos, con caritas apiladas.
        let multiRow = app.buttons["conv.row.\(multi)"]
        XCTAssertTrue(multiRow.waitForExistence(timeout: 15), "el chat grupal aparece en Inicio")
        shot(app, "v3-01-inicio")

        // Chat grupal: vista previa del enlace.
        multiRow.tap()
        XCTAssertTrue(app.descendants(matching: .any)["msg.linkPreview"].firstMatch.waitForExistence(timeout: 10), "tarjeta de vista previa")
        sleep(2) // miniatura
        shot(app, "v3-02-chat-grupal-vista-previa")

        // Detalles: cargo · área · empresa, sumar gente y salir.
        app.buttons["chat.header"].tap()
        XCTAssertTrue(app.buttons["details.addPeople"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["details.leave"].exists)
        shot(app, "v3-03-detalles-multi")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // Reenviar: menú del mensaje → hoja con selección múltiple.
        let bubble = element(app, containing: "Les comparto la ficha")
        XCTAssertTrue(bubble.waitForExistence(timeout: 5))
        bubble.press(forDuration: 1.0)
        let fwd = app.buttons["menu.forwardChat"]
        XCTAssertTrue(fwd.waitForExistence(timeout: 5), "menú con «Reenviar a otro chat»")
        shot(app, "v3-04-menu-mensaje")
        fwd.tap()
        let target = app.buttons["fwd.target.\(f.conversationId)"]
        XCTAssertTrue(target.waitForExistence(timeout: 5))
        target.tap()
        shot(app, "v3-05-reenviar")
        app.buttons["fwd.send"].tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // El grupo del espacio: llega el reenvío y la tarjeta del enlace.
        let groupRow = app.buttons["conv.row.\(f.conversationId)"]
        XCTAssertTrue(groupRow.waitForExistence(timeout: 10))
        groupRow.tap()
        XCTAssertTrue(element(app, containing: "Reenviado").waitForExistence(timeout: 10), "el reenvío llega con su etiqueta")
        sleep(2)
        shot(app, "v3-06-grupo-reenviado")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // Nuevo chat: personas por empresa, con 2+ elegidas muestra logos y nombre opcional.
        app.buttons["home.newChat"].tap()
        XCTAssertTrue(app.buttons["picker.person.\(f.b.id)"].waitForExistence(timeout: 5))
        shot(app, "v3-07-nuevo-chat")
        app.buttons["picker.person.\(f.b.id)"].tap()
        if let cId = ProcessInfo.processInfo.environment["TC_THIRD_ID"], app.buttons["picker.person.\(cId)"].exists { app.buttons["picker.person.\(cId)"].tap() }
        shot(app, "v3-08-nuevo-chat-elegidos")
        app.buttons["newChat.create"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["composer.field"].waitForExistence(timeout: 10), "abre el chat creado")
        shot(app, "v3-09-chat-abierto")

        // Perfil y archivos (pestaña Ajustes).
        app.tabBars.buttons.element(boundBy: 3).tap()
        let edit = app.buttons["settings.editProfile"]
        XCTAssertTrue(edit.waitForExistence(timeout: 5))
        shot(app, "v3-10-ajustes")
        edit.tap()
        XCTAssertTrue(app.textFields["profile.jobTitle"].waitForExistence(timeout: 5))
        shot(app, "v3-11-perfil")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["settings.files"].tap()
        app.buttons["files.mine"].tap()
        let folder = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'drive.folder.'")).firstMatch
        XCTAssertTrue(folder.waitForExistence(timeout: 10), "carpeta del seed")
        shot(app, "v3-12-mis-archivos")
        folder.tap()
        let file = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'drive.file.'")).firstMatch
        XCTAssertTrue(file.waitForExistence(timeout: 10))
        shot(app, "v3-13-carpeta")
        file.tap()
        sleep(3)
        shot(app, "v3-14-vista-rapida")
    }
    /// Capturas reales para la ficha: solo lee un fixture de demostración local.
    func testStoreScreenshots() throws {
        guard ProcessInfo.processInfo.environment["TC_STORE_SHOTS"] == "1" else { throw XCTSkip("Capturas de tienda desactivadas") }
        let f = try fixture()
        XCTAssertFalse(f.apiUrl.contains("app.tiecoms.com"), "solo entorno de pruebas")
        let lang = ProcessInfo.processInfo.environment["TC_SHOT_LANG"] ?? "es"
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-AppleLanguages", "(\(lang))", "-AppleLocale", lang == "es" ? "es_CO" : "en_US"]
        app.launch()
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 15))
        email.tap(); email.typeText(f.a.email)
        let password = app.secureTextFields["login.password"]
        password.tap(); password.typeText(f.password)
        app.buttons["login.submit"].tap()
        allowNotificationsIfAsked()
        let row = app.buttons["conv.row.\(f.conversationId)"]
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        sleep(2)
        shot(app, "01-inicio")
        row.tap()
        XCTAssertTrue(app.descendants(matching: .any)["composer.field"].waitForExistence(timeout: 10))
        sleep(2)
        shot(app, "02-conversacion")
        app.buttons["chat.header"].tap()
        sleep(2)
        shot(app, "03-equipo")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        // iPad puede mostrar las pestañas arriba; los botones conservan sus etiquetas.
        let issues = app.buttons[lang == "es" ? "Asuntos" : "Issues"].firstMatch
        if issues.exists { issues.tap(); sleep(2); shot(app, "04-asuntos") }
        let agenda = app.buttons[lang == "es" ? "Agenda" : "Calendar"].firstMatch
        if agenda.exists { agenda.tap(); sleep(2); shot(app, "05-agenda") }
    }

    func testReportBlockAndUnblock() throws {
        guard ProcessInfo.processInfo.environment["TC_SAFETY_UI"] == "1" else { throw XCTSkip("Seguridad UI desactivada") }
        let f = try fixture()
        XCTAssertFalse(f.apiUrl.contains("app.tiecoms.com"))
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-AppleLanguages", "(es)"]
        app.launch()
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 15))
        email.tap(); email.typeText(f.a.email)
        let password = app.secureTextFields["login.password"]
        password.tap(); password.typeText(f.password)
        app.buttons["login.submit"].tap()
        allowNotificationsIfAsked()
        let row = app.buttons["conv.row.\(f.conversationId)"]
        XCTAssertTrue(row.waitForExistence(timeout: 15)); row.tap()
        XCTAssertTrue(app.buttons["chat.header"].waitForExistence(timeout: 10)); app.buttons["chat.header"].tap()
        let person = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", f.b.name)).firstMatch
        XCTAssertTrue(person.waitForExistence(timeout: 5)); person.press(forDuration: 1)
        app.buttons["Reportar persona"].tap()
        let reason = app.descendants(matching: .any)["safety.reason"]
        XCTAssertTrue(reason.waitForExistence(timeout: 5)); reason.tap(); reason.typeText("Demostración de revisión de seguridad")
        app.buttons["safety.send"].tap()
        XCTAssertTrue(person.waitForExistence(timeout: 10))
        person.press(forDuration: 1)
        app.buttons["Bloquear persona"].tap()
        app.buttons["Bloquear persona"].tap()
        sleep(2)
        person.press(forDuration: 1)
        XCTAssertTrue(app.buttons["Desbloquear"].waitForExistence(timeout: 5))
        app.buttons["Desbloquear"].tap()
        app.buttons["Desbloquear"].tap()
        sleep(2)
        person.press(forDuration: 1)
        XCTAssertTrue(app.buttons["Bloquear persona"].waitForExistence(timeout: 5))
    }

}
