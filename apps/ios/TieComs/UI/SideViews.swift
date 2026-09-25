import SwiftUI

/// «Preguntar en privado (lateral)»: elegir personas (miembros del chat + colegas de mi empresa) y una pregunta opcional.
/// Quien no se puede sumar sale deshabilitado con el motivo (bloqueado, o de otra empresa según responde el API).
struct NewSideSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let conversationId: String
    let message: MessageDTO
    var onCreated: (String) -> Void

    @State private var query = ""
    @State private var chosen: Set<String> = []
    @State private var outsiders: Set<String> = []
    @State private var question = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        let cand = store.sideCandidates(conversationId)
        let fold: (String) -> String = { $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }
        let q = fold(query.trimmingCharacters(in: .whitespaces))
        let filter: ([PersonDTO]) -> [PersonDTO] = { list in
            q.isEmpty ? list : list.filter { p in [p.name, p.title, p.area].compactMap { $0 }.contains { fold($0).contains(q) } }
        }
        NavigationStack {
            Form {
                Section {
                    Text(L("sideq.body")).font(.footnote).foregroundStyle(Theme.textSecondary)
                    Text("“\(excerpt(message.body, 220))”").italic()
                }
                if !chosen.isEmpty, let d = store.data {
                    Section {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack {
                                ForEach(Array(chosen).compactMap { Naming.person(d, $0) }) { p in
                                    Button { chosen.remove(p.id) } label: {
                                        HStack(spacing: 4) { Text(p.name).font(.caption.weight(.semibold)); Image(systemName: "xmark").font(.caption2) }
                                            .padding(.horizontal, 10).padding(.vertical, 5)
                                            .background(Capsule().fill(Theme.orange.opacity(0.15)))
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel(L("sideq.removeChip", ["name": p.name]))
                                }
                            }
                        }
                    }
                }
                let members = filter(cand.members), colleagues = filter(cand.colleagues)
                if !members.isEmpty { Section(L("sideq.members")) { ForEach(members) { row($0) } } }
                if !colleagues.isEmpty { Section(L("sideq.colleagues")) { ForEach(colleagues) { row($0) } } }
                if members.isEmpty && colleagues.isEmpty { Text(L("sideq.nobody")).foregroundStyle(Theme.textSecondary) }
                Section {
                    TextField(L("sideq.questionPh"), text: $question, axis: .vertical).lineLimit(2...6).accessibilityIdentifier("side.question")
                } footer: { Text(L("sideq.privacy")) }
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
            }
            .searchable(text: $query, prompt: L("sideq.search"))
            .navigationTitle(L("sideq.title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if busy { ProgressView() } else {
                        Button(L("sideq.open"), action: submit).disabled(chosen.isEmpty).accessibilityIdentifier("side.submit")
                    }
                }
            }
        }
    }

    @ViewBuilder private func row(_ p: PersonDTO) -> some View {
        let d = store.data
        let blocked = store.blockedUserIds.contains(p.id)
        let outsider = outsiders.contains(p.id)
        let disabled = blocked || outsider
        Button {
            if chosen.contains(p.id) { chosen.remove(p.id) } else if !disabled { chosen.insert(p.id) }
        } label: {
            HStack(spacing: 10) {
                Avatar(person: p, org: d.flatMap { Naming.org($0, p.orgId) }, size: 32)
                VStack(alignment: .leading, spacing: 1) {
                    Text(p.name).foregroundStyle(Theme.textPrimary)
                    let line = disabled ? L(blocked ? "sideq.blocked" : "sideq.outsider")
                        : [Naming.roleLine(p), d.flatMap { Naming.org($0, p.orgId)?.name } ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
                    Text(line).font(.caption).foregroundStyle(disabled ? .red : Theme.textSecondary)
                }
                Spacer()
                Image(systemName: chosen.contains(p.id) ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(chosen.contains(p.id) ? Theme.accentText : Theme.textSecondary)
            }
        }
        .disabled(disabled && !chosen.contains(p.id))
        .opacity(disabled ? 0.55 : 1)
        .accessibilityAddTraits(chosen.contains(p.id) ? .isSelected : [])
        .accessibilityIdentifier("side.person.\(p.id)")
    }

    private func submit() {
        busy = true; error = nil
        Task {
            do {
                let id = try await store.createSide(conversationId, messageId: message.id, userIds: Array(chosen), question: question)
                dismiss()
                onCreated(id)
            } catch let e as ApiRequestError where e.code == "side_outsider" {
                outsiders.formUnion(e.userIds)
                chosen.subtract(e.userIds)
                error = L("sideq.outsiderError")
            } catch {
                self.error = L10n.errorText(error)
            }
            busy = false
        }
    }
}

/// Panel de la conversación lateral: iPad/pantalla ancha = panel a la derecha (inspector);
/// iPhone = hoja casi a pantalla completa. Mensaje ancla fijo arriba y «Llevar la respuesta al hilo».
struct SidePanel: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let sideId: String
    @State private var returning = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                anchor
                ConversationView(conversationId: sideId, embedded: true)
            }
            .routes()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("common.close")) { dismiss() }.accessibilityIdentifier("side.close") }
                ToolbarItem(placement: .primaryAction) {
                    if let c = store.meta(sideId), c.returnedAt == nil, c.parentId.flatMap({ store.meta($0) })?.canPost == true {
                        Button(L("sideq.return")) { returning = true }.accessibilityIdentifier("side.return")
                    }
                }
            }
            .sheet(isPresented: $returning) { ReturnResultSheet(conversationId: sideId) }
        }
    }

    /// Mensaje ancla: del origen si está cargado; si no, el extracto del mensaje de sistema side.started.
    @ViewBuilder private var anchor: some View {
        if let c = store.meta(sideId), let d = store.data {
            let parent = c.parentId.flatMap { store.meta($0) }
            let orig = c.parentId.flatMap { pid in store.conversations[pid]?.messages.first { $0.id == c.parentMessageId } }
            let started = store.conversations[sideId]?.messages.first { ($0.systemPayload?["k"] as? String) == "side.started" }?.systemPayload
            let text = orig?.body ?? (started?["excerpt"] as? String) ?? ""
            let author = orig.flatMap { Naming.person(d, $0.authorId)?.name } ?? (started?["authorName"] as? String)
            VStack(alignment: .leading, spacing: 4) {
                Label(parent.map { L("sideq.from", ["name": Naming.title(d, $0)]) } ?? L("sideq.label"), systemImage: "bubble.left.and.text.bubble.right")
                    .font(.caption.weight(.semibold)).foregroundStyle(Theme.accentText)
                if !text.isEmpty {
                    Text((author.map { "\($0): " } ?? "") + "«\(excerpt(text, 200))»").font(.subheadline).foregroundStyle(Theme.textPrimary).lineLimit(3)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16).padding(.vertical, 10)
            .background(Theme.orange.opacity(0.08))
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("side.anchor")
        }
    }
}

/// Chip «💬 Consulta lateral · N» bajo el mensaje ancla (solo lo ven los miembros de la lateral).
struct SideChip: View {
    let sides: [ConversationDTO]
    var onOpen: (String) -> Void
    var body: some View {
        if let first = sides.first {
            let label = "💬 " + L("sideq.chip") + (sides.count > 1 ? " · \(sides.count)" : "")
            Group {
                if sides.count == 1 {
                    Button { onOpen(first.id) } label: { chip(label) }
                } else {
                    Menu {
                        ForEach(sides) { s in Button(s.name ?? L("sideq.label")) { onOpen(s.id) } }
                    } label: { chip(label) }
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("side.chip.\(first.parentMessageId ?? "")")
        }
    }

    private func chip(_ text: String) -> some View {
        Text(text).font(.caption.weight(.semibold)).foregroundStyle(Theme.accentText)
            .padding(.horizontal, 10).padding(.vertical, 4)
            .background(Capsule().fill(Theme.orange.opacity(0.12)))
    }
}
