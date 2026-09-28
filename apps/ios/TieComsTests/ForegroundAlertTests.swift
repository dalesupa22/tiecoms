import XCTest
@testable import TieComs

/// Incidencia Alicia → Danny (28-sep-2026): avisos perdidos en primer plano y chat roto tras un 502.
/// Un push remoto ya no se calla por «socket en línea»: solo si ese messageId ya se anunció.
@MainActor
final class ForegroundAlertTests: XCTestCase {
    var store: AppStore!
    var spy: FeedbackSpy!

    private let bootstrapJSON = #"""
    {"contract":"2026-09-23","serverTime":"2026-09-23T10:00:00Z","me":{"id":"me","name":"Danny","kind":"human","primaryOrgId":"o1"},
     "organizations":[{"id":"o1","name":"A","mark":"A","colorBg":"#000000","colorFg":"#ffffff","myRole":"owner"}],
     "workspaces":[{"id":"w1","name":"Obra","owningOrgId":"o1","organizationIds":["o1"],"memberIds":["me","ali"],"myRole":"lead","createdAt":"2026-09-01T00:00:00Z"}],
     "conversations":[
       {"id":"dm","workspaceId":"w1","kind":"direct","memberIds":["me","ali"],"lastMessageSeq":2,"lastEventSeq":5,"lastReadSeq":2,"unread":0,"canPost":true,"historyFromSeq":0,"lastMessageAt":"2026-09-23T09:00:00Z"},
       {"id":"muted","workspaceId":"w1","kind":"group","name":"Silenciado","memberIds":["me","ali"],"lastMessageSeq":0,"lastEventSeq":0,"lastReadSeq":0,"unread":0,"canPost":true,"historyFromSeq":0}
     ],
     "people":[{"id":"me","name":"Danny","kind":"human","orgId":"o1","guest":false},{"id":"ali","name":"Alicia","kind":"human","orgId":"o1","guest":false}]}
    """#

    override func setUp() async throws {
        spy = FeedbackSpy()
        // Puerto cerrado: un catch-up falla rápido sin tocar ningún servidor.
        store = AppStore(baseURL: URL(string: "http://127.0.0.1:9")!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: spy)
        let d = try JSONDecoder().decode(BootstrapDTO.self, from: jsonData(bootstrapJSON))
        store.seedForTesting(d, conversations: ["dm": ConversationState(messages: [], lastEventSeq: 5, hasMore: false, loaded: true)])
        store.openConversationId = nil
        // Silenciado 1 h (no «hasta que lo reactive»): una mención sí avisa.
        store.patchMeta("muted") { $0.mutedUntil = ISODate.string(Date().addingTimeInterval(3600)) }
    }

    private func created(_ conv: String, _ eventSeq: Int, seq: Int, author: String = "ali") -> ConversationEvent {
        let json = #"{"type":"message.created","conversationId":"\#(conv)","eventSeq":\#(eventSeq),"message":{"id":"m-\#(conv)-\#(seq)","conversationId":"\#(conv)","seq":\#(seq),"authorId":"\#(author)","kind":"text","body":"hola","createdAt":"2026-09-28T15:09:32.949Z"}}"#
        return try! JSONDecoder().decode(ConversationEvent.self, from: jsonData(json))
    }

    private func push(_ conv: String, seq: Int, type: String = "message", author: String = "ali") -> PushPayload {
        PushPayload(userInfo: ["type": type, "conversationId": conv, "messageId": "m-\(conv)-\(seq)", "authorId": author,
                               "aps": ["alert": ["title": "Alicia", "body": "hola"]]])!
    }

    // MARK: Registro acotado

    func testLedgerIsBoundedAndFirstDecisionWins() {
        var l = AnnouncedLedger(capacity: 3)
        XCTAssertTrue(l.record("a", .notify))
        XCTAssertFalse(l.record("a", .none), "la primera decisión manda")
        XCTAssertEqual(l.decision("a"), .notify)
        l.record("b", .none); l.record("c", .sound)
        l.record("a", .notify) // uso reciente: «a» pasa al final
        l.record("d", .mention)
        XCTAssertEqual(l.count, 3)
        XCTAssertFalse(l.contains("b"), "se expulsa el menos reciente")
        XCTAssertTrue(l.contains("a") && l.contains("c") && l.contains("d"))
        XCTAssertEqual(AnnouncedLedger().capacity, 300)
        XCTAssertEqual(store.announced.capacity, 300)
    }

    // MARK: Decisión pura

    func testPureDecision() {
        typealias I = ForegroundPush.Input
        XCTAssertEqual(ForegroundPush.decide(I()).present, true, "sin aviso previo se muestra")
        XCTAssertEqual(ForegroundPush.decide(I()).outcome, .notify)
        XCTAssertEqual(ForegroundPush.decide(I(alreadyAnnounced: true)).present, false)
        XCTAssertNil(ForegroundPush.decide(I(alreadyAnnounced: true)).outcome, "ya decidido: no se vuelve a registrar")
        XCTAssertEqual(ForegroundPush.decide(I(dnd: true)).present, false)
        XCTAssertEqual(ForegroundPush.decide(I(dnd: true, mentionsMe: true)).present, false, "No molestar apaga también las menciones")
        XCTAssertEqual(ForegroundPush.decide(I(openActiveLoaded: true)).present, false)
        XCTAssertEqual(ForegroundPush.decide(I(muted: true)).present, false)
        XCTAssertEqual(ForegroundPush.decide(I(muted: true, mentionsMe: true)).outcome, .mention)
        XCTAssertEqual(ForegroundPush.decide(I(muted: true, mutedForever: true, mentionsMe: true)).present, false)
        XCTAssertEqual(ForegroundPush.decide(I(blocked: true)).present, false)
        XCTAssertEqual(ForegroundPush.decide(I(mine: true)).present, false)
        XCTAssertTrue(ForegroundPush.isMessage(.message) && ForegroundPush.isMessage(.mention) && ForegroundPush.isMessage(.side))
        XCTAssertFalse(ForegroundPush.isMessage(.reaction) || ForegroundPush.isMessage(.reminder) || ForegroundPush.isMessage(.event) || ForegroundPush.isMessage(.issue))
    }

    // MARK: Store: push + aviso local

    func testPushWithoutLocalNoticeShowsOnce() {
        let p = push("dm", seq: 3)
        XCTAssertTrue(store.presentsForegroundPush(p), "APNs en primer plano sin aviso local previo: se muestra")
        XCTAssertFalse(store.presentsForegroundPush(p), "el mismo push otra vez: no se repite")
    }

    func testLocalThenPushIsOneNotice() {
        store.onConversationEvent(created("dm", 6, seq: 3), live: true)
        XCTAssertEqual(spy.notifications.count, 1, "aviso local")
        XCTAssertEqual(store.announced.decision("m-dm-3"), .notify)
        XCTAssertFalse(store.presentsForegroundPush(push("dm", seq: 3)), "el push del mismo mensaje no duplica")
    }

    func testPushThenLocalIsOneNotice() {
        XCTAssertTrue(store.presentsForegroundPush(push("dm", seq: 3)))
        store.onConversationEvent(created("dm", 6, seq: 3), live: true)
        XCTAssertTrue(spy.notifications.isEmpty, "el socket llegó después: no hay segundo aviso")
        XCTAssertEqual(spy.receives, 0)
        XCTAssertEqual(store.conversations["dm"]?.messages.count, 1, "el mensaje sí se aplica")
    }

    func testOpenLoadedConversationShowsNothing() {
        store.openConversationId = "dm"
        XCTAssertEqual(store.visibleConversationId, "dm")
        XCTAssertFalse(store.presentsForegroundPush(push("dm", seq: 3)))
    }

    func testOpenButNotLoadedAfter502Shows() {
        // La vista marcó el chat abierto antes del GET, y el GET respondió 502.
        store.seedForTesting(store.data!, conversations: ["dm": ConversationState(loaded: false, error: "chaggu se está actualizando")])
        store.openConversationId = "dm"
        XCTAssertNil(store.visibleConversationId, "una pantalla vacía no cuenta como vista")
        XCTAssertTrue(store.presentsForegroundPush(push("dm", seq: 3)))
        // Y el aviso local tampoco se calla (antes era solo tc_receive).
        store.onConversationEvent(created("dm", 6, seq: 4), live: true)
        XCTAssertEqual(spy.notifications.map(\.conversationId), ["dm"])
        XCTAssertEqual(spy.receives, 0)
    }

    func testMutedWithoutMentionNothingWithMentionShows() {
        XCTAssertEqual(store.meta("muted")?.isMuted, true)
        XCTAssertFalse(store.presentsForegroundPush(push("muted", seq: 1)))
        XCTAssertTrue(store.presentsForegroundPush(push("muted", seq: 2, type: "mention")))
        store.patchMeta("muted") { $0.mutedUntil = Silence.foreverISO }
        XCTAssertFalse(store.presentsForegroundPush(push("muted", seq: 3, type: "mention")), "«hasta que lo reactive»: ni la mención")
    }

    func testDoNotDisturbShowsNothing() {
        store.patchMe { $0.dndUntil = "2099-01-01T00:00:00Z" }
        XCTAssertTrue(store.dndActive)
        XCTAssertFalse(store.presentsForegroundPush(push("dm", seq: 3)))
        XCTAssertFalse(store.presentsForegroundPush(push("dm", seq: 4, type: "mention")))
    }

    func testGapThenPushShows() {
        // Hueco: el socket trae seq 9 con el cursor en 5; no se aplica ni se anuncia (va por catch-up).
        store.onConversationEvent(created("dm", 9, seq: 3), live: true)
        XCTAssertTrue(spy.notifications.isEmpty)
        XCTAssertTrue(store.presentsForegroundPush(push("dm", seq: 3)), "el push del mensaje del hueco se muestra")
    }

    func testCatchUpThenPushShows() {
        // El catch-up (tras reconectar) aplica sin anunciar.
        store.onConversationEvent(created("dm", 6, seq: 3), live: false)
        XCTAssertTrue(spy.notifications.isEmpty)
        XCTAssertEqual(store.conversations["dm"]?.messages.count, 1)
        XCTAssertTrue(store.presentsForegroundPush(push("dm", seq: 3)))
    }

    func testUnknownConversationPushShows() {
        // Conversación que aún no está en el snapshot: el socket solo pide bootstrap y no avisa.
        store.onConversationEvent(created("nueva", 1, seq: 1), live: true)
        XCTAssertTrue(spy.notifications.isEmpty)
        XCTAssertTrue(store.presentsForegroundPush(push("nueva", seq: 1)))
    }

    func testSignOutClearsLedger() async {
        store.onConversationEvent(created("dm", 6, seq: 3), live: true)
        XCTAssertEqual(store.announced.count, 1)
        await store.signOutLocally()
        XCTAssertEqual(store.announced.count, 0)
    }
}
