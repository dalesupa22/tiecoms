import Foundation

/// Texto de un correo para leerlo en el chat, como apps/web/src/mail-text.ts (7b57ff9). Los correos HTML pasados a
/// texto traen el «alt» y la dirección de cada imagen («header-logo [http://…/header.png]») y enlaces largos: las
/// imágenes se quitan y los enlaces quedan como «dominio ↗» tocable. Lógica pura: `MailBodyTextTests`.
enum MailBodyText {
    enum Part: Equatable {
        case text(String)
        case link(href: String, label: String)
    }

    private static let linkRe = try! NSRegularExpression(pattern: #"\[(https?://[^\]\s]+)\]|<(https?://[^>\s]+)>|(\bhttps?://[^\s<>"'\]]+)"#, options: [.caseInsensitive])
    private static let imgRe = try! NSRegularExpression(pattern: #"\.(png|jpe?g|gif|svg|webp|bmp)(\?|#|$)|/(img|images?|pixel|track|open)\b"#, options: [.caseInsensitive])
    /// Línea que solo es el «alt» de una imagen: una palabra sin espacios tipo header-logo, img_footer, spacer.
    private static let altLineRe = try! NSRegularExpression(pattern: #"^[\t ]*[A-Za-z0-9_.-]*(logo|img|image|banner|icon|spacer|header|footer|pixel)[A-Za-z0-9_.-]*[\t ]*$"#, options: [.caseInsensitive, .anchorsMatchLines])
    private static let trailRe = try! NSRegularExpression(pattern: #"[.,;:!?)\]}»”’]+$"#)

    private static func replace(_ re: NSRegularExpression, in s: String, with t: String) -> String {
        re.stringByReplacingMatches(in: s, range: NSRange(location: 0, length: (s as NSString).length), withTemplate: t)
    }
    private static func replace(_ pattern: String, in s: String, with t: String) -> String {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return s }
        return replace(re, in: s, with: t)
    }

    static func isImage(_ url: String) -> Bool {
        imgRe.firstMatch(in: url, range: NSRange(location: 0, length: (url as NSString).length)) != nil
    }

    static func host(_ url: String) -> String {
        if let h = URL(string: url)?.host, !h.isEmpty { return h.hasPrefix("www.") ? String(h.dropFirst(4)) : h }
        return String(url.prefix(40))
    }

    static func parts(_ raw: String) -> [Part] {
        let ns = raw as NSString
        var out: [Part] = []
        var last = 0
        for m in linkRe.matches(in: raw, range: NSRange(location: 0, length: ns.length)) {
            let g = (1...3).first { m.range(at: $0).location != NSNotFound } ?? 3
            let url = ns.substring(with: m.range(at: g))
            var trail = ""
            if g == 3, let t = trailRe.firstMatch(in: url, range: NSRange(location: 0, length: (url as NSString).length)) {
                trail = (url as NSString).substring(with: t.range)
            }
            let href = trail.isEmpty ? url : (url as NSString).substring(to: (url as NSString).length - (trail as NSString).length)
            out.append(.text(ns.substring(with: NSRange(location: last, length: m.range.location - last))))
            if !isImage(href) { out.append(.link(href: href, label: host(href))) }
            if !trail.isEmpty { out.append(.text(trail)) }
            last = NSMaxRange(m.range)
        }
        out.append(.text(ns.substring(from: last)))
        // Se juntan los textos seguidos y se limpian las líneas que quedaron vacías o con solo el «alt» de la imagen.
        var joined: [Part] = []
        for p in out {
            if case .text(let t) = p, case .text(let prev)? = joined.last { joined[joined.count - 1] = .text(prev + t); continue }
            joined.append(p)
        }
        joined = joined.map { p in
            guard case .text(var t) = p else { return p }
            t = replace(altLineRe, in: t, with: "")
            t = replace(#"[ \t]+\n"#, in: t, with: "\n")
            t = replace(#"\n{3,}"#, in: t, with: "\n\n")
            return .text(t)
        }
        if case .text(let t)? = joined.first { joined[0] = .text(replace(#"^\s+"#, in: t, with: "")) }
        if case .text(let t)? = joined.last { joined[joined.count - 1] = .text(replace(#"\s+$"#, in: t, with: "")) }
        return joined
    }

    /// Resumen de una línea sin direcciones ni «alt» de imágenes.
    static func snippet(_ raw: String) -> String {
        let s = parts(raw).map { p -> String in if case .text(let t) = p { return t }; return "" }.joined(separator: " ")
        return replace(#"\s+([.,;:!?)])"#, in: replace(#"\s+"#, in: s, with: " "), with: "$1").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// El cuerpo para `Text`: los enlaces como «dominio ↗» tocables (abren Safari) y sin las imágenes.
    static func attributed(_ raw: String) -> AttributedString {
        var out = AttributedString()
        for p in parts(raw) {
            switch p {
            case .text(let t): out += AttributedString(t)
            case .link(let href, let label):
                var a = AttributedString(label + " ↗")
                a.link = URL(string: href)
                out += a
            }
        }
        return out
    }
}
