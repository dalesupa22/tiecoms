import SwiftUI
import UIKit

// MARK: Trazo

struct TrazoScreen: View {
    @Environment(AppStore.self) private var store

    private struct Node: Identifiable { var c: ConversationDTO; var depth: Int; var id: String { c.id } }

    var body: some View {
        Group {
            if let d = store.data {
                let convs = d.conversations.filter { $0.kind != .direct }
                let ids = Set(convs.map(\.id))
                let kids: (String) -> [ConversationDTO] = { id in convs.filter { $0.parentId == id }.sorted { ($0.lastMessageAt ?? "") < ($1.lastMessageAt ?? "") } }
                let roots = convs.filter { !kids($0.id).isEmpty && ($0.parentId.map { !ids.contains($0) } ?? true) }
                    + convs.filter { $0.parentId != nil && !ids.contains($0.parentId!) && kids($0.id).isEmpty }
                List {
                    Section { Text(L("trazo.sub")).font(.footnote).foregroundStyle(Theme.textSecondary) }
                    if roots.isEmpty { Text(L("trazo.empty")).foregroundStyle(Theme.textSecondary) }
                    ForEach(roots) { root in
                        let nodes = walk(root, 0, kids)
                        Section {
                            ForEach(nodes) { n in
                                NavigationLink(value: Route.conversation(n.c.id)) {
                                    VStack(alignment: .leading, spacing: 3) {
                                        HStack(spacing: 6) {
                                            Text(Naming.title(d, n.c)).font(.body.weight(.semibold)).lineLimit(1)
                                            if let k = n.c.deriveKind { Text(L("lin.kind.\(k)")).font(.caption2.weight(.bold)).foregroundStyle(Theme.accentText) }
                                        }
                                        if n.c.parentId != nil {
                                            Text(n.c.returnedAt.map { "↩ " + L("trazo.returnedOn", ["date": L10n.shortDate($0)]) } ?? "● " + L("trazo.open"))
                                                .font(.caption).foregroundStyle(n.c.returnedAt != nil ? .green : .orange)
                                        }
                                        if let r = n.c.deriveReason, !r.isEmpty { Text(r).font(.caption).foregroundStyle(Theme.textSecondary) }
                                        HStack(spacing: 4) {
                                            ForEach(Naming.companies(d, n.c)) { OrgMark(org: $0, size: 16) }
                                            Text("· \(n.c.memberIds.count)").font(.caption2).foregroundStyle(Theme.textSecondary)
                                        }
                                    }
                                    .padding(.leading, CGFloat(n.depth) * 18)
                                }
                            }
                        } header: {
                            Text("\(Naming.title(d, root)) · \(L("trazo.tramos", ["n": nodes.count]))").textCase(nil)
                        }
                    }
                }
                .listStyle(.insetGrouped)
                .scrollContentBackground(.hidden)
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(L("nav.trazo"))
    }

    private func walk(_ c: ConversationDTO, _ depth: Int, _ kids: (String) -> [ConversationDTO]) -> [Node] {
        [Node(c: c, depth: depth)] + kids(c.id).flatMap { walk($0, depth + 1, kids) }
    }
}

// MARK: Recordatorios

struct RemindersScreen: View {
    @Environment(AppStore.self) private var store
    @State private var error: String?

    var body: some View {
        let now = Date()
        let due = store.reminders.filter { (ISODate.parse($0.remindAt) ?? now) <= now }
        let upcoming = store.reminders.filter { (ISODate.parse($0.remindAt) ?? now) > now }
        List {
            if store.reminders.isEmpty { Text(L("rem.empty")).foregroundStyle(Theme.textSecondary) }
            if !due.isEmpty { Section(L("rem.due")) { ForEach(due) { row($0) } } }
            if !upcoming.isEmpty { Section(L("rem.upcoming")) { ForEach(upcoming) { row($0) } } }
            if let error { Text(error).foregroundStyle(.red).font(.footnote) }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(L("rem.title"))
        .refreshable { try? await store.loadReminders() }
        .task { try? await store.loadReminders() }
    }

    @ViewBuilder private func row(_ r: ReminderDTO) -> some View {
        let conv = store.meta(r.conversationId)
        let title = r.note?.isEmpty == false ? r.note! : conv.flatMap { c in store.data.map { Naming.title($0, c) } } ?? ""
        HStack {
            NavigationLink(value: Route.conversation(r.conversationId)) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("⏰ \(title)").font(.body.weight(.semibold)).lineLimit(2)
                    Text(L10n.dateTime(ISODate.parse(r.remindAt) ?? Date())).font(.caption).foregroundStyle(Theme.textSecondary)
                }
            }
        }
        .swipeActions(edge: .trailing) {
            Button(L("rem.done")) { run { try await store.completeReminder(r.id) } }.tint(.green)
            Button(L("rem.snooze")) { run { try await store.snoozeReminder(r.id, until: Date().addingTimeInterval(3600)) } }.tint(.orange)
        }
        .contextMenu {
            Button(L("rem.done")) { run { try await store.completeReminder(r.id) } }
            Button(L("rem.snooze")) { run { try await store.snoozeReminder(r.id, until: Date().addingTimeInterval(3600)) } }
        }
        .accessibilityIdentifier("reminder.\(r.id)")
    }

    private func run(_ f: @escaping () async throws -> Void) {
        Task { do { try await f() } catch { self.error = L10n.errorText(error) } }
    }
}

// MARK: WhatsApp

/// Pantalla WhatsApp: arriba solo el buscador, las categorías y Grupos/Todos, con una línea compacta de cuentas
/// («● 2 cuentas conectadas ›») que abre su hoja. Tocar un chat abre sus mensajes; la pulsación larga, el menú del chat.
/// «Mostrar ocultos», «Reorganizar» y «Conectar» van en ⋯ de la barra.
struct WhatsAppScreen: View {
    @Environment(AppStore.self) private var store
    @State private var accounts: [WaAccountDTO]?
    @State private var max = 5
    @State private var chats: [WaChatDTO] = []
    @State private var chatTokens: [String: Int] = [:]
    @State private var counts: [String: WaChatsPage.Count] = [:]
    @State private var category: WaCategory?
    @State private var onlyGroups = false
    @State private var nextPage: String?
    @State private var hasMore = false
    @State private var syncPartial = false
    @State private var loadingMore = false
    /// Ya llegó la primera lista (antes: «…», sin contadores en 0 que luego saltan).
    @State private var loaded = false
    @State private var loadGeneration = UUID()
    @Environment(\.scenePhase) private var scenePhase
    @State private var showHidden = false
    @State private var query = ""
    @State private var connecting = false
    @State private var managing = false
    @State private var appeared = false
    @State private var error: String?

    var body: some View {
        let list = accounts ?? []
        let multi = list.count > 1
        let workOnly = store.waWorkOnly
        let rows = WaWorkOnly.filter(chats.filter { store.waPrivacy.allows($0.inboxKey) && chatTokens[$0.inboxKey] == store.waPrivacy.token($0.inboxKey) }, on: workOnly)
            .sorted(by: WaRecency.before)
        let cats = workOnly ? WaCategory.allCases.filter(WaWorkOnly.categories.contains) : WaCategory.allCases
        List {
            if let accounts, accounts.isEmpty {
                // Solo sin cuentas: qué es y cómo conectar.
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("👤  🏪").font(.title)
                        Text(L("wa.emptyTitle")).font(.headline)
                        Text(L("wa.intro")).font(.footnote).foregroundStyle(Theme.textSecondary)
                        Button(L("wa.connect")) { connecting = true }.buttonStyle(PrimaryButtonStyle()).accessibilityIdentifier("wa.connect")
                    }
                    .padding(.vertical, 6)
                }
            } else if !list.isEmpty {
                Section { accountsLine(list) }
            }
            if !list.isEmpty || !chats.isEmpty {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) {
                                workOnlyChip(workOnly)
                                chip(nil, L("wa.cat.all"), counts.isEmpty ? nil : WaWorkOnly.total(counts, on: workOnly))
                                ForEach(cats, id: \.self) { c in
                                    chip(c, "\(c.icon) \(L("wa.cat.\(c.rawValue)"))", counts.isEmpty ? nil : counts[c.rawValue]?.total ?? 0)
                                }
                            }
                        }
                        Picker("", selection: $onlyGroups) { Text(L("wa.groups")).tag(true); Text(L("wa.allChats")).tag(false) }
                            .pickerStyle(.segmented)
                            .accessibilityIdentifier("wa.onlyGroups")
                    }
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 2, leading: 16, bottom: 2, trailing: 16))
                Section {
                    if !loaded { HStack { Spacer(); ProgressView(); Spacer() }.accessibilityIdentifier("wa.loading") }
                    else if rows.isEmpty { Text(list.contains { $0.status == "connected" } ? L("wa.noChats") : L("wa.syncing")).foregroundStyle(Theme.textSecondary) }
                    ForEach(rows) { c in
                        NavigationLink(value: Route.waChat(c)) { WaChatRow(chat: c, multi: multi) }
                            .accessibilityIdentifier("wa.chat.\(c.inboxKey)")
                            .contextMenu { WaChatMenuItems(chat: c) { replace($0) } }
                            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                                Button { togglePin(c) } label: {
                                    Label(c.pinned ? L("wa.inboxUnpin") : L("wa.inboxPin"), systemImage: c.pinned ? "pin.slash.fill" : "pin.fill")
                                }
                                .tint(c.pinned ? .gray : WaColors.badge)
                                .accessibilityIdentifier("wa.swipe.pin.\(c.inboxKey)")
                            }
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                Button(role: c.hidden ? nil : .destructive) { setHidden(c, !c.hidden) } label: {
                                    Label(c.hidden ? L("wa.unhide") : L("wa.hide"), systemImage: c.hidden ? "eye" : "eye.slash")
                                }
                                .accessibilityIdentifier("wa.swipe.hide.\(c.inboxKey)")
                            }
                    }
                }
            }
            if syncPartial { Text(L("wa.partial")).font(.caption).foregroundStyle(Theme.textSecondary) }
            if hasMore { Button(L("wa.loadMore")) { Task { await loadMoreChats() } }.disabled(loadingMore) }
            if let error { Text(error).foregroundStyle(.red).font(.footnote) }
        }
        .refreshable { await loadAccounts(); await loadChats() }
        .onChange(of: scenePhase) { _, p in if p == .active { Task { await loadAccounts(); await loadChats() } } }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Theme.background.ignoresSafeArea())
        // Arriba, siempre a la vista (antes flotaba abajo sobre la lista).
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: L("wa.search"))
        .navigationTitle(L("wa.title"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Toggle(isOn: $showHidden) { Label(L("wa.showHidden"), systemImage: "eye") }
                        .accessibilityIdentifier("wa.more.showHidden")
                    Button { reorganize() } label: { Label(L("wa.reorganize"), systemImage: "sparkles") }
                        .accessibilityIdentifier("wa.more.reorganize")
                    Divider()
                    if !list.isEmpty {
                        Button { managing = true } label: { Label(L("wa.accountsTitle"), systemImage: "person.2") }
                            .accessibilityIdentifier("wa.more.accounts")
                    }
                    if list.count < max {
                        Button { connecting = true } label: { Label(L("wa.connect"), systemImage: "plus") }
                            .accessibilityIdentifier("wa.more.connect")
                    }
                } label: { Image(systemName: "ellipsis.circle") }
                .accessibilityLabel(L("wa.more"))
                .accessibilityIdentifier("wa.more")
            }
        }
        .sheet(isPresented: $connecting) { WaConnectSheet(existing: list) { Task { await loadAccounts(); managing = true } } }
        .sheet(isPresented: $managing) { WaAccountsSheet(accounts: list, max: max) { Task { await loadAccounts(); await loadChats() } } }
        .onChange(of: store.waPrivacy.revision) { _, _ in
            chats.removeAll { chatTokens[$0.inboxKey] != store.waPrivacy.token($0.inboxKey) || !store.waPrivacy.allows($0.inboxKey) }
            counts = [:]; loadGeneration = UUID(); nextPage = nil; hasMore = false
        }
        // Al volver de un chat: la lista se refresca (pines, ocultos o categoría cambiados allí).
        .onAppear { if appeared { Task { await loadChats() } }; appeared = true }
        .task(id: store.waRevision) { await loadAccounts(); await loadChats() }
        .task(id: "\(category?.rawValue ?? "all")|\(onlyGroups)|\(showHidden)|\(query)") {
            if !query.isEmpty { try? await Task.sleep(nanoseconds: 250_000_000) }
            await loadChats()
        }
        .task(id: accounts?.contains(where: \.isWaiting) == true) {
            // Mientras hay un código en pantalla se pregunta seguido: el QR cambia cada ~20 s.
            while accounts?.contains(where: \.isWaiting) == true && !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                await loadAccounts()
            }
        }
    }

    /// «● 2 cuentas conectadas ›»: abre la hoja de cuentas (conectar, desconectar, «Responder desde chaggu», QR).
    private func accountsLine(_ list: [WaAccountDTO]) -> some View {
        let connected = list.filter { $0.status == "connected" }.count
        let waiting = list.contains(where: \.isWaiting)
        let text: String = connected == list.count
            ? (connected == 1 ? L("wa.accounts.one") : L("wa.accounts.many", ["n": connected]))
            : waiting ? L("wa.accounts.waiting") : L("wa.accounts.some", ["c": connected, "n": list.count])
        let color: Color = connected == list.count ? WaColors.green : waiting ? .orange : .red
        return Button { managing = true } label: {
            HStack(spacing: 8) {
                Circle().fill(color).frame(width: 8, height: 8).accessibilityHidden(true)
                Text(text).font(.subheadline.weight(.medium)).foregroundStyle(Theme.textPrimary)
                if list.count > 1 { HStack(spacing: 3) { ForEach(list) { WaAccountDot(accountId: $0.id, size: 7) } } }
                Spacer()
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.textSecondary).accessibilityHidden(true)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("wa.accounts")
    }

    /// «💼 Solo trabajo»: solo Trabajo y Clientes (se recuerda en el dispositivo). El número, cuántos quedan.
    private func workOnlyChip(_ on: Bool) -> some View {
        Button {
            Haptics.tap()
            store.waWorkOnly.toggle()
            if store.waWorkOnly, let c = category, !WaWorkOnly.categories.contains(c) { category = nil }
        } label: {
            HStack(spacing: 4) {
                Text(L("wa.workOnly"))
                if on, !counts.isEmpty { Text("\(WaWorkOnly.total(counts, on: true))").monospacedDigit().foregroundStyle(Theme.textSecondary) }
            }
        }
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(Capsule().fill(on ? Theme.orange.opacity(0.2) : Theme.bubbleOther))
        .overlay(Capsule().stroke(on ? Theme.orange.opacity(0.6) : .clear))
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("wa.workOnly")
    }

    private func chip(_ c: WaCategory?, _ label: String, _ n: Int?) -> some View {
        Button { category = c } label: {
            HStack(spacing: 4) {
                Text(label)
                // Sin contador hasta que llega (nada de «Todos 0» que luego salta).
                if let n { Text("\(n)").monospacedDigit().foregroundStyle(Theme.textSecondary) }
            }
        }
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(Capsule().fill(category == c ? Theme.orange.opacity(0.2) : Theme.bubbleOther))
        .buttonStyle(.plain)
        .accessibilityAddTraits(category == c ? .isSelected : [])
        .accessibilityIdentifier("wa.cat.\(c?.rawValue ?? "all")")
    }

    private func loadAccounts() async {
        do { let r = try await store.waAccounts(); accounts = r.accounts; max = r.max; error = nil } catch { self.error = L10n.errorText(error); if accounts == nil { accounts = [] } }
    }

    private func loadChats() async {
        let generation = UUID(); loadGeneration = generation
        let stamp = store.sessionStamp
        do {
            let r = try await store.waChats(accountId: nil, category: category, onlyGroups: onlyGroups, showHidden: showHidden, query: query)
            guard !Task.isCancelled, stamp == store.sessionStamp, generation == loadGeneration else { return }
            chatTokens = Dictionary(r.chats.map { ($0.inboxKey, store.waPrivacy.token($0.inboxKey)) }, uniquingKeysWith: { a, _ in a })
            chats = r.chats; counts = r.categories; nextPage = r.next; hasMore = r.hasMore; syncPartial = r.syncPartial; error = nil
            loaded = true
        } catch { if generation == loadGeneration, stamp == store.sessionStamp, !Task.isCancelled { self.error = L10n.errorText(error); loaded = true } }
    }

    private func loadMoreChats() async {
        guard !loadingMore, hasMore, let cursor = nextPage else { return }
        loadingMore = true; defer { loadingMore = false }
        let generation = loadGeneration, stamp = store.sessionStamp
        do {
            let page = try await store.waChats(accountId: nil, category: category, onlyGroups: onlyGroups, showHidden: showHidden, query: query, cursor: cursor)
            guard !Task.isCancelled, generation == loadGeneration, stamp == store.sessionStamp else { return }
            let old = Set(chats.map(\.id)); chats += page.chats.filter { !old.contains($0.id) }
            for c in page.chats { chatTokens[c.inboxKey] = store.waPrivacy.token(c.inboxKey) }
            nextPage = page.next; hasMore = page.hasMore && page.next != cursor; syncPartial = page.syncPartial
        } catch { if generation == loadGeneration, stamp == store.sessionStamp { self.error = L10n.errorText(error) } }
    }

    private func reorganize() {
        Task {
            do { let n = try await store.waOrganize(); store.show(L("wa.organized", ["n": n])); await loadChats() }
            catch { store.show(L10n.errorText(error)) }
        }
    }

    /// Deslizar a la derecha: «Fijar en WhatsApp» (o quitar).
    private func togglePin(_ c: WaChatDTO) {
        Haptics.tap()
        Task {
            do { let up = try await store.waSetPinned(c, !c.pinned); replace(up); store.show(up.pinned ? L("toast.pinned") : L("toast.unpinned")) }
            catch { store.show(L10n.errorText(error)) }
        }
    }

    /// Deslizar a la izquierda: Ocultar, con «Deshacer».
    private func setHidden(_ c: WaChatDTO, _ hidden: Bool) {
        Haptics.tap()
        if hidden && !showHidden { chats.removeAll { $0.id == c.id } }
        Task {
            do {
                let up = try await store.waSetHidden(c, hidden)
                if hidden {
                    store.show(L("wa.hiddenToast")) {
                        Task { if let back = try? await store.waSetHidden(up, false) { replace(back) } }
                    }
                } else { replace(up) }
            } catch { store.show(L10n.errorText(error)); await loadChats() }
        }
    }

    private func replace(_ up: WaChatDTO) {
        if up.hidden && !showHidden { chats.removeAll { $0.id == up.id } }
        else if chats.contains(where: { $0.id == up.id }) { chats = chats.map { $0.id == up.id ? up : $0 } }
        Task { await loadChats() }
    }
}

/// Fila de la pantalla WhatsApp: avatar, 📌 si está fijado en WhatsApp, nombre, hora, vista previa y no leídos. Sin la
/// línea «cuenta · categoría»: con varias cuentas, un punto de color en el avatar.
private struct WaChatRow: View {
    let chat: WaChatDTO
    let multi: Bool
    var body: some View {
        HStack(spacing: 10) {
            Avatar(name: chat.name.isEmpty ? "WhatsApp" : chat.name, org: nil, size: 38, fill: PersonColor.fill(chat.inboxKey))
                .overlay(alignment: .bottomTrailing) { if multi { WaAccountDot(accountId: chat.accountId, size: 11).offset(x: 2, y: 2) } }
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 4) {
                    if chat.pinned { Text("📌").font(.caption2).accessibilityHidden(true).accessibilityIdentifier("wa.pinned.\(chat.inboxKey)") }
                    Text(chat.name).font(.body.weight(chat.unread > 0 ? .semibold : .regular)).lineLimit(1)
                    if chat.hidden { Image(systemName: "eye.slash").font(.caption2).foregroundStyle(Theme.textSecondary) }
                    Spacer(minLength: 4)
                    Text(L10n.timeLabel(chat.lastMessageAt)).font(.caption2).foregroundStyle(Theme.textSecondary)
                }
                HStack(spacing: 6) {
                    Text(chat.lastPreview ?? (chat.isGroup && chat.participants != nil ? L("wa.members", ["n": chat.participants!]) : ""))
                        .font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(1)
                    Spacer(minLength: 4)
                    if chat.linkedConversationId != nil {
                        Image(systemName: "arrow.left.arrow.right").font(.caption2.weight(.semibold)).foregroundStyle(Theme.accentText)
                            .accessibilityLabel(L("wa.linkedShort"))
                    }
                    if chat.unread > 0 { UnreadPill(count: chat.unread, color: WaColors.badge) }
                }
            }
        }
        .foregroundStyle(Theme.textPrimary)
        .accessibilityElement(children: .combine)
        .accessibilityLabel([chat.name, multi ? chat.accountLabel : nil, chat.pinned ? L("wa.pinnedInWa") : nil, chat.hidden ? L("wa.hiddenShort") : nil,
                             chat.unread > 0 ? L("a11y.unread", ["n": chat.unread]) : nil, chat.lastPreview].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", "))
    }
}

/// Hoja de cuentas: lo que antes eran las tarjetas grandes arriba de la lista (estado, QR, desconectar,
/// «Responder desde chaggu») y el botón para conectar otra.
struct WaAccountsSheet: View {
    @Environment(\.dismiss) private var dismiss
    let accounts: [WaAccountDTO]
    let max: Int
    var onChanged: () -> Void
    @State private var connecting = false
    var body: some View {
        NavigationStack {
            List {
                ForEach(accounts) { a in Section { WaAccountCard(account: a, multi: accounts.count > 1, onChanged: onChanged) } }
                if accounts.count < max {
                    Section { Button(L("wa.connect")) { connecting = true }.accessibilityIdentifier("wa.connect") }
                }
                Section { Label(L("wa.privacy"), systemImage: "lock").font(.footnote).foregroundStyle(Theme.textSecondary) }
            }
            .navigationTitle(L("wa.accountsTitle"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(L("common.done")) { dismiss() }.accessibilityIdentifier("wa.accounts.done") } }
            .sheet(isPresented: $connecting) { WaConnectSheet(existing: accounts) { onChanged() } }
        }
        .presentationDetents([.medium, .large])
    }
}

struct WaAccountCard: View {
    @Environment(AppStore.self) private var store
    let account: WaAccountDTO
    var multi = false
    var onChanged: () -> Void
    @State private var usePhone = false
    @State private var phone = ""
    @State private var confirm = false
    @State private var busy = false
    @State private var sendOn: Bool?
    @State private var confirmSend = false

    var body: some View {
        let a = account
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(a.isBusiness ? "🏪" : "👤").font(.title2).accessibilityHidden(true)
                VStack(alignment: .leading) {
                    HStack(spacing: 6) {
                        if multi { WaAccountDot(accountId: a.id, size: 9) }
                        Text(a.label).font(.headline)
                        Text(a.isBusiness ? "WhatsApp Business" : "WhatsApp").font(.caption2).foregroundStyle(Theme.textSecondary)
                    }
                    Text([a.phone.map { "+\($0)" }, a.pushName].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(Theme.textSecondary)
                }
                Spacer()
                Circle().fill(a.status == "connected" ? Color.green : a.isWaiting ? Color.orange : Color.red).frame(width: 10, height: 10).accessibilityHidden(true)
            }
            HStack(spacing: 4) {
                Text(L("wa.status.\(a.status)")).font(.subheadline.weight(.semibold))
                if a.status == "connected" { Text("· " + L("wa.counts", ["chats": a.chats, "groups": a.groups])).font(.subheadline).foregroundStyle(Theme.textSecondary) }
                if let e = a.lastError, a.status != "connected", a.status != "qr" { Text("· \(e)").font(.caption).foregroundStyle(Theme.textSecondary) }
            }
            .accessibilityIdentifier("wa.status.\(a.id)")
            if a.status == "pending" { Text(L("wa.preparing")).font(.footnote).foregroundStyle(Theme.textSecondary) }
            if a.status == "qr" {
                if let code = a.pairingCode {
                    Text(code.count == 8 ? "\(code.prefix(4))-\(code.suffix(4))" : code)
                        .font(.system(size: 32, weight: .bold, design: .monospaced))
                        .accessibilityLabel(L("wa.pairingCode") + " " + code.map(String.init).joined(separator: " "))
                } else if let img = qrImage(a.qr) {
                    Image(uiImage: img).interpolation(.none).resizable().scaledToFit().frame(width: 220, height: 220)
                        .accessibilityLabel(L("wa.qrAlt"))
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("1. " + L(a.isBusiness ? "wa.step1b" : "wa.step1"))
                    Text("2. " + L("wa.step2"))
                    Text("3. " + L(a.pairingCode != nil ? "wa.step3code" : "wa.step3"))
                }
                .font(.footnote)
            }
            if ["expired", "logged_out", "error"].contains(a.status) {
                if usePhone { TextField(L("wa.phonePh"), text: $phone).keyboardType(.phonePad) }
                HStack {
                    Button(L("wa.newCode")) { run { _ = try await store.waRelink(a.id, pairPhone: usePhone ? phone : nil) } }.disabled(busy)
                    Button(usePhone ? L("wa.useQr") : L("wa.usePhone")) { usePhone.toggle() }
                }
                .buttonStyle(.bordered)
            }
            if a.status == "connected" {
                // «Responder desde chaggu»: apagado, solo lectura; encenderlo pide confirmación.
                Toggle(isOn: Binding(get: { sendOn ?? a.sendEnabled }, set: { v in if v { confirmSend = true } else { setSend(false) } })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(L("wa.sendOpt")).font(.subheadline.weight(.medium))
                        Text(L("wa.sendHint")).font(.caption).foregroundStyle(Theme.textSecondary)
                    }
                }
                .disabled(busy)
                .accessibilityIdentifier("wa.sendToggle.\(a.id)")
            }
            HStack { Spacer(); Button(L("wa.disconnect"), role: .destructive) { confirm = true }.font(.footnote) }
        }
        .onChange(of: a.sendEnabled) { _, _ in sendOn = nil }
        .confirmationDialog(L("wa.disconnectConfirm", ["label": a.label]), isPresented: $confirm, titleVisibility: .visible) {
            Button(L("wa.disconnect"), role: .destructive) { run { try await store.waRemove(a.id) } }
        }
        .alert(L("wa.sendOpt"), isPresented: $confirmSend) {
            Button(L("wa.activate")) { setSend(true) }
            Button(L("common.cancel"), role: .cancel) {}
        } message: { Text(L("wa.sendConfirm", ["name": a.label])) }
    }

    private func setSend(_ on: Bool) {
        sendOn = on
        run(toast: on ? L("wa.sendOnToast") : L("wa.sendOffToast")) { _ = try await store.waSetSendEnabled(account.id, on) }
    }

    private func run(toast: String? = nil, _ f: @escaping () async throws -> Void) {
        busy = true
        Task {
            do { try await f(); if let toast { store.show(toast) }; onChanged() } catch { sendOn = nil; store.show(L10n.errorText(error)) }
            busy = false
        }
    }

    private func qrImage(_ s: String?) -> UIImage? {
        guard let s, let comma = s.firstIndex(of: ","), let data = Data(base64Encoded: String(s[s.index(after: comma)...])) else { return nil }
        return UIImage(data: data)
    }
}

struct WaConnectSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let existing: [WaAccountDTO]
    var onDone: () -> Void
    @State private var kind = "personal"
    @State private var label = ""
    @State private var usePhone = true
    @State private var phone = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        let fallback = kind == "business" ? "Business" : L("wa.personal")
        SheetForm(title: L("wa.connectTitle"), action: L("wa.start"), busy: busy,
                  disabled: usePhone && phone.filter(\.isNumber).count < 8, error: error, onSubmit: submit) {
            Section {
                Text(L("wa.connectBody")).font(.footnote).foregroundStyle(Theme.textSecondary)
                Picker("", selection: $kind) { Text("WhatsApp").tag("personal"); Text("WhatsApp Business").tag("business") }.pickerStyle(.segmented)
                Text(L("wa.kind.\(kind)")).font(.caption).foregroundStyle(Theme.textSecondary)
                TextField("\(L("wa.label")) (\(fallback))", text: $label)
            }
            Section {
                Picker("", selection: $usePhone) { Text(L("wa.withQr")).tag(false); Text(L("wa.withPhone")).tag(true) }.pickerStyle(.segmented)
                if usePhone {
                    TextField(L("wa.phonePh"), text: $phone).keyboardType(.phonePad).textContentType(.telephoneNumber)
                    Text(L("wa.phoneHint")).font(.caption).foregroundStyle(Theme.textSecondary)
                }
            }
            Section { Label(L("wa.privacy"), systemImage: "lock").font(.footnote).foregroundStyle(Theme.textSecondary) }
        }
        .onAppear { if existing.contains(where: { $0.kind == "personal" }) { kind = "business" } }
    }

    private func submit() {
        busy = true; error = nil
        let fallback = kind == "business" ? "Business" : L("wa.personal")
        Task {
            do {
                _ = try await store.waCreate(label: label.trimmingCharacters(in: .whitespaces).isEmpty ? fallback : label, kind: kind,
                                             pairPhone: usePhone && !phone.isEmpty ? phone : nil)
                store.show(L("wa.linking"))
                onDone()
                dismiss()
            } catch { self.error = L10n.errorText(error) }
            busy = false
        }
    }
}

/// Un chat de WhatsApp abierto: sus mensajes y, abajo, el compositor (si la cuenta tiene «Responder desde chaggu»; si
/// no, la barra de solo lectura para activarlo). Los ajustes del chat (pines, lista principal, categoría, ocultar,
/// traer a un chat de chaggu) van en ⋯ de la barra.
struct WaChatView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State var chat: WaChatDTO
    var onPatched: (WaChatDTO) -> Void = { _ in }
    @State private var messages: [WaMessageDTO]?
    @State private var account: WaAccountDTO?
    @State private var draft = ""
    @State private var sending = false
    /// Enviados que el puente aún no confirmó (salen como burbujas «Enviando…»).
    @State private var outbox: [(id: UUID, text: String)] = []
    @State private var confirmSend = false
    @State private var settings = false
    @State private var sharing: WaMessageDTO?
    // gg de este chat de WhatsApp (fuente wa:<cuenta>:<jid>).
    @State private var ggOpen = false
    @State private var ggQuotes: [GgQuote] = []
    @State private var ggAsk: String?
    @State private var selecting = false
    @State private var selected: Set<String> = []
    @State private var suggesting = false
    @State private var ggQueue: [GgOutcome] = []
    @State private var taskPrefill: GgPrefill?
    @State private var reminderPrefill: GgPrefill?
    @FocusState private var composerFocused: Bool

    private var source: String { GgSource.whatsapp(chat) }

    var body: some View {
        ScrollViewReader { proxy in
            List {
                if messages == nil { HStack { Spacer(); ProgressView(); Spacer() }.listRowBackground(Color.clear).listRowSeparator(.hidden) }
                if messages?.isEmpty == true && outbox.isEmpty {
                    Text(L("wa.noMessages")).font(.footnote).foregroundStyle(Theme.textSecondary)
                        .listRowBackground(Color.clear).listRowSeparator(.hidden)
                }
                ForEach(messages ?? []) { m in bubbleRow(m).id(m.id) }
                ForEach(outbox, id: \.id) { o in
                    pendingBubble(o.text).id(o.id.uuidString)
                }
                Color.clear.frame(height: 1).id("wa.bottom").listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.background.ignoresSafeArea())
            .scrollDismissesKeyboard(.interactively)
            .accessibilityIdentifier("wa.messages")
            .onChange(of: (messages?.last?.id ?? "") + "\(outbox.count)") { _, _ in
                DispatchQueue.main.async { proxy.scrollTo("wa.bottom", anchor: .bottom) }
            }
        }
        .navigationTitle(chat.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            // El nombre y, pegado, el sello gg pequeñito (como en el chat de chaggu).
            ToolbarItem(placement: .principal) {
                HStack(spacing: 2) {
                    Text(chat.name).font(.headline).foregroundStyle(Theme.textPrimary).lineLimit(1).truncationMode(.tail)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityIdentifier("wa.chat.title")
                    if store.ggSide.available != false { GgHeaderButton(source: source) { ggOpen = true } }
                }
                .frame(maxWidth: max(120, UIScreen.main.bounds.width - 150))
            }
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    WaChatMenuItems(chat: chat) { up in patched(up) }
                    Divider()
                    Button { settings = true } label: { Label(L("wa.chatSettings"), systemImage: "slider.horizontal.3") }
                        .accessibilityIdentifier("wa.chat.settings")
                } label: { Image(systemName: "ellipsis.circle") }
                .accessibilityLabel(L("wa.more"))
                .accessibilityIdentifier("wa.chat.more")
            }
        }
        .safeAreaInset(edge: .bottom) {
            if selecting {
                GgSelectionBar(count: selected.count, onCancel: { selecting = false; selected = [] }, onAsk: { suggesting = true })
            } else {
                VStack(spacing: 0) {
                    if store.ggSide.used.contains(source) { GgContinueBar { ggOpen = true }.padding(.bottom, 6) }
                    composer
                }
                .background(.bar)
            }
        }
        .task(id: store.waRevision) { await loadMessages() }
        .task { await loadAccount() }
        // El número del botón gg de este chat (se había perdido en 1.7.8).
        .task(id: source) { if store.waPrivacy.allows(source) { await store.ggSidePending([source]) } }
        .alert(L("wa.sendOpt"), isPresented: $confirmSend) {
            Button(L("wa.activate")) { enableSend() }
            Button(L("common.cancel"), role: .cancel) {}
        } message: { Text(L("wa.sendConfirm", ["name": account?.label ?? chat.accountLabel])) }
        .sheet(isPresented: $settings) { WaChatSettingsSheet(chat: $chat) { up in patched(up) } }
        .sheet(item: $sharing) { m in WaShareSheet(chat: chat, message: m) }
        .sheet(isPresented: $ggOpen, onDismiss: { ggAsk = nil; runQueue() }) {
            GgSideSheet(source: source, chatTitle: chat.name, quotes: $ggQuotes, initialAsk: ggAsk) { ggQueue = [$0] }
        }
        .sheet(isPresented: $suggesting, onDismiss: runQueue) {
            GgSuggestSheet(source: source, messageIds: Array(selected), onDo: { list in
                ggQueue = list; selecting = false; selected = []
            }, onAsk: { text in
                ggQuotes = (messages ?? []).filter { selected.contains($0.id) }.map(quote)
                ggAsk = text; selecting = false; selected = []
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { ggOpen = true }
            })
        }
        // Sin chat de chaggu, la tarea es personal (el diálogo deja elegir otro destino).
        .sheet(item: $taskPrefill, onDismiss: runQueue) { p in NewIssueSheet(conversationId: nil, origin: nil, prefill: p) }
        .sheet(item: $reminderPrefill, onDismiss: runQueue) { p in
            if let linked = chat.linkedConversationId { ReminderSheet(conversationId: linked, message: nil, prefill: p) }
            else { NewIssueSheet(conversationId: nil, origin: nil, prefill: p) }
        }
        .waPrivateSource(source)
        .onChange(of: store.waPrivacy.token(source)) { _, _ in clearPrivateState(); dismiss() }
    }

    // MARK: Mensajes

    private func bubbleRow(_ m: WaMessageDTO) -> some View {
        HStack(spacing: 8) {
            if selecting { GgSelectCircle(on: selected.contains(m.id)) }
            if m.fromMe { Spacer(minLength: 40) }
            VStack(alignment: .leading, spacing: 3) {
                if !m.fromMe, chat.isGroup, let a = m.author { Text(a).font(.caption.weight(.semibold)).foregroundStyle(PersonColor.text(a)) }
                if !m.body.isEmpty { Text(m.body).font(.body).foregroundStyle(m.fromMe ? .white : Theme.textPrimary).textSelection(.enabled) }
                if let media = m.media { WaNativeMedia(accountId: chat.accountId, jid: chat.jid, messageId: m.id, media: media, mine: m.fromMe) }
                HStack(spacing: 6) {
                    Text(L10n.dateTime(ISODate.parse(m.sentAt) ?? Date())).font(.caption2)
                        .foregroundStyle(m.fromMe ? Color.white.opacity(0.8) : Theme.textSecondary)
                    // Como «⤴ Llevar a un chat» de la web.
                    if store.mailEnabled && !m.body.isEmpty && !selecting {
                        Button { sharing = m } label: { Text("⤴ " + L("wa.bringShort")).font(.caption2.weight(.semibold)) }
                            .buttonStyle(.borderless)
                            .foregroundStyle(m.fromMe ? .white : Theme.accentText)
                            .accessibilityIdentifier("wa.bringShort")
                    }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 16).fill(m.fromMe ? Theme.bubbleMine : Theme.bubbleOther))
            if !m.fromMe { Spacer(minLength: 40) }
        }
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets(top: 3, leading: 12, bottom: 3, trailing: 12))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("wa.msg.\(m.id)")
        .overlay {
            if selecting {
                Color.clear.contentShape(Rectangle()).onTapGesture { toggle(m.id) }
                    .accessibilityAddTraits(selected.contains(m.id) ? .isSelected : [])
            }
        }
        // Correo y WhatsApp en el chat (docs/CORREO.md): pulsación larga › «Comentar en chaggu…».
        // gg: «✨ Preguntar a gg» y «Seleccionar».
        .contextMenu {
            if !m.body.isEmpty {
                Button { UIPasteboard.general.string = m.body; store.show(L("toast.copied")) } label: { Label(L("common.copy"), systemImage: "doc.on.doc") }
            }
            if store.mailEnabled && !m.body.isEmpty {
                Button { sharing = m } label: { Label(L("wa.bring"), systemImage: "arrowshape.turn.up.right") }
                    .accessibilityIdentifier("wa.bring")
            }
            if store.ggSide.available == true && !m.body.isEmpty {
                Button { ggQuotes = [quote(m)]; ggOpen = true } label: { Label(L("ggs.ask"), systemImage: "sparkles") }
                    .accessibilityIdentifier("menu.askGg")
                Button { selecting = true; selected = [m.id] } label: { Label(L("ggs.select"), systemImage: "checkmark.circle") }
                    .accessibilityIdentifier("menu.select")
            }
        }
    }

    private func pendingBubble(_ text: String) -> some View {
        HStack {
            Spacer(minLength: 40)
            VStack(alignment: .trailing, spacing: 3) {
                Text(text).foregroundStyle(.white)
                Label(L("wa.sending"), systemImage: "clock").font(.caption2).foregroundStyle(Color.white.opacity(0.8))
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 16).fill(Theme.bubbleMine.opacity(0.75)))
        }
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets(top: 3, leading: 12, bottom: 3, trailing: 12))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("wa.pending")
    }

    /// Un cambio del chat: la copia de aquí y, si está en Grupos/DMs, su fila.
    private func patched(_ up: WaChatDTO) {
        chat = up
        if up.inInbox || store.waInbox.contains(where: { $0.id == up.id }) { store.upsertWaInbox(up) }
        onPatched(up)
    }

    // MARK: Compositor

    @ViewBuilder private var composer: some View {
        if let a = account {
            if a.status != "connected" {
                Label(L("wa.offline"), systemImage: "wifi.slash").font(.footnote).foregroundStyle(Theme.textSecondary)
                    .frame(maxWidth: .infinity).padding(12)
                    .accessibilityIdentifier("wa.offlineBar")
            } else if a.sendEnabled {
                HStack(alignment: .bottom, spacing: 8) {
                    TextField(L("wa.composerPh"), text: $draft, axis: .vertical)
                        .lineLimit(1...5)
                        .focused($composerFocused)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(RoundedRectangle(cornerRadius: 18).fill(Theme.surface))
                        .accessibilityIdentifier("wa.composer")
                    Button { send() } label: {
                        Image(systemName: "arrow.up.circle.fill").font(.system(size: 32)).foregroundStyle(WaColors.badge)
                    }
                    .disabled(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityLabel(L("wa.send"))
                    .accessibilityIdentifier("wa.sendButton")
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
            } else {
                HStack(spacing: 8) {
                    Image(systemName: "lock").foregroundStyle(Theme.textSecondary).accessibilityHidden(true)
                    Text(L("wa.readOnly")).font(.footnote).foregroundStyle(Theme.textSecondary)
                    Spacer(minLength: 4)
                    Button(L("wa.enableSend")) { confirmSend = true }.font(.footnote.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.75)
                        .accessibilityIdentifier("wa.enableSend")
                }
                .padding(.horizontal, 16).padding(.vertical, 12)
            }
        }
    }

    private func send() {
        let t = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, !sending else { return }
        sending = true
        let pending = (id: UUID(), text: t)
        outbox.append(pending); draft = ""
        Task {
            defer { sending = false }
            do {
                let r = try await store.waSend(chat, text: t)
                switch r.status {
                case "sent": await loadMessages(); outbox.removeAll { $0.id == pending.id }
                case "queued": store.show(L("wa.queued"))
                default:
                    outbox.removeAll { $0.id == pending.id }; draft = t
                    store.show(L("wa.sendFailed", ["error": r.error ?? ""]))
                }
            } catch {
                outbox.removeAll { $0.id == pending.id }; draft = t
                store.show(L10n.errorText(error))
            }
        }
    }

    private func enableSend() {
        Task {
            do { account = try await store.waSetSendEnabled(chat.accountId, true); store.show(L("wa.sendOnToast")); composerFocused = true }
            catch { store.show(L10n.errorText(error)) }
        }
    }

    private func loadMessages() async {
        do { let result = try await store.waMessages(chat); guard !Task.isCancelled else { return }; messages = result }
        catch { if messages == nil { messages = [] }; if !store.waPrivacy.allows(source) { clearPrivateState(); dismiss() } }
    }

    private func loadAccount() async {
        if let r = try? await store.waAccounts() { account = r.accounts.first { $0.id == chat.accountId } }
    }

    private func clearPrivateState() {
        messages = []; sharing = nil; ggOpen = false; ggQuotes = []; ggAsk = nil; outbox = []; draft = ""
        selecting = false; selected = []; suggesting = false; ggQueue = []; taskPrefill = nil; reminderPrefill = nil
    }

    private func quote(_ m: WaMessageDTO) -> GgQuote {
        GgQuote(id: m.id, author: m.fromMe ? L("a11y.you") : (m.author ?? chat.name), text: excerpt(m.body, 200))
    }

    private func toggle(_ id: String) {
        if selected.contains(id) { selected.remove(id) } else { selected.insert(id) }
        Haptics.tap()
    }

    /// Lo que se eligió de gg, uno por uno: cada diálogo se abre al cerrar el anterior. Con «Responder desde chaggu» el
    /// borrador va al compositor; si no, se copia para pegarlo en WhatsApp (nada se envía solo).
    private func runQueue() {
        guard !ggQueue.isEmpty, store.waPrivacy.allows(source) else { return }
        let token = store.waPrivacy.token(source)
        let next = ggQueue.removeFirst()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            guard store.waPrivacy.allows(source), token == store.waPrivacy.token(source) else { return }
            switch next {
            case .draft(let t):
                if account?.sendEnabled == true && account?.status == "connected" { draft = t; composerFocused = true }
                else { UIPasteboard.general.string = t; store.show(L("ggs.copied")) }
                runQueue()
            case .task(let p): taskPrefill = p
            case .reminder(let p): reminderPrefill = p
            case .messagePerson(let name, let draft):
                if let draft { UIPasteboard.general.string = draft }
                if let d = store.data, let person = GgPeople.find(d, name: name) {
                    dismiss()
                    if draft != nil { store.show(L("ggs.copied")) }
                    Task { do { try await store.openDirect(with: person.id) } catch { store.show(L10n.errorText(error)) } }
                } else {
                    if draft != nil { store.show(L("ggs.copied")) }
                    runQueue()
                }
            }
        }
    }
}

/// ⋯ › «Ajustes del chat»: categoría, traer los mensajes nuevos a un chat de chaggu y la descripción del grupo.
struct WaChatSettingsSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Binding var chat: WaChatDTO
    var onPatched: (WaChatDTO) -> Void
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker(L("wa.category"), selection: Binding(get: { chat.category }, set: { patch(["category": $0.rawValue]) })) {
                        ForEach(WaCategory.allCases, id: \.self) { Text("\($0.icon) \(L("wa.cat.\($0.rawValue)"))").tag($0) }
                    }
                    Text(chat.categoryManual ? L("wa.manual") : L("wa.suggested")).font(.caption).foregroundStyle(Theme.textSecondary)
                    if chat.categoryManual { Button(L("wa.resetCategory")) { patch(["category": NSNull()]) } }
                }
                if let d = store.data {
                    Section {
                        Picker(L("wa.linkTo"), selection: Binding(get: { chat.linkedConversationId ?? "" }, set: { patch(["linkedConversationId": $0.isEmpty ? NSNull() : $0]) })) {
                            Text(L("wa.notLinked")).tag("")
                            ForEach(d.conversations.filter { $0.kind != .direct && $0.canPost }) { c in Text(Naming.title(d, c)).tag(c.id) }
                        }
                    } footer: {
                        Text(chat.linkedConversationId.flatMap { store.meta($0) }.map { "\(L("wa.linkedHint")) \(Naming.title(d, $0))" } ?? L("wa.linkHint"))
                    }
                }
                if let desc = chat.description, !desc.isEmpty { Section { Text(String(desc.prefix(300))).font(.footnote) } }
            }
            .navigationTitle(L("wa.chatSettings"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(L("common.done")) { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }

    private func patch(_ p: [String: Any]) {
        Task {
            do { let up = try await store.waPatchChat(chat, p); chat = up; onPatched(up) } catch { store.show(L10n.errorText(error)) }
        }
    }
}

// MARK: Dominios de empresa

struct DomainsScreen: View {
    @Environment(AppStore.self) private var store
    let orgId: String
    @State private var domains: [OrgDomainDTO]?
    @State private var newDomain = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        List {
            Section {
                Text(L("dom.body")).font(.footnote).foregroundStyle(Theme.textSecondary)
                if let org = store.data.flatMap({ Naming.org($0, orgId) }), org.verification != "none" {
                    Label(L("dom.verifiedAs", ["domain": org.verifiedDomain ?? ""]), systemImage: "checkmark.seal.fill").foregroundStyle(.green)
                }
            }
            Section(L("dom.list")) {
                if domains == nil { ProgressView() }
                if domains?.isEmpty == true { Text(L("dom.empty")).foregroundStyle(Theme.textSecondary) }
                ForEach(domains ?? []) { dm in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(dm.domain).font(.body.weight(.semibold))
                            Spacer()
                            Text(L("dom.st.\(dm.status)")).font(.caption.weight(.bold)).foregroundStyle(dm.status == "pending" ? .orange : .green)
                        }
                        if dm.status == "pending" {
                            Text(L("dom.txtHint")).font(.caption).foregroundStyle(Theme.textSecondary)
                            LabeledContent(L("dom.txtName")) { Text(dm.txtName).font(.caption.monospaced()).textSelection(.enabled) }
                            LabeledContent(L("dom.txtValue")) { Text(dm.txtValue).font(.caption.monospaced()).textSelection(.enabled) }
                            HStack {
                                Button(L("common.copy")) { UIPasteboard.general.string = dm.txtValue; store.show(L("toast.copied")) }
                                Button(L("dom.verify")) { verify(dm.domain) }.disabled(busy)
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                    .accessibilityElement(children: .contain)
                }
            }
            Section(L("dom.add")) {
                TextField("empresa.com", text: $newDomain).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button(L("dom.add")) { add() }.disabled(newDomain.trimmingCharacters(in: .whitespaces).count < 3 || busy)
            }
            if let error { Text(error).foregroundStyle(.red).font(.footnote) }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(L("dom.title"))
        .task { await load() }
    }

    private func load() async {
        do { domains = try await store.listDomains(orgId); error = nil } catch { self.error = L10n.errorText(error); domains = domains ?? [] }
    }
    private func add() {
        busy = true
        Task {
            do { _ = try await store.addDomain(orgId, newDomain.trimmingCharacters(in: .whitespaces).lowercased()); newDomain = ""; await load() }
            catch { self.error = L10n.errorText(error) }
            busy = false
        }
    }
    private func verify(_ domain: String) {
        busy = true
        Task {
            do {
                let r = try await store.verifyDomain(orgId, domain)
                store.show(r.status == "pending" ? L("dom.notYet") : L("dom.done"))
                await load()
                try? await store.loadBootstrap()
            } catch { self.error = L10n.errorText(error) }
            busy = false
        }
    }
}

// MARK: Eliminar cuenta

struct DeleteAccountView: View {
    @Environment(AppStore.self) private var store
    @State private var email = ""
    @State private var password = ""
    @State private var needsPassword = false
    @State private var busy = false
    @State private var error: String?
    @State private var confirm = false

    var body: some View {
        Form {
            Section {
                Text(L("del.intro")).font(.body)
                Label(L("del.removed"), systemImage: "trash").font(.footnote)
                Label(L("del.kept"), systemImage: "archivebox").font(.footnote)
                Label(L("del.owner"), systemImage: "building.2").font(.footnote)
            }
            Section {
                TextField(L("del.emailPh"), text: $email).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .textContentType(.username)
                    .accessibilityIdentifier("delete.email")
                SecureField(needsPassword ? L("del.passwordRequired") : L("del.passwordOpt"), text: $password)
                    .textContentType(.password)
                    .accessibilityIdentifier("delete.password")
            } header: { Text(L("del.confirmTitle")) } footer: { Text(L("del.ssoHint")) }
            if let error { Section { Text(error).foregroundStyle(.red) } }
            Section {
                Button(role: .destructive) { confirm = true } label: {
                    HStack { Spacer(); if busy { ProgressView() } else { Text(L("del.button")).bold() }; Spacer() }
                }
                .disabled(busy || !email.contains("@") || (needsPassword && password.isEmpty))
                .listRowBackground(Color.red.opacity(0.12))
                .accessibilityIdentifier("delete.submit")
            }
        }
        .navigationTitle(L("del.title"))
        .confirmationDialog(L("del.last"), isPresented: $confirm, titleVisibility: .visible) {
            Button(L("del.button"), role: .destructive, action: submit)
        }
    }

    private func submit() {
        busy = true; error = nil
        Task {
            do { try await store.deleteAccount(confirmEmail: email, password: password.isEmpty ? nil : password) }
            catch let e as ApiRequestError {
                switch e.status {
                case 400: error = L("del.emailMismatch")
                case 403: needsPassword = true; error = password.isEmpty ? L("del.needPassword") : L("del.badPassword")
                default: error = L10n.errorText(e)
                }
            } catch { self.error = L10n.errorText(error) }
            busy = false
        }
    }
}
