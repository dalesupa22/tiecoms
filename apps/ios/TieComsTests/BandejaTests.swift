import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }

/// 1.6.4 (SPEC-bandeja): orden único con fijados primero, vista Lista «Empresa · Grupo» con separadores
/// Fijados · Sin leer · Recientes, y abrir un chat largo en el primer no leído.
final class BandejaTests: XCTestCase {
    private func conv(_ id: String, unread: Int = 0, mentions: Int = 0, muted: Bool = false, pinned: Bool = false, at: String) throws -> ConversationDTO {
        try dec(ConversationDTO.self, #"{"id":"\#(id)","kind":"group","unread":\#(unread),"unreadMentions":\#(mentions),"lastMessageAt":"\#(at)"\#(muted ? #","mutedUntil":"2099-01-01T00:00:00Z""# : "")\#(pinned ? #","pinnedAt":"2026-01-01T00:00:00Z""# : "")}"#)
    }

    // MARK: A. Orden

    func testPinnedFirstThenMentionThenUnreadThenActivity() throws {
        let old = try conv("old", at: "2026-09-01T10:00:00Z")
        let recent = try conv("recent", at: "2026-09-26T10:00:00Z")
        let unread = try conv("unread", unread: 3, at: "2026-09-10T10:00:00Z")
        let mutedUnread = try conv("mutedUnread", unread: 4, muted: true, at: "2026-09-27T10:00:00Z")
        let mention = try conv("mention", unread: 1, mentions: 1, muted: true, at: "2026-09-05T10:00:00Z")
        let pinRead = try conv("pinRead", pinned: true, at: "2026-08-01T10:00:00Z")
        let pinUnread = try conv("pinUnread", unread: 1, pinned: true, at: "2026-07-01T10:00:00Z")
        let pinMention = try conv("pinMention", unread: 2, mentions: 1, pinned: true, at: "2026-06-01T10:00:00Z")
        let sorted = [old, recent, unread, mutedUnread, mention, pinRead, pinUnread, pinMention].sorted(by: HomeOrder.before).map(\.id)
        XCTAssertEqual(sorted, ["pinMention", "pinUnread", "pinRead", "mention", "unread", "mutedUnread", "recent", "old"],
                       "fijadas arriba (entre ellas mención → no leído → actividad); luego mención aunque esté silenciada, no leídos y actividad")
    }

    func testTieBreakById() throws {
        let b = try conv("b", at: "2026-09-26T10:00:00Z")
        let a = try conv("a", at: "2026-09-26T10:00:00Z")
        XCTAssertEqual([b, a].sorted(by: HomeOrder.before).map(\.id), ["a", "b"])
    }

    // MARK: B. Lista

    private func boot() throws -> BootstrapDTO {
        try dec(BootstrapDTO.self, #"""
        {"contract":"2026-09-25","serverTime":"","me":{"id":"me","name":"Ana Ruiz","kind":"human","primaryOrgId":"oA"},
         "organizations":[{"id":"oA","name":"Xertify","myRole":"owner"},{"id":"oB","name":"Ongoing"},{"id":"oC","name":"Acme"}],
         "workspaces":[
           {"id":"wHome","name":"Xertify","owningOrgId":"oA","organizationIds":["oA"],"memberIds":["me"],"myRole":"member","isOrgHome":true,"createdAt":"2026-09-01"},
           {"id":"wRel","name":"Mentorías","owningOrgId":"oA","organizationIds":["oA","oB"],"memberIds":["me"],"myRole":"member","createdAt":"2026-09-01"},
           {"id":"wPend","name":"Nestlé","owningOrgId":"oA","organizationIds":["oA"],"memberIds":["me"],"myRole":"lead","counterpartName":"Nestlé","createdAt":"2026-09-01"},
           {"id":"wGuest","name":"Programa","owningOrgId":"oC","organizationIds":["oC"],"memberIds":["me"],"myRole":"guest","createdAt":"2026-09-01"}],
         "conversations":[
           {"id":"g1","workspaceId":"wHome","kind":"group","name":"Pagos","memberIds":["me"],"lastMessageAt":"2026-09-20T10:00:00Z","unread":2},
           {"id":"g2","workspaceId":"wHome","kind":"internal","name":"Xertify interno","memberIds":["me"],"lastMessageAt":"2026-09-01T10:00:00Z","pinnedAt":"2026-09-02T00:00:00Z"},
           {"id":"r1","workspaceId":"wRel","kind":"group","name":"Mentoría","memberIds":["me"],"lastMessageAt":"2026-09-10T10:00:00Z","unread":1,"unreadMentions":1,"mutedUntil":"2099-01-01T00:00:00Z"},
           {"id":"t1","workspaceId":"wRel","kind":"group","name":"Hilo · horario","parentId":"r1","deriveKind":"same","memberIds":["me"],"unread":5},
           {"id":"x1","workspaceId":"wGuest","kind":"group","name":"Cohorte","memberIds":["me"],"lastMessageAt":"2026-09-26T10:00:00Z"},
           {"id":"p1","workspaceId":"wPend","kind":"group","name":"Proveedores","memberIds":["me"],"lastMessageAt":"2026-09-25T10:00:00Z"},
           {"id":"d1","kind":"direct","memberIds":["me","bob"],"lastMessageAt":"2026-09-27T11:00:00Z","unread":3}],
         "people":[{"id":"me","name":"Ana Ruiz","kind":"human","orgId":"oA"},{"id":"bob","name":"Bob","kind":"human","orgId":"oB"}]}
        """#)
    }

    func testListIsFlatOrderedAndLabeledCompanyGroup() throws {
        let list = Naming.groupsList(try boot())
        XCTAssertEqual(list.map(\.id), ["g2", "r1", "g1", "x1", "p1"], "sin hilos ni DMs; fijado, mención, no leído y luego actividad")
        let labels = Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0.label ?? "") })
        XCTAssertEqual(labels["g1"], "Xertify · Pagos", "Tu organización → mi empresa")
        XCTAssertEqual(labels["g2"], "Xertify interno", "si el nombre ya empieza por la empresa no se repite")
        XCTAssertEqual(labels["r1"], "Ongoing · Mentoría", "Relaciones → la contraparte")
        XCTAssertEqual(labels["p1"], "Nestlé · Proveedores", "relación pendiente → counterpartName")
        XCTAssertEqual(labels["x1"], "Acme · Cohorte", "Invitado en → la anfitriona")
        XCTAssertEqual(list.first { $0.id == "r1" }?.threadUnread, 5, "«💬 N» de sus hilos")
    }

    func testListLabelDoesNotRepeatCompany() {
        XCTAssertEqual(Naming.listLabel(company: "Xertify", group: "xertify · Pagos"), "xertify · Pagos")
        XCTAssertEqual(Naming.listLabel(company: "Nestlé", group: "Nestle compras"), "Nestle compras", "sin tildes ni mayúsculas")
        XCTAssertEqual(Naming.listLabel(company: nil, group: "Pagos"), "Pagos")
        XCTAssertEqual(Naming.listLabel(company: "Ongoing", group: "Pagos"), "Ongoing · Pagos")
    }

    func testBucketsPinnedUnreadRecentAndEmptyOnesHidden() throws {
        let list = Naming.groupsList(try boot())
        let b = InboxBucket.split(list, conv: \.conv, extraUnread: \.threadUnread)
        XCTAssertEqual(b.map(\.bucket), [.pinned, .unread, .recent])
        XCTAssertEqual(b.map { $0.items.map(\.id) }, [["g2"], ["r1", "g1"], ["x1", "p1"]])
        let onlyRecent = InboxBucket.split([try conv("a", at: "2026-09-01T00:00:00Z")], conv: { $0 })
        XCTAssertEqual(onlyRecent.map(\.bucket), [.recent], "un bloque vacío no sale")
        XCTAssertEqual(InboxBucket.of(try conv("m", unread: 2, muted: true, at: "x")), .recent, "silenciada sin mención cuenta como leída")
    }

    func testViewModeDefaultsToListAndPersists() throws {
        let defaults = UserDefaults(suiteName: "bandeja.\(UUID().uuidString)")!
        XCTAssertEqual(GroupsViewMode.load(defaults), .list)
        GroupsViewMode.save(.tree, defaults)
        XCTAssertEqual(defaults.string(forKey: "groupsView"), "tree")
        XCTAssertEqual(GroupsViewMode.load(defaults), .tree)
    }

    // MARK: D. Primer no leído

    private func msg(_ seq: Int, _ author: String = "bob", system: Bool = false, mentions: String = "") -> MessageDTO {
        try! dec(MessageDTO.self, #"{"id":"m\#(seq)","conversationId":"c","seq":\#(seq),"authorId":"\#(author)","kind":"\#(system ? "system" : "text")","body":"x","createdAt":"2026-09-27T10:00:00Z"\#(mentions.isEmpty ? "" : #","mentions":[{"userId":"\#(mentions)","start":0,"length":4}]"#)}"#)
    }

    func testFirstUnreadAfterLastRead() {
        let ms = [msg(1), msg(2, "me"), msg(3), msg(4, system: true), msg(5), msg(6)]
        let i = ChatNav.firstUnreadIndex(ms, snapshot: .init(lastReadSeq: 4, unread: 2), me: "me")
        XCTAssertEqual(i.map { ms[$0].seq }, 5)
        XCTAssertNil(ChatNav.firstUnreadIndex(ms, snapshot: .init(lastReadSeq: 6, unread: 0), me: "me"), "sin no leídos abre al final")
    }

    func testFirstUnreadSkipsMineAndSystem() {
        let ms = [msg(1), msg(2, "me"), msg(3, system: true), msg(4)]
        let i = ChatNav.firstUnreadIndex(ms, snapshot: .init(lastReadSeq: 1, unread: 1), me: "me")
        XCTAssertEqual(i.map { ms[$0].seq }, 4)
    }

    func testFirstUnreadNotLoadedNeedsOlderPages() {
        let ms = [msg(50), msg(51), msg(52)]
        let s = ChatNav.Snapshot(lastReadSeq: 10, unread: 42)
        XCTAssertNil(ChatNav.firstUnreadIndex(ms, snapshot: s, me: "me", hasMore: true))
        XCTAssertTrue(ChatNav.needsOlder(ms, snapshot: s, me: "me", hasMore: true))
        XCTAssertFalse(ChatNav.needsOlder(ms, snapshot: s, me: "me", hasMore: false), "sin más páginas: el primero cargado")
        XCTAssertEqual(ChatNav.firstUnreadIndex(ms, snapshot: s, me: "me", hasMore: false), 0)
        XCTAssertEqual(ChatNav.maxOlderPages, 3)
    }

    func testFirstUnreadFallbackUsesLastNWhenLastReadUnknown() {
        let ms = [msg(1), msg(2), msg(3, "me"), msg(4), msg(5)]
        let i = ChatNav.firstUnreadIndex(ms, snapshot: .init(lastReadSeq: 0, unread: 2), me: "me")
        XCTAssertEqual(i.map { ms[$0].seq }, 4, "los últimos `unread` mensajes de otros")
    }

    func testUnreadMentionsAndJumpThreshold() {
        let ms = [msg(1, mentions: "me"), msg(2), msg(3, mentions: "me"), msg(4, "me", mentions: "me"), msg(5, mentions: "all")]
        XCTAssertEqual(ChatNav.mentionIds(ms, after: 1, me: "me"), ["m3", "m5"], "solo después de lo leído, no las mías; @todos cuenta")
        XCTAssertFalse(ChatNav.showsJumpToLatest(distanceFromBottom: 300, viewport: 700))
        XCTAssertTrue(ChatNav.showsJumpToLatest(distanceFromBottom: 900, viewport: 700))
    }
}
