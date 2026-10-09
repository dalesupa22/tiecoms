import XCTest
import UIKit

/// 1.7.1: un mensaje más alto que la pantalla no bloquea el scroll (ni se pierden mensajes) y deslizar un mensaje a la
/// derecha abre la respuesta citada (no un sidechat). Contra el API local con `TEST_RUNNER_TC_FIXTURE_LONG`: el fixture de
/// llamadas (`apiUrl`, `password`, `a`, `multiId`) + `longMessageId`, sembrado con 15 cortos, un mensaje de 120 líneas
/// (~5000 caracteres) y 15 cortos (el último «ÚLTIMO MENSAJE CORTO»), escritos por otra persona del chat.
final class ChatScrollUITests: XCTestCase {
    struct Fixture: Decodable {
        struct Person: Decodable { var email: String; var id: String }
        var apiUrl: String
        var password: String
        var a: Person
        var multiId: String
        var longMessageId: String
    }
    override func setUp() { continueAfterFailure = false }
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    private func shot(_ name: String) {
        let s = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: s); a.name = name; a.lifetime = .keepAlways; add(a)
        if let dir = env["TC_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    private func openChat(lazy: Bool = false) throws -> (XCUIApplication, Fixture) {
        guard let path = env["TC_FIXTURE_LONG"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE_LONG") }
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCResetSession", "YES", "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES", "-TCResetLanguage", "YES",
                               "-AppleLanguages", "(es)", "-AppleLocale", "es_CO", "-TCOpenConversation", f.multiId] + (lazy ? ["-TCLazyAbove", "0"] : [])
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
        if !app.textViews["composer.field"].waitForExistence(timeout: 8) {
            let dms = app.buttons["tab.dms"].firstMatch
            XCTAssertTrue(dms.waitForExistence(timeout: 15)); dms.tap()
            let row = app.buttons["conv.row.\(f.multiId)"].firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 15)); row.tap()
        }
        XCTAssertTrue(app.textViews["composer.field"].waitForExistence(timeout: 15))
        // «Save Password?» del sistema puede salir unos segundos después del login y tapa el chat: se cierra.
        for _ in 0..<20 {
            let b = [app.buttons["Not Now"], spring.buttons["Not Now"], app.buttons["Ahora no"], spring.buttons["Ahora no"]].first { $0.exists }
            if let b { b.tap(); break }
            usleep(300_000)
        }
        return (app, f)
    }

    private func text(_ app: XCUIApplication, _ s: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", s)).firstMatch
    }

    /// Arrastre vertical que empieza en `y` (fracción de la pantalla).
    private func drag(_ app: XCUIApplication, from y: CGFloat, to y2: CGFloat) {
        let a = app.coordinate(withNormalizedOffset: CGVector(dx: 0.55, dy: y))
        // Sin inercia (se sostiene al final): cada arrastre mueve lo que recorre el dedo.
        a.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.55, dy: y2)),
                withVelocity: XCUIGestureVelocity(900), thenHoldForDuration: 0.15)
    }

    func testLongMessageScrollsFromInsideTheBubbleAndNothingIsLost() throws { try longMessage(lazy: false) }
    /// Chats con historial largo (más de 200 filas) usan la LazyVStack: mismo recorrido con la pila perezosa.
    func testLongMessageScrollsInLazyStack() throws { try longMessage(lazy: true) }

    private func longMessage(lazy: Bool) throws {
        let (app, f) = try openChat(lazy: lazy)
        let tag = lazy ? "lazy-" : ""
        let long = app.descendants(matching: .any)["msg.\(f.longMessageId)"].firstMatch
        XCTAssertTrue(long.waitForExistence(timeout: 15), "el mensaje largo está en el chat")
        sleep(2)
        shot(tag + "171-01-abierto")
        let screen = app.windows.firstMatch.frame
        // Mensajes largos llegan plegados a 8 líneas y abren un lector con el cuerpo completo.
        let more = app.buttons["msg.readMore.\(f.longMessageId)"].firstMatch
        XCTAssertTrue(more.waitForExistence(timeout: 5), "el mensaje muy largo trae «Ver más»")
        XCTAssertEqual(more.label, "Ver más")
        for _ in 0..<12 where !(more.isHittable && more.frame.minY > screen.height * 0.25 && more.frame.maxY < screen.height * 0.8) {
            if more.frame.midY < screen.height * 0.5 { drag(app, from: 0.38, to: 0.62) } else { drag(app, from: 0.62, to: 0.38) }
        }
        let collapsedH = long.frame.height
        // Both stacks keep the row bounded and open the full, independently scrolling text.
        more.tap()
        let body = app.textViews["longText.body"].firstMatch
        XCTAssertTrue(body.waitForExistence(timeout: 5), "lector con el texto completo")
        XCTAssertTrue((body.value as? String)?.contains("Línea 120") == true, "trae las 120 líneas")
        shot(tag + "171-02-lector")
        body.swipeUp()
        app.buttons["longText.close"].tap()
        XCTAssertTrue(more.waitForExistence(timeout: 5))
        XCTAssertEqual(long.frame.height, collapsedH, accuracy: 4, "la fila sigue plegada")
        let first = text(app, "corto antes 1")
        for _ in 0..<25 where !(first.exists && first.isHittable) { drag(app, from: 0.35, to: 0.70) }
        XCTAssertTrue(first.exists && first.isHittable, "llega al primero de antes del largo")
        let last = text(app, "ÚLTIMO MENSAJE CORTO")
        for _ in 0..<25 where !(last.exists && last.isHittable) { drag(app, from: 0.70, to: 0.30) }
        XCTAssertTrue(last.exists && last.isHittable, "llega al último mensaje")
        shot(tag + "171-04-final")
    }

    /// Pila perezosa con filas altas (foto vertical de 3000 px, video vertical, PDF, 30 enlaces, tarjeta de tarea, de evento y
    /// de correo con comentarios): ninguna pasa de ≈ 60 % de lo visible y el chat se recorre de punta a punta sin congelarse.
    /// Fixture: `tools/fixtures/tall-rows-fixture.mjs` por `TEST_RUNNER_TC_FIXTURE_TALL`.
    func testTallRowsInLazyStack() throws { try tallRows(lazy: true) }
    /// Lo mismo en la pila normal (control).
    func testTallRowsInNormalStack() throws { try tallRows(lazy: false) }

    private func tallRows(lazy: Bool) throws {
        guard let path = env["TC_FIXTURE_TALL"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE_TALL") }
        setenv("TC_FIXTURE_LONG", path, 1)
        let (app, _) = try openChat(lazy: lazy)
        let screen = app.windows.firstMatch.frame
        let last = text(app, "ÚLTIMO MENSAJE CORTO")
        if !last.waitForExistence(timeout: 15) { for _ in 0..<40 where !last.exists { drag(app, from: 0.80, to: 0.30) } }
        XCTAssertTrue(last.exists, "llega al final")
        shot((lazy ? "lazy-" : "normal-") + "altas-01-final")
        // Hacia arriba hasta el primero, revisando que ninguna fila visible pase del tope.
        let first = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "corto 1")).firstMatch
        var tallest: CGFloat = 0
        var step = 0, stubs = 0
        for _ in 0..<80 where !(first.exists && first.isHittable && first.label == "corto 1") {
            drag(app, from: 0.30, to: 0.80)
            step += 1
            if app.buttons["row.showAll"].exists { stubs += 1; if stubs == 1 { shot("lazy-altas-01b-ver-completo") } }
            if step % 10 == 0 { shot((lazy ? "lazy-" : "normal-") + "altas-paso-\(step)") }
            for id in ["msg.", "mailCard.", "taskCard.", "eventCard."] {
                let rows = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", id)).allElementsBoundByIndex.prefix(6)
                for r in rows where r.exists { tallest = max(tallest, r.frame.height) }
            }
        }
        XCTAssertTrue(first.exists, "llega al primer mensaje (carga las páginas viejas)")
        shot("lazy-altas-02-arriba")
        XCTAssertLessThan(tallest, screen.height * 0.75, "ninguna fila pasa del tope (la más alta: \(tallest) de \(screen.height))")
        for _ in 0..<80 where !(last.exists && last.isHittable) { drag(app, from: 0.80, to: 0.30) }
        XCTAssertTrue(last.exists && last.isHittable, "vuelve al último")
        shot("lazy-altas-03-abajo")
    }

    func testSwipeRightRepliesWithQuoteNotSidechat() throws {
        let (app, _) = try openChat()
        let target = text(app, "ÚLTIMO MENSAJE CORTO")
        XCTAssertTrue(target.waitForExistence(timeout: 15))
        for _ in 0..<12 where !target.isHittable { drag(app, from: 0.62, to: 0.30) }
        XCTAssertTrue(target.isHittable)
        // Deslizar a la derecha sobre la burbuja (más de 60 pt).
        let start = target.coordinate(withNormalizedOffset: CGVector(dx: 0.35, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 150, dy: 0)), withVelocity: .slow, thenHoldForDuration: 0.1)
        let bar = app.descendants(matching: .any)["composer.replyBar"].firstMatch
        XCTAssertTrue(bar.waitForExistence(timeout: 4), "deslizar a la derecha abre la respuesta citada")
        XCTAssertTrue(text(app, "ÚLTIMO MENSAJE CORTO").exists)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 4), "con el teclado arriba")
        XCTAssertFalse(app.descendants(matching: .any)["side.new"].exists, "no abre «Preguntar en un sidechat»")
        shot("171-05-respuesta")
        // Se envía como respuesta: la burbuja nueva lleva la cita.
        let field = app.textViews["composer.field"]
        field.typeText("respuesta por deslizar")
        app.buttons["composer.send"].tap()
        XCTAssertTrue(text(app, "respuesta por deslizar").waitForExistence(timeout: 10))
        XCTAssertFalse(bar.exists, "la barra de respuesta se cierra al enviar")
        // Un deslizamiento corto (menos del umbral) no responde.
        let other = text(app, "corto después 14")
        if other.isHittable {
            let s2 = other.coordinate(withNormalizedOffset: CGVector(dx: 0.35, dy: 0.5))
            s2.press(forDuration: 0.05, thenDragTo: s2.withOffset(CGVector(dx: 30, dy: 0)), withVelocity: .slow, thenHoldForDuration: 0.05)
            sleep(1)
            XCTAssertFalse(bar.exists, "menos de 60 pt no responde")
        }
        shot("171-06-enviada")
    }

    /// Pegar una imagen copiada (menú «Pegar» del compositor): queda en la bandeja de adjuntos y se envía.
    func testPasteImageFromClipboardStagesAndSends() throws {
        let (app, _) = try openChat()
        let f = UIGraphicsImageRendererFormat(); f.scale = 1
        let img = UIGraphicsImageRenderer(size: CGSize(width: 120, height: 80), format: f).image { ctx in
            UIColor.systemTeal.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 120, height: 80))
        }
        UIPasteboard.general.image = img
        let field = app.textViews["composer.field"]
        // A veces el primer toque no enfoca el campo (otra ventana lo tapa para XCTest): se reintenta.
        for _ in 0..<3 where !app.keyboards.firstMatch.exists {
            if field.isHittable { field.tap() } else { field.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
            _ = app.keyboards.firstMatch.waitForExistence(timeout: 4)
        }
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        // Menú de edición: una pulsación sobre el campo con el cursor muestra «Pegar».
        field.press(forDuration: 1.0)
        let paste = app.descendants(matching: .any).matching(NSPredicate(format: "label IN %@ AND (elementType == %d OR elementType == %d)",
                                                                         ["Pegar", "Paste"], XCUIElement.ElementType.menuItem.rawValue,
                                                                         XCUIElement.ElementType.button.rawValue)).firstMatch
        if !paste.waitForExistence(timeout: 3) { field.tap(); _ = paste.waitForExistence(timeout: 3) }
        XCTAssertTrue(paste.exists, "«Pegar» aparece con una imagen en el portapapeles")
        shot("171-07-menu-pegar")
        paste.tap()
        let staged = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'staged.pegada-'")).firstMatch
        XCTAssertTrue(staged.waitForExistence(timeout: 8), "la imagen pegada queda en la bandeja de adjuntos")
        XCTAssertEqual((field.value as? String).map { $0.contains("http") } ?? false, false, "no se pega como texto")
        shot("171-08-pegada")
        app.buttons["composer.send"].tap()
        let gone = NSPredicate(format: "exists == false")
        expectation(for: gone, evaluatedWith: staged)
        waitForExpectations(timeout: 20)
        shot("171-09-enviada")
    }
}
