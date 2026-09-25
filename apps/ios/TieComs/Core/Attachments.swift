import AVFoundation
import Foundation
import UIKit
import UniformTypeIdentifiers

/// Adjuntos: límites, tipos y subida (la usan la app y la extensión Compartir).
enum AttachmentRules {
    static let maxBytes = 25 * 1024 * 1024
    static let maxPerMessage = 10
    static let maxShareTargets = 5

    static func mimeType(for url: URL) -> String {
        UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    }

    static func mimeType(for type: UTType) -> String { type.preferredMIMEType ?? "application/octet-stream" }

    static func sizeLabel(_ n: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(n), countStyle: .file)
    }

    /// Icono por tipo (SF Symbols).
    static func icon(_ contentType: String, _ name: String) -> String {
        if contentType.hasPrefix("image/") { return "photo" }
        if contentType.hasPrefix("video/") { return "film" }
        if contentType.hasPrefix("audio/") { return "waveform" }
        if contentType == "application/pdf" || name.lowercased().hasSuffix(".pdf") { return "doc.richtext" }
        if contentType.contains("sheet") || contentType.contains("excel") || name.lowercased().hasSuffix(".csv") { return "tablecells" }
        if contentType.contains("zip") { return "doc.zipper" }
        return "doc"
    }
}

/// Archivo local listo para subir.
struct LocalAttachment: Identifiable, Equatable {
    var id = UUID()
    var name: String
    var contentType: String
    var data: Data
    var sizeBytes: Int { data.count }
    var isImage: Bool { contentType.hasPrefix("image/") }
    var isVideo: Bool { contentType.hasPrefix("video/") }
    var tooBig: Bool { data.count > AttachmentRules.maxBytes }
}

enum Thumbnails {
    /// JPEG de 480 px de lado mayor (≤ 512 KB) para imágenes y el primer fotograma de videos.
    static func jpeg(for file: LocalAttachment) -> Data? {
        var image: UIImage?
        if file.isImage { image = UIImage(data: file.data) }
        else if file.isVideo {
            let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mov")
            try? file.data.write(to: tmp)
            defer { try? FileManager.default.removeItem(at: tmp) }
            let gen = AVAssetImageGenerator(asset: AVURLAsset(url: tmp))
            gen.appliesPreferredTrackTransform = true
            if let cg = try? gen.copyCGImage(at: .zero, actualTime: nil) { image = UIImage(cgImage: cg) }
        }
        guard let image, image.size.width > 0, image.size.height > 0 else { return nil }
        let k = min(1, 480 / max(image.size.width, image.size.height))
        let size = CGSize(width: (image.size.width * k).rounded(), height: (image.size.height * k).rounded())
        let fmt = UIGraphicsImageRendererFormat(); fmt.scale = 1; fmt.opaque = true
        let out = UIGraphicsImageRenderer(size: size, format: fmt).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        var q: CGFloat = 0.8
        var d = out.jpegData(compressionQuality: q)
        while let x = d, x.count > 512 * 1024, q > 0.3 { q -= 0.15; d = out.jpegData(compressionQuality: q) }
        return d
    }
}

extension APIClient {
    /// POST /conversations/:id/attachments (bytes; x-file-name URL-encoded y x-file-type). Queda pendiente hasta que un mensaje la use.
    func uploadAttachment(_ conversationId: String, _ file: LocalAttachment, progress: @escaping @Sendable (Double) -> Void) async throws -> AttachmentDTO {
        guard !file.tooBig else {
            throw ApiRequestError(status: 413, code: "too_large", message: L("att.tooBig", ["name": file.name]))
        }
        let name = file.name.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "archivo"
        var a: AttachmentDTO = try await uploadWithProgress("/conversations/\(conversationId)/attachments", data: file.data, contentType: "application/octet-stream",
                                                           headers: ["x-file-name": name, "x-file-type": file.contentType], progress: progress)
        // La miniatura la genera y sube el cliente (opcional): si falla, se usa la original.
        if file.isImage || file.isVideo, let thumb = Thumbnails.jpeg(for: file) {
            if let data = try? await requestData("/attachments/\(a.id)/thumb", method: "POST", body: .init(data: thumb, contentType: "application/octet-stream")) {
                let t = try? JSONDecoder().decode(ThumbResult.self, from: data)
                a.thumbUrl = t?.thumbUrl ?? "/api/v1/attachments/\(a.id)/thumb"
            }
        }
        return a
    }
}

private struct ThumbResult: Decodable {
    var thumbUrl: String?
    init(from decoder: Decoder) throws { thumbUrl = (try container(decoder)).o("thumbUrl") }
}
