import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }

/// docs/GRUPOS.md, «Dentro del chat»: hilos (derivadas y sidechats privados) y agenda del chat.
final class ChatBarTests: XCTestCase {
    private func boot() throws -> BootstrapDTO {
        try dec(BootstrapDTO.self, #"""
        {"contract":"x","serverTime":"","me":{"id":"me","name":"Ana"},"organizations":[],"workspaces":[],
         "conversations":[
           {"id":"c","workspaceId":"w","kind":"group","name":"Pagos","memberIds":["me","bob"]},
           {"id":"t1","workspaceId":"w","kind":"group","name":"Hilo · Facturas de octubre","parentId":"c","parentMessageId":"m1","deriveKind":"same","memberIds":["me","bob"],"lastMessageSeq":4,"lastMessageAt":"2026-09-25T10:00:00Z"},
           {"id":"t2","workspaceId":"w","kind":"group","name":"Derivada · Viejo","parentId":"c","parentMessageId":"m2","deriveKind":"same","returnedAt":"2026-09-25T11:00:00Z","memberIds":["me"],"lastMessageAt":"2026-09-25T12:00:00Z"},
           {"id":"s1","kind":"multi","name":"Sidechat · ¿Llega?","parentId":"c","parentMessageId":"m1","deriveKind":"side","memberIds":["me","bob"],"lastMessageAt":"2026-09-25T09:00:00Z"},
           {"id":"other","kind":"multi","parentId":"x","memberIds":["me"]}],
         "people":[]}
        """#)
    }

    func testThreadsOfConversationOpenFirstAndByMessage() throws {
        let d = try boot()
        XCTAssertEqual(ChatThreads.of(d, "c").map(\.id), ["t1", "s1", "t2"], "abiertos primero (por actividad) y los resueltos al final")
        XCTAssertEqual(ChatThreads.of(d, "c", messageId: "m1").map(\.id), ["t1", "s1"])
        XCTAssertTrue(ChatThreads.isPrivate(d.conversations.first { $0.id == "s1" }!))
        XCTAssertFalse(ChatThreads.isPrivate(d.conversations.first { $0.id == "t1" }!))
    }

    func testThreadTitleWithoutPrefixAndReplies() throws {
        let d = try boot()
        let t1 = d.conversations.first { $0.id == "t1" }!
        XCTAssertEqual(ChatThreads.title(d, t1), "Facturas de octubre")
        XCTAssertEqual(ChatThreads.title(d, d.conversations.first { $0.id == "t2" }!), "Viejo")
        XCTAssertEqual(ChatThreads.title(d, d.conversations.first { $0.id == "s1" }!), "¿Llega?")
        XCTAssertEqual(ChatThreads.title(d, d.conversations.first { $0.id == "c" }!), "Pagos")
        XCTAssertEqual(ChatThreads.replies(t1), 3)
        XCTAssertEqual(ChatThreads.replies(d.conversations.first { $0.id == "t2" }!), 0)
    }

    func testAgendaMergesMeetingsDueDatesAndMyRemindersByDate() throws {
        let now = ISODate.parse("2026-09-25T12:00:00Z")!
        let ev = try dec(CalendarEventDTO.self, #"{"id":"e1","conversationId":"c","title":"Revisión","startsAt":"2026-09-28T15:00:00Z","endsAt":"2026-09-28T16:00:00Z","timezone":"UTC","organizerId":"me","invitees":[],"updatedAt":""}"#)
        let past = try dec(CalendarEventDTO.self, #"{"id":"e0","conversationId":"c","title":"Pasada","startsAt":"2026-09-20T15:00:00Z","endsAt":"2026-09-20T16:00:00Z","timezone":"UTC","organizerId":"me","invitees":[],"updatedAt":""}"#)
        let cancelled = try dec(CalendarEventDTO.self, #"{"id":"e2","conversationId":"c","title":"No","startsAt":"2026-09-27T15:00:00Z","endsAt":"2026-09-27T16:00:00Z","timezone":"UTC","organizerId":"me","invitees":[],"cancelledAt":"2026-09-24T00:00:00Z","updatedAt":""}"#)
        let otherConv = try dec(CalendarEventDTO.self, #"{"id":"e3","conversationId":"z","title":"Otra","startsAt":"2026-09-26T15:00:00Z","endsAt":"2026-09-26T16:00:00Z","timezone":"UTC","organizerId":"me","invitees":[],"updatedAt":""}"#)
        let due = try dec(IssueDTO.self, #"{"id":"i1","conversationId":"c","title":"Pagar","status":"open","dueDate":"2026-09-26","createdBy":"me"}"#)
        let noDue = try dec(IssueDTO.self, #"{"id":"i2","conversationId":"c","title":"Sin fecha","status":"open","createdBy":"me"}"#)
        let done = try dec(IssueDTO.self, #"{"id":"i3","conversationId":"c","title":"Hecho","status":"done","dueDate":"2026-09-26","createdBy":"me"}"#)
        let rem = try dec(ReminderDTO.self, #"{"id":"r1","conversationId":"c","remindAt":"2026-09-25T20:00:00Z"}"#)
        let remDone = try dec(ReminderDTO.self, #"{"id":"r2","conversationId":"c","remindAt":"2026-09-25T21:00:00Z","doneAt":"2026-09-25T21:00:00Z"}"#)
        let items = ChatAgendaItem.build(conversationId: "c", events: [ev, past, cancelled, otherConv], issues: [due, noDue, done], reminders: [rem, remDone], now: now)
        XCTAssertEqual(items.map(\.id), ["reminder-r1", "due-i1", "event-e1"])
    }
}
