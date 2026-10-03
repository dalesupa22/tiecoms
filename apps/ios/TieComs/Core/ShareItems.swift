import Foundation
import UniformTypeIdentifiers

/// Lo que llega a la extensión Compartir: fotos, videos, archivos, enlaces y texto.
struct SharedItem: Identifiable, Equatable {
    enum Kind: String { case image, video, file, url, text }
    var id = UUID()
    var kind: Kind
    var name: String = ""
    var contentType: String = "application/octet-stream"
    var data: Data?
    var url: URL?
    var text: String?

    var isAttachment: Bool { kind == .image || kind == .video || kind == .file }
    var sizeBytes: Int { data?.count ?? 0 }
    var asAttachment: LocalAttachment? {
        guard isAttachment, let data else { return nil }
        return LocalAttachment(name: name.isEmpty ? "archivo" : name, contentType: contentType, data: data)
    }
}

enum ShareItems {
    /// Regla de activación de la extensión (la misma que va en NSExtensionActivationRule del Info.plist):
    /// fotos, videos, archivos, enlaces o texto, mezclados, hasta 10 adjuntos.
    static let activationRule = """
    SUBQUERY (extensionItems, $extensionItem, SUBQUERY ($extensionItem.attachments, $attachment, \
    ANY $attachment.registeredTypeIdentifiers UTI-CONFORMS-TO "public.image" \
    || ANY $attachment.registeredTypeIdentifiers UTI-CONFORMS-TO "public.movie" \
    || ANY $attachment.registeredTypeIdentifiers UTI-CONFORMS-TO "public.data" \
    || ANY $attachment.registeredTypeIdentifiers UTI-CONFORMS-TO "public.content" \
    || ANY $attachment.registeredTypeIdentifiers UTI-CONFORMS-TO "public.url" \
    || ANY $attachment.registeredTypeIdentifiers UTI-CONFORMS-TO "public.plain-text").@count >= 1 \
    AND SUBQUERY ($extensionItem.attachments, $attachment, \
    ANY $attachment.registeredTypeIdentifiers UTI-CONFORMS-TO "public.item").@count <= 10).@count >= 1
    """

    /// Qué es un proveedor según sus tipos registrados (orden de preferencia: foto, video, archivo, enlace, texto).
    static func kind(for typeIdentifiers: [String]) -> SharedItem.Kind? {
        let types = typeIdentifiers.compactMap(UTType.init)
        if types.contains(where: { $0.conforms(to: .image) }) { return .image }
        if types.contains(where: { $0.conforms(to: .movie) || $0.conforms(to: .video) }) { return .video }
        if types.contains(where: { $0.conforms(to: .fileURL) }) { return .file }
        if types.contains(where: { $0.conforms(to: .url) }) { return .url }
        if types.contains(where: { $0.conforms(to: .plainText) || $0.conforms(to: .text) }) { return .text }
        if types.contains(where: { $0.conforms(to: .data) || $0.conforms(to: .content) }) { return .file }
        return nil
    }

    /// Tipo a pedir al proveedor para obtener el archivo.
    static func loadType(for kind: SharedItem.Kind, typeIdentifiers: [String]) -> UTType {
        let types = typeIdentifiers.compactMap(UTType.init)
        switch kind {
        case .image: return types.first { $0.conforms(to: .image) } ?? .image
        case .video: return types.first { $0.conforms(to: .movie) } ?? .movie
        case .file: return types.first { $0.conforms(to: .data) && !$0.conforms(to: .url) } ?? .data
        case .url: return .url
        case .text: return .plainText
        }
    }

    /// Texto y enlaces unidos (sin duplicados) para el cuerpo del mensaje.
    static func text(of items: [SharedItem]) -> String {
        var seen = Set<String>()
        let parts = items.compactMap { i -> String? in
            switch i.kind {
            case .text: return i.text
            case .url: return i.url?.absoluteString
            default: return nil
            }
        }.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty && seen.insert($0).inserted }
        return parts.joined(separator: "\n")
    }

    /// Validación antes de enviar: máximo 10 adjuntos de hasta 25 MB cada uno.
    static func problems(_ items: [SharedItem]) -> [String] {
        var out: [String] = []
        let att = items.filter(\.isAttachment)
        if att.count > AttachmentRules.maxPerMessage { out.append(L("att.max", ["n": AttachmentRules.maxPerMessage])) }
        for i in att where i.sizeBytes > AttachmentRules.maxBytes { out.append(L("att.tooBig", ["name": i.name])) }
        return out
    }

    /// Nombre legible cuando el proveedor no trae uno.
    static func defaultName(kind: SharedItem.Kind, type: UTType, index: Int) -> String {
        let ext = type.preferredFilenameExtension ?? (kind == .image ? "jpg" : kind == .video ? "mov" : "bin")
        let base = kind == .image ? "foto" : kind == .video ? "video" : "archivo"
        return "\(base)-\(index + 1).\(ext)"
    }
}

/// Agrupado de destinos (función pura, se prueba en unitarias).
enum ShareSections {
    static func build(_ targets: [ShareTargets.Target], query: String, suggested: String?, recentCount: Int = 5) -> [(title: String, items: [ShareTargets.Target])] {
        let fold: (String) -> String = { $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }
        let q = fold(query.trimmingCharacters(in: .whitespaces))
        let list = targets.filter { q.isEmpty || fold($0.title).contains(q) || fold($0.group ?? $0.subtitle).contains(q) }
        let byRecent = list.sorted { ($0.lastMessageAt ?? "") > ($1.lastMessageAt ?? "") }
        var out: [(String, [ShareTargets.Target])] = []
        var used = Set<String>()
        if let s = suggested, let t = list.first(where: { $0.id == s }) { out.append((L("shareX.suggested"), [t])); used.insert(s) }
        if q.isEmpty {
            let recent = byRecent.filter { !used.contains($0.id) }.prefix(recentCount)
            if !recent.isEmpty { out.append((L("share.recent"), Array(recent))); used.formUnion(recent.map(\.id)) }
        }
        var groups: [String: [ShareTargets.Target]] = [:]
        var order: [String] = []
        var chats: [ShareTargets.Target] = []
        for t in byRecent where !used.contains(t.id) {
            if let g = t.group { if groups[g] == nil { order.append(g) }; groups[g, default: []].append(t) } else { chats.append(t) }
        }
        for g in order { out.append((g, groups[g]!)) }
        if !chats.isEmpty { out.append((L("side.directs"), chats)) }
        return out
    }
}


/// «Enviar en un grupo» de la extensión (1.7.13): solo si se eligieron 2 o más conversaciones y TODAS son
/// directos con una persona. Devuelve esas personas (sin repetir) para POST /chats; nil si no aplica y solo
/// queda «Enviar» por separado.
enum ShareGroupRule {
    static func peers(selected: [String], in targets: [ShareTargets.Target]) -> [String]? {
        guard selected.count >= 2 else { return nil }
        var out: [String] = []
        for id in selected {
            guard let t = targets.first(where: { $0.id == id }), t.kind == "direct", !t.isSide, let p = t.peerId else { return nil }
            if !out.contains(p) { out.append(p) }
        }
        return out.count >= 2 ? out : nil
    }
}


/// Selector de la extensión rediseñado (1.7.15): sin encabezados por empresa. Arriba «Recientes» (avatares), luego
/// «Chats» (directos y de varias personas) y «Grupos», cada uno por actividad; la empresa o el grupo van de subtítulo.
enum SharePicker {
    struct Lists: Equatable { var recents: [ShareTargets.Target]; var chats: [ShareTargets.Target]; var groups: [ShareTargets.Target] }

    static func lists(_ targets: [ShareTargets.Target], query: String, suggested: String?, recentCount: Int = 8) -> Lists {
        let fold: (String) -> String = { $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }
        let q = fold(query.trimmingCharacters(in: .whitespaces))
        let byRecent = targets.sorted { ($0.lastMessageAt ?? "") > ($1.lastMessageAt ?? "") }
        let list = byRecent.filter { q.isEmpty || fold($0.title).contains(q) || fold(subtitle($0)).contains(q) }
        var recents: [ShareTargets.Target] = []
        if q.isEmpty {
            if let s = suggested, let t = targets.first(where: { $0.id == s }) { recents.append(t) }
            for t in byRecent where recents.count < recentCount && !recents.contains(where: { $0.id == t.id }) { recents.append(t) }
        }
        let isChat: (ShareTargets.Target) -> Bool = { ($0.kind == "direct" || $0.kind == "multi") && !$0.isSide }
        return Lists(recents: recents, chats: list.filter(isChat), groups: list.filter { !isChat($0) })
    }

    /// «Empresa · Espacio» sin repetir («La Mafia · La Mafia» → «La Mafia») y sin repetir el propio nombre.
    static func subtitle(_ t: ShareTargets.Target) -> String {
        if t.isSide { return L("side.kind") }
        let raw = t.group ?? t.subtitle
        var parts: [String] = []
        for p in raw.components(separatedBy: " · ").map({ $0.trimmingCharacters(in: .whitespaces) }) where !p.isEmpty {
            if !parts.contains(where: { $0.caseInsensitiveCompare(p) == .orderedSame }) && p.caseInsensitiveCompare(t.title) != .orderedSame { parts.append(p) }
        }
        return parts.joined(separator: " · ")
    }
}
