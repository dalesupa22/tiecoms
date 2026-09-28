import Foundation

extension AppStore {
    /// «Marcar como leído» desde la lista: el grupo y cada derivada pendiente, cada una hasta el seq que se conoce
    /// ahora mismo (un mensaje que llegue mientras tanto sigue sin leer). Optimista; el servidor emite read.updated
    /// por cada una y así se sincronizan los otros dispositivos.
    func markTreeRead(_ rootId: String) async throws {
        guard let d = data, let root = meta(rootId) else { return }
        let items = ReadTree.Index(d).items(for: root)
        for it in items {
            patchMeta(it.conversationId) { ReadTree.applyRead(&$0, seq: it.seq) }
            AppFeedback.shared.clearNotifications(conversationId: it.conversationId)
        }
        do {
            let r: ReadTreeResult = try await api.request("/conversations/\(rootId)/read-tree", method: "POST", json: ["items": items.map(\.json)])
            for m in r.marked { patchMeta(m.conversationId) { ReadTree.applyRead(&$0, seq: m.lastReadSeq) } }
        } catch let e as ApiRequestError where e.status == 404 && items.count > 0 {
            // API anterior a 2026-09-28 (sin read-tree): cada una por separado, con el mismo seq.
            for it in items { try await api.requestData("/conversations/\(it.conversationId)/read", method: "POST", json: ["seq": it.seq]) }
        } catch {
            // No quedó marcado: vuelve el estado del servidor.
            try? await loadBootstrap()
            throw error
        }
    }
}
