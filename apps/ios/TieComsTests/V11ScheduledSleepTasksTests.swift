import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }

private func bogota() -> Calendar {
    var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "America/Bogota")!; return c
}
private func at(_ iso: String) -> Date { ISODate.parse(iso)! }

/// 1.6.4 (21): mensajes programados (docs/PROGRAMADOS.md).
@MainActor
final class ScheduledTests: XCTestCase {
    private var savedLang: L10n.Choice = .system
    override func setUp() { savedLang = L10n.choice; L10n.choice = .es; MockURLProtocol.routes = [:]; MockURLProtocol.requests = [] }
    override func tearDown() { L10n.choice = savedLang }

    private func opts(_ iso: String) -> [String] {
        let cal = bogota()
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = cal.timeZone; f.dateFormat = "yyyy-MM-dd'T'HH:mm"
        return Schedule.options(now: at(iso), calendar: cal).map { "\($0.key.replacingOccurrences(of: "sched.", with: "")) \(f.string(from: $0.at))" }
    }

    func testOptionsOnMondayMorning() {
        // Lunes 28-sep 10:07 en Bogotá.
        XCTAssertEqual(opts("2026-09-28T15:07:00.000Z"), [
            "inHour 2026-09-28T11:10",       // +1 h redondeado a 5 min
            "thisAfternoon 2026-09-28T18:00", // antes de las 16:00
            "tomorrowMorning 2026-09-29T08:00",
            "monday 2026-10-05T08:00",        // el lunes que viene
        ])
    }

    func testOptionsOnSundayEvening() {
        // Domingo 27-sep 17:00: sin «Esta tarde» (ya son más de las 16:00) y sin «El lunes» (mañana es lunes).
        XCTAssertEqual(opts("2026-09-27T22:00:00.000Z"), ["inHour 2026-09-27T18:00", "tomorrowMorning 2026-09-28T08:00"])
    }

    func testInHourKeepsExactFiveMinuteMarks() {
        XCTAssertEqual(opts("2026-09-30T15:00:00.000Z").first, "inHour 2026-09-30T11:00")
        XCTAssertEqual(opts("2026-09-30T15:00:01.000Z").first, "inHour 2026-09-30T11:05")
    }

    func testWhenLabels() {
        let cal = bogota(), now = at("2026-09-28T15:00:00.000Z")
        XCTAssertTrue(Schedule.whenLabel(at("2026-09-28T23:00:00.000Z"), now: now, calendar: cal).hasPrefix("hoy a las 6:00"))
        XCTAssertTrue(Schedule.whenLabel(at("2026-09-29T13:00:00.000Z"), now: now, calendar: cal).hasPrefix("mañana a las 8:00"))
        let later = Schedule.whenLabel(at("2026-10-05T13:00:00.000Z"), now: now, calendar: cal)
        XCTAssertTrue(later.hasPrefix("el lun"), later)
        XCTAssertTrue(later.contains("a las 8:00"), later)
        XCTAssertTrue(Schedule.isValidPick(now.addingTimeInterval(120), now: now))
        XCTAssertFalse(Schedule.isValidPick(now.addingTimeInterval(30), now: now), "en el futuro (más de 1 min)")
    }

    private func sched(_ id: String, conv: String = "c1", status: String = "pending", at: String = "2026-09-29T13:00:00.000Z") -> String {
        #"{"id":"\#(id)","conversationId":"\#(conv)","body":"Hola","mentions":[],"replyTo":null,"sendAt":"\#(at)","status":"\#(status)","messageId":null,"error":null,"createdAt":"2026-09-28T10:00:00.000Z","sentAt":null}"#
    }

    func testListKeepsPendingSendingAndFailedSorted() throws {
        let s = AppStore(baseURL: URL(string: "https://mock.chaggu.test")!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: nil)
        s.putScheduled(try dec(ScheduledMessageDTO.self, sched("b", at: "2026-09-30T13:00:00.000Z")))
        s.putScheduled(try dec(ScheduledMessageDTO.self, sched("a")))
        s.putScheduled(try dec(ScheduledMessageDTO.self, sched("f", status: "failed", at: "2026-09-28T13:00:00.000Z")))
        XCTAssertEqual(s.scheduled.map(\.id), ["f", "a", "b"], "por hora de salida")
        s.putScheduled(try dec(ScheduledMessageDTO.self, sched("a", status: "sent")))
        s.putScheduled(try dec(ScheduledMessageDTO.self, sched("b", status: "cancelled")))
        XCTAssertEqual(s.scheduled.map(\.id), ["f"], "enviado o cancelado sale de la lista")
        XCTAssertTrue(Schedule.stripText(s.scheduled).hasPrefix("⚠ 1 programado(s) no se pudieron enviar"))
        s.putScheduled(try dec(ScheduledMessageDTO.self, sched("f", status: "pending")))
        XCTAssertTrue(Schedule.stripText(s.scheduled).hasPrefix("🕒 1 mensaje programado · el próximo sale "))
        // El evento de cuenta llega igual que la respuesta del API.
        let e = try dec(AccountEvent.self, #"{"type":"scheduled.updated","scheduled":\#(sched("z"))}"#)
        guard case .scheduledUpdated(let x) = e else { return XCTFail("\(e)") }
        XCTAssertEqual(x.id, "z")
    }

    func testScheduleFromComposerPostsAndUndoCancels() async throws {
        MockURLProtocol.routes = ["/api/v1/conversations/c1/scheduled": (200, sched("s1")), "/api/v1/scheduled/s1": (200, sched("s1", status: "cancelled"))]
        let s = AppStore(baseURL: URL(string: "https://mock.chaggu.test")!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()),
                         feedback: nil, session: MockURLProtocol.session())
        var restored: String?
        let ok = await s.scheduleFromComposer("c1", body: "Hola @Ana", at: at("2026-09-29T13:00:00.000Z"),
                                              mentions: [Mention(userId: "u1", start: 5, length: 4)], replyTo: "m9") { text, _ in restored = text }
        XCTAssertTrue(ok)
        let post = try XCTUnwrap(MockURLProtocol.requests.last { $0.path == "/api/v1/conversations/c1/scheduled" })
        XCTAssertEqual(post.body["body"] as? String, "Hola @Ana")
        XCTAssertEqual(post.body["replyTo"] as? String, "m9")
        XCTAssertEqual((post.body["mentions"] as? [[String: Any]])?.first?["userId"] as? String, "u1")
        XCTAssertEqual(s.scheduled.map(\.id), ["s1"])
        XCTAssertTrue(s.toast?.hasPrefix("🕒 Programado para mañana") == true || s.toast?.hasPrefix("🕒 Programado para") == true, s.toast ?? "")
        s.toastUndo?()
        try await waitUntil(3, "deshacer") { restored == "Hola @Ana" }
        XCTAssertTrue(s.scheduled.isEmpty, "Deshacer cancela el programado")
    }
}
