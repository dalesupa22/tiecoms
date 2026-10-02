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
                // Fuera de un espacio (directos y chats grupales) solo hay hilo con las mismas personas.
                let options = [("same", L("derive.same"), L("derive.sameNote")),
                               ("internal", L("derive.internal", ["org": myOrg?.name ?? ""]), L("derive.internalNote")),
                               ("directive", L("derive.directive"), L("derive.directiveNote"))]
                ForEach(store.meta(conversationId)?.workspaceId == nil ? Array(options.prefix(1)) : options, id: \.0) { k, label, note in
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
    /// nil desde «＋ Crear»: se elige el grupo o chat (el más reciente primero).
    let conversationId: String?
    let origin: MessageDTO?
    /// Tema de la banderita elegida en el chat (docs/TEMAS.md).
    var topicId: String? = nil
    /// gg (Responder por mí › «Con acción», o «Pedir a gg»): título, responsable y fecha ya puestos; la persona confirma.
    var prefill: GgPrefill? = nil
    @State private var conv = ""
    @State private var title = ""
    @State private var ownerId: String = ""
    @State private var hasDue = false
    @State private var due = Date().addingTimeInterval(3 * 86400)
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        let d = store.data
        SheetForm(title: L("issue.newTitle"), action: L("issue.create"), busy: busy, disabled: title.trimmingCharacters(in: .whitespaces).count < 2 || conv.isEmpty, error: error, onSubmit: submit) {
            Section {
                TextField(L("issue.title"), text: $title, axis: .vertical).lineLimit(1...4).accessibilityIdentifier("issue.titleField")
                if let d {
                    if conversationId == nil {
                        // Primera opción: un asunto personal, que solo ves tú (sin chat, sin responsable que elegir).
                        Picker(L("issue.where"), selection: $conv) {
                            Text("🔒 " + L("issue.personal")).tag(IssueTasks.personalKey)
                            ForEach(Self.destinations(d)) { c in Text(Self.label(d, c)).tag(c.id) }
                        }
                        .onChange(of: conv) { _, _ in ownerId = d.me.id }
                        .accessibilityIdentifier("issue.where")
                    }
                    if conv == IssueTasks.personalKey {
                        Text(L("issue.personalHint")).font(.footnote).foregroundStyle(Theme.textSecondary)
                            .accessibilityIdentifier("issue.personalHint")
                    } else {
                        Picker(L("issue.owner"), selection: $ownerId) {
                            ForEach(humans(d, conv)) { p in
                                Text("\(p.name)\(p.id == d.me.id ? " " + L("common.you") : "") · \(Naming.org(d, p.orgId)?.name ?? L("common.guest"))").tag(p.id)
                            }
                        }
                    }
                }
                Toggle(L("issue.due"), isOn: $hasDue)
                if hasDue { DatePicker(L("issue.due"), selection: $due, displayedComponents: .date) }
            }
        }
        .onAppear {
            if conv.isEmpty { conv = conversationId ?? IssueTasks.personalKey }
            if ownerId.isEmpty { ownerId = d?.me.id ?? "" }
            if title.isEmpty, let p = prefill {
                title = String(p.title.prefix(200))
                if let due = p.dueDate { hasDue = true; self.due = due }
                if let d, let who = GgPeople.find(d, name: p.assigneeName, among: humans(d, conv).map(\.id)) { ownerId = who.id }
            }
            if title.isEmpty, let o = origin { title = excerpt(o.body, 200) }
        }
    }

    /// Dónde puedo crear un asunto: grupos y chats donde escribo y no soy tercero, el de actividad más reciente primero.
    static func destinations(_ d: BootstrapDTO) -> [ConversationDTO] {
        d.conversations.filter { $0.canPost && !Naming.isThread($0) && !Naming.isGuest(d, $0) }.sorted(by: HomeOrder.before)
    }

    /// «Grupo · Empresa» (o el nombre del chat) para el selector.
    static func label(_ d: BootstrapDTO, _ c: ConversationDTO) -> String {
        guard let ws = d.workspaces.first(where: { $0.id == c.workspaceId }) else { return Naming.title(d, c) }
        // Relación pendiente: el nombre escrito de la otra empresa (counterpartOrg daría la mía), como en Grupos.
        let company = ws.counterpartName ?? Naming.counterpartOrg(d, ws)?.name ?? ws.name
        return "\(Naming.title(d, c)) · \(company)"
    }

    private func submit() {
        busy = true; error = nil
        Task {
            do {
                let i = conv == IssueTasks.personalKey
                    ? try await store.createPersonalIssue(title: title, dueDate: hasDue ? IssueDates.iso(due) : nil)
                    : try await store.createIssue(conversationId: conv, title: title, ownerId: ownerId.isEmpty ? nil : ownerId,
                                                  dueDate: hasDue ? IssueDates.iso(due) : nil, originMessageId: origin?.id,
                                                  topicId: conv == conversationId ? topicId : nil)
                dismiss()
                store.show(i.title)
            } catch { self.error = L10n.errorText(error) }
            busy = false
        }
    }
}

/// Fechas de los asuntos («yyyy-MM-dd») siempre en la hora LOCAL del teléfono: vencido y «hoy» se comparan con
/// el día de aquí, no con UTC.
enum IssueDates {
    static func iso(_ d: Date, timeZone: TimeZone = .current) -> String {
        let f = DateFormatter(); f.calendar = Calendar(identifier: .gregorian); f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"; f.timeZone = timeZone
        return f.string(from: d)
    }
    static func date(_ s: String?) -> Date? {
        guard let s else { return nil }
        let f = DateFormatter(); f.calendar = Calendar(identifier: .gregorian); f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH:mm"; f.timeZone = .current
        return f.date(from: "\(s) 12:00")
    }
    static func today() -> String { iso(Date()) }

    /// Fechas de un toque (como la web): Hoy, Mañana, El viernes (solo si falta más de un día) y La otra semana
    /// (el próximo lunes; si hoy es lunes, el de la semana que viene).
    static func shortcuts(now: Date = Date(), calendar: Calendar = .current) -> [(key: String, iso: String)] {
        var cal = calendar
        cal.locale = Locale(identifier: "en_US_POSIX")
        let plus = { (n: Int) in iso(cal.date(byAdding: .day, value: n, to: now) ?? now, timeZone: cal.timeZone) }
        let dow = cal.component(.weekday, from: now) - 1 // 0 = domingo, como getDay()
        let toFriday = (5 - dow + 7) % 7
        let toMonday = (1 - dow + 7) % 7 == 0 ? 7 : (1 - dow + 7) % 7
        var out: [(key: String, iso: String)] = [("issue.dToday", plus(0)), ("issue.dTomorrow", plus(1))]
        if toFriday > 1 { out.append(("issue.dFriday", plus(toFriday))) }
        out.append(("issue.dNextWeek", plus(toMonday)))
        return out
    }
}

/// Asuntos de un chat (barra ◆ del chat, «Asuntos aquí» y el «+N asuntos» de Grupos): alta rápida, activos por
/// urgencia y «Completados · N» plegable, como la web.
struct ConversationIssuesSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let conversationId: String
    var body: some View {
        NavigationStack {
            List {
                // Los terceros participan en los asuntos, pero no los crean.
                ConversationIssuesList(conversationId: conversationId, canCreate: canCreate) { id in
                    dismiss(); store.push(.issue(id))
                }
            }
            .navigationTitle(L("issue.here"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("common.close")) { dismiss() } }
            }
            // GET ?conversationId= trae también los cerrados (para «Completados»).
            .task { _ = try? await store.loadIssues(conversationId: conversationId) }
        }
        .sheetToasts()
        .issueSheets(host: "conversationIssues-\(conversationId)")
    }

    private var canCreate: Bool {
        guard let c = store.meta(conversationId) else { return false }
        return c.canPost && !store.isGuest(conversationId)
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
