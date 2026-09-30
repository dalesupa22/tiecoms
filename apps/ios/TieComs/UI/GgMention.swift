import SwiftUI
import UIKit

// @gg con colorcito multicolor (web 63e6b0f: Mentions.tsx GgMention/TextWithGg, chat17.ts ggRanges, .mention.is-gg).
// En las burbujas: la mención a gg (userId fijo) o «@gg» escrito a mano, como palabra, en negrita con el degradado
// #FF5A36 → #FFB23F → #FF4FA3 → #7B61FF → #2F8CFF y un brillo suave que se mueve (sin brillo con Reducir movimiento).
// En la burbuja propia (roja) va una pastilla blanca con el texto en degradado. En el compositor, un fondo tenue.

enum GGMention {
    static let colors: [UIColor] = [0xFF5A36, 0xFFB23F, 0xFF4FA3, 0x7B61FF, 0x2F8CFF].map { UIColor(hexRGB: $0) }

    /// Posiciones (UTF-16) de «@gg» como palabra: no dentro de un correo («ana@gg.com») ni de «@ggg».
    static func typedRanges(in text: String) -> [NSRange] {
        guard let re = try? NSRegularExpression(pattern: #"(^|[^\w@.])(@gg)(?![\w])"#, options: [.caseInsensitive]) else { return [] }
        let ns = text as NSString
        return re.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { $0.range(at: 2) }
    }

    /// Lo escrito a mano más las menciones estructuradas a gg, sin repetir.
    static func ranges(in text: String, mentions: [Mention]) -> [NSRange] {
        var out = MentionText.valid(mentions, in: text).filter { $0.userId == GG.id }.map { NSRange(location: $0.start, length: $0.length) }
        for r in typedRanges(in: text) where !out.contains(where: { NSIntersectionRange($0, r).length > 0 }) { out.append(r) }
        return out.sorted { $0.location < $1.location }
    }

    /// Degradado horizontal que se repite sin salto (el último color vuelve al primero): así el patrón se ve bien en
    /// cualquier posición del texto.
    static func patternColor(height: CGFloat, width: CGFloat = 44, alpha: CGFloat = 1) -> UIColor {
        let size = CGSize(width: max(8, width), height: max(8, height))
        let img = UIGraphicsImageRenderer(size: size).image { ctx in
            let cs = CGColorSpaceCreateDeviceRGB()
            let cols = (colors + [colors[0]]).map { $0.withAlphaComponent(alpha).cgColor } as CFArray
            let locs: [CGFloat] = [0, 0.22, 0.44, 0.66, 0.84, 1]
            if let g = CGGradient(colorsSpace: cs, colors: cols, locations: locs) {
                ctx.cgContext.drawLinearGradient(g, start: .zero, end: CGPoint(x: size.width, y: 0), options: [])
            }
        }
        return UIColor(patternImage: img)
    }

    /// Estilo de @gg sobre un texto ya armado (burbuja).
    static func apply(to out: NSMutableAttributedString, text: String, mentions: [Mention], mine: Bool, font: UIFont) {
        let rs = ranges(in: text, mentions: mentions)
        guard !rs.isEmpty else { return }
        let color = patternColor(height: font.lineHeight)
        for r in rs where NSMaxRange(r) <= out.length {
            out.addAttributes([.font: font, .foregroundColor: color], range: r)
            out.removeAttribute(.underlineStyle, range: r)
            // En la burbuja propia (roja) el degradado no se lee: pastilla blanca.
            if mine { out.addAttribute(.backgroundColor, value: UIColor.white, range: r) }
        }
    }

    /// Compositor: fondo tenue del mismo degradado.
    static func applyComposer(_ storage: NSTextStorage, mentions: [Mention], font: UIFont) {
        let rs = ranges(in: storage.string, mentions: mentions)
        guard !rs.isEmpty else { return }
        let bg = patternColor(height: font.lineHeight, alpha: 0.22)
        for r in rs where NSMaxRange(r) <= storage.length {
            storage.addAttributes([.backgroundColor: bg, .font: font], range: r)
        }
    }
}

extension UIColor {
    convenience init(hexRGB: Int) {
        self.init(red: CGFloat((hexRGB >> 16) & 0xFF) / 255, green: CGFloat((hexRGB >> 8) & 0xFF) / 255, blue: CGFloat(hexRGB & 0xFF) / 255, alpha: 1)
    }
}

/// Brillo que recorre cada @gg de una burbuja (capa encima del texto). Sin brillo con Reducir movimiento.
enum GGShimmer {
    static let layerName = "gg.shimmer"

    static func update(_ v: UITextView, ranges: [NSRange]) {
        v.layer.sublayers?.filter { $0.name == layerName }.forEach { $0.removeFromSuperlayer() }
        guard !ranges.isEmpty, !UIAccessibility.isReduceMotionEnabled else { return }
        let lm = v.layoutManager
        for r in ranges {
            let glyphs = lm.glyphRange(forCharacterRange: r, actualCharacterRange: nil)
            var rect = lm.boundingRect(forGlyphRange: glyphs, in: v.textContainer)
            guard rect.width > 0 else { continue }
            rect = rect.offsetBy(dx: v.textContainerInset.left, dy: v.textContainerInset.top)
            let g = CAGradientLayer()
            g.name = layerName
            g.frame = rect
            g.startPoint = CGPoint(x: 0, y: 0.5); g.endPoint = CGPoint(x: 1, y: 0.5)
            g.colors = [UIColor.white.withAlphaComponent(0).cgColor, UIColor.white.withAlphaComponent(0.55).cgColor, UIColor.white.withAlphaComponent(0).cgColor]
            g.locations = [-0.6, -0.3, 0]
            g.compositingFilter = "screenBlendMode"
            let a = CABasicAnimation(keyPath: "locations")
            a.fromValue = [-0.6, -0.3, 0]; a.toValue = [1, 1.3, 1.6]
            a.duration = 1.6; a.repeatCount = .infinity
            a.beginTime = CACurrentMediaTime() + 0.2
            a.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            g.add(a, forKey: "shine")
            v.layer.addSublayer(g)
        }
    }
}
