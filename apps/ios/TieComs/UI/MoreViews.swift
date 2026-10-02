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

struct WhatsAppScreen: View {
    @Environment(AppStore.self) private var store
    @State private var accounts: [WaAccountDTO]?
    @State private var max = 5
    @State private var chats: [WaChatDTO] = []
    @State private var counts: [String: WaChatsPage.Count] = [:]
    @State private var category: WaCategory?
    @State private var onlyGroups = false
    @State private var nextPage: String?
    @State private var hasMore = false
    @State private var syncPartial = false
    @State private var loadingMore = false
    @State private var loadGeneration = UUID()
    @Environment(\.scenePhase) private var scenePhase
    @State private var showHidden = false
    @State private var query = ""
    @State private var connecting = false
    @State private var open: WaChatDTO?
    @State private var error: String?

    var body: some View {
        let connected = accounts?.filter { $0.status == "connected" } ?? []
        let total = counts.values.reduce(0) { $0 + $1.total }
        List {
            Section { Text(L("wa.intro")).font(.footnote).foregroundStyle(Theme.textSecondary) }
            if let accounts, accounts.isEmpty {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("👤  🏪").font(.title)
                        Text(L("wa.emptyTitle")).font(.headline)
                        Text(L("wa.emptyBody")).font(.subheadline).foregroundStyle(Theme.textSecondary)
                        Button(L("wa.connect")) { connecting = true }.buttonStyle(PrimaryButtonStyle())
                    }
                    .padding(.vertical, 6)
                }
            }
            ForEach(accounts ?? []) { a in Section { WaAccountCard(account: a, onChanged: { Task { await loadAccounts() } }) } }
            if !connected.isEmpty || total > 0 {
                Section(L("wa.organizer")) {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack {
                            chip(nil, "\(L("wa.cat.all")) \(total)")
                            ForEach(WaCategory.allCases, id: \.self) { c in chip(c, "\(c.icon) \(L("wa.cat.\(c.rawValue)")) \(counts[c.rawValue]?.total ?? 0)") }
                        }
                    }
                    Picker("", selection: $onlyGroups) { Text(L("wa.groups")).tag(true); Text(L("wa.allChats")).tag(false) }.pickerStyle(.segmented)
                    Toggle(L("wa.showHidden"), isOn: $showHidden)
                    Button("✦ \(L("wa.reorganize"))") {
                        Task {
                            do { let n = try await store.waOrganize(); store.show(L("wa.organized", ["n": n])); await loadChats() }
                            catch { store.show(L10n.errorText(error)) }
                        }
                    }
                }
                Section {
                    if chats.isEmpty { Text(connected.isEmpty ? L("wa.syncing") : L("wa.noChats")).foregroundStyle(Theme.textSecondary) }
                    ForEach(chats.sorted(by: WaRecency.before)) { c in
                        Button { open = c } label: { WaChatRow(chat: c, multi: (accounts?.count ?? 0) > 1) }
                            .contextMenu {
                                ForEach(WaCategory.allCases, id: \.self) { k in
                                    Button("\(k.icon) \(L("wa.cat.\(k.rawValue)"))") { patch(c, ["category": k.rawValue]) }
                                }
                                Divider()
                                // Bandeja de chaggu (contrato 1-oct): moverlo a Grupos o DMs, fijarlo arriba o sacarlo.
                                WaMoveToInboxItems(chat: c) { replace($0) }
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
        .searchable(text: $query, prompt: L("wa.search"))
        .navigationTitle(L("wa.title"))
        .toolbar {
            if (accounts?.count ?? 0) < max {
                ToolbarItem(placement: .primaryAction) { Button(L("wa.connect")) { connecting = true }.accessibilityIdentifier("wa.connect") }
            }
        }
        .sheet(isPresented: $connecting) { WaConnectSheet(existing: accounts ?? []) { Task { await loadAccounts() } } }
        .sheet(item: $open) { c in WaChatSheet(chat: c) { patched in replace(patched) } }
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

    private func chip(_ c: WaCategory?, _ label: String) -> some View {
        Button(label) { category = c }
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(Capsule().fill(category == c ? Theme.orange.opacity(0.2) : Theme.bubbleOther))
            .buttonStyle(.plain)
            .accessibilityAddTraits(category == c ? .isSelected : [])
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
            chats = r.chats; counts = r.categories; nextPage = r.next; hasMore = r.hasMore; syncPartial = r.syncPartial; error = nil
        } catch { if generation == loadGeneration, stamp == store.sessionStamp, !Task.isCancelled { self.error = L10n.errorText(error) } }
    }

    private func loadMoreChats() async {
        guard !loadingMore, hasMore, let cursor = nextPage else { return }
        loadingMore = true; defer { loadingMore = false }
        let generation = loadGeneration, stamp = store.sessionStamp
        do {
            let page = try await store.waChats(accountId: nil, category: category, onlyGroups: onlyGroups, showHidden: showHidden, query: query, cursor: cursor)
            guard !Task.isCancelled, generation == loadGeneration, stamp == store.sessionStamp else { return }
            let old = Set(chats.map(\.id)); chats += page.chats.filter { !old.contains($0.id) }
            nextPage = page.next; hasMore = page.hasMore && page.next != cursor; syncPartial = page.syncPartial
        } catch { if generation == loadGeneration, stamp == store.sessionStamp { self.error = L10n.errorText(error) } }
    }

    private func patch(_ c: WaChatDTO, _ p: [String: Any]) {
        Task { do { replace(try await store.waPatchChat(c, p)) } catch { store.show(L10n.errorText(error)) } }
    }

    private func replace(_ up: WaChatDTO) {
        chats = chats.map { $0.id == up.id ? up : $0 }
        Task { await loadChats() }
    }
}

private struct WaChatRow: View {
    let chat: WaChatDTO
    let multi: Bool
    var body: some View {
        HStack(spacing: 10) {
            Text(chat.isGroup ? "👥" : chat.category.icon).font(.title3).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text((chat.pinned ? "📌 " : "") + chat.name).font(.body.weight(chat.unread > 0 ? .semibold : .regular)).lineLimit(1)
                    Spacer()
                    Text(L10n.timeLabel(chat.lastMessageAt)).font(.caption2).foregroundStyle(Theme.textSecondary)
                }
                Text(chat.lastPreview ?? (chat.isGroup && chat.participants != nil ? L("wa.members", ["n": chat.participants!]) : ""))
                    .font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(1)
                HStack(spacing: 6) {
                    if multi { Text(chat.accountLabel).font(.caption2) }
                    Text("\(chat.category.icon) \(L("wa.cat.\(chat.category.rawValue)"))").font(.caption2)
                    if chat.linkedConversationId != nil { Text("⇄ chaggu").font(.caption2.weight(.semibold)).foregroundStyle(Theme.accentText) }
                }
                .foregroundStyle(Theme.textSecondary)
            }
            if chat.unread > 0 { Text("\(chat.unread)").font(.caption2.weight(.bold)).foregroundStyle(.white).padding(5).background(Circle().fill(.green)) }
        }
        .foregroundStyle(Theme.textPrimary)
        .accessibilityElement(children: .combine)
    }
}

struct WaAccountCard: View {
    @Environment(AppStore.self) private var store
    let account: WaAccountDTO
    var onChanged: () -> Void
    @State private var usePhone = false
    @State private var phone = ""
    @State private var confirm = false
    @State private var busy = false

    var body: some View {
        let a = account
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(a.isBusiness ? "🏪" : "👤").font(.title2).accessibilityHidden(true)
                VStack(alignment: .leading) {
                    HStack { Text(a.label).font(.headline); Text(a.isBusiness ? "WhatsApp Business" : "WhatsApp").font(.caption2).foregroundStyle(Theme.textSecondary) }
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
            HStack { Spacer(); Button(L("wa.disconnect"), role: .destructive) { confirm = true }.font(.footnote) }
        }
        .confirmationDialog(L("wa.disconnectConfirm", ["label": a.label]), isPresented: $confirm, titleVisibility: .visible) {
            Button(L("wa.disconnect"), role: .destructive) { run { try await store.waRemove(a.id) } }
        }
    }

    private func run(_ f: @escaping () async throws -> Void) {
        busy = true
        Task { do { try await f(); onChanged() } catch { store.show(L10n.errorText(error)) }; busy = false }
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

struct WaChatSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State var chat: WaChatDTO
    var onPatched: (WaChatDTO) -> Void
    @State private var messages: [WaMessageDTO]?
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

    private var source: String { GgSource.whatsapp(chat) }

    var body: some View {
        NavigationStack {
            List {
                // Bandeja de chaggu: «Mover a mi lista principal», «📌 Fijar arriba» o «Sacar de mi lista principal».
                Section { WaMoveToInboxItems(chat: chat) { up in chat = up; onPatched(up) } }
                Section {
                    Picker(L("wa.category"), selection: Binding(get: { chat.category }, set: { patch(["category": $0.rawValue]) })) {
                        ForEach(WaCategory.allCases, id: \.self) { Text("\($0.icon) \(L("wa.cat.\($0.rawValue)"))").tag($0) }
                    }
                    Text(chat.categoryManual ? L("wa.manual") : L("wa.suggested")).font(.caption).foregroundStyle(Theme.textSecondary)
                    if chat.categoryManual { Button(L("wa.resetCategory")) { patch(["category": NSNull()]) } }
                    Button(chat.pinned ? L("wa.unpin") : L("wa.pin")) { patch(["pinned": !chat.pinned]) }
                    Button(chat.hidden ? L("wa.unhide") : L("wa.hide")) { patch(["hidden": !chat.hidden]) }
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
                Section {
                    if messages == nil { ProgressView() }
                    if messages?.isEmpty == true { Text(L("wa.noMessages")).foregroundStyle(Theme.textSecondary) }
                    ForEach(messages ?? []) { m in
                        HStack(spacing: 8) {
                            if selecting { GgSelectCircle(on: selected.contains(m.id)) }
                        VStack(alignment: m.fromMe ? .trailing : .leading, spacing: 2) {
                            if !m.fromMe, chat.isGroup, let a = m.author { Text(a).font(.caption.weight(.semibold)) }
                            Text(m.body)
                            if let media = m.media { WaNativeMedia(accountId: chat.accountId, jid: chat.jid, messageId: m.id, media: media, mine: m.fromMe) }
                            Text(L10n.dateTime(ISODate.parse(m.sentAt) ?? Date())).font(.caption2).foregroundStyle(Theme.textSecondary)
                        }
                        .frame(maxWidth: .infinity, alignment: m.fromMe ? .trailing : .leading)
                        }
                        .accessibilityElement(children: .combine)
                        .overlay {
                            if selecting {
                                Color.clear.contentShape(Rectangle()).onTapGesture { toggle(m.id) }
                                    .accessibilityAddTraits(selected.contains(m.id) ? .isSelected : [])
                            }
                        }
                        // Correo y WhatsApp en el chat (docs/CORREO.md): pulsación larga › «Comentar en chaggu…».
                        // gg: «✨ Preguntar a gg» y «Seleccionar», sin quitar nada de lo que ya había.
                        .contextMenu {
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
                        // Botón a la vista, como «⤴ Llevar a un chat» de la web.
                        .overlay(alignment: m.fromMe ? .bottomLeading : .bottomTrailing) {
                            if store.mailEnabled && !m.body.isEmpty {
                                Button { sharing = m } label: { Text("⤴ " + L("wa.bringShort")).font(.caption2.weight(.semibold)) }
                                    .buttonStyle(.borderless)
                                    .accessibilityIdentifier("wa.bringShort")
                            }
                        }
                    }
                }
            }
            .navigationTitle(chat.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("common.close")) { dismiss() } }
                if store.ggSide.available == true {
                    ToolbarItem(placement: .primaryAction) { GgHeaderButton(source: source) { ggOpen = true } }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if selecting {
                    GgSelectionBar(count: selected.count, onCancel: { selecting = false; selected = [] }, onAsk: { suggesting = true })
                } else if store.ggSide.used.contains(source) {
                    GgContinueBar { ggOpen = true }.padding(.bottom, 6).background(Theme.background.opacity(0.9))
                }
            }
            .task(id: store.waRevision) { messages = (try? await store.waMessages(chat)) ?? [] }
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
        }
    }

    private func quote(_ m: WaMessageDTO) -> GgQuote {
        GgQuote(id: m.id, author: m.fromMe ? L("a11y.you") : (m.author ?? chat.name), text: excerpt(m.body, 200))
    }

    private func toggle(_ id: String) {
        if selected.contains(id) { selected.remove(id) } else { selected.insert(id) }
        Haptics.tap()
    }

    /// Lo que se eligió de gg, uno por uno: cada diálogo se abre al cerrar el anterior. Aquí no hay compositor de
    /// WhatsApp: los borradores se copian para pegarlos en WhatsApp (nada se envía solo).
    private func runQueue() {
        guard !ggQueue.isEmpty else { return }
        let next = ggQueue.removeFirst()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            switch next {
            case .draft(let t):
                UIPasteboard.general.string = t
                store.show(L("ggs.copied"))
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
