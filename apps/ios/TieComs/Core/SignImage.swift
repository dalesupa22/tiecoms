import CoreGraphics
import CoreText
import UIKit

/// Firmas como PNG transparentes (igual que apps/web/src/sign-image.ts): recortar al trazo, quitar el fondo de una
/// foto (umbral de Otsu) y escribir el nombre en letra cursiva. Las funciones puras trabajan sobre RGBA sin
/// premultiplicar para poder probarlas.
enum SignImage {
    enum Ink: String, CaseIterable, Identifiable {
        case blue, black
        var id: String { rawValue }
        var rgb: (UInt8, UInt8, UInt8) { self == .blue ? (23, 42, 138) : (20, 20, 24) }
        var color: UIColor { let c = rgb; return UIColor(red: CGFloat(c.0) / 255, green: CGFloat(c.1) / 255, blue: CGFloat(c.2) / 255, alpha: 1) }
    }

    /// Pixeles RGBA (8 bits por canal, sin premultiplicar).
    struct Bitmap: Equatable {
        var width: Int
        var height: Int
        var data: [UInt8]
    }

    struct Rect: Equatable { var x, y, w, h: Int }

    /// Caja mínima con píxeles visibles (alfa > umbral). nil si está vacía.
    static func inkBounds(_ b: Bitmap, minAlpha: UInt8 = 12) -> Rect? {
        var x0 = b.width, y0 = b.height, x1 = -1, y1 = -1
        b.data.withUnsafeBufferPointer { p in
            for y in 0..<b.height {
                let row = y * b.width * 4
                for x in 0..<b.width where p[row + x * 4 + 3] > minAlpha {
                    if x < x0 { x0 = x }
                    if x > x1 { x1 = x }
                    if y < y0 { y0 = y }
                    if y > y1 { y1 = y }
                }
            }
        }
        return x1 < 0 ? nil : Rect(x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1)
    }

    @inline(__always) static func luma(_ d: UnsafeBufferPointer<UInt8>, _ i: Int) -> Double {
        0.299 * Double(d[i]) + 0.587 * Double(d[i + 1]) + 0.114 * Double(d[i + 2])
    }

    /// Umbral de Otsu sobre la luminancia. Con dos tonos bien separados muchos cortes empatan: se usa el punto medio
    /// entre las dos medias de clase.
    static func otsuThreshold(_ b: Bitmap) -> Int {
        var hist = [Double](repeating: 0, count: 256)
        let n = Double(b.data.count / 4)
        b.data.withUnsafeBufferPointer { p in
            var i = 0
            while i < p.count { hist[Int(luma(p, i).rounded())] += 1; i += 4 }
        }
        var sum = 0.0
        for t in 0..<256 { sum += Double(t) * hist[t] }
        var sumB = 0.0, wB = 0.0, best = 0.0, threshold = 128
        for t in 0..<256 {
            wB += hist[t]
            if wB == 0 { continue }
            let wF = n - wB
            if wF == 0 { break }
            sumB += Double(t) * hist[t]
            let mB = sumB / wB, mF = (sum - sumB) / wF
            let between = wB * wF * (mB - mF) * (mB - mF)
            if between > best { best = between; threshold = Int(((mB + mF) / 2).rounded()) }
        }
        return threshold
    }

    /// Foto → tinta: lo más claro que el umbral queda transparente; lo oscuro toma el color de la tinta (o el suyo si
    /// `color` es nil) con opacidad según qué tan oscuro es (bordes suaves).
    static func inkify(_ src: Bitmap, threshold: Int, color: (UInt8, UInt8, UInt8)?) -> Bitmap {
        var out = [UInt8](repeating: 0, count: src.data.count)
        let t = Double(threshold)
        let soft = max(8, t * 0.25)
        src.data.withUnsafeBufferPointer { p in
            var i = 0
            while i < p.count {
                let l = luma(p, i)
                let a = l >= t ? 0 : min(1, (t - l) / soft)
                if let color { out[i] = color.0; out[i + 1] = color.1; out[i + 2] = color.2 } else { out[i] = p[i]; out[i + 1] = p[i + 1]; out[i + 2] = p[i + 2] }
                out[i + 3] = UInt8((a * 255 * (Double(p[i + 3]) / 255)).rounded())
                i += 4
            }
        }
        return Bitmap(width: src.width, height: src.height, data: out)
    }

    // MARK: CGImage ↔ Bitmap

    /// Lee una imagen a RGBA sin premultiplicar (reduce a ≤ maxSide).
    static func bitmap(_ image: CGImage, maxSide: Int? = nil) -> Bitmap? {
        var w = image.width, h = image.height
        if let maxSide, max(w, h) > maxSide {
            let k = Double(maxSide) / Double(max(w, h))
            w = max(1, Int((Double(w) * k).rounded())); h = max(1, Int((Double(h) * k).rounded()))
        }
        var data = [UInt8](repeating: 0, count: w * h * 4)
        let ok = data.withUnsafeMutableBytes { raw -> Bool in
            guard let ctx = CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            ctx.interpolationQuality = .high
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard ok else { return nil }
        // Des-premultiplicar.
        var i = 0
        while i < data.count {
            let a = data[i + 3]
            if a > 0 && a < 255 {
                let k = 255 / Double(a)
                data[i] = UInt8(min(255, (Double(data[i]) * k).rounded()))
                data[i + 1] = UInt8(min(255, (Double(data[i + 1]) * k).rounded()))
                data[i + 2] = UInt8(min(255, (Double(data[i + 2]) * k).rounded()))
            }
            i += 4
        }
        return Bitmap(width: w, height: h, data: data)
    }

    static func cgImage(_ b: Bitmap) -> CGImage? {
        var pre = b.data
        var i = 0
        while i < pre.count {
            let a = Double(pre[i + 3]) / 255
            if a < 1 {
                pre[i] = UInt8((Double(pre[i]) * a).rounded()); pre[i + 1] = UInt8((Double(pre[i + 1]) * a).rounded()); pre[i + 2] = UInt8((Double(pre[i + 2]) * a).rounded())
            }
            i += 4
        }
        guard let provider = CGDataProvider(data: Data(pre) as CFData) else { return nil }
        return CGImage(width: b.width, height: b.height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: b.width * 4,
                       space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                       provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
    }

    /// PNG recortado al trazo (con margen `pad`) y reducido a ≤ maxW × maxH, con fondo transparente. nil si no hay trazo.
    static func trimmedPNG(_ image: CGImage, maxW: Int = 1200, maxH: Int = 600, pad: Int = 8) -> (png: Data, width: Int, height: Int)? {
        guard let b = bitmap(image), let r = inkBounds(b), r.w >= 4, r.h >= 4 else { return nil }
        let x = max(0, r.x - pad), y = max(0, r.y - pad)
        let w = min(b.width - x, r.w + pad * 2), h = min(b.height - y, r.h + pad * 2)
        guard let crop = image.cropping(to: CGRect(x: x, y: y, width: w, height: h)) else { return nil }
        let k = min(1, Double(maxW) / Double(w), Double(maxH) / Double(h))
        let ow = max(8, Int((Double(w) * k).rounded())), oh = max(8, Int((Double(h) * k).rounded()))
        let fmt = UIGraphicsImageRendererFormat()
        fmt.scale = 1; fmt.opaque = false
        let out = UIGraphicsImageRenderer(size: CGSize(width: ow, height: oh), format: fmt).image { ctx in
            ctx.cgContext.interpolationQuality = .high
            UIImage(cgImage: crop).draw(in: CGRect(x: 0, y: 0, width: ow, height: oh))
        }
        guard var png = out.pngData() else { return nil }
        // Límite del servidor: 512 KB. Una firma rara vez pasa de 60 KB; si pasa, se achica.
        var side = Double(max(ow, oh))
        while png.count > SignLimits.maxBytes, side > 200 {
            side *= 0.8
            let kk = side / Double(max(ow, oh))
            let sz = CGSize(width: (Double(ow) * kk).rounded(), height: (Double(oh) * kk).rounded())
            let small = UIGraphicsImageRenderer(size: sz, format: fmt).image { _ in out.draw(in: CGRect(origin: .zero, size: sz)) }
            guard let d = small.pngData() else { break }
            png = d
        }
        guard let final = UIImage(data: png)?.cgImage else { return nil }
        return (png, final.width, final.height)
    }

    // MARK: Letra cursiva

    /// Letras de Google Fonts (licencia OFL, en Resources/Fonts) para la firma escrita.
    enum Script: String, CaseIterable, Identifiable {
        case dancing = "Dancing Script", vibes = "Great Vibes", caveat = "Caveat"
        var id: String { rawValue }
        /// Peso 600 en las fuentes variables (como la web).
        func font(size: CGFloat) -> UIFont {
            var attrs: [UIFontDescriptor.AttributeName: Any] = [.family: rawValue]
            if self != .vibes {
                let wght = 0x77676874 // 'wght'
                attrs[UIFontDescriptor.AttributeName(rawValue: kCTFontVariationAttribute as String)] = [wght: 600]
            }
            let f = UIFont(descriptor: UIFontDescriptor(fontAttributes: attrs), size: size)
            return f.familyName == rawValue ? f : (UIFont(name: "SnellRoundhand", size: size) ?? .italicSystemFont(ofSize: size))
        }
        var available: Bool { UIFont.fontNames(forFamilyName: rawValue).isEmpty == false }
    }

    /// Texto en cursiva → imagen transparente lista para recortar.
    static func typed(_ text: String, script: Script, ink: Ink) -> CGImage? {
        let size: CGFloat = 140
        let font = script.font(size: size)
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: ink.color]
        let measured = (text as NSString).size(withAttributes: attrs)
        let canvas = CGSize(width: min(2000, ceil(measured.width) + 80), height: (size * 1.8).rounded())
        let fmt = UIGraphicsImageRendererFormat()
        fmt.scale = 1; fmt.opaque = false
        return UIGraphicsImageRenderer(size: canvas, format: fmt).image { _ in
            (text as NSString).draw(at: CGPoint(x: 40, y: (canvas.height - measured.height) / 2), withAttributes: attrs)
        }.cgImage
    }

    // MARK: Foto

    struct PhotoResult { var image: CGImage; var threshold: Int; var auto: Int }

    /// Foto de una firma en papel → tinta sobre transparente. threshold nil = automático (Otsu + 10, máx. 235).
    static func photo(_ image: UIImage, ink: Ink?, threshold: Int?) -> PhotoResult? {
        // Dibujar aplica la orientación EXIF.
        let k = min(1, 1600 / max(image.size.width, image.size.height, 1))
        let size = CGSize(width: max(1, (image.size.width * k).rounded()), height: max(1, (image.size.height * k).rounded()))
        let fmt = UIGraphicsImageRendererFormat()
        fmt.scale = 1; fmt.opaque = true
        let upright = UIGraphicsImageRenderer(size: size, format: fmt).image { ctx in
            UIColor.white.setFill(); ctx.fill(CGRect(origin: .zero, size: size))
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        guard let cg = upright.cgImage, let b = bitmap(cg) else { return nil }
        let auto = otsuThreshold(b)
        let t = threshold ?? min(235, auto + 10)
        guard let out = cgImage(inkify(b, threshold: t, color: ink?.rgb)) else { return nil }
        return PhotoResult(image: out, threshold: t, auto: auto)
    }
}
