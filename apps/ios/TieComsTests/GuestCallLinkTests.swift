import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }

private let stateJSON = #"""
{"callId":"call9","kind":"video","active":true,"transcribing":false,"activeUserIds":["u1"],
 "guests":[{"id":"g1","name":"Laura Invitada"}],"names":{"u1":"Bruno Ortega","guest:g1":"Laura Invitada"}}
"""#
private let guestJoinJSON = #"""
{"guestId":"g1","secret":"s3cr3t-s3cr3t-s3cr3t-s3cr3t","call":\#(stateJSON),
 "meeting":{"Meeting":{"MeetingId":"fake-call9","ExternalMeetingId":"call9","MediaRegion":"us-east-1",
   "MediaPlacement":{"AudioHostUrl":"fake.invalid:3478","SignalingUrl":"wss://fake.invalid/control","TurnControlUrl":"https://fake.invalid/turn"}}},
 "attendee":{"Attendee":{"AttendeeId":"att-g1","ExternalUserId":"guest:g1","JoinToken":"tok-g1"}}}
"""#

/// Enlaces de llamada para invitados (/llamada/<token>), pantallas compartidas e invitados en CallDTO (docs/LLAMADAS.md).
@MainActor
final class GuestCallLinkTests: XCTestCase {
    // MARK: Enlace

    func testParsesUniversalAndSchemeCallLinks() {
        let tok = "tokenInvalidoDePrueba123"
        for s in ["https://app.chaggu.com/llamada/\(tok)", "https://chaggu.com/llamada/\(tok)", "https://www.chaggu.com/llamada/\(tok)/",
                  "https://app.tiecoms.com/llamada/\(tok)", "chaggu://llamada/\(tok)", "chaggu:///llamada/\(tok)", "CHAGGU://llamada/\(tok)"] {
            XCTAssertEqual(DeepLink.parse(URL(string: s)!), .guestCall(tok), s)
        }
        XCTAssertEqual(DeepLink.parse(URL(string: "https://app.chaggu.com/llamada/aB3_x-Z9?utm=1")!), .guestCall("aB3_x-Z9"), "la consulta no cuenta")
        XCTAssertNil(DeepLink.parse(URL(string: "https://app.chaggu.com/llamada")!), "sin token")
        XCTAssertNil(DeepLink.parse(URL(string: "chaggu://llamada/")!), "sin token")
        XCTAssertNil(DeepLink.parse(URL(string: "https://app.chaggu.com/llamada/ab%20cd")!), "espacio")
        XCTAssertNil(DeepLink.parse(URL(string: "https://app.chaggu.com/llamada/%C3%B1and%C3%BA")!), "fuera de base64url")
        XCTAssertNil(DeepLink.parse(URL(string: "https://app.chaggu.com/llamada/" + String(repeating: "a", count: 129))!), "demasiado largo")
        XCTAssertNil(DeepLink.parse(URL(string: "https://example.com/llamada/\(tok)")!), "otro dominio")
        XCTAssertTrue(DeepLink.validCallToken("Ab-_09"))
        XCTAssertFalse(DeepLink.validCallToken(""))
    }

    func testLinkOpensGuestScreenWithoutSessionAndMinimizesCurrentCall() throws {
        let s = try ControlledURLProtocol.store()
        s.handle(url: URL(string: "https://app.chaggu.com/llamada/tokenInvalidoDePrueba123")!)
        XCTAssertEqual(s.guestLinkToken, "tokenInvalidoDePrueba123", "se abre aunque el estado no sea .ready")
        s.guestLinkToken = nil
        s.callCenter.expanded = true
        s.handle(url: URL(string: "chaggu://llamada/otroToken_456")!)
        XCTAssertEqual(s.guestLinkToken, "otroToken_456")
        XCTAssertFalse(s.callCenter.expanded, "otra llamada a pantalla completa se minimiza para ver el enlace")
    }

    // MARK: Decodificación

    func testDecodesGuestPreviewStateJoinAndCallGuests() throws {
        let p = try dec(GuestCallPreviewDTO.self, #"{"title":"Obra Norte","hostName":"Bruno Ortega","orgName":"Xertify","kind":"video","active":true}"#)
        XCTAssertEqual(p, GuestCallPreviewDTO(title: "Obra Norte", hostName: "Bruno Ortega", orgName: "Xertify", kind: "video", active: true))
        XCTAssertTrue(p.isVideo)
        let direct = try dec(GuestCallPreviewDTO.self, #"{"title":null,"hostName":"Bruno","orgName":null,"kind":"audio","active":false}"#)
        XCTAssertNil(direct.title); XCTAssertNil(direct.orgName); XCTAssertFalse(direct.active); XCTAssertFalse(direct.isVideo)

        let st = try dec(GuestCallStateDTO.self, stateJSON)
        XCTAssertEqual(st.callId, "call9"); XCTAssertEqual(st.activeUserIds, ["u1"])
        XCTAssertEqual(st.guests, [CallGuestDTO(id: "g1", name: "Laura Invitada")])
        XCTAssertEqual(st.names["guest:g1"], "Laura Invitada")
        let broken = try dec(GuestCallStateDTO.self, #"{"callId":"x","guests":[{"name":"sin id"},{"id":"g2","name":"Ok"}]}"#)
        XCTAssertEqual(broken.guests.map(\.id), ["g2"], "un invitado defectuoso se descarta")
        XCTAssertFalse(broken.active); XCTAssertEqual(broken.kind, "audio")

        let j = try dec(GuestJoinDTO.self, guestJoinJSON)
        XCTAssertEqual(j.guestId, "g1"); XCTAssertEqual(j.secret, "s3cr3t-s3cr3t-s3cr3t-s3cr3t")
        XCTAssertEqual(j.join.call.id, "call9"); XCTAssertEqual(j.join.call.conversationId, "")
        XCTAssertEqual(j.join.attendee.externalUserId, "guest:g1"); XCTAssertTrue(j.join.isFake)
        XCTAssertTrue(j.join.call.isVideo); XCTAssertTrue(j.join.call.isLive)

        let c = try dec(CallDTO.self, #"{"id":"call9","conversationId":"c1","activeUserIds":["u1"],"guests":[{"id":"g1","name":"Laura"},{"bad":1}]}"#)
        XCTAssertEqual(c.guests, [CallGuestDTO(id: "g1", name: "Laura")])
        XCTAssertEqual(CallRules.people(c), ["u1", "guest:g1"])
        XCTAssertEqual(CallRules.guestName(c, "guest:g1"), "Laura")
        XCTAssertNil(CallRules.guestName(c, "u1"))
        let old = try dec(CallDTO.self, #"{"id":"x","conversationId":"c1"}"#)
        XCTAssertEqual(old.guests, [], "servidor anterior: sin invitados")
    }

    func testGuestRules() throws {
        XCTAssertEqual(CallRules.guestUserId("g1"), "guest:g1")
        XCTAssertTrue(CallRules.isGuest("guest:g1")); XCTAssertFalse(CallRules.isGuest("u1"))
        // Pantalla compartida: attendee «{id}#content» y externalUserId «{ext}#content» → la persona.
        XCTAssertEqual(CallRules.baseAttendee("att-1#content"), "att-1")
        XCTAssertEqual(CallRules.personId("guest:g1#content"), "guest:g1")
        XCTAssertEqual(CallRules.personId("u1#ios12345#content"), "u1")
        XCTAssertEqual(CallRules.cleanGuestName("  Laura  "), "Laura")
        XCTAssertNil(CallRules.cleanGuestName("   "))
        XCTAssertEqual(CallRules.cleanGuestName(String(repeating: "x", count: 80))?.count, 60)
        XCTAssertTrue(CallRules.guestGone(ApiRequestError(status: 409, code: "not_in_call", message: "")))
        XCTAssertTrue(CallRules.guestGone(ApiRequestError(status: 404, code: "not_found", message: "")))
        XCTAssertFalse(CallRules.guestGone(ApiRequestError(status: 0, code: "network", message: "")), "sin red se sigue intentando")
        XCTAssertFalse(CallRules.guestGone(ApiRequestError(status: 502, code: "server_updating", message: "")))

        let st = try dec(GuestCallStateDTO.self, stateJSON)
        let first = CallRules.guestCall(st, prev: nil)
        XCTAssertEqual(first.names["u1"], "Bruno Ortega"); XCTAssertEqual(first.guests.count, 1); XCTAssertNil(first.endedAt)
        var prev = first; prev.startedAt = "2026-09-30T10:00:00.000Z"
        XCTAssertEqual(CallRules.guestCall(st, prev: prev).startedAt, "2026-09-30T10:00:00.000Z", "el reloj no se reinicia en cada latido")
    }

    // MARK: Llamada como invitado

    func testGuestJoinHeartbeatAndLeave() async throws {
        let s = try ControlledURLProtocol.store()
        var paths: [String] = []
        var bodies: [String: [String: Any]] = [:]
        var clients: [String: String] = [:]
        var auth: [String] = []
        var beat = #"{"callId":"call9","kind":"video","active":true,"transcribing":false,"activeUserIds":["u1","u2"],"guests":[{"id":"g1","name":"Laura Invitada"},{"id":"g2","name":"Pedro"}],"names":{"u1":"Bruno","u2":"Ana","guest:g1":"Laura Invitada","guest:g2":"Pedro"}}"#
        var beatStatus = 200
        ControlledURLProtocol.handler = { req in Task { @MainActor in
            let p = req.request.url!.path
            paths.append(p); bodies[p] = req.json
            clients[p] = req.request.value(forHTTPHeaderField: "x-tiecoms-client")
            if let a = req.request.value(forHTTPHeaderField: "authorization") { auth.append(a) }
            switch p {
            case "/api/v1/call-links/tok_1234567890abcdef": req.respond(#"{"title":"Obra","hostName":"Bruno","orgName":"Xertify","kind":"video","active":true}"#)
            case "/api/v1/call-links/tok_1234567890abcdef/join": req.respond(guestJoinJSON)
            case "/api/v1/call-guests/g1/heartbeat": beatStatus == 200 ? req.respond(beat) : req.respond(beatStatus, #"{"error":{"code":"not_in_call","message":"Ya no estás en esa llamada"}}"#)
            case "/api/v1/call-guests/g1/leave": req.respond(#"{"ok":true}"#)
            default: req.respond(404, #"{"error":{"code":"not_found","message":"x"}}"#)
            }
        } }
        let preview = try await s.previewCallLink("tok_1234567890abcdef")
        XCTAssertEqual(preview.hostName, "Bruno")

        let center = s.callCenter
        try await center.joinAsGuest(token: "tok_1234567890abcdef", name: "Laura Invitada", camera: false, title: "Obra")
        XCTAssertEqual(bodies["/api/v1/call-links/tok_1234567890abcdef/join"]?["name"] as? String, "Laura Invitada")
        XCTAssertEqual(clients["/api/v1/call-links/tok_1234567890abcdef/join"], "ios")
        XCTAssertTrue(auth.isEmpty, "el API público no lleva sesión")
        XCTAssertTrue(center.media is NullCallMedia)
        XCTAssertEqual(center.guest?.userId, "guest:g1"); XCTAssertEqual(center.guest?.title, "Obra")
        XCTAssertEqual(center.view?.isGuest, true)
        try await waitUntil(2, "en vivo") { center.view?.phase == .live }
        XCTAssertNil(center.recorder, "los invitados no transcriben")

        // Latido: trae quién está (entró Ana y otro invitado).
        await center.guestBeat()
        XCTAssertEqual(bodies["/api/v1/call-guests/g1/heartbeat"]?["secret"] as? String, "s3cr3t-s3cr3t-s3cr3t-s3cr3t")
        XCTAssertEqual(center.view.map { CallRules.people($0.call) }, ["u1", "u2", "guest:g1", "guest:g2"])
        XCTAssertEqual(center.view?.call.names["u2"], "Ana")

        // Transcribiendo: los invitados siguen sin grabar su micrófono.
        beat = beat.replacingOccurrences(of: #""transcribing":false"#, with: #""transcribing":true"#)
        await center.guestBeat()
        XCTAssertEqual(center.view?.call.transcribing, true)
        XCTAssertNil(center.recorder)

        // Colgar: sale con el secreto y la pantalla dice «Saliste».
        await center.hangUp()
        XCTAssertNil(center.view); XCTAssertNil(center.guest)
        XCTAssertEqual(center.guestOutcome, .left)
        XCTAssertEqual(bodies["/api/v1/call-guests/g1/leave"]?["secret"] as? String, "s3cr3t-s3cr3t-s3cr3t-s3cr3t")
        XCTAssertFalse(paths.contains { $0.hasPrefix("/api/v1/calls/") }, "nada del API con sesión")

        // Otra vez dentro; el latido responde 409: la llamada terminó.
        try await center.joinAsGuest(token: "tok_1234567890abcdef", name: "Laura Invitada", camera: false, title: "Obra")
        XCTAssertNil(center.guestOutcome)
        beatStatus = 409
        await center.guestBeat()
        XCTAssertNil(center.view)
        XCTAssertEqual(center.guestOutcome, .ended)

        // Y si el latido dice active=false, también.
        beatStatus = 200
        try await center.joinAsGuest(token: "tok_1234567890abcdef", name: "Laura Invitada", camera: false, title: "Obra")
        beat = beat.replacingOccurrences(of: #""active":true"#, with: #""active":false"#)
        await center.guestBeat()
        XCTAssertNil(center.view)
        XCTAssertEqual(center.guestOutcome, .ended)
    }

    func testGuestCallSurvivesAccountResetAndJoinErrors() async throws {
        let s = try ControlledURLProtocol.store()
        ControlledURLProtocol.handler = { req in Task { @MainActor in
            switch req.request.url!.path {
            case "/api/v1/call-links/full_1234567890abcdef/join": req.respond(409, #"{"error":{"code":"call_full","message":"La llamada ya tiene el máximo de invitados"}}"#)
            case "/api/v1/call-links/gone_1234567890abcdef": req.respond(404, #"{"error":{"code":"not_found","message":"Enlace no encontrado"}}"#)
            case "/api/v1/call-links/tok_1234567890abcdef/join": req.respond(guestJoinJSON)
            default: req.respond(#"{"ok":true}"#)
            }
        } }
        do { _ = try await s.previewCallLink("gone_1234567890abcdef"); XCTFail("debió fallar") }
        catch let e as ApiRequestError { XCTAssertEqual(e.status, 404) }
        do { try await s.callCenter.joinAsGuest(token: "full_1234567890abcdef", name: "Laura", camera: false, title: "x"); XCTFail("debió fallar") }
        catch let e as ApiRequestError { XCTAssertEqual(e.code, "call_full") }
        XCTAssertNil(s.callCenter.view)

        try await s.callCenter.joinAsGuest(token: "tok_1234567890abcdef", name: "Laura", camera: false, title: "x")
        s.callCenter.reset()
        XCTAssertNotNil(s.callCenter.view, "cerrar sesión no corta la llamada de invitado")
        await s.callCenter.hangUp()
    }

    // MARK: Pantallas compartidas

    func testContentTilesGoToScreens() async throws {
        let s = try ControlledURLProtocol.store()
        ControlledURLProtocol.handler = { req in Task { @MainActor in req.respond(req.request.url!.path.hasSuffix("/join") ? guestJoinJSON : #"{"ok":true}"#) } }
        let center = s.callCenter
        try await center.joinAsGuest(token: "tok_1234567890abcdef", name: "Laura", camera: false, title: "x")
        center.mediaTileAdded(CallTile(tileId: 7, local: false, userId: "u1", active: true))
        center.mediaTileAdded(CallTile(tileId: 8, local: false, userId: "u1", active: true, content: true))
        XCTAssertEqual(center.view?.tiles.map(\.tileId), [7])
        XCTAssertEqual(center.view?.screens.map(\.tileId), [8])
        center.mediaTileAdded(CallTile(tileId: 8, local: false, userId: "u1", active: false, content: true))
        XCTAssertEqual(center.view?.screens.map(\.active), [false], "en pausa: se reemplaza, no se duplica")
        center.mediaTileRemoved(8)
        XCTAssertEqual(center.view?.screens, [])
        XCTAssertEqual(center.view?.tiles.map(\.tileId), [7])

        // Una vista solo suelta el recuadro si es la que lo tiene (al ampliar y volver hay dos por un momento).
        let a = UIView(), b = UIView()
        center.bind(a, tileId: 8)
        center.bind(b, tileId: 8)
        center.unbind(a, tileId: 8)
        XCTAssertTrue(center.isBound(b, tileId: 8), "la vista vieja no suelta a la nueva")
        center.unbind(b, tileId: 8)
        XCTAssertFalse(center.isBound(b, tileId: 8))
        await center.hangUp()
    }
}
