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

/// 1.6.4 (21): «No molestar todas las noches» (modo sueño).
@MainActor
final class SleepModeTests: XCTestCase {
    private var savedLang: L10n.Choice = .system
    override func setUp() { savedLang = L10n.choice; L10n.choice = .es }
    override func tearDown() { L10n.choice = savedLang }

    private let night = SleepWindow(start: "22:00", end: "07:00", tz: "America/Bogota")

    func testSleepingNowAcrossMidnight() {
        XCTAssertTrue(SleepRules.sleepingNow(night, at: at("2026-09-28T04:30:00.000Z")), "23:30 en Bogotá")
        XCTAssertTrue(SleepRules.sleepingNow(night, at: at("2026-09-28T11:59:00.000Z")), "06:59")
        XCTAssertFalse(SleepRules.sleepingNow(night, at: at("2026-09-28T12:00:00.000Z")), "07:00 ya despertó")
        XCTAssertTrue(SleepRules.sleepingNow(night, at: at("2026-09-28T03:00:00.000Z")), "22:00 empieza")
        XCTAssertFalse(SleepRules.sleepingNow(night, at: at("2026-09-28T02:59:00.000Z")), "21:59")
        let siesta = SleepWindow(start: "13:00", end: "15:00", tz: "America/Bogota")
        XCTAssertTrue(SleepRules.sleepingNow(siesta, at: at("2026-09-28T19:00:00.000Z")), "ventana sin medianoche")
        XCTAssertFalse(SleepRules.sleepingNow(SleepWindow(start: "07:00", end: "07:00", tz: "UTC"), at: Date()), "inicio = fin: apagado")
        XCTAssertFalse(SleepRules.sleepingNow(nil), "people[].sleep null: lo tiene apagado")
        // En su zona, no en la mía: 23:30 en Madrid es 16:30 en Bogotá.
        let madrid = SleepWindow(start: "22:00", end: "07:00", tz: "Europe/Madrid")
        XCTAssertTrue(SleepRules.sleepingNow(madrid, at: at("2026-09-28T21:30:00.000Z")))
    }

    func testWakeAt() {
        // 23:30 del domingo en Bogotá → despierta el lunes a las 7:00 (12:00 UTC).
        XCTAssertEqual(SleepRules.wakeAt(night, at: at("2026-09-28T04:30:20.000Z")), at("2026-09-28T12:00:00.000Z"))
        // 06:59 → en un minuto.
        XCTAssertEqual(SleepRules.wakeAt(night, at: at("2026-09-28T11:59:00.000Z")), at("2026-09-28T12:00:00.000Z"))
        // Justo a las 7:00 → el día siguiente.
        XCTAssertEqual(SleepRules.wakeAt(night, at: at("2026-09-28T12:00:00.000Z")), at("2026-09-29T12:00:00.000Z"))
    }

    private func person(_ id: String, _ name: String, sleep: SleepWindow?) throws -> PersonDTO {
        let s = sleep.map { #","sleep":{"start":"\#($0.start)","end":"\#($0.end)","tz":"\#($0.tz)"}"# } ?? #","sleep":null"#
        return try dec(PersonDTO.self, #"{"id":"\#(id)","name":"\#(name)","kind":"human"\#(s)}"#)
    }

    func testNoticeInDirectAndGroups() throws {
        let t = at("2026-09-28T04:30:00.000Z") // 23:30 en Bogotá
        let me = try person("me", "Danny Suárez", sleep: nil)
        let ana = try person("ana", "Ana Márquez", sleep: night)
        let bob = try person("bob", "Bruno Ortega", sleep: nil)
        // Directo: siempre; el botón «Enviar a las 7:00» solo mientras escribo.
        let idle = try XCTUnwrap(SleepRules.notice(me: "me", members: [me, ana], typing: false, at: t))
        XCTAssertTrue(idle.text.hasPrefix("Ana está descansando: le llega sin sonar. Lo verá mañana a las 7:00"), idle.text)
        XCTAssertNil(idle.wake)
        let typing = try XCTUnwrap(SleepRules.notice(me: "me", members: [me, ana], typing: true, at: t))
        XCTAssertEqual(typing.wake, at("2026-09-28T12:00:00.000Z"))
        // Grupo: solo mientras escribo y sin botón.
        XCTAssertNil(SleepRules.notice(me: "me", members: [me, ana, bob], typing: false, at: t))
        let group = try XCTUnwrap(SleepRules.notice(me: "me", members: [me, ana, bob], typing: true, at: t))
        XCTAssertEqual(group.text, "1 persona(s) del chat están descansando: les llega sin sonar.")
        XCTAssertNil(group.wake)
        // De día, nada.
        XCTAssertNil(SleepRules.notice(me: "me", members: [me, ana], typing: true, at: at("2026-09-28T17:00:00.000Z")))
    }

    func testDecodingAndEvent() throws {
        let u = try dec(UserDTO.self, #"{"id":"me","name":"Ana","sleep":{"on":true,"start":"23:00","end":"06:30","tz":"Europe/Madrid","tzAuto":false}}"#)
        XCTAssertEqual(u.sleep, SleepDTO(on: true, start: "23:00", end: "06:30", tz: "Europe/Madrid", tzAuto: false))
        XCTAssertNil(try dec(UserDTO.self, #"{"id":"me","name":"Ana"}"#).sleep, "servidor anterior")
        XCTAssertNil(SleepDTO(on: false).window)
        let e = try dec(AccountEvent.self, #"{"type":"me.sleep","sleep":{"on":false,"start":"22:00","end":"07:00","tz":"America/Bogota","tzAuto":true}}"#)
        XCTAssertEqual(e, .sleepChanged(SleepDTO(on: false)))
    }

    func testTimeZoneFollowsDeviceWhileAuto() async throws {
        MockURLProtocol.routes = ["/api/v1/me/sleep": (200, #"{"sleep":{"on":true,"start":"22:00","end":"07:00","tz":"Europe/Madrid","tzAuto":true}}"#)]
        MockURLProtocol.requests = []
        let s = AppStore(baseURL: URL(string: "https://mock.chaggu.test")!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()),
                         feedback: nil, session: MockURLProtocol.session())
        let boot = #"{"contract":"x","serverTime":"","me":{"id":"me","name":"Ana","kind":"human","sleep":{"on":true,"start":"22:00","end":"07:00","tz":"America/Bogota","tzAuto":true}},"organizations":[],"workspaces":[],"conversations":[],"people":[]}"#
        s.seedForTesting(try dec(BootstrapDTO.self, boot))
        await s.syncSleepTimeZone(device: "Europe/Madrid")
        let put = try XCTUnwrap(MockURLProtocol.requests.last { $0.path == "/api/v1/me/sleep" })
        XCTAssertEqual(put.body["tz"] as? String, "Europe/Madrid")
        XCTAssertEqual(put.body["tzAuto"] as? Bool, true)
        XCTAssertEqual(s.data?.me.sleep?.tz, "Europe/Madrid")
        // Zona fijada a mano: no se toca.
        MockURLProtocol.requests = []
        s.seedForTesting(try dec(BootstrapDTO.self, boot.replacingOccurrences(of: #""tzAuto":true"#, with: #""tzAuto":false"#)))
        await s.syncSleepTimeZone(device: "Asia/Tokyo")
        XCTAssertTrue(MockURLProtocol.requests.isEmpty)
    }
}
