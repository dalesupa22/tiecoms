import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }

private func wa(_ jid: String, place: String? = "dms", pinned: String? = nil, unread: Int = 0, at: String = "2026-10-01T10:00:00.000Z",
                group: Bool = false, status: String? = nil, hidden: Bool = false) -> String {
    let p = place.map { "\"\($0)\"" } ?? "null"
    let pin = pinned.map { "\"\($0)\"" } ?? "null"
    let st = status.map { ",\"accountStatus\":\"\($0)\"" } ?? ""
    return #"{"accountId":"acc1","accountLabel":"Personal","jid":"\#(jid)","name":"Chat \#(jid)","isGroup":\#(group),"unread":\#(unread),"lastMessageAt":"\#(at)","inboxPlace":\#(p),"inboxPinnedAt":\#(pin),"hidden":\#(hidden)\#(st)}"#
}

/// WhatsApp en la bandeja y gg dentro del chat (docs/CONTRATO-GG-CHAT-WA-INBOX.md, 1-oct-2026).
@MainActor
final class WaInboxGgTests: XCTestCase {
    func testWaChatInboxFieldsAndBootstrapAreOptional() throws {
        let c = try dec(WaChatDTO.self, wa("57300@s.whatsapp.net", place: "groups", pinned: "2026-10-01T09:00:00.000Z", status: "logged_out"))
        XCTAssertEqual(c.inboxPlace, "groups")
        XCTAssertNotNil(c.inboxPinnedAt)
        XCTAssertTrue(c.isDisconnected)
        XCTAssertEqual(c.inboxKey, "wa:acc1:57300@s.whatsapp.net")
        // Un servidor anterior no manda los campos: no está en la bandeja y no sale como desconectado.
        let old = try dec(WaChatDTO.self, #"{"accountId":"acc1","jid":"x@g.us","name":"X","isGroup":true}"#)
        XCTAssertNil(old.inboxPlace); XCTAssertFalse(old.isDisconnected); XCTAssertEqual(old.suggestedPlace, "groups")
        XCTAssertNil(try dec(WaChatDTO.self, #"{"accountId":"a","jid":"j","inboxPlace":"rara"}"#).inboxPlace, "valor desconocido = fuera de la bandeja")
        XCTAssertNil(try dec(BootstrapDTO.self, #"{"me":{"id":"a","name":"A"}}"#).waInbox, "app vieja / servidor viejo")
        let b = try dec(BootstrapDTO.self, #"{"me":{"id":"a","name":"A"},"waInbox":[\#(wa("1")),{"bad":true}]}"#)
        XCTAssertEqual(b.waInbox?.count, 1)
    }

    func testAccountEventWaInbox() throws {
        guard case .waInbox(let chat) = try dec(AccountEvent.self, #"{"type":"wa.inbox","chat":\#(wa("9"))}"#) else { return XCTFail() }
        XCTAssertEqual(chat?.jid, "9")
        guard case .waInbox(let none) = try dec(AccountEvent.self, #"{"type":"wa.inbox"}"#) else { return XCTFail() }
        XCTAssertNil(none)
    }

    func testRowsFilterBySectionHiddenUnreadAndQuery() throws {
        let all = try [wa("1", place: "dms", unread: 2), wa("2", place: "groups"), wa("3", place: nil), wa("4", place: "dms", hidden: true),
                       wa("5", place: "dms", pinned: "2026-10-01T08:00:00.000Z", at: "2026-09-01T00:00:00.000Z")].map { try dec(WaChatDTO.self, $0) }
        XCTAssertEqual(WaInbox.rows(all, place: "dms").map(\.jid), ["5", "1"], "fijado primero, luego sin leer")
        XCTAssertEqual(WaInbox.rows(all, place: "groups").map(\.jid), ["2"])
        XCTAssertEqual(WaInbox.rows(all, place: "dms", filter: .unread).map(\.jid), ["1"])
        XCTAssertEqual(WaInbox.rows(all, place: "dms", filter: .mentions), [], "WhatsApp no cuenta en Menciones")
        XCTAssertEqual(WaInbox.rows(all, place: "dms", query: "chat 5").map(\.jid), ["5"])
        XCTAssertEqual(WaInbox.bucket(all[0]), .unread)
        XCTAssertEqual(WaInbox.bucket(all[4]), .pinned)
        XCTAssertEqual(WaInbox.bucket(all[1]), .recent)
    }

    func testMixKeepsBucketsAndInterleavesByActivity() throws {
        struct Row: Identifiable { var id: String; var at: String; var mention = false }
        let split: [(bucket: InboxBucket, items: [Row])] = [
            (.pinned, [Row(id: "p1", at: "2026-10-01T05:00:00.000Z")]),
            (.recent, [Row(id: "r1", at: "2026-10-01T12:00:00.000Z"), Row(id: "r2", at: "2026-10-01T08:00:00.000Z")]),
        ]
        let w = try [wa("new", at: "2026-10-01T10:00:00.000Z"), wa("u", unread: 1), wa("pin", pinned: "2026-10-01T01:00:00.000Z")].map { try dec(WaChatDTO.self, $0) }
        let out = WaInbox.mix(split, wa: w, activity: \.at)
        XCTAssertEqual(out.map(\.bucket), [.pinned, .unread, .recent], "el bloque Sin leer aparece aunque chaggu no tenga")
        XCTAssertEqual(out[0].items.map(\.id), ["wa:acc1:pin", "p1"], "dentro de Fijados, por actividad")
        XCTAssertEqual(out[1].items.map(\.id), ["wa:acc1:u"])
        XCTAssertEqual(out[2].items.map(\.id), ["r1", "wa:acc1:new", "r2"])
        // Una mención sin leer de chaggu va antes aunque el WhatsApp sea más nuevo.
        let urgent: [(bucket: InboxBucket, items: [Row])] = [(.unread, [Row(id: "m", at: "2026-01-01T00:00:00.000Z", mention: true)])]
        XCTAssertEqual(WaInbox.mix(urgent, wa: [w[1]], activity: \.at, urgent: \.mention)[0].items.map(\.id), ["m", "wa:acc1:u"])
    }

    func testApplyingMatchesServerRules() throws {
        let c = try dec(WaChatDTO.self, wa("1", place: nil, group: true))
        let pinned = WaInbox.applying(c, pinned: true)
        XCTAssertEqual(pinned.inboxPlace, "groups", "fijar sin haberlo movido lo mueve a la sugerida")
        XCTAssertNotNil(pinned.inboxPinnedAt)
        let out = WaInbox.applying(pinned, place: .some(nil))
        XCTAssertNil(out.inboxPlace); XCTAssertNil(out.inboxPinnedAt, "sacarlo quita también el fijado")
        XCTAssertEqual(WaInbox.applying(pinned, place: .some("dms")).inboxPinnedAt, pinned.inboxPinnedAt)
    }

    func testPatchesAndStoreOptimisticUpdate() async throws {
        let s = try ControlledURLProtocol.store()
        let c = try dec(WaChatDTO.self, wa("57@s.whatsapp.net", place: nil))
        var body: [String: Any] = [:]
        var path = ""
        ControlledURLProtocol.handler = { req in Task { @MainActor in
            body = req.json; path = req.request.url?.path ?? ""
            req.respond(wa("57@s.whatsapp.net", place: "dms"))
        } }
        try await s.waSetInboxPlace(c, "dms")
        XCTAssertEqual(path, "/api/v1/whatsapp/chats/acc1/57@s.whatsapp.net")
        XCTAssertEqual(body["inboxPlace"] as? String, "dms")
        XCTAssertEqual(s.waInbox.map(\.jid), ["57@s.whatsapp.net"])
        ControlledURLProtocol.handler = { req in Task { @MainActor in
            body = req.json
            req.respond(wa("57@s.whatsapp.net", place: nil))
        } }
        try await s.waSetInboxPlace(s.waInbox[0], nil)
        XCTAssertTrue(body["inboxPlace"] is NSNull, "null lo saca de la bandeja")
        XCTAssertTrue(s.waInbox.isEmpty)
        // Error del servidor: vuelve a como estaba.
        s.applyWaInbox([try dec(WaChatDTO.self, wa("1"))])
        ControlledURLProtocol.handler = { req in Task { @MainActor in req.respond(500, #"{"error":{"code":"boom","message":"x"}}"#) } }
        do { try await s.waSetInboxPinned(s.waInbox[0], true); XCTFail() } catch {}
        XCTAssertNil(s.waInbox[0].inboxPinnedAt)
    }

    func testGgSideDecodingIsLenient() throws {
        let m = try dec(GgSideMessageDTO.self, #"""
        {"id":"g1","role":"gg","body":"Hola","quoted":null,"createdAt":"2026-10-01T10:00:00Z",
         "extra":{"followUps":["¿Qué falta?","¿Quién?"],"pending":[{"text":"Ana pregunta por la cotización","messageId":"m1"}],
                  "drafts":[{"style":"action","text":"Lo reviso hoy","action":{"kind":"task","title":"Revisar cotización","assigneeName":"Ana","due":"2026-10-03"}}],
                  "suggestions":[{"id":"s1","kind":"task","title":"Crear tarea","params":{"assigneeName":"Ana","due":"2026-10-03","n":3,"x":null},"forMessageIds":["m1"]}]}}
        """#)
        XCTAssertTrue(m.isGg)
        XCTAssertEqual(m.extra?.followUps.count, 2)
        XCTAssertEqual(m.extra?.pending.first?.messageId, "m1")
        XCTAssertEqual(m.extra?.drafts.first?.action?.assigneeName, "Ana")
        let s = try XCTUnwrap(m.extra?.suggestions.first)
        XCTAssertEqual(s.params?["n"], "3")
        let p = GgPrefill(s)
        XCTAssertEqual(p.assigneeName, "Ana"); XCTAssertEqual(p.messageId, "m1")
        XCTAssertNotNil(p.dueDate)
        XCTAssertEqual(GgSuggestSheet.outcome(s), .task(p))
        XCTAssertEqual(GgSuggestSheet.outcome(GgSuggestion(id: "r", kind: "reply", title: "Responder", draft: "Listo")), .draft("Listo"))
        XCTAssertEqual(GgSource.conversation("c1"), "c:c1")
        XCTAssertEqual(GgSource.query("wa:acc:57@s.whatsapp.net"), "wa%3Aacc%3A57%40s%2Ewhatsapp%2Enet")
    }

    func testGgSidePending404HidesButtonAndConsentFlag() async throws {
        let s = try ControlledURLProtocol.store()
        // Un 404 de UN chat (bloqueado o borrado) no esconde gg en todos los chats (012a9ff); solo «Ruta no encontrada».
        ControlledURLProtocol.handler = { req in Task { @MainActor in req.respond(404, #"{"error":{"code":"not_found","message":"Not found"}}"#) } }
        await s.ggSidePending(["c:c1"])
        XCTAssertNil(s.ggSide.available, "404 de un chat: el botón no se esconde")
        let r = try ControlledURLProtocol.store()
        ControlledURLProtocol.handler = { req in Task { @MainActor in req.respond(404, #"{"error":{"code":"route_not_found","message":"Ruta no encontrada"}}"#) } }
        await r.ggSidePending(["c:c1"])
        XCTAssertEqual(r.ggSide.available, false, "API sin gg en el chat: el botón no sale")
        let t = try ControlledURLProtocol.store()
        var url = ""
        ControlledURLProtocol.handler = { req in Task { @MainActor in url = req.request.url?.absoluteString ?? ""; req.respond(#"{"c:c1":3}"#) } }
        await t.ggSidePending(["c:c1"])
        XCTAssertEqual(t.ggSide.available, true)
        XCTAssertEqual(t.ggSide.pending["c:c1"], 3)
        XCTAssertTrue(url.contains("/gg/side/pending?sources=c%3Ac1"), url)
        // Consentimiento: 403 ai_consent_required → la UI pide permiso; con permiso, el cuerpo lleva aiConsent.
        ControlledURLProtocol.handler = { req in Task { @MainActor in req.respond(403, #"{"error":{"code":"ai_consent_required","message":"x"}}"#) } }
        do { _ = try await t.ggSideReplyForMe("c:c1"); XCTFail() } catch let e as ApiRequestError { XCTAssertTrue(e.needsAIConsent) }
        t.ggSide.consented = true
        var body: [String: Any] = [:]
        ControlledURLProtocol.handler = { req in Task { @MainActor in body = req.json; req.respond(#"{"drafts":[{"style":"short","text":"Ok"},{"style":"warm","text":"¡Claro!"}]}"#) } }
        let drafts = try await t.ggSideReplyForMe("c:c1", tone: "formal")
        XCTAssertEqual(drafts.map(\.style), ["short", "warm"])
        XCTAssertEqual(body["aiConsent"] as? Bool, true)
        XCTAssertEqual(body["tone"] as? String, "formal")
        XCTAssertEqual(t.ggSide.threads["c:c1"]?.messages.last?.extra?.drafts.count, 2, "queda en el hilo de gg")
        XCTAssertTrue(t.ggSide.used.contains("c:c1"))
    }

    func testGgSideLoadOpensGreetingWhenEmptyAndNewBumpsSession() async throws {
        let s = try ControlledURLProtocol.store()
        var paths: [String] = []
        ControlledURLProtocol.handler = { req in Task { @MainActor in
            let p = req.request.url?.path ?? ""
            paths.append(p)
            switch p {
            case "/api/v1/gg/side": req.respond(#"{"session":2,"messages":[],"pending":0}"#)
            case "/api/v1/gg/side/open": req.respond(#"{"message":{"id":"g1","role":"gg","body":"Te piden 2 cosas","extra":{"pending":[{"text":"a"},{"text":"b"}],"followUps":["x"]},"createdAt":"2026-10-01T10:00:00Z"}}"#)
            case "/api/v1/gg/side/new": req.respond(#"{"session":3}"#)
            default: req.respond(404, "{}")
            }
        } }
        try await s.ggSideLoad("c:c1")
        XCTAssertEqual(paths, ["/api/v1/gg/side", "/api/v1/gg/side/open"])
        XCTAssertEqual(s.ggSide.threads["c:c1"]?.messages.map(\.id), ["g1"])
        XCTAssertEqual(s.ggSide.pending["c:c1"], 2)
        try await s.ggSideNew("c:c1")
        XCTAssertEqual(s.ggSide.threads["c:c1"]?.session, 3)
    }

    func testPrefillDueParsing() {
        XCTAssertNotNil(GgPrefill.parseDue("2026-10-03"))
        XCTAssertNotNil(GgPrefill.parseDue("2026-10-03T15:00:00Z"))
        XCTAssertNotNil(GgPrefill.parseDue("2026-10-03 15:00"))
        XCTAssertNil(GgPrefill.parseDue("mañana"))
        XCTAssertNil(GgPrefill.parseDue(nil))
    }
}


extension WaInboxGgTests {
    func testPrivacyLedgerPreservesOtherAccountsAndRequiresFreshAcceptance() throws {
        var p = WaPrivacy()
        let c = try dec(WaChatDTO.self, wa("57300@s.whatsapp.net"))
        let original = p.token(c.inboxKey)
        p.revoke(account: "acc1", jids: [c.jid, "alias@lid"], reset: false)
        XCTAssertFalse(p.allows(c.inboxKey)); XCTAssertFalse(p.allows("wa:acc1:alias@lid"))
        XCTAssertTrue(p.allows("wa:other:57300@s.whatsapp.net")); XCTAssertTrue(p.allows("wa:acc1:public@g.us"))
        XCTAssertNotEqual(original, p.token(c.inboxKey))
        p.accept([c]); XCTAssertTrue(p.allows(c.inboxKey)); XCTAssertFalse(p.allows("wa:acc1:alias@lid"))
        p.revoke(account: "acc1", jids: [], reset: true)
        p.accept([c]); XCTAssertFalse(p.allows(c.inboxKey), "list cannot bypass account revalidation")
        p.ready("acc1"); p.accept([c]); XCTAssertTrue(p.allows(c.inboxKey))
    }
    func testPrivacyEventPurgesOnlyAffectedInboxAndGgAndIgnoresLateTombstones() throws {
        let s = try ControlledURLProtocol.store()
        let c = try dec(WaChatDTO.self, wa("locked@lid"))
        var other = c; other.accountId = "other"
        s.applyWaInbox([c, other])
        s.ggSide.threads[c.inboxKey] = GgSideThread(messages: [.init(role: "gg", body: "private")], loaded: true)
        s.ggSide.threads[other.inboxKey] = GgSideThread(messages: [.init(role: "gg", body: "other")], loaded: true)
        s.socketEventForTesting("account.event", #"{"type":"wa.privacy","accountId":"acc1","jids":["locked@lid"]}"#)
        XCTAssertEqual(s.waInbox.map(\.accountId), ["other"])
        XCTAssertNil(s.ggSide.threads[c.inboxKey]); XCTAssertNotNil(s.ggSide.threads[other.inboxKey])
        s.upsertWaInbox(c); XCTAssertEqual(s.waInbox.count, 1, "stale inbox update cannot resurrect")
    }
    func testHeldWaListAndMessagesCannotResurrectRevokedSource() async throws {
        for list in [true, false] {
            let s = try ControlledURLProtocol.store()
            let c = try dec(WaChatDTO.self, wa("locked@lid"))
            let started = expectation(description: "WA held")
            var held: ControlledURLProtocol?
            ControlledURLProtocol.handler = { request in Task { @MainActor in held = request; started.fulfill() } }
            let request = Task { () throws -> Void in
                if list { _ = try await s.waChats(accountId: nil, category: nil, onlyGroups: false, showHidden: true, query: "") }
                else { _ = try await s.waMessages(c) }
            }
            await fulfillment(of: [started], timeout: 2)
            s.revokeWaPrivacy(accountId: c.accountId, jids: [c.jid])
            held?.respond(list ? "{\"chats\":[\(wa(c.jid))]}" : #"{"messages":[{"id":"private","body":"secret"}]}"#)
            do { try await request.value; XCTFail("revoked response must fail") } catch {}
            XCTAssertTrue(s.waInbox.isEmpty)
        }
    }
    func testFailedOptimisticWaMutationCannotRollbackPrivacy() async throws {
        let s = try ControlledURLProtocol.store()
        let c = try dec(WaChatDTO.self, wa("locked@lid"))
        s.applyWaInbox([c])
        let started = expectation(description: "WA mutation held")
        var held: ControlledURLProtocol?
        ControlledURLProtocol.handler = { request in Task { @MainActor in held = request; started.fulfill() } }
        let request = Task { try await s.waSetInboxPinned(c, true) }
        await fulfillment(of: [started], timeout: 2)
        s.revokeWaPrivacy(accountId: c.accountId, reset: true)
        held?.respond(500, #"{"error":{"code":"failure","message":"failed"}}"#)
        do { _ = try await request.value; XCTFail() } catch {}
        XCTAssertTrue(s.waInbox.isEmpty)
    }
    func testFreshWaListCanRestoreExplicitlyUnlockedChat() async throws {
        let s = try ControlledURLProtocol.store()
        s.revokeWaPrivacy(accountId: "acc1", jids: ["locked@lid"])
        ControlledURLProtocol.handler = { req in req.respond("{\"chats\":[\(wa("locked@lid"))]}") }
        let page = try await s.waChats(accountId: nil, category: nil, onlyGroups: false, showHidden: false, query: "")
        XCTAssertEqual(page.chats.count, 1); XCTAssertTrue(s.waPrivacy.allows("wa:acc1:locked@lid"))
    }
    func testDeniedWaMessagesFailClosedAndPrivacySourcesParseEncodedJids() async throws {
        let s = try ControlledURLProtocol.store()
        let c = try dec(WaChatDTO.self, wa("locked@lid")); s.applyWaInbox([c])
        ControlledURLProtocol.handler = { req in req.respond(404, #"{"error":{"code":"not_found","message":"unavailable"}}"#) }
        do { _ = try await s.waMessages(c); XCTFail() } catch {}
        XCTAssertTrue(s.waInbox.isEmpty); XCTAssertFalse(s.waPrivacy.allows(c.inboxKey))
        XCTAssertEqual(WaPrivacy.requestSource("/api/v1/whatsapp/media/acc1/locked%40lid/msg"), c.inboxKey)
        XCTAssertEqual(WaPrivacy.requestSource("/gg/side?source=wa%3Aacc1%3Alocked%40lid"), c.inboxKey)
    }
    func testSnapshotOmitsPrivateWaWithoutDeletingChagguData() throws {
        var d = try ControlledURLProtocol.boot("a")
        d.waInbox = [try dec(WaChatDTO.self, wa("locked@lid"))]
        let snapshot = SnapshotCache.make(d, blocked: [], conversations: [:])
        XCTAssertTrue(snapshot.bootstrap.waInbox?.isEmpty == true)
        XCTAssertEqual(snapshot.bootstrap.me.id, "a")
        XCTAssertEqual(snapshot.bootstrap.conversations, d.conversations)
    }
    func testHeldBootstrapCannotRestoreRevokedWa() async throws {
        let store = try ControlledURLProtocol.store()
        let started = expectation(description: "bootstrap held")
        var held: ControlledURLProtocol?
        ControlledURLProtocol.handler = { request in Task { @MainActor in
            if request.request.url?.path.hasSuffix("/bootstrap") == true { held = request; started.fulfill() }
            else { request.respond(#"{"userIds":[]}"#) }
        } }
        let pending = Task { try await store.loadBootstrap() }
        await fulfillment(of: [started], timeout: 2)
        store.revokeWaPrivacy(accountId: "acc1", jids: ["locked@lid"])
        held?.respond("{\"me\":{\"id\":\"a\"},\"conversations\":[],\"waInbox\":[\(wa("locked@lid"))]}")
        try await pending.value
        XCTAssertTrue(store.waInbox.isEmpty)
        XCTAssertTrue(store.data?.waInbox?.isEmpty == true)
    }
    func testHeldGgResponseAndBackgroundInvalidatePrivateSource() async throws {
        let store = try ControlledURLProtocol.store()
        let source = "wa:acc1:locked@lid"
        let started = expectation(description: "gg held")
        var held: ControlledURLProtocol?
        ControlledURLProtocol.handler = { request in Task { @MainActor in held = request; started.fulfill() } }
        let pending = Task { try await store.ggSideAsk(source, text: "synthetic", quotes: []) }
        await fulfillment(of: [started], timeout: 2)
        store.enteredBackground()
        held?.respond(#"{"message":{"id":"secret","role":"gg","body":"synthetic private"}}"#)
        do { try await pending.value; XCTFail("old gg response must fail") } catch {}
        XCTAssertNil(store.ggSide.threads[source])
        XCTAssertFalse(store.waPrivacy.allows(source))
    }

    func testReadyAccountRefreshesListAfterConcurrentEmptyResponse() async throws {
        let store = try ControlledURLProtocol.store()
        store.revokeWaPrivacy(accountId: "acc1", reset: true)
        let revision = store.waRevision
        ControlledURLProtocol.handler = { request in request.respond(#"{"accounts":[{"id":"acc1","privacyReady":true}]}"#) }
        _ = try await store.waAccounts()
        XCTAssertTrue(store.waPrivacy.allows("wa:acc1:synthetic@lid"))
        XCTAssertGreaterThan(store.waRevision, revision)
    }

    func testHeldRefreshCannotDispatchPrivateRequestAfterLockOrResetEvenIfUnlocked() async throws {
        for retry in [false, true] {
            for reset in [false, true] {
                for unlock in [false, true] {
                    for media in [false, true] {
                        let config = URLSessionConfiguration.ephemeral
                        config.protocolClasses = [ControlledURLProtocol.self]
                        let api = APIClient(baseURL: URL(string: "https://synthetic.invalid")!, secrets: MemorySecretStore("synthetic-refresh"), session: URLSession(configuration: config))
                        var privacy = WaPrivacy()
                        let source = "wa:acc1:locked@lid"
                        api.waPrivacyCheck = { source in
                            guard privacy.allows(source) else { throw CancellationError() }
                            return privacy.token(source)
                        }
                        let auth = #"{"accessToken":"synthetic-access","accessExpiresAt":"2199-01-01T00:00:00Z","refreshToken":"synthetic-refresh","user":{"id":"a","kind":"human"}}"#
                        if retry {
                            ControlledURLProtocol.handler = { request in request.respond(auth) }
                            _ = await api.refresh()
                        }
                        let started = expectation(description: "refresh held")
                        var held: ControlledURLProtocol?
                        var privateCalls = 0
                        ControlledURLProtocol.handler = { request in Task { @MainActor in
                            if request.request.url?.path.hasSuffix("/refresh") == true {
                                held = request; started.fulfill()
                            } else {
                                privateCalls += 1
                                request.respond(retry && privateCalls == 1 ? 401 : 200, "{}")
                            }
                        } }
                        let pending = Task { try await api.download(media ? "/whatsapp/media/acc1/locked%40lid/m1" : "/whatsapp/chats/acc1/locked%40lid/messages") }
                        await fulfillment(of: [started], timeout: 2)
                        privacy.revoke(account: "acc1", jids: reset ? [] : ["locked@lid"], reset: reset)
                        if unlock {
                            privacy.ready("acc1")
                            privacy.accept([try dec(WaChatDTO.self, wa("locked@lid"))])
                            XCTAssertTrue(privacy.allows(source))
                        }
                        held?.respond(auth)
                        do { _ = try await pending.value; XCTFail("old private request must not dispatch") } catch {}
                        XCTAssertEqual(privateCalls, retry ? 1 : 0, "No private HTTP after held refresh: retry=\(retry), reset=\(reset), unlock=\(unlock), media=\(media)")
                    }
                }
            }
        }
    }

    func testSignoutPurgesWhatsAppFilesAndResetsVoiceWithoutDeletingCanonicalFiles() async throws {
        let store = try ControlledURLProtocol.store()
        ControlledURLProtocol.handler = { request in request.respond("synthetic") }
        let id = UUID().uuidString
        let privateAttachment = try dec(AttachmentDTO.self, """
            {"id":"wa-\(id)","name":"private.txt","contentType":"text/plain","sizeBytes":9,"url":"/whatsapp/media/acc1/locked%40lid/m1"}
            """)
        let canonicalAttachment = try dec(AttachmentDTO.self, """
            {"id":"canonical-\(id)","name":"keep.txt","contentType":"text/plain","sizeBytes":9,"url":"/attachments/\(id)"}
            """)
        let privateURL = try await AttachmentCache.shared.fileURL(privateAttachment, api: store.api)
        let canonicalURL = try await AttachmentCache.shared.fileURL(canonicalAttachment, api: store.api)
        defer { try? FileManager.default.removeItem(at: canonicalURL.deletingLastPathComponent()) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: privateURL.path))
        await store.signOutLocally()
        XCTAssertFalse(FileManager.default.fileExists(atPath: privateURL.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: canonicalURL.path))
        XCTAssertFalse(VoicePlayer.shared.playing)
    }


    // MARK: gg propone, la persona confirma: reunión y correo (gg-actions.ts, 2-oct-2026)

    func testMeetingDraftDecodesAndToleratesOldOrBadFields() throws {
        let d = try dec(GgMeetingDraft.self, #"{"title":"Revisión del contrato","durationMin":45,"attendeeEmails":["ana@cliente.co"],"invitees":[{"id":"u-1","name":"Luis Pérez"},{"name":"sin id"}],"missingPeople":["Marta"],"links":["https://docs.example.com/x"],"description":"Cerrar cláusulas\n\nEnlaces:\n- https://docs.example.com/x"}"#)
        XCTAssertEqual(d.title, "Revisión del contrato")
        XCTAssertEqual(d.durationMin, 45)
        XCTAssertEqual(d.attendeeEmails, ["ana@cliente.co"])
        XCTAssertEqual(d.invitees, [GgInvitee(id: "u-1", name: "Luis Pérez")], "sin id no se puede invitar")
        XCTAssertEqual(d.missingPeople, ["Marta"])
        XCTAssertEqual(d.links.count, 1)
        XCTAssertTrue(d.description.contains("Enlaces"))
        let empty = try dec(GgMeetingDraft.self, #"{"durationMin":"900","invitees":null}"#)
        XCTAssertEqual(empty.durationMin, 30, "fuera de 15…240 → 30")
        XCTAssertTrue(empty.invitees.isEmpty && empty.attendeeEmails.isEmpty && empty.title.isEmpty)
        XCTAssertEqual(try dec(GgMeetingDraft.self, #"{"durationMin":90.0}"#).durationMin, 90)
    }

    func testMailDraftReadyAndNeedsConnect() throws {
        let d = try dec(GgMailDraft.self, #"{"provider":"google","from":"yo@empresa.co","status":"ready","to":["ana@cliente.co"],"cc":[],"missingPeople":["Luis"],"subject":"Propuesta","body":"Hola Ana"}"#)
        XCTAssertTrue(d.ready)
        XCTAssertEqual(d.fromLabel, "yo@empresa.co")
        XCTAssertEqual(d.to, ["ana@cliente.co"]); XCTAssertEqual(d.missingPeople, ["Luis"])
        XCTAssertEqual(d.subject, "Propuesta"); XCTAssertEqual(d.body, "Hola Ana")
        let none = try dec(GgMailDraft.self, #"{"provider":null,"from":null,"status":"needs_connect","to":[],"cc":[],"missingPeople":[],"subject":"x","body":""}"#)
        XCTAssertFalse(none.ready); XCTAssertEqual(none.status, "needs_connect")
        // «ready» sin proveedor conocido no deja enviar.
        XCTAssertFalse(try dec(GgMailDraft.self, #"{"provider":"yahoo","status":"ready"}"#).ready)
        XCTAssertEqual(try dec(GgMailDraft.self, #"{"provider":"microsoft","status":"ready","from":""}"#).fromLabel, "Outlook")
        let sent = try dec(GgMailSendResult.self, #"{"ok":true,"already":true}"#)
        XCTAssertTrue(sent.ok && sent.already)
        XCTAssertFalse(try dec(GgMailSendResult.self, #"{}"#).ok)
    }

    func testEmailListParsingAndValidation() {
        XCTAssertEqual(GgEmails.parse(" Ana@Cliente.co, luis@x.co;ana@cliente.co\nmarta@y.co "), ["ana@cliente.co", "luis@x.co", "marta@y.co"])
        XCTAssertTrue(GgEmails.parse(" , ; ").isEmpty)
        XCTAssertTrue(GgEmails.valid("a@b.co"))
        for bad in ["luis", "a@b", "a@@b.co", "@b.co", "a@b.", "a@.co"] { XCTAssertFalse(GgEmails.valid(bad), bad) }
        XCTAssertEqual(GgEmails.invalid(["a@b.co", "luis"]), ["luis"])
    }

    // MARK: 2-oct-2026: dos pines, «💼 Solo trabajo» y pines de correo

    func testWaTwoPinsPatchesAndAccountSendEnabled() throws {
        XCTAssertEqual(WaInbox.pinPatch(true) as? [String: Bool], ["inboxPinned": true], "«Fijar en la pantalla principal»")
        XCTAssertEqual(WaInbox.waPinPatch(false) as? [String: Bool], ["pinned": false], "«Fijar en WhatsApp»")
        XCTAssertEqual(WaInbox.hidePatch(true) as? [String: Bool], ["hidden": true])
        let a = try dec(WaAccountDTO.self, #"{"id":"acc1","label":"danny","sendEnabled":true,"status":"connected"}"#)
        XCTAssertTrue(a.sendEnabled)
        XCTAssertFalse(try dec(WaAccountDTO.self, #"{"id":"acc1"}"#).sendEnabled, "servidor anterior = solo lectura")
        // La ruta del chat lleva el DTO (Hashable).
        let c = try dec(WaChatDTO.self, wa("1"))
        XCTAssertEqual(Route.waChat(c), Route.waChat(c))
        var other = c; other.pinned = true
        XCTAssertNotEqual(Route.waChat(c), Route.waChat(other))
    }

    func testWorkOnlyFiltersCategoriesButKeepsMainPinned() throws {
        func chat(_ jid: String, _ cat: String, pinned: String? = nil) throws -> WaChatDTO {
            var j = wa(jid, place: "groups", pinned: pinned)
            j.removeLast(); j += #","category":"\#(cat)"}"#
            return try dec(WaChatDTO.self, j)
        }
        let all = try [chat("t", "trabajo"), chat("c", "clientes"), chat("f", "familia"), chat("a", "amigos"), chat("o", "otros"),
                       chat("p", "familia", pinned: "2026-10-01T08:00:00.000Z")]
        XCTAssertEqual(Set(WaWorkOnly.filter(all, on: true).map(\.jid)), ["t", "c"], "pantalla WhatsApp: solo trabajo y clientes")
        XCTAssertEqual(WaWorkOnly.filter(all, on: false).count, 6)
        XCTAssertEqual(Set(WaInbox.rows(all, place: "groups", workOnly: true).map(\.jid)), ["t", "c", "p"], "la fijada en principal siempre se ve")
        XCTAssertEqual(WaInbox.rows(all, place: "groups").count, 6)
        let counts = try dec([String: WaChatsPage.Count].self, #"{"trabajo":{"total":3,"unread":1},"clientes":{"total":2,"unread":0},"familia":{"total":7,"unread":0}}"#)
        XCTAssertEqual(WaWorkOnly.total(counts, on: true), 5)
        XCTAssertEqual(WaWorkOnly.total(counts, on: false), 12)
        let d = UserDefaults(suiteName: "wa-work-only-test")!
        d.removePersistentDomain(forName: "wa-work-only-test")
        XCTAssertFalse(WaWorkOnly.load(d))
        WaWorkOnly.save(true, d)
        XCTAssertTrue(WaWorkOnly.load(d), "queda como lo dejó")
        d.removePersistentDomain(forName: "wa-work-only-test")
    }

    func testMailPinDecodeAndBootstrap() throws {
        let p = try dec(MailPinDTO.self, #"{"provider":"google","threadKey":"t1","messageId":"m2","subject":"Contrato","from":{"name":"Ana","email":"ana@x.co"},"date":"2026-10-01T10:00:00.000Z","mainPinnedAt":"2026-10-02T10:00:00.000Z","mailPinnedAt":null}"#)
        XCTAssertEqual(p.id, "google|t1")
        XCTAssertTrue(p.onMain); XCTAssertFalse(p.onMail)
        XCTAssertEqual(p.from?.display, "Ana")
        XCTAssertEqual(p.listItem.id, "m2", "tocarlo abre ese correo")
        XCTAssertEqual(p.listItem.threadId, "t1")
        XCTAssertNil(try dec(BootstrapDTO.self, #"{"me":{"id":"a","name":"A"}}"#).mailPins, "servidor anterior")
        let b = try dec(BootstrapDTO.self, #"{"me":{"id":"a","name":"A"},"mailPins":[{"provider":"microsoft","threadKey":"x","messageId":"x"},{"provider":"rara"}]}"#)
        XCTAssertEqual(b.mailPins?.map(\.provider), [.microsoft])
    }

    func testMailPinPutBody() throws {
        var m = MailListItemDTO(provider: .google, id: "m1", from: MailAddressDTO(name: nil, email: "a@b.co"), to: [], subject: "Hola", snippet: "", date: "2026-10-01T10:00:00.000Z")
        // Sin hilo: el id del correo hace de threadKey; solo va el pin que cambia.
        var b = MailPins.body(m, main: true)
        XCTAssertEqual(b["provider"] as? String, "google")
        XCTAssertEqual(b["threadKey"] as? String, "m1")
        XCTAssertEqual(b["messageId"] as? String, "m1")
        XCTAssertEqual(b["subject"] as? String, "Hola")
        XCTAssertEqual(b["date"] as? String, "2026-10-01T10:00:00.000Z")
        XCTAssertEqual(b["main"] as? Bool, true)
        XCTAssertNil(b["mail"], "ausente = no cambia")
        let from = b["from"] as? [String: Any]
        XCTAssertEqual(from?["email"] as? String, "a@b.co")
        XCTAssertTrue(from?["name"] is NSNull)
        m.threadId = "th9"; m.from = nil; m.date = nil
        b = MailPins.body(m, mail: false)
        XCTAssertEqual(b["threadKey"] as? String, "th9")
        XCTAssertEqual(b["mail"] as? Bool, false)
        XCTAssertNil(b["main"])
        XCTAssertTrue(b["from"] is NSNull); XCTAssertTrue(b["date"] is NSNull)
        XCTAssertNoThrow(try JSONSerialization.data(withJSONObject: b))
    }

    func testMailPinsApplyingAndLists() throws {
        var m = MailListItemDTO(provider: .google, id: "m1", from: nil, to: [], subject: "A", snippet: "", date: nil)
        m.threadId = "t1"
        var pins = MailPins.applying([], m, main: true, now: "2026-10-02T01:00:00.000Z")
        XCTAssertEqual(MailPins.main(pins).map(\.threadKey), ["t1"])
        XCTAssertEqual(MailPins.mail(pins, provider: .google), [])
        pins = MailPins.applying(pins, m, mail: true, now: "2026-10-02T02:00:00.000Z")
        XCTAssertEqual(pins.count, 1, "mismo hilo, una fila")
        XCTAssertEqual(pins[0].mainPinnedAt, "2026-10-02T01:00:00.000Z", "fijar otra vez no cambia la fecha")
        XCTAssertEqual(MailPins.mail(pins, provider: .google).count, 1)
        XCTAssertEqual(MailPins.mail(pins, provider: .microsoft).count, 0)
        // Otro correo del mismo hilo encuentra el pin.
        var reply = m; reply.id = "m2"
        XCTAssertNotNil(MailPins.find(pins, reply))
        pins = MailPins.applying(pins, m, main: false)
        pins = MailPins.applying(pins, m, mail: false)
        XCTAssertEqual(pins, [], "sin pines, la fila desaparece (como el servidor)")
    }
}
