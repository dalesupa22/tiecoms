import XCTest
@testable import TieComs

/// 1.6.2: idioma elegido en la app (Tú › Idioma), «Subjects» en inglés y la línea de seguridad del splash.
@MainActor
final class V9LanguageSubjectsTests: XCTestCase {
    private var saved: L10n.Choice = .system

    override func setUp() { saved = L10n.choice }
    override func tearDown() { L10n.choice = saved }

    private func strings(_ lang: String) throws -> [String: String] {
        let path = try XCTUnwrap(Bundle.main.path(forResource: "Localizable", ofType: "strings", inDirectory: nil, forLocalization: lang))
        return try XCTUnwrap(NSDictionary(contentsOfFile: path) as? [String: String])
    }

    /// La marca se escribe «chaggu», en minúscula, en todo texto visible (1.6.4 build 20).
    func testBrandIsLowercaseEverywhere() throws {
        for lang in ["es", "en"] {
            let bad = try strings(lang).filter { $0.value.contains("Chaggu") }
            XCTAssertTrue(bad.isEmpty, "\(lang): \(bad.keys.sorted())")
            let path = try XCTUnwrap(Bundle.main.path(forResource: "InfoPlist", ofType: "strings", inDirectory: nil, forLocalization: lang))
            let info = try XCTUnwrap(NSDictionary(contentsOfFile: path) as? [String: String])
            XCTAssertEqual(info["CFBundleDisplayName"], "chaggu")
            XCTAssertFalse(info.values.contains { $0.contains("Chaggu") }, lang)
        }
        XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String, "chaggu")
        XCTAssertEqual(Bundle.main.bundleIdentifier, "com.chaggu.app", "el bundle ID no cambia")
    }

    func testNoEnglishTextSaysIssue() throws {
        let en = try strings("en")
        let leftovers = en.filter { $0.value.range(of: #"\bissues?\b"#, options: [.regularExpression, .caseInsensitive]) != nil }
        XCTAssertTrue(leftovers.isEmpty, "en inglés son «Subjects»: \(leftovers.keys.sorted())")
        XCTAssertEqual(en["tab.issues"], "Subjects")
        XCTAssertEqual(en["grp.moreIssues"], "+{n} subjects")
        XCTAssertEqual(en["issue.create"], "Create subject")
        XCTAssertEqual(en["issue.chipOne"], "◆ 1 subject")
        // En español siguen siendo «asuntos».
        let es = try strings("es")
        XCTAssertEqual(es["tab.issues"], "Asuntos")
        XCTAssertEqual(es["grp.moreIssues"], "+{n} asuntos")
        XCTAssertTrue(es.values.allSatisfy { $0.range(of: #"\b(issue|subject)s?\b"#, options: [.regularExpression, .caseInsensitive]) == nil })
    }

    func testLanguageChoiceAppliesAtOncePersistsAndFormats() {
        L10n.choice = .en
        XCTAssertEqual(L10n.lang, "en")
        XCTAssertEqual(L("tab.issues"), "Subjects", "cambia sin reiniciar")
        XCTAssertEqual(L10n.locale.identifier, "en-US")
        XCTAssertEqual(UserDefaults.standard.stringArray(forKey: "AppleLanguages"), ["en"], "los textos del sistema siguen al próximo arranque")
        L10n.choice = .es
        XCTAssertEqual(L("tab.issues"), "Asuntos")
        XCTAssertEqual(L("splash.secure"), "Conexión cifrada para proteger tu información")
        XCTAssertEqual(L10n.defaults.string(forKey: L10n.choiceKey), "es", "se guarda en el grupo compartido (extensión Compartir)")
        L10n.choice = .system
        XCTAssertNil(L10n.defaults.string(forKey: L10n.choiceKey))
        XCTAssertNil(UserDefaults.standard.persistentDomain(forName: Bundle.main.bundleIdentifier!)?["AppleLanguages"], "sin forzar el idioma del sistema")
        XCTAssertEqual(L10n.lang, L10n.systemLang)
        XCTAssertEqual(L10n.resolve(.system, system: "es"), "es")
        XCTAssertEqual(L10n.resolve(.en, system: "es"), "en")
    }

    func testSplashSecurityLineMakesNoAbsoluteClaims() throws {
        for lang in ["es", "en"] {
            let s = try XCTUnwrap(try strings(lang)["splash.secure"])
            for banned in ["extremo a extremo", "end-to-end", "peer", "pair", "segura", "secure"] {
                XCTAssertFalse(s.localizedCaseInsensitiveContains(banned), "\(lang): «\(banned)»")
            }
        }
        XCTAssertEqual(try strings("en")["splash.secure"], "Encrypted connection to help protect your information")
    }

    func testLanguageChangeResendsPushTokenWithNewLang() async throws {
        MockURLProtocol.routes = ["/api/v1/push/token": (200, "{}")]
        MockURLProtocol.requests = []
        let s = AppStore(baseURL: URL(string: "https://mock.chaggu.test")!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()),
                         feedback: nil, session: MockURLProtocol.session())
        L10n.choice = .es
        s.pushTokenSync.startSession()
        s.pushTokenSync.setEnabled(true)
        s.pushTokenSync.receive("abc123")
        await s.pushTokenSync.synchronize()
        XCTAssertEqual(MockURLProtocol.requests.last { $0.path == "/api/v1/push/token" }?.body["lang"] as? String, "es")
        let before = s.languageRevision
        s.setLanguage(.en)
        XCTAssertEqual(s.languageRevision, before + 1, "la interfaz se redibuja")
        try await waitUntil(5, "re-registro") { MockURLProtocol.requests.filter { $0.path == "/api/v1/push/token" }.count >= 2 }
        XCTAssertEqual(MockURLProtocol.requests.last { $0.path == "/api/v1/push/token" }?.body["lang"] as? String, "en", "push en el idioma nuevo")
    }

    /// Carrera: cambiar de idioma mientras un PUT en español sigue en vuelo debe terminar en otro PUT en inglés.
    func testLanguageChangeDuringInFlightPutSendsSecondPutWithNewLang() async throws {
        final class Box { var lang = "es"; var sent: [(String, String)] = []; var hold: CheckedContinuation<Void, Never>? }
        let box = Box()
        let sync = PushTokenSync(lang: { box.lang }) { op in
            guard case .register(let t) = op else { return }
            box.sent.append((t, box.lang))
            if box.sent.count == 1 { await withCheckedContinuation { box.hold = $0 } }   // el PUT en español queda en vuelo
        }
        sync.startSession()
        sync.setEnabled(true)
        sync.receive("tok")
        let first = Task { await sync.synchronize() }
        try await waitUntil(3, "PUT en vuelo") { box.hold != nil }
        box.lang = "en"
        sync.resendToken()                       // lo que hace AppStore.setLanguage
        let second = Task { await sync.synchronize() }
        box.hold?.resume()
        await first.value
        await second.value
        XCTAssertEqual(box.sent.map(\.1), ["es", "en"], "segundo PUT con el idioma nuevo")
        XCTAssertEqual(sync.registeredToken, "tok")
        XCTAssertEqual(sync.registeredLang, "en")
        // Sin cambios, no hay más PUT.
        await sync.synchronize()
        XCTAssertEqual(box.sent.count, 2)
    }
}
