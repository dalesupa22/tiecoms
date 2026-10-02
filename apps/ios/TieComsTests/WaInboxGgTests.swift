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
        ControlledURLProtocol.handler = { req in Task { @MainActor in req.respond(404, #"{"error":{"code":"not_found","message":"Not found"}}"#) } }
        await s.ggSidePending(["c:c1"])
        XCTAssertEqual(s.ggSide.available, false, "API sin gg en el chat: el botón no sale")
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
