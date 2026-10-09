import XCTest
@testable import TieComs

/// Choques en el compositor con menciones (sidechat, emojis, tildes, menciones desfasadas) y exclusividad del store.
final class MentionSafetyTests: XCTestCase {
    private func u16(_ s: String) -> Int { (s as NSString).length }

    /// Menciones viejas (p. ej. al cancelar una edición) con un texto más corto: borrar no puede dar un rango fuera del texto.
    func testExpandDeletionNeverLeavesTheText() {
        let stale = [Mention(userId: "bob", start: 0, length: 12)]
        XCTAssertNil(MentionText.expandDeletion(NSRange(location: 0, length: 1), mentions: stale, length: u16("@")))
        XCTAssertNil(MentionText.expandDeletion(NSRange(location: 3, length: 2), mentions: [], length: 4), "rango pedido fuera del texto")
        let ok = MentionText.expandDeletion(NSRange(location: 5, length: 1), mentions: [Mention(userId: "bob", start: 0, length: 6)], length: 7)
        XCTAssertEqual(ok, NSRange(location: 0, length: 6), "una mención válida se sigue borrando entera")
    }

    func testClampedDropsNegativeOutOfBoundsAndOverlaps() {
        let ms = [Mention(userId: "a", start: -2, length: 4), Mention(userId: "b", start: 0, length: 3),
                  Mention(userId: "c", start: 2, length: 3), Mention(userId: "d", start: 4, length: 9), Mention(userId: "e", start: 3, length: 0)]
        XCTAssertEqual(MentionText.clamped(ms, length: 8).map(\.userId), ["b"])
    }

    func testReconcileAndInsertTolerateGarbageMentions() {
        let garbage = [Mention(userId: "x", start: -5, length: 3), Mention(userId: "y", start: 40, length: 6), Mention(userId: "z", start: 1, length: 2)]
        let r = MentionText.reconcile(old: "hola", new: "hol", mentions: garbage)
        XCTAssertTrue(r.mentions.allSatisfy { $0.start >= 0 && $0.end <= u16(r.text) })
        let i = MentionText.insert(name: "Bruno Ortega", userId: "bob", into: "¿Qué tal 😀 @br", replacing: 12, 15, mentions: garbage)
        XCTAssertTrue(i.mentions.allSatisfy { $0.start >= 0 && $0.end <= u16(i.text) })
        XCTAssertTrue(i.text.hasSuffix("@Bruno Ortega "))
        let bad = MentionText.insert(name: "Bruno", userId: "bob", into: "@b", replacing: 5, 9, mentions: garbage)
        XCTAssertEqual(bad.text, "@b")
        XCTAssertLessThanOrEqual(bad.cursor, 2)
    }

    /// Texto marcado (dictado, predicción) antes de un token: las menciones se corren sin tocar el texto.
    func testShiftDuringMarkedText() {
        let old = "@Bruno hola"
        let ms = [Mention(userId: "bob", start: 0, length: 6)]
        XCTAssertEqual(MentionText.shift(old: old, new: "¿Oye? @Bruno hola", mentions: ms), [Mention(userId: "bob", start: 6, length: 6)])
        XCTAssertEqual(MentionText.shift(old: old, new: "@Bruno hola 😀", mentions: ms), ms)
        XCTAssertEqual(MentionText.shift(old: old, new: "@Bru hola", mentions: ms), [], "la tocada se suelta")
    }

    /// Ediciones al azar sobre texto con emojis y tildes: nunca choca y las menciones siempre caben en el texto.
    func testRandomEditsKeepMentionsInsideText() {
        var rng = SystemRandomNumberGenerator()
        let pieces = ["a", "é", "ñ", "😀", "👩🏽‍💻", " ", "@", "¿", "\n"]
        for _ in 0..<400 {
            var text = ""
            var mentions: [Mention] = []
            for _ in 0..<25 {
                let len = u16(text)
                switch Int.random(in: 0..<5, using: &rng) {
                case 0, 1: text += pieces.randomElement(using: &rng)!
                case 2:
                    if let q = MentionText.activeQuery(in: text) {
                        let r = MentionText.insert(name: "Laura Gómez", userId: "l", into: text, replacing: q.start, len, mentions: mentions)
                        text = r.text; mentions = r.mentions
                    } else { text += " @" }
                case 3 where len > 0:
                    let loc = Int.random(in: 0..<len, using: &rng)
                    let range = NSRange(location: loc, length: min(Int.random(in: 1...3, using: &rng), len - loc))
                    let full = MentionText.expandDeletion(range, mentions: mentions, length: len) ?? range
                    XCTAssertLessThanOrEqual(full.location + full.length, len)
                    let new = (text as NSString).replacingCharacters(in: full, with: "")
                    let r = MentionText.reconcile(old: text, new: new, mentions: mentions)
                    text = r.text; mentions = r.mentions
                default:
                    // Menciones desfasadas a propósito (como tras cancelar una edición).
                    mentions.append(Mention(userId: "s", start: Int.random(in: -3...(len + 5), using: &rng), length: Int.random(in: -1...8, using: &rng)))
                }
                mentions = MentionText.clamped(mentions, length: u16(text))
                XCTAssertTrue(mentions.allSatisfy { $0.start >= 0 && $0.end <= u16(text) })
                _ = MentionText.valid(mentions, in: text)
                _ = MentionText.trimmed(text, mentions: mentions)
            }
        }
    }

    /// El closure de patchMeta/patchWorkspace puede leer el store: antes abortaba por exclusividad (`f(&data!…)`).
    @MainActor
    func testPatchClosuresCanReadTheStore() throws {
        let store = AppStore(baseURL: URL(string: "https://mock.tiecoms.test")!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: nil)
        store.seedForTesting(try JSONDecoder().decode(BootstrapDTO.self, from: Data(#"""
        {"contract":"x","serverTime":"","me":{"id":"me","name":"Ana"},"organizations":[],
         "workspaces":[{"id":"w","name":"W","owningOrgId":"o","organizationIds":["o"],"myRole":"member"}],
         "conversations":[{"id":"c","workspaceId":"w","kind":"group","name":"Pagos","memberIds":["me"]}],"people":[]}
        """#.utf8)))
        store.patchMeta("c") { c in
            c.name = "\(store.me?.name ?? "") · \(store.data?.conversations.count ?? 0) · \(store.meta("c")?.name ?? "")"
        }
        XCTAssertEqual(store.meta("c")?.name, "Ana · 1 · Pagos")
        store.patchWorkspace("w") { w in w.name = (store.data?.workspaces.first?.name ?? "") + "2" }
        XCTAssertEqual(store.data?.workspaces.first?.name, "W2")
        store.patchMeta("nope") { _ in XCTFail("no existe") }
    }
}
