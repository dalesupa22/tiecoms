import SwiftUI

struct HomeView: View {
    @Environment(AppStore.self) private var store
    @State private var query = ""
    @State private var newChat = false
    @State private var newSpace = false
    @State private var issuesFor: String?
    @State private var collapsed = HomeCollapse.load()
    @State private var tab = HomeFilter.saved

    var body: some View {
        @Bindable var store = store
        Group {
            if let d = store.data {
                let tree = Naming.homeTree(d, query: query, filterWorkspace: store.workspaceFilter, tab: tab)
                let searching = !query.trimmingCharacters(in: .whitespaces).isEmpty
                List {
                    HomeTabs(d: d, selected: $tab)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
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
                    if tab == .mentions {
                        MentionsInboxSection()
                    } else {
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
                                    WorkspaceRow(ws: w.ws, orgColor: co.org.flatMap { Theme.badgeColor($0.colorBg) }, open: wsOpen,
                                                 unread: wsOpen ? 0 : Naming.unreadCount(wsAll)) { toggle("ws:\(w.id)") }
                                        .contextMenu {
                                            Button {
                                                Task { do { try await store.setWorkspacePinned(w.ws.id, w.ws.pinnedAt == nil) } catch { store.show(L10n.errorText(error)) } }
                                            } label: { Label(w.ws.pinnedAt == nil ? L("menu.pinTop") : L("menu.unpinTop"), systemImage: "pin") }
                                            Button { store.homePath.append(.workspace(w.ws.id)) } label: { Label(L("menu.openSpace"), systemImage: "square.stack.3d.up") }
                                        }
                                    if wsOpen {
                                        ForEach(w.convs) { n in
                                            convLink(d, n.conv, indent: 1, badgeColor: co.org.flatMap { Theme.badgeColor($0.colorBg) })
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
                }
                .listStyle(.insetGrouped)
                .scrollContentBackground(.hidden)
                .animation(.spring(response: 0.45, dampingFraction: 0.9), value: tree.orderSignature)
                .overlay {
                    if tree.isEmpty && searching { ContentUnavailableView.search(text: query) }
                    else if tree.isEmpty && tab != .all && tab != .mentions {
                        ContentUnavailableView(L("home.empty.\(tab.rawValue)"), systemImage: tab == .unread ? "checkmark.seal" : "tray")
                            .accessibilityIdentifier("home.tab.emptyState")
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
                if unread > 0 { UnreadPill(count: unread, color: org.flatMap { Theme.badgeColor($0.colorBg) }) }
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.textSecondary)
                    .rotationEffect(.degrees(open ? 90 : 0))
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel([org?.name ?? L("common.noCompany"), unread > 0 ? L("a11y.unread", ["n": unread]) : nil].compactMap { $0 }.joined(separator: ", "))
        .accessibilityHint(open ? L("home.collapse") : L("home.expand"))
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
        .accessibilityHint(open ? L("home.collapse") : L("home.expand"))
        .accessibilityIdentifier("home.ws.\(ws.id)")
    }
}

/// Badge «@» junto a los no leídos cuando me mencionaron.
struct MentionBadge: View {
    var body: some View {
        Text(L("mention.badge")).font(.caption2.weight(.heavy)).foregroundStyle(.white)
            .frame(width: 20, height: 18)
            .background(Capsule().fill(Theme.badgeFallback))
            .accessibilityHidden(true)
            .accessibilityIdentifier("home.mentionBadge")
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
            .background(Capsule().fill(muted ? Theme.badgeMuted : (color ?? Theme.badgeFallback)))
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
        let preview = blocked ? L("safety.previewHidden") : (L10n.listPreview(c) ?? L("conv.noMessages"))
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
                    if c.unreadMentions > 0 { MentionBadge() }
                    if c.unread > 0 { UnreadPill(count: c.unread, color: badgeColor, muted: c.isMuted && c.unreadMentions == 0) }
                }
                HStack(spacing: 6) {
                    Text(preview).font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(1)
                    Spacer(minLength: 4)
                    Text(time).font(.caption2).foregroundStyle(Theme.textSecondary)
                }
                if c.openIssues > 0 {
                    Button(action: onIssues) {
                        Text(c.openIssues == 1 ? L("issue.chipOne") : L("issue.chipMany", ["n": c.openIssues]))
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
        .accessibilityLabel([title, c.isMuted ? L("side.muted") : nil, c.unreadMentions > 0 ? L("mention.youMentioned") : nil,
                             c.unread > 0 ? L("a11y.unread", ["n": c.unread]) : nil, preview, time,
                             c.openIssues > 0 ? (c.openIssues == 1 ? L("issue.chipOne") : L("issue.chipMany", ["n": c.openIssues])).replacingOccurrences(of: "◆ ", with: "") : nil].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", "))
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
        let preview = c.memberIds.contains(where: { store.blockedUserIds.contains($0) }) ? L("safety.previewHidden") : (L10n.listPreview(c) ?? L("conv.noMessages"))
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
                    if c.unreadMentions > 0 { MentionBadge() }
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
        if c.unreadMentions > 0 { parts.append(L("mention.youMentioned")) }
        if c.unread > 0 { parts.append(L("a11y.unread", ["n": c.unread])) }
        parts.append(preview)
        if !time.isEmpty { parts.append(time) }
        return parts.joined(separator: ", ")
    }
}


/// Pestañas grandes tipo «pill» bajo el buscador: Todo · No leídos · Asuntos · Chats · Laterales, con contador.
struct HomeTabs: View {
    let d: BootstrapDTO
    @Binding var selected: HomeFilter
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(HomeFilter.allCases) { t in
                    let n = t.count(d)
                    let on = selected == t
                    Button {
                        withAnimation(.easeInOut(duration: 0.15)) { selected = t }
                        HomeFilter.saved = t
                    } label: {
                        HStack(spacing: 6) {
                            Text(L(t.labelKey)).font(.subheadline.weight(.semibold))
                            if t != .all || n > 0 {
                                Text("\(n)").font(.caption.weight(.bold)).monospacedDigit()
                                    .padding(.horizontal, 7).padding(.vertical, 2)
                                    .background(Capsule().fill(on ? Color.white.opacity(0.25) : Theme.textSecondary.opacity(0.15)))
                            }
                        }
                        .foregroundStyle(on ? Color.white : Theme.textPrimary)
                        .padding(.horizontal, 14).frame(minHeight: 40)
                        .background(Capsule().fill(on ? Theme.bubbleMine : Theme.surface))
                        .overlay(Capsule().stroke(Theme.textSecondary.opacity(on ? 0 : 0.2)))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(L(t.labelKey)), \(n)")
                    .accessibilityAddTraits(on ? .isSelected : [])
                    .accessibilityIdentifier("home.tab.\(t.rawValue)")
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 6)
        }
    }
}

/// Bandeja «Menciones» (pestaña de Inicio): mis menciones recientes con el texto resaltado; tocar abre el mensaje.
struct MentionsInboxSection: View {
    @Environment(AppStore.self) private var store
    @State private var items: [MentionItem] = []
    @State private var hasMore = false
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        Section {
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            if items.isEmpty && !loading && error == nil {
                Text(L("mention.empty")).foregroundStyle(Theme.textSecondary).accessibilityIdentifier("mention.empty")
            }
            if let d = store.data {
                ForEach(items) { it in row(d, it) }
            }
            if loading { ProgressView().frame(maxWidth: .infinity) }
            if hasMore && !loading {
                Button(L("mention.loadMore")) { Task { await load(more: true) } }.accessibilityIdentifier("mention.loadMore")
            }
        } header: { HomeHeader(title: L("mention.inbox")) }
        .task { await load(more: false) }
    }

    private func row(_ d: BootstrapDTO, _ it: MentionItem) -> some View {
        let author = Naming.person(d, it.message.authorId)
        let conv = store.meta(it.conversationId)
        let title = conv.map { Naming.title(d, $0) } ?? ""
        return Button {
            store.jumpTo[it.conversationId] = it.message.seq
            store.navigate(to: .conversation(it.conversationId))
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Avatar(person: author, org: Naming.org(d, author?.orgId), size: 36)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 4) {
                        Text(author?.name ?? "").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.textPrimary)
                        if !title.isEmpty { Text(L("mention.inConv", ["name": title])).font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(1) }
                        Spacer(minLength: 4)
                        Text(L10n.timeLabel(it.createdAt)).font(.caption2).foregroundStyle(Theme.textSecondary)
                    }
                    Text(MentionText.attributed(AttributedString(it.message.body), text: it.message.body, mentions: it.message.mentions, mine: false, links: false))
                        .font(.subheadline).lineLimit(3).foregroundStyle(Theme.textPrimary)
                }
                if !it.read { Circle().fill(Theme.orange).frame(width: 8, height: 8).padding(.top, 6).accessibilityLabel(L("home.tab.unread")) }
            }
            .padding(.vertical, 2)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("mention.item.\(it.message.id)")
    }

    private func load(more: Bool) async {
        loading = true
        defer { loading = false }
        do {
            let page = try await store.loadMentions(before: more ? items.last?.createdAt : nil)
            items = more ? items + page.mentions.filter { n in !items.contains { $0.id == n.id } } : page.mentions
            hasMore = page.hasMore
            error = nil
        } catch { self.error = L10n.errorText(error) }
    }
}
