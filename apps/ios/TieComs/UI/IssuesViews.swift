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
                Avatar(name: owner?.name ?? "—", org: Naming.org(d, owner?.orgId), size: 32)
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

struct IssuesScreen: View {
    @Environment(AppStore.self) private var store
    @State private var filter = "mine"
    @State private var error: String?

    var body: some View {
        Group {
            if let d = store.data {
                let visible = Set(d.conversations.map(\.id))
                let list = store.issues.values.filter { visible.contains($0.conversationId) }
                    .filter { filter == "closed" ? $0.status.closed : !$0.status.closed && (filter == "open" || $0.ownerId == d.me.id) }
                    .sorted(by: IssueSort.order)
                let groups = Dictionary(grouping: list, by: \.workspaceId).sorted { a, b in
                    (d.workspaces.first { $0.id == a.key }?.name ?? "") < (d.workspaces.first { $0.id == b.key }?.name ?? "")
                }
                List {
                    Section {
                        Text(L("issue.pageSub")).font(.footnote).foregroundStyle(Theme.textSecondary)
                        Picker("", selection: $filter) {
                            Text(L("issue.mine")).tag("mine")
                            Text(L("issue.allOpen")).tag("open")
                            Text(L("issue.closed")).tag("closed")
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("issues.filter")
                        if let error { Text(error).foregroundStyle(.red).font(.footnote) }
                    }
                    if list.isEmpty { Text(L("issue.empty")).foregroundStyle(Theme.textSecondary) }
                    ForEach(groups, id: \.key) { wsId, items in
                        Section(d.workspaces.first { $0.id == wsId }?.name ?? "") {
                            ForEach(items) { i in NavigationLink(value: Route.issue(i.id)) { IssueRow(issue: i) } }
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
                    VStack(alignment: .leading, spacing: 3) {
                        Text("\(who?.name ?? L("common.participant")) \(e.kind == "comment" ? "" : eventText(d, e))").font(.subheadline)
                            + Text(" · \(L10n.dateTime(ISODate.parse(e.createdAt) ?? Date()))").font(.caption).foregroundColor(Theme.textSecondary)
                        if e.kind == "comment", let b = e.payload["body"]?.stringValue {
                            Text(b).font(.body).padding(8).background(RoundedRectangle(cornerRadius: 10).fill(Theme.bubbleOther))
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            Section {
                TextField(L("issue.commentPh"), text: $comment, axis: .vertical).lineLimit(1...5).accessibilityIdentifier("issue.commentField")
                Button(L("issue.comment")) {
                    let body = comment.trimmingCharacters(in: .whitespacesAndNewlines)
                    Task {
                        do { try await store.commentIssue(issueId, body: body); comment = ""; await load() } catch { self.error = L10n.errorText(error) }
                    }
                }
                .disabled(comment.trimmingCharacters(in: .whitespaces).isEmpty)
                if let error { Text(error).foregroundStyle(.red).font(.footnote) }
            }
        }
        .scrollContentBackground(.hidden)
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
