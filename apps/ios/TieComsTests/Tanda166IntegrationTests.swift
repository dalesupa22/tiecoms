import XCTest
@testable import TieComs

/// 1.6.6 contra un API de PRUEBAS local (rama tanda-lectura-reuniones, migración 028, contrato 2026-09-28).
/// Fixture: `API_URL=http://localhost:3075 FIXTURE_OUT=/tmp/fx.json node apps/ios/tools/fixtures/tanda166-fixture.mjs`
/// y `TEST_RUNNER_TC_FIXTURE166=/tmp/fx.json`. Usa un fixture nuevo por corrida (las pruebas cambian lo leído).
@MainActor
final class Tanda166IntegrationTests: XCTestCase {
    struct Fixture: Decodable {
        struct Person: Decodable { var email: String; var id: String }
        var apiUrl: String
        var password: String
        var a: Person
        var b: Person
        var c: Person
        var generalId: String
        var diagId: String
        var decisionId: String
        var longId: String
        var sharedIssueId: String
        var personalIssueId: String
    }

    static var fx: Fixture?
    static var storeA: AppStore?
    static var tokens: [String: String] = [:]

    private func fixture() throws -> Fixture {
        if let f = Self.fx { return f }
        guard let path = ProcessInfo.processInfo.environment["TC_FIXTURE166"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE166") }
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        XCTAssertFalse(f.apiUrl.contains("app.chaggu.com") || f.apiUrl.contains("app.tiecoms.com"), "nunca contra producción")
        Self.fx = f
        return f
    }

    /// Store de Danny con sesión (compartido: el login tiene límite por minuto).
    private func store() async throws -> (AppStore, Fixture) {
        let f = try fixture()
        if let s = Self.storeA, s.status == .ready { return (s, f) }
        let s = AppStore(baseURL: URL(string: f.apiUrl)!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: nil)
        try await s.login(email: f.a.email, password: f.password)
        try await waitUntil(10, "socket") { s.connection == .online }
        Self.storeA = s
        return (s, f)
    }

    /// Token de otra persona del fixture (HTTP directo, como otro dispositivo).
    private func token(_ p: Fixture.Person) async throws -> String {
        if let t = Self.tokens[p.id] { return t }
        let (_, j) = try await http("POST", "/auth/login", token: nil, body: ["email": p.email, "password": try fixture().password,
                                                                          "device": ["deviceId": UUID().uuidString, "name": "XCTest 1.6.6", "platform": "agent"]])
        let t = try XCTUnwrap(j["accessToken"] as? String)
        Self.tokens[p.id] = t
        return t
    }

    @discardableResult
    private func http(_ method: String, _ path: String, token: String?, body: [String: Any]? = nil, contract: String = "2026-09-28") async throws -> (Int, [String: Any]) {
        let f = try fixture()
        var req = URLRequest(url: URL(string: "\(f.apiUrl)/api/v1\(path)")!)
        req.httpMethod = method
        req.setValue(contract, forHTTPHeaderField: "x-tiecoms-contract")
        if let body { req.httpBody = try JSONSerialization.data(withJSONObject: body); req.setValue("application/json", forHTTPHeaderField: "content-type") }
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        let (data, res) = try await URLSession(configuration: .ephemeral).data(for: req)
        return ((res as! HTTPURLResponse).statusCode, (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:])
    }

    private func convs(_ token: String) async throws -> [[String: Any]] {
        let (_, j) = try await http("GET", "/bootstrap", token: token)
        return j["conversations"] as? [[String: Any]] ?? []
    }

    // MARK: 1. Pendientes del árbol

    /// El caso de Danny, la carrera con un mensaje nuevo, read.updated en el otro dispositivo y la persistencia al reabrir.
    func test1TreeMarkReadRaceSyncAndPersistence() async throws {
        let (s, f) = try await store()
        let d = try XCTUnwrap(s.data)
        let gen = try XCTUnwrap(s.meta(f.generalId))
        XCTAssertEqual(gen.unread, 0, "General está leído")
        let t = ReadTree.pending(d, gen)
        XCTAssertEqual(t.unread, 11, "5 (Diagnóstico) + 6 (Decisión) sin leer en derivadas nunca abiertas")
        XCTAssertEqual(t.mentions, 1, "la mención antigua de la decisión")
        XCTAssertEqual(HomeFilter.unread.groupCount(d), 2, "General (por su árbol) y la Cohorte larga")
        XCTAssertTrue(t.canMarkRead)

        // Los ítems se toman con lo que el cliente conoce; Bruno escribe en la decisión antes de que se manden.
        let items = ReadTree.items(d, gen)
        XCTAssertEqual(Set(items.map(\.conversationId)), [f.generalId, f.diagId, f.decisionId])
        let tb = try await token(f.b)
        let (st, _) = try await http("POST", "/conversations/\(f.decisionId)/messages", token: tb,
                                     body: ["clientMessageId": UUID().uuidString, "body": "Llegó mientras marcabas"])
        XCTAssertTrue((200..<300).contains(st))
        let (rt, r) = try await http("POST", "/conversations/\(f.generalId)/read-tree", token: s.api.accessToken,
                                     body: ["items": items.map(\.json)])
        XCTAssertEqual(rt, 200, "\(r)")
        XCTAssertEqual((r["marked"] as? [Any])?.count, 3)

        // read.updated llega al store (como a otro dispositivo): el árbol queda con solo el mensaje nuevo.
        try await waitUntil(10, "read.updated del árbol") { s.meta(f.diagId)?.unread == 0 && (s.meta(f.decisionId)?.lastReadSeq ?? 0) >= items.first { $0.conversationId == f.decisionId }!.seq }
        try await waitUntil(10, "el mensaje nuevo en vivo") { s.meta(f.decisionId)?.unread == 1 }
        XCTAssertEqual(ReadTree.pending(try XCTUnwrap(s.data), try XCTUnwrap(s.meta(f.generalId))).unread, 1, "lo que llegó después sigue sin leer")

        // Reabrir: otro login de Danny ve lo mismo desde el servidor.
        let other = AppStore(baseURL: URL(string: f.apiUrl)!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: nil)
        try await other.login(email: f.a.email, password: f.password)
        let d2 = try XCTUnwrap(other.data)
        XCTAssertEqual(other.meta(f.diagId)?.unread, 0)
        XCTAssertEqual(other.meta(f.decisionId)?.unread, 1)
        XCTAssertEqual(other.meta(f.decisionId)?.unreadMentions, 0, "la mención antigua quedó leída al marcar")
        XCTAssertEqual(ReadTree.pending(d2, try XCTUnwrap(other.meta(f.generalId))).unread, 1)

        // «Marcar como leído» desde el menú (la acción del store) deja el árbol en cero y lo mantiene al reabrir.
        try await s.markTreeRead(f.generalId)
        XCTAssertEqual(ReadTree.pending(try XCTUnwrap(s.data), try XCTUnwrap(s.meta(f.generalId))).unread, 0)
        try await other.loadBootstrap()
        XCTAssertEqual(ReadTree.pending(try XCTUnwrap(other.data), try XCTUnwrap(other.meta(f.generalId))).unread, 0, "persistido")
        await other.logout()
    }

    /// El servidor rechaza lo que no es del árbol (un sidechat o una conversación ajena) sin romper el resto.
    func test2ReadTreeIgnoresForeignItems() async throws {
        let (s, f) = try await store()
        let (st, r) = try await http("POST", "/conversations/\(f.generalId)/read-tree", token: s.api.accessToken,
                                     body: ["items": [["conversationId": f.longId, "seq": 70], ["conversationId": f.generalId, "seq": s.meta(f.generalId)?.lastMessageSeq ?? 0]]])
        XCTAssertEqual(st, 200)
        XCTAssertEqual((r["marked"] as? [[String: Any]])?.compactMap { $0["conversationId"] as? String }, [f.generalId], "la Cohorte larga no es derivada de General")
        try await s.loadBootstrap()
        XCTAssertEqual(s.meta(f.longId)?.unread, 40, "no se marcó lo que no es del árbol")
    }

    /// Paginación: abrir el chat largo y ver solo una parte deja el resto (y la mención del 55) sin leer, también al reabrir.
    func test3PartialReadOfPaginatedChatPersists() async throws {
        let (s, f) = try await store()
        try await s.openConversation(f.longId)
        XCTAssertEqual(s.conversations[f.longId]?.messages.count, 50, "primera página")
        let seen = try XCTUnwrap(s.meta(f.longId)?.lastReadSeq) + 10
        s.markRead(f.longId, upTo: seen)
        try await Task.sleep(nanoseconds: 900_000_000)  // debounce de 400 ms + POST
        let other = AppStore(baseURL: URL(string: f.apiUrl)!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: nil)
        try await other.login(email: f.a.email, password: f.password)
        XCTAssertEqual(other.meta(f.longId)?.lastReadSeq, seen)
        XCTAssertEqual(other.meta(f.longId)?.unread, 30, "lo que no se vio sigue sin leer")
        XCTAssertEqual(other.meta(f.longId)?.unreadMentions, 1, "la mención del mensaje 55 sigue pendiente")
        await other.logout()
    }

    // MARK: 3. Asuntos personales

    /// Solo su dueño lo ve (lista, por id, tiempo real); no se reasigna, no se comparte ni tiene tareas; las apps 1.6.5 no lo reciben.
    func test4PersonalIssuePrivacyAndRealtime() async throws {
        let (s, f) = try await store()
        _ = try await s.loadIssues()
        XCTAssertNotNil(s.issues[f.personalIssueId], "el personal del fixture llega con el contrato 2026-09-28")
        XCTAssertNil(s.issues[f.personalIssueId]?.conversationId)
        let mine = try await s.createPersonalIssue(title: "Renovar mi pasaporte", dueDate: nil)
        XCTAssertTrue(mine.isPersonal)
        XCTAssertEqual(mine.visibility, .private)
        XCTAssertEqual(mine.ownerId, f.a.id)

        // Bruno (otra empresa) y Carla (mi empresa) no lo ven por lista ni por id.
        for p in [f.b, f.c] {
            let t = try await token(p)
            let (_, list) = try await http("GET", "/issues", token: t)
            let ids = (list["issues"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }
            XCTAssertFalse(ids.contains(mine.id) || ids.contains(f.personalIssueId), "\(p.email) no ve personales ajenos")
            let (st, _) = try await http("GET", "/issues/\(mine.id)", token: t)
            XCTAssertEqual(st, 404, "por id: 404 para los demás")
        }
        // Un cliente 1.6.5 (contrato anterior) no recibe asuntos sin conversación.
        let (_, old) = try await http("GET", "/issues", token: s.api.accessToken, contract: "2026-09-26")
        XCTAssertFalse((old["issues"] as? [[String: Any]] ?? []).contains { ($0["id"] as? String) == mine.id })

        // No se reasigna, no se comparte ni admite tareas (400).
        let (st1, _) = try await http("PATCH", "/issues/\(mine.id)", token: s.api.accessToken, body: ["ownerId": f.b.id])
        XCTAssertEqual(st1, 400)
        let (st2, _) = try await http("PATCH", "/issues/\(mine.id)", token: s.api.accessToken, body: ["visibility": "all"])
        XCTAssertEqual(st2, 400)
        let (st3, _) = try await http("POST", "/issues/\(mine.id)/children", token: s.api.accessToken, body: ["title": "Subtarea"])
        XCTAssertEqual(st3, 400)

        // Tiempo real: otro dispositivo de Danny recibe issue.personal; nadie más.
        let other = AppStore(baseURL: URL(string: f.apiUrl)!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: nil)
        try await other.login(email: f.a.email, password: f.password)
        try await waitUntil(10, "socket") { other.connection == .online }
        try await s.updateIssue(mine.id, ["title": "Renovar mi pasaporte (cita)", "dueDate": IssueDates.today()])
        try await waitUntil(10, "issue.personal en el otro dispositivo") { other.issues[mine.id]?.title == "Renovar mi pasaporte (cita)" }
        XCTAssertEqual(other.meta(f.generalId)?.openIssues, s.meta(f.generalId)?.openIssues, "no cambia contadores de conversaciones")
        await other.logout()
    }

    // MARK: 4. Reuniones (proveedor MOCK: tools/fake-meetings.mjs; NO prueba OAuth real)

    /// Sigue una redirección sin ir más allá (para recorrer el OAuth del MOCK sin navegador).
    private final class NoFollow: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    }
    private func location(_ url: URL) async throws -> URL {
        let s = URLSession(configuration: .ephemeral, delegate: NoFollow(), delegateQueue: nil)
        let (_, res) = try await s.data(from: url)
        return try XCTUnwrap(((res as? HTTPURLResponse)?.value(forHTTPHeaderField: "location")).flatMap(URL.init(string:)))
    }
    private func mock(_ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
        guard let base = ProcessInfo.processInfo.environment["TC_FAKE_MEETINGS"], !base.isEmpty else { throw XCTSkip("Sin TC_FAKE_MEETINGS") }
        var req = URLRequest(url: URL(string: base + path)!)
        if let body { req.httpMethod = "POST"; req.httpBody = try JSONSerialization.data(withJSONObject: body); req.setValue("application/json", forHTTPHeaderField: "content-type") }
        let (d, _) = try await URLSession(configuration: .ephemeral).data(for: req)
        return (try? JSONSerialization.jsonObject(with: d) as? [String: Any]) ?? [:]
    }
    /// Conectar con el MOCK: POST /meetings/connect → auth del MOCK → callback del API → chaggu://meetings/connected.
    private func mockConnect(_ s: AppStore, _ p: MeetingProvider) async throws -> MeetingCallback? {
        let r: AppStore.UrlResult = try await s.api.request("/meetings/connect/\(p.rawValue)", method: "POST", json: ["platform": "ios", "redirectScheme": "chaggu"])
        let back = try await location(try await location(try XCTUnwrap(URL(string: r.url))))
        XCTAssertEqual(back.scheme, "chaggu", "vuelve a la app nativa: \(back)")
        return MeetingCallback.parse(back)
    }

    func test5MeetingsWithMockProvider() async throws {
        let (s, f) = try await store()
        _ = try await mock("/control", ["msNoTeams": false, "revokeAll": false, "failNext": NSNull()])
        let before = try await mock("/stats")
        var conns = try await s.loadMeetingConnections()
        XCTAssertEqual(conns.map(\.provider), [.google, .microsoft, .zoom])
        XCTAssertEqual(conns.first { $0.provider == .zoom }?.chipState, .unavailable(conns.first { $0.provider == .zoom }?.unavailableReason), "Zoom sin app OAuth: No disponible con el motivo")
        XCTAssertNotNil(conns.first { $0.provider == .zoom }?.unavailableReason)

        // Sin conectar: 409 not_connected. Zoom: 503 provider_unavailable.
        do { _ = try await s.createMeeting(.microsoft, conversationId: f.generalId, idempotencyKey: UUID().uuidString, title: "Reunión · General", startsAt: nil, durationMin: 30); XCTFail("sin conexión") }
        catch { XCTAssertEqual(MeetingError(error), .notConnected) }
        do { _ = try await s.createMeeting(.zoom, conversationId: f.generalId, idempotencyKey: UUID().uuidString, title: "Reunión · General", startsAt: nil, durationMin: 30); XCTFail("zoom") }
        catch { if case .unavailable = MeetingError(error) {} else { XCTFail("\(error)") } }

        // Conectar Google (MOCK) y crear «ahora»: enlace del proveedor, mensaje en el chat y reunión en el calendario.
        let cb1 = try await mockConnect(s, .google)
        XCTAssertEqual(cb1, .connected(.google))
        conns = try await s.loadMeetingConnections()
        XCTAssertEqual(conns.first { $0.provider == .google }?.chipState, .connected("mock.google@example.com"))
        var idem = MeetingIdempotency()
        let key = try XCTUnwrap(idem.begin())
        let m = try await s.createMeeting(.google, conversationId: f.generalId, idempotencyKey: key, title: "Reunión · General", startsAt: nil, durationMin: 30)
        XCTAssertEqual(m.confirmedURL?.host, "meet.google.com")
        XCTAssertTrue(m.shared, "se publicó en el chat")
        XCTAssertNotNil(m.calendarEventId)
        // Reintento con la misma llave (respuesta perdida): la misma reunión, sin otra en el proveedor.
        let again = try await s.createMeeting(.google, conversationId: f.generalId, idempotencyKey: key, title: "Reunión · General", startsAt: nil, durationMin: 30)
        XCTAssertEqual(again.id, m.id); XCTAssertEqual(again.joinUrl, m.joinUrl)
        idem.succeeded()
        let stats = try await mock("/stats")
        XCTAssertEqual((stats["google"] as? Int ?? 0) - (before["google"] as? Int ?? 0), 1, "un solo evento en el proveedor")
        try await waitUntil(10, "reunión en el calendario con el enlace") { s.events[m.calendarEventId ?? ""]?.location == m.joinUrl }
        try await waitUntil(10, "mensaje con el enlace real") { (s.meta(f.generalId)?.lastMessagePreview ?? "").contains("Google Meet") }

        // Agendada: con fecha y hora.
        let at = Date().addingTimeInterval(3 * 86400)
        let later = try await s.createMeeting(.google, conversationId: f.generalId, idempotencyKey: UUID().uuidString, title: "Seguimiento", startsAt: at, durationMin: 45)
        XCTAssertEqual(abs((ISODate.parse(later.startsAt) ?? .distantPast).timeIntervalSince(at)), 0, accuracy: 1)

        // Falla del proveedor (502): no hay enlace; el reintento con la misma llave sí crea una sola.
        _ = try await mock("/control", ["failNext": "google"])
        let k2 = UUID().uuidString
        do { _ = try await s.createMeeting(.google, conversationId: f.generalId, idempotencyKey: k2, title: "Con falla", startsAt: nil, durationMin: 15); XCTFail("falla") }
        catch { if case .provider = MeetingError(error) {} else { XCTFail("\(error)") } }
        let retried = try await s.createMeeting(.google, conversationId: f.generalId, idempotencyKey: k2, title: "Con falla", startsAt: nil, durationMin: 15)
        XCTAssertNotNil(retried.confirmedURL)

        // Microsoft sin Teams para empresas: no_teams.
        let cb2 = try await mockConnect(s, .microsoft)
        XCTAssertEqual(cb2, .connected(.microsoft))
        _ = try await mock("/control", ["msNoTeams": true])
        do { _ = try await s.createMeeting(.microsoft, conversationId: f.generalId, idempotencyKey: UUID().uuidString, title: "Teams", startsAt: nil, durationMin: 30); XCTFail("no_teams") }
        catch { XCTAssertEqual(MeetingError(error), .noTeams) }
        _ = try await mock("/control", ["msNoTeams": false])

        // Permiso revocado en el proveedor: reconnect_required y el chip pasa a «Reconectar».
        _ = try await mock("/control", ["revokeAll": true])
        do { _ = try await s.createMeeting(.google, conversationId: f.generalId, idempotencyKey: UUID().uuidString, title: "Revocado", startsAt: nil, durationMin: 30); XCTFail("revocado") }
        catch { XCTAssertEqual(MeetingError(error), .reconnectRequired) }
        _ = try await mock("/control", ["revokeAll": false])
        conns = try await s.loadMeetingConnections()
        XCTAssertEqual(conns.first { $0.provider == .google }?.chipState, .reconnect)
        let cb3 = try await mockConnect(s, .google)
        XCTAssertEqual(cb3, .connected(.google), "reconectar")

        // Desconectar.
        try await s.disconnectMeetings(.microsoft)
        conns = try await s.loadMeetingConnections()
        XCTAssertEqual(conns.first { $0.provider == .microsoft }?.chipState, .connect)
    }
}
