import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }

/// SPEC-v4 H: menciones con @ — offsets UTF-16 con emojis y tildes, token que se borra entero, recorte, validación.
final class V6MentionTests: XCTestCase {
    private func u16(_ s: String) -> Int { (s as NSString).length }

    func testActiveQuery() {
        XCTAssertEqual(MentionText.activeQuery(in: "@")?.query, "")
        XCTAssertEqual(MentionText.activeQuery(in: "hola @La")?.query, "La")
        XCTAssertEqual(MentionText.activeQuery(in: "hola @La")?.start, 5)
        XCTAssertEqual(MentionText.activeQuery(in: "🎉🎉 @Gó")?.start, u16("🎉🎉 "), "offset en UTF-16 con emojis")
        XCTAssertNil(MentionText.activeQuery(in: "correo@dominio"), "no tras una letra")
        XCTAssertNil(MentionText.activeQuery(in: "hola"))
        XCTAssertNil(MentionText.activeQuery(in: "@uno dos tres cuatro"), "demasiadas palabras")
    }

    func testInsertWithEmojisAndAccents() {
        let r = MentionText.insert(name: "Laura Gómez", userId: "u1", into: "👋🏽 ¿lo ves @La", at: u16("👋🏽 ¿lo ves "), mentions: [])
        XCTAssertEqual(r.text, "👋🏽 ¿lo ves @Laura Gómez ")
        XCTAssertEqual(r.mentions, [Mention(userId: "u1", start: u16("👋🏽 ¿lo ves "), length: u16("@Laura Gómez"))])
        let ns = r.text as NSString
        XCTAssertEqual(ns.substring(with: NSRange(location: r.mentions[0].start, length: r.mentions[0].length)), "@Laura Gómez")
        XCTAssertEqual(MentionText.valid(r.mentions, in: r.text), r.mentions)
    }

    func testTokenDeletesWholeAndOthersShift() {
        var text = "Hola @Ana Ruiz y @Bo 😀"
        let ana = Mention(userId: "a", start: 5, length: u16("@Ana Ruiz"))
        let bo = Mention(userId: "b", start: u16("Hola @Ana Ruiz y "), length: 3)
        // Retroceso en la última letra de «@Ana Ruiz»: se borra el token completo y @Bo se corre.
        let backspaced = "Hola @Ana Rui y @Bo 😀"
        let r = MentionText.reconcile(old: text, new: backspaced, mentions: [ana, bo])
        XCTAssertEqual(r.text, "Hola  y @Bo 😀")
        XCTAssertEqual(r.mentions.map(\.userId), ["b"])
        XCTAssertEqual((r.text as NSString).substring(with: NSRange(location: r.mentions[0].start, length: 3)), "@Bo")
        // Escribir antes de un token lo corre sin tocarlo (con tildes).
        text = "@Bo ok"
        let r2 = MentionText.reconcile(old: text, new: "¡Ey! @Bo ok", mentions: [Mention(userId: "b", start: 0, length: 3)])
        XCTAssertEqual(r2.mentions, [Mention(userId: "b", start: u16("¡Ey! "), length: 3)])
        // Escribir después no lo toca.
        let r3 = MentionText.reconcile(old: "@Bo ", new: "@Bo hola", mentions: [Mention(userId: "b", start: 0, length: 3)])
        XCTAssertEqual(r3.mentions.count, 1)
        XCTAssertEqual(r3.text, "@Bo hola")
        // Escribir dentro del token lo rompe: se quita entero.
        let r4 = MentionText.reconcile(old: "x @Bo y", new: "x @Bxo y", mentions: [Mention(userId: "b", start: 2, length: 3)])
        XCTAssertEqual(r4.text, "x x y")
        XCTAssertTrue(r4.mentions.isEmpty)
    }

    func testTrimAndValidate() {
        let (t, ms) = MentionText.trimmed("  \n@Ana hola  ", mentions: [Mention(userId: "a", start: 3, length: 4)])
        XCTAssertEqual(t, "@Ana hola")
        XCTAssertEqual(ms, [Mention(userId: "a", start: 0, length: 4)])
        XCTAssertTrue(MentionText.valid([Mention(userId: "a", start: 1, length: 3)], in: "@Ana").isEmpty, "debe empezar con @")
        XCTAssertTrue(MentionText.valid([Mention(userId: "a", start: 0, length: 9)], in: "@Ana").isEmpty, "fuera del texto")
        let over = (0..<60).map { Mention(userId: "u\($0)", start: $0 * 3, length: 2) }
        XCTAssertEqual(MentionText.valid(over, in: String(repeating: "@a ", count: 60)).count, 50, "máx. 50")
    }

    func testDecodeAndMentionsMe() throws {
        let m = try dec(MessageDTO.self, #"{"id":"m","seq":1,"authorId":"b","body":"@Ana y @todos","createdAt":"","mentions":[{"userId":"me","start":0,"length":4},{"userId":"all","start":7,"length":6}]}"#)
        XCTAssertEqual(m.mentions.count, 2)
        XCTAssertTrue(m.mentions[1].isAll)
        XCTAssertTrue(MentionText.mentionsMe(m.mentions, me: "me", authorId: "b"))
        XCTAssertTrue(MentionText.mentionsMe([Mention(userId: "all", start: 0, length: 6)], me: "x", authorId: "b"), "@todos cuenta para todos")
        XCTAssertFalse(MentionText.mentionsMe([Mention(userId: "all", start: 0, length: 6)], me: "b", authorId: "b"), "menos el autor")
        XCTAssertEqual(try dec(MessageDTO.self, #"{"id":"x","seq":1,"authorId":"b","body":"hola","createdAt":""}"#).mentions, [], "mensajes viejos: sin campo")
        let c = try dec(ConversationDTO.self, #"{"id":"c","kind":"group","unread":3,"unreadMentions":1,"mutedUntil":"2099-01-01T00:00:00Z"}"#)
        XCTAssertEqual(c.unreadMentions, 1)
        XCTAssertEqual(HomeOrder.pending(c), 3, "una mención sube la conversación aunque esté silenciada")
        XCTAssertTrue(HomeFilter.mentions.includes(c))
        XCTAssertTrue(HomeFilter.unread.includes(c))
        XCTAssertTrue(MentionText.mutedForever(c))
        let page = try dec(MentionsPage.self, #"{"mentions":[{"message":{"id":"m","seq":4,"authorId":"b","body":"@Ana","createdAt":"2026-09-25T10:00:00Z"},"conversationId":"c","all":false,"read":false,"createdAt":"2026-09-25T10:00:00Z"}],"hasMore":true}"#)
        XCTAssertEqual(page.mentions.first?.conversationId, "c")
        XCTAssertTrue(page.hasMore)
        let push = PushPayload(userInfo: ["type": "mention", "conversationId": "c", "authorId": "b", "aps": ["alert": ["title": "Bob te mencionó", "body": "@Ana"], "category": "TC_MESSAGE"]])
        XCTAssertEqual(push?.kind, .mention)
    }

    func testAttributedHighlightsWithEmoji() {
        let text = "😀 @Ana mira"
        let m = Mention(userId: "a", start: u16("😀 "), length: 4)
        let out = MentionText.attributed(AttributedString(text), text: text, mentions: [m], mine: false)
        let linked = out.runs.filter { $0.link != nil }.map { String(out[$0.range].characters) }
        XCTAssertEqual(linked, ["@Ana"])
        XCTAssertEqual(out.runs.first { $0.link != nil }?.link, URL(string: "tiecoms-mention://a"))
    }

    func testPickerCandidatesAndAll() throws {
        let d = try dec(BootstrapDTO.self, #"""
        {"contract":"x","serverTime":"","me":{"id":"me","name":"Ana","kind":"human","primaryOrgId":"o"},"organizations":[],"workspaces":[],
         "conversations":[{"id":"c","kind":"multi","memberIds":["me","l","m"]},{"id":"d","kind":"direct","memberIds":["me","l"]}],
         "people":[{"id":"me","name":"Ana","kind":"human"},{"id":"l","name":"Laura Gómez","kind":"human"},{"id":"m","name":"Mateo Rivas","kind":"human"},
                   {"id":"x","name":"Lucía Fuera","kind":"human"}]}
        """#)
        let msgs = [MessageDTO(id: "1", conversationId: "c", seq: 1, authorId: "m", clientMessageId: nil, kind: "text", body: "a", createdAt: "")]
        XCTAssertEqual(MentionText.candidates(d, d.conversations[0], query: "", messages: msgs).map(\.id), ["m", "l"], "primero quien más escribe")
        XCTAssertEqual(MentionText.candidates(d, d.conversations[0], query: "gomez", messages: []).map(\.id), ["l"], "por apellido, sin tildes")
        XCTAssertTrue(MentionText.allowsAll(d.conversations[0]))
        XCTAssertFalse(MentionText.allowsAll(d.conversations[1]), "sin @todos en directos")
        XCTAssertEqual(MentionText.outsiders(d, d.conversations[0], query: "luc").map(\.id), ["x"])
    }

    /// Bug: cada mención con el color de SU persona; los enlaces http no toman ese color.
    func testEachMentionHasItsOwnColorAndLinksKeepAccent() {
        // Dos ids con colores distintos de la paleta.
        let a = "00000000-0000-0000-0000-000000000000", b = "3f2b8c1e-9a4d-4e21-8b7a-1c2d3e4f5a6b"
        XCTAssertNotEqual(PersonColor.index(a), PersonColor.index(b))
        let text = "@Ana 🎉 y @Bea mira https://tiecoms.com"
        let ma = Mention(userId: a, start: 0, length: 4)
        let mb = Mention(userId: b, start: u16("@Ana 🎉 y "), length: 4)
        let out = RichText.bubble(text, mentions: [ma, mb], mine: false, linkify: true)
        func rgba(_ c: Any?) -> [Int] {
            guard let c = (c as? UIColor)?.resolvedColor(with: UITraitCollection(userInterfaceStyle: .light)) else { return [] }
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, al: CGFloat = 0
            c.getRed(&r, green: &g, blue: &b, alpha: &al)
            return [r, g, b, al].map { Int(($0 * 255).rounded()) }
        }
        let ca = rgba(out.attribute(.foregroundColor, at: ma.start, effectiveRange: nil))
        let cb = rgba(out.attribute(.foregroundColor, at: mb.start, effectiveRange: nil))
        XCTAssertEqual(ca, rgba(UIColor(PersonColor.text(a))))
        XCTAssertEqual(cb, rgba(UIColor(PersonColor.text(b))))
        XCTAssertNotEqual(ca, cb, "cada mención con su color")
        let linkAt = u16("@Ana 🎉 y @Bea mira ") + 3
        XCTAssertEqual(rgba(out.attribute(.foregroundColor, at: linkAt, effectiveRange: nil)), rgba(UIColor(Theme.accentText)), "http con el color de enlace")
        XCTAssertNotEqual(rgba(out.attribute(.foregroundColor, at: linkAt, effectiveRange: nil)), ca)
        XCTAssertEqual(out.attribute(.link, at: linkAt, effectiveRange: nil) as? URL, URL(string: "https://tiecoms.com"))
        XCTAssertEqual(out.attribute(.link, at: mb.start, effectiveRange: nil) as? URL, URL(string: "tiecoms-mention://\(b)"))
        let bold = out.attribute(.font, at: ma.start, effectiveRange: nil) as? UIFont
        XCTAssertTrue(bold?.fontDescriptor.symbolicTraits.contains(.traitBold) == true)
        // En mi burbuja: blanco.
        XCTAssertEqual(rgba(RichText.bubble(text, mentions: [ma], mine: true, linkify: true).attribute(.foregroundColor, at: 0, effectiveRange: nil)), [255, 255, 255, 255])
    }

    func testInsertAtCursorAndExpandDeletion() {
        // Insertar en medio (cursor tras «@Be»): el resto del texto se conserva y la mención de después se corre.
        let text = "Hola @Be y @Ana 😀"
        let ana = Mention(userId: "a", start: u16("Hola @Be y "), length: 4)
        let r = MentionText.insert(name: "Beatriz Núñez", userId: "b", into: text, replacing: 5, 8, mentions: [ana])
        XCTAssertEqual(r.text, "Hola @Beatriz Núñez  y @Ana 😀")
        XCTAssertEqual(r.cursor, 5 + u16("@Beatriz Núñez "))
        XCTAssertEqual(r.mentions.map(\.userId), ["b", "a"])
        XCTAssertEqual((r.text as NSString).substring(with: NSRange(location: r.mentions[1].start, length: 4)), "@Ana")
        XCTAssertEqual(MentionText.activeQuery(in: String("Hola @Be y".utf16.prefix(8))!)?.query, "Be", "consulta hasta el cursor")
        // Retroceso dentro de un token: se amplía al token entero.
        XCTAssertEqual(MentionText.expandDeletion(NSRange(location: ana.end - 1, length: 1), mentions: [ana]), NSRange(location: ana.start, length: ana.length))
        XCTAssertNil(MentionText.expandDeletion(NSRange(location: 0, length: 1), mentions: [ana]), "fuera del token: normal")
        XCTAssertNil(MentionText.expandDeletion(NSRange(location: ana.end, length: 0), mentions: [ana]))
    }
}
