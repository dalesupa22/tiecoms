import XCTest
@testable import TieComs

/// «Actualización disponible» (docs/ACTUALIZAR.md): decodificación de /app-version, comparación de builds y peticiones.
@MainActor
final class AppUpdateTests: XCTestCase {
    private func info(_ json: String) throws -> AppVersionInfo { try JSONDecoder().decode(AppVersionInfo.self, from: Data(json.utf8)) }

    func testDecodesServerResponse() throws {
        let i = try info(#"{"platform":"ios","latestVersion":"1.6.7","latestBuild":24,"minBuild":0,"url":"https://apps.apple.com/app/id6816439007","notes":"Temas en el chat","extra":1}"#)
        XCTAssertEqual(i.latestVersion, "1.6.7")
        XCTAssertEqual(i.latestBuild, 24)
        XCTAssertEqual(i.minBuild, 0)
        XCTAssertEqual(i.url, "https://apps.apple.com/app/id6816439007")
        XCTAssertEqual(i.notes, "Temas en el chat")
    }

    func testDecodesTolerantly() throws {
        let i = try info(#"{"latestBuild":"25","minBuild":null,"url":"","notes":"  "}"#)
        XCTAssertEqual(i.platform, "ios")
        XCTAssertEqual(i.latestBuild, 25, "un número como texto también vale")
        XCTAssertEqual(i.minBuild, 0)
        XCTAssertNil(i.url)
        XCTAssertNil(i.notes, "notas vacías: sin línea de notas")
        XCTAssertEqual(try info("{}").latestBuild, 0)
    }

    func testCompareBuilds() {
        let v = AppVersionInfo(latestVersion: "1.6.7", latestBuild: 24)
        XCTAssertEqual(AppUpdate.state(installedBuild: 23, info: v), .available(v))
        XCTAssertEqual(AppUpdate.state(installedBuild: 24, info: v), .none, "build igual: nada")
        XCTAssertEqual(AppUpdate.state(installedBuild: 25, info: v), .none, "build mayor (TestFlight adelantado): nada")
        XCTAssertEqual(AppUpdate.state(installedBuild: nil, info: v), .none, "sin CFBundleVersion numérico: nada")
        XCTAssertEqual(AppUpdate.state(installedBuild: 23, info: nil), .none, "sin respuesta (red): nada")
        XCTAssertEqual(AppUpdate.state(installedBuild: 23, info: AppVersionInfo(latestVersion: "", latestBuild: 0)), .none)
        XCTAssertEqual(AppUpdate.state(installedBuild: 23, info: AppVersionInfo(platform: "android", latestVersion: "9", latestBuild: 99)), .none)
    }

    func testMinBuildBlocks() {
        let v = AppVersionInfo(latestVersion: "1.6.7", latestBuild: 24, minBuild: 24)
        XCTAssertEqual(AppUpdate.state(installedBuild: 23, info: v), .blocked(v))
        XCTAssertEqual(AppUpdate.state(installedBuild: 24, info: v), .none)
        let low = AppVersionInfo(latestVersion: "1.6.7", latestBuild: 24, minBuild: 20)
        XCTAssertEqual(AppUpdate.state(installedBuild: 22, info: low), .available(low), "sobre el mínimo: solo la franja")
    }

    func testInstalledBuildIsTheBundleBuild() {
        XCTAssertEqual(AppUpdate.installedBuild, Int(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as! String))
        XCTAssertEqual(AppUpdate.installedBuild, 52, "1.7.12 (52)")
    }

    func testUpdateTargets() {
        XCTAssertTrue(AppUpdate.isTestFlight(receiptURL: URL(fileURLWithPath: "/x/StoreKit/sandboxReceipt")))
        XCTAssertFalse(AppUpdate.isTestFlight(receiptURL: URL(fileURLWithPath: "/x/StoreKit/receipt")))
        XCTAssertFalse(AppUpdate.isTestFlight(receiptURL: nil))
        XCTAssertEqual(AppUpdate.targets(testFlight: true, storeURL: "https://apps.apple.com/app/id1").map(\.absoluteString),
                       ["itms-beta://", "https://testflight.apple.com"])
        XCTAssertEqual(AppUpdate.targets(testFlight: false, storeURL: "https://apps.apple.com/app/id1").map(\.absoluteString),
                       ["https://apps.apple.com/app/id1"])
        XCTAssertEqual(AppUpdate.targets(testFlight: false, storeURL: nil).count, 1)
    }

    func testOneRequestPerOpeningAndSilentOnFailure() async {
        MockURLProtocol.requests = []
        MockURLProtocol.routes = ["/api/v1/app-version": (200, #"{"platform":"ios","latestVersion":"1.6.7","latestBuild":99,"minBuild":0}"#)]
        let c = AppUpdateChecker(baseURL: URL(string: "https://mock.tiecoms.test")!, session: MockURLProtocol.session())
        let t0 = Date()
        await c.check(now: t0)
        await c.check(now: t0.addingTimeInterval(0.5)) // arranque + «activa» casi a la vez: una sola
        XCTAssertEqual(c.requests, 1)
        XCTAssertEqual(MockURLProtocol.requests.filter { $0.path == "/api/v1/app-version" }.count, 1)
        XCTAssertEqual(c.info?.latestBuild, 99)
        if case .available = c.state {} else { XCTFail("build 24 < 99: franja") }
        // Vuelta al frente más tarde: otra petición. Si falla, se conserva lo último conocido y no reintenta sola.
        MockURLProtocol.routes = [:]
        await c.check(now: t0.addingTimeInterval(60))
        XCTAssertEqual(c.requests, 2)
        XCTAssertEqual(c.info?.latestBuild, 99)
        XCTAssertEqual(MockURLProtocol.httpRequests.last?.url?.query, "platform=ios&lang=\(L10n.lang)")
    }

    func testStrings() {
        L10n.choice = .es
        defer { L10n.choice = .system }
        XCTAssertEqual(L("update.available"), "Actualización disponible")
        XCTAssertEqual(L("update.action"), "Actualizar")
        XCTAssertEqual(L("update.blocked"), "Esta versión ya no funciona. Actualiza chaggu para seguir.")
        L10n.choice = .en
        XCTAssertEqual(L("update.available"), "Update available")
        XCTAssertEqual(L("update.action"), "Update")
    }
}
