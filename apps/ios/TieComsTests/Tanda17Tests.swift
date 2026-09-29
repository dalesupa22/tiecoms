import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }
private func sys(_ body: String) -> MessageDTO {
    MessageDTO(id: "s\(abs(body.hashValue))", conversationId: "c1", seq: 1, authorId: "a", clientMessageId: nil, kind: "system", body: body, createdAt: "")
}

/// Tanda 1.7 (docs/TANDA-1.7.md): refs, avisos de tareas y eventos, búsqueda y una sola vista.
@MainActor
final class Tanda17Tests: XCTestCase {
    func testDecodesNewDTOFields() throws {
        let m = try dec(MessageDTO.self, #"""
        {"id":"m1","conversationId":"c1","seq":3,"authorId":"b","kind":"text","body":"Ver #Finanzas","createdAt":"",
         "refs":[{"conversationId":"g1","name":"Finanzas","start":4,"length":9},{"broken":true}],
         "viewOnce":true,"viewOnceState":"unopened","openedBy":[{"userId":"a","at":"2026-09-29T10:00:00Z"}]}
        """#)
        XCTAssertEqual(m.refs.filter { !$0.conversationId.isEmpty }.count, 1, "una ref defectuosa no rompe el mensaje")
        XCTAssertEqual(m.refs.first?.name, "Finanzas")
        XCTAssertTrue(m.viewOnce); XCTAssertEqual(m.viewOnceState, "unopened"); XCTAssertEqual(m.openedBy.first?.userId, "a")
        let old = try dec(MessageDTO.self, #"{"id":"m2","body":"hola"}"#)
        XCTAssertFalse(old.viewOnce); XCTAssertTrue(old.refs.isEmpty)
        let ev = try dec(CalendarEventDTO.self, #"{"id":"e1","conversationId":"c1","title":"Demo","startsAt":"2026-09-29T20:00:00Z","endsAt":"2026-09-29T21:00:00Z","timezone":"America/Bogota","organizerId":"a","invitees":[],"updatedAt":"","commentCount":3,"lastComments":[{"id":"k1","eventId":"e1","authorId":"b","body":"Llevo el informe","createdAt":""}]}"#)
        XCTAssertEqual(ev.commentCount, 3); XCTAssertEqual(ev.lastComments.first?.body, "Llevo el informe")
        let page = try dec(ChatSearchPage.self, #"{"results":[{"message":{"id":"m1","seq":3,"body":"El informe"},"snippet":"El informe","matches":[[3,7]]}],"hasMore":true}"#)
        XCTAssertEqual(page.results.first?.matches, [[3, 7]]); XCTAssertTrue(page.hasMore)
        let open = try dec(ViewOnceContent.self, #"{"body":"secreto","attachments":[]}"#)
        XCTAssertEqual(open.body, "secreto")
    }

    func testSystemTextsEsEn() {
        let saved = L10n.choice; defer { L10n.choice = saved }
        L10n.choice = .es
        XCTAssertEqual(L10n.systemText(#"{"k":"issue.done","issueId":"i","title":"Cerrar el mes","byId":"a","byName":"Ana"}"#), "Ana completó la tarea «Cerrar el mes».")
        XCTAssertTrue(L10n.systemText(#"{"k":"issue.overdue","issueId":"i","title":"Informe","ownerId":"b","ownerName":"Bruno","dueDate":"2026-09-25"}"#).hasPrefix("No cumplimos: «Informe» venció el "))
        XCTAssertTrue(L10n.systemText(#"{"k":"event.today","eventId":"e","title":"Demo","startsAt":"2026-09-29T20:00:00Z","timezone":"America/Bogota"}"#).hasPrefix("Hoy: Demo a las "))
        XCTAssertEqual(L10n.systemText(#"{"k":"issue.comments","issueId":"i","title":"Informe","count":2,"lastById":"b","lastByName":"Bruno","lastExcerpt":"listo"}"#), "Bruno comentó la tarea «Informe».")
        L10n.choice = .en
        XCTAssertEqual(L10n.systemText(#"{"k":"event.comments","eventId":"e","title":"Demo","count":1,"lastByName":"Bruno","lastExcerpt":"ok"}"#), "Bruno commented on the event “Demo”.")
        // Una sola vista: la vista previa nunca muestra el contenido.
        var m = MessageDTO(id: "v", conversationId: "c", seq: 1, authorId: "b", clientMessageId: nil, body: "", createdAt: "")
        m.viewOnce = true
        XCTAssertEqual(L10n.messagePreview(m), "① Message")
        L10n.choice = .es
        m.attachments = [AttachmentDTO(id: "x", name: "f.jpg", contentType: "image/jpeg", sizeBytes: 1, url: "")]
        XCTAssertEqual(L10n.messagePreview(m), "① Foto")
    }

    func testCardKinds() {
        XCTAssertEqual(ChatCards.kind(sys(#"{"k":"event.today","eventId":"e1","title":"x"}"#)), .eventToday("e1"))
        XCTAssertEqual(ChatCards.kind(sys(#"{"k":"issue.done","issueId":"i1","byName":"Ana"}"#)), .issueDone("i1", byName: "Ana"))
        XCTAssertEqual(ChatCards.kind(sys(#"{"k":"issue.overdue","issueId":"i1","dueDate":"2026-09-25"}"#)), .issueOverdue("i1", dueDate: "2026-09-25"))
        XCTAssertEqual(ChatCards.kind(sys(#"{"k":"issue.comments","issueId":"i1","count":3,"lastByName":"Bruno","lastExcerpt":"ok"}"#)),
                       .issueComments("i1", .init(count: 3, lastById: nil, lastByName: "Bruno", lastExcerpt: "ok")))
        XCTAssertNil(ChatCards.kind(sys(#"{"k":"issue.created","issueId":"i2","parentIssueId":"i1"}"#)), "las derivadas siguen como línea")
        XCTAssertEqual(ChatCards.kind(sys(#"{"k":"issue.created","issueId":"i2"}"#))?.issueId, "i2")
        XCTAssertEqual(ChatCards.burst(sys(#"{"k":"issue.done","issueId":"i1"}"#)), .confetti)
        XCTAssertEqual(ChatCards.burst(sys(#"{"k":"issue.overdue","issueId":"i1"}"#)), .sad)
        XCTAssertNil(ChatCards.burst(sys(#"{"k":"issue.created","issueId":"i1"}"#)))
        // Tema del chat: las tarjetas nuevas de una tarea siguen el tema de la tarea.
        var i = try! dec(IssueDTO.self, #"{"id":"i1","title":"t","status":"open","createdBy":"a","createdAt":"","updatedAt":"","statusSince":"","topicId":"t1"}"#)
        i.topicId = "t1"
        XCTAssertTrue(TaskCard.matches(sys(#"{"k":"issue.done","issueId":"i1"}"#), filter: "t1", issues: ["i1": i]))
    }

    func testQuickDueAndBurstLedger() {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = .current
        let wed = cal.date(from: DateComponents(year: 2026, month: 9, day: 30, hour: 15))!
        XCTAssertEqual(ChatCards.quickDue(.today, now: wed, calendar: cal), "2026-09-30")
        XCTAssertEqual(ChatCards.quickDue(.tomorrow, now: wed, calendar: cal), "2026-10-01")
        XCTAssertEqual(ChatCards.quickDue(.nextMonday, now: wed, calendar: cal), "2026-10-05")
        let mon = cal.date(from: DateComponents(year: 2026, month: 10, day: 5, hour: 9))!
        XCTAssertEqual(ChatCards.quickDue(.nextMonday, now: mon, calendar: cal), "2026-10-12", "desde un lunes, el siguiente")
        let id = "burst-\(UUID().uuidString)"
        XCTAssertTrue(BurstLedger.shouldPlay(id)); XCTAssertFalse(BurstLedger.shouldPlay(id), "una vez por mensaje y dispositivo")
    }

    func testRefsInComposer() {
        XCTAssertEqual(RefText.activeQuery(in: "Mira #Fin")?.query, "Fin")
        XCTAssertNil(RefText.activeQuery(in: "color#fff"), "solo al inicio o tras un espacio")
        let r = MentionText.insert(name: "Finanzas", userId: "#g1", into: "Mira #Fin", replacing: 5, 9, mentions: [], sigil: "#")
        XCTAssertEqual(r.text, "Mira #Finanzas ")
        XCTAssertEqual(r.mentions, [Mention(userId: "#g1", start: 5, length: 9)])
        let all = r.mentions + [Mention(userId: "u1", start: 0, length: 4)]
        let parts = RefText.split(all)
        XCTAssertEqual(parts.mentions.map(\.userId), ["u1"]); XCTAssertEqual(parts.refs.map(\.refConversationId), ["g1"])
        XCTAssertEqual(RefText.json(parts.refs[0])["conversationId"] as? String, "g1")
        XCTAssertEqual(MentionText.valid(r.mentions, in: r.text).count, 1, "el token empieza con #")
        XCTAssertEqual(RefText.name(in: r.text, r.mentions[0]), "Finanzas")
        XCTAssertEqual(RefText.tokens([MessageRef(conversationId: "g1", name: "Finanzas", start: 5, length: 9)]), [Mention(userId: "#g1", start: 5, length: 9)])
        let d = try! dec(BootstrapDTO.self, #"{"me":{"id":"a","name":"Ana"},"conversations":[{"id":"g1","kind":"group","name":"Finanzas y pagos","memberIds":["a"]},{"id":"g2","kind":"group","name":"Obra","memberIds":["a"]}]}"#)
        XCTAssertEqual(RefText.candidates(d, query: "finan").map(\.id), ["g1"], "sin mayúsculas ni tildes")
    }

    func testSearchRangesAndState() {
        XCTAssertEqual(ChatSearch.ranges(of: "informe", in: "El Informe y el INFORME"), [NSRange(location: 3, length: 7), NSRange(location: 16, length: 7)])
        XCTAssertEqual(ChatSearch.ranges(of: "reunion", in: "La reunión es hoy").first, NSRange(location: 3, length: 7), "sin tildes")
        XCTAssertTrue(ChatSearch.ranges(of: "a", in: "casa").isEmpty, "mínimo 2 caracteres")
        var s = ChatSearchState(active: true, query: "in")
        s.results = (0..<3).map { MessageDTO(id: "m\($0)", conversationId: "c", seq: 10 - $0, authorId: "b", clientMessageId: nil, body: "x", createdAt: "") }
        let saved = L10n.choice; defer { L10n.choice = saved }; L10n.choice = .es
        XCTAssertEqual(s.counter, "1 de 3")
        s.older(); s.older(); s.older()
        XCTAssertEqual(s.index, 2, "no pasa del más viejo"); XCTAssertEqual(s.counter, "3 de 3")
        s.newer(); XCTAssertEqual(s.current?.id, "m1")
        s.hasMore = true; XCTAssertEqual(s.counter, "2 de 3+")
    }

    func testViewOnceRules() {
        var m = MessageDTO(id: "v", conversationId: "c", seq: 1, authorId: "a", clientMessageId: nil, body: "", createdAt: "")
        m.viewOnce = true
        XCTAssertEqual(ViewOnceRules.kind(m), .text)
        m.attachments = [AttachmentDTO(id: "x", name: "n.m4a", contentType: "audio/mp4", sizeBytes: 1, url: "", kind: "voice")]
        XCTAssertEqual(ViewOnceRules.kind(m), .voice)
        XCTAssertTrue(ViewOnceRules.allowed([LocalAttachment(name: "a.jpg", contentType: "image/jpeg", data: Data([1]))]))
        XCTAssertFalse(ViewOnceRules.allowed([LocalAttachment(name: "a.pdf", contentType: "application/pdf", data: Data([1]))]), "archivos no")
        m.openedBy = [ViewOnceOpen(userId: "b", at: "")]
        let saved = L10n.choice; defer { L10n.choice = saved }; L10n.choice = .es
        XCTAssertEqual(ViewOnceRules.seenBy(m) { $0 == "b" ? "Bruno Ortega" : nil }, "Visto por Bruno")
        m.viewOnceState = "opened"; XCTAssertTrue(ViewOnceRules.opened(m))
    }

    func testViewOnceOpenOnceAndSendPayload() async throws {
        let s = try ControlledURLProtocol.store()
        s.seedForTesting(try dec(BootstrapDTO.self, #"{"me":{"id":"a","name":"Ana"},"conversations":[{"id":"c1","kind":"direct","memberIds":["a","b"],"canPost":true}]}"#),
                         conversations: ["c1": ConversationState(messages: [], lastEventSeq: 0, hasMore: false, loaded: true)])
        var calls = 0
        ControlledURLProtocol.handler = { req in Task { @MainActor in
            calls += 1
            if calls == 1 { req.respond(#"{"body":"secreto","attachments":[]}"#) }
            else { req.respond(410, #"{"error":{"code":"already_opened","message":"Ya lo abriste"}}"#) }
        } }
        var m = MessageDTO(id: "v1", conversationId: "c1", seq: 1, authorId: "b", clientMessageId: nil, body: "", createdAt: "")
        m.viewOnce = true; m.viewOnceState = "unopened"
        s.upsertLocal(m)
        let c = try await s.openViewOnce(m)
        XCTAssertEqual(c.body, "secreto")
        XCTAssertEqual(s.conversations["c1"]?.messages.first?.viewOnceState, "opened", "al abrir queda «Abierto»")
        do { _ = try await s.openViewOnce(m); XCTFail("la segunda vez: 410") } catch let e as ApiRequestError { XCTAssertEqual(e.status, 410) }
        let p = s.send("c1", body: "hola #Finanzas", mentions: [Mention(userId: "#g1", start: 5, length: 9)], viewOnce: true)
        XCTAssertEqual(p?.viewOnce, true)
        XCTAssertEqual(p?.mentions?.first?.userId, "#g1")
    }
}
