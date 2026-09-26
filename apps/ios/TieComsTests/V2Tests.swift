import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }

/// DTO nuevos (asuntos, agenda, recordatorios, reenvíos, dominios, WhatsApp) con campos extra.
final class DecodingV2Tests: XCTestCase {
    static let issue = #"{"id":"i1","workspaceId":"w1","conversationId":"c1","originMessageId":"m1","originMessageSeq":4,"title":"Enviar cotización","status":"waiting","waitingOnOrgId":"o2","ownerId":"u1","requestedBy":"u2","dueDate":"2026-09-30","createdBy":"u1","createdAt":"2026-09-20T10:00:00.000Z","updatedAt":"2026-09-21T10:00:00.000Z","statusSince":"2026-09-21T10:00:00.000Z","closedAt":null,"commentCount":2,"priority":"alta"}"#
    static let event = #"{"id":"e1","workspaceId":"w1","conversationId":"c1","originMessageId":null,"title":"Revisión","description":null,"location":"https://meet.example/x","startsAt":"2026-09-25T15:00:00.000Z","endsAt":"2026-09-25T16:00:00.000Z","timezone":"America/Bogota","organizerId":"u1","invitees":[{"userId":"u1","rsvp":"yes"},{"userId":"u2","rsvp":"desconocido"},{"sinUser":1}],"cancelledAt":null,"updatedAt":"2026-09-24T10:00:00.000Z","color":"rojo"}"#

    func testIssueAndStatus() throws {
        let i = try dec(IssueDTO.self, Self.issue)
        XCTAssertEqual(i.status, .waiting)
        XCTAssertEqual(i.originMessageSeq, 4)
        XCTAssertFalse(i.status.closed)
        let unknown = try dec(IssueDTO.self, #"{"id":"i2","status":"futuro"}"#)
        XCTAssertEqual(unknown.status, .open)
    }

    func testIssueDetailPayload() throws {
        let r = try dec(IssueDetail.self, #"{"issue":\#(Self.issue),"events":[{"id":1,"issueId":"i1","actorId":"u1","kind":"comment","payload":{"body":"listo","extra":[1,true,null]},"createdAt":"2026-09-21T10:00:00Z"},{"id":2,"issueId":"i1","actorId":"u1","kind":"status","payload":{"from":"open","to":"waiting"},"createdAt":"2026-09-21T11:00:00Z"}]}"#)
        XCTAssertEqual(r.events.count, 2)
        XCTAssertEqual(r.events[0].payload["body"]?.stringValue, "listo")
        XCTAssertEqual(r.events[1].payload["to"]?.stringValue, "waiting")
    }

    func testCalendarEventTolerant() throws {
        let e = try dec(CalendarEventDTO.self, Self.event)
        XCTAssertEqual(e.invitees.count, 3)
        XCTAssertEqual(e.invitees[1].rsvp, .pending)
        XCTAssertEqual(e.end.timeIntervalSince(e.start), 3600)
        XCTAssertFalse(e.isCancelled)
    }

    func testReminderForwardedMessageAndDomain() throws {
        let r = try dec(ReminderDTO.self, #"{"id":"r1","conversationId":"c1","messageId":null,"messageSeq":null,"note":"Llamar","remindAt":"2026-09-24T12:00:00Z","firedAt":null,"doneAt":null,"snoozes":3}"#)
        XCTAssertEqual(r.note, "Llamar")
        let m = try dec(MessageDTO.self, #"{"id":"m1","seq":2,"authorId":"u","body":"x","createdAt":"","forwarded":{"source":"whatsapp","author":"Juan","sentAt":"24/9/26 10:12","fromConversationId":null,"app":"wa"}}"#)
        XCTAssertEqual(m.forwarded?.source, .whatsapp)
        XCTAssertEqual(m.forwarded?.author, "Juan")
        let weird = try dec(MessageDTO.self, #"{"id":"m2","seq":3,"authorId":"u","body":"y","createdAt":"","forwarded":{"source":"telegram"}}"#)
        XCTAssertEqual(weird.forwarded?.source, .other, "fuente desconocida → otra app")
        let d = try dec(OrgDomainDTO.self, #"{"domain":"acme.co","status":"pending","txtName":"_tiecoms.acme.co","txtValue":"tiecoms-verify=abc","verifiedAt":null,"lastCheckedAt":null,"method":"dns"}"#)
        XCTAssertEqual(d.txtName, "_tiecoms.acme.co")
    }

    func testConversationPrefsAndLineage() throws {
        let c = try dec(ConversationDTO.self, #"{"id":"c1","kind":"group","pinnedAt":"2026-09-24T10:00:00Z","mutedUntil":"2099-12-31T00:00:00.000Z","parentId":"c0","parentMessageSeq":7,"deriveKind":"internal","deriveReason":"Revisar","returnedAt":null,"openIssues":2}"#)
        XCTAssertTrue(c.isMuted)
        XCTAssertNotNil(c.pinnedAt)
        XCTAssertEqual(c.parentMessageSeq, 7)
        XCTAssertEqual(c.deriveReason, "Revisar")
        let past = try dec(ConversationDTO.self, #"{"id":"c2","kind":"group","mutedUntil":"2020-01-01T00:00:00Z"}"#)
        XCTAssertFalse(past.isMuted)
    }

    func testWhatsAppDTOs() throws {
        let a = try dec(WaAccountDTO.self, #"{"id":"a1","label":"Tienda","kind":"personal","status":"qr","phone":null,"pushName":null,"platform":"smba","qr":"data:image/png;base64,AAAA","pairingCode":null,"lastError":null,"connectedAt":null,"lastSyncAt":null,"chats":0,"groups":0,"createdAt":"","nuevo":1}"#)
        XCTAssertTrue(a.isBusiness, "platform smb* = Business")
        XCTAssertTrue(a.isWaiting)
        let p = try dec(WaChatsPage.self, #"{"chats":[{"accountId":"a1","accountLabel":"Tienda","accountKind":"business","jid":"123@g.us","name":"Proveedores","isGroup":true,"participants":12,"description":null,"lastMessageAt":null,"lastPreview":null,"unread":3,"category":"clientes","categoryManual":false,"pinned":false,"hidden":false,"archivedInWhatsApp":false,"linkedConversationId":null}],"categories":{"clientes":{"total":1,"unread":3}}}"#)
        XCTAssertEqual(p.chats.first?.category, .clientes)
        XCTAssertEqual(p.categories["clientes"]?.unread, 3)
    }

    func testNewConversationEvents() throws {
        let pins = try dec(ConversationEvent.self, #"{"type":"pins.changed","conversationId":"c1","eventSeq":9,"messageIds":["m1","m2"]}"#)
        XCTAssertEqual(pins, .pinsChanged(conversationId: "c1", eventSeq: 9, messageIds: ["m1", "m2"]))
        let cal = try dec(ConversationEvent.self, #"{"type":"calendar.updated","conversationId":"c1","eventSeq":10,"event":\#(Self.event)}"#)
        guard case .calendarUpdated(_, 10, let e) = cal else { return XCTFail() }
        XCTAssertEqual(e.title, "Revisión")
        let iss = try dec(ConversationEvent.self, #"{"type":"issue.updated","conversationId":"c1","eventSeq":11,"issue":\#(Self.issue)}"#)
        guard case .issueUpdated(_, 11, let i) = iss else { return XCTFail() }
        XCTAssertEqual(i.id, "i1")
        // issue.updated con payload ilegible no rompe: solo avanza el cursor.
        let bad = try dec(ConversationEvent.self, #"{"type":"issue.updated","conversationId":"c1","eventSeq":12,"issue":"x"}"#)
        XCTAssertEqual(bad, .other(type: "issue.updated", conversationId: "c1", eventSeq: 12))
    }

    func testNewAccountEvents() throws {
        guard case .reminderDue(let r) = try dec(AccountEvent.self, #"{"type":"reminder.due","reminder":{"id":"r1","conversationId":"c1","remindAt":"2026-09-24T12:00:00Z"}}"#) else { return XCTFail() }
        XCTAssertEqual(r.id, "r1")
        XCTAssertEqual(try dec(AccountEvent.self, #"{"type":"prefs.updated","conversationId":"c1"}"#), .prefsUpdated(conversationId: "c1", workspaceId: nil))
        XCTAssertEqual(try dec(AccountEvent.self, #"{"type":"whatsapp.updated","accountId":"a1"}"#), .whatsappUpdated(accountId: "a1"))
        XCTAssertEqual(try dec(AccountEvent.self, #"{"type":"reminder.due","reminder":null}"#), .other(type: "reminder.due"))
    }

    func testNewDeepLinks() {
        XCTAssertEqual(DeepLink.parse(URL(string: "https://app.tiecoms.com/asuntos")!), .issues)
        XCTAssertEqual(DeepLink.parse(URL(string: "chaggu://agenda")!), .agenda)
        XCTAssertEqual(DeepLink.parse(URL(string: "https://tiecoms.com/trazo")!), .trazo)
        XCTAssertEqual(DeepLink.parse(URL(string: "chaggu://whatsapp")!), .whatsapp)
        XCTAssertEqual(DeepLink.parse(URL(string: "https://app.tiecoms.com/share?title=Hola&text=mundo")!), .share(text: "Hola\nmundo"))
        XCTAssertEqual(DeepLink.parse(URL(string: "chaggu://share")!), .share(text: nil))
    }

    func testErrorCodesFromWeb() {
        // Los códigos SSO y de dominio vienen de la web (i18n.ts) vía gen-strings.
        XCTAssertNotEqual(L("err.domain_claimed"), "err.domain_claimed")
        XCTAssertNotEqual(L("err.sso_expired"), "err.sso_expired")
        XCTAssertEqual(L10n.codeText("codigo_raro", message: "texto"), "texto")
    }
}

/// Splash de Chaggu («ignición» del símbolo + eslogan) como función pura del tiempo.
final class SplashTimelineTests: XCTestCase {
    typealias T = SplashTimeline

    func testStartsLikeSystemLaunchScreen() {
        // t = 0: solo capas 1 y 2 a escala 1, sin rayitas ni eslogan, sin salida.
        XCTAssertEqual(T.symbolSide, 200)
        XCTAssertEqual(T.pop(0), 1, accuracy: 0.0001)
        XCTAssertEqual(T.sparks(0).opacity, 0)
        XCTAssertEqual(T.tagline(0).opacity, 0)
        XCTAssertEqual(T.exit(0).opacity, 1)
        XCTAssertEqual(T.exit(0).scale, 1, accuracy: 0.0001)
        // Quieto hasta 0,20 s (el «pop» arranca antes de que termine la pausa de 0,25 s).
        for t in stride(from: 0.0, through: 0.20, by: 0.05) {
            XCTAssertEqual(T.pop(t), 1, accuracy: 0.0001)
            XCTAssertEqual(T.sparks(t).opacity, 0)
        }
        XCTAssertLessThanOrEqual(T.popStart, T.holdEnd)
    }

    func testPop() {
        XCTAssertEqual(T.pop(T.popStart), 1, accuracy: 0.0001)
        XCTAssertEqual(T.pop(T.popEnd), 1, accuracy: 0.0001)
        XCTAssertEqual(T.pop(1.0), 1, accuracy: 0.0001)
        let peak = stride(from: T.popStart, through: T.popEnd, by: 0.005).map(T.pop).max() ?? 0
        XCTAssertEqual(peak, 1.10, accuracy: 0.002)
        XCTAssertGreaterThan(T.pop(0.30), 1.05, "ease out: sube rápido")
    }

    func testSparks() {
        XCTAssertEqual(T.sparks(T.sparksStart).opacity, 0)
        XCTAssertEqual(T.sparks(T.sparksStart).scale, 0.4, accuracy: 0.0001)
        XCTAssertEqual(T.sparks(T.sparksEnd).opacity, 1)
        XCTAssertEqual(T.sparks(T.sparksEnd).scale, 1, accuracy: 0.0001)
        XCTAssertEqual(T.sparks(1.2).scale, 1, accuracy: 0.0001)
        let mid = T.sparks((T.sparksStart + T.sparksEnd) / 2)
        XCTAssertTrue(mid.opacity > 0 && mid.opacity < 1)
        XCTAssertEqual(T.sparksAnchor.x, 0.83, accuracy: 0.001)
        XCTAssertEqual(T.sparksAnchor.y, 0.17, accuracy: 0.001)
        XCTAssertEqual(T.soundAt, T.sparksStart)
        XCTAssertEqual(T.hapticAt, T.sparksStart)
    }

    func testTaglineAndExit() {
        XCTAssertEqual(T.tagline(0.5).opacity, 0)
        XCTAssertEqual(T.tagline(T.taglineStart).offset, 8, accuracy: 0.0001)
        XCTAssertEqual(T.tagline(T.taglineEnd).opacity, 0.8, accuracy: 0.0001)
        XCTAssertEqual(T.tagline(T.taglineEnd).offset, 0, accuracy: 0.0001)
        XCTAssertEqual(T.exit(T.exitStart).opacity, 1)
        XCTAssertEqual(T.exit(T.total).opacity, 0)
        XCTAssertEqual(T.exit(T.total).scale, 1.04, accuracy: 0.001)
        XCTAssertEqual(T.exitStart, 1.30)
        XCTAssertEqual(T.total, 1.60)
        // Todo el símbolo está completo antes de la salida.
        XCTAssertLessThan(T.taglineEnd, T.exitStart)
    }

    func testClockHoldsUntilReadyAndShortMode() {
        // Lista desde el principio: el reloj es el tiempo real.
        XCTAssertEqual(T.clock(elapsed: 0.5, short: false, readyAt: 0.2), 0.5)
        XCTAssertEqual(T.clock(elapsed: 1.5, short: false, readyAt: 0.2), 1.5, accuracy: 0.001)
        // Aún cargando: se queda en el último cuadro (inicio de la salida).
        XCTAssertEqual(T.clock(elapsed: 3.5, short: false, readyAt: nil), T.exitStart)
        // Lista a los 4 s: la salida arranca entonces.
        XCTAssertEqual(T.clock(elapsed: 4.1, short: false, readyAt: 4.0), T.exitStart + 0.1, accuracy: 0.001)
        // Máximo 6 s esperando: sigue sin estar lista y sale igual.
        XCTAssertEqual(T.clock(elapsed: 6.2, short: false, readyAt: nil), T.exitStart + 0.2, accuracy: 0.001)
        // Enlace en frío: empieza en 0,7 s (rayitas ya completas) y termina en ≤ 0,9 s.
        XCTAssertEqual(T.clock(elapsed: 0, short: true, readyAt: 0), 0.7, accuracy: 0.0001)
        XCTAssertEqual(T.sparks(T.clock(elapsed: 0, short: true, readyAt: 0)).opacity, 1)
        XCTAssertGreaterThanOrEqual(T.clock(elapsed: 0.9, short: true, readyAt: 0), T.total - 0.001)
        // Toque: salta a la salida.
        XCTAssertEqual(T.clock(elapsed: 0.3, short: false, readyAt: 0, skip: T.exitStart - 0.3), T.exitStart, accuracy: 0.001)
    }

    func testReduceMotion() {
        XCTAssertEqual(T.reducedTagline(0), 0)
        XCTAssertEqual(T.reducedTagline(T.reducedTaglineEnd), 0.8, accuracy: 0.0001)
        // Lista pronto: se muestra al menos 0,9 s y luego se desvanece en 0,3 s.
        XCTAssertEqual(T.reducedExitOpacity(elapsed: 0.5, readyAt: 0.1), 1)
        XCTAssertEqual(T.reducedExitOpacity(elapsed: 1.05, readyAt: 0.1), 0.5, accuracy: 0.001)
        XCTAssertEqual(T.reducedExitOpacity(elapsed: 1.3, readyAt: 0.1), 0, accuracy: 0.0001)
        // Sin estar lista: espera hasta 6 s.
        XCTAssertEqual(T.reducedExitOpacity(elapsed: 5, readyAt: nil), 1)
        XCTAssertEqual(T.reducedExitOpacity(elapsed: 6.3, readyAt: nil), 0, accuracy: 0.0001)
    }
}

/// Compartir hacia Chaggu y tiempos rápidos.
final class SharedTextTests: XCTestCase {
    func testWhatsAppSplit() {
        let txt = "[24/9/26, 10:12] Juan Pérez: Hola equipo\n[24/9/26, 10:13] Ana: ¿Mañana?\nsegunda línea\n[24/9/26, 10:14] Ana: <Multimedia omitido>"
        XCTAssertEqual(SharedText.detectSource(txt), .whatsapp)
        let items = SharedText.analyze(txt, source: .whatsapp)
        XCTAssertEqual(items.map(\.body), ["Hola equipo", "¿Mañana?\nsegunda línea"])
        XCTAssertEqual(items.first?.forwarded.author, "Juan Pérez")
        XCTAssertEqual(items.first?.forwarded.sentAt, "24/9/26 10:12")
    }

    func testEmailAndOther() {
        let mail = "De: Laura <laura@acme.co>\nAsunto: Pedido\n\nAdjunto el pedido."
        XCTAssertEqual(SharedText.detectSource(mail), .email)
        XCTAssertEqual(SharedText.analyze(mail, source: .email).first?.forwarded.author, "Laura <laura@acme.co>")
        XCTAssertEqual(SharedText.detectSource("https://example.com/nota"), .other)
        XCTAssertEqual(SharedText.analyze("  ", source: .other).count, 0)
        let one = SharedText.analyze("texto suelto", source: .other)
        XCTAssertEqual(one.count, 1)
        XCTAssertEqual(one[0].forwarded.json["source"] as? String, "other")
    }

    func testQuickTimes() {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "America/Bogota")!
        let wed = ISODate.parse("2026-09-23T15:00:00.000Z")! // miércoles 10:00 en Bogotá
        let list = QuickTimes.list(now: wed, calendar: cal)
        XCTAssertEqual(list.map(\.key), ["20m", "1h", "3h", "tomorrow", "monday"])
        XCTAssertEqual(list[0].date.timeIntervalSince(wed), 1200)
        XCTAssertEqual(cal.component(.hour, from: list[3].date), 9)
        XCTAssertEqual(cal.component(.weekday, from: list[4].date), 2, "lunes")
        XCTAssertEqual(cal.component(.day, from: list[4].date), 28)
    }

    func testMuteOptions() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(AppStore.muteUntil(.hour, now: now).timeIntervalSince(now), 3600)
        XCTAssertEqual(AppStore.muteUntil(.week, now: now).timeIntervalSince(now), 7 * 86400)
        XCTAssertGreaterThan(AppStore.muteUntil(.forever), ISODate.parse("2099-01-01T00:00:00Z")!)
    }
}

/// Eventos nuevos aplicados al store (sin red).
@MainActor
final class StoreV2Tests: XCTestCase {
    var store: AppStore!
    var spy: FeedbackSpy!

    override func setUp() async throws {
        spy = FeedbackSpy()
        store = AppStore(baseURL: URL(string: "http://127.0.0.1:9")!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: spy)
        let d = try JSONDecoder().decode(BootstrapDTO.self, from: Data(#"""
        {"contract":"x","serverTime":"","me":{"id":"me","name":"Ana","kind":"human","primaryOrgId":"o1"},"organizations":[],"workspaces":[{"id":"w1","name":"Obra","owningOrgId":"o1","organizationIds":["o1"],"memberIds":["me","bob"],"myRole":"lead","createdAt":""}],
         "conversations":[{"id":"c1","workspaceId":"w1","kind":"group","name":"General","memberIds":["me","bob"],"lastMessageSeq":2,"lastEventSeq":5,"canPost":true},
                          {"id":"c2","workspaceId":"w1","kind":"group","name":"Silenciada","memberIds":["me","bob"],"lastMessageSeq":0,"lastEventSeq":0,"canPost":true,"mutedUntil":"2099-12-31T00:00:00.000Z"}],
         "people":[{"id":"me","name":"Ana","kind":"human","orgId":"o1"},{"id":"bob","name":"Bob","kind":"human","orgId":"o1"}]}
        """#.utf8))
        let m = try JSONDecoder().decode(MessageDTO.self, from: Data(#"{"id":"m1","conversationId":"c1","seq":2,"authorId":"bob","body":"original","createdAt":"2026-09-24T10:00:00Z"}"#.utf8))
        store.seedForTesting(d, conversations: ["c1": ConversationState(messages: [m], lastEventSeq: 5, hasMore: false, loaded: true)])
        store.openConversationId = "c1"
    }

    private func ev(_ json: String) -> ConversationEvent { try! JSONDecoder().decode(ConversationEvent.self, from: Data(json.utf8)) }

    func testMessageUpdatedEditsAndDeletes() {
        store.onConversationEvent(ev(#"{"type":"message.updated","conversationId":"c1","eventSeq":6,"message":{"id":"m1","conversationId":"c1","seq":2,"authorId":"bob","body":"editado","createdAt":"2026-09-24T10:00:00Z","editedAt":"2026-09-24T10:05:00Z"}}"#), live: true)
        XCTAssertEqual(store.conversations["c1"]?.messages.first?.body, "editado")
        XCTAssertNotNil(store.conversations["c1"]?.messages.first?.editedAt)
        XCTAssertEqual(store.meta("c1")?.lastMessagePreview, "editado")
        XCTAssertEqual(spy.receives, 0, "una edición no suena")
        store.onConversationEvent(ev(#"{"type":"message.updated","conversationId":"c1","eventSeq":7,"message":{"id":"m1","conversationId":"c1","seq":2,"authorId":"bob","body":"","createdAt":"","deletedAt":"2026-09-24T10:06:00Z"}}"#), live: true)
        XCTAssertNotNil(store.conversations["c1"]?.messages.first?.deletedAt)
        XCTAssertEqual(store.conversations["c1"]?.lastEventSeq, 7)
    }

    func testPinsCalendarIssueEvents() {
        store.onConversationEvent(ev(#"{"type":"pins.changed","conversationId":"c1","eventSeq":6,"messageIds":["m1"]}"#), live: true)
        XCTAssertEqual(store.pins["c1"], ["m1"])
        store.onConversationEvent(ev(#"{"type":"calendar.updated","conversationId":"c1","eventSeq":7,"event":\#(DecodingV2Tests.event.replacingOccurrences(of: "\"organizerId\":\"u1\"", with: "\"organizerId\":\"bob\""))}"#), live: true)
        XCTAssertEqual(store.events["e1"]?.title, "Revisión")
        XCTAssertEqual(spy.notifications.count, 1, "reunión nueva de otra persona → aviso con tc_notify")
        store.onConversationEvent(ev(#"{"type":"issue.updated","conversationId":"c1","eventSeq":8,"issue":\#(DecodingV2Tests.issue)}"#), live: true)
        XCTAssertEqual(store.issues["i1"]?.status, .waiting)
        XCTAssertEqual(store.meta("c1")?.openIssues, 1)
        XCTAssertEqual(store.conversations["c1"]?.lastEventSeq, 8)
    }

    func testEventsInUnloadedConversationStillApply() {
        store.onConversationEvent(ev(#"{"type":"pins.changed","conversationId":"c2","eventSeq":1,"messageIds":["x"]}"#), live: true)
        XCTAssertEqual(store.pins["c2"], ["x"])
    }

    func testMutedConversationDoesNotNotify() {
        store.onConversationEvent(ev(#"{"type":"message.created","conversationId":"c2","eventSeq":1,"message":{"id":"n1","conversationId":"c2","seq":1,"authorId":"bob","body":"hola","createdAt":"2026-09-24T10:00:00Z"}}"#), live: true)
        XCTAssertTrue(spy.notifications.isEmpty, "silenciada: sin sonido ni notificación")
        XCTAssertEqual(store.meta("c2")?.unread, 1, "pero cuenta como no leído")
    }

    func testReplyAndForwardedGoInPendingPayload() {
        let p = store.send("c1", body: "respuesta", replyTo: "m1", forwarded: ForwardedInfo(source: .slack, author: "Luis"))!
        XCTAssertEqual(p.replyTo, "m1")
        XCTAssertEqual(p.forwarded?.source, .slack)
        let data = try! JSONEncoder().encode(p)
        let back = try! JSONDecoder().decode(PendingMessage.self, from: data)
        XCTAssertEqual(back.forwarded?.author, "Luis", "la cola persistente conserva el reenvío")
    }

    func testNavigateNewTabs() {
        store.navigate(to: .issues); XCTAssertEqual(store.tab, .issues)
        store.navigate(to: .agenda); XCTAssertEqual(store.tab, .agenda)
        store.navigate(to: .trazo); XCTAssertEqual(store.tab, .home); XCTAssertEqual(store.homePath, [.trazo])
        store.navigate(to: .whatsapp); XCTAssertEqual(store.tab, .settings); XCTAssertEqual(store.settingsPath, [.whatsapp])
        store.handle(.share(text: "hola")); XCTAssertEqual(store.shareText, "hola")
    }

    func testPinnedSectionFirst() {
        store.patchMeta("c2") { $0.pinnedAt = "2026-09-24T10:00:00Z" }
        let s = Naming.sections(store.data!, filterWorkspace: nil, query: "")
        XCTAssertEqual(s.first?.id, "_pinned")
        XCTAssertEqual(s.first?.conversations.map(\.id), ["c2"])
        XCTAssertFalse(s.dropFirst().flatMap(\.conversations).contains { $0.id == "c2" })
    }
}
