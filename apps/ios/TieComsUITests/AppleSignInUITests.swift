import XCTest

/// Layout/consent only against a closed local port. This does not authenticate an Apple Account.
final class AppleSignInUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testAppleIsNativeVisibleAndEquivalentOnLoginAndSignup() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-TCApiURL", "http://127.0.0.1:9", "-TCResetSession", "YES", "-TCNoSplash", "YES",
            "-TCNoPushPrompt", "YES", "-TCResetLanguage", "YES", "-AppleLanguages", "(es)", "-AppleLocale", "es_CO"]
        app.launch()
        let apple = app.buttons["login.sso.apple"]
        let google = app.buttons["login.sso.google"]
        XCTAssertTrue(apple.waitForExistence(timeout: 15))
        XCTAssertTrue(google.exists)
        XCTAssertFalse(apple.isEnabled)
        XCTAssertFalse(google.isEnabled)
        XCTAssertEqual(apple.frame.height, google.frame.height, accuracy: 1)
        XCTAssertEqual(apple.frame.width, google.frame.width, accuracy: 2)
        XCTAssertLessThan(apple.frame.minY, google.frame.minY)
        app.switches["login.acceptTerms"].tap()
        XCTAssertTrue(apple.isEnabled)
        XCTAssertTrue(google.isEnabled)
        shot("apple-login")
        let create = app.buttons["login.createAccount"]
        if !create.isHittable { app.swipeUp() }
        create.tap()
        let signupApple = app.buttons["signup.sso.apple"]
        XCTAssertTrue(signupApple.waitForExistence(timeout: 8))
        XCTAssertFalse(signupApple.isEnabled)
        app.switches["signup.acceptTerms"].tap()
        XCTAssertTrue(signupApple.isEnabled)
        XCTAssertEqual(signupApple.frame.height, app.buttons["signup.sso.google"].frame.height, accuracy: 1)
        shot("apple-signup")
        app.terminate()
    }

    private func shot(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let directory = ProcessInfo.processInfo.environment["TC_SHOTS"] {
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: directory).appendingPathComponent(name + ".png"))
        }
    }
}
