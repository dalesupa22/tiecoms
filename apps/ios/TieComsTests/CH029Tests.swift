import CallKit
import XCTest
@testable import TieComs

/// CH029: llamadas que timbran como WhatsApp. Push VoIP (PushKit) → pantalla de llamada del sistema (CallKit), cuándo
/// deja de sonar, y «Llamando…» / «Sonando…» para quien llama.
@MainActor
final class CH029Tests: XCTestCase {
    private func call(_ json: String) throws -> CallDTO {
        try JSONDecoder().decode(CallDTO.self, from: Data(json.utf8))
    }

    // MARK: Push VoIP

    func testVoipPayloadOfACall() {
        let id = "5e8e5a23-9a5d-4fe2-b44f-fc941597bd2d"
        let p = VoipCallPush(["type": "call", "callId": id, "conversationId": "c1", "kind": "video", "callerName": " Danny ", "subtitle": NSNull()])
        XCTAssertEqual(p?.callId, id)
        XCTAssertEqual(p?.conversationId, "c1")
        XCTAssertEqual(p?.video, true)
        XCTAssertEqual(p?.displayName, "Danny")
        XCTAssertNil(p?.subtitle)
    }

    func testVoipPayloadInAGroupShowsTheGroup() {
        let p = VoipCallPush(["type": "call", "callId": "x", "conversationId": "g", "kind": "audio", "callerName": "Danny", "subtitle": "Ventas"])
        XCTAssertEqual(p?.displayName, "Danny · Ventas")
        XCTAssertEqual(p?.video, false)
    }

    func testVoipPayloadThatIsNotACall() {
        XCTAssertNil(VoipCallPush(["type": "message", "callId": "x"]))
        XCTAssertNil(VoipCallPush(["type": "call"]))
        XCTAssertNil(VoipCallPush([:]))
        // Sin nombre, el sistema muestra «chaggu».
        XCTAssertEqual(VoipCallPush(["type": "call", "callId": "x"])?.displayName, "chaggu")
    }

    func testRingtoneOfAPushCallIsTheAppRingtone() {
        XCTAssertEqual(CallKitRules.pushRingtone("ring_marimba"), "ring_marimba.caf")
        XCTAssertEqual(CallKitRules.pushRingtone(nil), "\(ChatSounds.ringFile(nil)).caf")
        XCTAssertNotNil(Bundle.main.url(forResource: "ring_marimba", withExtension: "caf"), "el tono está en la app (CallKit lo busca ahí)")
    }

    // MARK: Cuándo deja de sonar en el sistema

    func testIncomingStopsWhenTheCallIsOverOrAnsweredElsewhere() throws {
        let live = try call(#"{"id":"k","conversationId":"c","startedBy":"ana","activeUserIds":["ana"]}"#)
        XCTAssertNil(CallRules.incomingEnd(live, callId: "k", me: "me"), "sigue sonando")
        XCTAssertEqual(CallRules.incomingEnd(nil, callId: "k", me: "me"), .remoteEnded, "ya no hay llamada")
        let other = try call(#"{"id":"otra","conversationId":"c","activeUserIds":["ana"]}"#)
        XCTAssertEqual(CallRules.incomingEnd(other, callId: "k", me: "me"), .remoteEnded, "colgó y empezó otra")
        let ended = try call(#"{"id":"k","conversationId":"c","endedAt":"2026-11-02T15:00:00Z","activeUserIds":[]}"#)
        XCTAssertEqual(CallRules.incomingEnd(ended, callId: "k", me: "me"), .remoteEnded)
        let mine = try call(#"{"id":"k","conversationId":"c","activeUserIds":["ana","me"]}"#)
        XCTAssertEqual(CallRules.incomingEnd(mine, callId: "k", me: "me"), .answeredElsewhere, "contesté en otro dispositivo")
        let ringingMe = try call(#"{"id":"k","conversationId":"c","activeUserIds":["ana"],"ringingUserIds":["me"]}"#)
        XCTAssertNil(CallRules.incomingEnd(ringingMe, callId: "k", me: "me", acked: true), "sigue sonando")
        XCTAssertEqual(CallRules.incomingEnd(live, callId: "k", me: "me", acked: true), .declinedElsewhere, "rechacé en otro dispositivo")
        XCTAssertNil(CallRules.incomingEnd(live, callId: "k", me: "me", acked: false), "sin confirmar no se concluye nada")
    }

    // MARK: Llamando… / Sonando…

    func testCallerSeesCallingThenRinging() throws {
        let calling = try call(#"{"id":"k","conversationId":"c","startedBy":"me","activeUserIds":["me"]}"#)
        XCTAssertEqual(CallRules.waitingKey(calling, me: "me"), "call.calling")
        let ringing = try call(#"{"id":"k","conversationId":"c","startedBy":"me","activeUserIds":["me"],"ringingUserIds":["alicia"]}"#)
        XCTAssertEqual(ringing.ringingUserIds, ["alicia"])
        XCTAssertEqual(CallRules.waitingKey(ringing, me: "me"), "call.ringingOut")
        // Entré a una que quedó sola (no la empecé): como antes.
        let alone = try call(#"{"id":"k","conversationId":"c","startedBy":"ana","activeUserIds":["me"]}"#)
        XCTAssertEqual(CallRules.waitingKey(alone, me: "me"), "call.waiting")
        XCTAssertEqual(L("call.calling") != "call.calling", true)
        XCTAssertEqual(L("call.ringingOut") != "call.ringingOut", true)
    }

    // MARK: Token VoIP

    func testVoipTokenIsSentAgainAfterTheSessionTokensWereDeleted() async {
        var sent: [PushTokenSync.Operation] = []
        let alerts = PushTokenSync { _ in }
        let voip = PushTokenSync { sent.append($0) }
        alerts.afterUnregister = { voip.resendToken() }
        alerts.startSession(); voip.startSession()
        voip.receive("VOIP"); voip.setEnabled(true)
        await voip.synchronize()
        XCTAssertEqual(sent, [.register("VOIP")])
        // El DELETE de avisos (p. ej. al arrancar la sesión) borra también el VoIP en el servidor: se vuelve a mandar.
        await alerts.synchronize()
        await voip.synchronize()
        XCTAssertEqual(sent, [.register("VOIP"), .register("VOIP")])
    }
}
