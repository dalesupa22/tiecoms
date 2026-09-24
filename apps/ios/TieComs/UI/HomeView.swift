import SwiftUI

struct HomeView: View {
    @Environment(AppStore.self) private var store
    @State private var query = ""
    @State private var newChat = false

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
                                    .contextMenu { ConversationMenuItems(conv: c) }
                            }
                        } header: {
                            SectionHeader(d: d, section: s)
                                .contextMenu {
                                    if let ws = s.workspace {
                                        Button {
                                            Task { do { try await store.setWorkspacePinned(ws.id, ws.pinnedAt == nil) } catch { store.show(L10n.errorText(error)) } }
                                        } label: { Label(ws.pinnedAt == nil ? L("menu.pinTop") : L("menu.unpinTop"), systemImage: "pin") }
                                        Button { store.workspaceFilter = ws.id } label: { Label(L("menu.openSpace"), systemImage: "square.stack.3d.up") }
                                    }
                                }
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
                Menu {
                    Button { store.homePath.append(.reminders) } label: {
                        Label(store.reminders.isEmpty ? L("rem.title") : "\(L("rem.title")) (\(store.reminders.count))", systemImage: "alarm")
                    }
                    Button { store.homePath.append(.files) } label: { Label(L("nav.files"), systemImage: "folder") }
                    Button { store.homePath.append(.trazo) } label: { Label(L("nav.trazo"), systemImage: "arrow.triangle.branch") }
                    Button { store.homePath.append(.whatsapp) } label: { Label(L("nav.whatsapp"), systemImage: "message") }
                } label: {
                    Image(systemName: store.reminders.contains { (ISODate.parse($0.remindAt) ?? .distantFuture) <= Date() } ? "bell.badge" : "ellipsis.circle")
                }
                .accessibilityLabel(L("menu.open"))
                .accessibilityIdentifier("home.more")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { newChat = true } label: { Image(systemName: "square.and.pencil") }
                    .accessibilityLabel(L("chat.new"))
                    .accessibilityIdentifier("home.newChat")
            }
        }
        .sheet(isPresented: $newChat) { NewChatSheet() }
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
    @Environment(AppStore.self) private var store
    var d: BootstrapDTO
    var c: ConversationDTO

    var body: some View {
        let title = Naming.title(d, c)
        let preview = c.memberIds.contains(where: { store.blockedUserIds.contains($0) }) ? L("safety.previewHidden") : (L10n.preview(c.lastMessagePreview) ?? L("conv.noMessages"))
        let time = L10n.timeLabel(c.lastMessageAt)
        HStack(spacing: 12) {
            icon
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(title).font(.body.weight(c.unread > 0 ? .semibold : .regular)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                    if c.isMuted { Image(systemName: "bell.slash.fill").font(.caption2).foregroundStyle(Theme.textSecondary).accessibilityHidden(true) }
                    if c.openIssues > 0 {
                        Text("◆ \(c.openIssues)").font(.caption2.weight(.semibold)).foregroundStyle(Theme.accentText).accessibilityHidden(true)
                    }
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
                            .background(Capsule().fill(c.isMuted ? Theme.textSecondary : Theme.bubbleMine))
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
            Avatar(person: other, org: Naming.org(d, other.orgId), size: 44, badge: true)
        } else if c.kind == .multi {
            StackedAvatars(d: d, c: c, box: 44)
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
        if c.kind == .multi { parts.append(Naming.subtitle(d, c)) }
        if c.isMuted { parts.append(L("side.muted")) }
        if c.pinnedAt != nil { parts.append(L("side.pinned")) }
        if c.unread > 0 { parts.append(L("a11y.unread", ["n": c.unread])) }
        parts.append(preview)
        if !time.isEmpty { parts.append(time) }
        return parts.joined(separator: ", ")
    }
}
