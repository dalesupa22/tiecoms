import Foundation

/// Archivos de una tarea (1.7.14, mismo flujo que la web): cada archivo se sube a POST /issues/:id/attachments y
/// luego PATCH /issues/:id {attachmentIds: los de antes + los nuevos} los deja en la tarea. Máximo 20 por tarea.
enum TaskAttachmentRules {
    static let maxPerTask = 20

    /// Los ids que quedan en la tarea: los que ya tenía (en orden) y los nuevos, sin repetir.
    static func merged(_ existing: [AttachmentDTO], adding ids: [String]) -> [String] {
        var out = existing.map(\.id)
        for id in ids where !out.contains(id) { out.append(id) }
        return out
    }

    /// Error si con estos archivos la tarea pasaría del máximo o alguno pesa más de 25 MB.
    static func problem(existing: Int, adding files: [LocalAttachment]) -> String? {
        if existing + files.count > maxPerTask { return L("taskFiles.max", ["n": maxPerTask]) }
        if let big = files.first(where: \.tooBig) { return L("att.tooBig", ["name": big.name]) }
        return nil
    }

    /// Título de una tarea creada desde un archivo: el nombre sin la extensión («Contrato Nestlé.pdf» → «Contrato Nestlé»).
    static func title(fromFileName name: String) -> String {
        let base = (name as NSString).deletingPathExtension.trimmingCharacters(in: .whitespacesAndNewlines)
        let t = base.isEmpty ? name : base
        return String(t.replacingOccurrences(of: "_", with: " ").prefix(200))
    }
}

extension APIClient {
    func uploadIssueAttachment(_ issueId: String, _ file: LocalAttachment, progress: @escaping @Sendable (Double) -> Void) async throws -> AttachmentDTO {
        guard !file.tooBig else { throw ApiRequestError(status: 413, code: "too_large", message: L("att.tooBig", ["name": file.name])) }
        let name = file.name.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "archivo"
        return try await uploadWithProgress("/issues/\(issueId)/attachments", data: file.data, contentType: "application/octet-stream",
                                            headers: ["x-file-name": name, "x-file-type": file.contentType], progress: progress)
    }
}

@MainActor
extension AppStore {
    /// Sube y deja los archivos en la tarea. `progress` va de 0 a 1 sobre todos los archivos.
    @discardableResult
    func attachToIssue(_ issueId: String, files: [LocalAttachment], progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws -> IssueDTO? {
        guard !files.isEmpty else { return issues[issueId] }
        let existing = issues[issueId]?.attachments ?? []
        if let p = TaskAttachmentRules.problem(existing: existing.count, adding: files) { throw ApiRequestError(status: 400, code: "bad_request", message: p) }
        var ids: [String] = []
        let total = Double(files.count)
        for (n, f) in files.enumerated() {
            let a = try await api.uploadIssueAttachment(issueId, f) { p in progress((Double(n) + p) / total) }
            ids.append(a.id)
        }
        let current = issues[issueId]?.attachments ?? existing
        return try await updateIssue(issueId, ["attachmentIds": TaskAttachmentRules.merged(current, adding: ids)])
    }

    /// Copia archivos de un mensaje a una tarea (el API no deja reusar el adjunto de un mensaje): los baja y los vuelve a subir.
    func copyAttachmentsToIssue(_ issueId: String, _ atts: [AttachmentDTO], progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws {
        var files: [LocalAttachment] = []
        for a in atts {
            let d = try await AttachmentCache.shared.data(a.url, api: api)
            files.append(LocalAttachment(name: a.name, contentType: a.contentType, data: d))
        }
        try await attachToIssue(issueId, files: files, progress: progress)
    }

    /// Quitar un archivo de la tarea (PATCH con los demás).
    func removeIssueAttachment(_ issueId: String, _ attachmentId: String) async throws {
        guard let i = issues[issueId] else { return }
        try await updateIssue(issueId, ["attachmentIds": i.attachments.map(\.id).filter { $0 != attachmentId }])
    }
}
