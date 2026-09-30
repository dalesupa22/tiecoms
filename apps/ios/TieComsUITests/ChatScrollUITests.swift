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
        func covers() -> Bool { long.frame.minY < screen.midY - 100 && long.frame.maxY > screen.midY + 100 }
        // Más de 40 líneas: llega plegado a 30 con «Ver más». Se despliega (120 líneas, mucho más alto que la pantalla).
        let more = app.buttons["msg.readMore.\(f.longMessageId)"].firstMatch
        XCTAssertTrue(more.waitForExistence(timeout: 5), "el mensaje muy largo trae «Ver más»")
        XCTAssertEqual(more.label, "Ver más")
        for _ in 0..<12 where !(more.isHittable && more.frame.minY > screen.height * 0.25 && more.frame.maxY < screen.height * 0.8) {
            if more.frame.midY < screen.height * 0.5 { drag(app, from: 0.38, to: 0.62) } else { drag(app, from: 0.62, to: 0.38) }
        }
        let collapsedH = long.frame.height
        more.tap()
        let expanded = app.buttons["msg.readMore.\(f.longMessageId)"].firstMatch
        XCTAssertTrue(NSPredicate(format: "label == 'Ver menos'").evaluate(with: expanded) || { sleep(1); return expanded.label == "Ver menos" }(),
                      "«Ver más» cambia a «Ver menos»")
        XCTAssertGreaterThan(long.frame.height, collapsedH * 2.5, "desplegado muestra las 120 líneas (\(collapsedH) → \(long.frame.height))")
        XCTAssertGreaterThan(long.frame.height, screen.height * 1.5, "más alto que la pantalla")
        // Llevar su final a la parte baja de la pantalla, para cruzarlo entero hacia arriba.
        for _ in 0..<16 where long.frame.maxY > screen.height * 0.8 { drag(app, from: 0.72, to: 0.38) }
        // Llevar el mensaje largo a cubrir el centro, venga de arriba o de abajo.
        for _ in 0..<16 where !covers() {
            if long.frame.maxY < screen.midY { drag(app, from: 0.38, to: 0.72) } else { drag(app, from: 0.72, to: 0.38) }
        }
        XCTAssertTrue(covers(), "el mensaje largo cubre la pantalla: \(long.frame)")
        shot(tag + "171-02-largo-en-pantalla")
        // Cruzar el largo en ambos sentidos, cada arrastre EMPEZANDO sobre la burbuja: tiene que moverse.
        func cross(forward: Bool) -> Int {
            var moved = 0
            let y: CGFloat = forward ? 0.62 : 0.34
            for _ in 0..<16 {
                let start = CGPoint(x: screen.width * 0.55, y: screen.height * y)
                guard long.frame.contains(start) else { break }
                let before = long.frame.minY
                drag(app, from: y, to: forward ? 0.30 : 0.66)
                let delta = abs(long.frame.minY - before)
                XCTAssertGreaterThan(delta, 80, "un arrastre que empieza sobre la burbuja larga desplaza el chat (\(before) → \(long.frame.minY))")
                if delta > 80 { moved += 1 }
            }
            return moved
        }
        // Hacia arriba del chat, cruzando todo el largo (empezando por su final), hasta el primero de antes.
        XCTAssertGreaterThan(cross(forward: false), 3, "hacia arriba del chat, sobre la burbuja larga")
        let first = text(app, "corto antes 1")
        for _ in 0..<20 where !(first.exists && first.isHittable) { drag(app, from: 0.35, to: 0.70) }
        XCTAssertTrue(first.exists && first.isHittable, "llega al primero de antes del largo")
        shot(tag + "171-03-arriba")
        // Y de vuelta hacia abajo, cruzando todo el largo desde su inicio: nada se pierde, hasta el último.
        for _ in 0..<16 where !covers() { drag(app, from: 0.72, to: 0.38) }
        XCTAssertTrue(covers(), "de vuelta sobre el largo")
        XCTAssertGreaterThan(cross(forward: true), 3, "hacia abajo del chat, sobre la burbuja larga")
        let last = text(app, "ÚLTIMO MENSAJE CORTO")
        for _ in 0..<10 where !(last.exists && last.isHittable) { drag(app, from: 0.62, to: 0.30) }
        XCTAssertTrue(last.exists && last.isHittable, "llega al último mensaje")
        XCTAssertTrue(text(app, "corto después 1").exists, "el primero después del largo sigue ahí")
        XCTAssertFalse(app.descendants(matching: .any)["composer.replyBar"].exists, "arrastrar en vertical no abre la respuesta")
        shot(tag + "171-04-final")
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
        field.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
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
