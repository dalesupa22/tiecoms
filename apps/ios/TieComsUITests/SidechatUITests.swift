import XCTest

/// SPEC-v4 G (Sidechats) en un simulador que no es de Danny: iniciar desde un mensaje, panel con tarjeta del ancla,
/// split con conector (iPad) u hoja con línea (iPhone), minimizar a burbuja flotante, chip-hilo y respuestas rápidas.
/// Entorno: TEST_RUNNER_TC_FIXTURE4=<fx.json> y TEST_RUNNER_TC_SHOTS=<carpeta>.
final class SidechatUITests: XCTestCase {
    struct Fixture: Decodable {
        struct Person: Decodable { var email: String; var id: String; var name: String }
        var apiUrl: String; var password: String; var conversationId: String; var a: Person; var b: Person
    }

    override func setUp() { continueAfterFailure = false }
    override func tearDown() { shot("zz-final-state") }

    private var device: String { UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone" }

    private func fixture() throws -> Fixture {
        guard let path = ProcessInfo.processInfo.environment["TC_FIXTURE4"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE4") }
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
    }

    private func shot(_ name: String) {
        let s = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: s); a.name = name; a.lifetime = .keepAlways; add(a)
        if let dir = ProcessInfo.processInfo.environment["TC_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(device)-\(name).png"))
        }
    }

    @discardableResult
    private func http(_ f: Fixture, _ method: String, _ path: String, token: String?, body: [String: Any]?) -> [String: Any] {
        var req = URLRequest(url: URL(string: "\(f.apiUrl)/api/v1\(path)")!)
        req.httpMethod = method
        if let body { req.httpBody = try? JSONSerialization.data(withJSONObject: body); req.setValue("application/json", forHTTPHeaderField: "content-type") }
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
                                                          "device": ["deviceId": UUID().uuidString, "name": "UI v5", "platform": "agent"]])["accessToken"] as? String ?? ""
    }

    func testSidechat() throws {
        let f = try fixture()
        XCTAssertFalse(f.apiUrl.contains("app.tiecoms.com"))
        let tag = String(UUID().uuidString.prefix(4))
        // B escribe en el general; luego B abre un sidechat a A sobre otro mensaje (A recibe la pregunta).
        let tb = login(f, f.b.email)
        let anchorText = "¿Confirmamos el lanzamiento para el jueves? \(tag)"
        let m = http(f, "POST", "/conversations/\(f.conversationId)/messages", token: tb, body: ["clientMessageId": UUID().uuidString, "body": anchorText])
        let anchorId = (m["message"] as? [String: Any])?["id"] as? String ?? ""
        http(f, "POST", "/conversations/\(f.conversationId)/messages", token: tb, body: ["clientMessageId": UUID().uuidString, "body": "Avísenme cualquier cosa. \(tag)"])
        let side = http(f, "POST", "/conversations/\(f.conversationId)/side", token: tb,
                        body: ["messageId": anchorId, "userIds": [f.a.id], "question": "Entre nos: ¿el equipo llega a tiempo? \(tag)"])
        XCTAssertNotNil(side["id"], "sidechat creado por B")

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
            for surface in [app, springboard] { for label in ["Not Now", "Ahora no"] where surface.buttons[label].exists { surface.buttons[label].tap() } }
            usleep(300_000)
        }
        if app.buttons["push.later"].waitForExistence(timeout: 3) { app.buttons["push.later"].tap() }
        sleep(1)
        for surface in [app, springboard] { for label in ["Not Now", "Ahora no"] where surface.buttons[label].exists { surface.buttons[label].tap() } }
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.tap()

        // Chip-hilo bajo el ancla → abre el sidechat (split en iPad, hoja a medias en iPhone).
        let chip = app.buttons["side.chip.\(anchorId)"]
        XCTAssertTrue(chip.waitForExistence(timeout: 10), "chip-hilo bajo el ancla")
        shot("v5-01b-chip-hilo")
        chip.tap()
        XCTAssertTrue(app.descendants(matching: .any)["side.anchor"].waitForExistence(timeout: 8), "tarjeta del ancla")
        XCTAssertTrue(app.buttons["side.quick.check"].waitForExistence(timeout: 8), "respuestas rápidas para quien recibe")
        sleep(2)
        shot("v5-02b-sidechat-abierto")
        app.buttons["side.quick.check"].tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Déjame reviso'")).firstMatch.waitForExistence(timeout: 8))
        sleep(1)
        shot("v5-03-respuesta-rapida")

        if device == "iphone" {
            // Arrastrar abajo = minimizar a la burbuja flotante.
            let panel = app.descendants(matching: .any)["side.anchor"]
            let start = panel.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.0)).withOffset(CGVector(dx: 0, dy: -60))
            start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 700)))
            let floating = app.buttons["side.floating"]
            XCTAssertTrue(floating.waitForExistence(timeout: 6), "burbuja flotante")
            shot("v5-04-burbuja-flotante")
            floating.tap()
            XCTAssertTrue(app.descendants(matching: .any)["side.anchor"].waitForExistence(timeout: 6))
        }
        app.buttons["side.close"].tap()
        sleep(1)

        // Iniciar un sidechat desde el menú del mensaje: ancla como burbuja, sugerencias y «¿Qué quieres preguntar?».
        let other = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Avísenme cualquier cosa. \(tag)")).firstMatch
        XCTAssertTrue(other.waitForExistence(timeout: 5))
        other.press(forDuration: 1.0)
        let ask = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Preguntar'")).firstMatch
        XCTAssertTrue(ask.waitForExistence(timeout: 5))
        ask.tap()
        XCTAssertTrue(app.descendants(matching: .any)["side.anchorBubble"].waitForExistence(timeout: 5))
        let person = app.buttons["side.person.\(f.b.id)"]
        XCTAssertTrue(person.waitForExistence(timeout: 5))
        XCTAssertTrue(person.isSelected, "el autor del mensaje viene sugerido y elegido")
        let q = app.descendants(matching: .any)["side.question"]
        q.tap(); q.typeText("¿Qué quisiste decir con esto?")
        shot("v5-05-iniciar")
        app.buttons["side.submit"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["side.anchor"].waitForExistence(timeout: 10), "abre el sidechat nuevo")
        sleep(2)
        shot("v5-06-sidechat-nuevo")
    }

    /// H. Menciones: buscador al teclear @, token, resaltado (especial cuando me mencionan), badge @ y bandeja.
    func testMentions() throws {
        let f = try fixture()
        let tag = String(UUID().uuidString.prefix(4))
        let tb = login(f, f.b.email)
        let anaName = f.a.name
        let body = "@\(anaName) ¿me confirmas la fecha? 📅 \(tag)"
        http(f, "POST", "/conversations/\(f.conversationId)/messages", token: tb,
             body: ["clientMessageId": UUID().uuidString, "body": body, "mentions": [["userId": f.a.id, "start": 0, "length": ("@" + anaName as NSString).length]]])

        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-AppleLanguages", "(es)", "-AppleLocale", "es_CO"]
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
            for surface in [app, springboard] { for label in ["Not Now", "Ahora no"] where surface.buttons[label].exists { surface.buttons[label].tap() } }
            usleep(300_000)
        }
        if app.buttons["push.later"].waitForExistence(timeout: 3) { app.buttons["push.later"].tap() }
        sleep(1)
        for surface in [app, springboard] { for label in ["Not Now", "Ahora no"] where surface.buttons[label].exists { surface.buttons[label].tap() } }
        if app.buttons["home.tab.all"].waitForExistence(timeout: 5) { app.buttons["home.tab.all"].tap() }
        let mentioned = app.buttons.matching(NSPredicate(format: "identifier == %@ AND label CONTAINS %@", "conv.row.\(f.conversationId)", "Te mencionaron")).firstMatch
        XCTAssertTrue(mentioned.waitForExistence(timeout: 8), "badge @ en Inicio (etiqueta accesible «Te mencionaron»)")
        shot("v6-01-inicio-badge")
        app.buttons["home.tab.mentions"].tap()
        let item = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'mention.item.'")).firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 8), "bandeja de menciones")
        shot("v6-02-bandeja")
        item.tap()
        sleep(2)
        shot("v6-03-me-mencionaron")

        // Escribir @ abre el buscador; elegir inserta el token.
        let field = app.descendants(matching: .any)["composer.field"].firstMatch
        field.tap(); field.typeText("Listo @")
        XCTAssertTrue(app.descendants(matching: .any)["mention.picker"].waitForExistence(timeout: 5), "buscador de menciones")
        shot("v6-04-buscador")
        app.buttons["mention.pick.\(f.b.id)"].tap()
        field.typeText("te aviso 👍")
        app.buttons["composer.send"].tap()
        sleep(2)
        shot("v6-05-mencion-enviada")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["home.tab.all"].tap()
    }
}
