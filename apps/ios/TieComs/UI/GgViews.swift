import SwiftUI

// gg como chat (docs/GG-CHAT.md): la tarjeta del aviso {k:'gg.actions'} en el chat. Paridad con GgActionsRow y ActionCard
// de apps/web/src/screens/Assistant.tsx. Solo `forUserId` confirma (los tokens van firmados con su id); los demás ven una
// línea discreta «Para X: …».

extension GG {
    /// Mensaje de sistema {k:'gg.actions', forUserId, actions, suggestions}.
    struct ActionsPayload: Equatable {
        var forUserId: String
        var actions: [AssistantActionDTO]
        var suggestions: [String]
    }

    static func actions(_ m: MessageDTO) -> ActionsPayload? {
        guard m.isSystem, m.body.hasPrefix("{\"k\":\"gg.actions\""), let data = m.body.data(using: .utf8) else { return nil }
        struct Raw: Decodable { var k: String; var forUserId: String?; var actions: [AssistantActionDTO]?; var suggestions: [String]? }
        guard let r = try? JSONDecoder().decode(Raw.self, from: data), r.k == "gg.actions" else { return nil }
        return ActionsPayload(forUserId: r.forUserId ?? "", actions: r.actions ?? [], suggestions: r.suggestions ?? [])
    }
}

extension APIClient {
    /// Confirmar (o deshacer con undoToken) una acción de la tarjeta: el estado queda en el mensaje (message.updated).
    func ggRun(token: String, text: String? = nil, messageId: String, actionId: String) async throws {
        var body: [String: Any] = ["token": token, "messageId": messageId, "actionId": actionId]
        if let text { body["text"] = text }
        try await requestData("/assistant/run", method: "POST", json: body)
    }
    func ggDiscard(messageId: String, actionId: String) async throws {
        try await requestData("/assistant/actions/discard", method: "POST", json: ["messageId": messageId, "actionId": actionId])
    }
}

struct GgActionsRow: View {
    @Environment(AppStore.self) private var store
    let message: MessageDTO
    let payload: GG.ActionsPayload
    /// Cambios locales mientras llega message.updated.
    @State private var local: [String: AssistantActionDTO] = [:]

    var body: some View {
        let me = store.me?.id
        let mine = payload.forUserId == me
        VStack(alignment: .leading, spacing: 8) {
            ForEach(payload.actions) { base in
                let a = merged(base)
                if mine { card(a) } else {
                    Text(L("gg.forOther", ["name": MailUI.firstName(store.data.flatMap { Naming.person($0, payload.forUserId)?.name })]) + ": \(a.target) · \(a.text)")
                        .font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("gg.actions.other")
                }
            }
            if mine && !payload.suggestions.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(payload.suggestions, id: \.self) { s in
                            Button(s) { store.send(message.conversationId, body: s) }
                                .font(.caption.weight(.semibold)).buttonStyle(.bordered).controlSize(.small)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: 520, alignment: .leading)
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("gg.actions")
    }

    /// Lo que dice el mensaje manda cuando ya no está pendiente (otro dispositivo lo confirmó o descartó).
    private func merged(_ a: AssistantActionDTO) -> AssistantActionDTO {
        guard let l = local[a.id], a.status == .pending else { return a }
        return l
    }

    @ViewBuilder private func card(_ a: AssistantActionDTO) -> some View {
        let danger = a.kind == .cancelEvent
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(a.icon).font(.system(size: 15)).foregroundStyle(danger ? .red : Theme.accentText).accessibilityHidden(true)
                Text(a.target).font(.subheadline.weight(.semibold)).lineLimit(1)
                Spacer(minLength: 4)
                switch a.status {
                case .done: Text(L("ai.done")).font(.caption.weight(.semibold)).foregroundStyle(Theme.doneGreen)
                case .undone: Text(L("ai.undone")).font(.caption).foregroundStyle(Theme.textSecondary)
                case .failed: Text(L("ai.failed")).font(.caption.weight(.semibold)).foregroundStyle(.red)
                case .pending: EmptyView()
                }
            }
            if !a.text.isEmpty { Text(a.text).font(.subheadline).strikethrough(danger).fixedSize(horizontal: false, vertical: true) }
            if let d = a.detail, !d.isEmpty { Text(d).font(.caption).foregroundStyle(Theme.textSecondary) }
            if let e = a.error, !e.isEmpty { Text(e).font(.caption).foregroundStyle(.red) }
            if a.status == .pending {
                HStack(spacing: 6) {
                    Button(L(a.verbKey)) { run(a) }
                        .buttonStyle(.borderedProminent).tint(danger ? .red : Theme.primaryFill).controlSize(.small)
                        .accessibilityIdentifier("gg.confirm.\(a.id)")
                    Button(L("ai.discard")) { discard(a) }
                        .buttonStyle(.bordered).controlSize(.small)
                        .accessibilityIdentifier("gg.discard.\(a.id)")
                }
            } else if a.status == .done, let u = a.undoToken {
                Button(L("ai.undo")) { undo(a, u) }.buttonStyle(.bordered).controlSize(.small)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.surface))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke((danger ? Color.red : Theme.orange).opacity(0.3)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("gg.action.\(a.id)")
    }

    private func patch(_ a: AssistantActionDTO, _ f: (inout AssistantActionDTO) -> Void) {
        var x = local[a.id] ?? a
        f(&x)
        local[a.id] = x
    }

    private func run(_ a: AssistantActionDTO) {
        guard let token = a.token else { return }
        patch(a) { $0.status = .done; $0.error = nil }
        Task {
            do { try await store.api.ggRun(token: token, messageId: message.id, actionId: a.id) }
            catch { patch(a) { $0.status = .failed; $0.error = L10n.errorText(error) } }
        }
    }

    private func undo(_ a: AssistantActionDTO, _ token: String) {
        Task {
            do { try await store.api.ggRun(token: token, messageId: message.id, actionId: a.id); patch(a) { $0.status = .undone; $0.undoToken = nil } }
            catch { patch(a) { $0.error = L10n.errorText(error) } }
        }
    }

    private func discard(_ a: AssistantActionDTO) {
        patch(a) { $0.status = .failed; $0.error = L("ai.discarded"); $0.token = nil }
        Task { try? await store.api.ggDiscard(messageId: message.id, actionId: a.id) }
    }
}
