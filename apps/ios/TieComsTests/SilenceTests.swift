import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }

/// 1.6.4 (18), SPEC-silencio: silenciar un chat, «No molestar» y las reglas de los avisos locales.
@MainActor
final class SilenceTests: XCTestCase {
    private var savedLang = L10n.choice
    override func setUp() { savedLang = L10n.choice }
    override func tearDown() { L10n.choice = savedLang }

    private var bogota: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/Bogota")!
        return c
    }
    /// Sáb 27 sep 2026, 15:00 en Bogotá.
    private let now = ISODate.parse("2026-09-27T20:00:00Z")!

    // MARK: Estado y fechas

    func testForeverIsTheContractDate() {
        XCTAssertEqual(Silence.foreverISO, "9999-12-31T00:00:00Z")
        XCTAssertEqual(AppStore.muteUntil(.forever), Silence.forever, "«Hasta que lo reactive» del chat usa la misma fecha")
        XCTAssertEqual(Silence.wire(Silence.forever) as? String, "9999-12-31T00:00:00Z", "se manda tal cual al API")
        XCTAssertTrue(Silence.wire(nil) is NSNull, "null apaga")
        let hour = now.addingTimeInterval(3600)
        XCTAssertEqual(ISODate.parse(Silence.wire(hour) as? String), hour)
    }

    func testMuteStateFromDTO() throws {
        let forever = try dec(ConversationDTO.self, #"{"id":"a","kind":"group","mutedUntil":"9999-12-31T00:00:00Z"}"#)
        XCTAssertTrue(forever.isMuted)
        XCTAssertTrue(MentionText.mutedForever(forever))
        let week = try dec(ConversationDTO.self, #"{"id":"b","kind":"group","mutedUntil":"\#(ISODate.string(AppStore.muteUntil(.week)))"}"#)
        XCTAssertTrue(week.isMuted)
        XCTAssertFalse(MentionText.mutedForever(week), "1 semana no es «siempre»: una mención sí avisa")
        let past = try dec(ConversationDTO.self, #"{"id":"c","kind":"group","mutedUntil":"2020-01-01T00:00:00Z"}"#)
        XCTAssertFalse(past.isMuted, "una fecha vencida ya no silencia")
        XCTAssertFalse(try dec(ConversationDTO.self, #"{"id":"d","kind":"group","mutedUntil":null}"#).isMuted)
    }

    func testDndOptions() {
        XCTAssertEqual(Silence.dndUntil(.hour, now: now, calendar: bogota).timeIntervalSince(now), 3600)
        XCTAssertEqual(Silence.dndUntil(.eightHours, now: now, calendar: bogota).timeIntervalSince(now), 8 * 3600)
        let tomorrow = Silence.dndUntil(.tomorrow, now: now, calendar: bogota)
        XCTAssertEqual(ISODate.string(tomorrow), "2026-09-28T13:00:00.000Z", "mañana a las 8:00 hora local (Bogotá = UTC−5)")
        XCTAssertEqual(Silence.dndUntil(.forever, now: now), Silence.forever)
        XCTAssertEqual(DndOption.allCases.map(\.labelKey), ["mute.1h", "mute.8h", "dnd.tomorrow", "mute.forever"])
        XCTAssertTrue(Silence.isActive(now.addingTimeInterval(1), now: now))
        XCTAssertFalse(Silence.isActive(now, now: now))
        XCTAssertFalse(Silence.isActive(nil, now: now))
    }

    // MARK: «Silenciado hasta…»

    func testMutedUntilTextSpanish() {
        L10n.choice = .es
        let es = Locale(identifier: "es-CO")
        let at18 = ISODate.parse("2026-09-27T23:00:00Z")!
        let t = Silence.text(.muted, until: at18, now: now, calendar: bogota, locale: es)
        XCTAssertTrue(t.hasPrefix("Silenciado hasta las "), t)
        XCTAssertTrue(t.contains("6:00") || t.contains("18:00"), t)
        let tomorrow = Silence.text(.muted, until: Silence.dndUntil(.tomorrow, now: now, calendar: bogota), now: now, calendar: bogota, locale: es)
        XCTAssertTrue(tomorrow.hasPrefix("Silenciado hasta mañana a las "), tomorrow)
        XCTAssertTrue(tomorrow.contains("8:00"), tomorrow)
        let week = Silence.text(.muted, until: now.addingTimeInterval(7 * 86400), now: now, calendar: bogota, locale: es)
        XCTAssertTrue(week.hasPrefix("Silenciado hasta el "), week)
        XCTAssertTrue(week.contains("4") && week.lowercased().contains("oct"), "fecha con día y mes: \(week)")
        XCTAssertEqual(Silence.text(.muted, until: Silence.forever, now: now), "Silenciado")
        XCTAssertEqual(Silence.text(.dndStatus, until: Silence.forever, now: now), "Activo")
        XCTAssertTrue(Silence.text(.dndStatus, until: at18, now: now, calendar: bogota, locale: es).hasPrefix("Activo hasta las "))
        XCTAssertTrue(Silence.text(.dndBanner, until: at18, now: now, calendar: bogota, locale: es).hasPrefix("No molestar hasta las "))
        XCTAssertEqual(L("dnd.title"), "No molestar")
        XCTAssertEqual(L("dnd.tomorrow"), "Hasta mañana")
        XCTAssertEqual(L("dnd.off"), "Reactivar")
        XCTAssertEqual(L("mute.forever"), "Hasta que lo reactive")
        XCTAssertEqual(L("menu.unmute"), "Reactivar notificaciones")
    }

    func testMutedUntilTextEnglish() {
        L10n.choice = .en
        let en = Locale(identifier: "en-US")
        let at18 = ISODate.parse("2026-09-27T23:00:00Z")!
        XCTAssertEqual(Silence.text(.muted, until: at18, now: now, calendar: bogota, locale: en), "Muted until 6:00\u{202F}PM")
        XCTAssertEqual(Silence.text(.dndBanner, until: at18, now: now, calendar: bogota, locale: en), "Do not disturb until 6:00\u{202F}PM")
        XCTAssertEqual(Silence.text(.dndStatus, until: Silence.dndUntil(.tomorrow, now: now, calendar: bogota), now: now, calendar: bogota, locale: en),
                       "On until tomorrow at 8:00\u{202F}AM")
        XCTAssertEqual(Silence.text(.muted, until: Silence.forever, now: now), "Muted")
        XCTAssertEqual(L("dnd.title"), "Do not disturb")
        XCTAssertEqual(L("dnd.tomorrow"), "Until tomorrow")
        XCTAssertEqual(L("dnd.off"), "Turn off")
        XCTAssertEqual(L("mute.forever"), "Until I turn it back on")
    }

    // MARK: Reglas de avisos locales

    func testNotifyRules() {
        typealias I = NotifyRule.Input
        XCTAssertEqual(NotifyRule.incoming(I()), .notify, "chat normal, no abierto → notificación")
        XCTAssertEqual(NotifyRule.incoming(I(openAndActive: true)), .sound, "chat abierto → solo el sonido corto")
        XCTAssertEqual(NotifyRule.incoming(I(mine: true)), .none, "mis mensajes nunca")
        XCTAssertEqual(NotifyRule.incoming(I(system: true)), .none, "los de sistema nunca")
        XCTAssertEqual(NotifyRule.incoming(I(blocked: true)), .none)
        XCTAssertEqual(NotifyRule.incoming(I(muted: true)), .none, "silenciado: ni aviso")
        XCTAssertEqual(NotifyRule.incoming(I(openAndActive: true, muted: true)), .none, "silenciado: ni sonido con el chat abierto")
        XCTAssertEqual(NotifyRule.incoming(I(muted: true, mentionsMe: true)), .mention, "la mención sí avisa aunque esté silenciado")
        XCTAssertEqual(NotifyRule.incoming(I(openAndActive: true, muted: true, mentionsMe: true)), .sound)
        XCTAssertEqual(NotifyRule.incoming(I(muted: true, mutedForever: true, mentionsMe: true)), .none, "«hasta que lo reactive»: tampoco la mención (como el servidor)")
        XCTAssertEqual(NotifyRule.incoming(I(mentionsMe: true)), .mention)
        XCTAssertEqual(NotifyRule.incoming(I(dnd: true)), .none, "«No molestar»: nada")
        XCTAssertEqual(NotifyRule.incoming(I(mentionsMe: true, dnd: true)), .none, "«No molestar»: ni las menciones")
        XCTAssertEqual(NotifyRule.incoming(I(openAndActive: true, dnd: true)), .none, "«No molestar»: ni el sonido del chat abierto")
        XCTAssertTrue(NotifyRule.accountAlert(dnd: false))
        XCTAssertFalse(NotifyRule.accountAlert(dnd: true), "recordatorios y reuniones: nada con «No molestar»")
        XCTAssertFalse(NotifyRule.accountAlert(dnd: false, muted: true, respectsMute: true), "reunión nueva en un chat silenciado")
        XCTAssertTrue(NotifyRule.accountAlert(dnd: false, muted: true, respectsMute: false), "el aviso de 10 min ignora el silencio del chat")
        XCTAssertFalse(NotifyRule.presentsInForeground(dnd: true))
        XCTAssertTrue(NotifyRule.presentsInForeground(dnd: false))
    }

    // MARK: Store: bootstrap, evento me.dnd y avisos

    private func boot(dnd: String? = nil) throws -> BootstrapDTO {
        let dndField = dnd.map { #","dndUntil":"\#($0)""# } ?? ""
        return try dec(BootstrapDTO.self, #"""
        {"contract":"x","serverTime":"","me":{"id":"me-silence","name":"Ana","kind":"human","primaryOrgId":"o1"\#(dndField)},"organizations":[],
         "workspaces":[{"id":"w1","name":"Obra","owningOrgId":"o1","organizationIds":["o1"],"memberIds":["me-silence","bob"],"myRole":"lead","createdAt":""}],
         "conversations":[{"id":"c1","workspaceId":"w1","kind":"group","name":"General","memberIds":["me-silence","bob"],"lastMessageSeq":0,"lastEventSeq":0,"canPost":true},
                          {"id":"c2","workspaceId":"w1","kind":"group","name":"Silenciada","memberIds":["me-silence","bob"],"lastMessageSeq":0,"lastEventSeq":0,"canPost":true,"mutedUntil":"\#(ISODate.string(Date().addingTimeInterval(3600)))"}],
         "people":[{"id":"me-silence","name":"Ana","kind":"human","orgId":"o1"},{"id":"bob","name":"Bob","kind":"human","orgId":"o1"}]}
        """#)
    }

    private func store(_ d: BootstrapDTO, spy: FeedbackSpy, session: URLSession? = nil) -> AppStore {
        Prefs.setLocalDndUntil(nil, userId: "me-silence")
        let s = AppStore(baseURL: URL(string: "https://mock.chaggu.test")!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()),
                         feedback: spy, session: session)
        s.seedForTesting(d)
        return s
    }

    private func message(_ conv: String, seq: Int, mention: Bool = false) -> ConversationEvent {
        let m = mention ? #","mentions":[{"userId":"me-silence","start":5,"length":4}]"# : ""
        return try! dec(ConversationEvent.self, #"{"type":"message.created","conversationId":"\#(conv)","eventSeq":\#(seq),"message":{"id":"n\#(conv)\#(seq)","conversationId":"\#(conv)","seq":\#(seq),"authorId":"bob","body":"hola @Ana","createdAt":"2026-09-27T10:00:00Z"\#(m)}}"#)
    }

    func testBootstrapDndDecodes() throws {
        let spy = FeedbackSpy()
        XCTAssertNil(try boot().me.dndUntil, "servidor viejo: sin campo = apagado")
        let on = store(try boot(dnd: ISODate.string(Date().addingTimeInterval(3600))), spy: spy)
        XCTAssertTrue(on.dndActive)
        let past = store(try boot(dnd: "2020-01-01T00:00:00Z"), spy: spy)
        XCTAssertFalse(past.dndActive, "una fecha vencida no cuenta")
        XCTAssertEqual(try dec(AccountEvent.self, #"{"type":"me.dnd","dndUntil":"9999-12-31T00:00:00Z"}"#), .dndChanged(until: "9999-12-31T00:00:00Z"))
        XCTAssertEqual(try dec(AccountEvent.self, #"{"type":"me.dnd","dndUntil":null}"#), .dndChanged(until: nil))
    }

    func testDndEventSilencesEverythingAndTurnsBackOn() throws {
        let spy = FeedbackSpy()
        let s = store(try boot(), spy: spy)
        // El chat abierto suena (en vez de avisar) solo si sus mensajes están cargados (incidencia 502, 28-sep-2026).
        s.seedForTesting(try boot(), conversations: ["c1": ConversationState(loaded: true)])
        s.onConversationEvent(message("c1", seq: 1), live: true)
        XCTAssertEqual(spy.notifications.count, 1, "sin «No molestar» avisa")

        s.socketEventForTesting("account.event", #"{"type":"me.dnd","dndUntil":"9999-12-31T00:00:00Z"}"#)
        XCTAssertTrue(s.dndActive, "el evento me.dnd de otra sesión lo enciende")
        s.onConversationEvent(message("c1", seq: 2), live: true)
        s.onConversationEvent(message("c2", seq: 1, mention: true), live: true)
        s.openConversationId = "c1"
        s.onConversationEvent(message("c1", seq: 3), live: true)
        s.socketEventForTesting("account.event", #"{"type":"reminder.due","reminder":{"id":"r1","conversationId":"c1","remindAt":"2026-09-27T12:00:00Z"}}"#)
        XCTAssertEqual(spy.notifications.count, 1, "con «No molestar» nada notifica (ni menciones ni recordatorios)")
        XCTAssertEqual(spy.receives, 0, "ni suena en el chat abierto")
        XCTAssertEqual(s.meta("c1")?.unread, 3, "pero todo queda sin leer")

        s.socketEventForTesting("me.dnd", #"{"dndUntil":null}"#)
        XCTAssertFalse(s.dndActive, "también se entiende como evento propio del socket")
        s.onConversationEvent(message("c1", seq: 4), live: true)
        XCTAssertEqual(spy.receives, 1, "al apagarlo vuelve el sonido")
    }

    func testMutedChatRespectsMentionInForeground() throws {
        let spy = FeedbackSpy()
        let s = store(try boot(), spy: spy)
        s.onConversationEvent(message("c2", seq: 1), live: true)
        XCTAssertTrue(spy.notifications.isEmpty, "silenciado: sin aviso")
        s.onConversationEvent(message("c2", seq: 2, mention: true), live: true)
        XCTAssertEqual(spy.notifications.count, 1, "la mención sí avisa")
        s.openConversationId = "c2"
        s.onConversationEvent(message("c2", seq: 3), live: true)
        XCTAssertEqual(spy.receives, 0, "silenciado y abierto: sin sonido")
        s.patchMeta("c2") { $0.mutedUntil = Silence.foreverISO }
        s.openConversationId = nil
        s.onConversationEvent(message("c2", seq: 4, mention: true), live: true)
        XCTAssertEqual(spy.notifications.count, 1, "«hasta que lo reactive»: la mención tampoco avisa")
    }

    func testSetDndSendsContractAndFallsBackOn404() async throws {
        MockURLProtocol.routes = [:]
        MockURLProtocol.requests = []
        MockURLProtocol.httpRequests = []
        let spy = FeedbackSpy()
        let s = store(try boot(), spy: spy, session: MockURLProtocol.session())

        MockURLProtocol.routes["/api/v1/me/dnd"] = (200, #"{"dndUntil":"9999-12-31T00:00:00.000Z"}"#)
        await s.setDoNotDisturb(until: Silence.forever)
        let put = try XCTUnwrap(MockURLProtocol.httpRequests.last { $0.url?.path == "/api/v1/me/dnd" })
        XCTAssertEqual(put.httpMethod, "PUT")
        XCTAssertEqual(MockURLProtocol.requests.last { $0.path == "/api/v1/me/dnd" }?.body["until"] as? String, "9999-12-31T00:00:00Z")
        XCTAssertTrue(s.dndActive)
        XCTAssertFalse(s.dndLocalOnly)

        MockURLProtocol.routes["/api/v1/me/dnd"] = (200, #"{"dndUntil":null}"#)
        await s.setDoNotDisturb(until: nil)
        XCTAssertTrue(MockURLProtocol.requests.last { $0.path == "/api/v1/me/dnd" }?.body["until"] is NSNull, "apagar manda null")
        XCTAssertFalse(s.dndActive)

        // Servidor viejo: 404 → queda en el dispositivo, sin error y sin romperse.
        MockURLProtocol.routes["/api/v1/me/dnd"] = nil
        let hour = Silence.dndUntil(.hour)
        await s.setDoNotDisturb(until: hour)
        XCTAssertTrue(s.dndActive, "404: se guarda solo en el dispositivo")
        XCTAssertTrue(s.dndLocalOnly)
        XCTAssertEqual(Prefs.localDndUntil(userId: "me-silence").map { Int($0.timeIntervalSince1970) }, Int(hour.timeIntervalSince1970))
        XCTAssertEqual(s.toast, L("toast.dndOn"), "aviso discreto, no un error")
        s.onConversationEvent(message("c1", seq: 1), live: true)
        XCTAssertTrue(spy.notifications.isEmpty, "el modo local también apaga los avisos")

        // Un nuevo bootstrap sin el campo conserva lo local.
        s.seedForTesting(try boot())
        s.loadLocalDnd()
        XCTAssertTrue(s.dndActive)

        await s.setDoNotDisturb(until: nil)
        XCTAssertFalse(s.dndActive)
        XCTAssertNil(Prefs.localDndUntil(userId: "me-silence"))
    }
}
