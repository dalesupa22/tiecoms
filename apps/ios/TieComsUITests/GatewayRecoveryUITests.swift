import XCTest

/// Incidencia Alicia → Danny (28-sep-2026): al abrir un DM durante un despliegue se veía «bad gateway» y el chat
/// quedaba vacío. Ahora: «Reconectando…» o «chaggu se está actualizando, reintentando…», reintento solo y el borrador intacto.
///
/// Contra el API sintético local `tools/fixtures/gateway502-api.mjs` (502 HTML las primeras FAIL veces). Nunca producción.
/// Fixture por `TEST_RUNNER_TC_FIXTURE_502`; capturas en `TEST_RUNNER_TC_SHOTS`.
final class GatewayRecoveryUITests: XCTestCase {
    struct Fixture: Decodable { var apiUrl: String; var email: String; var password: String; var dmId: String; var fail: Int }

    override func setUp() { continueAfterFailure = false }

    private var env: [String: String] { ProcessInfo.processInfo.environment }

    private func fixture() throws -> Fixture {
        guard let path = env["TC_FIXTURE_502"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE_502") }
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        let host = URL(string: f.apiUrl)?.host ?? ""
        XCTAssertTrue(host == "127.0.0.1" || host == "localhost", "solo un API local")
        return f
    }

    private func shot(_ name: String) {
        let s = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: s)
        a.name = name
        a.lifetime = .keepAlways
        add(a)
        if let dir = env["TC_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    private func element(_ app: XCUIApplication, containing text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@", text)).firstMatch
    }

    private func stats(_ f: Fixture) -> [String: Int] {
        guard let data = try? Data(contentsOf: URL(string: f.apiUrl + "/__stats")!) else { return [:] }
        return (try? JSONDecoder().decode([String: Int].self, from: data)) ?? [:]
    }

    func testDMAfter502RetriesKeepsDraftAndNeverShowsBadGateway() throws {
        let f = try fixture()
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES",
                               "-TCResetLanguage", "YES", "-TCOpenConversation", f.dmId, "-AppleLanguages", "(es)", "-AppleLocale", "es_CO"]
        app.launch()
        // Con el Keychain del simulador sin firmar la sesión sintética anterior puede seguir: entonces no hay login.
        let email = app.textFields["login.email"]
        let composer = app.descendants(matching: .any)["composer.field"]
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline && !email.exists && !composer.exists { usleep(200_000) }
        if email.exists {
            email.tap(); email.typeText(f.email)
            let pw = app.secureTextFields["login.password"]
            pw.tap(); pw.typeText(f.password)
            app.buttons["login.submit"].tap()
        }
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

        // 1. Mientras el API responde 502: aviso de reintento, nunca «bad gateway».
        let reconnecting = app.descendants(matching: .any)["chat.reconnecting"]
        let until = Date().addingTimeInterval(20)
        while Date() < until && !reconnecting.exists {
            for s in [app, springboard] { for l in ["Not Now", "Ahora no"] where s.buttons[l].exists && s.buttons[l].isHittable { s.buttons[l].tap() } }
            usleep(200_000)
        }
        XCTAssertTrue(reconnecting.exists, "estado «Reconectando…» tras el 502")
        XCTAssertTrue(element(app, containing: "Reconectando").exists || element(app, containing: "chaggu se está actualizando").exists)
        XCTAssertFalse(element(app, containing: "bad gateway").exists)
        XCTAssertTrue(app.buttons["chat.retry"].exists, "botón Reintentar")
        shot("502-01-reconectando")
        app.buttons["chat.retry"].tap() // reutiliza el intento retenido; no crea una segunda carga

        // 2. El borrador escrito durante los reintentos no se pierde.
        let field = app.descendants(matching: .any)["composer.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap(); field.typeText("Borrador durante el 502")

        // 3. Se recupera sola: aparece el mensaje y sigue el borrador.
        XCTAssertTrue(element(app, containing: "Mensaje sintético después del 502").waitForExistence(timeout: 30), "chat cargado tras reintentar")
        XCTAssertFalse(reconnecting.exists)
        XCTAssertFalse(element(app, containing: "bad gateway").exists)
        let value = (field.value as? String) ?? ""
        XCTAssertTrue(value.contains("Borrador durante el 502"), "borrador conservado: \(value)")
        shot("502-02-recuperado-con-borrador")
        let hits = stats(f)["/api/v1/conversations/\(f.dmId)/messages"] ?? 0
        // Solo los GET: 502 × FAIL y un 200. Ningún POST: el borrador no se envió solo.
        XCTAssertEqual(hits, f.fail + 1, "\(f.fail) × 502 y luego 200")
        XCTAssertEqual(stats(f)["messagePOSTs"] ?? 0, 0, "el borrador no se envía")
    }
}
