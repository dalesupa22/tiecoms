import SwiftUI

struct HomeView: View {
    @Environment(AppStore.self) private var store
    @State private var query = ""
    @State private var newChat = false
    @State private var newSpace = false
    @State private var issuesFor: String?
    @State private var collapsed = HomeCollapse.load()

    var body: some View {
        @Bindable var store = store
        Group {
            if let d = store.data {
                let tree = Naming.homeTree(d, query: query, filterWorkspace: store.workspaceFilter)
                let searching = !query.trimmingCharacters(in: .whitespaces).isEmpty
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
                    if !tree.pinned.isEmpty {
                        Section {
                            ForEach(tree.pinned) { c in convLink(d, c, indent: 0, showWs: true) }
                        } header: { HomeHeader(title: "📌 " + L("side.pinned")) }
                    }
                    Section {
                        if tree.companies.isEmpty && !searching {
                            Text(L("side.empty")).font(.footnote).foregroundStyle(Theme.textSecondary)
                        }
                        ForEach(tree.companies) { co in
                            let isOpen = searching || !collapsed.contains("org:\(co.id)")
                            let all = co.workspaces.flatMap { $0.convs.flatMap { [$0.conv] + $0.sides } }
                            CompanyRow(org: co.org, open: isOpen, unread: isOpen ? 0 : Naming.unreadCount(all)) { toggle("org:\(co.id)") }
                            if isOpen {
                                ForEach(co.workspaces) { w in
                                    let wsOpen = searching || !collapsed.contains("ws:\(w.id)")
                                    let wsAll = w.convs.flatMap { [$0.conv] + $0.sides }
                                    WorkspaceRow(ws: w.ws, orgColor: co.org.map { Color(css: $0.colorBg) }, open: wsOpen,
                                                 unread: wsOpen ? 0 : Naming.unreadCount(wsAll)) { toggle("ws:\(w.id)") }
                                        .contextMenu {
                                            Button {
                                                Task { do { try await store.setWorkspacePinned(w.ws.id, w.ws.pinnedAt == nil) } catch { store.show(L10n.errorText(error)) } }
                                            } label: { Label(w.ws.pinnedAt == nil ? L("menu.pinTop") : L("menu.unpinTop"), systemImage: "pin") }
                                            Button { store.homePath.append(.workspace(w.ws.id)) } label: { Label(L("menu.openSpace"), systemImage: "square.stack.3d.up") }
                                        }
                                    if wsOpen {
                                        ForEach(w.convs) { n in
                                            convLink(d, n.conv, indent: 1, badgeColor: co.org.map { Color(css: $0.colorBg) })
                                            ForEach(n.sides) { sc in convLink(d, sc, indent: 2) }
                                        }
                                    }
                                }
                            }
                        }
                    } header: {
                        HomeHeader(title: L("side.companies"), action: (L("side.newSpace"), { newSpace = true }), identifier: "home.newSpace")
                    }
                    Section {
                        if tree.chats.isEmpty && !searching {
                            Button { newChat = true } label: { Label(L("chat.new"), systemImage: "plus") }
                        }
                        ForEach(tree.chats) { n in
                            convLink(d, n.conv, indent: 0)
                            ForEach(n.sides) { sc in convLink(d, sc, indent: 1) }
                        }
                    } header: {
                        HomeHeader(title: L("side.directs"), action: (L("chat.new"), { newChat = true }), identifier: "home.newChatSection")
                    }
                }
                .listStyle(.insetGrouped)
                .scrollContentBackground(.hidden)
                .overlay {
                    if tree.isEmpty && searching { ContentUnavailableView.search(text: query) }
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
                    Button { newSpace = true } label: { Label(L("side.newSpace"), systemImage: "square.stack.3d.up.badge.plus") }
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
        .sheet(isPresented: $newSpace) { NewWorkspaceSheet() }
        .sheet(item: Binding(get: { issuesFor.map(IdBox.init) }, set: { issuesFor = $0?.id })) { box in
            ConversationIssuesSheet(conversationId: box.id)
        }
    }

    private func toggle(_ key: String) {
        withAnimation(.easeInOut(duration: 0.2)) {
            if collapsed.contains(key) { collapsed.remove(key) } else { collapsed.insert(key) }
        }
        HomeCollapse.save(collapsed)
    }

    @ViewBuilder
    private func convLink(_ d: BootstrapDTO, _ c: ConversationDTO, indent: Int, badgeColor: Color? = nil, showWs: Bool = false) -> some View {
        NavigationLink(value: Route.conversation(c.id)) {
            HierarchyConvRow(d: d, c: c, badgeColor: badgeColor, showWs: showWs) { issuesFor = c.id }
        }
        .listRowInsets(EdgeInsets(top: 6, leading: 16 + CGFloat(indent) * 18, bottom: 6, trailing: 12))
        .accessibilityIdentifier("conv.row.\(c.id)")
        .contextMenu { ConversationMenuItems(conv: c) }
    }
}

struct IdBox: Identifiable { let id: String }

/// Empresas y espacios plegados (se recuerda en este dispositivo).
enum HomeCollapse {
    private static let key = "tc.home.collapsed"
    static func load() -> Set<String> { Set(UserDefaults.standard.stringArray(forKey: key) ?? []) }
    static func save(_ s: Set<String>) { UserDefaults.standard.set(Array(s).sorted(), forKey: key) }
}

/// Encabezado de sección en mayúsculas con botón + opcional (como EMPRESAS Y ESPACIOS / CHATS de la web).
struct HomeHeader: View {
    var title: String
    var action: (label: String, run: () -> Void)? = nil
    var identifier: String? = nil
    var body: some View {
        HStack {
            Text(title).font(.caption.weight(.bold)).textCase(.uppercase).foregroundStyle(Theme.textSecondary)
                .accessibilityAddTraits(.isHeader)
            Spacer()
            if let action {
                Button(action: action.run) { Image(systemName: "plus").font(.subheadline.weight(.bold)) }
                    .accessibilityLabel(action.label)
                    .accessibilityIdentifier(identifier ?? "")
                    .frame(minWidth: 44, minHeight: 32)
            }
        }
    }
}

struct CompanyRow: View {
    var org: OrganizationDTO?
    var open: Bool
    var unread: Int
    var onToggle: () -> Void
    var body: some View {
        Button(action: onToggle) {
            HStack(spacing: 10) {
                OrgMark(org: org, size: 26)
                Text(org?.name ?? L("common.noCompany")).font(.body.weight(.bold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                Spacer()
                if unread > 0 { UnreadPill(count: unread, color: org.map { Color(css: $0.colorBg) }) }
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.textSecondary)
                    .rotationEffect(.degrees(open ? 90 : 0))
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel([org?.name ?? L("common.noCompany"), unread > 0 ? L("a11y.unread", ["n": unread]) : nil].compactMap { $0 }.joined(separator: ", "))
        .accessibilityValue(open ? L("a11y.expanded") : L("a11y.collapsed"))
        .accessibilityHint(L("a11y.toggleHint"))
        .accessibilityIdentifier("home.org.\(org?.id ?? "none")")
    }
}

struct WorkspaceRow: View {
    var ws: WorkspaceDTO
    var orgColor: Color?
    var open: Bool
    var unread: Int
    var onToggle: () -> Void
    var body: some View {
        Button(action: onToggle) {
            HStack(spacing: 8) {
                Rectangle().fill(Theme.textSecondary.opacity(0.35)).frame(width: 2, height: 18).accessibilityHidden(true)
                Text((ws.pinnedAt != nil ? "📌 " : "") + ws.name).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                Spacer()
                if unread > 0 { UnreadPill(count: unread, color: orgColor) }
                Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(Theme.textSecondary)
                    .rotationEffect(.degrees(open ? 90 : 0))
            }
            .padding(.leading, 8)
        }
        .buttonStyle(.plain)
        .accessibilityLabel([ws.name, unread > 0 ? L("a11y.unread", ["n": unread]) : nil].compactMap { $0 }.joined(separator: ", "))
        .accessibilityValue(open ? L("a11y.expanded") : L("a11y.collapsed"))
        .accessibilityIdentifier("home.ws.\(ws.id)")
    }
}

struct UnreadPill: View {
    var count: Int
    var color: Color? = nil
    var muted = false
    var body: some View {
        Text(count > 99 ? "99+" : "\(count)")
            .font(.caption2.weight(.bold)).foregroundStyle(.white)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(Capsule().fill(muted ? Theme.textSecondary : (color ?? Theme.bubbleMine)))
            .accessibilityHidden(true)
    }
}

/// Fila compacta de la jerarquía: ícono (# / candado / foto / ⑂ / consulta lateral), nombre y badge;
/// debajo, en letra pequeña, vista previa y hora; chip «◆ N asuntos» si hay asuntos abiertos.
struct HierarchyConvRow: View {
    @Environment(AppStore.self) private var store
    var d: BootstrapDTO
    var c: ConversationDTO
    var badgeColor: Color? = nil
    var showWs = false
    var onIssues: () -> Void

    var body: some View {
        let title = Naming.title(d, c)
        let blocked = c.memberIds.contains(where: { store.blockedUserIds.contains($0) })
        let preview = blocked ? L("safety.previewHidden") : (L10n.preview(c.lastMessagePreview) ?? L("conv.noMessages"))
        let time = L10n.timeLabel(c.lastMessageAt)
        HStack(alignment: .top, spacing: 10) {
            ConvIcon(d: d, c: c, size: 30)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(title).font(.subheadline.weight(c.unread > 0 && !c.isMuted ? .bold : .medium)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                    if showWs, let ws = d.workspaces.first(where: { $0.id == c.workspaceId }) {
                        Text("· \(ws.name)").font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(1)
                    }
                    if c.isMuted { Image(systemName: "bell.slash.fill").font(.caption2).foregroundStyle(Theme.textSecondary).accessibilityHidden(true) }
                    Spacer(minLength: 4)
                    if c.unread > 0 { UnreadPill(count: c.unread, color: badgeColor, muted: c.isMuted) }
                }
                HStack(spacing: 6) {
                    Text(preview).font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(1)
                    Spacer(minLength: 4)
                    Text(time).font(.caption2).foregroundStyle(Theme.textSecondary)
                }
                if c.openIssues > 0 {
                    Button(action: onIssues) {
                        Text("◆ " + (c.openIssues == 1 ? L("issue.countOne") : L("issue.count", ["n": c.openIssues])))
                            .font(.caption2.weight(.semibold)).foregroundStyle(Theme.accentText)
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(Capsule().fill(Theme.orange.opacity(0.12)))
                    }
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier("conv.issues.\(c.id)")
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel([title, c.isMuted ? L("side.muted") : nil, c.unread > 0 ? L("a11y.unread", ["n": c.unread]) : nil, preview, time,
                             c.openIssues > 0 ? L("issue.count", ["n": c.openIssues]) : nil].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", "))
    }
}

/// Ícono de conversación: foto del grupo, persona, varias personas, # / candado / ⑂ / consulta lateral.
struct ConvIcon: View {
    var d: BootstrapDTO
    var c: ConversationDTO
    var size: CGFloat = 30
    var body: some View {
        if let photo = c.avatarUrl, MediaURL.absolute(photo) != nil {
            Avatar(name: Naming.title(d, c), org: nil, size: size, photo: photo, fill: PersonColor.fill(c.id))
        } else if c.kind == .direct, let other = Naming.otherInDirect(d, c) {
            Avatar(person: other, org: Naming.org(d, other.orgId), size: size)
        } else if Naming.isSide(c) {
            glyph("bubble.left.and.text.bubble.right")
        } else if c.kind == .multi {
            StackedAvatars(d: d, c: c, box: size)
        } else {
            glyph(c.parentId != nil ? "arrow.triangle.branch" : c.kind == .internal ? "lock.fill" : "number")
        }
    }

    private func glyph(_ name: String) -> some View {
        Image(systemName: name)
            .font(.system(size: size * 0.45, weight: .semibold))
            .foregroundStyle(Theme.accentText)
            .frame(width: size, height: size)
            .background(RoundedRectangle(cornerRadius: size * 0.28).fill(Theme.orange.opacity(0.12)))
            .accessibilityHidden(true)
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
