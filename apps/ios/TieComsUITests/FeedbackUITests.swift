import XCTest

/// Feedback de TestFlight (SPEC-v3) en el simulador contra el API de mobile-feedback (3043).
/// Entorno: TEST_RUNNER_TC_FIXTURE3=<fx.json> y TEST_RUNNER_TC_SHOTS=<carpeta de capturas>.
final class FeedbackUITests: XCTestCase {
    struct Fixture: Decodable {
        struct Person: Decodable { var email: String; var id: String; var name: String }
        var apiUrl: String; var password: String; var conversationId: String; var a: Person; var b: Person
    }

    override func setUp() { continueAfterFailure = false }
    override func tearDown() { shot("zz-final-state") }

    private func fixture() throws -> Fixture {
        guard let path = ProcessInfo.processInfo.environment["TC_FIXTURE3"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE3") }
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

    /// HTTP síncrono desde el runner (datos de ejemplo como B).
    @discardableResult
    private func http(_ f: Fixture, _ method: String, _ path: String, token: String?, body: [String: Any]) -> [String: Any] {
        var req = URLRequest(url: URL(string: "\(f.apiUrl)/api/v1\(path)")!)
        req.httpMethod = method
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        let sem = DispatchSemaphore(value: 0)
        var out: [String: Any] = [:]
        URLSession.shared.dataTask(with: req) { data, _, _ in
            out = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }) ?? [:]
            sem.signal()
        }.resume()
        sem.wait()
        return out
    }

    private func login(_ f: Fixture, _ email: String) -> String {
        http(f, "POST", "/auth/login", token: nil, body: ["email": email, "password": f.password,
                                                          "device": ["deviceId": UUID().uuidString, "name": "UI v3", "platform": "agent"]])["accessToken"] as? String ?? ""
    }

    private func element(_ app: XCUIApplication, containing text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    func testFeedbackTestFlight() throws {
        let f = try fixture()
        XCTAssertFalse((f.apiUrl.contains("app.chaggu.com") || f.apiUrl.contains("app.tiecoms.com")))
        // Datos: B escribe una racha de dos mensajes y otro después; A abre un asunto.
        let tb = login(f, f.b.email)
        for body in ["Hola equipo, ¿cómo vamos con la fecha de salida?", "Necesito confirmarla hoy con dirección."] {
            http(f, "POST", "/conversations/\(f.conversationId)/messages", token: tb, body: ["clientMessageId": UUID().uuidString, "body": body])
        }
        let ta = login(f, f.a.email)
        http(f, "POST", "/conversations/\(f.conversationId)/messages", token: ta, body: ["clientMessageId": UUID().uuidString, "body": "La revisamos esta tarde."])
        http(f, "POST", "/conversations/\(f.conversationId)/messages", token: tb, body: ["clientMessageId": UUID().uuidString, "body": "Perfecto, quedo atento."])
        http(f, "POST", "/conversations/\(f.conversationId)/issues", token: ta, body: ["title": "Confirmar fecha con dirección", "ownerId": f.a.id])

        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCDemoPhoto", "YES",
                               "-AppleLanguages", "(es)", "-AppleLocale", "es_CO"]
        app.launch()
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        email.tap(); email.typeText(f.a.email)
        let pw = app.secureTextFields["login.password"]
        pw.tap(); pw.typeText(f.password)
        app.buttons["login.submit"].tap()

        // 6. Pantalla previa al permiso de notificaciones (y el aviso de guardar contraseña del sistema).
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        var promptShot = false
        let until = Date().addingTimeInterval(12)
        while Date() < until {
            if app.buttons["push.later"].exists {
                if !promptShot { shot("v3-00-permiso-push"); promptShot = true }
                app.buttons["push.later"].tap()
            }
            for surface in [app, springboard] {
                for label in ["Not Now", "Ahora no"] where surface.buttons[label].exists && surface.buttons[label].isHittable { surface.buttons[label].tap() }
            }
            if promptShot && app.buttons["conv.row.\(f.conversationId)"].isHittable { break }
            usleep(300_000)
        }
        if !promptShot { print("[aviso] el permiso de notificaciones ya estaba decidido en este simulador: sin pantalla previa") }

        // 9. Jerarquía de Inicio.
        let row = app.buttons["conv.row.\(f.conversationId)"]
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        XCTAssertTrue(element(app, containing: "EMPRESAS Y ESPACIOS").exists || element(app, containing: "Empresas y espacios").exists)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'conv.issues.'")).firstMatch.exists, "chip ◆ asuntos")
        shot("v3-01-inicio-jerarquia")
        row.tap()

        // 5. Autores con avatar y color; cabecera Empresa · Espacio; barra de asuntos.
        XCTAssertTrue(element(app, containing: "Perfecto, quedo atento").waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["chat.issuesBar"].exists, "barra «Asuntos abiertos»")
        shot("v3-02-chat-autores")

        // 8. Pulsación larga con vista previa → 4. Preguntar en privado (lateral).
        let theirs = element(app, containing: "Necesito confirmarla hoy")
        theirs.press(forDuration: 1.0)
        let ask = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Preguntar'")).firstMatch
        XCTAssertTrue(ask.waitForExistence(timeout: 5))
        shot("v3-03-menu-mensaje")
        ask.tap()
        let person = app.buttons["side.person.\(f.b.id)"]
        XCTAssertTrue(person.waitForExistence(timeout: 5))
        if !person.isSelected { person.tap() }   // el autor del mensaje viene elegido
        let q = app.descendants(matching: .any)["side.question"]
        q.tap(); q.typeText("¿Me ayudas con esta fecha?")
        app.buttons["side.submit"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["side.anchor"].waitForExistence(timeout: 10), "panel lateral con el ancla")
        XCTAssertTrue(element(app, containing: "¿Me ayudas con esta fecha?").waitForExistence(timeout: 8))
        shot("v3-04-lateral")
        app.buttons["side.close"].tap()
        let chip = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'side.chip.'")).firstMatch
        let chipOK = chip.waitForExistence(timeout: 6)
        shot("v3-04b-chip-lateral")
        XCTAssertTrue(chipOK, "chip «Consulta lateral» bajo el ancla")

        // 7. Responder en privado.
        theirs.press(forDuration: 1.0)
        let priv = app.buttons["Responder en privado"]
        XCTAssertTrue(priv.waitForExistence(timeout: 5))
        priv.tap()
        XCTAssertTrue(app.descendants(matching: .any)["composer.privateReplyBar"].waitForExistence(timeout: 10))
        let field = app.descendants(matching: .any)["composer.field"]
        field.tap(); field.typeText("Te cuento en privado: la movemos al viernes.")
        app.buttons["composer.send"].tap()
        XCTAssertTrue(element(app, containing: "Respondiste en privado").waitForExistence(timeout: 10))
        shot("v3-05-respuesta-privada")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // 3. Comentar el asunto: un solo compositor con «Comentar».
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.tap()
        app.buttons["chat.issuesBar"].tap()
        let issue = element(app, containing: "Confirmar fecha con dirección")
        XCTAssertTrue(issue.waitForExistence(timeout: 5))
        issue.tap()
        let comment = app.descendants(matching: .any)["issue.commentField"]
        XCTAssertTrue(comment.waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["issue.commentSend"].isEnabled, "Comentar se habilita con texto")
        comment.tap(); comment.typeText("Dirección confirma el jueves.")
        app.buttons["issue.commentSend"].tap()
        app.swipeDown(velocity: .fast)
        XCTAssertTrue(element(app, containing: "Dirección confirma el jueves.").waitForExistence(timeout: 8), "el comentario aparece en el historial")
        shot("v3-06-asunto-comentario")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // 1. Foto del grupo (recorte + Guardar).
        app.buttons["chat.header"].tap()
        let change = app.buttons["details.changePhoto"]
        XCTAssertTrue(change.waitForExistence(timeout: 5))
        change.tap()
        app.buttons["Demo"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["photo.crop"].waitForExistence(timeout: 5))
        shot("v3-07-recorte-grupo")
        app.buttons["photo.save"].tap()
        // Toast «Foto del grupo actualizada» (dura 2,4 s) o, si ya pasó, la opción «Quitar foto» que solo sale con foto.
        let groupToast = element(app, containing: "Foto del grupo actualizada")
        XCTAssertTrue(groupToast.waitForExistence(timeout: 10) || element(app, containing: "Quitar foto").exists)
        shot("v3-08-foto-grupo")
        // Cierra Detalles y el chat (su hoja de recorte ya no debe quedar en la jerarquía).
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // 2. Foto de perfil: Ajustes → Perfil → tocar la foto → recorte → Guardar.
        app.tabBars.buttons["Ajustes"].tap()
        let profile = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'settings.editProfile'")).firstMatch
        if profile.waitForExistence(timeout: 3) { profile.tap() } else { element(app, containing: f.a.name).firstMatch.tap() }
        let photo = app.buttons["profile.photo"]
        XCTAssertTrue(photo.waitForExistence(timeout: 5))
        photo.tap()
        app.buttons["Demo"].tap()
        let save = app.navigationBars["Ajusta tu foto"].buttons["photo.save"]
        XCTAssertTrue(save.waitForExistence(timeout: 5))
        shot("v3-09a-recorte-perfil")
        save.tap()
        let toast = element(app, containing: "Foto actualizada")
        XCTAssertTrue(toast.waitForExistence(timeout: 10) || app.buttons["profile.removePhoto"].waitForExistence(timeout: 3))
        shot("v3-09-perfil-foto")

        // 7. Nuevo chat desde el lápiz de Inicio.
        app.tabBars.buttons["Inicio"].tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["home.newChat"].tap()
        shot("v3-10-nuevo-chat")
    }
}

/// Concede el permiso de notificaciones (para probar el push con `xcrun simctl push`).
final class GrantNotificationsUITests: XCTestCase {
    func testGrantNotifications() throws {
        guard let api = ProcessInfo.processInfo.environment["TC_API"], !api.isEmpty else { throw XCTSkip("Sin TC_API") }
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", api, "-TCNoSplash", "YES", "-AppleLanguages", "(es)"]
        app.launch()
        app.tabBars.buttons["Ajustes"].tap()
        let toggle = app.switches["settings.notifications"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        if (toggle.value as? String) == "1" { toggle.switches.firstMatch.tap(); sleep(1) }
        toggle.switches.firstMatch.tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for label in ["Permitir", "Allow"] where springboard.buttons[label].waitForExistence(timeout: 3) { springboard.buttons[label].tap() }
        sleep(2)
        XCUIDevice.shared.press(.home)
    }
}
