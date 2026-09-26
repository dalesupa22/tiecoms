import XCTest
@testable import TieComs

/// Decodificación tolerante: campos extra, nulos, tipos de evento desconocidos.
final class DecodingTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    static let conversationJSON = #"""
    {"id":"c1","workspaceId":"w1","kind":"group","level":null,"name":"General","internalOrgId":null,
     "memberIds":["u1","u2"],"lastMessageSeq":4,"lastEventSeq":6,"lastMessageAt":"2026-09-23T10:00:00.000Z",
     "lastMessagePreview":"hola","lastReadSeq":2,"unread":2,"canPost":true,"canManage":false,"historyFromSeq":0,
     "parentId":null,"parentMessageId":null,"parentMessageSeq":null,"deriveKind":null,"deriveReason":null,"returnedAt":null,
     "openIssues":3,"campoDelFuturo":{"x":[1,2,3]}}
    """#

    func testConversationWithExtraAndNewFields() throws {
        let c = try decode(ConversationDTO.self, Self.conversationJSON)
        XCTAssertEqual(c.id, "c1")
        XCTAssertEqual(c.kind, .group)
        XCTAssertEqual(c.unread, 2)
        XCTAssertEqual(c.openIssues, 3)
        XCTAssertEqual(c.lastEventSeq, 6)
    }

    func testConversationMinimalAndUnknownKind() throws {
        let c = try decode(ConversationDTO.self, #"{"id":"c2","kind":"canal-nuevo","canPost":null,"unread":"5"}"#)
        XCTAssertEqual(c.kind, .group)
        XCTAssertTrue(c.canPost)
        XCTAssertEqual(c.unread, 5)
        XCTAssertEqual(c.memberIds, [])
        XCTAssertEqual(c.lastEventSeq, 0)
        XCTAssertNil(c.workspaceId)
    }

    func testMessageWithMergedFromAndExtra() throws {
        let m = try decode(MessageDTO.self, #"""
        {"id":"m1","conversationId":"c1","seq":9,"authorId":"u1","clientMessageId":"x","kind":"text","body":"hola",
         "replyTo":null,"mergedFrom":"c9","createdAt":"2026-09-23T10:00:00.000Z","editedAt":null,"deletedAt":null,
         "reactions":[{"emoji":"👍"}]}
        """#)
        XCTAssertEqual(m.seq, 9)
        XCTAssertEqual(m.mergedFrom, "c9")
        XCTAssertFalse(m.isSystem)
    }

    func testBootstrapDropsBrokenItems() throws {
        let b = try decode(BootstrapDTO.self, #"""
        {"contract":"2026-09-23","serverTime":"2026-09-23T10:00:00Z","me":{"id":"u1","name":"Ana","kind":"human","primaryOrgId":"o1","extra":1},
         "organizations":[{"id":"o1","name":"A","mark":"A","colorBg":"#000","colorFg":"#fff","myRole":"owner"},{"sinId":true}],
         "workspaces":[],"conversations":[\#(Self.conversationJSON)],"people":[{"id":"u1","name":"Ana","kind":"human","orgId":"o1","guest":false}],
         "issues":[{"id":"i1"}]}
        """#)
        XCTAssertEqual(b.me.name, "Ana")
        XCTAssertEqual(b.organizations.count, 1, "el elemento sin id se descarta sin invalidar la respuesta")
        XCTAssertEqual(b.conversations.first?.openIssues, 3)
        XCTAssertEqual(b.people.first?.title, nil)
    }

    func testKnownEvents() throws {
        let created = try decode(ConversationEvent.self, #"""
        {"type":"message.created","conversationId":"c1","eventSeq":7,"message":{"id":"m1","conversationId":"c1","seq":3,"authorId":"u2","kind":"text","body":"hola","createdAt":"2026-09-23T10:00:00.000Z"}}
        """#)
        guard case .messageCreated(_, 7, let m) = created else { return XCTFail("\(created)") }
        XCTAssertEqual(m.body, "hola")

        let members = try decode(ConversationEvent.self, #"{"type":"members.changed","conversationId":"c1","eventSeq":8,"memberIds":["a","b"]}"#)
        XCTAssertEqual(members, .membersChanged(conversationId: "c1", eventSeq: 8, memberIds: ["a", "b"]))
    }

    func testUnknownRedactedAndBrokenEventsKeepSeq() throws {
        for json in [
            #"{"type":"issue.updated","conversationId":"c1","eventSeq":11,"issue":{"sinId":true}}"#,
            #"{"type":"redacted","conversationId":"c1","eventSeq":12}"#,
            #"{"type":"reaction.added","conversationId":"c1","eventSeq":13,"emoji":"🎉"}"#,
            // message.created con un mensaje ilegible: no se cae, solo avanza el cursor.
            #"{"type":"message.created","conversationId":"c1","eventSeq":14,"message":{"sinId":1}}"#,
        ] {
            let e = try decode(ConversationEvent.self, json)
            guard case .other = e else { return XCTFail("debería ser .other: \(json)") }
            XCTAssertEqual(e.conversationId, "c1")
            XCTAssertGreaterThan(e.eventSeq, 10)
        }
    }

    func testEventsPageWithMixedEvents() throws {
        let page = try decode(EventsPage.self, #"""
        {"events":[{"type":"redacted","conversationId":"c1","eventSeq":1},{"type":"futuro","conversationId":"c1","eventSeq":2},
          {"type":"message.created","conversationId":"c1","eventSeq":3,"message":{"id":"m","seq":1,"authorId":"u","body":"x","createdAt":""}}],
         "resetRequired":false,"lastEventSeq":3,"cursorNuevo":"abc"}
        """#)
        XCTAssertEqual(page.events.map(\.eventSeq), [1, 2, 3])
        XCTAssertFalse(page.resetRequired)
    }

    func testAccountEvents() throws {
        XCTAssertEqual(try decode(AccountEvent.self, #"{"type":"scope.changed","reason":"x"}"#), .scopeChanged(reason: "x"))
        XCTAssertEqual(try decode(AccountEvent.self, #"{"type":"read.updated","conversationId":"c","seq":4}"#), .readUpdated(conversationId: "c", seq: 4))
        XCTAssertEqual(try decode(AccountEvent.self, #"{"type":"nuevo.aviso"}"#), .other(type: "nuevo.aviso"))
    }

    func testAuthResultAndErrorBody() throws {
        let r = try decode(AuthResult.self, #"{"accessToken":"a","accessExpiresAt":"2026-09-23T10:15:00.000Z","refreshToken":"r","sessionId":"s","user":{"id":"u","name":"Ana"},"mfa":null}"#)
        XCTAssertEqual(r.refreshToken, "r")
        let e = APIClient.parseError(Data(#"{"error":{"code":"bad_request","message":"Datos inválidos","details":[{"path":"password","message":"corta"}]}}"#.utf8), status: 400)
        XCTAssertEqual(e.code, "bad_request")
        XCTAssertEqual(e.paths, ["password"])
        XCTAssertTrue(e.permanent)
        XCTAssertFalse(ApiRequestError(status: 429, code: "rate_limited", message: "").permanent)
        XCTAssertFalse(ApiRequestError(status: 401, code: "unauthorized", message: "").permanent)
    }

    func testSystemText() {
        XCTAssertEqual(L10n.systemText("texto plano"), "texto plano")
        let s = L10n.systemText(#"{"k":"group.created","name":"Obra"}"#)
        XCTAssertTrue(s.contains("Obra"), s)
        XCTAssertEqual(L10n.systemText(#"{"k":"clave.desconocida"}"#), #"{"k":"clave.desconocida"}"#)
    }

    func testMeetingSystemTextFormatsStartDate() {
        for key in ["event.created", "event.moved"] {
            let body = "{\"k\":\"\(key)\",\"title\":\"Revisión\",\"startsAt\":\"2026-09-24T21:00:00.000Z\"}"
            let text = L10n.systemText(body)
            XCTAssertTrue(text.contains("Revisión"), text)
            XCTAssertFalse(text.contains("{when}"), text)
            XCTAssertTrue(text.contains(L10n.dateTime(ISODate.parse("2026-09-24T21:00:00.000Z")!)), text)
        }
    }

    func testDeepLinks() {
        XCTAssertEqual(DeepLink.parse(URL(string: "tiecoms://c/abc-123")!), .conversation("abc-123"))
        XCTAssertEqual(DeepLink.parse(URL(string: "https://app.chaggu.com/c/abc-123")!), .conversation("abc-123"))
        XCTAssertEqual(DeepLink.parse(URL(string: "https://www.chaggu.com/w/w1")!), .workspace("w1"))
        XCTAssertEqual(DeepLink.parse(URL(string: "https://chaggu.com/invite/tok_en-1")!), .invite("tok_en-1"))
        XCTAssertEqual(DeepLink.parse(URL(string: "https://app.chaggu.com/signup?org=ORG123")!), .signup(orgToken: "ORG123"))
        XCTAssertEqual(conversationLink("abc-123"), "https://app.chaggu.com/c/abc-123", "los enlaces compartidos usan el dominio nuevo")
        XCTAssertNil(DeepLink.parse(URL(string: "https://evil.example/c/abc-123")!))
        // Dominio anterior: los enlaces ya compartidos siguen abriendo la app.
        XCTAssertEqual(DeepLink.parse(URL(string: "https://app.tiecoms.com/c/abc-123")!), .conversation("abc-123"))
        XCTAssertEqual(DeepLink.parse(URL(string: "https://www.tiecoms.com/w/w1")!), .workspace("w1"))
        XCTAssertEqual(DeepLink.parse(URL(string: "https://tiecoms.com/invite/tok_en-1")!), .invite("tok_en-1"))
        XCTAssertEqual(DeepLink.parse(URL(string: "tiecoms://invite/tok")!), .invite("tok"))
        XCTAssertEqual(DeepLink.parse(URL(string: "https://app.tiecoms.com/signup?org=ORG123")!), .signup(orgToken: "ORG123"))
        XCTAssertEqual(DeepLink.parse(URL(string: "tiecoms://signup?org=ORG123")!), .signup(orgToken: "ORG123"))
        XCTAssertNil(DeepLink.parse(URL(string: "https://evil.example.com/c/abc")!))
        XCTAssertNil(DeepLink.parse(URL(string: "https://app.tiecoms.com/")!))
        XCTAssertNil(DeepLink.parse(URL(string: "tiecoms://c/")!))
    }
}
