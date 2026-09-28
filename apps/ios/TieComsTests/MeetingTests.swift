import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }

/// 1.6.6 · Reuniones con Meet / Teams / Zoom: idempotencia del diálogo, estados de los chips, errores y vuelta de la conexión.
@MainActor
final class MeetingTests: XCTestCase {
    func testIdempotencyKeyPerTapReusedOnRetryAndBlockedWhileCreating() {
        var n = 0
        let gen = { () -> String in n += 1; return "key-\(n)" }
        var i = MeetingIdempotency()
        XCTAssertEqual(i.begin(newKey: gen), "key-1")
        XCTAssertNil(i.begin(newKey: gen), "doble toque mientras crea: no hay segunda petición")
        i.failed()
        XCTAssertEqual(i.begin(newKey: gen), "key-1", "el reintento usa la misma llave")
        i.failed()
        XCTAssertEqual(i.begin(newKey: gen), "key-1")
        i.succeeded()
        XCTAssertFalse(i.inFlight)
        XCTAssertEqual(i.begin(newKey: gen), "key-2", "otra reunión, otra llave")
        XCTAssertEqual(n, 2)
    }

    func testChipStates() throws {
        let list = try dec(MeetingConnectionsList.self, #"""
        {"connections":[
          {"provider":"google","label":"Google Meet","available":true,"unavailableReason":null,"status":"active","accountEmail":"danny@example.com"},
          {"provider":"microsoft","label":"Microsoft Teams","available":true,"unavailableReason":null,"status":"reconnect","accountEmail":"d@x.com"},
          {"provider":"zoom","label":"Zoom","available":false,"unavailableReason":"Zoom aún no tiene una app OAuth","status":"none","accountEmail":null},
          {"provider":"webex","label":"Webex","available":true,"status":"none"}]}
        """#)
        XCTAssertEqual(list.connections.map(\.provider), [.google, .microsoft, .zoom], "un proveedor desconocido se ignora")
        XCTAssertEqual(list.connections[0].chipState, .connected("danny@example.com"))
        XCTAssertTrue(list.connections[0].canCreate)
        XCTAssertEqual(list.connections[1].chipState, .reconnect)
        XCTAssertFalse(list.connections[1].canCreate)
        XCTAssertEqual(list.connections[2].chipState, .unavailable("Zoom aún no tiene una app OAuth"))
        XCTAssertEqual(MeetingConnectionDTO(provider: .zoom).chipState, .connect)
    }

    func testErrorsMapToExplanations() {
        XCTAssertEqual(MeetingError(ApiRequestError(status: 409, code: "not_connected", message: "x")), .notConnected)
        XCTAssertEqual(MeetingError(ApiRequestError(status: 409, code: "reconnect_required", message: "x")), .reconnectRequired)
        XCTAssertEqual(MeetingError(ApiRequestError(status: 409, code: "no_teams", message: "x")), .noTeams)
        XCTAssertEqual(MeetingError(ApiRequestError(status: 503, code: "provider_unavailable", message: "Falta ZOOM_CLIENT_ID")), .unavailable("Falta ZOOM_CLIENT_ID"))
        XCTAssertEqual(MeetingError(ApiRequestError(status: 502, code: "google_failed", message: "Google Meet: cuota")), .provider("Google Meet: cuota"))
        XCTAssertEqual(MeetingError(ApiRequestError.network(URLError(.notConnectedToInternet))), .network)
        XCTAssertTrue(MeetingError.notConnected.needsConnect)
        XCTAssertFalse(MeetingError.noTeams.needsConnect)
        XCTAssertTrue(MeetingError.unavailable("Falta X").text(.zoom).contains("Falta X"), "se muestra el motivo")
    }

    func testOnlyConfirmedHttpsLinksCount() throws {
        let ok = try dec(MeetingDTO.self, #"{"id":"m","provider":"google","status":"created","title":"R","joinUrl":"https://meet.google.com/abc-defg-hij","messageId":"x"}"#)
        XCTAssertEqual(ok.confirmedURL?.host, "meet.google.com")
        XCTAssertTrue(ok.shared)
        XCTAssertNil(try dec(MeetingDTO.self, #"{"id":"m","provider":"zoom","status":"creating","joinUrl":"https://zoom.us/j/1"}"#).confirmedURL, "sin confirmación no hay enlace")
        XCTAssertNil(try dec(MeetingDTO.self, #"{"id":"m","provider":"zoom","status":"created","joinUrl":"javascript:alert(1)"}"#).confirmedURL)
        XCTAssertNil(try dec(MeetingDTO.self, #"{"id":"m","provider":"zoom","status":"created","joinUrl":null}"#).confirmedURL)
        XCTAssertEqual(MeetingProvider.microsoft.appName, "Teams")
    }

    func testConnectCallbackParsing() {
        XCTAssertEqual(MeetingCallback.parse(URL(string: "chaggu://meetings/connected?provider=google&connected=1")!), .failed(.google, code: "invalid_callback"))
        let receipt = String(repeating: "r", count: 43)
        XCTAssertEqual(MeetingCallback.parse(URL(string: "chaggu://meetings/connected?provider=google&receipt=\(receipt)")!), .receipt(.google, receipt))
        XCTAssertEqual(MeetingCallback.parse(URL(string: "chaggu://meetings/connected?provider=microsoft&error=cancelled")!), .failed(.microsoft, code: "cancelled"))
        XCTAssertEqual(MeetingCallback.parse(URL(string: "chaggu://meetings/connected?provider=zoom&error=denied")!), .failed(.zoom, code: "denied"))
        XCTAssertNil(MeetingCallback.parse(URL(string: "chaggu://auth/callback?code=1")!))
        XCTAssertNil(MeetingCallback.parse(URL(string: "https://evil.example/meetings/connected?connected=1")!))
        XCTAssertTrue(MeetingCallback.isMeetings(URL(string: "chaggu://meetings/connected")!))
        XCTAssertNil(DeepLink.parse(URL(string: "chaggu://meetings/connected?provider=google&connected=1")!), "no es navegación")
    }

    func testNextSlotRoundsToHalfHour() {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "America/Bogota")!
        let d = cal.date(from: DateComponents(year: 2026, month: 9, day: 28, hour: 10, minute: 12, second: 40))!
        XCTAssertEqual(cal.dateComponents([.hour, .minute, .second], from: MeetingSheet.nextSlot(d, calendar: cal)), DateComponents(hour: 10, minute: 30, second: 0))
        let e = cal.date(from: DateComponents(year: 2026, month: 9, day: 28, hour: 23, minute: 45))!
        XCTAssertEqual(cal.dateComponents([.day, .hour, .minute], from: MeetingSheet.nextSlot(e, calendar: cal)), DateComponents(day: 29, hour: 0, minute: 0))
    }
}

extension MeetingTests {
    private var receipt: String { String(repeating: "r", count: 43) }
    private func payload(title: String = "Synthetic meeting", provider: MeetingProvider = .google) -> MeetingPayload {
        MeetingPayload(provider: provider, conversationId: "conversation", title: title, startsAt: nil, durationMin: 30, timezone: "UTC", share: true)
    }

    func testOAuthRequiresProofConfirmationAndRejectsUnsolicitedOrWrongProvider() async throws {
        let s = try ControlledURLProtocol.store()
        let flow = MeetingAuthorization(stamp: s.sessionStamp, provider: .google, connector: MeetingConnector())
        XCTAssertEqual(flow.proof.verifier.count, 43, "32 random bytes in base64url")
        XCTAssertEqual(flow.proof.challenge, PKCE(verifier: flow.proof.verifier).challenge)
        let another = MeetingAuthorization(stamp: s.sessionStamp, provider: .google, connector: MeetingConnector())
        XCTAssertNotEqual(flow.proof.verifier, another.proof.verifier)
        s.meetingAuthorization = flow
        var calls = 0
        ControlledURLProtocol.handler = { req in Task { @MainActor in
            calls += 1
            XCTAssertEqual(req.request.url?.path, "/api/v1/meetings/connect/confirm")
            let body = req.json
            XCTAssertEqual(body["receipt"] as? String, self.receipt)
            XCTAssertEqual(body["proofVerifier"] as? String, flow.proof.verifier)
            req.respond(#"{"ok":true,"provider":"google"}"#)
        } }
        let legacy = try await s.confirmMeetingCallback(.connected(.google), flow: flow)
        XCTAssertEqual(legacy, .failed(.google, code: "invalid_callback"))
        let wrong = try await s.confirmMeetingCallback(.receipt(.zoom, receipt), flow: flow)
        XCTAssertEqual(wrong, .failed(.google, code: "invalid_callback"))
        XCTAssertEqual(calls, 0)
        XCTAssertEqual(s.meetingsRevision, 0)
        let confirmed = try await s.confirmMeetingCallback(.receipt(.google, receipt), flow: flow)
        XCTAssertEqual(confirmed, .connected(.google))
        XCTAssertEqual(calls, 1)
        let replay = try await s.confirmMeetingCallback(.receipt(.google, receipt), flow: flow)
        XCTAssertEqual(replay, .failed(.google, code: "invalid_callback"))
        XCTAssertEqual(calls, 1)
        s.cancelMeetingAuthorization()
        XCTAssertNil(s.meetingAuthorization)
        s.handle(url: URL(string: "chaggu://meetings/connected?provider=google&connected=1")!)
        XCTAssertEqual(s.meetingsRevision, 1, "a bare URL never activates a connection")
    }

    func testHeldConfirmationAndConnectionsAreDiscardedAfterAccountSwitch() async throws {
        for confirmation in [false, true] {
            let s = try ControlledURLProtocol.store()
            let flow = MeetingAuthorization(stamp: s.sessionStamp, provider: .google, connector: MeetingConnector())
            s.meetingAuthorization = flow
            let started = expectation(description: "held account result")
            var held: ControlledURLProtocol?
            ControlledURLProtocol.handler = { req in Task { @MainActor in held = req; started.fulfill() } }
            let task = Task {
                if confirmation { _ = try await s.confirmMeetingCallback(.receipt(.google, self.receipt), flow: flow) }
                else { _ = try await s.loadMeetingConnections() }
            }
            await fulfillment(of: [started], timeout: 2)
            await s.signOutLocally(); s.seedForTesting(try ControlledURLProtocol.boot("b"))
            held?.respond(confirmation ? #"{"ok":true,"provider":"google"}"# : #"{"connections":[{"provider":"google","available":true,"status":"active","accountEmail":"synthetic-a@example.invalid"}]}"#)
            do { try await task.value; XCTFail("old account response") } catch is CancellationError {} catch { XCTFail("\(error)") }
            XCTAssertNil(s.meetingAuthorization)
            XCTAssertEqual(s.meetingsRevision, 0)
        }
    }

    func testUncertainMeetingFreezesPayloadAndRetryChecksSameOperation() async throws {
        let s = try ControlledURLProtocol.store()
        var calls: [(String, String, [String: Any])] = []
        ControlledURLProtocol.handler = { req in Task { @MainActor in
            let method = req.request.httpMethod ?? "GET", path = req.request.url!.path
            calls.append((method, path, req.json))
            if method == "POST" { req.respond(409, #"{"error":{"code":"meeting_uncertain","message":"Uncertain","details":{"meetingId":"meeting-1"}}}"#) }
            else { req.respond(#"{"id":"meeting-1","provider":"google","status":"created","title":"Synthetic meeting","joinUrl":"https://meet.google.com/synthetic"}"#) }
        } }
        let original = payload()
        do { _ = try await s.performMeetingAttempt(original); XCTFail() } catch {}
        let attempt = try XCTUnwrap(s.meetingAttempts["conversation"])
        XCTAssertEqual(attempt.payload, original)
        XCTAssertEqual(attempt.meetingId, "meeting-1")
        XCTAssertFalse(attempt.inFlight)
        do { _ = try await s.performMeetingAttempt(payload(title: "Different", provider: .zoom)); XCTFail() }
        catch { XCTAssertEqual((error as? ApiRequestError)?.code, "idempotency_mismatch") }
        XCTAssertEqual(calls.count, 1, "changing form details cannot reuse the pending key")
        let known = try await s.performMeetingAttempt(original)
        XCTAssertNotNil(known.confirmedURL)
        XCTAssertEqual(calls.map { $0.0 }, ["POST", "GET"], "retry recovers the existing result without a second create")
        XCTAssertNil(s.meetingAttempts["conversation"])
    }

    func testUnconfirmedStoredMeetingRetriesExactPostAfterLookup() async throws {
        for (failure, status) in [("meeting_uncertain", "creating"), ("not_connected", "failed"), ("reconnect_required", "failed")] {
            let s = try ControlledURLProtocol.store()
            var calls: [(String, String)] = []
            var bodies: [[String: Any]] = []
            ControlledURLProtocol.handler = { req in Task { @MainActor in
                let method = req.request.httpMethod ?? "GET"
                calls.append((method, req.request.url!.path))
                if method == "GET" {
                    req.respond(#"{"id":"meeting-1","provider":"google","status":"\#(status)","title":"Synthetic meeting"}"#)
                } else {
                    bodies.append(req.json)
                    if bodies.count == 1 {
                        req.respond(409, #"{"error":{"code":"\#(failure)","message":"Synthetic failure","details":{"meetingId":"meeting-1"}}}"#)
                    } else {
                        req.respond(#"{"id":"meeting-1","provider":"google","status":"created","joinUrl":"https://meet.google.com/synthetic"}"#)
                    }
                }
            } }
            let original = payload()
            do { _ = try await s.performMeetingAttempt(original); XCTFail() } catch {}
            let retained = try XCTUnwrap(s.meetingAttempts["conversation"])
            XCTAssertEqual(retained.meetingId, "meeting-1")
            let recovered = try await s.performMeetingAttempt(original)
            XCTAssertNotNil(recovered.confirmedURL)
            XCTAssertEqual(calls.map { $0.0 }, ["POST", "GET", "POST"])
            XCTAssertEqual(calls[1].1, "/api/v1/meetings/meeting-1")
            XCTAssertEqual(bodies.count, 2)
            XCTAssertEqual(bodies[1]["idempotencyKey"] as? String, retained.key)
            XCTAssertEqual(try JSONSerialization.data(withJSONObject: bodies[0], options: .sortedKeys),
                           try JSONSerialization.data(withJSONObject: bodies[1], options: .sortedKeys),
                           "Recovery must resume the original operation after \(failure), never start another meeting")
            XCTAssertNil(s.meetingAttempts["conversation"])
        }
    }

    func testLostResponseRetriesIdenticalPayloadAndKeyAndBlocksDoubleTap() async throws {
        let s = try ControlledURLProtocol.store()
        let started = expectation(description: "create retained")
        var held: ControlledURLProtocol?
        var bodies: [[String: Any]] = []
        ControlledURLProtocol.handler = { req in Task { @MainActor in
            bodies.append(req.json)
            if held == nil { held = req; started.fulfill() }
            else { req.respond(#"{"id":"meeting-1","provider":"google","status":"created","joinUrl":"https://meet.google.com/synthetic"}"#) }
        } }
        let p = payload()
        let first = Task { try await s.performMeetingAttempt(p) }
        await fulfillment(of: [started], timeout: 2)
        do { _ = try await s.performMeetingAttempt(p); XCTFail() }
        catch { XCTAssertEqual((error as? ApiRequestError)?.code, "meeting_in_progress") }
        held?.respond(502, #"{"error":{"code":"network","message":"Lost response"}}"#)
        do { _ = try await first.value; XCTFail() } catch {}
        _ = try await s.performMeetingAttempt(p)
        XCTAssertEqual(bodies.count, 2)
        XCTAssertEqual(try JSONSerialization.data(withJSONObject: bodies[0], options: .sortedKeys), try JSONSerialization.data(withJSONObject: bodies[1], options: .sortedKeys))
    }

    func testHeldMeetingCreationCannotAppearInNextAccountAndOld401DoesNotRetry() async throws {
        for status in [200, 401] {
            let s = try ControlledURLProtocol.store()
            let started = expectation(description: "create retained")
            var held: ControlledURLProtocol?, calls = 0
            ControlledURLProtocol.handler = { req in Task { @MainActor in calls += 1; held = req; started.fulfill() } }
            let task = Task { try await s.performMeetingAttempt(payload()) }
            await fulfillment(of: [started], timeout: 2)
            await s.signOutLocally(); s.seedForTesting(try ControlledURLProtocol.boot("b"))
            held?.respond(status, status == 200 ? #"{"id":"meeting-a","provider":"google","status":"created","joinUrl":"https://meet.google.com/synthetic"}"# : #"{"error":{"code":"unauthorized","message":"expired"}}"#)
            do { _ = try await task.value; XCTFail() } catch is CancellationError {} catch { XCTFail("\(error)") }
            XCTAssertTrue(s.meetingAttempts.isEmpty)
            XCTAssertTrue(s.events.isEmpty)
            XCTAssertEqual(calls, 1, "A's 401 cannot retry under B's token")
        }
    }
}

extension MeetingTests {
    func testPendingOperationSurvivesRelaunchOnlyForItsUserAndIsDeletedOnLogout() async throws {
        let directory = tempDir()
        func store(_ user: String) throws -> AppStore {
            let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ControlledURLProtocol.self]
            let s = AppStore(baseURL: URL(string: "https://synthetic.invalid")!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: directory), feedback: nil, session: URLSession(configuration: config))
            s.seedForTesting(try ControlledURLProtocol.boot(user))
            return s
        }
        let first = try store("a")
        ControlledURLProtocol.handler = { req in req.respond(409, #"{"error":{"code":"meeting_in_progress","message":"still working","details":{"meetingId":"meeting-pending"}}}"#) }
        do { _ = try await first.performMeetingAttempt(payload()); XCTFail() } catch {}
        let original = try XCTUnwrap(first.meetingAttempts["conversation"])
        let relaunched = try store("a")
        XCTAssertEqual(relaunched.meetingAttempts["conversation"], original)
        XCTAssertFalse(relaunched.meetingAttempts["conversation"]!.inFlight)
        XCTAssertTrue(try store("b").meetingAttempts.isEmpty)
        let data = try XCTUnwrap(OutboxStore(directory: directory).loadMeetingAttempts(userId: "a"))
        let json = String(decoding: data, as: UTF8.self)
        XCTAssertFalse(json.contains("proofVerifier")); XCTAssertFalse(json.contains("receipt")); XCTAssertFalse(json.contains("accessToken"))
        await relaunched.signOutLocally()
        XCTAssertNil(try OutboxStore(directory: directory).loadMeetingAttempts(userId: "a"))
        XCTAssertTrue(try store("a").meetingAttempts.isEmpty)
    }

    func testOAuthStartSendsChallengeAndCancelDiscardsHeldResponseWithoutOpeningBrowser() async throws {
        let s = try ControlledURLProtocol.store()
        let started = expectation(description: "start retained")
        var held: ControlledURLProtocol?
        ControlledURLProtocol.handler = { req in Task { @MainActor in
            let body = req.json
            XCTAssertEqual(body["platform"] as? String, "ios")
            XCTAssertEqual(body["redirectScheme"] as? String, "chaggu")
            XCTAssertEqual(body["proofChallenge"] as? String, s.meetingAuthorization?.proof.challenge)
            XCTAssertNil(body["proofVerifier"])
            held = req; started.fulfill()
        } }
        let task = Task { try await s.connectMeetings(.google) }
        await fulfillment(of: [started], timeout: 2)
        s.cancelMeetingAuthorization()
        held?.respond(#"{"url":"https://provider.invalid/authorization"}"#)
        do { _ = try await task.value; XCTFail() } catch is CancellationError {} catch { XCTFail("\(error)") }
        XCTAssertNil(s.meetingAuthorization)
        XCTAssertEqual(s.meetingsRevision, 0)
    }
}
