import SwiftUI

// Dentro del chat: lo que falta por leer en sus derivadas (docs/TANDA-LECTURA-REUNIONES.md §1).
// «⑂ 11 sin leer en 2 conversaciones de este grupo · Ver» abre la lista con nombre, cifra y «@» si hay mención.

/// Franja sobre los mensajes. No aparece si ninguna derivada tiene pendientes.
struct TreeUnreadStrip: View {
    @Environment(AppStore.self) private var store
    let conversationId: String
    var onOpen: () -> Void

    var body: some View {
        if let d = store.data, let c = store.meta(conversationId) {
            let list = ReadTree.Index(d).pendingDerived(of: c.id)
            if !list.isEmpty {
                let n = list.reduce(0) { $0 + $1.unread }
                let mention = list.contains { $0.unreadMentions > 0 }
                Button(action: onOpen) {
                    HStack(spacing: 6) {
                        Text(TreeText.strip(n: n, k: list.count, chat: c.kind.isChat))
                            .font(.footnote.weight(.semibold)).foregroundStyle(Theme.textPrimary)
                            .lineLimit(2).multilineTextAlignment(.leading)
                        if mention { MentionBadge() }
                        Spacer(minLength: 4)
                        Text("· " + L("tree.view")).font(.footnote.weight(.bold)).foregroundStyle(Theme.accentText).fixedSize()
                    }
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                    .background(Theme.orange.opacity(0.10))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(TreeText.strip(n: n, k: list.count, chat: c.kind.isChat) + (mention ? ", " + L("mention.youMentioned") : ""))
                .accessibilityHint(L("tree.view"))
                .accessibilityIdentifier("chat.treeStrip")
            }
        }
    }
}

enum TreeText {
    static func strip(n: Int, k: Int, chat: Bool) -> String {
        let key = chat ? (k == 1 ? "tree.stripChatOne" : "tree.stripChat") : (k == 1 ? "tree.stripOne" : "tree.strip")
        return L(key, ["n": n, "k": k])
    }
}

/// Lista de derivadas pendientes: cada una lleva a su conversación.
struct TreePendingSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let conversationId: String
    var onOpen: (String) -> Void

    var body: some View {
        NavigationStack {
            Group {
                if let d = store.data, let c = store.meta(conversationId) {
                    let list = ReadTree.Index(d).pendingDerived(of: c.id)
                    List {
                        if list.isEmpty {
                            Text(L("tree.allRead")).foregroundStyle(Theme.textSecondary).accessibilityIdentifier("tree.allRead")
                        }
                        ForEach(list) { x in
                            Button { dismiss(); onOpen(x.id) } label: {
                                HStack(spacing: 10) {
                                    ConvIcon(d: d, c: x, size: 28)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(Naming.title(d, x)).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.textPrimary)
                                            .lineLimit(2).multilineTextAlignment(.leading)
                                        if let p = L10n.listPreview(x) {
                                            Text(p).font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(1)
                                        }
                                    }
                                    Spacer(minLength: 4)
                                    if x.unreadMentions > 0 { MentionBadge() }
                                    if x.unread > 0 { UnreadPill(count: x.unread) }
                                }
                                .frame(minHeight: 44)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityElement(children: .combine)
                            .accessibilityIdentifier("tree.item.\(x.id)")
                        }
                        if !list.isEmpty {
                            Section {
                                Button {
                                    Task {
                                        do { try await store.markTreeRead(conversationId); store.show(L("toast.markedRead")); dismiss() }
                                        catch { store.show(L10n.errorText(error)) }
                                    }
                                } label: { Label(L("menu.markRead"), systemImage: "checkmark.circle") }
                                .accessibilityIdentifier("tree.markRead")
                            } footer: { Text(L("tree.markReadHint")) }
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle(L(store.meta(conversationId)?.kind.isChat == true ? "tree.titleChat" : "tree.title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L("common.close")) { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
}
