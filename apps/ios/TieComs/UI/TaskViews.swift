import SwiftUI

/// Tareas derivadas de un asunto (docs/TAREAS.md): alta con ¿Quién la hace? y ¿Quién la ve?, la sección «Tareas» del
/// detalle, «＋ Tarea derivada» / «💬 Hablar aparte» en la pulsación larga y la franja del sidechat.

/// Hojas que se abren desde el menú de un asunto (en cualquier lista).
enum IssueSheet: Identifiable, Equatable {
    case tasks(parentId: String, conversationId: String?)
    case side(issueId: String)
    var id: String {
        switch self {
        case .tasks(let p, let c): return "tasks-\(p)-\(c ?? "")"
        case .side(let i): return "side-\(i)"
        }
    }
}

private struct IssueSheetHostKey: EnvironmentKey { static let defaultValue = "root" }

extension EnvironmentValues {
    /// Quién presenta las hojas de asunto para esta parte de la pantalla (cada pestaña o la hoja de asuntos del chat).
    var issueSheetHost: String {
        get { self[IssueSheetHostKey.self] }
        set { self[IssueSheetHostKey.self] = newValue }
    }
}

extension AppStore {
    /// Pide una hoja de asunto al presentador de esa parte de la pantalla.
    func requestIssueSheet(_ s: IssueSheet, host: String) { issueSheetHost = host; issueSheet = s }
}

extension View {
    /// Presenta `store.issueSheet` cuando la pidió algo de su subárbol (`host`). Así no compiten la pestaña y una hoja
    /// abierta encima: presenta el más cercano a quien la pidió.
    func issueSheets(host: String) -> some View { modifier(IssueSheetsModifier(host: host)) }
}

private struct IssueSheetsModifier: ViewModifier {
    @Environment(AppStore.self) private var store
    var host: String
    func body(content: Content) -> some View {
        // Se lee aquí (en body) para que Observation siga el cambio; dentro del getter del Binding no lo seguiría.
        let current = store.issueSheetHost == host ? store.issueSheet : nil
        content
            .environment(\.issueSheetHost, host)
            .sheet(item: Binding(get: { current }, set: { if $0 == nil { store.issueSheet = nil; store.issueSheetHost = nil } })) { s in
                switch s {
                case .tasks(let p, let c): TasksSheet(parentId: p, conversationId: c)
                case .side(let i): SideFromIssueSheet(issueId: i)
                }
            }
    }
}

/// Alta de una tarea: título y Return; al escribir, ¿Quién la hace? (los del chat y «＋ Otra persona») y ¿Quién la ve?
/// Si la persona no está en el chat, «Todo el chat» se desactiva y la tarea queda privada. En un sidechat la ven solo
/// los del sidechat.
struct TaskQuickAdd: View {
    @Environment(AppStore.self) private var store
    let parent: IssueDTO
    var conversationId: String?
    @State private var title = ""
    @State private var ownerId = ""
    @State private var assigneeIds: Set<String> = []
    @State private var vis: IssueVisibility?
    @State private var busy = false
    @FocusState private var focused: Bool

    var body: some View {
        if let d = store.data {
            let whereId = conversationId ?? parent.conversationId ?? ""
            let inSide = whereId != parent.conversationId
            let members = issueMembers(store, d, whereId)
            let owner = ownerId.isEmpty ? d.me.id : ownerId
            let selected = assigneeIds.isEmpty ? Set([owner]) : assigneeIds
            let outsiders = selected.subtracting(members.map(\.id))
            let outsider = !outsiders.isEmpty
            let chosen = vis ?? (inSide ? .all : IssueTasks.defaultVisibility(members: issueMembers(store, d, parent.conversationId), myOrg: d.me.primaryOrgId))
            let effective = IssueTasks.effective(chosen, outsider: outsider)
            let myOrg = Naming.org(d, d.me.primaryOrgId)
            let contacts = d.people.filter { p in p.kind == "human" && p.id != d.me.id && !members.contains { $0.id == p.id } }
                .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            let visOptions: [(IssueVisibility, String)] = inSide
                ? [(.all, L("task.visSide")), (.private, L("task.visPrivate"))]
                : [(.all, L("task.visAll"))] + (myOrg.map { [(.org, L("task.visOrg", ["org": $0.name]))] } ?? []) + [(.private, L("task.visPrivate"))]
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 4) {
                    Image(systemName: "plus.circle").font(.title3).foregroundStyle(Theme.textSecondary).frame(width: 44, height: 44).accessibilityHidden(true)
                    TextField(L("task.ph").replacingOccurrences(of: " (Enter)", with: ""), text: $title)
                        .focused($focused)
                        .submitLabel(.done)
                        .onSubmit { submit(owner: owner, visibility: effective, inSide: inSide, whereId: whereId) }
                        .frame(minHeight: 44)
                        .accessibilityLabel(L("task.title"))
                        .accessibilityIdentifier("task.quickField")
                    if !title.isEmpty {
                        Button(L("issue.add")) { submit(owner: owner, visibility: effective, inSide: inSide, whereId: whereId) }
                            .font(.subheadline.weight(.semibold))
                            .primaryProminent()
                            .disabled(busy || title.trimmingCharacters(in: .whitespaces).count < 2)
                            .accessibilityIdentifier("task.quickAdd")
                    }
                }
                if !title.isEmpty {
                    Text(L("issue.qWho")).font(.footnote.weight(.semibold)).foregroundStyle(Theme.textSecondary)
                    ChipFlow(spacing: 8) {
                        ForEach(members) { p in
                            TaskChip(on: selected.contains(p.id), id: "task.who.\(p.id)", action: { if assigneeIds.isEmpty { assigneeIds = [owner] }; if assigneeIds.contains(p.id) { assigneeIds.remove(p.id) } else { assigneeIds.insert(p.id) }; ownerId = assigneeIds.sorted().first ?? "" }) {
                                HStack(spacing: 6) {
                                    Avatar(name: p.name, org: Naming.org(d, p.orgId), size: 20, photo: p.avatarUrl).accessibilityHidden(true)
                                    Text(p.id == d.me.id ? L("issue.me") : firstName(p.name))
                                }
                            }
                        }
                        ForEach(outsiders.sorted(), id: \.self) { id in
                        if let o = Naming.person(d, id) {
                            TaskChip(on: true, id: "task.who.\(o.id)", action: { assigneeIds.remove(o.id); ownerId = assigneeIds.sorted().first ?? "" }) {
                                HStack(spacing: 6) {
                                    Avatar(name: o.name, org: Naming.org(d, o.orgId), size: 20, photo: o.avatarUrl).accessibilityHidden(true)
                                    Text(firstName(o.name))
                                }
                            }
                        }
                        }
                        if !contacts.isEmpty {
                            Menu {
                                Section(L("task.pickPerson")) {
                                    ForEach(contacts) { p in
                                        Button("\(p.name) · \(Naming.org(d, p.orgId)?.name ?? L("common.guest"))") { if assigneeIds.isEmpty { assigneeIds = [owner] }; assigneeIds.insert(p.id); ownerId = assigneeIds.sorted().first ?? p.id }
                                    }
                                }
                            } label: {
                                Text("＋ " + L("task.otherPerson")).font(.subheadline).foregroundStyle(Theme.textSecondary)
                                    .padding(.horizontal, 14).frame(minHeight: 44)
                                    .overlay(Capsule().stroke(Theme.textSecondary.opacity(0.35), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
                            }
                            .accessibilityIdentifier("task.otherPerson")
                        }
                    }
                    Text(L("task.whoSees")).font(.footnote.weight(.semibold)).foregroundStyle(Theme.textSecondary)
                    ChipFlow(spacing: 8) {
                        ForEach(visOptions, id: \.0) { v, label in
                            TaskChip(on: effective == v, id: "task.vis.\(v.rawValue)", action: { vis = v }) {
                                Text((v == .all ? "👁 " : "🔒 ") + label)
                            }
                            .disabled(outsider && v == .all)
                            .opacity(outsider && v == .all ? 0.45 : 1)
                        }
                    }
                    if outsider, let id = outsiders.sorted().first, let o = Naming.person(d, id) {
                        Text(L("task.outsiderHint", ["name": firstName(o.name)])).font(.footnote).foregroundStyle(Theme.textSecondary)
                            .accessibilityIdentifier("task.outsiderHint")
                    }
                }
            }
        }
    }

    private func firstName(_ n: String) -> String { String(n.split(separator: " ").first ?? Substring(n)) }

    private func submit(owner: String, visibility: IssueVisibility, inSide: Bool, whereId: String) {
        let text = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count >= 2, !busy else { focused = true; return }
        busy = true
        Task {
            do {
                let assigned = assigneeIds.isEmpty ? [owner] : assigneeIds.sorted()
                try await store.createChildIssue(parent.id, title: text, ownerId: assigned.first, visibility: visibility, viewerIds: visibility == .private ? assigned : [], conversationId: inSide ? whereId : nil, assigneeIds: assigned)
                title = ""
                Haptics.tap()
            } catch { store.show(L10n.errorText(error)) }
            busy = false
            focused = true
        }
    }
}

/// Botón de un toque (sin menús), marcado cuando es el valor actual.
struct TaskChip<Content: View>: View {
    var on: Bool
    var id: String
    var action: () -> Void
    @ViewBuilder var label: () -> Content
    var body: some View {
        Button(action: action) {
            label()
                .font(.subheadline.weight(on ? .semibold : .regular))
                .foregroundStyle(on ? Theme.onPrimary : Theme.textPrimary)
                .padding(.horizontal, 14)
                .frame(minHeight: 44)
                .background(Capsule().fill(on ? Theme.primaryFill : Theme.bubbleOther))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier(id)
    }
}

/// «Tareas» dentro del asunto: las que veo (sangradas) y el alta.
struct TasksSection: View {
    @Environment(AppStore.self) private var store
    let parentId: String
    var conversationId: String?
    var onOpen: (String) -> Void

    var body: some View {
        if let parent = store.issues[parentId] {
            let kids = IssueTasks.children(store.issues, of: parentId)
            let done = kids.filter { $0.status.closed }.count
            VStack(alignment: .leading, spacing: 8) {
                Text(L("task.section") + (kids.isEmpty ? "" : " · \(done)/\(kids.count)"))
                    .font(.subheadline.weight(.bold)).foregroundStyle(Theme.textPrimary)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("task.section")
                ForEach(kids) { k in IssueRow(issue: k, showWhere: false, child: true) { onOpen(k.id) } }
                if !parent.status.closed {
                    TaskQuickAdd(parent: parent, conversationId: conversationId)
                    if kids.isEmpty { Text(L("task.hint")).font(.footnote).foregroundStyle(Theme.textSecondary) }
                }
            }
        }
    }
}

/// «Tareas de «asunto»» (desde el menú del asunto o la franja del sidechat).
struct TasksSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let parentId: String
    var conversationId: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                TasksSection(parentId: parentId, conversationId: conversationId) { id in dismiss(); store.push(.issue(id)) }
                    .padding(16)
            }
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle(L("task.dialogTitle", ["title": store.issues[parentId]?.title ?? ""]))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(L("common.done")) { dismiss() }.accessibilityIdentifier("task.sheetDone") } }
            .task { if store.issues[parentId] == nil { _ = try? await store.issueDetail(parentId) } }
        }
        .sheetToasts()
    }
}

/// Quién ve la tarea (solo quien la creó lo cambia).
struct VisibilityChoice: View {
    @Environment(AppStore.self) private var store
    let issue: IssueDTO
    var body: some View {
        if let d = store.data {
            let myOrg = Naming.org(d, d.me.primaryOrgId)
            let opts: [(IssueVisibility, String)] = [(.all, L("task.visAll"))] + (myOrg.map { [(.org, L("task.visOrg", ["org": $0.name]))] } ?? []) + [(.private, L("task.visPrivate"))]
            VStack(alignment: .leading, spacing: 8) {
                Text(L("task.whoSees")).font(.subheadline.weight(.bold)).accessibilityAddTraits(.isHeader)
                ChipFlow(spacing: 8) {
                    ForEach(opts, id: \.0) { v, label in
                        TaskChip(on: issue.visibility == v, id: "task.setVis.\(v.rawValue)", action: {
                            Task { do { try await store.updateIssue(issue.id, ["visibility": v.rawValue]) } catch { store.show(L10n.errorText(error)) } }
                        }) { Text((v == .all ? "👁 " : "🔒 ") + label) }
                    }
                }
            }
        }
    }
}

/// «Hablar aparte»: un sidechat desde el asunto con quienes elija; sus tareas quedan colgadas del asunto.
struct SideFromIssueSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let issueId: String
    @State private var picked: [String] = []
    @State private var question = ""
    @State private var busy = false

    var body: some View {
        NavigationStack {
            if let d = store.data, let issue = store.issues[issueId] {
                let others = issueMembers(store, d, issue.conversationId).filter { $0.id != d.me.id }
                Form {
                    Section {
                        Text(L("task.sideExplain", ["title": issue.title])).font(.footnote).foregroundStyle(Theme.textSecondary)
                        ChipFlow(spacing: 8) {
                            ForEach(others) { p in
                                TaskChip(on: picked.contains(p.id), id: "side.pick.\(p.id)", action: {
                                    if picked.contains(p.id) { picked.removeAll { $0 == p.id } } else { picked.append(p.id) }
                                }) {
                                    HStack(spacing: 6) {
                                        Avatar(name: p.name, org: Naming.org(d, p.orgId), size: 20, photo: p.avatarUrl).accessibilityHidden(true)
                                        Text(String(p.name.split(separator: " ").first ?? Substring(p.name)))
                                    }
                                }
                            }
                        }
                        TextField(L("task.sideFirst"), text: $question, axis: .vertical).lineLimit(1...4)
                            .accessibilityIdentifier("side.first")
                    }
                }
                .navigationTitle(L("task.sidechat"))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("💬 " + L("task.sideGo")) { go(issue) }
                            .disabled(busy || picked.isEmpty)
                            .accessibilityIdentifier("side.go")
                    }
                }
            } else {
                ProgressView()
            }
        }
    }

    private func go(_ issue: IssueDTO) {
        busy = true
        Task {
            do {
                let id = try await store.createSideFromIssue(issue, userIds: picked, question: question)
                dismiss()
                store.navigate(to: .conversation(id))
            } catch { store.show(L10n.errorText(error)) }
            busy = false
        }
    }
}

/// Franja en un sidechat que salió de un asunto: «◆ asunto · ☑ 1/3 · ＋ Tarea».
struct SideIssueStrip: View {
    @Environment(AppStore.self) private var store
    @Environment(\.issueSheetHost) private var host
    let sideId: String
    let issueId: String

    var body: some View {
        Group {
            if let parent = store.issues[issueId] {
                let p = IssueTasks.progress(store.issues, of: issueId)
                HStack(spacing: 8) {
                    Button { store.push(.issue(issueId)) } label: {
                        Text("◆ \(parent.title)" + (p.map { " · ☑ \($0.done)/\($0.total)" } ?? ""))
                            .font(.footnote.weight(.semibold)).foregroundStyle(Theme.accentText).lineLimit(1)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("side.issue")
                    Button("＋ " + L("task.short")) { store.requestIssueSheet(.tasks(parentId: issueId, conversationId: sideId), host: host) }
                        .font(.footnote.weight(.bold))
                        .buttonStyle(.bordered).tint(Theme.accentText)
                        .accessibilityIdentifier("side.addTask")
                }
                .padding(.horizontal, 14)
                .background(Theme.orange.opacity(0.08))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("side.issueStrip")
            }
        }
        .task(id: issueId) { if store.issues[issueId] == nil { _ = try? await store.issueDetail(issueId) } }
    }
}
