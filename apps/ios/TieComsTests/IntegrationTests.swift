import XCTest
@testable import TieComs

/// Integración contra el API de PRUEBAS (nunca producción).
///
/// Requiere el fixture de `scripts/mobile-fixture.mjs`; la ruta llega por el entorno
/// del test runner: `TEST_RUNNER_TC_FIXTURE=/ruta/fx.json xcodebuild test ...`
/// (Xcode quita el prefijo TEST_RUNNER_). La prueba del par en vivo necesita además
/// `scripts/realtime-peer.mjs` corriendo y `TEST_RUNNER_TC_PEER=1`.
@MainActor
final class IntegrationTests: XCTestCase {
    struct Fixture: Decodable {
        struct Person: Decodable { var email: String; var id: String; var name: String }
        var apiUrl: String
        var password: String
        var workspaceId: String
        var conversationId: String
        var a: Person
        var b: Person
    }

    static var fixture: Fixture?
    static var store: AppStore?
    static var spy = FeedbackSpy()
    static var bToken: String?

    private func loadFixture() throws -> Fixture {
        if let f = Self.fixture { return f }
        guard let path = ProcessInfo.processInfo.environment["TC_FIXTURE"], !path.isEmpty else {
            throw XCTSkip("Sin TC_FIXTURE: las pruebas de integración necesitan el fixture del API de pruebas")
        }
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        XCTAssertFalse(f.apiUrl.contains("app.tiecoms.com"), "las pruebas no se corren contra producción")
        Self.fixture = f
        return f
    }

    /// Store de A con sesión iniciada, compartido entre pruebas (el login tiene límite de 10/min).
    private func storeA() async throws -> (AppStore, Fixture) {
        let f = try loadFixture()
        if let s = Self.store, s.status == .ready { return (s, f) }
        let s = AppStore(baseURL: URL(string: f.apiUrl)!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: Self.spy)
        try await s.login(email: f.a.email, password: f.password)
        Self.store = s
        return (s, f)
    }

    // MARK: HTTP directo como B (otra empresa)

    private func http(_ method: String, _ path: String, token: String?, body: [String: Any]? = nil) async throws -> (Int, [String: Any]) {
        let f = try loadFixture()
        var req = URLRequest(url: URL(string: "\(f.apiUrl)/api/v1\(path)")!)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        if let body { req.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, res) = try await URLSession.shared.data(for: req)
        return ((res as! HTTPURLResponse).statusCode, (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:])
    }

    private func tokenB() async throws -> String {
        if let t = Self.bToken { return t }
        let f = try loadFixture()
        let (status, json) = try await http("POST", "/auth/login", token: nil, body: [
            "email": f.b.email, "password": f.password,
            "device": ["deviceId": UUID().uuidString, "name": "XCTest B", "platform": "agent"],
        ])
        XCTAssertEqual(status, 200)
        let t = try XCTUnwrap(json["accessToken"] as? String)
        Self.bToken = t
        return t
    }

    private func sendAsB(_ body: String) async throws -> [String: Any] {
        let f = try loadFixture()
        let (status, json) = try await http("POST", "/conversations/\(f.conversationId)/messages", token: try await tokenB(),
                                            body: ["clientMessageId": UUID().uuidString, "body": body])
        XCTAssertEqual(status, 201)
        return json["message"] as? [String: Any] ?? [:]
    }

    // MARK: Pruebas

    /// Login de A, bootstrap, socket conecta y recibe `ready`, envío con ACK por socket.
    func test1_LoginBootstrapSocketReadyAndAckSend() async throws {
        let t0 = Date()
        let (s, f) = try await storeA()
        let tLogin = Date().timeIntervalSince(t0)
        XCTAssertEqual(s.me?.id, f.a.id)
        XCTAssertNotNil(s.meta(f.conversationId), "bootstrap trae el grupo compartido")
        try await waitUntil(10, "evento ready del socket") { s.connection == .online }
        let tReady = Date().timeIntervalSince(t0)
        try await s.openConversation(f.conversationId)
        XCTAssertTrue(s.conversations[f.conversationId]?.messages.contains { $0.body.contains("empresa B") } ?? false)

        let viaSocket = s.deliveredViaSocket
        let sends = Self.spy.sends
        let text = "ack ios \(UUID().uuidString.prefix(8))"
        let t1 = Date()
        let p = try XCTUnwrap(s.send(f.conversationId, body: text))
        try await waitUntil(8, "ACK del envío") { !s.pending.contains { $0.clientMessageId == p.clientMessageId } }
        let tAck = Date().timeIntervalSince(t1)
        XCTAssertEqual(s.deliveredViaSocket, viaSocket + 1, "el envío fue por socket con ACK")
        XCTAssertEqual(Self.spy.sends, sends + 1, "suena tc_send al confirmar")
        let mine = s.conversations[f.conversationId]?.messages.filter { $0.clientMessageId == p.clientMessageId } ?? []
        XCTAssertEqual(mine.count, 1)
        print("[medida] login+bootstrap=\(ms(tLogin)) ms · socket ready=\(ms(tReady)) ms · ACK envío=\(ms(tAck)) ms")
    }

    /// Mensaje de otra persona (B, por HTTP) llega por socket en < 2 s.
    func test2_ReceiveFromOtherCompanyUnder2s() async throws {
        let (s, f) = try await storeA()
        try await waitUntil(10, "socket online") { s.connection == .online }
        try await s.openConversation(f.conversationId)
        let text = "desde B \(UUID().uuidString.prefix(8))"
        var received: (MessageDTO, Date)?
        s.onLiveMessage = { m in if m.body == text { received = (m, Date()) } }
        let t0 = Date()
        _ = try await sendAsB(text)
        try await waitUntil(5, "mensaje de B en vivo") { received != nil }
        let (m, at) = received!
        let fromSend = at.timeIntervalSince(t0)
        let fromServer = at.timeIntervalSince(ISODate.parse(m.createdAt) ?? t0)
        // Misma medida que scripts/realtime-peer.mjs: desde createdAt (commit en el servidor) hasta la recepción.
        // El POST de B incluye la transacción en la base de pruebas remota (~80 ms por consulta), por eso se reporta aparte.
        XCTAssertLessThan(fromServer, 2.0, "latencia servidor → recepción en A")
        XCTAssertLessThan(fromSend, 5.0, "POST de B → recepción en A")
        print("[medida] B→A: desde POST=\(ms(fromSend)) ms · desde createdAt del servidor=\(ms(fromServer)) ms")
        s.onLiveMessage = nil
    }

    /// Par en vivo (`scripts/realtime-peer.mjs`): A envía, el par responde "eco: …".
    func test3_EchoFromRealtimePeer() async throws {
        guard ProcessInfo.processInfo.environment["TC_PEER"] == "1" else { throw XCTSkip("Sin TC_PEER=1: el par en vivo no está corriendo") }
        let (s, f) = try await storeA()
        try await waitUntil(10, "socket online") { s.connection == .online }
        try await s.openConversation(f.conversationId)
        let text = "hola eco \(UUID().uuidString.prefix(8))"
        var echoAt: Date?
        var echo: MessageDTO?
        s.onLiveMessage = { m in if m.body == "eco: \(text)" { echo = m; echoAt = Date() } }
        let t0 = Date()
        s.send(f.conversationId, body: text)
        try await waitUntil(8, "eco del par en vivo") { echoAt != nil }
        let rtt = echoAt!.timeIntervalSince(t0)
        let fromServer = echoAt!.timeIntervalSince(ISODate.parse(echo!.createdAt) ?? t0)
        XCTAssertLessThan(fromServer, 2.0)
        print("[medida] ida y vuelta A→par→A=\(ms(rtt)) ms · eco desde createdAt=\(ms(fromServer)) ms")
        s.onLiveMessage = nil
    }

    /// Catch-up por /events tras desconectar mientras B envía.
    func test4_CatchUpAfterDisconnect() async throws {
        let (s, f) = try await storeA()
        try await waitUntil(10, "socket online") { s.connection == .online }
        try await s.openConversation(f.conversationId)
        s.openConversationId = f.conversationId
        let before = s.conversations[f.conversationId]?.lastEventSeq ?? 0
        let live = s.liveEventsApplied
        let caught = s.catchUpEventsApplied

        s.socket.disconnect()
        XCTAssertEqual(s.connection, .offline)
        let t1 = "offline 1 \(UUID().uuidString.prefix(6))"
        let t2 = "offline 2 \(UUID().uuidString.prefix(6))"
        _ = try await sendAsB(t1)
        _ = try await sendAsB(t2)
        try await Task.sleep(nanoseconds: 700_000_000)
        XCTAssertFalse(s.conversations[f.conversationId]?.messages.contains { $0.body == t1 } ?? true, "desconectado no llega nada")

        let t0 = Date()
        s.socket.connect()
        try await waitUntil(10, "catch-up tras reconectar") {
            let msgs = s.conversations[f.conversationId]?.messages ?? []
            return msgs.contains { $0.body == t1 } && msgs.contains { $0.body == t2 }
        }
        let tCatch = Date().timeIntervalSince(t0)
        let bodies = s.conversations[f.conversationId]!.messages.map(\.body)
        XCTAssertLessThan(bodies.firstIndex(of: t1)!, bodies.firstIndex(of: t2)!, "orden por seq")
        XCTAssertGreaterThanOrEqual(s.catchUpEventsApplied - caught, 2, "llegaron por /events")
        XCTAssertEqual(s.liveEventsApplied, live, "no por el socket")
        XCTAssertGreaterThan(s.conversations[f.conversationId]!.lastEventSeq, before)
        print("[medida] reconexión + catch-up de 2 mensajes=\(ms(tCatch)) ms")
    }

    /// Idempotencia: el mismo clientMessageId dos veces (HTTP y socket) → un solo mensaje.
    func test5_IdempotentClientMessageId() async throws {
        let (s, f) = try await storeA()
        try await waitUntil(10, "socket online") { s.connection == .online }
        let cid = UUID().uuidString.lowercased()
        let body = "idempotente \(cid.prefix(6))"
        let p = PendingMessage(clientMessageId: cid, conversationId: f.conversationId, body: body, replyTo: nil, createdAt: ISODate.string(),
                               attempts: 0, status: .pending, error: nil, nextAttemptAt: 0)
        // 1) HTTP
        let r1: SendResult = try await s.api.request("/conversations/\(f.conversationId)/messages", method: "POST", json: ["clientMessageId": cid, "body": body])
        XCTAssertFalse(r1.duplicate)
        // 2) HTTP de nuevo
        let r2: SendResult = try await s.api.request("/conversations/\(f.conversationId)/messages", method: "POST", json: ["clientMessageId": cid, "body": body])
        XCTAssertTrue(r2.duplicate)
        XCTAssertEqual(r1.message.id, r2.message.id)
        // 3) Socket con ACK, mismo identificador
        let m3 = try await s.deliver(p)
        XCTAssertEqual(m3.id, r1.message.id)
        let page: MessagesPage = try await s.api.request("/conversations/\(f.conversationId)/messages?limit=100")
        XCTAssertEqual(page.messages.filter { $0.clientMessageId == cid }.count, 1)
    }

    /// Sin sesión válida el refresh devuelve unauthorized y no se queda colgado.
    func test6_RefreshRotatesAndInvalidTokenSignsOut() async throws {
        let f = try loadFixture()
        let secrets = MemorySecretStore("token-invalido-\(UUID().uuidString)")
        let api = APIClient(baseURL: URL(string: f.apiUrl)!, secrets: secrets)
        let out = await api.refresh()
        XCTAssertEqual(out, .unauthorized)

        let (s, _) = try await storeA()
        let r = await s.api.refresh()
        XCTAssertEqual(r, .ok, "refresh con el token guardado rota y sigue la sesión")
        let _: BootstrapDTO = try await s.api.request("/bootstrap")
    }

    private func ms(_ t: TimeInterval) -> Int { Int((t * 1000).rounded()) }
}
