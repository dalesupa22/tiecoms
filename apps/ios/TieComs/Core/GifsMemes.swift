import Foundation
import ImageIO
import UIKit

/// The catalog carries proxy URLs and provenance; custom meme captions stay on this device.
struct GifMediaItem: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let provider: String
    let title: String
    let previewUrl: String
    let url: String
    let width: Int
    let height: Int
    let attribution: String?
    let sourceUrl: String?
    let boxCount: Int?
}
struct GifCatalog: Decodable, Sendable {
    struct PoweredBy: Decodable, Sendable { let label: String; let url: String }
    let provider: String
    let items: [GifMediaItem]
    let next: String?
    let poweredBy: PoweredBy?
}
struct GifImport: Decodable, Sendable {
    let attachment: AttachmentDTO
    let attribution: String?
}

enum GifMediaRules {
    /// Only download through our authenticated API, never forward its Bearer to a catalog host.
    static func proxyPath(_ value: String, base: URL) -> String? {
        guard let u = URL(string: value) else { return nil }
        if u.scheme != nil {
            guard u.scheme == base.scheme, u.host == base.host, u.port == base.port else { return nil }
        } else if u.host != nil { return nil }
        guard u.path == "/api/v1/gifs/media", let query = u.query, !query.isEmpty else { return nil }
        return u.path + "?" + query
    }
    static func catalogPath(query: String, language: String, cursor: String? = nil) -> String {
        var c = URLComponents()
        c.path = query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "/gifs/trending" : "/gifs/search"
        c.queryItems = [URLQueryItem(name: "lang", value: language == "es" ? "es" : "en")]
        if c.path.hasSuffix("search") { c.queryItems?.append(URLQueryItem(name: "q", value: query.trimmingCharacters(in: .whitespacesAndNewlines))) }
        if let cursor { c.queryItems?.append(URLQueryItem(name: "cursor", value: cursor)) }
        return c.string!
    }
    static func body(_ text: String, attributions: [String]) -> String {
        var seen = Set<String>()
        let notes = attributions.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty && seen.insert($0).inserted }
        return ([text] + notes).filter { !$0.isEmpty }.joined(separator: "\n\n")
    }
}

extension APIClient {
    func gifCatalog(query: String, cursor: String? = nil) async throws -> GifCatalog {
        try await request(GifMediaRules.catalogPath(query: query, language: L10n.lang, cursor: cursor))
    }
    func memeTemplates() async throws -> GifCatalog { try await request("/memes/templates") }
    func gifMediaData(_ path: String) async throws -> Data {
        guard let proxy = GifMediaRules.proxyPath(path, base: baseURL) else { throw ApiRequestError(status: 400, code: "invalid_media", message: L("att.loadFailed")) }
        return try await download(proxy)
    }
    /// Import only after Send. This creates a pending attachment, then the ordinary chat send references it.
    func importGif(_ conversationId: String, item: GifMediaItem) async throws -> GifImport {
        guard GifMediaRules.proxyPath(item.url, base: baseURL) != nil else { throw ApiRequestError(status: 400, code: "invalid_media", message: L("att.loadFailed")) }
        return try await request("/conversations/\(conversationId)/gifs", method: "POST", json: ["url": item.url])
    }
}

struct GifAnimation: @unchecked Sendable {
    let identity = UUID()
    let frames: [UIImage]
    let delays: [TimeInterval]
    var duration: TimeInterval { delays.reduce(0, +) }
    /// Decode bounded thumbnails, rather than a full uncompressed GIF for every chat bubble.
    static func decode(_ data: Data, maxSide: Int = 640, maxPixels: Int = 2_000_000) -> GifAnimation? {
        guard data.count <= AttachmentRules.maxBytes,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              (CGImageSourceGetType(source) as String?) == "com.compuserve.gif" else { return nil }
        let count = CGImageSourceGetCount(source)
        guard count > 1, count <= 4096 else { return nil }
        let side = max(1, min(maxSide, Int(sqrt(Double(max(1, maxPixels)) / Double(count)))))
        var frames: [UIImage] = [], delays: [TimeInterval] = []
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: side,
                                       kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceShouldCacheImmediately: true]
        for i in 0..<count {
            guard let cg = CGImageSourceCreateThumbnailAtIndex(source, i, options as CFDictionary) else { return nil }
            let props = CGImageSourceCopyPropertiesAtIndex(source, i, nil) as? [CFString: Any]
            let gif = props?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
            let raw = gif?[kCGImagePropertyGIFUnclampedDelayTime] as? Double ?? gif?[kCGImagePropertyGIFDelayTime] as? Double ?? 0.1
            frames.append(UIImage(cgImage: cg)); delays.append(raw.isFinite && raw >= 0.02 ? min(raw, 10) : 0.1)
        }
        return GifAnimation(frames: frames, delays: delays)
    }
}

enum MemeRenderer {
    static let maxSide: CGFloat = 1280
    static let maxCaptionLength = 280
    /// Standard top / bottom outlined captions; no text is placed in a provider URL or request.
    static func image(template: UIImage, top: String, bottom: String) -> UIImage? {
        guard template.size.width > 0, template.size.height > 0 else { return nil }
        let scale = min(1, maxSide / max(template.size.width, template.size.height))
        let size = CGSize(width: max(1, (template.size.width * scale).rounded()), height: max(1, (template.size.height * scale).rounded()))
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
        return UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            UIColor.white.setFill(); ctx.fill(CGRect(origin: .zero, size: size))
            template.draw(in: CGRect(origin: .zero, size: size))
            draw(String(top.prefix(maxCaptionLength)), in: CGRect(x: size.width * 0.04, y: size.height * 0.03, width: size.width * 0.92, height: size.height * 0.3), bottom: false)
            draw(String(bottom.prefix(maxCaptionLength)), in: CGRect(x: size.width * 0.04, y: size.height * 0.67, width: size.width * 0.92, height: size.height * 0.3), bottom: true)
        }
    }
    private static func draw(_ text: String, in rect: CGRect, bottom: Bool) {
        guard !text.isEmpty else { return }
        let para = NSMutableParagraphStyle(); para.alignment = .center; para.lineBreakMode = .byWordWrapping
        var point = min(rect.width * 0.085, rect.height * 0.38)
        var attrs: [NSAttributedString.Key: Any] = [:]
        var bounds = CGRect.zero
        repeat {
            attrs = [.font: UIFont(name: "Impact", size: point) ?? UIFont.systemFont(ofSize: point, weight: .heavy), .foregroundColor: UIColor.white,
                     .strokeColor: UIColor.black, .strokeWidth: -4, .paragraphStyle: para]
            bounds = (text as NSString).boundingRect(with: rect.size, options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: attrs, context: nil)
            if bounds.height <= rect.height { break }
            point -= 1
        } while point > 8
        let y = bottom ? rect.maxY - min(rect.height, bounds.height) : rect.minY
        (text as NSString).draw(with: CGRect(x: rect.minX, y: y, width: rect.width, height: rect.height), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: attrs, context: nil)
    }
    static func attachment(template: UIImage, top: String, bottom: String, item: GifMediaItem) -> LocalAttachment? {
        guard let img = image(template: template, top: top, bottom: bottom), let data = ImagePrep.jpeg(img) else { return nil }
        return LocalAttachment(name: "meme.jpg", contentType: "image/jpeg", data: data,
                               attribution: item.attribution ?? item.sourceUrl.map { "\(item.title) · \($0)" })
    }
}
