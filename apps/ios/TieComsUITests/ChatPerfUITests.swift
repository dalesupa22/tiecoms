import XCTest

/// 1.7.1 (velocidad): cuánto trabajo hace la app al desplazar un chat largo y la lista de Inicio. La app escribe sus
/// contadores (`PerfCounters`, `-TCPerfOut`) y la prueba resta lo de antes y después de cada tramo.
/// Fixture: `TEST_RUNNER_TC_FIXTURE_LONG` con `dmId` sembrado con ~250 mensajes (tools/fixtures/seed-many.mjs).
/// Resultado en `TEST_RUNNER_TC_PERF_OUT` (JSON) y en el registro de la prueba.
final class ChatPerfUITests: XCTestCase {
    struct Fixture: Decodable {
        struct Person: Decodable { var email: String; var id: String }
        var apiUrl: String
        var password: String
        var a: Person
        var dmId: String
    }
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    private func counters(_ path: String) -> [String: Int] {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        var out: [String: Int] = [:]
        for (k, v) in obj["counts"] as? [String: Int] ?? [:] { out[k] = v }
        for (k, v) in obj["micros"] as? [String: Int] ?? [:] { out[k + ".us"] = v }
        out["bubble.cacheHits"] = obj["bubbleHits"] as? Int ?? 0
        out["bubble.cacheMisses"] = obj["bubbleMisses"] as? Int ?? 0
        return out
    }

    private func diff(_ a: [String: Int], _ b: [String: Int]) -> [String: Int] {
        var out: [String: Int] = [:]
        for k in Set(a.keys).union(b.keys) { let d = (b[k] ?? 0) - (a[k] ?? 0); if d != 0 { out[k] = d } }
        return out
    }

    private func drag(_ app: XCUIApplication, from y: CGFloat, to y2: CGFloat) {
        let a = app.coordinate(withNormalizedOffset: CGVector(dx: 0.55, dy: y))
        a.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.55, dy: y2)),
                withVelocity: XCUIGestureVelocity(1400), thenHoldForDuration: 0.05)
    }

    func testScrollLongChatAndHomeCounters() throws {
        guard let path = env["TC_FIXTURE_LONG"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE_LONG") }
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        let perf = (env["TC_PERF_DIR"].flatMap { $0.isEmpty ? nil : $0 } ?? NSTemporaryDirectory()) + "/chaggu-perf-\(UUID().uuidString).json"
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES", "-TCResetLanguage", "YES",
                               "-AppleLanguages", "(es)", "-AppleLocale", "es_CO", "-TCPerfOut", perf]
        app.launch()
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 15))
        email.tap(); email.typeText(f.a.email)
        let pw = app.secureTextFields["login.password"]; pw.tap(); pw.typeText(f.password)
        app.buttons["login.submit"].tap()
        let spring = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for _ in 0..<10 {
            let b = [app.buttons["Not Now"], spring.buttons["Not Now"], app.buttons["Ahora no"], spring.buttons["Ahora no"]].first { $0.exists }
            if let b { b.tap(); break }
            usleep(300_000)
        }
        let dms = app.buttons["tab.dms"].firstMatch
        XCTAssertTrue(dms.waitForExistence(timeout: 20))
        let row = app.buttons["conv.row.\(f.dmId)"].firstMatch
        // Recién entrado, el primer toque a la pestaña a veces se pierde: se reintenta.
        for _ in 0..<4 where !row.exists { dms.tap(); _ = row.waitForExistence(timeout: 5) }
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        sleep(2)
        // Tramo 1: la lista de DMs, arriba y abajo.
        var t0 = counters(perf)
        var start = Date()
        for _ in 0..<4 { drag(app, from: 0.75, to: 0.35) }
        for _ in 0..<4 { drag(app, from: 0.35, to: 0.75) }
        sleep(1)
        var results: [String: [String: Int]] = [:]
        var times: [String: Double] = [:]
        times["dmsList"] = Date().timeIntervalSince(start)
        results["dmsList"] = diff(t0, counters(perf))
        // Tramo 2: abrir el chat largo.
        t0 = counters(perf)
        start = Date()
        row.tap()
        XCTAssertTrue(app.textViews["composer.field"].waitForExistence(timeout: 15))
        sleep(3)
        times["openChat"] = Date().timeIntervalSince(start)
        results["openChat"] = diff(t0, counters(perf))
        // Tramo 3: 12 arrastres hacia arriba del chat (carga páginas viejas) y 12 hacia abajo.
        t0 = counters(perf)
        start = Date()
        for _ in 0..<12 { drag(app, from: 0.30, to: 0.75) }
        for _ in 0..<12 { drag(app, from: 0.75, to: 0.30) }
        sleep(1)
        times["scrollChat"] = Date().timeIntervalSince(start)
        results["scrollChat"] = diff(t0, counters(perf))
        // Tramo 4: escribir 20 letras (cada tecla vuelve a pintar el chat).
        t0 = counters(perf)
        start = Date()
        let field = app.textViews["composer.field"]
        field.tap()
        field.typeText("hola que tal, prueba")
        sleep(1)
        times["typing"] = Date().timeIntervalSince(start)
        results["typing"] = diff(t0, counters(perf))

        var lines: [String] = []
        for k in ["dmsList", "openChat", "scrollChat", "typing"] {
            let r = results[k] ?? [:]
            lines.append("\(k) (\(String(format: "%.1f", times[k] ?? 0)) s): " + r.keys.sorted().map { "\($0)=\(r[$0]!)" }.joined(separator: " "))
        }
        let out = lines.joined(separator: "\n")
        print("PERF171\n" + out)
        let a = XCTAttachment(string: out); a.name = "perf171"; a.lifetime = .keepAlways; add(a)
        if let o = env["TC_PERF_OUT"], !o.isEmpty { try? out.write(toFile: o, atomically: true, encoding: .utf8) }
        XCTAssertFalse(results["scrollChat"]?.isEmpty ?? true, "la app escribió contadores")
    }
}
