import XCTest

/// «Actualización disponible» contra un API de PRUEBAS con /app-version (latestBuild 24). Build simulado con
/// `-TCBuildOverride` (solo Debug). Fixture: `TEST_RUNNER_TC_TEMAS_FIXTURE` (el de TemasUITests).
final class UpdateUITests: XCTestCase {
    struct Fixture: Decodable { var apiUrl: String; var email: String; var password: String; var conversationId: String }
    override func setUp() { continueAfterFailure = false }

    private func fixture() throws -> Fixture {
        guard let path = ProcessInfo.processInfo.environment["TC_TEMAS_FIXTURE"], !path.isEmpty else { throw XCTSkip("Sin TC_TEMAS_FIXTURE") }
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
    }

    private func shot(_ name: String) {
        let s = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: s); a.name = name; a.lifetime = .keepAlways; add(a)
        if let dir = ProcessInfo.processInfo.environment["TC_SHOTS"], !dir.isEmpty {
            try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    private func launch(build: Int, _ f: Fixture, reset: Bool = true) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", f.apiUrl, "-TCNoSplash", "YES", "-TCNoPushPrompt", "YES", "-TCBuildOverride", "\(build)",
                               "-TCOpenConversation", f.conversationId, "-AppleLanguages", "(es)", "-AppleLocale", "es_CO"]
        if reset { app.launchArguments += ["-TCResetSession", "YES"] }
        app.launch()
        return app
    }

    func testBannerWithOldBuildAndNotWithCurrent() throws {
        let f = try fixture()
        XCTAssertFalse(f.apiUrl.contains("app.chaggu.com") || f.apiUrl.contains("app.tiecoms.com"), "no se prueba contra producción")
        // Build 23: la franja sale también sin sesión (en el login), sin tapar el formulario.
        var app = launch(build: 23, f)
        let banner = app.descendants(matching: .any)["update.banner"]
        XCTAssertTrue(banner.waitForExistence(timeout: 15), "franja con build 23 < 24")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Actualización disponible · chaggu 1.6.7")).firstMatch.exists)
        XCTAssertTrue(app.buttons["update.button"].exists)
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 5))
        email.tap(); email.typeText(f.email)
        let password = app.secureTextFields["login.password"]
        password.tap(); password.typeText(f.password)
        app.buttons["login.submit"].tap()
        for label in ["Not Now", "Ahora no"] {
            let b = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons[label]
            if b.waitForExistence(timeout: 2) { b.tap() }
        }
        // En el chat: la franja arriba y la cabecera, las banderitas y el compositor debajo, a la vista.
        let field = app.descendants(matching: .any)["composer.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 20))
        XCTAssertTrue(banner.exists, "sigue fija dentro de la app")
        let header = app.descendants(matching: .any)["chat.header"]
        let bar = app.descendants(matching: .any)["chat.bar"]
        XCTAssertTrue(bar.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(banner.frame.maxY, header.frame.minY + 1, "empuja la cabecera hacia abajo (no la tapa)")
        XCTAssertLessThanOrEqual(banner.frame.maxY, bar.frame.minY, "ni la barra de accesos")
        // El teclado del chat se comporta igual: se escribe y la franja no se mueve.
        sleep(2) // el chat termina de ubicarse en el primer no leído
        field.tap()
        if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }
        field.typeText("hola")
        XCTAssertTrue(banner.exists)
        XCTAssertTrue(app.buttons["composer.send"].isHittable)
        app.tap()
        sleep(1)
        shot("ios-update")

        // Build 24 (el publicado): sin franja.
        app.terminate()
        app = launch(build: 24, f, reset: false)
        XCTAssertTrue(app.descendants(matching: .any)["composer.field"].waitForExistence(timeout: 20))
        sleep(2)
        XCTAssertFalse(app.descendants(matching: .any)["update.banner"].exists, "build 24 = latestBuild: sin franja")
        shot("ios-update-24")
    }
}
