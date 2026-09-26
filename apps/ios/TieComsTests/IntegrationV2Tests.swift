import XCTest
@testable import TieComs

/// Integración v2 contra el API de PRUEBAS (3041, base tiecoms_mobile; 3042 para eliminar cuenta).
/// Entorno: TEST_RUNNER_TC_FIXTURE=<fx.json>, TEST_RUNNER_TC_PEER2=1 con scripts/realtime-peer2.mjs corriendo,
/// TEST_RUNNER_TC_DELETE_API=http://localhost:3042 para la prueba de eliminar cuenta.
@MainActor
final class IntegrationV2Tests: XCTestCase {
    typealias Fixture = IntegrationTests.Fixture
    static var fixture: Fixture?
    static var store: AppStore?
    static let spy = FeedbackSpy()
    static var bToken: String?

    private func fx() throws -> Fixture {
        if let f = Self.fixture { return f }
        guard let path = ProcessInfo.processInfo.environment["TC_FIXTURE"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE") }
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        XCTAssertFalse((f.apiUrl.contains("app.chaggu.com") || f.apiUrl.contains("app.tiecoms.com")))
        Self.fixture = f
        return f
    }

    private func storeA() async throws -> (AppStore, Fixture) {
        let f = try fx()
        if let s = Self.store, s.status == .ready { return (s, f) }
        let s = AppStore(baseURL: URL(string: f.apiUrl)!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: Self.spy)
        try await s.login(email: f.a.email, password: f.password)
        try await waitUntil(10, "socket online") { s.connection == .online }
        try await s.openConversation(f.conversationId)
        Self.store = s
        return (s, f)
    }

    private func requirePeer() throws { guard ProcessInfo.processInfo.environment["TC_PEER2"] == "1" else { throw XCTSkip("Sin TC_PEER2=1") } }

    private func http(_ base: String, _ method: String, _ path: String, token: String?, body: [String: Any]? = nil) async throws -> (Int, [String: Any]) {
        var req = URLRequest(url: URL(string: "\(base)/api/v1\(path)")!)
        req.httpMethod = method
        if let body { req.httpBody = try JSONSerialization.data(withJSONObject: body); req.setValue("application/json", forHTTPHeaderField: "content-type") }
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        let (data, res) = try await URLSession.shared.data(for: req)
        return ((res as! HTTPURLResponse).statusCode, (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:])
    }

    private func sendAsB(_ body: String) async throws {
        let f = try fx()
        if Self.bToken == nil {
            let (_, j) = try await http(f.apiUrl, "POST", "/auth/login", token: nil, body: ["email": f.b.email, "password": f.password, "device": ["deviceId": UUID().uuidString, "name": "XCTest B v2", "platform": "agent"]])
            Self.bToken = j["accessToken"] as? String
        }
        let (st, _) = try await http(f.apiUrl, "POST", "/conversations/\(f.conversationId)/messages", token: Self.bToken, body: ["clientMessageId": UUID().uuidString, "body": body])
        XCTAssertEqual(st, 201)
    }

    private func messages(_ s: AppStore, _ f: Fixture) -> [MessageDTO] { s.conversations[f.conversationId]?.messages ?? [] }
    private func ms(_ t: TimeInterval) -> Int { Int((t * 1000).rounded()) }

    /// Editar, fijar y borrar en vivo: el par lo ve (responde) y la app recibe message.updated / pins.changed del par.
    func test1_EditPinDeleteLive() async throws {
        try requirePeer()
        let (s, f) = try await storeA()
        s.openConversationId = f.conversationId
        let text = "para editar \(UUID().uuidString.prefix(6))"
        let p = try XCTUnwrap(s.send(f.conversationId, body: text))
        try await waitUntil(8, "envío") { !s.pending.contains { $0.clientMessageId == p.clientMessageId } }
        let mine = try XCTUnwrap(messages(s, f).last { $0.clientMessageId == p.clientMessageId })
        try await waitUntil(8, "eco") { self.messages(s, f).contains { $0.body == "eco: \(text)" } }

        var t0 = Date()
        try await s.editMessage(mine.id, body: text + " (v2)")
        try await waitUntil(8, "el par ve la edición") { self.messages(s, f).contains { $0.body == "vi edición: \(text) (v2)" } }
        let tEdit = Date().timeIntervalSince(t0)
        XCTAssertNotNil(messages(s, f).first { $0.id == mine.id }?.editedAt)

        t0 = Date()
        try await s.setMessagePinned(mine, true)
        XCTAssertEqual(s.pins[f.conversationId]?.contains(mine.id), true)
        try await waitUntil(8, "el par ve el fijado") { self.messages(s, f).contains { $0.body.hasPrefix("vi fijados:") } }
        let tPin = Date().timeIntervalSince(t0)

        t0 = Date()
        try await s.deleteMessage(mine.id)
        try await waitUntil(8, "el par ve el borrado") { self.messages(s, f).contains { $0.body == "vi borrado" } }
        let tDel = Date().timeIntervalSince(t0)
        XCTAssertNotNil(messages(s, f).first { $0.id == mine.id }?.deletedAt)

        // Ahora el par edita y fija su propio mensaje: llegan message.updated y pins.changed en vivo.
        let live0 = s.liveEventsApplied
        t0 = Date()
        s.send(f.conversationId, body: "par: edita")
        try await waitUntil(10, "message.updated del par") { self.messages(s, f).contains { $0.body == "editado por el par" && $0.editedAt != nil } }
        let tPeerEdit = Date().timeIntervalSince(t0)
        let peerMsg = try XCTUnwrap(messages(s, f).first { $0.body == "editado por el par" })
        try await waitUntil(8, "pins.changed del par") { s.pins[f.conversationId]?.contains(peerMsg.id) == true }
        XCTAssertGreaterThan(s.liveEventsApplied, live0)
        print("[medida] v2 edición→par=\(ms(tEdit)) ms · fijar→par=\(ms(tPin)) ms · borrar→par=\(ms(tDel)) ms · par edita+fija→app=\(ms(tPeerEdit)) ms")
    }

    /// Asunto: crear desde un mensaje → cambiar estado → comentar.
    func test2_IssueLifecycle() async throws {
        let (s, f) = try await storeA()
        let origin = try XCTUnwrap(messages(s, f).last { !$0.isSystem })
        let i = try await s.createIssue(conversationId: f.conversationId, title: "Asunto iOS \(UUID().uuidString.prefix(4))", ownerId: f.a.id, dueDate: IssueDates.iso(Date().addingTimeInterval(86400)), originMessageId: origin.id)
        XCTAssertEqual(i.status, .open)
        XCTAssertEqual(i.originMessageId, origin.id)
        XCTAssertGreaterThanOrEqual(s.meta(f.conversationId)?.openIssues ?? 0, 1)
        let up = try await s.updateIssue(i.id, ["status": "in_progress"])
        XCTAssertEqual(up.status, .in_progress)
        try await s.commentIssue(i.id, body: "Avance desde iOS")
        let detail = try await s.issueDetail(i.id)
        XCTAssertTrue(detail.events.contains { $0.kind == "status" && $0.payload["to"]?.stringValue == "in_progress" })
        XCTAssertTrue(detail.events.contains { $0.kind == "comment" })
        let done = try await s.updateIssue(i.id, ["status": "done"])
        XCTAssertTrue(done.status.closed)
        let mine = try await s.loadIssues(mine: true)
        XCTAssertTrue(mine.contains { $0.id == i.id })
    }

    /// Reunión: crear invitando a B → B confirma (par) → calendar.updated en vivo; A responde «quizá».
    func test3_EventCreateAndRsvp() async throws {
        try requirePeer()
        let (s, f) = try await storeA()
        let start = Date().addingTimeInterval(2 * 86400)
        let ev = try await s.createEvent(conversationId: f.conversationId, [
            "title": "Reunión iOS \(UUID().uuidString.prefix(4))", "startsAt": ISODate.string(start), "endsAt": ISODate.string(start.addingTimeInterval(3600)),
            "timezone": "America/Bogota", "inviteeIds": [f.a.id, f.b.id], "location": "https://meet.example/tiecoms",
        ])
        XCTAssertEqual(ev.invitees.count, 2)
        let t0 = Date()
        s.send(f.conversationId, body: "par: reunión")
        try await waitUntil(10, "RSVP del par por calendar.updated") { s.events[ev.id]?.invitees.first { $0.userId == f.b.id }?.rsvp == .yes }
        let tRsvp = Date().timeIntervalSince(t0)
        let mine = try await s.rsvp(ev.id, .maybe)
        XCTAssertEqual(mine.invitees.first { $0.userId == f.a.id }?.rsvp, .maybe)
        let list = try await s.loadEvents(from: Date(), to: start.addingTimeInterval(86400))
        XCTAssertTrue(list.contains { $0.id == ev.id })
        let cancelled = try await s.cancelEvent(ev.id)
        XCTAssertTrue(cancelled.isCancelled)
        print("[medida] v2 RSVP del par → app=\(ms(tRsvp)) ms")
    }

    /// Derivar → devolver: la derivada aparece con parentId y el origen recibe un mensaje mergedFrom.
    func test4_DeriveAndReturn() async throws {
        let (s, f) = try await storeA()
        let origin = try XCTUnwrap(messages(s, f).last { !$0.isSystem && $0.deletedAt == nil })
        let child = try await s.derive(f.conversationId, messageId: origin.id, kind: "same", name: "Derivada iOS", reason: "Prueba")
        let meta = try XCTUnwrap(s.meta(child))
        XCTAssertEqual(meta.parentId, f.conversationId)
        XCTAssertEqual(meta.deriveKind, "same")
        let parent = try await s.returnResult(child, summary: "Resultado desde iOS")
        XCTAssertEqual(parent, f.conversationId)
        try await waitUntil(8, "mensaje mergedFrom en el origen") { self.messages(s, f).contains { $0.mergedFrom == child } }
        XCTAssertNotNil(s.meta(child)?.returnedAt)
    }

    /// Recordatorio que vence en 1 min → reminder.due por socket.
    func test5_ReminderDueBySocket() async throws {
        let (s, f) = try await storeA()
        let due0 = s.remindersDue
        let n0 = Self.spy.notifications.count
        let at = Date().addingTimeInterval(60)
        let r = try await s.createReminder(conversationId: f.conversationId, messageId: nil, note: "Recordatorio iOS", at: at)
        try await waitUntil(100, "reminder.due") { s.remindersDue > due0 }
        let late = Date().timeIntervalSince(at)
        XCTAssertNotNil(s.reminders.first { $0.id == r.id }?.firedAt)
        XCTAssertGreaterThan(Self.spy.notifications.count, n0, "aviso local con tc_notify")
        try await s.completeReminder(r.id)
        print("[medida] v2 reminder.due llegó \(ms(late)) ms después de la hora pedida")
    }

    /// Silenciar → un mensaje de B no suena ni notifica; al reactivar sí.
    func test6_MuteSilences() async throws {
        let (s, f) = try await storeA()
        s.openConversationId = nil
        try await s.setConversationPrefs(f.conversationId, mutedUntil: .some(AppStore.muteUntil(.hour)))
        try await waitUntil(5, "prefs aplicadas") { s.meta(f.conversationId)?.isMuted == true }
        let n0 = Self.spy.notifications.count, r0 = Self.spy.receives
        let text = "silencio \(UUID().uuidString.prefix(4))"
        try await sendAsB(text)
        try await waitUntil(8, "llega el mensaje") { s.meta(f.conversationId)?.lastMessagePreview == text }
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(Self.spy.notifications.count, n0, "silenciada: sin notificación")
        XCTAssertEqual(Self.spy.receives, r0, "silenciada: sin sonido")
        try await s.setConversationPrefs(f.conversationId, mutedUntil: .some(nil))
        try await waitUntil(5, "reactivada") { s.meta(f.conversationId)?.isMuted == false }
        try await sendAsB("ya no silencio")
        try await waitUntil(8, "aviso tras reactivar") { Self.spy.notifications.count > n0 }
        s.openConversationId = f.conversationId
    }

    /// Compartir hacia TieComs: texto de WhatsApp → mensajes con forwarded (mismo camino que la extensión: POST HTTP).
    func test7_ShareIntoTieComs() async throws {
        let (s, f) = try await storeA()
        let shared = "[24/9/26, 10:12] Juan: Llegó el pedido\n[24/9/26, 10:13] Ana: Perfecto \(UUID().uuidString.prefix(4))"
        let items = SharedText.analyze(shared, source: SharedText.detectSource(shared))
        XCTAssertEqual(items.count, 2)
        for it in items {
            let _: SendResult = try await s.api.request("/conversations/\(f.conversationId)/messages", method: "POST",
                                                        json: ["clientMessageId": UUID().uuidString.lowercased(), "body": it.body, "forwarded": it.forwarded.json])
        }
        try await waitUntil(8, "reenviados en la conversación") { self.messages(s, f).contains { $0.forwarded?.source == .whatsapp && $0.forwarded?.author == "Juan" } }
        // Reenvío interno (menú del mensaje) conserva la conversación de origen.
        let src = try XCTUnwrap(messages(s, f).last { !$0.isSystem && $0.deletedAt == nil })
        let others = s.data?.conversations.filter { $0.id != f.conversationId && $0.canPost } ?? []
        if let target = others.first {
            try await s.openConversation(target.id)
            s.forward(src, to: target.id, comment: nil)
            try await waitUntil(8, "reenvío interno") { s.conversations[target.id]?.messages.contains { $0.forwarded?.fromConversationId == f.conversationId } == true }
        }
    }

    /// SSO contra 3041: /start responde redirect o error controlado (no hay credenciales de Google/Microsoft).
    func test8_SSOStartControlled() async throws {
        let f = try fx()
        let pkce = PKCE.generate()
        let url = SSOAuthenticator.startURL(base: URL(string: f.apiUrl)!, provider: .google, deviceId: "ios-test-device", pkce: pkce)
        final class NoRedirect: NSObject, URLSessionTaskDelegate {
            func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest) async -> URLRequest? { nil }
        }
        let session = URLSession(configuration: .ephemeral, delegate: NoRedirect(), delegateQueue: nil)
        let (data, res) = try await session.data(from: url)
        let http = res as! HTTPURLResponse
        let location = http.value(forHTTPHeaderField: "location") ?? ""
        print("[resultado] SSO /start en 3041: HTTP \(http.statusCode) location=\(location.prefix(90)) cuerpo=\(String(decoding: data.prefix(160), as: UTF8.self))")
        XCTAssertTrue((300..<400).contains(http.statusCode) || (400..<600).contains(http.statusCode), "redirect o error controlado")
        if (300..<400).contains(http.statusCode), location.hasPrefix("tiecoms://") {
            XCTAssertNotNil(SSOCallback.parse(URL(string: location)!), "el callback nativo se entiende")
        }
    }

    /// Eliminar cuenta (3042, rama account-deletion): 400 correo distinto, 403 contraseña, 200 y la sesión deja de servir.
    func test9_DeleteAccount() async throws {
        guard let base = ProcessInfo.processInfo.environment["TC_DELETE_API"], !base.isEmpty else { throw XCTSkip("Sin TC_DELETE_API") }
        XCTAssertFalse((base.contains("app.chaggu.com") || base.contains("app.tiecoms.com")))
        let tag = UUID().uuidString.prefix(6).lowercased()
        let email = "borrar.\(tag)@qa.tiecoms.test"
        let password = "Clave-\(UUID().uuidString.prefix(12))"
        let secrets = MemorySecretStore()
        let s = AppStore(baseURL: URL(string: base)!, secrets: secrets, outbox: OutboxStore(directory: tempDir()), feedback: nil)
        try await s.signup(name: "Borrar iOS \(tag)", email: email, password: password, orgName: "QA Borrar \(tag)", orgInviteToken: nil, title: nil)
        XCTAssertEqual(s.status, .ready)
        do { try await s.deleteAccount(confirmEmail: "otro@qa.tiecoms.test", password: password); XCTFail("debió fallar") }
        catch let e as ApiRequestError { XCTAssertEqual(e.status, 400) }
        do { try await s.deleteAccount(confirmEmail: email, password: "incorrecta-123"); XCTFail("debió fallar") }
        catch let e as ApiRequestError { XCTAssertEqual(e.status, 403) }
        do { try await s.deleteAccount(confirmEmail: email, password: nil); XCTFail("sin contraseña debió pedirla") }
        catch let e as ApiRequestError { XCTAssertEqual(e.status, 403) }
        try await s.deleteAccount(confirmEmail: email, password: password)
        XCTAssertEqual(s.status, .anonymous, "vuelve al login")
        XCTAssertNil(secrets.get(), "credenciales locales borradas")
        let (st, _) = try await http(base, "POST", "/auth/login", token: nil, body: ["email": email, "password": password, "device": ["deviceId": UUID().uuidString, "name": "x", "platform": "agent"]])
        XCTAssertEqual(st, 401, "la cuenta ya no entra")
        s.socket.disconnect()
    }
}
