import XCTest
@testable import TieComs

/// Tarjeta del evento en el chat: qué mensajes la muestran, color del grupo (igual que la web), día completo y respuesta.
final class EventCardTests: XCTestCase {
    private func sys(_ body: String, kind: String = "system") -> MessageDTO {
        MessageDTO(id: UUID().uuidString, conversationId: "c1", seq: 1, authorId: "u1", clientMessageId: nil, kind: kind, body: body, createdAt: "")
    }
    private func ev(_ start: String, _ end: String, invitees: String = "[]", cancelled: String = "null") throws -> CalendarEventDTO {
        try JSONDecoder().decode(CalendarEventDTO.self, from: Data(#"{"id":"e1","conversationId":"c1","title":"Revisión","startsAt":"\#(start)","endsAt":"\#(end)","timezone":"America/Bogota","organizerId":"u1","invitees":\#(invitees),"cancelledAt":\#(cancelled),"updatedAt":""}"#.utf8))
    }

    func testOnlyEventCreatedWithId() {
        XCTAssertEqual(EventCardRule.eventId(sys(#"{"k":"event.created","eventId":"e1","title":"Revisión"}"#)), "e1")
        XCTAssertNil(EventCardRule.eventId(sys(#"{"k":"event.cancelled","eventId":"e1"}"#)), "otros avisos de evento siguen como línea")
        XCTAssertNil(EventCardRule.eventId(sys(#"{"k":"event.created"}"#)))
        XCTAssertNil(EventCardRule.eventId(sys(#"{"k":"event.created","eventId":"e1"}"#, kind: "text")), "solo mensajes de sistema")
        XCTAssertNil(EventCardRule.eventId(sys("Agendó una reunión")))
    }

    func testGroupColorMatchesWebHash() {
        // Mismos índices que groupColorIndex de packages/client-core (node): UTF-16, h*31 en uint32, % 10.
        XCTAssertEqual(GroupColor.index("a402fbbd-c080-4d5d-84ce-e6fff4e0dab3"), 9)
        XCTAssertEqual(GroupColor.index("c1"), 8)
        XCTAssertEqual(GroupColor.index("ñandú-😀"), 8)
        XCTAssertEqual(GroupColor.palette.count, 10)
    }

    func testAllDayGoingAndAnswer() throws {
        let tz = TimeZone(identifier: "America/Bogota")!
        var cal = Calendar(identifier: .gregorian); cal.timeZone = tz
        let allDay = try ev("2026-09-30T05:00:00.000Z", "2026-10-01T04:59:00.000Z")
        XCTAssertTrue(EventCardRule.isAllDay(allDay, calendar: cal))
        let meeting = try ev("2026-09-30T20:00:00.000Z", "2026-09-30T21:00:00.000Z",
                             invitees: #"[{"userId":"u1","rsvp":"yes"},{"userId":"u2","rsvp":"maybe"},{"userId":"u3","rsvp":"yes"},{"userId":"u4"}]"#)
        XCTAssertFalse(EventCardRule.isAllDay(meeting, calendar: cal))
        XCTAssertEqual(EventCardRule.going(meeting), 2)
        let before = ISODate.parse("2026-09-30T10:00:00Z")!, after = ISODate.parse("2026-10-01T10:00:00Z")!
        XCTAssertTrue(EventCardRule.canAnswer(meeting, me: "u2", now: before))
        XCTAssertFalse(EventCardRule.canAnswer(meeting, me: "u9", now: before), "no invitado")
        XCTAssertFalse(EventCardRule.canAnswer(meeting, me: "u2", now: after), "ya pasó")
        let cancelled = try ev("2026-09-30T20:00:00.000Z", "2026-09-30T21:00:00.000Z", invitees: #"[{"userId":"u2","rsvp":"pending"}]"#, cancelled: #""2026-09-29T00:00:00Z""#)
        XCTAssertFalse(EventCardRule.canAnswer(cancelled, me: "u2", now: before), "cancelado")
    }

    func testWhenText() throws {
        L10n.choice = .es
        defer { L10n.choice = .system }
        let meeting = try ev("2026-09-30T20:00:00.000Z", "2026-09-30T21:00:00.000Z")
        let s = EventCardRule.when(meeting, locale: Locale(identifier: "es-CO"))
        XCTAssertTrue(s.contains("septiembre"), s)
        XCTAssertTrue(s.contains(" – "), s)
        XCTAssertEqual(L("cal.cardGoing", ["n": 2, "total": 4]), "2 de 4 asistirán")
        XCTAssertEqual(L("cal.card", ["name": "Laura"]), "Evento de Laura")
    }
}
