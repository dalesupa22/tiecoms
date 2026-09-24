import SwiftUI

struct HomeView: View {
    @Environment(AppStore.self) private var store
    @State private var query = ""

    var body: some View {
        @Bindable var store = store
        Group {
            if let d = store.data {
                let sections = Naming.sections(d, filterWorkspace: store.workspaceFilter, query: query)
                List {
                    if store.connection != .online {
                        ConnectionBanner(connection: store.connection)
                            .listRowBackground(Color.clear)
                            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                    }
                    if let wid = store.workspaceFilter, let ws = d.workspaces.first(where: { $0.id == wid }) {
                        HStack {
                            Label(ws.name, systemImage: "square.stack.3d.up").font(.subheadline.weight(.semibold))
                            Spacer()
                            Button(L("home.showAll")) { store.workspaceFilter = nil }
                                .font(.subheadline)
                                .accessibilityIdentifier("home.clearFilter")
                        }
                        .listRowBackground(Color.clear)
                    }
                    ForEach(sections) { s in
                        Section {
                            ForEach(s.conversations) { c in
                                NavigationLink(value: Route.conversation(c.id)) { ConversationRow(d: d, c: c) }
                                    .accessibilityIdentifier("conv.row.\(c.id)")
                            }
                        } header: {
                            SectionHeader(d: d, section: s)
                        }
                    }
                }
                .listStyle(.insetGrouped)
                .scrollContentBackground(.hidden)
                .overlay {
                    if sections.isEmpty {
                        if query.isEmpty {
                            ContentUnavailableView(L("home.emptyTitle"), systemImage: "bubble.left.and.bubble.right", description: Text(L("home.emptyBody")))
                        } else {
                            ContentUnavailableView.search(text: query)
                        }
                    }
                }
                .refreshable { await store.refreshAll() }
            } else {
                ProgressView()
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(L("nav.inbox"))
        .searchable(text: $query, prompt: L("inbox.search"))
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(value: Route.settings) { Image(systemName: "gearshape") }
                    .accessibilityLabel(L("settings.title"))
                    .accessibilityIdentifier("home.settings")
            }
        }
    }
}

struct ConnectionBanner: View {
    var connection: AppStore.Connection
    var body: some View {
        HStack(spacing: 8) {
            if connection == .connecting { ProgressView().controlSize(.small) } else { Image(systemName: "wifi.slash") }
            Text(connection == .connecting ? L("conn.connecting") : L("conn.offline")).font(.footnote)
        }
        .foregroundStyle(Theme.textSecondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("conn.banner")
    }
}

private struct SectionHeader: View {
    var d: BootstrapDTO
    var section: Naming.Section
    var body: some View {
        HStack(spacing: 8) {
            if let ws = section.workspace {
                let orgs = ws.organizationIds.compactMap { Naming.org(d, $0) }
                HStack(spacing: -6) { ForEach(orgs.prefix(3)) { OrgMark(org: $0, size: 20) } }
                Text(ws.name)
            } else {
                Text(section.title)
            }
        }
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(Theme.textSecondary)
        .textCase(nil)
        .accessibilityAddTraits(.isHeader)
    }
}

struct ConversationRow: View {
    var d: BootstrapDTO
    var c: ConversationDTO

    var body: some View {
        let title = Naming.title(d, c)
        let preview = L10n.preview(c.lastMessagePreview) ?? L("conv.noMessages")
        let time = L10n.timeLabel(c.lastMessageAt)
        HStack(spacing: 12) {
            icon
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(title).font(.body.weight(c.unread > 0 ? .semibold : .regular)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                    Spacer(minLength: 6)
                    Text(time).font(.caption).foregroundStyle(c.unread > 0 ? Theme.accentText : Theme.textSecondary)
                }
                HStack(alignment: .top) {
                    Text(preview).font(.subheadline).foregroundStyle(Theme.textSecondary).lineLimit(2)
                    Spacer(minLength: 6)
                    if c.unread > 0 {
                        Text(c.unread > 99 ? "99+" : "\(c.unread)")
                            .font(.caption.weight(.bold)).foregroundStyle(.white)
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background(Capsule().fill(Theme.bubbleMine))
                            .accessibilityHidden(true)
                    }
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText(title: title, preview: preview, time: time))
    }

    @ViewBuilder private var icon: some View {
        if c.kind == .direct, let other = Naming.otherInDirect(d, c) {
            Avatar(name: other.name, org: Naming.org(d, other.orgId), isAgent: other.kind == "agent", size: 44)
        } else {
            Image(systemName: c.kind == .internal ? "lock.fill" : "number")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Theme.accentText)
                .frame(width: 44, height: 44)
                .background(RoundedRectangle(cornerRadius: 12).fill(Theme.orange.opacity(0.14)))
                .accessibilityHidden(true)
        }
    }

    private func accessibilityText(title: String, preview: String, time: String) -> String {
        var parts = [title]
        if c.kind == .internal { parts.append(L("kind.internalShort")) }
        if c.unread > 0 { parts.append(L("a11y.unread", ["n": c.unread])) }
        parts.append(preview)
        if !time.isEmpty { parts.append(time) }
        return parts.joined(separator: ", ")
    }
}
