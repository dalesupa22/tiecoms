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

    /// Error al subir un adjunto: 413 (límite del servidor) y red con su propio texto; siguen en el compositor.
    static func uploadErrorText(_ error: Error, name: String) -> String {
        if let e = error as? ApiRequestError {
            if e.code == "too_large", !e.message.isEmpty, e.status == 413, e.message.contains(name) { return e.message }
            if e.status == 413 || e.code == "http_413" { return L("att.uploadTooLarge", ["name": name]) }
            if e.isNetwork { return L("att.uploadNetwork", ["name": name]) }
        }
        return L("att.failed", ["name": name]) + ": " + L10n.errorText(error)
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
    var attribution: String? = nil
    var sizeBytes: Int { data.count }
    var isImage: Bool { contentType.hasPrefix("image/") }
    var isVideo: Bool { contentType.hasPrefix("video/") }
    var tooBig: Bool { data.count > AttachmentRules.maxBytes }
}

/// Fotos listas para enviar: orientación aplicada, lado mayor ≤ 2560 px y JPEG de ≤ ~2 MB (una foto de la cámara
/// sale de 3–12 MB). HEIC/HEIF y otros formatos pasan a JPEG para que se vean en web y Android. GIF y PNG pequeños no cambian.
enum ImagePrep {
    static let maxSide: CGFloat = 2560
    static let targetBytes = 2 * 1024 * 1024

    /// JPEG de una imagen (cámara o convertida). nil si no se puede codificar.
    static func jpeg(_ image: UIImage) -> Data? {
        guard image.size.width > 0, image.size.height > 0 else { return nil }
        let k = min(1, maxSide / max(image.size.width, image.size.height))
        let size = CGSize(width: (image.size.width * k).rounded(), height: (image.size.height * k).rounded())
        let fmt = UIGraphicsImageRendererFormat(); fmt.scale = 1; fmt.opaque = true
        // Dibujar aplica la orientación EXIF: el resultado queda derecho en cualquier visor.
        let out = UIGraphicsImageRenderer(size: size, format: fmt).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        var q: CGFloat = 0.82
        var d = out.jpegData(compressionQuality: q)
        while let x = d, x.count > targetBytes, q > 0.4 { q -= 0.12; d = out.jpegData(compressionQuality: q) }
        return d
    }

    /// Una imagen elegida (Fotos, Archivos): la deja lista para subir. nil si los bytes no son una imagen legible.
    static func prepare(_ data: Data, name: String, contentType: String) -> LocalAttachment? {
        let type = contentType.lowercased()
        let base = (name as NSString).deletingPathExtension
        if type == "image/gif" { return LocalAttachment(name: name, contentType: type, data: data) }
        guard let img = UIImage(data: data) else { return nil }
        let small = max(img.size.width, img.size.height) <= maxSide && data.count <= targetBytes && img.imageOrientation == .up
        if small && (type == "image/jpeg" || type == "image/png") { return LocalAttachment(name: name, contentType: type, data: data) }
        guard let jpg = jpeg(img) else { return nil }
        return LocalAttachment(name: "\(base.isEmpty ? "foto" : base).jpg", contentType: "image/jpeg", data: jpg)
    }
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
