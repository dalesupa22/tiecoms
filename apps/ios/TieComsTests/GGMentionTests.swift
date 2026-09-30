import XCTest
import UIKit
@testable import TieComs

/// @gg multicolor (web 63e6b0f, chat17.ts ggRanges): detección de «@gg» como palabra y de la mención estructurada a gg.
@MainActor
final class GGMentionTests: XCTestCase {
    private func words(_ s: String) -> [String] { GGMention.typedRanges(in: s).map { (s as NSString).substring(with: $0) } }

    func testTypedDetection() {
        XCTAssertEqual(words("@gg ayúdame"), ["@gg"])
        XCTAssertEqual(words("Hola @gg, ¿puedes?"), ["@gg"])
        XCTAssertEqual(words("oye @GG"), ["@GG"], "sin importar mayúsculas")
        XCTAssertEqual(words("(@gg)"), ["@gg"])
        XCTAssertEqual(words("@gg y @gg"), ["@gg", "@gg"])
        XCTAssertTrue(words("ana@gg.com").isEmpty, "no dentro de un correo")
        XCTAssertTrue(words("@ggg").isEmpty, "no «@ggg»")
        XCTAssertTrue(words("@gg_bot").isEmpty)
        XCTAssertTrue(words("x.@gg").isEmpty)
        XCTAssertTrue(words("gg sin arroba").isEmpty)
        // Posiciones UTF-16 (con emojis antes).
        let s = "😀 @gg"
        XCTAssertEqual(GGMention.typedRanges(in: s).first, NSRange(location: 3, length: 3))
    }

    func testStructuredMentionAndNoDuplicates() {
        let text = "@gg revisa esto y @gg también"
        let m = Mention(userId: GG.id, start: 0, length: 3)
        let r = GGMention.ranges(in: text, mentions: [m])
        XCTAssertEqual(r.map(\.location), [0, 18], "la estructurada y la escrita, sin repetir")
        let other = Mention(userId: "ana", start: 18, length: 3)
        XCTAssertEqual(GGMention.ranges(in: "@Ana y nada más", mentions: [Mention(userId: "ana", start: 0, length: 4)]), [], "otra persona no")
        _ = other
    }

    func testBubbleStylesGradientAndPillOnMine() {
        let text = "Hola @gg"
        let theirs = RichText.bubble(text, mentions: [], mine: false, linkify: false)
        let r = NSRange(location: 5, length: 3)
        let fg = theirs.attribute(.foregroundColor, at: 5, effectiveRange: nil) as? UIColor
        XCTAssertNotNil(fg); XCTAssertNotEqual(fg, UIColor(Theme.textPrimary), "con el degradado")
        XCTAssertTrue(((theirs.attribute(.font, at: 5, effectiveRange: nil) as? UIFont)?.fontDescriptor.symbolicTraits.contains(.traitBold)) == true, "en negrita")
        XCTAssertNil(theirs.attribute(.backgroundColor, at: 5, effectiveRange: nil))
        let mine = RichText.bubble(text, mentions: [], mine: true, linkify: false)
        XCTAssertEqual(mine.attribute(.backgroundColor, at: 5, effectiveRange: nil) as? UIColor, .white, "pastilla blanca en la burbuja propia")
        XCTAssertNil(mine.attribute(.backgroundColor, at: 0, effectiveRange: nil), "el resto sin pastilla")
        _ = r
    }
}
