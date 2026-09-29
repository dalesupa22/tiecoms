import XCTest

/// Fase 2 de la 1.7.0 (velocidad): arranque en frío hasta ver la lista con datos y de tocar un chat hasta ver sus mensajes,
/// contra el API local detrás de `tools/fixtures/latency-proxy.mjs` (~100 ms por viaje, como desde Colombia).
/// Fixture: `TEST_RUNNER_TC_FIXTURE_LLAMADAS` (llamadas-fixture.mjs) con `apiUrl` del proxy. Resultados en `TEST_RUNNER_TC_PERF_OUT`.
final class PerfUITests: XCTestCase {
    struct Fixture: Decodable {
        struct Person: Decodable { var email: String; var id: String }
        var apiUrl: String
        var password: String
        var a: Person
        var multiId: String
    }
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    private func until(_ timeout: TimeInterval, _ cond: () -> Bool) -> TimeInterval? {
        let t0 = Date()
        while Date().timeIntervalSince(t0) < timeout {
            if cond() { return Date().timeIntervalSince(t0) }
            usleep(30_000)
        }
        return nil
    }

    func testColdStartAndOpenChat() throws {
        guard let path = env["TC_FIXTURE_LLAMADAS"], !path.isEmpty else { throw XCTSkip("Sin fixture") }
        var f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        if let proxy = env["TC_PERF_API"], !proxy.isEmpty { f.apiUrl = proxy }
        // Primera vez: iniciar sesión (queda en el llavero) y abrir el chat una vez.
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES", "-AppleLanguages", "(es)"]
        app.launch()
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 15))
        email.tap(); email.typeText(f.a.email)
        let pw = app.secureTextFields["login.password"]; pw.tap(); pw.typeText(f.password)
        app.buttons["login.submit"].tap()
        XCTAssertTrue(app.buttons["tab.dms"].firstMatch.waitForExistence(timeout: 20))
        sleep(4)
        app.terminate()
        var starts: [Double] = [], opens: [Double] = []
        for _ in 0..<3 {
            let a = XCUIApplication()
            a.launchArguments = ["-TCApiURL", f.apiUrl, "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES", "-AppleLanguages", "(es)"]
            let t0 = Date()
            a.launch()
            let dms = a.buttons["tab.dms"].firstMatch
            // Lista con datos: el globo de DMs (no leídos del bootstrap) ya está.
            _ = until(30) { dms.exists && !((dms.value as? String) ?? "").isEmpty }
            starts.append(Date().timeIntervalSince(t0))
            dms.tap()
            let row = a.buttons["conv.row.\(f.multiId)"].firstMatch
            _ = until(15) { row.exists && row.isHittable }
            let t1 = Date()
            row.tap()
            let msg = a.staticTexts["¿Quién revisa el acta?"].firstMatch
            _ = until(20) { msg.exists }
            opens.append(Date().timeIntervalSince(t1))
            sleep(2)
            a.terminate()
        }
        let out = String(format: "arranque (s): %@\nabrir chat (s): %@\n", starts.map { String(format: "%.2f", $0) }.joined(separator: ", "),
                         opens.map { String(format: "%.2f", $0) }.joined(separator: ", "))
        print("PERF\n" + out)
        if let o = env["TC_PERF_OUT"], !o.isEmpty { try? out.write(toFile: o, atomically: true, encoding: .utf8) }
    }
}
