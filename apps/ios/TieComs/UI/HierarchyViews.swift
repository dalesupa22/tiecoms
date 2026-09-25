import SwiftUI

/// Espacio (tema): empresas participantes y sus conversaciones (subtemas) con sus asuntos.
struct WorkspaceDetailsView: View {
    @Environment(AppStore.self) private var store
    let workspaceId: String
    @State private var issuesFor: String?

    var body: some View {
        content
            .background(Theme.background.ignoresSafeArea())
            .navigationBarTitleDisplayMode(.inline)
            .sheet(item: Binding(get: { issuesFor.map(IdBox.init) }, set: { issuesFor = $0?.id })) { ConversationIssuesSheet(conversationId: $0.id) }
    }

    @ViewBuilder private var content: some View {
        if let d = store.data, let ws = d.workspaces.first(where: { $0.id == workspaceId }) {
            list(d, ws).navigationTitle(ws.name)
        } else {
            ContentUnavailableView(L("ws.notFound"), systemImage: "lock.slash")
        }
    }

    private func list(_ d: BootstrapDTO, _ ws: WorkspaceDTO) -> some View {
        let convs = d.conversations.filter { $0.workspaceId == ws.id && !Naming.isSide($0) }
            .sorted { ($0.lastMessageAt ?? "") > ($1.lastMessageAt ?? "") }
        let color: Color? = Naming.counterpartOrg(d, ws).map { Color(css: $0.colorBg) }
        return List {
            Section { header(d, ws) }
            Section {
                ForEach(convs) { c in
                    NavigationLink(value: Route.conversation(c.id)) {
                        HierarchyConvRow(d: d, c: c, badgeColor: color) { issuesFor = c.id }
                    }
                }
            } header: { Text(L("ws.yourGroups")) } footer: { Text(L("ws.onlyYours")) }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
    }

    private func header(_ d: BootstrapDTO, _ ws: WorkspaceDTO) -> some View {
        let orgs = ws.organizationIds.compactMap { Naming.org(d, $0) }
        return VStack(alignment: .leading, spacing: 6) {
            Text(ws.name).font(.title3.weight(.semibold))
            if let dep = ws.department, !dep.isEmpty { Text(dep).font(.subheadline).foregroundStyle(Theme.textSecondary) }
            HStack(spacing: 6) {
                ForEach(orgs) { o in
                    HStack(spacing: 4) { OrgMark(org: o, size: 18); Text(o.name).font(.caption) }
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Nuevo espacio con un cliente (NewWorkspaceDialog de la web).
struct NewWorkspaceSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var department = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        SheetForm(title: L("dlg.newSpace"), action: L("dlg.createSpace"), busy: busy,
                  disabled: name.trimmingCharacters(in: .whitespaces).count < 2, error: error, onSubmit: submit) {
            Section {
                Text(L("dlg.newSpaceBody")).font(.footnote).foregroundStyle(Theme.textSecondary)
                TextField(L("dlg.spaceNamePh"), text: $name).accessibilityLabel(L("dlg.spaceName")).accessibilityIdentifier("space.name")
                TextField(L("dlg.departmentPh"), text: $department).accessibilityLabel(L("dlg.department"))
            }
        }
    }

    private func submit() {
        busy = true; error = nil
        Task {
            do {
                let general = try await store.createWorkspace(name: name.trimmingCharacters(in: .whitespaces), department: department)
                dismiss()
                if let general { store.navigate(to: .conversation(general)) }
            } catch { self.error = L10n.errorText(error) }
            busy = false
        }
    }
}

/// Barra «Asuntos abiertos (N)» del chat, bajo los fijados; se despliega con los asuntos de la conversación.
struct OpenIssuesBar: View {
    @Environment(AppStore.self) private var store
    let conversationId: String
    @State private var open = false
    var body: some View {
        let list = store.issues.values.filter { $0.conversationId == conversationId && !$0.status.closed }.sorted(by: IssueSort.order)
        if !list.isEmpty {
            VStack(spacing: 0) {
                Button { withAnimation(.easeInOut(duration: 0.2)) { open.toggle() } } label: {
                    HStack {
                        Label(L("issue.openBar", ["n": list.count]), systemImage: "checklist").font(.footnote.weight(.semibold))
                        Spacer()
                        Image(systemName: "chevron.down").rotationEffect(.degrees(open ? 180 : 0)).font(.caption)
                    }
                    .padding(.horizontal, 16).padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.accentText)
                .accessibilityHint(open ? L("home.collapse") : L("home.expand"))
                .accessibilityIdentifier("chat.issuesBar")
                if open {
                    VStack(spacing: 0) {
                        ForEach(list.prefix(6)) { i in
                            NavigationLink(value: Route.issue(i.id)) { IssueRow(issue: i, showWhere: false).padding(.horizontal, 16).padding(.vertical, 6) }
                                .buttonStyle(.plain)
                            Divider().padding(.leading, 16)
                        }
                    }
                    .background(Theme.surface)
                }
            }
            .background(Theme.orange.opacity(0.06))
        }
    }
}
