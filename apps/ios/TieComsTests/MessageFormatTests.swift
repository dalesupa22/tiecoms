import XCTest
@testable import TieComs

/// Formato básico en los mensajes (web 7b57ff9: fmt.tsx, bullets de Mentions.tsx y test/formatted.test.tsx).
@MainActor
final class MessageFormatTests: XCTestCase {
    private func kinds(_ s: String) -> [MessageFormat.Kind] { MessageFormat.parse(s).map(\.kind) }

    func testBoldItalicStrikeCode() {
        XCTAssertEqual(MessageFormat.display("para el *viernes*"), "para el viernes")
        XCTAssertEqual(kinds("para el *viernes*"), [.bold])
        XCTAssertEqual(kinds("la _plantilla_ ya"), [.italic])
        XCTAssertEqual(kinds("~Llamar~"), [.strike])
        XCTAssertEqual(kinds("sube `a.xlsx`"), [.code])
        XCTAssertEqual(MessageFormat.display("sube `a.xlsx` y *ya* ~no~ _más_"), "sube a.xlsx y ya no más")
        let sp = MessageFormat.parse("para el *viernes*")[0]
        XCTAssertEqual(sp.range, NSRange(location: 8, length: 9))
        XCTAssertEqual(sp.inner, NSRange(location: 9, length: 7))
        // Con palabras de varias letras y tildes/emojis antes (UTF-16).
        XCTAssertEqual(MessageFormat.display("👋 *Hola Ana*, ¿vienes?"), "👋 Hola Ana, ¿vienes?")
    }

    func testNotFormat() {
        XCTAssertEqual(MessageFormat.display("nombre_de_archivo.pdf"), "nombre_de_archivo.pdf")
        XCTAssertEqual(MessageFormat.display("2 * 3 * 4"), "2 * 3 * 4")
        XCTAssertEqual(MessageFormat.display("* suelto"), "• suelto")
        XCTAssertTrue(MessageFormat.parse("* suelto").isEmpty)
        // Sin espacio junto a la marca por dentro.
        XCTAssertTrue(MessageFormat.parse("* no * y _ no _").isEmpty)
        // Nada multilínea.
        XCTAssertTrue(MessageFormat.parse("*uno\ndos*").isEmpty)
        XCTAssertTrue(MessageFormat.parse("`a\nb`").isEmpty)
        // Pegado a una palabra por fuera.
        XCTAssertTrue(MessageFormat.parse("a*b*c").isEmpty)
        XCTAssertFalse(MessageFormat.hasFormat("hola mundo"))
        XCTAssertFalse(MessageFormat.hasFormat("snake_case_name"))
        XCTAssertTrue(MessageFormat.hasFormat("es *urgente*"))
    }

    func testBullets() {
        XCTAssertEqual(MessageFormat.bullets("Pendientes:\n- uno\n* dos\n  - tres"), "Pendientes:\n• uno\n• dos\n  • tres")
        XCTAssertEqual(MessageFormat.bullets("- uno"), "• uno")
        // Solo al inicio de línea y con texto después; misma longitud UTF-16.
        XCTAssertEqual(MessageFormat.bullets("a - b"), "a - b")
        XCTAssertEqual(MessageFormat.bullets("-  "), "-  ")
        let s = "- hola @Ana"
        XCTAssertEqual((MessageFormat.bullets(s) as NSString).length, (s as NSString).length)
    }

    func testMentionsAndLinksAreNotFormatted() {
        // «@Ana_Gómez» es una mención: su «_» no abre cursiva con otro «_» de afuera.
        let text = "hola @Ana_Gómez mira _esto_"
        let m = Mention(userId: "u1", start: 5, length: 10)
        let spans = RichText.formatSpans(text, mentions: [m])
        XCTAssertEqual(spans.map(\.kind), [.italic])
        XCTAssertEqual(spans.first?.range.location, 21)
        // Un enlace con guiones bajos no se toca.
        XCTAssertTrue(RichText.formatSpans("ver https://x.com/_a_/b", mentions: []).isEmpty)
        // La mención conserva su posición en el texto mostrado y las marcas se ocultan.
        let shown = RichText.bubble("*ojo* @Ana", mentions: [Mention(userId: "u1", start: 6, length: 4)], mine: false, linkify: true)
        XCTAssertEqual(shown.string, "ojo @Ana")
        let font = shown.attribute(.font, at: 4, effectiveRange: nil) as? UIFont
        XCTAssertTrue(font?.fontDescriptor.symbolicTraits.contains(.traitBold) == true)
        XCTAssertNotNil(shown.attribute(.link, at: 4, effectiveRange: nil))
        let bold = shown.attribute(.font, at: 0, effectiveRange: nil) as? UIFont
        XCTAssertTrue(bold?.fontDescriptor.symbolicTraits.contains(.traitBold) == true)
        // Rangos (brillo de @gg) corridos al texto sin marcas.
        XCTAssertEqual(RichText.displayRanges([NSRange(location: 6, length: 3)], text: "*ojo* @gg", mentions: []), [NSRange(location: 4, length: 3)])
    }

    func testCodeAndStrikeAttributes() {
        let a = RichText.bubble("usa `npm i` ~ya~", mentions: [], mine: true, linkify: true)
        XCTAssertEqual(a.string, "usa npm i ya")
        let code = a.attribute(.font, at: 4, effectiveRange: nil) as? UIFont
        XCTAssertTrue(code?.fontDescriptor.symbolicTraits.contains(.traitMonoSpace) == true)
        XCTAssertNotNil(a.attribute(.backgroundColor, at: 4, effectiveRange: nil))
        XCTAssertNotNil(a.attribute(.strikethroughStyle, at: 10, effectiveRange: nil))
    }

    func testComposerWrap() {
        let m = [Mention(userId: "u1", start: 0, length: 4)]
        let r = MessageFormat.wrap("@Ana ven hoy", selection: NSRange(location: 5, length: 3), mark: "*", mentions: m)
        XCTAssertEqual(r?.text, "@Ana *ven* hoy")
        XCTAssertEqual(r?.selection, NSRange(location: 6, length: 3))
        XCTAssertEqual(r?.mentions, m)
        // La mención después de la selección se corre 2; una dentro, 1.
        let r2 = MessageFormat.wrap("hola @Ana", selection: NSRange(location: 0, length: 9), mark: "_", mentions: [Mention(userId: "u1", start: 5, length: 4)])
        XCTAssertEqual(r2?.text, "_hola @Ana_")
        XCTAssertEqual(r2?.mentions, [Mention(userId: "u1", start: 6, length: 4)])
        let r3 = MessageFormat.wrap("hola @Ana", selection: NSRange(location: 0, length: 4), mark: "~", mentions: [Mention(userId: "u1", start: 5, length: 4)])
        XCTAssertEqual(r3?.mentions, [Mention(userId: "u1", start: 7, length: 4)])
        // Un borde dentro de la mención, sin selección o con saltos de línea: no se toca.
        XCTAssertNil(MessageFormat.wrap("@Ana ven", selection: NSRange(location: 2, length: 4), mark: "*", mentions: m))
        XCTAssertNil(MessageFormat.wrap("ven", selection: NSRange(location: 1, length: 0), mark: "*", mentions: []))
        XCTAssertNil(MessageFormat.wrap("a\nb", selection: NSRange(location: 0, length: 3), mark: "*", mentions: []))
    }
}
