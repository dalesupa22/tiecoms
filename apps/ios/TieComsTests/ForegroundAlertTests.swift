import XCTest
import UserNotifications
@testable import TieComs

/// Incidencia Alicia → Danny (28-sep-2026): avisos perdidos en primer plano y chat roto tras un 502.
/// Un push remoto ya no se calla por «socket en línea»: solo si ese messageId ya se anunció.
@MainActor
final class ForegroundAlertTests: XCTestCase {
    var store: AppStore!
    var spy: FeedbackSpy!
    var center: DeferredNotificationCenter!
    var appFeedback: AppFeedback!
    var fallbackSounds = 0
    var savedSounds = true
    var savedNotifications = true

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
        savedSounds = Prefs.soundsEnabled; savedNotifications = Prefs.notificationsEnabled
        Prefs.soundsEnabled = true; Prefs.notificationsEnabled = true
        spy = FeedbackSpy()
        center = DeferredNotificationCenter()
        appFeedback = AppFeedback(localCenter: center, playNotificationSound: { [weak self] in self?.fallbackSounds += 1 })
        await appFeedback.refreshAuthorization()
        spy.messageHandler = { [weak self] m, t, a, b in self?.appFeedback.notifyMessage(m, title: t, author: a, body: b) }
        spy.cancelMessages = { [weak self] in self?.appFeedback.cancelPendingMessages() }
        // Puerto cerrado: un catch-up falla rápido sin tocar ningún servidor.
        store = AppStore(baseURL: URL(string: "http://127.0.0.1:9")!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: spy)
        let d = try JSONDecoder().decode(BootstrapDTO.self, from: jsonData(bootstrapJSON))
        store.seedForTesting(d, conversations: ["dm": ConversationState(messages: [], lastEventSeq: 5, hasMore: false, loaded: true)])
        appFeedback.foregroundSession = { [weak self] in
            guard let store = self?.store, store.appActive, store.me != nil else { return nil }
            return store.foregroundOwner
        }
        appFeedback.presentsMessage = { [weak self] p, owner, played in self?.store.presentsForegroundPush(p, localOwner: owner, soundAlreadyPlayed: played) ?? false }
        store.openConversationId = nil
        // Silenciado 1 h (no «hasta que lo reactive»): una mención sí avisa.
        store.patchMeta("muted") { $0.mutedUntil = ISODate.string(Date().addingTimeInterval(3600)) }
    }

    override func tearDown() async throws {
        await store.signOutLocally()
        Prefs.soundsEnabled = savedSounds; Prefs.notificationsEnabled = savedNotifications
        appFeedback = nil; center = nil; spy = nil; store = nil
    }

    private func presentLocal(_ index: Int = 0) -> UNNotificationPresentationOptions {
        appFeedback.presentationOptions(userInfo: center.requests[index].content.userInfo, isRemote: false)
    }
    private func presentRemote(_ seq: Int = 3) -> UNNotificationPresentationOptions {
        appFeedback.presentationOptions(userInfo: ["type": "message", "conversationId": "dm", "messageId": "m-dm-\(seq)", "authorId": "ali"], isRemote: true)
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
        XCTAssertNil(store.announced.decision("m-dm-3"), "enqueue no admite")
        XCTAssertTrue(presentLocal().contains(.banner))
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

    func testLoadedChatWithoutThatMessageStillPresentsFallback() {
        store.openConversationId = "dm"
        XCTAssertEqual(store.visibleConversationId, "dm")
        XCTAssertTrue(presentRemote().contains(.banner))
        store.onConversationEvent(created("dm", 6, seq: 3), live: true)
        XCTAssertEqual(spy.receives, 0, "ya se admitió banner para este id")
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
        XCTAssertTrue(presentLocal().contains(.banner))
        XCTAssertEqual(store.announced.count, 1)
        await store.signOutLocally()
        XCTAssertEqual(store.announced.count, 0)
    }
    func testRemoteWinsWhileLocalQueueIsDeferred() {
        store.onConversationEvent(created("dm", 6, seq: 3), live: true)
        XCTAssertEqual(center.requests.count, 1)
        XCTAssertNil(store.announced.decision("m-dm-3"))
        XCTAssertTrue(presentRemote().contains(.banner))
        XCTAssertTrue(presentLocal().isEmpty)
        XCTAssertTrue(presentRemote().isEmpty)
    }

    func testDeniedAuthorizationCacheDoesNotConsumeRemoteAndAudioIsSeparate() async {
        center.authorized = false
        await appFeedback.refreshAuthorization()
        store.onConversationEvent(created("dm", 6, seq: 3), live: true)
        XCTAssertTrue(center.requests.isEmpty)
        XCTAssertEqual(fallbackSounds, 1)
        XCTAssertNil(store.announced.decision("m-dm-3"))
        center.authorized = true
        await appFeedback.refreshAuthorization()
        let options = presentRemote()
        XCTAssertTrue(options.contains(.banner))
        XCTAssertFalse(options.contains(.sound), "el audio fallback ya sonó; banner sigue elegible")
    }

    func testFallbackAudioThenOpeningAppliedMessageDoesNotPlayReceiveAgain() async {
        center.authorized = false
        await appFeedback.refreshAuthorization()
        store.onConversationEvent(created("dm", 6, seq: 3), live: true)
        XCTAssertEqual(fallbackSounds, 1)
        store.openConversationId = "dm"
        XCTAssertTrue(presentRemote().isEmpty)
        XCTAssertEqual(spy.receives, 0)
    }

    func testAddFailureDoesNotConsumeRemote() {
        center.accepts = false
        store.onConversationEvent(created("dm", 6, seq: 3), live: true)
        XCTAssertTrue(center.pending.isEmpty)
        XCTAssertNil(store.announced.decision("m-dm-3"))
        XCTAssertTrue(presentRemote().contains(.banner))
    }

    func testAbsentFeedbackDoesNotConsumeRemote() {
        let noSink = AppStore(baseURL: URL(string: "http://127.0.0.1:9")!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: nil)
        noSink.seedForTesting(store.data!, conversations: store.conversations)
        noSink.onConversationEvent(created("dm", 6, seq: 3), live: true)
        XCTAssertNil(noSink.announced.decision("m-dm-3"))
        XCTAssertTrue(noSink.presentsForegroundPush(push("dm", seq: 3)))
    }

    func testLocalPresentationDisabledThenRemoteEligible() {
        store.onConversationEvent(created("dm", 6, seq: 3), live: true)
        Prefs.notificationsEnabled = false
        XCTAssertTrue(presentLocal().isEmpty)
        XCTAssertNil(store.announced.decision("m-dm-3"))
        Prefs.notificationsEnabled = true
        XCTAssertTrue(presentRemote().contains(.banner))
    }

    func testIntentionalSilenceAtLocalPresentationStaysSilent() {
        store.onConversationEvent(created("dm", 6, seq: 3), live: true)
        store.patchMe { $0.dndUntil = "2099-01-01T00:00:00Z" }
        XCTAssertTrue(presentLocal().isEmpty)
        XCTAssertEqual(store.announced.decision("m-dm-3"), NotifyRule.Outcome.none)
        store.patchMe { $0.dndUntil = nil }
        XCTAssertTrue(presentRemote().isEmpty)
    }

    func testReceiveOnceForAppliedMessageInBothOrdersAndSoundSettings() {
        for enabled in [true, false] {
            Prefs.soundsEnabled = enabled
            for remoteFirst in [true, false] {
                store.announced.removeAll()
                store.seedForTesting(store.data!, conversations: ["dm": ConversationState(lastEventSeq: 5, loaded: true)])
                spy.receives = 0
                store.openConversationId = "dm"
                store.onConversationEvent(created("dm", 6, seq: 3), live: !remoteFirst)
                XCTAssertTrue(presentRemote().isEmpty)
                store.onConversationEvent(created("dm", 6, seq: 3), live: true)
                XCTAssertTrue(presentRemote().isEmpty)
                XCTAssertEqual(spy.receives, enabled ? 1 : 0)
            }
        }
    }

    func testLoadedMissingMessageDoesNotBecomeVisibleOnMereLoadFlag() {
        store.openConversationId = "dm"
        store.onConversationEvent(created("dm", 9, seq: 3), live: true)
        XCTAssertTrue(store.conversations["dm"]!.messages.isEmpty)
        XCTAssertTrue(presentRemote().contains(.banner))
        XCTAssertEqual(spy.receives, 0)
    }

    func testOldLocalCallbackAfterSameUserLogsInAgainDoesNotConsumeNewSession() async {
        let data = store.data!
        store.onConversationEvent(created("dm", 6, seq: 3), live: true)
        let oldOwner = store.foregroundOwner
        await store.signOutLocally()
        store.seedForTesting(data)
        XCTAssertNotEqual(store.foregroundOwner, oldOwner)
        XCTAssertTrue(presentLocal().isEmpty)
        XCTAssertTrue(presentRemote().contains(.banner))
        XCTAssertFalse(center.removed.isEmpty)
    }

    func testBackgroundCancelsPendingIncludingLateAddCompletion() {
        center.deferCompletion = true
        store.onConversationEvent(created("dm", 6, seq: 3), live: true)
        store.appActive = false
        center.finish(0)
        XCTAssertTrue(center.pending.isEmpty)
        XCTAssertTrue(presentLocal().isEmpty)
        XCTAssertNil(store.announced.decision("m-dm-3"))
        store.onConversationEvent(created("dm", 7, seq: 4), live: true)
        XCTAssertEqual(center.requests.count, 1, "no enqueue en background")
    }

    func testSleepWindowSilencesMessageAndMention() throws {
        let minute = SleepRules.minutesIn("UTC", at: Date())
        let start = String(format: "%02d:%02d", (minute + 1439) % 1440 / 60, (minute + 1439) % 60)
        let end = String(format: "%02d:%02d", (minute + 30) % 1440 / 60, (minute + 30) % 60)
        let sleep = try JSONDecoder().decode(SleepDTO.self, from: jsonData(#"{"on":true,"start":"\#(start)","end":"\#(end)","tz":"UTC","tzAuto":false}"#))
        store.patchMe { $0.sleep = sleep }
        XCTAssertTrue(store.sleepActive)
        store.onConversationEvent(created("dm", 6, seq: 3), live: true)
        XCTAssertTrue(center.requests.isEmpty)
        XCTAssertTrue(presentRemote().isEmpty)
        XCTAssertFalse(store.presentsForegroundPush(push("dm", seq: 4, type: "mention")))
        XCTAssertEqual(spy.receives, 0)
    }

}


@MainActor
final class DeferredNotificationCenter: LocalNotificationCenter {
    var authorized = true
    var accepts = true
    var deferCompletion = false
    var requests: [UNNotificationRequest] = []
    var completions: [@MainActor (Bool) -> Void] = []
    var pending: Set<String> = []
    var removed: [String] = []
    func isAuthorized() async -> Bool { authorized }
    func add(_ request: UNNotificationRequest, completion: @escaping @MainActor (Bool) -> Void) {
        requests.append(request); completions.append(completion)
        if !deferCompletion { finish(requests.count - 1) }
    }
    func finish(_ index: Int) {
        if accepts { pending.insert(requests[index].identifier) }
        completions[index](accepts)
    }
    func removePending(_ identifiers: [String]) {
        removed += identifiers
        for id in identifiers { pending.remove(id) }
    }
}
