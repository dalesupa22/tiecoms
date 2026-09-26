import SwiftUI

/// Formulario con botones Cancelar / acción principal en la barra.
struct SheetForm<Content: View>: View {
    @Environment(\.dismiss) private var dismiss
    var title: String
    var action: String
    var busy: Bool
    var disabled: Bool = false
    var error: String?
    var onSubmit: () -> Void
    @ViewBuilder var content: () -> Content

    var body: some View {
        NavigationStack {
            Form {
                content()
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if busy { ProgressView() } else {
                        Button(action, action: onSubmit).disabled(disabled).accessibilityIdentifier("sheet.submit")
                    }
                }
            }
        }
    }
}

private func humans(_ d: BootstrapDTO, _ conversationId: String) -> [PersonDTO] {
    (d.conversations.first { $0.id == conversationId }?.memberIds ?? []).compactMap { Naming.person(d, $0) }.filter { $0.kind == "human" }
}

// MARK: Derivar

struct DeriveSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let conversationId: String
    let message: MessageDTO
    /// El hilo nuevo se abre al lado del chat; sin esto, en su propia pantalla.
    var onOpened: ((String) -> Void)? = nil
    @State private var kind = "same"
    @State private var name = ""
    @State private var reason = ""
    @State private var busy = false
    @State private var error: String?

    private var short: String {
        let e = excerpt(message.body, 1000)
        guard e.count > 40 else { return e }
        let cut = String(e.prefix(40))
        return (cut.range(of: "\\s+\\S*$", options: .regularExpression).map { String(cut[..<$0.lowerBound]) } ?? cut) + "…"
    }

    var body: some View {
        let d = store.data
        let myOrg = d.flatMap { Naming.org($0, $0.me.primaryOrgId) }
        SheetForm(title: L("derive.title"), action: L("derive.create"), busy: busy, disabled: name.trimmingCharacters(in: .whitespaces).count < 2, error: error, onSubmit: submit) {
            Section {
                Text(L("derive.body")).font(.footnote).foregroundStyle(Theme.textSecondary)
                Text("“\(excerpt(message.body, 220))”").font(.callout).italic()
            }
            Section {
                ForEach([("same", L("derive.same"), L("derive.sameNote")),
                         ("internal", L("derive.internal", ["org": myOrg?.name ?? ""]), L("derive.internalNote")),
                         ("directive", L("derive.directive"), L("derive.directiveNote"))], id: \.0) { k, label, note in
                    Button { pick(k) } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(label).font(.body.weight(.semibold)).foregroundStyle(Theme.textPrimary)
                                Text(note).font(.caption).foregroundStyle(Theme.textSecondary)
                            }
                            Spacer()
                            if kind == k { Image(systemName: "checkmark").foregroundStyle(Theme.accentText) }
                        }
                    }
                    .accessibilityAddTraits(kind == k ? .isSelected : [])
                    .accessibilityIdentifier("derive.\(k)")
                }
            }
            Section {
                TextField(L("derive.name"), text: $name)
                TextField(L("derive.reason"), text: $reason)
            }
        }
        .onAppear { if name.isEmpty { pick("same") } }
    }

    private func pick(_ k: String) { kind = k; name = "\(L("derive.prefix.\(k)")) · \(short)" }

    private func submit() {
        busy = true; error = nil
        Task {
            do {
                let id = try await store.derive(conversationId, messageId: message.id, kind: kind, name: name, reason: reason)
                dismiss()
                if let onOpened { onOpened(id) } else { store.push(.conversation(id)) }
            } catch { self.error = L10n.errorText(error) }
            busy = false
        }
    }
}

/// «Llevar al hilo»: resumen local editable, con DeepSeek opcional tras consentimiento explícito,
/// vista previa de cómo se verá en el grupo y «Publicar en el hilo».
struct ReturnResultSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let conversationId: String
    @State private var summary = ""
    @State private var source: String?
    @State private var suggesting = false
    @State private var showingAIConsent = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        let d = store.data
        let parent = store.meta(conversationId)?.parentId.flatMap { store.meta($0) }
        let parentName = parent.flatMap { p in d.map { Naming.title($0, p) } } ?? ""
        SheetForm(title: L("side.return"), action: L("side.publish"), busy: busy || suggesting, disabled: summary.trimmingCharacters(in: .whitespaces).count < 2, error: error, onSubmit: submit) {
            Section {
                Text(L("lin.returnBody", ["name": parentName])).font(.footnote).foregroundStyle(Theme.textSecondary)
                ZStack(alignment: .topLeading) {
                    TextField("", text: $summary, axis: .vertical).lineLimit(4...12).disabled(suggesting).accessibilityIdentifier("return.summary")
                    if suggesting { ProgressView().frame(maxWidth: .infinity, alignment: .trailing) }
                }
                if suggesting { Text(L("side.suggesting")).font(.caption).foregroundStyle(Theme.textSecondary) }
                else { Text(L("side.returnEdit")).font(.caption).foregroundStyle(Theme.textSecondary) }
                if let source {
                    Label(source == "ai" ? L("side.suggested") : L("side.suggestedFallback"), systemImage: source == "ai" ? "sparkles" : "text.quote")
                        .font(.caption).foregroundStyle(Theme.textSecondary)
                        .accessibilityIdentifier("return.source.\(source)")
                }
                Button { showingAIConsent = true } label: {
                    Label(L("ai.side.request"), systemImage: "sparkles")
                }
                .disabled(suggesting || busy)
                .accessibilityIdentifier("return.requestAI")
            }
            Section(L("side.previewInGroup")) {
                if let d, let me = Naming.person(d, d.me.id) {
                    HStack(alignment: .top, spacing: 8) {
                        Avatar(person: me, org: Naming.org(d, me.orgId), size: 28)
                        VStack(alignment: .leading, spacing: 4) {
                            Label(L("side.fromSidechat"), systemImage: "bubble.left.and.text.bubble.right").font(.caption2.weight(.semibold))
                                .foregroundStyle(.white.opacity(0.9))
                            Text(summary.isEmpty ? "…" : summary).foregroundStyle(.white)
                        }
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(RoundedRectangle(cornerRadius: 16).fill(Theme.bubbleMine))
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("return.preview")
                }
            }
        }
        .task {
            guard summary.isEmpty else { return }
            summary = store.localReturnSummary(conversationId)
            source = "fallback"
        }
        .alert(L("ai.side.title"), isPresented: $showingAIConsent) {
            Button(L("ai.side.allow")) { suggestWithAI() }
            Button(L("ai.side.without"), role: .cancel) {}
        } message: { Text(L("ai.side.message")) }
    }

    private func suggestWithAI() {
        guard !suggesting else { return }
        suggesting = true
        error = nil
        Task {
            defer { suggesting = false }
            do {
                let result = try await store.suggestReturn(conversationId, aiConsent: true)
                if !result.summary.isEmpty { summary = result.summary; source = result.source }
            } catch { self.error = L10n.errorText(error) }
        }
    }

    private func submit() {
        busy = true; error = nil
        Task {
            do {
                let parentId = try await store.returnResult(conversationId, summary: summary)
                dismiss()
                store.navigate(to: .conversation(parentId))
            } catch { self.error = L10n.errorText(error) }
            busy = false
        }
    }
}

// MARK: Asuntos

struct NewIssueSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let conversationId: String
    let origin: MessageDTO?
    @State private var title = ""
    @State private var ownerId: String = ""
    @State private var hasDue = false
    @State private var due = Date().addingTimeInterval(3 * 86400)
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        let d = store.data
        SheetForm(title: L("issue.newTitle"), action: L("issue.create"), busy: busy, disabled: title.trimmingCharacters(in: .whitespaces).count < 2, error: error, onSubmit: submit) {
            Section {
                TextField(L("issue.title"), text: $title, axis: .vertical).lineLimit(1...4).accessibilityIdentifier("issue.titleField")
                if let d {
                    Picker(L("issue.owner"), selection: $ownerId) {
                        ForEach(humans(d, conversationId)) { p in
                            Text("\(p.name)\(p.id == d.me.id ? " " + L("common.you") : "") · \(Naming.org(d, p.orgId)?.name ?? L("common.guest"))").tag(p.id)
                        }
                    }
                }
                Toggle(L("issue.due"), isOn: $hasDue)
                if hasDue { DatePicker(L("issue.due"), selection: $due, displayedComponents: .date) }
            }
        }
        .onAppear {
            if ownerId.isEmpty { ownerId = d?.me.id ?? "" }
            if title.isEmpty, let o = origin { title = excerpt(o.body, 200) }
        }
    }

    private func submit() {
        busy = true; error = nil
        Task {
            do {
                let i = try await store.createIssue(conversationId: conversationId, title: title, ownerId: ownerId.isEmpty ? nil : ownerId,
                                                    dueDate: hasDue ? IssueDates.iso(due) : nil, originMessageId: origin?.id)
                dismiss()
                store.show(i.title)
            } catch { self.error = L10n.errorText(error) }
            busy = false
        }
    }
}

enum IssueDates {
    static func iso(_ d: Date) -> String {
        let f = DateFormatter(); f.calendar = Calendar(identifier: .gregorian); f.dateFormat = "yyyy-MM-dd"; f.timeZone = .current
        return f.string(from: d)
    }
    static func date(_ s: String?) -> Date? {
        guard let s else { return nil }
        let f = DateFormatter(); f.calendar = Calendar(identifier: .gregorian); f.dateFormat = "yyyy-MM-dd HH:mm"; f.timeZone = .current
        return f.date(from: "\(s) 12:00")
    }
    static func today() -> String { iso(Date()) }
}

struct ConversationIssuesSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let conversationId: String
    @State private var creating = false
    var body: some View {
        NavigationStack {
            // Con fecha límite primero (la más cercana arriba).
            let list = store.issues.values.filter { $0.conversationId == conversationId && !$0.status.closed }
                .sorted { ($0.dueDate ?? "9999", $0.createdAt) < ($1.dueDate ?? "9999", $1.createdAt) }
            List {
                if list.isEmpty { Text(L("issue.noIssues")).foregroundStyle(Theme.textSecondary) }
                ForEach(list) { i in
                    Button { dismiss(); store.push(.issue(i.id)) } label: { IssueRow(issue: i, showWhere: false) }
                }
            }
            .navigationTitle(L("issue.here"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("common.close")) { dismiss() } }
                // Los terceros participan en los asuntos, pero no los crean.
                if !store.isGuest(conversationId) {
                    ToolbarItem(placement: .primaryAction) { Button(L("issue.new")) { creating = true }.accessibilityIdentifier("issues.here.new") }
                }
            }
            .sheet(isPresented: $creating) { NewIssueSheet(conversationId: conversationId, origin: nil) }
        }
    }
}

// Reenviar a otros chats: ForwardSheet en ChatsViews.swift.

// MARK: Fijados

struct PinsSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let conversationId: String
    @State private var list: [MessageDTO]?
    var body: some View {
        NavigationStack {
            List {
                if list == nil { ProgressView() }
                if list?.filter({ !store.blockedUserIds.contains($0.authorId) }).isEmpty == true { Text(L("pins.empty")).foregroundStyle(Theme.textSecondary) }
                if let d = store.data {
                    ForEach((list ?? []).filter { !store.blockedUserIds.contains($0.authorId) }) { m in
                        let p = Naming.person(d, m.authorId)
                        HStack(alignment: .top, spacing: 10) {
                            Avatar(name: p?.name ?? "?", org: Naming.org(d, p?.orgId), size: 30, photo: p?.avatarUrl)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(p?.name ?? L("common.participant")).font(.caption.weight(.semibold))
                                Text(excerpt(m.body, 140)).font(.subheadline)
                            }
                        }
                        .accessibilityElement(children: .combine)
                        .swipeActions {
                            Button(L("menu.unpin")) {
                                Task { try? await store.setMessagePinned(m, false); list = try? await store.loadPins(conversationId) }
                            }
                        }
                    }
                }
            }
            .navigationTitle(L("pins.title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L("common.close")) { dismiss() } } }
            .task { list = (try? await store.loadPins(conversationId)) ?? [] }
        }
        .presentationDetents([.medium, .large])
    }
}

// MARK: Compartir hacia Chaggu

/// Equivalente nativo de /share y Bring: el usuario elige la conversación y se envía
/// con `forwarded` (origen detectado por el texto; si no, "otra app").
struct ShareIntoTieComsView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let text: String
    @State private var query = ""
    @State private var source: ForwardSource = .other

    var body: some View {
        NavigationStack {
            if let d = store.data {
                let list = d.conversations.filter { $0.canPost && (query.isEmpty || Naming.title(d, $0).localizedCaseInsensitiveContains(query)) }
                List {
                    Section {
                        Text(L("share.body")).font(.footnote).foregroundStyle(Theme.textSecondary)
                        if text.isEmpty { Text(L("share.empty")) } else { Text(String(text.prefix(400))).italic() }
                        Picker(L("imp.source"), selection: $source) {
                            ForEach(ForwardSource.allCases.filter { $0 != .tiecoms }, id: \.self) { Text(L("src.\($0.rawValue)")).tag($0) }
                        }
                    }
                    Section {
                        ForEach(list) { c in
                            Button {
                                let parsed = SharedText.analyze(text, source: source)
                                for item in parsed { store.send(c.id, body: item.body, forwarded: item.forwarded) }
                                store.show(L("toast.sent"))
                                dismiss()
                                store.navigate(to: .conversation(c.id))
                            } label: {
                                HStack { Text(Naming.title(d, c)).foregroundStyle(Theme.textPrimary); Spacer(); Image(systemName: "chevron.right").foregroundStyle(Theme.textSecondary) }
                            }
                            .disabled(text.isEmpty)
                        }
                    }
                }
                .searchable(text: $query, prompt: L("fwd.search"))
                .navigationTitle(L("share.title"))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { dismiss() } } }
                .onAppear { source = SharedText.detectSource(text) }
            } else {
                ContentUnavailableView(L("share.title"), systemImage: "square.and.arrow.down", description: Text(L("share.loginFirst")))
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L("common.close")) { dismiss() } } }
            }
        }
    }
}
