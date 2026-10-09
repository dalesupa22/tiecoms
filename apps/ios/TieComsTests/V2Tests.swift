import XCTest
import SwiftUI
import UIKit
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

/// Splash de Chaggu (puntitos que escriben + ¡pum!) como función pura del tiempo.
final class SplashTimelineTests: XCTestCase {
    typealias T = SplashTimeline

    private func allDots(_ t: Double, reduced: Bool = false) -> [(opacity: Double, rise: Double)] {
        T.Bubble.allCases.flatMap { b in (0..<3).map { T.dot(t, b, index: $0, reduced: reduced) } }
    }

    func testStartsLikeSystemLaunchScreen() {
        XCTAssertEqual(T.symbolSide, 200)
        for t in stride(from: 0.0, through: T.holdEnd, by: 0.05) {
            for d in allDots(t) { XCTAssertEqual(d.opacity, 1); XCTAssertEqual(d.rise, 0) }
            XCTAssertEqual(T.sparks(t).opacity, 0)
            XCTAssertEqual(T.orangeTap(t), 1, accuracy: 0.0001)
        }
        XCTAssertEqual(T.tagline(0).opacity, 0)
        XCTAssertEqual(T.exit(0).opacity, 1)
        // Puntitos en las posiciones de puntitos.txt.
        XCTAssertEqual(T.dotRadius, 0.02949, accuracy: 0.00001)
        XCTAssertEqual(T.whiteDotsX, [0.14744, 0.22436, 0.30128])
        XCTAssertEqual(T.orangeDotsX, [0.53205, 0.60897, 0.68590])
    }

    func testWhiteDotsTypeInTwoWaves() {
        XCTAssertEqual(T.pulseStarts(.white, index: 0), [0.15, 0.55])
        XCTAssertEqual(T.pulseStarts(.white, index: 1)[0], 0.28, accuracy: 0.0001)
        XCTAssertEqual(T.pulseStarts(.white, index: 2)[1], 0.81, accuracy: 0.0001)
        // Mitad del primer pulso del punto 0: 0,25 de opacidad y sube 0,35 radios.
        let mid = T.dot(0.15 + 0.15, .white, index: 0)
        XCTAssertEqual(mid.opacity, 0.25, accuracy: 0.0001)
        XCTAssertEqual(mid.rise, 0.35, accuracy: 0.0001)
        // Final del pulso: vuelve a lleno.
        XCTAssertEqual(T.dot(0.45, .white, index: 0).opacity, 1, accuracy: 0.0001)
        // En secuencia: en t = 0,30 el punto 0 está en su mitad y el 2 aún no empieza.
        XCTAssertLessThan(T.dot(0.30, .white, index: 0).opacity, T.dot(0.30, .white, index: 1).opacity)
        XCTAssertEqual(T.dot(0.30, .white, index: 2).opacity, 1)
        // Segunda ola del punto 1 en 0,68 + 0,15.
        XCTAssertEqual(T.dot(0.83, .white, index: 1).opacity, 0.25, accuracy: 0.0001)
        // Los naranjas siguen quietos mientras escribe la blanca.
        for t in stride(from: 0.0, through: 0.85, by: 0.05) {
            for i in 0..<3 { XCTAssertEqual(T.dot(t, .orange, index: i).opacity, 1) }
        }
    }

    func testOrangeDotsFollow() {
        XCTAssertEqual(T.pulseStarts(.orange, index: 0), [0.85, 1.25])
        XCTAssertEqual(T.dot(1.0, .orange, index: 0).opacity, 0.25, accuracy: 0.0001)
        XCTAssertEqual(T.dot(1.0, .orange, index: 0).rise, 0.35, accuracy: 0.0001)
        XCTAssertEqual(T.dot(0.98 + 0.40 + 0.15, .orange, index: 1).opacity, 0.25, accuracy: 0.0001)
        // Los blancos ya terminaron cuando la naranja va por la mitad.
        for i in 0..<3 { XCTAssertEqual(T.dot(1.2, .white, index: i).opacity, 1, accuracy: 0.0001) }
    }

    func testPum() {
        XCTAssertEqual(T.sparks(T.pumStart).opacity, 0)
        XCTAssertEqual(T.sparks(T.pumStart).scale, 0.3, accuracy: 0.0001)
        XCTAssertEqual(T.sparks(T.pumStart + 0.08).opacity, 1)
        let peak = stride(from: T.pumStart, through: T.pumEnd, by: 0.002).map { T.sparks($0).scale }.max() ?? 0
        XCTAssertEqual(peak, 1.15, accuracy: 0.001)
        XCTAssertEqual(T.sparks(T.pumEnd).scale, 1, accuracy: 0.0001)
        XCTAssertEqual(T.sparks(2.5).scale, 1, accuracy: 0.0001)
        let tapPeak = stride(from: T.pumStart, through: T.pumEnd, by: 0.002).map { T.orangeTap($0) }.max() ?? 0
        XCTAssertEqual(tapPeak, 1.04, accuracy: 0.001)
        XCTAssertEqual(T.orangeTap(T.pumEnd), 1, accuracy: 0.0001)
        XCTAssertEqual(T.orangeAnchor.x, 0.609, accuracy: 0.001)
        XCTAssertEqual(T.orangeAnchor.y, 0.340, accuracy: 0.001)
        XCTAssertEqual(T.sparksAnchor.x, 0.83, accuracy: 0.001)
        XCTAssertEqual(T.sparksAnchor.y, 0.17, accuracy: 0.001)
        XCTAssertEqual(T.soundAt, 1.65)
        XCTAssertEqual(T.hapticAt, 1.65)
    }

    func testTaglineAndExit() {
        XCTAssertEqual(T.tagline(1.79).opacity, 0)
        XCTAssertEqual(T.tagline(T.taglineStart).offset, 8, accuracy: 0.0001)
        XCTAssertEqual(T.tagline(2.15).opacity, 0.8, accuracy: 0.0001)
        XCTAssertEqual(T.tagline(2.15).offset, 0, accuracy: 0.0001)
        XCTAssertEqual(T.exit(2.35).opacity, 1)
        XCTAssertEqual(T.exit(2.65).opacity, 0)
        XCTAssertEqual(T.exit(2.65).scale, 1.04, accuracy: 0.001)
    }

    func testClockHoldsUntilReadyAndShortMode() {
        XCTAssertEqual(T.clock(elapsed: 0.5, short: false, readyAt: 0.2), 0.5)
        XCTAssertEqual(T.clock(elapsed: 2.5, short: false, readyAt: 0.2), 2.5, accuracy: 0.001)
        // Aún cargando: último cuadro.
        XCTAssertEqual(T.clock(elapsed: 3.5, short: false, readyAt: nil), T.exitStart)
        XCTAssertEqual(T.clock(elapsed: 4.1, short: false, readyAt: 4.0), T.exitStart + 0.1, accuracy: 0.001)
        // Máximo 6 s.
        XCTAssertEqual(T.clock(elapsed: 6.2, short: false, readyAt: nil), T.exitStart + 0.2, accuracy: 0.001)
        // Enlace en frío: desde 1,55 s (antes del ¡pum!) y termina en 1,1 s.
        XCTAssertEqual(T.clock(elapsed: 0, short: true, readyAt: 0), 1.55, accuracy: 0.0001)
        XCTAssertLessThan(T.clock(elapsed: 0, short: true, readyAt: 0), T.pumStart)
        XCTAssertGreaterThanOrEqual(T.clock(elapsed: 1.1, short: true, readyAt: 0), T.total - 0.001)
        // Toque: salta a la salida.
        XCTAssertEqual(T.clock(elapsed: 0.3, short: false, readyAt: 0, skip: T.exitStart - 0.3), T.exitStart, accuracy: 0.001)
    }

    func testReduceMotion() {
        // Puntos solo con opacidad.
        XCTAssertEqual(T.dot(0.30, .white, index: 0, reduced: true).opacity, 0.25, accuracy: 0.0001)
        XCTAssertEqual(T.dot(0.30, .white, index: 0, reduced: true).rise, 0)
        // Rayitas con fundido, sin escala; sin golpecito ni escalas de salida.
        XCTAssertEqual(T.sparks(T.pumStart, reduced: true).scale, 1)
        XCTAssertEqual(T.sparks(T.pumStart + 0.1, reduced: true).opacity, 0.5, accuracy: 0.0001)
        XCTAssertEqual(T.sparks(T.pumEnd, reduced: true).opacity, 1)
        XCTAssertEqual(T.orangeTap(1.75, reduced: true), 1)
        XCTAssertEqual(T.tagline(1.9, reduced: true).offset, 0)
        XCTAssertEqual(T.exit(2.5, reduced: true).scale, 1)
    }
}

/// Cierre del teclado: cuándo un toque lo cierra y qué campos llevan «Listo».
final class KeyboardPolicyTests: XCTestCase {
    func testTapOutside() {
        XCTAssertTrue(KeyboardPolicy.shouldDismissOnTap(editing: true, editorIsComposer: false, touchInTextInput: false))
        XCTAssertFalse(KeyboardPolicy.shouldDismissOnTap(editing: false, editorIsComposer: false, touchInTextInput: false))
        XCTAssertFalse(KeyboardPolicy.shouldDismissOnTap(editing: true, editorIsComposer: false, touchInTextInput: true), "tocar otro campo no cierra")
        XCTAssertFalse(KeyboardPolicy.shouldDismissOnTap(editing: true, editorIsComposer: true, touchInTextInput: false), "el chat lo maneja su lista")
    }

    func testDoneBar() {
        XCTAssertTrue(KeyboardPolicy.wantsDoneBar(isSearchField: false, isComposer: false, isEditable: true))
        XCTAssertFalse(KeyboardPolicy.wantsDoneBar(isSearchField: true, isComposer: false, isEditable: true))
        XCTAssertFalse(KeyboardPolicy.wantsDoneBar(isSearchField: false, isComposer: true, isEditable: true))
        XCTAssertEqual(KeyboardPolicy.composerId, "composer.field")
    }
}

/// Contraste AA del acento mandarina en modo claro.
final class AccentContrastTests: XCTestCase {
    func testPrimaryFillLightIsAAWithWhite() {
        XCTAssertGreaterThanOrEqual(Theme.contrastWithWhite("#C73A1A") ?? 0, 4.5)
        XCTAssertLessThan(Theme.contrastWithWhite("#FF5A36") ?? 9, 4.5, "la mandarina pura no sirve para texto blanco")
        let light = UIColor(Theme.primaryFill).resolvedColor(with: UITraitCollection(userInterfaceStyle: .light))
        let dark = UIColor(Theme.primaryFill).resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark))
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        light.getRed(&r, green: &g, blue: &b, alpha: &a)
        XCTAssertEqual(Int((r * 255).rounded()), 0xC7); XCTAssertEqual(Int((g * 255).rounded()), 0x3A)
        dark.getRed(&r, green: &g, blue: &b, alpha: &a)
        XCTAssertEqual(Int((r * 255).rounded()), 0xFF); XCTAssertEqual(Int((g * 255).rounded()), 0x5A)
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
