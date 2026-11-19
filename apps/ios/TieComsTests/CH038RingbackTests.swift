import AVFoundation
import XCTest
@testable import TieComs

/// CH038: quien llama oye el tono de «llamando» (425 Hz, 1 s sí / 4 s no) mientras está sola, hasta 45 s.
@MainActor
final class CH038RingbackTests: XCTestCase {
    private func call(startedBy: String = "a", active: [String] = ["a"], guests: [CallGuestDTO] = [], ended: Bool = false) -> CallDTO {
        var c = CallDTO(id: "call1", conversationId: "c1", startedBy: startedBy, startedAt: "2026-11-19T10:00:00.000Z",
                        endedAt: ended ? "2026-11-19T10:01:00.000Z" : nil, activeUserIds: active)
        c.guests = guests
        return c
    }

    // MARK: Regla

    func testRingsForTheCallerWhileAlone() {
        XCTAssertTrue(CallRules.shouldRingback(call: call(), me: "a", isGuest: false, elapsed: 0))
        XCTAssertTrue(CallRules.shouldRingback(call: call(), me: "a", isGuest: false, elapsed: 44.9))
        XCTAssertTrue(CallRules.shouldRingback(call: call(active: []), me: "a", isGuest: false, elapsed: 3), "aún no aparezco dentro")
        var ringing = call(); ringing.ringingUserIds = ["b"]
        XCTAssertTrue(CallRules.shouldRingback(call: ringing, me: "a", isGuest: false, elapsed: 3), "«Sonando…»: sigue el tono")
        XCTAssertTrue(CallRules.shouldRingback(call: call(active: ["a", "a"]), me: "a", isGuest: false, elapsed: 3), "yo desde dos dispositivos")
        var muted = call(); muted.transcribing = true
        XCTAssertTrue(CallRules.shouldRingback(call: muted, me: "a", isGuest: false, elapsed: 3))
    }

    func testSilentWhenSomeoneElseIsInside() {
        XCTAssertFalse(CallRules.shouldRingback(call: call(active: ["a", "b"]), me: "a", isGuest: false, elapsed: 2))
        XCTAssertFalse(CallRules.shouldRingback(call: call(active: ["b"]), me: "a", isGuest: false, elapsed: 2))
        XCTAssertFalse(CallRules.shouldRingback(call: call(guests: [CallGuestDTO(id: "g1", name: "Invitada")]), me: "a", isGuest: false, elapsed: 2),
                       "un invitado por enlace también contesta")
    }

    func testSilentForTheCalleeGuestsEndedAndAfterTheNoAnswerWindow() {
        XCTAssertFalse(CallRules.shouldRingback(call: call(startedBy: "b"), me: "a", isGuest: false, elapsed: 2), "no la empecé yo")
        XCTAssertFalse(CallRules.shouldRingback(call: call(), me: "a", isGuest: true, elapsed: 2), "invitado por enlace")
        XCTAssertFalse(CallRules.shouldRingback(call: call(), me: "", isGuest: false, elapsed: 2), "sin sesión")
        XCTAssertFalse(CallRules.shouldRingback(call: call(ended: true), me: "a", isGuest: false, elapsed: 2), "terminó")
        XCTAssertFalse(CallRules.shouldRingback(call: call(), me: "a", isGuest: false, elapsed: TimeInterval(CallRules.ringSeconds)), "45 s: No contestó")
        XCTAssertFalse(CallRules.shouldRingback(call: call(), me: "a", isGuest: false, elapsed: 600))
        XCTAssertFalse(CallRules.shouldRingback(call: call(), me: "a", isGuest: false, elapsed: -1))
    }

    // MARK: WAV

    private func u32(_ d: Data, _ at: Int) -> Int { Int(d[at]) | Int(d[at + 1]) << 8 | Int(d[at + 2]) << 16 | Int(d[at + 3]) << 24 }
    private func u16(_ d: Data, _ at: Int) -> Int { Int(d[at]) | Int(d[at + 1]) << 8 }
    private func sample(_ d: Data, _ i: Int) -> Int { Int(Int16(bitPattern: UInt16(u16(d, 44 + 2 * i)))) }

    func testWavHeaderSizeAndDuration() {
        let d = CallRules.ringbackWAV()
        let rate = CallRules.ringbackSampleRate
        XCTAssertEqual(d.count, 44 + 5 * rate * 2, "5 s, 16 bits, mono")
        XCTAssertEqual(String(decoding: d[0..<4], as: UTF8.self), "RIFF")
        XCTAssertEqual(u32(d, 4), d.count - 8)
        XCTAssertEqual(String(decoding: d[8..<12], as: UTF8.self), "WAVE")
        XCTAssertEqual(String(decoding: d[12..<16], as: UTF8.self), "fmt ")
        XCTAssertEqual(u32(d, 16), 16)
        XCTAssertEqual(u16(d, 20), 1, "PCM")
        XCTAssertEqual(u16(d, 22), 1, "mono")
        XCTAssertEqual(u32(d, 24), rate)
        XCTAssertEqual(u32(d, 28), rate * 2)
        XCTAssertEqual(u16(d, 32), 2)
        XCTAssertEqual(u16(d, 34), 16)
        XCTAssertEqual(String(decoding: d[36..<40], as: UTF8.self), "data")
        XCTAssertEqual(u32(d, 40), d.count - 44)
        XCTAssertEqual(Double(u32(d, 40)) / Double(rate * 2), CallRules.ringbackCycleSeconds, accuracy: 0.0001)
    }

    func testWavIsOneSecondOfToneThenSilence() {
        let d = CallRules.ringbackWAV()
        let rate = CallRules.ringbackSampleRate
        XCTAssertEqual(sample(d, 0), 0, "empieza con rampa")
        let tone = (rate / 10..<(rate * 9 / 10)).map { abs(sample(d, $0)) }
        let peak = tone.max() ?? 0
        XCTAssertGreaterThan(peak, 24_000); XCTAssertLessThanOrEqual(peak, 32_767)
        // 425 Hz: 85 ciclos en 0,2 s = 170 cruces por cero.
        let w = (rate / 2..<(rate / 2 + rate / 5)).map { sample(d, $0) }
        let crossings = zip(w, w.dropFirst()).filter { ($0 < 0) != ($1 < 0) }.count
        XCTAssertEqual(Double(crossings), 170, accuracy: 2)
        XCTAssertTrue((rate + 1..<(5 * rate)).allSatisfy { sample(d, $0) == 0 }, "4 s de silencio")
        XCTAssertLessThan(abs(sample(d, rate - 1)), 500, "termina con rampa")
    }

    func testAVAudioPlayerReadsTheWav() throws {
        let p = try AVAudioPlayer(data: CallRules.ringbackWAV(), fileTypeHint: AVFileType.wav.rawValue)
        XCTAssertEqual(p.duration, CallRules.ringbackCycleSeconds, accuracy: 0.01)
        XCTAssertEqual(p.numberOfChannels, 1)
    }

    // MARK: Flujo con el API (URLProtocol) y medios falsos

    private func joinJSON(startedBy: String, active: [String]) -> String {
        let now = ISO8601DateFormatter().string(from: Date())
        let ids = active.map { "\"\($0)\"" }.joined(separator: ",")
        return #"""
        {"call":{"id":"call1","conversationId":"c1","kind":"audio","startedBy":"\#(startedBy)","startedAt":"\#(now)","endedAt":null,"activeUserIds":[\#(ids)],"transcribing":false,"hasTranscript":false},
         "meeting":{"Meeting":{"MeetingId":"fake-call1","ExternalMeetingId":"call1","MediaRegion":"us-east-1",
           "MediaPlacement":{"AudioHostUrl":"fake.invalid:3478","SignalingUrl":"wss://fake.invalid/control","TurnControlUrl":"https://fake.invalid/turn"}}},
         "attendee":{"Attendee":{"AttendeeId":"att-1","ExternalUserId":"a","JoinToken":"tok-1"}}}
        """#
    }

    /// La central guarda la tienda débil: la prueba la retiene mientras dura.
    private var stores: [AppStore] = []

    private func connected(startedBy: String, active: [String]) async throws -> CallCenter {
        let s = try ControlledURLProtocol.store(user: "a")
        stores.append(s)
        let join = joinJSON(startedBy: startedBy, active: active)
        ControlledURLProtocol.handler = { req in Task { @MainActor in
            switch req.request.url!.path {
            case "/api/v1/conversations/c1/call", "/api/v1/calls/call1/join": req.respond(join)
            case "/api/v1/calls/call1/leave": req.respond(#"{"call":null}"#)
            default: req.respond(404, #"{"error":{"code":"not_found","message":"x"}}"#)
            }
        } }
        let center = s.callCenter
        center.fakeCaptions = false
        try await center.start("c1", kind: "audio")
        try await waitUntil(2, "en vivo") { center.view?.phase == .live }
        return center
    }

    func testCallerHearsItUntilSomeoneJoinsAndNotAgainWhenAloneAgain() async throws {
        let center = try await connected(startedBy: "a", active: ["a"])
        XCTAssertTrue(center.ringbackOn, "sola y la empecé yo")
        center.toggleMute()
        XCTAssertTrue(center.ringbackOn, "silenciarme no lo apaga")
        var c = try XCTUnwrap(center.view?.call)
        c.activeUserIds = ["a", "b"]
        center.callChanged(c)
        XCTAssertFalse(center.ringbackOn, "contestaron")
        c.activeUserIds = ["a"]
        center.callChanged(c)
        XCTAssertFalse(center.ringbackOn, "quedé sola otra vez: ya no es «llamando»")
        await center.hangUp()
        XCTAssertFalse(center.ringbackOn)
    }

    func testStopsWhenAGuestJoinsAndWhenIHangUp() async throws {
        let center = try await connected(startedBy: "a", active: ["a"])
        var c = try XCTUnwrap(center.view?.call)
        c.guests = [CallGuestDTO(id: "g1", name: "Invitada")]
        center.callChanged(c)
        XCTAssertFalse(center.ringbackOn)
        await center.hangUp()

        let again = try await connected(startedBy: "a", active: ["a"])
        XCTAssertTrue(again.ringbackOn)
        await again.hangUp()
        XCTAssertFalse(again.ringbackOn, "colgué")
    }

    func testCalleeAndJoiningARunningCallDoNotHearIt() async throws {
        let callee = try await connected(startedBy: "b", active: ["a", "b"])
        XCTAssertFalse(callee.ringbackOn)
        await callee.hangUp()
        let late = try await connected(startedBy: "a", active: ["a", "b"])
        XCTAssertFalse(late.ringbackOn, "ya había alguien dentro")
        await late.hangUp()
    }
}
