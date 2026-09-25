import SwiftUI

/// Lista sobre el compositor al escribir «@»: participantes (los que más escriben primero), «@todos» en grupos y,
/// si coincide alguien que no está en el chat, «Añadir» (si puedo administrar) o «Preguntarle en un sidechat».
struct MentionPicker: View {
    let d: BootstrapDTO
    let c: ConversationDTO
    let query: String
    let messages: [MessageDTO]
    var onPick: (String, String) -> Void
    var onAdd: (PersonDTO) -> Void
    var onAskSide: (PersonDTO) -> Void

    var body: some View {
        let people = Array(MentionText.candidates(d, c, query: query, messages: messages).prefix(6))
        let fold: (String) -> String = { $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }
        let q = fold(query)
        let showAll = MentionText.allowsAll(c) && (q.isEmpty || fold(L("mention.all")).hasPrefix(q) || "todos".hasPrefix(q) || "all".hasPrefix(q))
        let outsiders = people.isEmpty ? MentionText.outsiders(d, c, query: query) : []
        VStack(alignment: .leading, spacing: 0) {
            Text(L("mention.picker")).font(.caption.weight(.semibold)).foregroundStyle(Theme.textSecondary)
                .padding(.horizontal, 14).padding(.top, 8).padding(.bottom, 4)
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(people) { p in
                        Button { onPick(p.name, p.id) } label: {
                            HStack(spacing: 10) {
                                Avatar(person: p, org: Naming.org(d, p.orgId), size: 30)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(p.name).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.textPrimary)
                                    let line = [Naming.roleLine(p), Naming.org(d, p.orgId)?.name ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
                                    if !line.isEmpty { Text(line).font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(1) }
                                }
                                Spacer()
                            }
                            .padding(.horizontal, 14).padding(.vertical, 6)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("mention.pick.\(p.id)")
                    }
                    if showAll {
                        Button { onPick(L("mention.all"), Mention.all) } label: {
                            HStack(spacing: 10) {
                                Image(systemName: "person.3.fill").foregroundStyle(Theme.accentText).frame(width: 30, height: 30)
                                    .background(Circle().fill(Theme.orange.opacity(0.14)))
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(L("mention.allLabel")).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.textPrimary)
                                    Text(L("mention.allHint")).font(.caption).foregroundStyle(Theme.textSecondary)
                                }
                                Spacer()
                            }
                            .padding(.horizontal, 14).padding(.vertical, 6)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("mention.pick.all")
                    }
                    ForEach(outsiders) { p in
                        HStack(spacing: 8) {
                            Avatar(person: p, org: Naming.org(d, p.orgId), size: 26).opacity(0.7)
                            Text(L("mention.notInChat", ["name": p.name.split(separator: " ").first.map(String.init) ?? p.name]))
                                .font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(2)
                            Spacer()
                            if c.canManage && !Naming.isSide(c) && c.kind != .direct {
                                Button(L("mention.addToChat")) { onAdd(p) }.font(.caption.weight(.semibold))
                            }
                            if !Naming.isSide(c) { Button(L("mention.askSide")) { onAskSide(p) }.font(.caption.weight(.semibold)) }
                        }
                        .foregroundStyle(Theme.accentText)
                        .padding(.horizontal, 14).padding(.vertical, 6)
                        .accessibilityIdentifier("mention.outsider.\(p.id)")
                    }
                    if people.isEmpty && !showAll && outsiders.isEmpty {
                        Text(L("mention.noMatch")).font(.footnote).foregroundStyle(Theme.textSecondary).padding(14)
                    }
                }
            }
            .frame(maxHeight: 230)
        }
        .background(Theme.surface)
        .overlay(alignment: .top) { Divider() }
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .accessibilityIdentifier("mention.picker")
    }
}

/// Ficha de una persona mencionada: enviar mensaje directo.
struct PersonCardSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let personId: String
    @State private var busy = false

    var body: some View {
        if let d = store.data, let p = Naming.person(d, personId) {
            VStack(spacing: 10) {
                Avatar(person: p, org: Naming.org(d, p.orgId), size: 72)
                Text(p.name).font(.title3.weight(.bold))
                let line = [Naming.roleLine(p), Naming.org(d, p.orgId)?.name ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
                if !line.isEmpty { Text(line).font(.subheadline).foregroundStyle(Theme.textSecondary) }
                if p.id != d.me.id {
                    Button {
                        busy = true
                        Task {
                            do {
                                let r = try await store.createChat(userIds: [p.id], name: nil)
                                dismiss()
                                store.navigate(to: .conversation(r.id))
                            } catch { store.show(L10n.errorText(error)) }
                            busy = false
                        }
                    } label: {
                        Label(L("chat.openDirect"), systemImage: "bubble.left.fill").frame(maxWidth: .infinity).padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.bubbleMine)
                    .disabled(busy)
                    .padding(.horizontal, 30)
                    .accessibilityIdentifier("person.sendMessage")
                }
            }
            .padding(.top, 24)
            .frame(maxWidth: .infinity)
            .accessibilityIdentifier("person.card")
        }
    }
}
