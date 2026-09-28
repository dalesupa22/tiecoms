import XCTest
@testable import TieComs

/// Incidencia Alicia → Danny (28-sep-2026): el DM abierto durante un despliegue mostraba «bad gateway» y quedaba vacío.
// MARK: Recuperación del chat tras un 502

/// Responde en orden una lista de (status, cuerpo, content-type) por ruta; el último se repite.
final class SequenceURLProtocol: URLProtocol {
    nonisolated(unsafe) private static var _script: [String: [(Int, String, String)]] = [:]
    nonisolated(unsafe) private static var _hits: [String: Int] = [:]
    static var script: [String: [(Int, String, String)]] {
        get { lock.lock(); defer { lock.unlock() }; return _script }
        set { lock.lock(); defer { lock.unlock() }; _script = newValue }
    }
    static var hits: [String: Int] {
        get { lock.lock(); defer { lock.unlock() }; return _hits }
        set { lock.lock(); defer { lock.unlock() }; _hits = newValue }
    }
    nonisolated(unsafe) static var suspendedPaths: Set<String> = []
    nonisolated(unsafe) static var suspended: [String: [SequenceURLProtocol]] = [:]
    private static let lock = NSLock()
    private var response: (Int, String, String)?
    private var stopped = false

    static func release(_ path: String) {
        lock.lock()
        let pending = suspended.removeValue(forKey: path) ?? []
        suspendedPaths.remove(path)
        lock.unlock()
        for item in pending { item.deliver() }
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url?.path ?? ""
        Self.lock.lock()
        let n = SequenceURLProtocol._hits[path, default: 0]
        SequenceURLProtocol._hits[path] = n + 1
        let list = SequenceURLProtocol._script[path] ?? [(404, #"{"error":{"code":"not_found","message":"no"}}"#, "application/json")]
        response = list[min(n, list.count - 1)]
        if Self.suspendedPaths.contains(path) {
            Self.suspended[path, default: []].append(self)
            Self.lock.unlock()
            return
        }
        Self.lock.unlock()
        deliver()
    }
    private func deliver() {
        Self.lock.lock()
        defer { Self.lock.unlock() }
        guard !stopped, let (status, body, type) = response else { return }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["content-type": type])!,
                            cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { Self.lock.lock(); stopped = true; Self.lock.unlock() }
}

@MainActor
final class ChatRecoveryTests: XCTestCase {
    private let html502 = (502, "<html><head><title>502 Bad Gateway</title></head><body>bad gateway</body></html>", "text/html")
    private let page = (200, #"{"messages":[{"id":"m1","conversationId":"dm","seq":1,"authorId":"ali","kind":"text","body":"hola","createdAt":"2026-09-28T15:09:32.949Z"}],"hasMore":false,"lastEventSeq":1}"#, "application/json")
    private let events = (200, #"{"events":[],"resetRequired":false,"lastEventSeq":1}"#, "application/json")

    private func makeStore() throws -> AppStore {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [SequenceURLProtocol.self]
        let s = AppStore(baseURL: URL(string: "https://synthetic.invalid")!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()),
                         feedback: nil, session: URLSession(configuration: cfg))
        s.seedForTesting(try JSONDecoder().decode(BootstrapDTO.self, from: jsonData(
            #"{"me":{"id":"me","name":"Danny","kind":"human"},"organizations":[],"workspaces":[],"people":[],"conversations":[{"id":"dm","kind":"direct","memberIds":["me","ali"],"canPost":true}]}"#)))
        return s
    }

    override func setUp() {
        SequenceURLProtocol.script = [:]
        SequenceURLProtocol.hits = [:]
        SequenceURLProtocol.suspendedPaths = []
        SequenceURLProtocol.suspended = [:]
    }

    // MARK: Error de un 502 sin JSON

    func testGateway5xxWithoutJSONIsLocalizedAndTransient() {
        let saved = L10n.choice
        defer { L10n.choice = saved }
        for (lang, text) in [(L10n.Choice.es, "chaggu se está actualizando. Reintenta en unos segundos."), (.en, "chaggu is updating. Try again in a few seconds.")] {
            L10n.choice = lang
            for status in [502, 503, 504] {
                let e = APIClient.parseError(Data("<html><body>bad gateway</body></html>".utf8), status: status)
                XCTAssertEqual(e.code, "server_updating")
                XCTAssertTrue(e.isTransient)
                XCTAssertEqual(L10n.errorText(e), text)
                XCTAssertFalse(L10n.errorText(e).lowercased().contains("bad gateway"))
            }
        }
        XCTAssertTrue(APIClient.parseError(Data(), status: 500).isTransient)
        XCTAssertTrue(ApiRequestError(status: 0, code: "network", message: "timeout").isTransient)
        XCTAssertFalse(APIClient.parseError(Data(#"{"error":{"code":"forbidden","message":"No"}}"#.utf8), status: 403).isTransient)
        XCTAssertFalse(APIClient.parseError(Data(), status: 404).isTransient)
    }

    func test502ThenRetryLoadsAndKeepsDraftAndSilencing() async throws {
        let store = try makeStore()
        SequenceURLProtocol.script["/api/v1/conversations/dm/messages"] = [html502, html502, page]
        SequenceURLProtocol.script["/api/v1/conversations/dm/events"] = [events]
        store.openConversationId = "dm"
        // El borrador vive en la vista; aquí se comprueba que la recuperación no toca el estado de envío.
        let draftBefore = store.pendingFor("dm").count
        let loaded = await store.openConversationRecovering("dm", delays: [0.01, 0.01, 0.01])
        XCTAssertTrue(loaded)
        XCTAssertEqual(SequenceURLProtocol.hits["/api/v1/conversations/dm/messages"], 3, "dos 502 y un 200")
        let st = try XCTUnwrap(store.conversations["dm"])
        XCTAssertTrue(st.loaded)
        XCTAssertNil(st.error)
        XCTAssertFalse(st.transient)
        XCTAssertEqual(st.messages.map(\.id), ["m1"])
        XCTAssertEqual(store.pendingFor("dm").count, draftBefore)
        XCTAssertEqual(store.visibleConversationId, "dm", "ya cargada: ahora sí calla sus avisos")
        XCTAssertEqual(store.meta("dm")?.lastReadSeq, 0, "cargar no marca como leído")
    }

    func testTransientStateWhileRetrying() async throws {
        let store = try makeStore()
        SequenceURLProtocol.script["/api/v1/conversations/dm/messages"] = [html502]
        let loaded = await store.openConversationRecovering("dm", delays: [])
        XCTAssertFalse(loaded)
        let st = try XCTUnwrap(store.conversations["dm"])
        XCTAssertFalse(st.loaded)
        XCTAssertEqual(st.error, L("err.server_updating"), "sin «bad gateway»")
        XCTAssertFalse(st.transient, "agotados los reintentos queda el texto con Reintentar")
        XCTAssertNil(store.visibleConversationId)
    }

    func testRetriesStopAfterBudget() async throws {
        let store = try makeStore()
        SequenceURLProtocol.script["/api/v1/conversations/dm/messages"] = [html502]
        let loaded = await store.openConversationRecovering("dm", delays: [0.01, 0.01, 0.01, 0.01, 0.01])
        XCTAssertFalse(loaded)
        XCTAssertEqual(SequenceURLProtocol.hits["/api/v1/conversations/dm/messages"], 6, "1 intento + 5 reintentos")
        XCTAssertEqual(AppStore.openRetryDelays, [1, 2, 4, 8, 15])
        XCTAssertEqual(AppStore.openRetryDelays.reduce(0, +), 30)
    }

    func testPermanentErrorIsShownWithoutRetrying() async throws {
        let store = try makeStore()
        SequenceURLProtocol.script["/api/v1/conversations/dm/messages"] = [(403, #"{"error":{"code":"forbidden","message":"No tienes permiso para esto"}}"#, "application/json")]
        let loaded = await store.openConversationRecovering("dm", delays: [0.01, 0.01])
        XCTAssertFalse(loaded)
        XCTAssertEqual(SequenceURLProtocol.hits["/api/v1/conversations/dm/messages"], 1, "un 403 no se reintenta")
        XCTAssertEqual(store.conversations["dm"]?.transient, false)
        XCTAssertNotNil(store.conversations["dm"]?.error)
    }

    func testSocketReconnectReloadsOpenChatThatFailed() async throws {
        let store = try makeStore()
        let boot = #"{"me":{"id":"me","name":"Danny","kind":"human"},"organizations":[],"workspaces":[],"people":[],"conversations":[{"id":"dm","kind":"direct","memberIds":["me","ali"],"canPost":true}]}"#
        SequenceURLProtocol.script["/api/v1/conversations/dm/messages"] = [html502, page]
        SequenceURLProtocol.script["/api/v1/conversations/dm/events"] = [events]
        SequenceURLProtocol.script["/api/v1/blocks"] = [(200, #"{"userIds":[]}"#, "application/json")]
        SequenceURLProtocol.script["/api/v1/bootstrap"] = [(200, boot, "application/json")]
        store.openConversationId = "dm"
        _ = await store.openConversationRecovering("dm", delays: [])
        XCTAssertEqual(store.conversations["dm"]?.loaded, false)
        // El socket vuelve (evento `ready`): el chat en pantalla que falló se vuelve a pedir.
        store.socketEventForTesting("ready", "{}")
        try await waitUntil(3, "chat recargado al reconectar") { store.conversations["dm"]?.loaded == true }
        XCTAssertEqual(store.conversations["dm"]?.messages.map(\.id), ["m1"])
        XCTAssertEqual(store.connection, .online)
    }

    func testCancelledRecoveryStops() async throws {
        let store = try makeStore()
        SequenceURLProtocol.script["/api/v1/conversations/dm/messages"] = [html502]
        let task = Task { await store.openConversationRecovering("dm", delays: [5, 5]) }
        try await waitUntil(3, "primer 502") { store.conversations["dm"]?.transient == true }
        XCTAssertEqual(store.conversations["dm"]?.transient, true, "mientras reintenta: «Reconectando…»")
        task.cancel()
        let loaded = await task.value
        XCTAssertFalse(loaded)
        XCTAssertEqual(SequenceURLProtocol.hits["/api/v1/conversations/dm/messages"], 1)
    }
    func testRecoveryCannotRetryAfterLogoutAndSameUserLoginDuringBackoff() async throws {
        let store = try makeStore(), data = try makeStore().data!
        SequenceURLProtocol.script["/api/v1/conversations/dm/messages"] = [html502, page]
        store.openConversationId = "dm"
        let task = store.startConversationRecovery("dm", delays: [0.15])
        try await waitUntil(2) { store.conversations["dm"]?.transient == true }
        await store.signOutLocally()
        store.seedForTesting(data)
        let result = await task.value
        XCTAssertFalse(result)
        try await Task.sleep(nanoseconds: 250_000_000)
        XCTAssertEqual(SequenceURLProtocol.hits["/api/v1/conversations/dm/messages"], 1)
        XCTAssertNil(store.conversations["dm"])
    }

    func testManualRecoveryStopsOnLeavingOrChangingChat() async throws {
        for next in [nil, "another"] as [String?] {
            SequenceURLProtocol.hits = [:]
            let store = try makeStore()
            SequenceURLProtocol.script["/api/v1/conversations/dm/messages"] = [html502, page]
            store.openConversationId = "dm"
            let task = store.startConversationRecovery("dm", delays: [0.1])
            try await waitUntil(2) { store.conversations["dm"]?.transient == true }
            store.openConversationId = next
            let result = await task.value
            XCTAssertFalse(result)
            try await Task.sleep(nanoseconds: 150_000_000)
            XCTAssertEqual(SequenceURLProtocol.hits["/api/v1/conversations/dm/messages"], 1)
            XCTAssertEqual(store.conversations["dm"]?.loading, false)
        }
    }

    func testManualAndReconnectShareInFlightLoadAndDoNotReportEarlySuccess() async throws {
        let store = try makeStore()
        let messagePath = "/api/v1/conversations/dm/messages"
        SequenceURLProtocol.script[messagePath] = [page]
        SequenceURLProtocol.script["/api/v1/conversations/dm/events"] = [events]
        SequenceURLProtocol.script["/api/v1/blocks"] = [(200, #"{"userIds":[]}"#, "application/json")]
        SequenceURLProtocol.script["/api/v1/bootstrap"] = [(200, #"{"me":{"id":"me","name":"Danny"},"conversations":[{"id":"dm","kind":"direct","memberIds":["me","ali"]}]}"#, "application/json")]
        SequenceURLProtocol.suspendedPaths.insert(messagePath)
        store.openConversationId = "dm"
        let first = store.startConversationRecovery("dm", delays: [])
        try await waitUntil(2) { SequenceURLProtocol.hits[messagePath] == 1 }
        var secondFinished = false
        let second = Task { let result = await store.openConversationRecovering("dm", delays: []); secondFinished = true; return result }
        store.socketEventForTesting("ready", "{}")
        try await waitUntil(2) { SequenceURLProtocol.hits["/api/v1/bootstrap"] == 1 }
        for _ in 0..<20 { await Task.yield() }
        XCTAssertFalse(secondFinished)
        XCTAssertEqual(store.conversations["dm"]?.loading, true)
        XCTAssertEqual(SequenceURLProtocol.hits[messagePath], 1)
        SequenceURLProtocol.release(messagePath)
        let a = await first.value, b = await second.value
        XCTAssertTrue(a && b)
        XCTAssertEqual(SequenceURLProtocol.hits[messagePath], 1)
        XCTAssertEqual(store.conversations["dm"]?.loading, false)
        XCTAssertEqual(store.conversations["dm"]?.transient, false)
    }

    func testOldCancelledLoadCannotCleanUpOrApplyOverNewOwner() async throws {
        let store = try makeStore(), path = "/api/v1/conversations/dm/messages"
        SequenceURLProtocol.script[path] = [html502, page]
        SequenceURLProtocol.script["/api/v1/conversations/dm/events"] = [events]
        SequenceURLProtocol.suspendedPaths.insert(path)
        store.openConversationId = "dm"
        let old = store.startConversationRecovery("dm", delays: [])
        try await waitUntil(2) { SequenceURLProtocol.hits[path] == 1 }
        store.cancelConversationRecovery("dm")
        let new = store.startConversationRecovery("dm", delays: [])
        try await waitUntil(2) { SequenceURLProtocol.hits[path] == 2 }
        let oldResult = await old.value
        XCTAssertFalse(oldResult)
        XCTAssertEqual(store.conversations["dm"]?.loading, true, "el dueño viejo no limpia al nuevo")
        SequenceURLProtocol.release(path)
        let loaded = await new.value
        XCTAssertTrue(loaded)
        XCTAssertEqual(store.conversations["dm"]?.messages.map(\.id), ["m1"])
        XCTAssertNil(store.conversations["dm"]?.error)
    }

    func testPushForKnownUnloadedChatCoalescesMetadataWithoutHistoryOrRead() async throws {
        for failed in [false, true] {
            SequenceURLProtocol.hits = [:]
            let store = try makeStore()
            if failed { store.seedForTesting(store.data!, conversations: ["dm": ConversationState(error: "502", transient: true)]) }
            let path = "/api/v1/bootstrap"
            SequenceURLProtocol.script["/api/v1/blocks"] = [(200, #"{"userIds":[]}"#, "application/json")]
            SequenceURLProtocol.script[path] = [(200, #"{"me":{"id":"me","name":"Danny"},"conversations":[{"id":"dm","kind":"direct","memberIds":["me","ali"],"lastMessageSeq":8,"lastReadSeq":2,"unread":6,"lastMessagePreview":"nuevo"}]}"#, "application/json")]
            SequenceURLProtocol.suspendedPaths.insert(path)
            let push = PushPayload(userInfo: ["type": "message", "conversationId": "dm", "messageId": "m8", "authorId": "ali"])!
            _ = store.presentsForegroundPush(push)
            _ = store.presentsForegroundPush(push)
            try await waitUntil(2) { SequenceURLProtocol.hits[path] == 1 }
            for _ in 0..<5 { _ = store.presentsForegroundPush(push) }
            try await Task.sleep(nanoseconds: 300_000_000)
            XCTAssertEqual(SequenceURLProtocol.hits[path], 1, "también coalesce mientras HTTP está pendiente")
            SequenceURLProtocol.release(path)
            try await waitUntil(2) { store.meta("dm")?.lastMessagePreview == "nuevo" }
            XCTAssertEqual(store.meta("dm")?.unread, 6)
            XCTAssertEqual(store.meta("dm")?.lastReadSeq, 2)
            XCTAssertNotEqual(store.conversations["dm"]?.loaded, true)
            XCTAssertNil(SequenceURLProtocol.hits["/api/v1/conversations/dm/messages"])
            XCTAssertNil(SequenceURLProtocol.hits["/api/v1/conversations/dm/events"])
            XCTAssertNil(SequenceURLProtocol.hits["/api/v1/conversations/dm/read"])
            await store.signOutLocally()
        }
    }

    func testNewPushDuringBootstrapGetsOneFollowupSnapshot() async throws {
        let store = try makeStore(), path = "/api/v1/bootstrap"
        SequenceURLProtocol.script["/api/v1/blocks"] = [(200, #"{"userIds":[]}"#, "application/json")]
        func snapshot(_ seq: Int) -> (Int, String, String) {
            (200, #"{"me":{"id":"me","name":"Danny"},"conversations":[{"id":"dm","kind":"direct","memberIds":["me","ali"],"lastMessageSeq":\#(seq),"lastReadSeq":0,"unread":\#(seq),"lastMessagePreview":"snapshot-\#(seq)"}]}"#, "application/json")
        }
        SequenceURLProtocol.script[path] = [snapshot(1), snapshot(2)]
        SequenceURLProtocol.suspendedPaths.insert(path)
        func push(_ seq: Int) -> PushPayload {
            PushPayload(userInfo: ["type": "message", "conversationId": "dm", "messageId": "m\(seq)", "authorId": "ali"])!
        }
        _ = store.presentsForegroundPush(push(1))
        try await waitUntil(2) { SequenceURLProtocol.hits[path] == 1 }
        // El primer HTTP ya capturó snapshot-1. El segundo mensaje llega antes de recibir esa respuesta.
        for _ in 0..<5 { _ = store.presentsForegroundPush(push(2)) }
        SequenceURLProtocol.release(path)
        try await waitUntil(2) { store.meta("dm")?.lastMessagePreview == "snapshot-2" }
        XCTAssertEqual(SequenceURLProtocol.hits[path], 2)
        XCTAssertEqual(store.meta("dm")?.unread, 2)
        XCTAssertEqual(store.meta("dm")?.lastReadSeq, 0)
        XCTAssertNil(store.conversations["dm"])
        XCTAssertNil(SequenceURLProtocol.hits["/api/v1/conversations/dm/messages"])
        XCTAssertNil(SequenceURLProtocol.hits["/api/v1/conversations/dm/read"])
        await store.signOutLocally()
    }

}
