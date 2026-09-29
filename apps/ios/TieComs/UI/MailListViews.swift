import SwiftUI

// Correo en el chat (docs/CORREO.md): la lista en vivo de Gmail/Outlook (pestañas, búsqueda y filtros), la vista previa,
// «Llevar a un chat», las tarjetas para conectar, la invitación de Hoy y «Comentar en chaggu…» de WhatsApp.
// Paridad con MailBrowser, MailPreview, ShareStep, ConnectCards, MailConnectNudge y WaShareDialog de Mail.tsx.

// MARK: - Conectar

struct MailConnectCards: View {
    @Environment(AppStore.self) private var store
    let list: [MailConnectionDTO]
    var onChanged: () -> Void
    @State private var busy: MailProvider?

    var body: some View {
        ForEach(list) { c in
            HStack(spacing: 12) {
                MailProviderIcon(provider: c.provider, size: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(c.label).font(.body.weight(.semibold))
                    Text(subtitle(c)).font(.caption)
                        .foregroundStyle(c.status == "reconnect" || !c.available ? Color.red : Theme.textSecondary)
                }
                Spacer(minLength: 4)
                if busy == c.provider { ProgressView() }
                if c.available && !c.isActive {
                    Button(c.status == "reconnect" ? L("mail.reconnect") : L("mail.connect")) { connect(c.provider) }
                        .buttonStyle(.borderedProminent).tint(Theme.primaryFill).controlSize(.small)
                        .disabled(busy != nil)
                        .accessibilityIdentifier("mail.connect.\(c.provider.rawValue)")
                }
                if c.status != "none" {
                    Button(L("mail.disconnect")) { disconnect(c.provider) }
                        .buttonStyle(.bordered).controlSize(.small)
                        .accessibilityIdentifier("mail.disconnect.\(c.provider.rawValue)")
                }
            }
            .padding(.vertical, 4)
        }
    }

    private func subtitle(_ c: MailConnectionDTO) -> String {
        if !c.available { return c.unavailableReason ?? "" }
        if c.isActive { return L("mail.connectedAs", ["email": c.accountEmail ?? ""]) }
        return c.status == "reconnect" ? L("mail.reconnectHint") : L("mail.connectHint")
    }

    private func connect(_ p: MailProvider) {
        busy = p
        Task {
            defer { busy = nil }
            do {
                switch try await store.connectMail(p) {
                case .connected(let x): store.show(L("mail.connectedToast", ["name": (x ?? p).label]))
                case .failed(_, let code): store.show(code == "cancelled" ? L("mail.cancelledToast") : L("mail.failedToast", ["code": code]))
                case .receipt: break
                }
            } catch is CancellationError {
            } catch { store.show(L10n.errorText(error)) }
            onChanged()
        }
    }

    private func disconnect(_ p: MailProvider) {
        busy = p
        Task {
            defer { busy = nil }
            do { try await store.disconnectMail(p) } catch { store.show(L10n.errorText(error)) }
            onChanged()
        }
    }
}

// MARK: - Pantalla: Tú › Correo, o ＋ del chat › Correo

struct MailBoxScreen: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    /// Desde el ＋ del chat: el destino ya viene elegido.
    var conversationId: String?
    @State private var list: [MailConnectionDTO]?
    @State private var error: String?
    @State private var accounts = false

    var body: some View {
        Group {
            if let list, list.contains(where: \.isActive) {
                MailBrowser(connections: list, conversationId: conversationId) { dismiss() }
            } else {
                List {
                    if let error { Text(error).foregroundStyle(.red).font(.footnote) }
                    if list == nil && error == nil { ProgressView() }
                    if let list {
                        Section {
                            Text(L("mail.intro")).font(.subheadline).foregroundStyle(Theme.textSecondary)
                        }
                        Section {
                            MailConnectCards(list: list) { Task { await load() } }
                        } footer: { Text(L("mail.privacyHint")) }
                    }
                }
                .listStyle(.insetGrouped)
                .scrollContentBackground(.hidden)
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(conversationId == nil ? L("mail.title") : L("mail.pickTitle"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if list?.contains(where: \.isActive) == true {
                ToolbarItem(placement: .topBarTrailing) { Button(L("mail.accounts")) { accounts = true }.accessibilityIdentifier("mail.accounts") }
            }
        }
        .sheet(isPresented: $accounts) {
            NavigationStack {
                List {
                    Section { MailConnectCards(list: list ?? []) { Task { await load() } } } footer: { Text(L("mail.privacyHint")) }
                }
                .navigationTitle(L("mail.accounts"))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button(L("common.done")) { accounts = false } } }
            }
            .presentationDetents([.medium, .large])
        }
        .task(id: store.mailRevision) { await load() }
    }

    private func load() async {
        do { list = try await store.mailConnections(); error = nil } catch { self.error = L10n.errorText(error); if list == nil { list = [] } }
    }
}

// MARK: - La lista con búsqueda y filtros

/// Lo visto se guarda en memoria unos segundos: volver a un filtro pinta al instante y se refresca por detrás si tiene más de 20 s.
@MainActor
enum MailListCache {
    struct Entry { var items: [MailListItemDTO]; var next: String?; var at: Date }
    static var entries: [String: Entry] = [:]
    static func put(_ key: String, _ e: Entry) {
        if entries.count > 30, let k = entries.min(by: { $0.value.at < $1.value.at })?.key { entries[k] = nil }
        entries[key] = e
    }
}

struct MailBrowser: View {
    @Environment(AppStore.self) private var store
    let connections: [MailConnectionDTO]
    var conversationId: String?
    /// Se compartió en el chat de origen: volver a él.
    var onSharedHere: () -> Void
    @State private var provider: MailProvider?
    @State private var f = MailFilters()
    @State private var qText = ""
    @State private var items: [MailListItemDTO]?
    @State private var next: String?
    @State private var busy = false
    @State private var error: String?
    @State private var seq = 0
    @State private var textFilter: TextFilter?
    @State private var textValue = ""
    @State private var between = false
    @State private var afterDate = Date()
    @State private var beforeDate = Date()
    @State private var preview: MailListItemDTO?

    enum TextFilter: String, Identifiable { case from, to, label; var id: String { rawValue } }

    private var ready: [MailConnectionDTO] { connections.filter(\.isActive) }
    private var p: MailProvider { provider ?? ready.first?.provider ?? .google }
    private var cacheKey: String { f.path(p) }

    var body: some View {
        List {
            Section { controls }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
            Section {
                if let error { Text(error).font(.footnote).foregroundStyle(.red) }
                if items == nil { HStack { Spacer(); ProgressView(); Spacer() } }
                if items?.isEmpty == true && error == nil {
                    Text(f.filtered ? L("mail.noResults") : L("mail.empty")).font(.subheadline).foregroundStyle(Theme.textSecondary)
                }
                ForEach(items ?? []) { m in
                    Button { preview = m } label: { MailRow(item: m, showDir: f.box != "inbox", query: f.q) }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button { preview = m } label: { Label(conversationId == nil ? L("mail.bring") : L("mail.pickHere"), systemImage: "bubble.left.and.text.bubble.right") }
                        }
                        .accessibilityIdentifier("mail.row.\(m.id)")
                }
                if let next {
                    Button(busy ? L("common.loading") : L("mail.more")) { Task { await load(page: next) } }
                        .disabled(busy)
                        .frame(maxWidth: .infinity)
                        .accessibilityIdentifier("mail.more")
                }
            } header: {
                HStack(spacing: 6) {
                    Button { Task { await load(fresh: true) } } label: { Text(busy ? "…" : "↻") }
                        .disabled(busy).accessibilityLabel(L("mail.refresh")).accessibilityIdentifier("mail.refresh")
                    Text(headerText).textCase(nil).accessibilityIdentifier("mail.header")
                }
            } footer: {
                HStack(spacing: 4) {
                    MailProviderIcon(provider: p, size: 12)
                    Text(f.filtered ? L("mail.searchFoot", ["name": p.label]) : L("mail.liveFoot", ["name": p.label]))
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await load(fresh: true) }
        .task(id: cacheKey) { await show() }
        .task(id: qText) {
            // Escribir busca solo, a los 400 ms.
            let t = qText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard t != f.q else { return }
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard !Task.isCancelled else { return }
            f.q = t
        }
        .onChange(of: provider) { _, _ in f.category = nil }
        .alert(textFilterTitle, isPresented: Binding(get: { textFilter != nil }, set: { if !$0 { textFilter = nil } })) {
            TextField(textFilterTitle, text: $textValue).textInputAutocapitalization(.never).autocorrectionDisabled()
            Button(L("mail.apply")) { applyText(textValue) }
            if let tf = textFilter, !value(tf).isEmpty { Button(L("mail.remove"), role: .destructive) { applyText("") } }
            Button(L("common.cancel"), role: .cancel) {}
        }
        .sheet(isPresented: $between) { betweenSheet }
        .sheet(item: $preview) { m in
            MailPreviewSheet(provider: p, item: m, conversationId: conversationId) { sharedIn in
                preview = nil
                if let conversationId, sharedIn == conversationId { onSharedHere() }
                else { store.navigate(to: .conversation(sharedIn)) }
            }
        }
    }

    // MARK: Controles

    @ViewBuilder private var controls: some View {
        VStack(alignment: .leading, spacing: 10) {
            if ready.count > 1 {
                Picker("", selection: Binding(get: { p }, set: { provider = $0 })) {
                    ForEach(ready) { c in Text(c.label).tag(c.provider) }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("mail.provider")
            } else if let c = ready.first {
                HStack(spacing: 6) { MailProviderIcon(provider: c.provider, size: 16); Text(c.accountEmail ?? c.label).font(.footnote).foregroundStyle(Theme.textSecondary) }
            }
            Picker(L("mail.box"), selection: $f.box) {
                ForEach(["inbox", "sent", "all"], id: \.self) { b in Text(L("mail.box.\(b)")).tag(b) }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("mail.box")
            if f.box == "inbox" {
                let current = f.effectiveCategory(p)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(p.categories, id: \.self) { c in
                            Button { f.category = c } label: { chipLabel(L("mail.cat.\(c)"), on: current == c) }
                                .buttonStyle(.plain)
                                .accessibilityAddTraits(current == c ? .isSelected : [])
                                .accessibilityIdentifier("mail.cat.\(c)")
                        }
                    }
                }
                .accessibilityLabel(L("mail.cat"))
            }
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").foregroundStyle(Theme.textSecondary)
                TextField(L("mail.searchPh"), text: $qText)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.search)
                    .onSubmit { f.q = qText.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .accessibilityLabel(L("mail.search"))
                    .accessibilityIdentifier("mail.search")
                if !qText.isEmpty || f.filtered {
                    Button { qText = ""; f.clear() } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.textSecondary) }
                        .accessibilityLabel(L("mail.clear"))
                        .accessibilityIdentifier("mail.clear")
                }
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 10).fill(Theme.surface))
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    Menu {
                        Button(L("mail.date.today")) { f.setRange(.today) }
                        Button(L("mail.date.7")) { f.setRange(.week) }
                        Button(L("mail.date.30")) { f.setRange(.month) }
                        Button(L("mail.date.year")) { f.setRange(.year) }
                        Button(L("mail.date.older")) { f.setRange(.older) }
                        Divider()
                        Button(L("mail.date.between")) {
                            afterDate = ISODate.parse(f.after.isEmpty ? nil : f.after + "T12:00:00Z") ?? Date().addingTimeInterval(-30 * 86_400)
                            beforeDate = ISODate.parse(f.before.isEmpty ? nil : f.before + "T12:00:00Z") ?? Date()
                            between = true
                        }
                        if !f.after.isEmpty || !f.before.isEmpty { Button(L("mail.date.any"), role: .destructive) { f.setRange(nil) } }
                    } label: { chipLabel(rangeLabel + " ▾", on: !f.after.isEmpty || !f.before.isEmpty) }
                    .accessibilityIdentifier("mail.f.date")
                    textChip(.from, L("mail.f.from"))
                    textChip(.to, L("mail.f.to"))
                    Button { f.attachments.toggle() } label: { chipLabel("📎 " + L("mail.f.attachments"), on: f.attachments) }
                        .buttonStyle(.plain).accessibilityAddTraits(f.attachments ? .isSelected : []).accessibilityIdentifier("mail.f.attachments")
                    Button { f.unread.toggle() } label: { chipLabel(L("mail.f.unread"), on: f.unread) }
                        .buttonStyle(.plain).accessibilityAddTraits(f.unread ? .isSelected : []).accessibilityIdentifier("mail.f.unread")
                    textChip(.label, labelTitle)
                }
            }
        }
    }

    private var labelTitle: String { p == .microsoft ? L("mail.f.category") : L("mail.f.label") }
    private var textFilterTitle: String {
        switch textFilter { case .from: return L("mail.f.from"); case .to: return L("mail.f.to"); case .label: return labelTitle; case nil: return "" }
    }
    private func value(_ t: TextFilter) -> String { t == .from ? f.from : t == .to ? f.to : f.label }
    private func applyText(_ v: String) {
        let x = v.trimmingCharacters(in: .whitespacesAndNewlines)
        switch textFilter { case .from: f.from = x; case .to: f.to = x; case .label: f.label = x; case nil: break }
        textFilter = nil
    }
    private func textChip(_ t: TextFilter, _ title: String) -> some View {
        let v = value(t)
        return Button { textValue = v; textFilter = t } label: { chipLabel((v.isEmpty ? title : "\(title): \(v)") + " ▾", on: !v.isEmpty) }
            .buttonStyle(.plain)
            .accessibilityIdentifier("mail.f.\(t.rawValue)")
    }

    private var rangeLabel: String {
        switch f.range {
        case .today: return L("mail.date.today")
        case .week: return L("mail.date.7")
        case .month: return L("mail.date.30")
        case .year: return L("mail.date.year")
        case .older: return L("mail.date.older")
        default: return f.after.isEmpty && f.before.isEmpty ? L("mail.f.date") : "\(f.after.isEmpty ? "…" : f.after) – \(f.before.isEmpty ? "…" : f.before)"
        }
    }

    private func chipLabel(_ t: String, on: Bool) -> some View {
        Text(t).font(.caption.weight(.semibold)).lineLimit(1)
            .foregroundStyle(on ? Theme.accentText : Theme.textPrimary)
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(Capsule().fill(on ? Theme.orange.opacity(0.16) : Theme.textSecondary.opacity(0.1)))
    }

    private var headerText: String {
        if f.filtered {
            guard let items else { return L("mail.searching") }
            return L("mail.results", ["n": "\(items.count)" + (next != nil ? "+" : ""), "name": p.label])
        }
        if f.box == "inbox", let c = f.effectiveCategory(p), c != "any" { return L("mail.latest.inbox") + " · " + L("mail.cat.\(c)") }
        return L("mail.latest.\(f.box)")
    }

    private var betweenSheet: some View {
        NavigationStack {
            Form {
                DatePicker(L("mail.date.from"), selection: $afterDate, in: ...beforeDate, displayedComponents: .date)
                DatePicker(L("mail.date.until"), selection: $beforeDate, in: afterDate..., displayedComponents: .date)
            }
            .navigationTitle(L("mail.date.between"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { between = false } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("common.done")) {
                        f.range = .custom; f.after = MailText.ymd(afterDate); f.before = MailText.ymd(beforeDate); between = false
                    }
                }
            }
        }
        .presentationDetents([.medium])
    }

    // MARK: Carga

    private func show() async {
        if let hit = MailListCache.entries[cacheKey] {
            items = hit.items; next = hit.next
            if Date().timeIntervalSince(hit.at) > 20 { await load() }
        } else {
            items = nil
            await load()
        }
    }

    private func load(page: String? = nil, fresh: Bool = false) async {
        seq += 1
        let my = seq, key = cacheKey, filters = f, prov = p
        busy = true; error = nil
        defer { if my == seq { busy = false } }
        do {
            let r = try await store.listMail(prov, filters, page: page, fresh: fresh)
            guard my == seq else { return }
            let list = page == nil ? r.items : (items ?? []) + r.items
            items = list; next = r.nextPage
            MailListCache.put(key, .init(items: list, next: r.nextPage, at: Date()))
        } catch is CancellationError {
        } catch {
            guard my == seq else { return }
            self.error = L10n.errorText(error)
            if page == nil && items == nil { items = [] }
        }
    }
}

/// Fila de la lista: avatar con iniciales, ↙/↗ fuera de Recibidos, quién, fecha, asunto y extracto.
struct MailRow: View {
    let item: MailListItemDTO
    var showDir = false
    var query = ""
    var body: some View {
        let other = item.other
        HStack(alignment: .top, spacing: 10) {
            Avatar(name: other?.display ?? "?", org: nil, size: 34, fill: PersonColor.fill(other?.email ?? item.id))
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    if showDir { MailDirBadge(out: item.isSent) }
                    Text((item.isSent ? L("mail.toShort") + " " : "") + (other?.display ?? ""))
                        .font(.subheadline.weight(item.unread ? .bold : .semibold)).lineLimit(1)
                    Spacer(minLength: 4)
                    Text(MailUI.date(item.date)).font(.caption2).foregroundStyle(Theme.textSecondary)
                }
                highlight(item.subject.isEmpty ? L("mail.noSubject") : item.subject)
                    .font(.subheadline.weight(item.unread ? .semibold : .regular)).lineLimit(1)
                (Text(item.hasAttachments ? "📎 " : "") + highlight(item.snippet))
                    .font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(2)
            }
            if item.unread { Circle().fill(MailUI.inColor).frame(width: 8, height: 8).padding(.top, 6).accessibilityLabel(L("mail.f.unread")) }
        }
        .foregroundStyle(Theme.textPrimary)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    /// Resalta las palabras buscadas (como <mark> en la web).
    private func highlight(_ text: String) -> Text {
        let words = query.split(separator: " ").map(String.init).filter { $0.count > 1 && !$0.contains(":") }
        guard !words.isEmpty else { return Text(text) }
        var a = AttributedString(text)
        for w in words {
            var range = a.startIndex..<a.endIndex
            while let r = a[range].range(of: w, options: [.caseInsensitive, .diacriticInsensitive]) {
                a[r].backgroundColor = Color.yellow.opacity(0.4)
                range = r.upperBound..<a.endIndex
            }
        }
        return Text(a)
    }
}

// MARK: - Vista previa y «Llevar a un chat»

struct MailPreviewSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let provider: MailProvider
    let item: MailListItemDTO
    var conversationId: String?
    var onShared: (String) -> Void
    @State private var full: MailMessageDTO?
    @State private var error: String?
    @State private var sharing = false

    var body: some View {
        NavigationStack {
            Group {
                if sharing {
                    MailShareStep(provider: provider, item: item, conversationId: conversationId, onBack: { sharing = false }, onDone: onShared)
                } else {
                    preview
                }
            }
            .navigationTitle(sharing ? L("mail.shareTitle") : (item.subject.isEmpty ? L("mail.noSubject") : item.subject))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L("common.close")) { dismiss() } } }
        }
        .task { do { full = try await store.getMail(provider, item.id) } catch { self.error = L10n.errorText(error) } }
    }

    private var preview: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    meta(L("mail.meta.from"), item.from?.full ?? "—")
                    let to = full?.item.to ?? item.to
                    if !to.isEmpty { meta(L("mail.meta.to"), to.map(\.full).joined(separator: ", ")) }
                    if let cc = full?.cc, !cc.isEmpty { meta("CC", cc.map(\.full).joined(separator: ", ")) }
                    if let d = ISODate.parse(item.date) {
                        meta(L("mail.meta.date"), d.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(L10n.locale)) + " · " + provider.label)
                    }
                }
                if let error { Text(error).font(.footnote).foregroundStyle(.red) }
                Text(full.map { $0.body.isEmpty ? L("mail.noBody") : $0.body } ?? L("common.loading"))
                    .font(.body).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Theme.surface))
                    .accessibilityIdentifier("mail.previewBody")
                if let atts = full?.attachments, !atts.isEmpty {
                    ForEach(atts) { a in Text("📎 \(a.name) · \(MailText.size(a.size))").font(.caption) }
                }
            }
            .padding(16)
        }
        .background(Theme.background.ignoresSafeArea())
        .safeAreaInset(edge: .bottom) {
            Button { sharing = true } label: {
                Text(conversationId == nil ? L("mail.bring") : L("mail.pickHere")).frame(maxWidth: .infinity)
            }
            .buttonStyle(PrimaryButtonStyle())
            .padding(12)
            .background(.bar)
            .accessibilityIdentifier("mail.pick")
        }
    }

    private func meta(_ k: String, _ v: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(k).font(.caption.weight(.semibold)).foregroundStyle(Theme.textSecondary).frame(width: 52, alignment: .leading)
            Text(v).font(.caption)
        }
    }
}

/// Elegir el chat (si no viene dado), el comentario y el aviso de quiénes lo verán. POST /mail/share.
struct MailShareStep: View {
    @Environment(AppStore.self) private var store
    let provider: MailProvider
    let item: MailListItemDTO
    var conversationId: String?
    var onBack: () -> Void
    var onDone: (String) -> Void
    @State private var q = ""
    @State private var target: String?
    @State private var comment = ""
    @State private var busy = false

    var body: some View {
        let d = store.data
        let conv = (target ?? conversationId).flatMap { store.meta($0) }
        List {
            Section {
                HStack(alignment: .top, spacing: 10) {
                    MailProviderIcon(provider: provider, size: 22)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 4) { MailDirBadge(out: item.isSent); Text(item.subject.isEmpty ? L("mail.noSubject") : item.subject).font(.subheadline.weight(.bold)).lineLimit(2) }
                        Text("\(item.other?.display ?? "") · \(MailUI.date(item.date))\(item.hasAttachments ? " · 📎" : "")").font(.caption).foregroundStyle(Theme.textSecondary)
                    }
                }
            }
            if conversationId == nil, let d {
                Section {
                    TextField(L("mail.pickChat"), text: $q).accessibilityIdentifier("mail.pickChat")
                    ForEach(chats(d)) { c in
                        Button { target = c.id } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(Naming.title(d, c)).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.textPrimary)
                                    Text(d.workspaces.first { $0.id == c.workspaceId }?.name ?? L("kind.direct")).font(.caption).foregroundStyle(Theme.textSecondary)
                                }
                                Spacer()
                                Image(systemName: target == c.id ? "checkmark.circle.fill" : "circle").foregroundStyle(Theme.accentText)
                            }
                        }
                        .accessibilityAddTraits(target == c.id ? .isSelected : [])
                        .accessibilityIdentifier("mail.target.\(c.id)")
                    }
                }
            }
            Section {
                TextField(L("mail.commentPh"), text: $comment, axis: .vertical).lineLimit(2...6)
                    .accessibilityIdentifier("mail.shareComment")
            } footer: {
                if let conv, let d { Text(L("mail.whoSees", ["n": conv.memberIds.count, "name": Naming.title(d, conv)])).accessibilityIdentifier("mail.whoSees") }
            }
        }
        .safeAreaInset(edge: .bottom) {
            HStack {
                Button(L("common.back"), action: onBack).buttonStyle(.bordered)
                Button {
                    share()
                } label: {
                    Text(busy ? L("mail.sharing") : conv.flatMap { c in d.map { L("mail.shareIn", ["name": Naming.title($0, c)]) } } ?? L("mail.share"))
                        .lineLimit(1).frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(conv == nil || busy)
                .accessibilityIdentifier("mail.shareSend")
            }
            .padding(12)
            .background(.bar)
        }
    }

    private func chats(_ d: BootstrapDTO) -> [ConversationDTO] {
        let t = q.trimmingCharacters(in: .whitespaces).lowercased()
        return Array(d.conversations.filter { $0.canPost && (t.isEmpty || Naming.title(d, $0).lowercased().contains(t)) }.prefix(80))
    }

    private func share() {
        guard let id = target ?? conversationId, !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await store.shareMail(provider, messageId: item.id, conversationId: id, comment: comment)
                store.show(L("mail.shared"))
                onDone(id)
            } catch { store.show(L10n.errorText(error)) }
        }
    }
}

// MARK: - Hoy: invitación a conectar

/// Solo si el correo está prendido, nadie está conectado y hay un proveedor disponible. Se cierra con ✕ y no vuelve.
struct MailConnectNudge: View {
    @Environment(AppStore.self) private var store
    /// Se recuerda por persona (en este dispositivo).
    static func key(_ userId: String?) -> String { "tc.mailNudgeOff.\(userId ?? "")" }
    static func closed(_ store: AppStore) -> Bool { UserDefaults.standard.bool(forKey: key(store.me?.id)) }
    /// ¿Se muestra? (las conexiones las pide `refresh` desde la lista de Grupos).
    static func visible(_ store: AppStore) -> Bool {
        guard store.mailEnabled, !closed(store), let list = store.mailConnectionsKnown else { return false }
        return !list.contains(where: \.isActive) && list.contains(where: \.available)
    }
    static func refresh(_ store: AppStore) async {
        guard store.mailEnabled, !closed(store) else { return }
        if let l = try? await store.mailConnections() { store.mailConnectionsKnown = l }
    }

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 2) { MailProviderIcon(provider: .google, size: 22); MailProviderIcon(provider: .microsoft, size: 22) }
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(L("mail.nudgeTitle")).font(.subheadline.weight(.bold))
                Text(L("mail.nudgeBody")).font(.caption).foregroundStyle(Theme.textSecondary)
            }
            Spacer(minLength: 4)
            Button(L("mail.connect")) { store.push(.mailBox(conversationId: nil)) }
                .buttonStyle(.borderedProminent).tint(Theme.primaryFill).controlSize(.small)
                .accessibilityIdentifier("mail.nudge.connect")
            Button {
                UserDefaults.standard.set(true, forKey: Self.key(store.me?.id))
                store.mailConnectionsKnown = nil // ya no se vuelve a pedir: queda cerrada
            } label: { Image(systemName: "xmark").font(.caption.weight(.bold)).foregroundStyle(Theme.textSecondary).frame(width: 30, height: 30) }
                .buttonStyle(.borderless)
                .accessibilityLabel(L("common.close"))
                .accessibilityIdentifier("mail.nudge.close")
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.surface))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("mail.nudge")
    }
}

// MARK: - WhatsApp: «Comentar en chaggu…»

struct WaShareSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let chat: WaChatDTO
    let message: WaMessageDTO
    @State private var q = ""
    @State private var target: String?
    @State private var comment = ""
    @State private var busy = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(alignment: .top, spacing: 10) {
                        WaIcon(size: 22)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(chat.name).font(.subheadline.weight(.bold))
                            Text(message.fromMe ? L("common.youShort") : message.author ?? L("wa.someone")).font(.caption).foregroundStyle(Theme.textSecondary)
                            HStack(spacing: 8) {
                                Rectangle().fill(MailUI.waColor).frame(width: 3)
                                Text(String(message.body.prefix(400))).font(.subheadline)
                            }
                        }
                    }
                }
                if let d = store.data {
                    Section {
                        TextField(L("mail.pickChat"), text: $q)
                        ForEach(Array(d.conversations.filter { $0.canPost && (q.isEmpty || Naming.title(d, $0).lowercased().contains(q.lowercased())) }.prefix(80))) { c in
                            Button { target = c.id } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(Naming.title(d, c)).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.textPrimary)
                                        Text(d.workspaces.first { $0.id == c.workspaceId }?.name ?? L("kind.direct")).font(.caption).foregroundStyle(Theme.textSecondary)
                                    }
                                    Spacer()
                                    Image(systemName: target == c.id ? "checkmark.circle.fill" : "circle").foregroundStyle(Theme.accentText)
                                }
                            }
                            .accessibilityIdentifier("wa.target.\(c.id)")
                        }
                    }
                    Section {
                        TextField(L("wa.commentPh"), text: $comment, axis: .vertical).lineLimit(2...5)
                    } footer: {
                        if let c = target.flatMap({ store.meta($0) }) { Text(L("mail.whoSees", ["n": c.memberIds.count, "name": Naming.title(d, c)])) }
                    }
                }
            }
            .navigationTitle(L("wa.commentIn"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("mail.share")) { share() }.disabled(target == nil || busy).accessibilityIdentifier("wa.shareSend")
                }
            }
        }
    }

    private func share() {
        guard let target else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await store.shareWhatsApp(accountId: chat.accountId, jid: chat.jid, messageId: message.id, conversationId: target, comment: comment)
                store.show(L("mail.shared"))
                dismiss()
            } catch { store.show(L10n.errorText(error)) }
        }
    }
}
