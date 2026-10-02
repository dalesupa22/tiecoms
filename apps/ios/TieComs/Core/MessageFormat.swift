import Foundation

/// Formato básico en los mensajes, como la web (apps/web/src/fmt.tsx y `bullets` de Mentions.tsx, 7b57ff9):
/// *negrilla*, _cursiva_, ~tachado~ y `código`. Sin espacio junto a la marca por dentro, «_» dentro de una palabra
/// (nombre_archivo) no es cursiva y nada es multilínea. «- » o «* » al inicio de línea se ve como «• ».
/// Al mostrar, las marcas se ocultan (la web las deja tenues). Lógica pura: se prueba en `MessageFormatTests`.
enum MessageFormat {
    enum Kind: Equatable { case bold, italic, strike, code }

    /// Un tramo con formato. `range` incluye las dos marcas; `inner`, solo el texto (UTF-16 sobre el texto completo).
    struct Span: Equatable {
        var kind: Kind
        var range: NSRange
        var markerWidth = 1
        var inner: NSRange { NSRange(location: range.location + markerWidth, length: range.length - markerWidth * 2) }
    }

    /// Igual que FMT de la web.
    private static let pattern = try! NSRegularExpression(pattern: #"`[^`\n]+`|\*\*[^\s*](?:[^*\n]*[^\s*])?\*\*|\*[^\s*](?:[^*\n]*[^\s*])?\*|_[^\s_](?:[^_\n]*[^\s_])?_|~[^\s~](?:[^~\n]*[^\s~])?~"#)
    private static let bulletPattern = try! NSRegularExpression(pattern: #"(^|\n)([ \t]*)[-*] (?=\S)"#)

    /// Revisión barata antes del regex: ¿hay alguna marca?
    static func mightHaveFormat(_ text: String) -> Bool {
        text.utf8.contains { $0 == 0x2A || $0 == 0x5F || $0 == 0x7E || $0 == 0x60 }
    }

    private static let hasCache: NSCache<NSString, NSNumber> = { let c = NSCache<NSString, NSNumber>(); c.countLimit = 800; c.totalCostLimit = 2_000_000; return c }()

    /// ¿Se ve distinto con formato? (para decidir si la burbuja usa el texto enriquecido). Con caché: se pregunta en cada pintada.
    static func hasFormat(_ text: String) -> Bool {
        guard mightHaveFormat(text) else { return false }
        let k = text as NSString
        if let hit = hasCache.object(forKey: k) { return hit.boolValue }
        let v = !parse(text).isEmpty
        hasCache.setObject(NSNumber(value: v), forKey: k, cost: text.utf16.count * 2)
        return v
    }

    /// «- » o «* » al inicio de línea → «• ». Mide lo mismo (1 unidad UTF-16), así las menciones no se corren.
    static func bullets(_ text: String) -> String {
        guard text.contains("- ") || text.contains("* ") else { return text }
        let ns = text as NSString
        let literal = literalRanges(text)
        let out = NSMutableString(string: text)
        for m in bulletPattern.matches(in: text, range: NSRange(location: 0, length: ns.length)).reversed() {
            let offset = NSMaxRange(m.range) - 2
            if !literal.contains(where: { NSLocationInRange(offset, $0) }) { out.replaceCharacters(in: NSRange(location: offset, length: 1), with: "•") }
        }
        return out as String
    }

    /// Tramos con formato fuera de `blocked` (menciones, #grupos, @gg y enlaces): como la web, el formato se busca
    /// solo en el texto suelto entre ellos, y nunca los cruza.
    static func spans(in text: String, excluding blocked: [NSRange] = []) -> [Span] {
        guard mightHaveFormat(text) else { return [] }
        let ns = text as NSString
        var out: [Span] = []
        var cursor = 0
        let cuts = (blocked + CodeMessages.blocks(text).map(\.range)).filter { $0.length > 0 && $0.location >= 0 && NSMaxRange($0) <= ns.length }.sorted { $0.location < $1.location }
        func scan(_ lo: Int, _ hi: Int) {
            guard hi > lo else { return }
            let seg = ns.substring(with: NSRange(location: lo, length: hi - lo))
            out += parse(seg).map { Span(kind: $0.kind, range: NSRange(location: $0.range.location + lo, length: $0.range.length), markerWidth: $0.markerWidth) }
        }
        for b in cuts {
            if b.location > cursor { scan(cursor, b.location) }
            cursor = max(cursor, NSMaxRange(b))
        }
        scan(cursor, ns.length)
        return out
    }

    /// Un solo tramo de texto suelto (lo que hace `Formatted` de la web con `text.split(FMT)`).
    static func parse(_ text: String) -> [Span] {
        let ns = text as NSString
        let matches = pattern.matches(in: text, range: NSRange(location: 0, length: ns.length)).map(\.range)
        var out: [Span] = []
        for (i, r) in matches.enumerated() {
            // Lo que queda entre esta marca y la anterior / la siguiente (como parts[i-1] y parts[i+1]).
            let prevEnd = i > 0 ? NSMaxRange(matches[i - 1]) : 0
            let nextStart = i + 1 < matches.count ? matches[i + 1].location : ns.length
            let before = ns.substring(with: NSRange(location: prevEnd, length: r.location - prevEnd)).last
            let after = ns.substring(with: NSRange(location: NSMaxRange(r), length: nextStart - NSMaxRange(r))).first
            // «_» dentro de una palabra (nombre_archivo) no es cursiva; lo mismo con las demás marcas.
            if let c = before, c.isLetter || c.isNumber { continue }
            if let c = after, c.isLetter || c.isNumber { continue }
            let kind: Kind
            switch ns.character(at: r.location) {
            case 0x2A: kind = .bold
            case 0x5F: kind = .italic
            case 0x7E: kind = .strike
            default: kind = .code
            }
            let width = kind == .bold && ns.substring(with: r).hasPrefix("**") ? 2 : 1
            out.append(Span(kind: kind, range: r, markerWidth: width))
        }
        return out
    }

    /// Posiciones (UTF-16) de las marcas que se ocultan, de menor a mayor.
    static func hiddenOffsets(_ spans: [Span]) -> [Int] {
        spans.flatMap { sp in (0..<sp.markerWidth).flatMap { [sp.range.location + $0, NSMaxRange(sp.range) - 1 - $0] } }.sorted()
    }

    static func literalRanges(_ text: String) -> [NSRange] {
        let blocks = CodeMessages.blocks(text).map(\.range)
        return blocks + spans(in: text, excluding: blocks).filter { $0.kind == .code }.map(\.range)
    }

    /// Un rango del texto original en el texto ya sin marcas.
    static func map(_ r: NSRange, hidden: [Int]) -> NSRange {
        let before = hidden.filter { $0 < r.location }.count
        let inside = hidden.filter { $0 >= r.location && $0 < NSMaxRange(r) }.count
        return NSRange(location: r.location - before, length: max(0, r.length - inside))
    }

    /// El texto como se ve: viñetas y sin marcas.
    static func display(_ text: String, excluding blocked: [NSRange] = []) -> String {
        let t = bullets(text)
        let hidden = hiddenOffsets(spans(in: t, excluding: blocked))
        guard !hidden.isEmpty else { return t }
        let m = NSMutableString(string: t)
        for o in hidden.reversed() { m.deleteCharacters(in: NSRange(location: o, length: 1)) }
        return m as String
    }

    /// Compositor (⌘B / ⌘I / ⌘⇧X o Formato del menú): envuelve la selección en la marca y corre las menciones.
    /// nil si no hay selección, si ya tiene saltos de línea o si un borde cae dentro de una mención (se partiría).
    static func wrap(_ text: String, selection: NSRange, mark: String, mentions: [Mention]) -> (text: String, mentions: [Mention], selection: NSRange)? {
        let ns = text as NSString
        guard selection.length > 0, selection.location >= 0, NSMaxRange(selection) <= ns.length, [1, 2].contains((mark as NSString).length) else { return nil }
        let lo = selection.location, hi = NSMaxRange(selection), width = (mark as NSString).length
        guard !ns.substring(with: selection).contains("\n") else { return nil }
        for m in mentions where (m.start < lo && m.end > lo) || (m.start < hi && m.end > hi) { return nil }
        let out = ns.replacingCharacters(in: selection, with: mark + ns.substring(with: selection) + mark)
        let moved = mentions.map { m -> Mention in
            if m.start >= hi { return Mention(userId: m.userId, start: m.start + width * 2, length: m.length) }
            if m.start >= lo { return Mention(userId: m.userId, start: m.start + width, length: m.length) }
            return m
        }
        return (out, moved, NSRange(location: lo + width, length: selection.length))
    }
}
