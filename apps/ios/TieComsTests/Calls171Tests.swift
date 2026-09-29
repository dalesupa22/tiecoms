import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }
private let callJSON = #"{"id":"call1","conversationId":"c1","kind":"audio","startedBy":"b","startedAt":"2026-09-29T10:00:00.000Z","endedAt":null,"activeUserIds":["b","a"],"transcribing":false,"hasTranscript":false,"myDevices":[{"deviceKey":"pc123456","platform":"web","label":"Navegador"}]}"#
private let joinJSON = #"""
{"call":{"id":"call1","conversationId":"c1","kind":"audio","activeUserIds":["b","a"]},
 "meeting":{"Meeting":{"MeetingId":"fake-call1","MediaRegion":"us-east-1","MediaPlacement":{"AudioHostUrl":"fake.invalid:3478","SignalingUrl":"wss://fake.invalid/control","TurnControlUrl":"https://fake.invalid/turn"}}},
 "attendee":{"Attendee":{"AttendeeId":"att-1","ExternalUserId":"a#abcd1234","JoinToken":"tok"}}}
"""#

/// 1.7.1 (docs/LLAMADAS.md › Varios dispositivos, altavoz y llamadas en curso).
@MainActor
final class Calls171Tests: XCTestCase {
    private func store() throws -> AppStore {
        let s = try ControlledURLProtocol.store()
        s.seedForTesting(try dec(BootstrapDTO.self, #"{"me":{"id":"a","name":"Ana"},"features":{"calls":true},"conversations":[{"id":"c1","kind":"direct","memberIds":["a","b"],"canPost":true}]}"#))
        return s
    }

    func testPersonIdAndDecoding() throws {
        XCTAssertEqual(CallRules.personId("u1#abcd1234"), "u1")
        XCTAssertEqual(CallRules.personId("u1"), "u1", "clientes 1.7.0: sin «#»")
        let c = try dec(CallDTO.self, callJSON)
        XCTAssertEqual(c.myDevices.first?.label, "Navegador")
        let b = try dec(BootstrapDTO.self, #"{"me":{"id":"a","name":"A"},"myActiveCall":\#(callJSON)}"#)
        XCTAssertEqual(b.myActiveCall?.id, "call1")
        XCTAssertNil(try dec(BootstrapDTO.self, #"{"me":{"id":"a","name":"A"},"myActiveCall":null}"#).myActiveCall)
        let page = try dec(ActiveCallsPage.self, #"{"calls":[{"call":\#(callJSON),"title":"Obra"}]}"#)
        XCTAssertEqual(page.calls.first?.title, "Obra")
        guard case .callAnswered(let id, let key, _, let label) = try dec(AccountEvent.self, #"{"type":"call.answered","callId":"call1","conversationId":"c1","deviceKey":"ph1","platform":"ios","label":"iPhone"}"#) else { return XCTFail() }
        XCTAssertEqual([id, key, label], ["call1", "ph1", "iPhone"])
        guard case .callDeclined(let d) = try dec(AccountEvent.self, #"{"type":"call.declined","callId":"call1","conversationId":"c1"}"#) else { return XCTFail() }
        XCTAssertEqual(d, "call1")
        XCTAssertNotNil(CallRules.deviceKey.range(of: #"^[A-Za-z0-9_-]{1,16}$"#, options: .regularExpression), "contrato CallDeviceKey")
        XCTAssertEqual(Contract.version, "2026-09-29.1")
    }

    func testOutputsInviteStateAndOtherDevice() throws {
        let rec = CallAudioDevice(id: "r", label: "iPhone", kind: .receiver), spk = CallAudioDevice(id: "s", label: "Altavoz", kind: .speaker)
        let bt = CallAudioDevice(id: "b", label: "AirPods", kind: .bluetooth)
        XCTAssertEqual(CallRules.defaultOutput([rec, spk], video: false), "r", "voz: auricular")
        XCTAssertEqual(CallRules.defaultOutput([rec, spk], video: true), "s", "video: altavoz")
        XCTAssertEqual(CallRules.defaultOutput([rec, spk, bt], video: true), "b", "Bluetooth manda")
        let t0 = Date()
        XCTAssertEqual(CallRules.inviteState(since: t0, now: t0.addingTimeInterval(10)), .ringing)
        XCTAssertEqual(CallRules.inviteState(since: t0, now: t0.addingTimeInterval(46)), .noAnswer)
        let c = try dec(CallDTO.self, callJSON)
        XCTAssertEqual(CallRules.onOtherDevice(c, inCallHere: nil, myKey: "ph999999")?.label, "Navegador")
        XCTAssertNil(CallRules.onOtherDevice(c, inCallHere: "call1", myKey: "ph999999"), "ya estoy aquí")
        XCTAssertNil(CallRules.onOtherDevice(c, inCallHere: nil, myKey: "pc123456"), "ese dispositivo soy yo")
    }

    func testAnsweredElsewhereStopsRingingAndDeclineCallsApi() throws {
        let s = try store()
        var paths: [String] = []
        ControlledURLProtocol.handler = { req in Task { @MainActor in paths.append(req.request.url!.path); req.respond(#"{"ok":true}"#) } }
        s.socketEventForTesting("account.event", #"{"type":"call.ringing","call":\#(callJSON),"callerName":"Bruno"}"#)
        XCTAssertNotNil(s.callCenter.ringing)
        s.socketEventForTesting("account.event", #"{"type":"call.answered","callId":"call1","conversationId":"c1","deviceKey":"\#(CallRules.deviceKey)","platform":"ios","label":"iPhone"}"#)
        XCTAssertNotNil(s.callCenter.ringing, "contesté aquí mismo: no se toca")
        s.socketEventForTesting("account.event", #"{"type":"call.answered","callId":"call1","conversationId":"c1","deviceKey":"otro1234","platform":"web","label":"Navegador"}"#)
        XCTAssertNil(s.callCenter.ringing, "contesté en otro dispositivo: deja de sonar")
        s.socketEventForTesting("account.event", #"{"type":"call.ringing","call":\#(callJSON),"callerName":"Bruno"}"#)
        s.socketEventForTesting("account.event", #"{"type":"call.declined","callId":"call1","conversationId":"c1"}"#)
        XCTAssertNil(s.callCenter.ringing)
        s.socketEventForTesting("account.event", #"{"type":"call.ringing","call":\#(callJSON),"callerName":"Bruno"}"#)
        s.callCenter.decline()
        XCTAssertNil(s.callCenter.ringing)
        let exp = expectation(description: "decline")
        Task { @MainActor in
            for _ in 0..<50 where !paths.contains("/api/v1/calls/call1/decline") { try? await Task.sleep(nanoseconds: 20_000_000) }
            exp.fulfill()
        }
        wait(for: [exp], timeout: 2)
        XCTAssertTrue(paths.contains("/api/v1/calls/call1/decline"), "«Ahora no» avisa a mis dispositivos")
    }

    func testKeepDevicesFromConversationEventAndHandOff() async throws {
        let s = try store()
        s.socketEventForTesting("account.event", #"{"type":"call.updated","call":\#(callJSON)}"#)
        XCTAssertEqual(s.liveCalls["c1"]?.myDevices.count, 1)
        s.socketEventForTesting("conv.event", #"{"type":"call.updated","conversationId":"c1","eventSeq":1,"call":{"id":"call1","conversationId":"c1","kind":"audio","activeUserIds":["b","a"]}}"#)
        XCTAssertEqual(s.liveCalls["c1"]?.myDevices.first?.deviceKey, "pc123456", "el evento de la conversación no trae myDevices: se conserva")
        var bodies: [String: [String: Any]] = [:]
        ControlledURLProtocol.handler = { req in Task { @MainActor in
            let p = req.request.url!.path; bodies[p] = req.json
            if p.hasSuffix("/join") { req.respond(joinJSON) } else { req.respond(#"{"call":{"id":"call1","conversationId":"c1","activeUserIds":["b","a"]}}"#) }
        } }
        s.callCenter.handOff(s.liveCalls["c1"]!, from: "pc123456")
        try await waitUntil(3, "en vivo") { s.callCenter.view?.phase == .live }
        try await waitUntil(3, "sale el otro") { bodies["/api/v1/calls/call1/leave"] != nil }
        XCTAssertEqual(bodies["/api/v1/calls/call1/join"]?["deviceKey"] as? String, CallRules.deviceKey)
        XCTAssertEqual(bodies["/api/v1/calls/call1/leave"]?["deviceKey"] as? String, "pc123456", "«Pasar aquí» saca solo al otro dispositivo")
        // Altavoz (medios falsos): voz empieza en el auricular y 🔊 alterna.
        XCTAssertEqual(s.callCenter.view?.audioOut, "receiver")
        s.callCenter.toggleSpeaker(); XCTAssertEqual(s.callCenter.view?.audioOut, "speaker")
        s.callCenter.toggleSpeaker(); XCTAssertEqual(s.callCenter.view?.audioOut, "receiver")
        // Cámara en plena llamada: aparece mi recuadro; al apagarla vuelve el avatar.
        await s.callCenter.toggleCamera()
        XCTAssertEqual(s.callCenter.view?.camera, true); XCTAssertEqual(s.callCenter.view?.tiles.filter(\.local).count, 1)
        await s.callCenter.toggleCamera()
        XCTAssertEqual(s.callCenter.view?.camera, false); XCTAssertTrue(s.callCenter.view?.tiles.isEmpty ?? false)
        // Silenciados por persona.
        s.callCenter.mediaRemoteMute(["b"], muted: true); XCTAssertEqual(s.callCenter.view?.mutedUsers, ["b"])
        s.callCenter.mediaRemoteMute(["b"], muted: false); XCTAssertEqual(s.callCenter.view?.mutedUsers, [])
        // Agregar: «Llamando…» hasta que entra.
        ControlledURLProtocol.handler = { req in Task { @MainActor in req.respond(#"{"call":{"id":"call1","conversationId":"c1","activeUserIds":["b","a"]}}"#) } }
        try await s.callCenter.invite(["g"])
        XCTAssertEqual(s.callCenter.inviteState("g"), .ringing)
        s.callCenter.reset()
    }
}
