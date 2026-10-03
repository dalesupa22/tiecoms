import Foundation

/// Lo que la extensión «Compartir en chaggu» no puede terminar sola (1.7.15): crear una tarea eligiendo grupo o firmar
/// un PDF. Deja los archivos en el App Group (Handoff/<id>/) y abre chaggu://handoff/<id>. Si iOS no deja abrir la app
/// desde la extensión, la app lo retoma igual la próxima vez que se abra (pendiente de menos de 15 min).
/// Lo compilan la app y la extensión.
struct ShareHandoff: Codable, Equatable {
    enum Action: String, Codable { case task, sign }
    struct File: Codable, Equatable { var name: String; var contentType: String; var path: String }
    var id: String
    var action: Action
    var createdAt: Date
    var files: [File] = []
    /// Firmar: el PDF ya subido a «Tú» (para abrir el firmador con él).
    var attachment: AttachmentDTO?
    var conversationId: String?
    /// Texto o enlace compartido (título de la tarea si no hay archivo).
    var text: String?
}

enum ShareHandoffStore {
    static let maxAge: TimeInterval = 15 * 60

    static func root(_ base: URL? = nil) -> URL? {
        (base ?? FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: ShareTargets.suite))?
            .appendingPathComponent("Handoff", isDirectory: true)
    }

    static func url(_ id: String) -> URL { URL(string: "chaggu://handoff/\(id)")! }

    /// Guarda el pedido y sus archivos. Devuelve su id.
    @discardableResult
    static func save(_ action: ShareHandoff.Action, files: [LocalAttachment], attachment: AttachmentDTO? = nil, conversationId: String? = nil,
                     text: String? = nil, base: URL? = nil, now: Date = Date()) throws -> String {
        guard let root = root(base) else { throw CocoaError(.fileNoSuchFile) }
        let id = UUID().uuidString.lowercased()
        let dir = root.appendingPathComponent(id, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var list: [ShareHandoff.File] = []
        for (n, f) in files.enumerated() {
            let path = "\(n)-" + f.name.replacingOccurrences(of: "/", with: "-")
            try f.data.write(to: dir.appendingPathComponent(path), options: .atomic)
            list.append(.init(name: f.name, contentType: f.contentType, path: path))
        }
        let h = ShareHandoff(id: id, action: action, createdAt: now, files: list, attachment: attachment, conversationId: conversationId,
                              text: text.map { String($0.prefix(2000)) })
        try JSONEncoder().encode(h).write(to: dir.appendingPathComponent("manifest.json"), options: .atomic)
        return id
    }

    static func load(_ id: String, base: URL? = nil) -> (ShareHandoff, [LocalAttachment])? {
        guard id.count <= 64, id.allSatisfy({ $0.isHexDigit || $0 == "-" }), let root = root(base) else { return nil }
        let dir = root.appendingPathComponent(id, isDirectory: true)
        guard let d = try? Data(contentsOf: dir.appendingPathComponent("manifest.json")),
              let h = try? JSONDecoder().decode(ShareHandoff.self, from: d) else { return nil }
        let files = h.files.compactMap { f in
            (try? Data(contentsOf: dir.appendingPathComponent(f.path))).map { LocalAttachment(name: f.name, contentType: f.contentType, data: $0) }
        }
        return (h, files)
    }

    /// El pedido más reciente que sigue vigente (para retomarlo al abrir la app). Borra los vencidos.
    static func latestPending(base: URL? = nil, now: Date = Date()) -> String? {
        guard let root = root(base), let ids = try? FileManager.default.contentsOfDirectory(atPath: root.path) else { return nil }
        var best: (String, Date)?
        for id in ids {
            guard let (h, _) = load(id, base: base) else { consume(id, base: base); continue }
            if now.timeIntervalSince(h.createdAt) > maxAge { consume(id, base: base); continue }
            if best == nil || h.createdAt > best!.1 { best = (id, h.createdAt) }
        }
        return best?.0
    }

    static func consume(_ id: String, base: URL? = nil) {
        guard let root = root(base) else { return }
        try? FileManager.default.removeItem(at: root.appendingPathComponent(id, isDirectory: true))
    }
}

/// Las acciones de la primera pantalla de la extensión: cuáles salen según lo compartido.
enum ShareActionsRule {
    enum Action: String, CaseIterable { case send, sign, analyze, task, save }
    /// `attachments`: archivos/fotos (no texto ni enlaces). Firmar solo con un único PDF; gg, tarea y guardar con archivos.
    static func available(attachments: [SharedItem], hasText: Bool) -> [Action] {
        var out: [Action] = [.send]
        if attachments.count == 1, attachments[0].isPdf { out.append(.sign) }
        if !attachments.isEmpty { out += [.analyze, .task, .save] }
        else if hasText { out.append(.task) }
        return out
    }
    static let analyzePrompt = "share.analyzePrompt"
}

extension SharedItem {
    var isPdf: Bool { contentType == "application/pdf" || name.lowercased().hasSuffix(".pdf") }
}
