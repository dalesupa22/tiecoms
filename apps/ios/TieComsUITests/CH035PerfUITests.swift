import XCTest

/// CH035 (fluidez, tanda 2): cuánto trabajo hace la app en tres momentos — escribir en un chat, un mensaje que llega a
/// OTRO chat mientras este está abierto, y abrir un chat y volver. La app escribe sus contadores (`PerfCounters`,
/// `-TCPerfOut`) y la prueba resta lo de antes y después de cada tramo.
/// Fixture: `TEST_RUNNER_TC_FIXTURE_CH035`, la API sintética con socket `tools/fixtures/ch035-perf-api.mjs` (sin base de datos). Resultado en `TEST_RUNNER_TC_PERF_OUT`.
final class CH035PerfUITests: XCTestCase {
    struct Fixture: Decodable {
        var apiUrl: String
        var email: String
        var password: String
        var dmId: String
        var otherId: String
    }
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    private func counters(_ path: String) -> [String: Int] {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        var out: [String: Int] = [:]
        for (k, v) in obj["counts"] as? [String: Int] ?? [:] { out[k] = v }
        for (k, v) in obj["micros"] as? [String: Int] ?? [:] { out[k + ".us"] = v }
        return out
    }

    private func diff(_ a: [String: Int], _ b: [String: Int]) -> [String: Int] {
        var out: [String: Int] = [:]
        for k in Set(a.keys).union(b.keys) { let d = (b[k] ?? 0) - (a[k] ?? 0); if d != 0 { out[k] = d } }
        return out
    }

    /// Órdenes a la API sintética (`/__say`, `/__typing`): eventos en vivo por su socket.
    private func fixture(_ f: Fixture, _ path: String, _ body: [String: Any]) {
        var req = URLRequest(url: URL(string: "\(f.apiUrl)\(path)")!)
        req.httpMethod = "POST"
        req.httpBody = try? JSONSerialization.data(withJSONObject: body); req.setValue("application/json", forHTTPHeaderField: "content-type")
        let sem = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { _, _, _ in sem.signal() }.resume()
        sem.wait()
    }

    func testTypingOtherChatEventAndOpenBack() throws {
        guard let path = env["TC_FIXTURE_CH035"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE_CH035") }
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        let perf = (env["TC_PERF_DIR"].flatMap { $0.isEmpty ? nil : $0 } ?? NSTemporaryDirectory()) + "/chaggu-perf-\(UUID().uuidString).json"
        guard URL(string: f.apiUrl)?.host == "127.0.0.1" else { throw XCTSkip("Solo la API sintética local") }
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES", "-TCResetLanguage", "YES",
                               "-AppleLanguages", "(es)", "-AppleLocale", "es_CO", "-TCPerfOut", perf]
        app.launch()
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 15))
        email.tap(); email.typeText(f.email)
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
        for _ in 0..<4 where !row.exists { dms.tap(); _ = row.waitForExistence(timeout: 5) }
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        sleep(2)
        var results: [String: [String: Int]] = [:]
        let field = app.textViews["composer.field"]

        // Tramo 1: abrir el chat (120 mensajes) y esperar a que quede quieto.
        var t0 = counters(perf)
        row.tap()
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        sleep(4)
        results["open"] = diff(t0, counters(perf))

        // Tramo 2: llegan 3 mensajes a OTRO chat con este abierto.
        t0 = counters(perf)
        for i in 1...3 { fixture(f, "/__say", ["conv": f.otherId, "body": "Aviso \(i) en el otro chat"]); sleep(1) }
        sleep(2)
        results["otherChatMessages3"] = diff(t0, counters(perf))

        // Tramo 3: alguien escribe en OTRO chat (3 avisos de «escribiendo…», cada uno caduca a los 4 s).
        t0 = counters(perf)
        for _ in 1...3 { fixture(f, "/__typing", ["conv": f.otherId]); sleep(1) }
        sleep(5)
        results["otherChatTyping3"] = diff(t0, counters(perf))

        // Tramo 4: escribir 20 letras.
        field.tap()
        sleep(1)
        t0 = counters(perf)
        field.typeText("hola que tal, prueba")
        sleep(1)
        results["typing20"] = diff(t0, counters(perf))

        // Tramo 5: enviar lo escrito (burbuja pendiente → confirmada).
        t0 = counters(perf)
        app.buttons["composer.send"].tap()
        sleep(3)
        results["send1"] = diff(t0, counters(perf))

        // Tramo 6: un mensaje llega a ESTE chat (una fila nueva).
        t0 = counters(perf)
        fixture(f, "/__say", ["conv": f.dmId, "body": "Uno nuevo aquí"])
        sleep(3)
        results["thisChatMessage1"] = diff(t0, counters(perf))

        // Tramo 7: volver a la lista, y abrir de nuevo (ya en memoria).
        t0 = counters(perf)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        sleep(2)
        results["back"] = diff(t0, counters(perf))
        // Tramo 8: en la lista, llegan 3 mensajes a otro chat.
        t0 = counters(perf)
        for i in 4...6 { fixture(f, "/__say", ["conv": f.otherId, "body": "Aviso \(i) en el otro chat"]); sleep(1) }
        sleep(2)
        results["listOtherChatMessages3"] = diff(t0, counters(perf))
        t0 = counters(perf)
        row.tap()
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        sleep(3)
        results["reopen"] = diff(t0, counters(perf))

        var lines: [String] = []
        for k in ["open", "otherChatMessages3", "otherChatTyping3", "typing20", "send1", "thisChatMessage1", "back", "listOtherChatMessages3", "reopen"] {
            let r = results[k] ?? [:]
            lines.append("\(k): " + r.keys.sorted().map { "\($0)=\(r[$0]!)" }.joined(separator: " "))
        }
        let out = lines.joined(separator: "\n")
        print("PERFCH035\n" + out)
        let a = XCTAttachment(string: out); a.name = "perfCH035"; a.lifetime = .keepAlways; add(a)
        if let o = env["TC_PERF_OUT"], !o.isEmpty { try? out.write(toFile: o, atomically: true, encoding: .utf8) }
        XCTAssertFalse(results["open"]?.isEmpty ?? true, "la app escribió contadores")
    }
}
