import Foundation
import UIKit
import ImageIO
import UniformTypeIdentifiers
import CryptoKit

enum MessageCopy {
    /// Only metadata-owned attribution is hidden; an arbitrary caption is never guessed away.
    static func body(_ body: String, attachments: [AttachmentDTO]) -> String {
        let credits = attachments.compactMap(\.provenance).map(\.attribution).filter { !$0.isEmpty }
        if credits.contains(body) { return "" }
        let joined = credits.joined(separator: "\n\n")
        return !joined.isEmpty && body == joined ? "" : body
    }
    @MainActor static func write(_ text: String, store: AppStore) {
        guard !text.isEmpty else { store.show(L("copy.empty")); return }
        UIPasteboard.general.string = text
        if UIPasteboard.general.string == text { store.show(L("toast.copied")) }
        else { store.show(L("copy.failed")) }
    }
}

enum LongMessageRules {
    static let maxUTF16 = 8000
    static let maxBytes = 1024 * 1024
    static func attachment(_ original: String) -> LocalAttachment? {
        let data = Data(original.utf8)
        guard !original.isEmpty, data.count <= maxBytes else { return nil }
        return LocalAttachment(name: "mensaje-\(UUID().uuidString.prefix(8)).txt", contentType: "text/plain; charset=utf-8", data: data, sourceText: original)
    }
}

/// Draft storage is scoped by server/account/conversation, never by the session token.
struct ComposerDraft: Codable {
    var text: String
    var mentions: [Mention]
    var files: [LocalAttachment]
    var gifs: [GifMediaItem]
    var voice: VoiceDraft?
    var updatedAt = Date()
}
struct VoiceDraft: Codable {
    var data: Data
    var durationMs: Int
    var waveform: [Double]
    var replyTo: String?
    var topicId: String?
    var viewOnce: Bool
    var aiConsent: Bool
}
enum ScopedPreference {
    static func key(server: String, account: String, purpose: String) -> String {
        let digest = SHA256.hash(data: Data((server + "|" + account).utf8)).map { String(format: "%02x", $0) }.joined()
        return "tc.\(purpose).\(digest)"
    }
}
enum DraftStorage {
    private static let lock = NSLock()
    // Disk writes serialize off-main; reserving the next draft never waits for file I/O.
    private static let writerLock = NSLock()
    nonisolated(unsafe) private static var generations: [URL: UInt64] = [:]
    static func reserve(_ url: URL) -> UInt64 {
        lock.lock(); defer { lock.unlock() }
        let value = (generations[url] ?? 0) &+ 1
        generations[url] = value
        return value
    }
    static func url(server: String, account: String, conversation: String) -> URL? {
        let scope = server + "|" + account + "|" + conversation
        let name = SHA256.hash(data: Data(scope.utf8)).map { String(format: "%02x", $0) }.joined()
        guard let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?.appendingPathComponent("ChatDrafts", isDirectory: true) else { return nil }
        return dir.appendingPathComponent(name + ".json")
    }
    static func save(_ draft: ComposerDraft, to url: URL, generation: UInt64? = nil) throws {
        let empty = draft.text.isEmpty && draft.files.isEmpty && draft.gifs.isEmpty && draft.voice == nil
        let bytes = empty ? nil : try JSONEncoder().encode(draft)
        writerLock.lock(); defer { writerLock.unlock() }
        lock.lock()
        let current = generation == nil || generations[url] == generation
        lock.unlock()
        guard current else { return }
        let dir = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        var mutable = dir; try? mutable.setResourceValues(values)
        if empty { if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }; return }
        try bytes?.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    static func load(_ url: URL) -> ComposerDraft? {
        guard let data = try? Data(contentsOf: url), data.count < 260 * 1024 * 1024 else { return nil }
        return try? JSONDecoder().decode(ComposerDraft.self, from: data)
    }
}

@MainActor enum ImageClipboard {
    static func copy(_ attachment: AttachmentDTO, store: AppStore) async {
        let stamp = store.sessionStamp
        do {
            guard attachment.isImage, attachment.sizeBytes <= AttachmentRules.maxBytes else { throw CocoaError(.fileReadTooLarge) }
            let data = try await store.api.download(attachment.url)
            guard stamp == store.sessionStamp, !Task.isCancelled else { return }
            let png = await Task.detached { () -> Data? in
                guard data.count <= AttachmentRules.maxBytes, let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary), let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any], let w = props[kCGImagePropertyPixelWidth] as? Int, let h = props[kCGImagePropertyPixelHeight] as? Int, w > 0, h > 0, w <= 16_000_000 / h, let cg = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
                return UIImage(cgImage: cg).pngData()
            }.value
            guard stamp == store.sessionStamp, !Task.isCancelled else { return }
            guard let png else { throw CocoaError(.fileReadCorruptFile) }
            // PNG is interoperable for Copy image. Share preserves the original animated GIF bytes.
            UIPasteboard.general.setItems([[UTType.png.identifier: png]], options: [.localOnly: true])
            guard UIPasteboard.general.hasImages else { throw CocoaError(.fileWriteUnknown) }
            store.show(L("copy.imageDone"))
        } catch { if stamp == store.sessionStamp { store.show(L10n.errorText(error)) } }
    }
}
