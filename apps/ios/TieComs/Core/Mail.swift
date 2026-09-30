import AuthenticationServices
import Foundation
import UIKit

// Correo y WhatsApp en el chat (docs/CORREO.md): llamadas al API y estado. Imita packages/client-core
// (putMail, lote de tarjetas de hasta 50, conectar con recibo + prueba PKCE como Reuniones).

/// Conectar Gmail/Outlook: la prueba PKCE vive solo en memoria mientras dura el flujo.
@MainActor
final class MailAuthorization {
    let id = UUID()
    let stamp: AppStore.SessionStamp
    let provider: MailProvider
    let proof: PKCE
    let connector: MailConnector
    var confirming = false
    init(stamp: AppStore.SessionStamp, provider: MailProvider, connector: MailConnector) {
        self.stamp = stamp; self.provider = provider; self.connector = connector
        var bytes = [UInt8](repeating: 0, count: 32)
        precondition(SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess)
        proof = PKCE(verifier: PKCE.base64url(Data(bytes)))
    }
}

/// La URL del proveedor en ASWebAuthenticationSession; vuelve por chaggu://mail/connected?….
@MainActor
final class MailConnector: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    private var completion: CheckedContinuation<MailCallback, Never>?

    func run(_ url: URL) async -> MailCallback {
        await withTaskCancellationHandler {
            await withCheckedContinuation { cont in
                guard !Task.isCancelled else { cont.resume(returning: .failed(nil, code: "cancelled")); return }
                completion = cont
                let s = ASWebAuthenticationSession(url: url, callbackURLScheme: SSOCallback.scheme) { [weak self] callback, error in
                    Task { @MainActor in
                        if let callback { self?.receive(callback) }
                        else {
                            let cancelled = (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin
                            self?.finish(.failed(nil, code: cancelled ? "cancelled" : "session"))
                        }
                    }
                }
                s.presentationContextProvider = self
                s.prefersEphemeralWebBrowserSession = false
                session = s
                if !s.start() { finish(.failed(nil, code: "session")) }
            }
        } onCancel: { Task { @MainActor [weak self] in self?.cancel() } }
    }

    func receive(_ url: URL) { finish(MailCallback.parse(url) ?? .failed(nil, code: "invalid_callback")) }
    func cancel() { session?.cancel(); finish(.failed(nil, code: "cancelled")) }
    private func finish(_ value: MailCallback) {
        let c = completion
        completion = nil; session = nil
        c?.resume(returning: value)
    }
    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.first.map { UIWindow(windowScene: $0) } ?? ASPresentationAnchor()
        }
    }
}

extension AppStore {
    var mailEnabled: Bool { data?.mailEnabled == true }

    // MARK: Tarjetas

    /// Guarda una tarjeta sin perder el cuerpo ya cargado (ni, en vivo, lo que solo ve su dueño).
    @discardableResult
    func putMail(_ m: SharedMailDTO, live: Bool = false) -> SharedMailDTO {
        let merged = SharedMailDTO.merge(m, into: mails[m.id], live: live)
        if mails[m.id] != merged { mails[m.id] = merged }
        mailsMissing.remove(m.id)
        return merged
    }

    /// Pide la tarjeta si no está: se juntan las del chat y salen en una sola petición (hasta 50 por lote).
    func wantMail(_ id: String) {
        guard mails[id] == nil, !mailsMissing.contains(id), !mailWanted.contains(id) else { return }
        mailWanted.append(id)
        guard !mailBatchScheduled else { return }
        mailBatchScheduled = true
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 30_000_000)
            await self?.flushMailBatch()
        }
    }

    private func flushMailBatch() async {
        let stamp = sessionStamp
        while !mailWanted.isEmpty {
            let batch = Array(mailWanted.prefix(50))
            mailWanted.removeFirst(batch.count)
            do {
                struct R: Decodable { var emails: [SharedMailDTO] }
                let r: R = try await api.request("/mail/shared?ids=\(batch.joined(separator: ","))")
                try requireSession(stamp)
                let got = Set(r.emails.map(\.id))
                for e in r.emails { putMail(e) }
                for id in batch where !got.contains(id) { mailsMissing.insert(id) }
            } catch {
                if (error as? ApiRequestError)?.status == 404 || (error as? ApiRequestError)?.status == 403 { batch.forEach { mailsMissing.insert($0) } }
                // Error de red: se vuelve a pedir cuando la tarjeta aparezca de nuevo.
            }
        }
        mailBatchScheduled = false
    }

    /// El correo con su cuerpo (al abrirlo).
    func loadSharedMailFull(_ id: String) async throws -> SharedMailDTO {
        let stamp = sessionStamp
        do {
            let m: SharedMailDTO = try await api.request("/mail/shared/\(id)?full=1")
            try requireSession(stamp)
            return putMail(m)
        } catch let e as ApiRequestError where e.status == 404 || e.status == 403 {
            mailsMissing.insert(id)
            throw e
        }
    }

    /// Correos sin leer de Recibidos › Principal/Prioritarios (tope 100), para la pastilla de «Todo».
    func mailUnread() async throws -> Int {
        struct R: Decodable { var unread: Int }
        let r: R = try await api.request("/mail/unread")
        return r.unread
    }

    /// El correo tal cual está en el buzón (historial citado y firma), en vivo y sin guardar.
    func mailOriginal(_ id: String) async throws -> String {
        struct R: Decodable { var body: String }
        let r: R = try await api.request("/mail/shared/\(id)/original")
        return r.body
    }

    /// El HTML del correo (ya limpio por el servidor) para verlo con su diseño; nil si solo tiene texto.
    /// Las imágenes vienen como rutas relativas /api/v1/mail/img/… (proxy firmado): se resuelven contra el origen del API.
    func mailHtml(_ id: String) async throws -> String? {
        struct R: Decodable { var html: String? }
        let r: R = try await api.request("/mail/shared/\(id)/html")
        return r.html.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
    }

    func mailComments(_ id: String) async throws -> [SharedMailCommentDTO] {
        struct R: Decodable { var comments: [SharedMailCommentDTO] }
        let r: R = try await api.request("/mail/shared/\(id)/comments")
        return r.comments
    }

    func commentMail(_ id: String, body: String) async throws -> SharedMailCommentDTO {
        struct R: Decodable { var comment: SharedMailCommentDTO; var email: SharedMailDTO }
        let r: R = try await api.request("/mail/shared/\(id)/comments", method: "POST", json: ["body": body])
        var e = r.email
        if e.scheduledReply == nil { e.scheduledReply = mails[id]?.scheduledReply }
        putMail(e)
        return r.comment
    }

    /// Descarga el adjunto (con Bearer) a un archivo temporal para QuickLook o Compartir.
    func mailAttachmentFile(_ emailId: String, _ a: MailAttachmentInfoDTO) async throws -> URL {
        let att = a.id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? a.id
        let data = try await api.download("/mail/shared/\(emailId)/attachments/\(att)")
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("mail-\(emailId)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let safe = a.name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
        let url = dir.appendingPathComponent(safe.isEmpty ? "adjunto" : safe)
        try data.write(to: url, options: .atomic)
        return url
    }

    func draftMailReply(_ id: String) async throws -> String {
        struct R: Decodable { var body: String }
        let r: R = try await api.request("/mail/shared/\(id)/draft", method: "POST", json: ["lang": L10n.lang == "en" ? "en" : "es"])
        return r.body
    }

    /// Responder ya (sin `sendAt`) o programar.
    func replyMail(_ id: String, body: String, cc: [String], attachmentIds: [String], sendAt: Date?) async throws {
        var json: [String: Any] = ["body": body, "cc": cc, "attachmentIds": attachmentIds, "notifyChat": true]
        if let sendAt { json["sendAt"] = ISODate.string(sendAt) }
        let m: SharedMailDTO = try await api.request("/mail/shared/\(id)/reply", method: "POST", json: json)
        putMail(m)
    }

    func cancelMailReply(_ id: String) async throws {
        let m: SharedMailDTO = try await api.request("/mail/shared/\(id)/reply", method: "DELETE")
        putMail(m)
    }

    func mailTask(_ id: String, title: String, ownerId: String?, dueDate: String?, closeOnReply: Bool) async throws -> IssueDTO {
        struct R: Decodable { var issue: IssueDTO; var email: SharedMailDTO }
        let r: R = try await api.request("/mail/shared/\(id)/task", method: "POST", json: [
            "title": title, "ownerId": ownerId ?? NSNull(), "dueDate": dueDate ?? NSNull(), "closeOnReply": closeOnReply])
        issues[r.issue.id] = r.issue
        recountIssues(r.issue.conversationId)
        putMail(r.email)
        return r.issue
    }

    // MARK: Buzón en vivo

    func mailConnections() async throws -> [MailConnectionDTO] {
        struct R: Decodable { var connections: [MailConnectionDTO] }
        let stamp = sessionStamp
        let r: R = try await api.request("/mail/connections")
        try requireSession(stamp)
        return r.connections
    }

    func listMail(_ p: MailProvider, _ f: MailFilters, page: String? = nil, fresh: Bool = false) async throws -> MailListDTO {
        try await api.request(f.path(p, page: page, fresh: fresh))
    }

    func getMail(_ p: MailProvider, _ id: String) async throws -> MailMessageDTO {
        try await api.request("/mail/messages/\(p.rawValue)/\(id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? id)")
    }

    /// Llevar a uno o varios chats (hasta 10; POST /mail/share con conversationIds → {emails}). Cada chat tiene su tarjeta.
    @discardableResult
    func shareMail(_ p: MailProvider, messageId: String, conversationIds: [String], comment: String) async throws -> [SharedMailDTO] {
        var json: [String: Any] = ["provider": p.rawValue, "messageId": messageId, "conversationIds": Array(conversationIds.prefix(10))]
        let c = comment.trimmingCharacters(in: .whitespacesAndNewlines)
        if !c.isEmpty { json["comment"] = String(c.prefix(4000)) }
        let data = try await api.requestData("/mail/share", method: "POST", json: json)
        return MailShareResult.decode(data).map { putMail($0) }
    }

    func shareWhatsApp(accountId: String, jid: String, messageId: String, conversationIds: [String], comment: String) async throws {
        var json: [String: Any] = ["accountId": accountId, "jid": jid, "messageId": messageId, "conversationIds": Array(conversationIds.prefix(10))]
        let c = comment.trimmingCharacters(in: .whitespacesAndNewlines)
        if !c.isEmpty { json["comment"] = String(c.prefix(4000)) }
        let data = try await api.requestData("/whatsapp/share", method: "POST", json: json)
        for e in MailShareResult.decode(data) { putMail(e) }
    }

    /// Reenviar una tarjeta a otros chats (hasta 10): cada uno recibe su copia con hilo propio (POST …/forward → {emails}).
    @discardableResult
    func forwardShared(_ emailId: String, conversationIds: [String], comment: String) async throws -> [SharedMailDTO] {
        var json: [String: Any] = ["conversationIds": Array(conversationIds.prefix(10))]
        let c = comment.trimmingCharacters(in: .whitespacesAndNewlines)
        if !c.isEmpty { json["comment"] = String(c.prefix(4000)) }
        let data = try await api.requestData("/mail/shared/\(emailId)/forward", method: "POST", json: json)
        return MailShareResult.decode(data).map { putMail($0) }
    }

    // MARK: Conectar

    func cancelMailAuthorization() {
        let old = mailAuthorization
        mailAuthorization = nil
        old?.connector.cancel()
    }

    /// POST /mail/connect/:provider → navegador del sistema → recibo → POST /mail/connect/confirm con la prueba.
    func connectMail(_ p: MailProvider) async throws -> MailCallback {
        cancelMailAuthorization()
        let flow = MailAuthorization(stamp: sessionStamp, provider: p, connector: MailConnector())
        guard flow.stamp.userId != nil else { throw CancellationError() }
        mailAuthorization = flow
        defer { if mailAuthorization?.id == flow.id { mailAuthorization = nil } }
        struct U: Decodable { var url: String }
        let r: U = try await api.request("/mail/connect/\(p.rawValue)", method: "POST", json: [
            "platform": "ios", "redirectScheme": SSOCallback.scheme, "proofChallenge": flow.proof.challenge])
        try requireMailAuthorization(flow)
        guard let url = URL(string: r.url), url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(url.host ?? "")) else {
            throw ApiRequestError(status: 502, code: "bad_url", message: L("mail.failedToast", ["code": "bad_url"]))
        }
        let callback = await flow.connector.run(url)
        try requireMailAuthorization(flow)
        guard case .receipt(let provider, let receipt) = callback else { return callback }
        guard provider == flow.provider, !flow.confirming else { return .failed(flow.provider, code: "invalid_callback") }
        flow.confirming = true
        struct C: Decodable { var ok: Bool; var provider: MailProvider }
        let c: C = try await api.request("/mail/connect/confirm", method: "POST", json: ["receipt": receipt, "proofVerifier": flow.proof.verifier])
        try requireMailAuthorization(flow)
        guard c.ok, c.provider == provider else { return .failed(provider, code: "invalid_callback") }
        mailRevision += 1
        return .connected(provider)
    }

    private func requireMailAuthorization(_ flow: MailAuthorization) throws {
        try requireSession(flow.stamp)
        guard mailAuthorization?.id == flow.id else { throw CancellationError() }
    }

    func disconnectMail(_ p: MailProvider) async throws {
        try await api.requestData("/mail/connections/\(p.rawValue)", method: "DELETE")
        mailRevision += 1
    }
}
