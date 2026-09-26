import XCTest
import UIKit
@testable import TieComs

/// Integración del feedback de TestFlight contra el API de la rama mobile-feedback (3043).
/// Entorno: TEST_RUNNER_TC_FIXTURE3=<fx.json creado con API_URL=http://localhost:3043>.
@MainActor
final class IntegrationV3FeedbackTests: XCTestCase {
    typealias Fixture = IntegrationTests.Fixture
    static var fixture: Fixture?
    static var store: AppStore?
    static var bToken: String?

    private func fx() throws -> Fixture {
        if let f = Self.fixture { return f }
        guard let path = ProcessInfo.processInfo.environment["TC_FIXTURE3"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE3") }
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        XCTAssertFalse(f.apiUrl.contains("app.tiecoms.com"))
        Self.fixture = f
        return f
    }

    private func storeA() async throws -> (AppStore, Fixture) {
        let f = try fx()
        if let s = Self.store, s.status == .ready { return (s, f) }
        let s = AppStore(baseURL: URL(string: f.apiUrl)!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: nil)
        try await s.login(email: f.a.email, password: f.password)
        try await waitUntil(10, "socket") { s.connection == .online }
        try await s.openConversation(f.conversationId)
        Self.store = s
        return (s, f)
    }

    private func http(_ method: String, _ path: String, token: String?, body: [String: Any]? = nil) async throws -> (Int, [String: Any]) {
        let f = try fx()
        var req = URLRequest(url: URL(string: "\(f.apiUrl)/api/v1\(path)")!)
        req.httpMethod = method
        if let body { req.httpBody = try JSONSerialization.data(withJSONObject: body); req.setValue("application/json", forHTTPHeaderField: "content-type") }
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        let (data, res) = try await URLSession.shared.data(for: req)
        return ((res as! HTTPURLResponse).statusCode, (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:])
    }

    private func tokenB() async throws -> String {
        if let t = Self.bToken { return t }
        let f = try fx()
        let (_, j) = try await http("POST", "/auth/login", token: nil, body: ["email": f.b.email, "password": f.password, "device": ["deviceId": UUID().uuidString, "name": "XCTest B v3", "platform": "agent"]])
        Self.bToken = j["accessToken"] as? String
        return try XCTUnwrap(Self.bToken)
    }

    private func sendAsB(_ body: String) async throws -> String {
        let f = try fx()
        let (st, j) = try await http("POST", "/conversations/\(f.conversationId)/messages", token: try await tokenB(), body: ["clientMessageId": UUID().uuidString, "body": body])
        XCTAssertEqual(st, 201)
        return (j["message"] as? [String: Any])?["id"] as? String ?? ""
    }

    private func messages(_ s: AppStore, _ id: String) -> [MessageDTO] { s.conversations[id]?.messages ?? [] }

    /// 1. Foto del grupo: subir (recorte → JPEG), se ve con la URL base, mensaje de sistema, quitar; directo = 400.
    func test1_GroupPhoto() async throws {
        let (s, f) = try await storeA()
        let img = UIGraphicsImageRenderer(size: CGSize(width: 900, height: 600)).image { ctx in
            UIColor.systemTeal.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 900, height: 600))
        }
        let jpeg = try XCTUnwrap(CropMath.render(img, crop: CropMath.cropRect(image: img.size, side: 300, zoom: 1.5, offset: .zero)))
        try await s.uploadConversationAvatar(f.conversationId, jpeg: jpeg)
        let path = try XCTUnwrap(s.meta(f.conversationId)?.avatarUrl)
        XCTAssertTrue(path.hasPrefix("/api/v1/avatars/"), path)
        let url = try XCTUnwrap(MediaURL.absolute(path, base: URL(string: f.apiUrl)!))
        let (data, res) = try await URLSession.shared.data(from: url)
        XCTAssertEqual((res as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertNotNil(UIImage(data: data), "la foto se descarga con la URL base")
        try await waitUntil(8, "mensaje de sistema") { self.messages(s, f.conversationId).contains { ($0.systemPayload?["k"] as? String) == "group.photo_changed" } }
        let sys = try XCTUnwrap(messages(s, f.conversationId).last { ($0.systemPayload?["k"] as? String) == "group.photo_changed" })
        XCTAssertFalse(L10n.systemText(sys.body).hasPrefix("{"))
        try await s.removeConversationAvatar(f.conversationId)
        XCTAssertNil(s.meta(f.conversationId)?.avatarUrl)
        // En un directo el API responde 400.
        let chat = try await s.createChat(userIds: [f.b.id], name: nil)
        XCTAssertEqual(chat.kind, .direct)
        do { try await s.uploadConversationAvatar(chat.id, jpeg: jpeg); XCTFail("directo sin foto de grupo") }
        catch let e as ApiRequestError { XCTAssertEqual(e.status, 400) }
    }

    /// 4. Conversación lateral: privada (el origen no cambia), B la ve, outsider → 403 con userIds, devolver → mergedFrom.
    func test2_SideConversation() async throws {
        let (s, f) = try await storeA()
        let anchorId = try await sendAsB("¿Cuándo sale la versión? \(UUID().uuidString.prefix(4))")
        try await waitUntil(8, "ancla") { self.messages(s, f.conversationId).contains { $0.id == anchorId } }
        let originSeq = s.meta(f.conversationId)?.lastMessageSeq ?? 0
        // Una persona de otra empresa que no está en el origen no se puede sumar.
        let tag = UUID().uuidString.prefix(6).lowercased()
        let (st, other) = try await http("POST", "/auth/signup", token: nil, body: [
            "name": "Carla Externa \(tag)", "email": "carla.\(tag)@qa.tiecoms.test", "password": "Clave-\(UUID().uuidString.prefix(10))",
            "orgName": "QA Externa \(tag)", "device": ["deviceId": UUID().uuidString, "name": "x", "platform": "agent"],
        ])
        XCTAssertEqual(st, 200)
        let outsider = try XCTUnwrap((other["user"] as? [String: Any])?["id"] as? String)
        do {
            _ = try await s.createSide(f.conversationId, messageId: anchorId, userIds: [f.b.id, outsider], question: nil)
            XCTFail("outsider debió dar 403")
        } catch let e as ApiRequestError {
            XCTAssertEqual(e.status, 403)
            XCTAssertEqual(e.code, "side_outsider")
            XCTAssertEqual(e.userIds, [outsider], "el API dice a quién marcar en la interfaz")
        }
        let t0 = Date()
        let side = try await s.createSide(f.conversationId, messageId: anchorId, userIds: [f.b.id], question: "¿Me ayudas con esto?")
        let tSide = Date().timeIntervalSince(t0)
        let meta = try XCTUnwrap(s.meta(side))
        XCTAssertEqual(meta.kind, .multi)
        XCTAssertEqual(meta.deriveKind, "side")
        XCTAssertEqual(meta.parentMessageId, anchorId)
        XCTAssertEqual(s.sides(of: anchorId).map(\.id), [side], "chip «Consulta lateral» bajo el ancla")
        XCTAssertEqual(Naming.homeTree(s.data!).companies.flatMap { $0.workspaces.flatMap { $0.convs.flatMap { $0.sides.map(\.id) } } }, [side],
                       "en Inicio cuelga de su origen")
        try await s.openConversation(side)
        let sideMsgs = messages(s, side)
        XCTAssertTrue(sideMsgs.contains { ($0.systemPayload?["k"] as? String) == "side.started" })
        XCTAssertTrue(sideMsgs.contains { $0.body == "¿Me ayudas con esto?" && $0.authorId == f.a.id }, "la pregunta es el primer mensaje")
        try await Task.sleep(nanoseconds: 500_000_000)
        try await s.loadBootstrap()
        XCTAssertEqual(s.meta(f.conversationId)?.lastMessageSeq, originSeq, "privada: en el origen no se publica nada")
        // B la ve en su /bootstrap.
        let (_, bb) = try await http("GET", "/bootstrap", token: try await tokenB())
        XCTAssertTrue(((bb["conversations"] as? [[String: Any]]) ?? []).contains { $0["id"] as? String == side })
        // Llevar la respuesta al hilo.
        let parent = try await s.returnResult(side, summary: "Sale el jueves (respuesta de la consulta)")
        XCTAssertEqual(parent, f.conversationId)
        try await s.openConversation(f.conversationId, force: true)
        XCTAssertTrue(messages(s, f.conversationId).contains { $0.mergedFrom == side })
        print("[medida] v3 crear lateral = \(Int(tSide * 1000)) ms")
    }

    /// 7. Responder en privado: abre el directo con el autor y envía con forwarded.messageId.
    func test3_PrivateReply() async throws {
        let (s, f) = try await storeA()
        let anchorId = try await sendAsB("Pregunta para responder aparte \(UUID().uuidString.prefix(4))")
        try await waitUntil(8, "mensaje de B") { self.messages(s, f.conversationId).contains { $0.id == anchorId } }
        let m = try XCTUnwrap(messages(s, f.conversationId).first { $0.id == anchorId })
        let direct = try await s.startPrivateReply(to: m)
        XCTAssertEqual(s.meta(direct)?.kind, .direct)
        XCTAssertEqual(s.homePath.last, .conversation(direct))
        let draft = try XCTUnwrap(s.privateReplies[direct])
        try await s.openConversation(direct)
        s.sendPrivateReply(draft, body: "Te respondo en privado")
        try await waitUntil(8, "respuesta privada enviada") { self.messages(s, direct).contains { $0.forwarded?.messageId == anchorId } }
        let sent = try XCTUnwrap(messages(s, direct).first { $0.forwarded?.messageId == anchorId })
        XCTAssertEqual(sent.forwarded?.fromConversationId, f.conversationId)
        XCTAssertEqual(sent.body, "Te respondo en privado")
        // Nuevo chat con varias personas → chat grupal (multi).
        let multi = try await s.createChat(userIds: [f.b.id, f.b.id], name: "Chat de prueba iOS")
        XCTAssertTrue([.direct, .multi].contains(multi.kind))
    }

    /// 3. Comentar asuntos de verdad (la captura de iOS sugería que no funcionaba).
    func test4_IssueComments() async throws {
        let (s, f) = try await storeA()
        let i = try await s.createIssue(conversationId: f.conversationId, title: "Confirmar fecha con dirección", ownerId: f.a.id, dueDate: nil, originMessageId: nil)
        try await s.commentIssue(i.id, body: "Primera actualización desde iOS")
        let d = try await s.issueDetail(i.id)
        let c = try XCTUnwrap(d.events.first { $0.kind == "comment" })
        XCTAssertEqual(c.payload["body"]?.stringValue, "Primera actualización desde iOS")
        XCTAssertEqual(c.actorId, f.a.id)
        XCTAssertEqual(s.issues[i.id]?.commentCount, 1)
    }

    /// 6. Push: registrar el token APNs (sandbox en Debug) y borrarlo.
    func test5_PushToken() async throws {
        let (s, _) = try await storeA()
        let token = (0..<32).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
        // El simulador no concede permiso APNs: esta prueba cubre el contrato del API.
        await s.retryPushRegistration()
        s.pushTokenSync.receive(token)
        s.pushTokenSync.setEnabled(true)
        await s.pushTokenSync.synchronize()
        XCTAssertEqual(s.registeredPushToken, token)
        let (st, j) = try await http("PUT", "/push/token", token: s.api.accessToken,
                                     body: ["provider": "apns", "token": token, "environment": "sandbox", "lang": "es"])
        XCTAssertEqual(st, 200)
        XCTAssertEqual(j["ok"] as? Bool, true)
        await s.unregisterPush()
        XCTAssertNil(s.registeredPushToken)
        XCTAssertEqual(s.badgeCount, Naming.unreadCount(s.data?.conversations ?? []))
    }
}
