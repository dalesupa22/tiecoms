import SwiftUI

/// Señales de cuello de botella (mismas reglas que Issues.tsx).
enum IssueSort {
    static let stallDays = 2

    static func flags(_ i: IssueDTO, now: Date = Date()) -> (stalledDays: Int, overdue: Bool, dueToday: Bool) {
        guard !i.status.closed else { return (0, false, false) }
        let since = ISODate.parse(i.statusSince) ?? now
        let days = Int(now.timeIntervalSince(since) / 86400)
        let today = IssueDates.iso(now)
        let overdue = i.dueDate.map { $0 < today } ?? false
        return (days >= stallDays ? days : 0, overdue, i.dueDate == today)
    }

    static func order(_ a: IssueDTO, _ b: IssueDTO) -> Bool {
        let fa = flags(a).stalledDays, fb = flags(b).stalledDays
        if fa != fb { return fa > fb }
        return (a.dueDate ?? "9") < (b.dueDate ?? "9")
    }

    static func dueLabel(_ i: IssueDTO) -> String {
        guard let d = IssueDates.date(i.dueDate) else { return L("issue.noDue") }
        return d.formatted(Date.FormatStyle().day().month(.abbreviated).locale(L10n.locale))
    }
}

struct StatusPill: View {
    let status: IssueStatus
    var body: some View {
        let color: Color = switch status {
        case .open: .blue
        case .in_progress: Theme.accentText
        case .waiting: .purple
        case .done: .green
        case .cancelled: .gray
        }
        Text(L("issue.st.\(status.rawValue)"))
            .font(.caption2.weight(.bold))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(Capsule().fill(color.opacity(0.15)))
            .foregroundStyle(color)
    }
}

struct IssueRow: View {
    @Environment(AppStore.self) private var store
    let issue: IssueDTO
    var showWhere = true
    var body: some View {
        if let d = store.data {
            let owner = Naming.person(d, issue.ownerId)
            let conv = store.meta(issue.conversationId)
            let f = IssueSort.flags(issue)
            HStack(spacing: 10) {
                Avatar(name: owner?.name ?? "—", org: Naming.org(d, owner?.orgId), size: 32, photo: owner?.avatarUrl)
                VStack(alignment: .leading, spacing: 2) {
                    Text(issue.title).font(.body.weight(.semibold)).foregroundStyle(Theme.textPrimary).lineLimit(2)
                    Text([owner?.name ?? L("common.none"), showWhere ? conv.map { L("issue.in", ["name": Naming.title(d, $0)]) } : nil].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(1)
                    HStack(spacing: 6) {
                        if f.stalledDays > 0 {
                            Text("⏱ " + (f.stalledDays == 1 ? L("issue.stalledOne") : L("issue.stalled", ["n": f.stalledDays])))
                                .font(.caption2.weight(.semibold)).foregroundStyle(.orange)
                        }
                        Text(f.overdue ? L("issue.overdue") : f.dueToday ? L("issue.today") : IssueSort.dueLabel(issue))
                            .font(.caption2).foregroundStyle(f.overdue ? .red : Theme.textSecondary)
                    }
                }
                Spacer(minLength: 4)
                StatusPill(status: issue.status)
            }
            .padding(.vertical, 2)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("issue.row.\(issue.id)")
        }
    }
}

/// Asuntos en la jerarquía: Empresa → Espacio → Conversación → asuntos (como Inicio).
enum IssueTree {
    struct Conv: Identifiable { var conv: ConversationDTO?; var id: String; var issues: [IssueDTO] }
    struct Ws: Identifiable { var ws: WorkspaceDTO?; var id: String; var convs: [Conv] }
    struct Company: Identifiable {
        var org: OrganizationDTO?; var id: String; var workspaces: [Ws]
        var isChats: Bool { id == IssueTree.chatsId }
    }
    static let chatsId = "__chats"

    enum Filter: String, CaseIterable { case mine, open, all }

    static func filter(_ list: [IssueDTO], _ f: Filter, me: String) -> [IssueDTO] {
        switch f {
        case .mine: return list.filter { !$0.status.closed && $0.ownerId == me }
        case .open: return list.filter { !$0.status.closed }
        case .all: return list
        }
    }

    static func group(_ d: BootstrapDTO, _ issues: [IssueDTO]) -> [Company] {
        let visible = Set(d.conversations.map(\.id))
        var out: [String: Company] = [:]
        var order: [String] = []
        let inScope = issues.filter { visible.contains($0.conversationId) }
        // Directos, multi y laterales (sin espacio): sección «Chats» después de las empresas.
        let chatItems = inScope.filter { $0.workspaceId == nil }
        let byWs = Dictionary(grouping: inScope.filter { $0.workspaceId != nil }, by: { $0.workspaceId ?? "" })
        for (wsId, items) in byWs {
            let ws = d.workspaces.first { $0.id == wsId }
            let org = ws.flatMap { Naming.counterpartOrg(d, $0) }
            let key = org?.id ?? "none"
            if out[key] == nil { order.append(key); out[key] = Company(org: org, id: key, workspaces: []) }
            let convs = Dictionary(grouping: items, by: \.conversationId).map { cid, list in
                Conv(conv: d.conversations.first { $0.id == cid }, id: cid, issues: list.sorted(by: IssueSort.order))
            }.sorted { a, b in
                (a.conv.map { Naming.title(d, $0) } ?? "").localizedCaseInsensitiveCompare(b.conv.map { Naming.title(d, $0) } ?? "") == .orderedAscending
            }
            out[key]!.workspaces.append(Ws(ws: ws, id: wsId, convs: convs))
        }
        var companies = order.compactMap { out[$0] }.map { var c = $0
            c.workspaces.sort { ($0.ws?.name ?? "").localizedCaseInsensitiveCompare($1.ws?.name ?? "") == .orderedAscending }
            return c
        }.sorted { ($0.org?.name ?? "~").localizedCaseInsensitiveCompare($1.org?.name ?? "~") == .orderedAscending }
        if !chatItems.isEmpty {
            let convs = Dictionary(grouping: chatItems, by: \.conversationId).map { cid, list in
                Conv(conv: d.conversations.first { $0.id == cid }, id: cid, issues: list.sorted(by: IssueSort.order))
            }.sorted { a, b in
                (a.conv.map(HomeOrder.activity) ?? "") > (b.conv.map(HomeOrder.activity) ?? "")
            }
            companies.append(Company(org: nil, id: chatsId, workspaces: [Ws(ws: nil, id: chatsId, convs: convs)]))
        }
        return companies
    }
}

struct IssuesScreen: View {
    @Environment(AppStore.self) private var store
    @State private var filter = IssueTree.Filter.mine
    @State private var error: String?

    var body: some View {
        Group {
            if let d = store.data {
                let list = IssueTree.filter(Array(store.issues.values), filter, me: d.me.id)
                let tree = IssueTree.group(d, list)
                List {
                    Section {
                        Text(L("issue.pageSub")).font(.footnote).foregroundStyle(Theme.textSecondary)
                        Picker("", selection: $filter) {
                            Text(L("issue.mine")).tag(IssueTree.Filter.mine)
                            Text(L("issue.allOpen")).tag(IssueTree.Filter.open)
                            Text(L("issue.all")).tag(IssueTree.Filter.all)
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("issues.filter")
                        if let error { Text(error).foregroundStyle(.red).font(.footnote) }
                    }
                    if tree.isEmpty { Text(L("issue.empty")).foregroundStyle(Theme.textSecondary) }
                    ForEach(tree) { co in
                        Section {
                            ForEach(co.workspaces) { w in
                                if !co.isChats { HStack(spacing: 8) {
                                    Rectangle().fill(Theme.textSecondary.opacity(0.35)).frame(width: 2, height: 16)
                                    Text(w.ws?.name ?? "").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.textSecondary)
                                }
                                .accessibilityAddTraits(.isHeader) }
                                ForEach(w.convs) { cv in
                                    if let conv = cv.conv {
                                        NavigationLink(value: Route.conversation(conv.id)) {
                                            HStack(spacing: 6) {
                                                ConvIcon(d: d, c: conv, size: 22)
                                                Text(Naming.title(d, conv)).font(.subheadline.weight(.semibold)).lineLimit(1)
                                            }
                                        }
                                        .listRowInsets(EdgeInsets(top: 4, leading: 30, bottom: 4, trailing: 12))
                                    }
                                    ForEach(cv.issues) { i in
                                        NavigationLink(value: Route.issue(i.id)) { IssueRow(issue: i, showWhere: false) }
                                            .listRowInsets(EdgeInsets(top: 6, leading: 48, bottom: 6, trailing: 12))
                                    }
                                }
                            }
                        } header: {
                            HStack(spacing: 8) {
                                if co.isChats {
                                    Image(systemName: "bubble.left.and.bubble.right").foregroundStyle(Theme.accentText)
                                    Text(L("issue.chatsSection")).font(.subheadline.weight(.bold)).foregroundStyle(Theme.textPrimary).textCase(nil)
                                } else {
                                    OrgMark(org: co.org, size: 20)
                                    Text(co.org?.name ?? L("common.noCompany")).font(.subheadline.weight(.bold)).foregroundStyle(Theme.textPrimary).textCase(nil)
                                }
                            }
                        }
                    }
                }
                .listStyle(.insetGrouped)
                .scrollContentBackground(.hidden)
                .refreshable { await load() }
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(L("nav.issues"))
        .task { await load() }
    }

    private func load() async {
        do { try await store.loadIssues(); error = nil } catch { self.error = L10n.errorText(error) }
    }
}

struct IssueDetailView: View {
    @Environment(AppStore.self) private var store
    let issueId: String
    @State private var events: [IssueEventDTO] = []
    @State private var comment = ""
    @State private var sending = false
    @State private var error: String?

    var body: some View {
        Group {
            if let d = store.data, let i = store.issues[issueId] {
                detail(d, i)
            } else if let error {
                ContentUnavailableView(error, systemImage: "exclamationmark.triangle")
            } else {
                ProgressView()
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(store.issues[issueId]?.title ?? L("nav.issues"))
        .navigationBarTitleDisplayMode(.inline)
        .task(id: store.issues[issueId]?.updatedAt) { await load() }
    }

    private func load() async {
        do { events = try await store.issueDetail(issueId).events } catch { self.error = L10n.errorText(error) }
    }

    private func update(_ patch: [String: Any]) {
        Task { do { try await store.updateIssue(issueId, patch) } catch { self.error = L10n.errorText(error) } }
    }

    @ViewBuilder
    private func detail(_ d: BootstrapDTO, _ i: IssueDTO) -> some View {
        let conv = store.meta(i.conversationId)
        let members = (conv?.memberIds ?? []).compactMap { Naming.person(d, $0) }.filter { $0.kind == "human" }
        let orgIds = Array(Set(members.compactMap(\.orgId)))
        let f = IssueSort.flags(i)
        let requester = Naming.person(d, i.requestedBy)
        Form {
            Section {
                Text(i.title).font(.title3.weight(.semibold))
                Text([conv.map { Naming.title(d, $0) }, requester.map { L("issue.requestedBy", ["name": $0.name]) } ?? L("issue.manual")].compactMap { $0 }.joined(separator: " · "))
                    .font(.footnote).foregroundStyle(Theme.textSecondary)
                if f.stalledDays > 0 || f.overdue {
                    Label("\(L("issue.bottleneck")) · " + [f.overdue ? L("issue.overdue") : nil, f.stalledDays > 0 ? (f.stalledDays == 1 ? L("issue.stalledOne") : L("issue.stalled", ["n": f.stalledDays])) : nil].compactMap { $0 }.joined(separator: " · "),
                          systemImage: "timer").foregroundStyle(.orange).font(.footnote.weight(.semibold))
                }
            }
            Section(L("issue.status")) {
                Picker(L("issue.status"), selection: Binding(get: { i.status }, set: { update(["status": $0.rawValue]) })) {
                    ForEach(IssueStatus.allCases, id: \.self) { Text(L("issue.st.\($0.rawValue)")).tag($0) }
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("issue.statusPicker")
                Picker(L("issue.owner"), selection: Binding(get: { i.ownerId ?? "" }, set: { update(["ownerId": $0.isEmpty ? NSNull() : $0]) })) {
                    Text(L("common.none")).tag("")
                    ForEach(members) { p in Text("\(p.name) · \(Naming.org(d, p.orgId)?.name ?? L("common.guest"))").tag(p.id) }
                }
                DueDateRow(due: i.dueDate) { update(["dueDate": $0.map(IssueDates.iso) ?? NSNull()]) }
                if i.status == .waiting {
                    Picker(L("issue.waitingOn"), selection: Binding(get: { i.waitingOnOrgId ?? "" }, set: { update(["waitingOnOrgId": $0.isEmpty ? NSNull() : $0]) })) {
                        Text(L("issue.waitingOnPh")).tag("")
                        ForEach(orgIds, id: \.self) { o in Text(Naming.org(d, o)?.name ?? "").tag(o) }
                    }
                }
            }
            if i.originMessageId != nil {
                Section {
                    if let conv, let seq = i.originMessageSeq, seq > conv.historyFromSeq {
                        NavigationLink(value: Route.conversation(conv.id)) { Label(L("issue.origin"), systemImage: "arrow.up.forward") }
                    } else {
                        Text(L("issue.originOut")).font(.footnote).foregroundStyle(Theme.textSecondary)
                    }
                }
            }
            Section(L("issue.history")) {
                ForEach(events) { e in
                    let who = Naming.person(d, e.actorId)
                    HStack(alignment: .top, spacing: 10) {
                        Avatar(name: who?.name ?? "?", org: nil, isAgent: who?.kind == "agent", size: 28, photo: who?.avatarUrl, fill: PersonColor.fill(e.actorId))
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(alignment: .firstTextBaseline, spacing: 4) {
                                Text(who?.name ?? L("common.participant")).font(.subheadline.weight(.semibold)).foregroundStyle(PersonColor.text(e.actorId))
                                Text(L10n.dateTime(ISODate.parse(e.createdAt) ?? Date())).font(.caption).foregroundStyle(Theme.textSecondary)
                            }
                            if e.kind == "comment", let b = e.payload["body"]?.stringValue {
                                Text(b).font(.body).padding(.horizontal, 10).padding(.vertical, 7)
                                    .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bubbleOther))
                                    .textSelection(.enabled)
                            } else {
                                Text(eventText(d, e)).font(.subheadline).foregroundStyle(Theme.textSecondary)
                            }
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier(e.kind == "comment" ? "issue.comment.\(e.id)" : "issue.event.\(e.id)")
                }
            }
            if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
        }
        .scrollContentBackground(.hidden)
        .safeAreaInset(edge: .bottom) { commentComposer }
    }

    /// Un solo compositor: campo + «Comentar» a la derecha (se habilita con texto).
    private var commentComposer: some View {
        let body = comment.trimmingCharacters(in: .whitespacesAndNewlines)
        return HStack(alignment: .bottom, spacing: 8) {
            TextField(L("issue.commentPh"), text: $comment, axis: .vertical)
                .lineLimit(1...5)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: 20).fill(Theme.background))
                .overlay(RoundedRectangle(cornerRadius: 20).stroke(Theme.textSecondary.opacity(0.25)))
                .accessibilityLabel(L("issue.commentPh"))
                .accessibilityIdentifier("issue.commentField")
            Button {
                sending = true
                Task {
                    do { try await store.commentIssue(issueId, body: body); comment = ""; error = nil; await load() }
                    catch { self.error = L10n.errorText(error) }
                    sending = false
                }
            } label: {
                if sending { ProgressView().frame(minWidth: 80, minHeight: 40) } else {
                    Text(L("issue.comment")).font(.subheadline.weight(.semibold)).frame(minWidth: 80, minHeight: 40)
                }
            }
            .primaryProminent()
            .disabled(body.isEmpty || sending)
            .accessibilityIdentifier("issue.commentSend")
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Theme.surface.ignoresSafeArea(edges: .bottom))
    }

    private func eventText(_ d: BootstrapDTO, _ e: IssueEventDTO) -> String {
        let to = e.payload["to"]?.stringValue
        switch e.kind {
        case "created": return L("issue.ev.created")
        case "status": return L("issue.ev.status", ["to": L("issue.st.\(to ?? "open")")])
        case "owner": return "\(L("issue.ev.owner")) → \(Naming.person(d, to)?.name ?? L("common.none"))"
        case "due": return L("issue.ev.due", ["to": IssueDates.date(to).map { $0.formatted(Date.FormatStyle().day().month(.abbreviated).locale(L10n.locale)) } ?? L("issue.noDue")])
        case "title": return "\(L("issue.ev.title")) → «\(to ?? "")»"
        case "waiting": return L("issue.ev.waiting") + (to.flatMap { Naming.org(d, $0)?.name }.map { ": \($0)" } ?? "")
        default: return ""
        }
    }
}

/// Fecha límite opcional.
private struct DueDateRow: View {
    let due: String?
    let onChange: (Date?) -> Void
    var body: some View {
        let has = Binding(get: { due != nil }, set: { onChange($0 ? (IssueDates.date(due) ?? Date().addingTimeInterval(86400)) : nil) })
        Toggle(L("issue.due"), isOn: has)
        if let date = IssueDates.date(due) {
            DatePicker(L("issue.due"), selection: Binding(get: { date }, set: { onChange($0) }), displayedComponents: .date)
        }
    }
}
