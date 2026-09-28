import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }

/// 1.6.6 · Asuntos personales: `IssueDTO.conversationId` puede llegar null (contrato 2026-09-28).
@MainActor
final class PersonalIssueTests: XCTestCase {
    private func issue(_ id: String, conv: String?, parent: String? = nil, owner: String = "me") throws -> IssueDTO {
        let c = conv.map { "\"\($0)\"" } ?? "null"
        let p = parent.map { "\"\($0)\"" } ?? "null"
        return try dec(IssueDTO.self, #"{"id":"\#(id)","workspaceId":null,"conversationId":\#(c),"parentIssueId":\#(p),"title":"T \#(id)","status":"open","ownerId":"\#(owner)","createdBy":"me","visibility":"\#(conv == nil ? "private" : "all")","viewerIds":["me"]}"#)
    }

    func testContractAndNullConversationDecode() throws {
        XCTAssertEqual(Contract.version, "2026-09-28", "GET /issues solo manda personales con contrato ≥ 2026-09-28")
        let p = try issue("p", conv: nil)
        XCTAssertNil(p.conversationId)
        XCTAssertTrue(p.isPersonal)
        XCTAssertFalse(try issue("s", conv: "c1").isPersonal)
        let empty = try dec(IssueDTO.self, #"{"id":"e","conversationId":"","title":"x"}"#)
        XCTAssertNil(empty.conversationId, "vacío = sin conversación")
    }

    func testPersonalAccountEvent() throws {
        let e = try dec(AccountEvent.self, #"{"type":"issue.personal","issue":{"id":"p1","conversationId":null,"title":"Mío","status":"open","createdBy":"me","visibility":"private"}}"#)
        guard case .issuePersonal(let i) = e else { return XCTFail("\(e)") }
        XCTAssertEqual(i.id, "p1"); XCTAssertTrue(i.isPersonal)
        let s = AppStore(baseURL: URL(string: "http://127.0.0.1:9")!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: nil)
        let d = try dec(BootstrapDTO.self, #"{"me":{"id":"me","name":"A","kind":"human"},"organizations":[],"workspaces":[],"people":[],"conversations":[{"id":"c1","kind":"group","openIssues":1}]}"#)
        s.seedForTesting(d)
        s.socketEventForTesting("account.event", #"{"type":"issue.personal","issue":{"id":"p1","conversationId":null,"title":"Mío","status":"open","ownerId":"me","createdBy":"me","visibility":"private"}}"#)
        XCTAssertEqual(s.issues["p1"]?.title, "Mío", "llega a mi cuenta y entra en la lista")
        XCTAssertEqual(s.meta("c1")?.openIssues, 1, "no cuenta en los chips de ninguna conversación")
        XCTAssertEqual(s.myOpenIssues, 1, "sí cuenta en «Míos»")
    }

    func testByGroupPutsPersonalSectionFirstAndNothingElseBreaks() throws {
        let p = try issue("p", conv: nil), a = try issue("a", conv: "c1"), b = try issue("b", conv: "c1")
        let all = Dictionary(uniqueKeysWithValues: [p, a, b].map { ($0.id, $0) })
        let s = IssueTree.sections([a, b, p], by: .group, me: "me", groupKey: { IssueTasks.groupConversation($0, all) }) { $0 }
        XCTAssertEqual(s.map(\.id), [IssueTasks.personalKey, "c1"], "«Personal · solo tú» primero aunque tenga menos")
        XCTAssertEqual(HomeView.openByConversation(all).keys.sorted(), ["c1"], "no va bajo ningún grupo")
        XCTAssertTrue(ChatAgendaItem.build(conversationId: "c1", events: [], issues: [p], reminders: []).isEmpty)
        XCTAssertEqual(IssueTasks.listed(in: "c1", all).map(\.id).sorted(), ["a", "b"])
        XCTAssertTrue(IssueTree.group(try dec(BootstrapDTO.self, #"{"me":{"id":"me","name":"A","kind":"human"},"organizations":[],"workspaces":[],"people":[],"conversations":[]}"#), [p]).isEmpty)
    }
}

/// Retains an actual URLSession response so account-switch regressions exercise the suspension boundary.
final class ControlledURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((ControlledURLProtocol) -> Void)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.handler?(self) }
    override func stopLoading() {}
    func respond(_ json: String) { respond(200, json) }
    func respond(_ status: Int, _ json: String) {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["content-type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    var json: [String: Any] {
        if let data = request.httpBody { return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:] }
        guard let stream = request.httpBodyStream else { return [:] }
        stream.open(); defer { stream.close() }
        var data = Data(); var buffer = [UInt8](repeating: 0, count: 2048)
        while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }
    @MainActor static func store(user: String = "a") throws -> AppStore {
        let cfg = URLSessionConfiguration.ephemeral; cfg.protocolClasses = [ControlledURLProtocol.self]
        let s = AppStore(baseURL: URL(string: "https://synthetic.invalid")!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: nil, session: URLSession(configuration: cfg))
        s.seedForTesting(try boot(user))
        return s
    }
    static func boot(_ user: String) throws -> BootstrapDTO {
        try JSONDecoder().decode(BootstrapDTO.self, from: Data(#"{"me":{"id":"\#(user)","name":"Synthetic","kind":"human"},"organizations":[],"workspaces":[],"people":[],"conversations":[]}"#.utf8))
    }
}

extension PersonalIssueTests {
    func testHeldPrivateResponseCannotPopulateNextAccountOrSameAccountRelogin() async throws {
        for next in ["b", "a"] {
            let store = try ControlledURLProtocol.store()
            let started = expectation(description: "private response retained")
            var held: ControlledURLProtocol?
            ControlledURLProtocol.handler = { request in Task { @MainActor in held = request; started.fulfill() } }
            let task = Task { try await store.loadIssues() }
            await fulfillment(of: [started], timeout: 2)
            await store.signOutLocally()
            store.seedForTesting(try ControlledURLProtocol.boot(next))
            held?.respond(#"{"items":[{"id":"private-a","conversationId":null,"title":"Private A","ownerId":"a","createdBy":"a","visibility":"private"}]}"#)
            do { _ = try await task.value; XCTFail("old result must be discarded") } catch is CancellationError {} catch { XCTFail("\(error)") }
            XCTAssertTrue(store.issues.isEmpty)
        }
    }

    func testHeldFailedOptimisticUpdateCannotRestoreOldPrivateIssue() async throws {
        let store = try ControlledURLProtocol.store()
        store.issues["private-a"] = try issue("private-a", conv: nil, owner: "a")
        let started = expectation(description: "update retained")
        var held: ControlledURLProtocol?
        ControlledURLProtocol.handler = { request in Task { @MainActor in held = request; started.fulfill() } }
        let task = Task { try await store.setIssueStatus("private-a", .done) }
        await fulfillment(of: [started], timeout: 2)
        await store.signOutLocally(); store.seedForTesting(try ControlledURLProtocol.boot("b"))
        held?.respond(500, #"{"error":{"code":"synthetic_failure","message":"failed"}}"#)
        do { try await task.value; XCTFail() } catch {}
        XCTAssertTrue(store.issues.isEmpty, "rollback must not restore A's private title in B")
    }

    func testPrivateEventsFromOtherOwnerAreRejected() throws {
        let store = try ControlledURLProtocol.store(user: "b")
        store.socketEventForTesting("account.event", #"{"type":"issue.personal","issue":{"id":"private-a","conversationId":null,"title":"Private A","ownerId":"a","createdBy":"a","visibility":"private"}}"#)
        XCTAssertTrue(store.issues.isEmpty)
    }
}

extension PersonalIssueTests {
    func testHeldUpload401CannotRetryUsingNextAccount() async throws {
        let store = try ControlledURLProtocol.store()
        let started = expectation(description: "upload retained")
        var held: ControlledURLProtocol?, calls = 0
        ControlledURLProtocol.handler = { request in Task { @MainActor in held = request; calls += 1; started.fulfill() } }
        let task = Task { () throws -> AppStore.IdResult in
            try await store.api.uploadWithProgress("/conversations/synthetic/attachments", data: Data("synthetic".utf8), contentType: "application/octet-stream") { _ in }
        }
        await fulfillment(of: [started], timeout: 2)
        await store.signOutLocally(); store.seedForTesting(try ControlledURLProtocol.boot("b"))
        held?.respond(401, #"{"error":{"code":"unauthorized","message":"expired"}}"#)
        do { _ = try await task.value; XCTFail() } catch is CancellationError {} catch { XCTFail("\(error)") }
        XCTAssertEqual(calls, 1)
    }
}

extension PersonalIssueTests {
    func testHeldLogoutDoesNotClearCredentialsFromNewLogin() async throws {
        let store = try ControlledURLProtocol.store()
        let started = expectation(description: "logout retained")
        var held: ControlledURLProtocol?
        ControlledURLProtocol.handler = { req in Task { @MainActor in
            if req.request.url!.path.hasSuffix("/logout") { held = req; started.fulfill() }
            else {
                let email = req.json["email"] as? String ?? "a"
                req.respond(#"{"accessToken":"synthetic-\#(email)","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"synthetic-refresh","user":{"id":"\#(email)","name":"Synthetic","kind":"human"}}"#)
            }
        } }
        _ = try await store.api.login(email: "a", password: "synthetic")
        let logout = Task { await store.api.logout() }
        await fulfillment(of: [started], timeout: 2)
        _ = try await store.api.login(email: "b", password: "synthetic")
        held?.respond("{}")
        await logout.value
        XCTAssertEqual(store.api.accessToken, "synthetic-b")
    }
}
