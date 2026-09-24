import Foundation

/// Texto traído desde otra app (Compartir / Bring de la web): detecta el origen y,
/// si es un chat de WhatsApp exportado o copiado, lo separa en mensajes con su autor.
enum SharedText {
    struct Item: Equatable { var body: String; var forwarded: ForwardedInfo }
    struct Line: Equatable { var author: String; var sentAt: String; var body: String }

    // «[24/9/26, 10:12] Juan: texto» o «24/9/26 10:12 - Juan: texto» (mismo patrón que apps/web/src/screens/Bring.tsx).
    private static let waLine = try! NSRegularExpression(
        pattern: #"^‎?\[?(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?\s?m\.?)?)\]?\s*(?:-\s*)?([^:]{1,60}):\s([\s\S]*)$"#,
        options: [.caseInsensitive])

    static func parseWhatsApp(_ text: String) -> [Line] {
        var out: [Line] = []
        for raw in text.replacingOccurrences(of: "\r", with: "").components(separatedBy: "\n") {
            let ns = raw as NSString
            if let m = waLine.firstMatch(in: raw, range: NSRange(location: 0, length: ns.length)) {
                out.append(Line(author: ns.substring(with: m.range(at: 3)).trimmingCharacters(in: .whitespaces),
                                sentAt: "\(ns.substring(with: m.range(at: 1))) \(ns.substring(with: m.range(at: 2)))",
                                body: ns.substring(with: m.range(at: 4)).trimmingCharacters(in: .whitespaces)))
            } else if !out.isEmpty, !raw.trimmingCharacters(in: .whitespaces).isEmpty {
                out[out.count - 1].body += "\n\(raw)"
            }
        }
        return out.filter { !$0.body.isEmpty && $0.body.range(of: "^<(Multimedia omitido|Media omitted)>$", options: [.regularExpression, .caseInsensitive]) == nil }
    }

    static func emailFrom(_ text: String) -> String? {
        guard let r = text.range(of: #"(?im)^(?:De|From):\s*(.+)$"#, options: .regularExpression) else { return nil }
        return String(text[r]).replacingOccurrences(of: #"(?i)^(?:De|From):\s*"#, with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    }

    /// Origen probable por el formato del texto (la app que comparte no se conoce en iOS).
    static func detectSource(_ text: String) -> ForwardSource {
        if !parseWhatsApp(text).isEmpty { return .whatsapp }
        if emailFrom(text) != nil || text.range(of: #"(?im)^(?:Asunto|Subject):"#, options: .regularExpression) != nil { return .email }
        if text.contains("slack.com/archives") { return .slack }
        if text.contains("teams.microsoft.com") { return .teams }
        return .other
    }

    /// Mensajes a enviar: varios si es un chat de WhatsApp con más de una línea, si no uno solo.
    static func analyze(_ text: String, source: ForwardSource) -> [Item] {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        let lines = source == .whatsapp ? parseWhatsApp(trimmed) : []
        if lines.count > 1 {
            return lines.map { Item(body: $0.body, forwarded: ForwardedInfo(source: source, author: $0.author, sentAt: $0.sentAt)) }
        }
        let author = lines.first?.author ?? (source == .email ? emailFrom(trimmed) : nil)
        return [Item(body: String(trimmed.prefix(8000)), forwarded: ForwardedInfo(source: source, author: author, sentAt: lines.first?.sentAt))]
    }
}
