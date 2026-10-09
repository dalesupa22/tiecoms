import XCTest
@testable import TieComs

@MainActor
final class SafetyTests: XCTestCase {
    var store: AppStore!

    override func setUp() {
        MockURLProtocol.routes = [:]
        MockURLProtocol.requests = []
        store = AppStore(baseURL: URL(string: "https://mock.tiecoms.test")!, secrets: MemorySecretStore(),
                         outbox: OutboxStore(directory: tempDir()), feedback: nil, session: MockURLProtocol.session())
    }

    func testBlockOnlyChangesLocalStateAfterServerAccepts() async throws {
        MockURLProtocol.routes["/api/v1/blocks/u2"] = (403, #"{"error":{"code":"forbidden","message":"Denied"}}"#)
        do { try await store.setUserBlocked("u2", blocked: true); XCTFail("should fail") } catch {}
        XCTAssertFalse(store.blockedUserIds.contains("u2"))
        MockURLProtocol.routes["/api/v1/blocks/u2"] = (200, #"{"ok":true}"#)
        try await store.setUserBlocked("u2", blocked: true)
        XCTAssertTrue(store.blockedUserIds.contains("u2"))
        try await store.setUserBlocked("u2", blocked: false)
        XCTAssertFalse(store.blockedUserIds.contains("u2"))
    }

    func testReloadRestoresBlocksAndSignOutClearsThem() async throws {
        MockURLProtocol.routes["/api/v1/blocks"] = (200, #"{"userIds":["u2","u3"]}"#)
        try await store.loadBlockedUsers()
        XCTAssertEqual(store.blockedUserIds, ["u2", "u3"])
        await store.signOutLocally()
        XCTAssertTrue(store.blockedUserIds.isEmpty)
    }

    func testEveryBootstrapRefreshReloadsCrossDeviceBlocks() async throws {
        MockURLProtocol.routes["/api/v1/bootstrap"] = (200, ChatsStoreTests.bootstrap)
        MockURLProtocol.routes["/api/v1/blocks"] = (200, #"{"userIds":["u2"]}"#)
        try await store.loadBootstrap()
        XCTAssertEqual(store.blockedUserIds, ["u2"])
        MockURLProtocol.routes["/api/v1/blocks"] = (200, #"{"userIds":[]}"#)
        try await store.loadBootstrap()
        XCTAssertTrue(store.blockedUserIds.isEmpty)
    }

    func testReportSendsTargetAndTrimmedReason() async throws {
        MockURLProtocol.routes["/api/v1/reports"] = (201, #"{"id":"report-1"}"#)
        try await store.reportContent(userId: "u2", messageId: "m2", reason: "  Abusive content  ")
        let request = try XCTUnwrap(MockURLProtocol.requests.last)
        XCTAssertEqual(request.path, "/api/v1/reports")
        XCTAssertEqual(request.body["userId"] as? String, "u2")
        XCTAssertEqual(request.body["messageId"] as? String, "m2")
        XCTAssertEqual(request.body["reason"] as? String, "Abusive content")
    }
}
