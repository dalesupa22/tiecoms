import SwiftUI
import UIKit

private enum ChatItem: Identifiable {
    case day(String, Date)
    case message(MessageDTO, showAuthor: Bool)
    case system(MessageDTO)
    case pending(PendingMessage)

    var id: String {
        switch self {
        case .day(let k, _): return "day-\(k)"
        case .message(let m, _), .system(let m): return m.id
        case .pending(let p): return "p-\(p.clientMessageId)"
        }
    }
}

/// Hojas que se abren desde el menú de un mensaje o de la conversación.
enum ChatSheet: Identifiable {
    case derive(MessageDTO), returnResult, newIssue(MessageDTO?), newEvent(MessageDTO?), forward(MessageDTO)
    case reminder(MessageDTO?), pins, issuesHere, report(MessageDTO)
    var id: String {
        switch self {
        case .derive(let m): return "derive-\(m.id)"
        case .returnResult: return "return"
        case .newIssue(let m): return "issue-\(m?.id ?? "")"
        case .newEvent(let m): return "event-\(m?.id ?? "")"
        case .forward(let m): return "fwd-\(m.id)"
        case .reminder(let m): return "rem-\(m?.id ?? "")"
        case .report(let m): return "report-\(m.id)"
        case .pins: return "pins"
        case .issuesHere: return "issues"
        }
    }
}

func excerpt(_ s: String, _ n: Int = 120) -> String {
    let t = s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    return t.count > n ? String(t.prefix(n)) + "…" : t
}

struct ConversationView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @Environment(\.horizontalSizeClass) private var sizeClass
    let conversationId: String
    /// Dentro del panel de una conversación lateral.
    var embedded = false
    @State private var draft = ""
    @State private var sidePanel: String?
    /// Pide desplazar el chat a un mensaje (ancla de un sidechat) y resaltarlo.
    @State private var reveal: String?
    @State private var dragging: (id: String, dx: CGFloat)?
    @State private var addingToSide = false
    @State private var highlighted: String?
    @State private var staged: [LocalAttachment] = []
    @State private var uploadProgress: [UUID: Double] = [:]
    @State private var uploading = false
    @State private var askSide: MessageDTO?
    @State private var replyTo: MessageDTO?
    @State private var editing: MessageDTO?
    @State private var sheet: ChatSheet?
    @State private var confirmDelete: MessageDTO?
    @State private var blockUserId: String?
    @State private var recorder = VoiceRecorder()
    @FocusState private var composerFocused: Bool

    var body: some View {
        Group {
            if let d = store.data, let c = store.meta(conversationId) {
                content(d, c)
            } else {
                ContentUnavailableView(L("chat.notFound"), systemImage: "lock.slash")
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        // Cabecera opaca: los mensajes no se ven por detrás del título ni de las pestañas.
        .toolbarBackground(Theme.background, for: .navigationBar)
        .toolbarBackground(embedded ? .automatic : .visible, for: .navigationBar)
        .onAppear {
            store.openConversationId = conversationId
            let id = conversationId
            VoicePlayer.shared.nextProvider = { [weak store] finished in
                VoicePlayer.next(after: finished, in: store?.conversations[id]?.messages ?? [])
            }
        }
        .onDisappear { if store.openConversationId == conversationId { store.openConversationId = nil } }
        .task(id: conversationId) {
            try? await store.openConversation(conversationId)
            // Sugerencias de la hoja de compartir: abrir una conversación también cuenta (como mucho una vez por hora).
            Donations.donate(store, conversationId: conversationId, minInterval: 3600)
            try? await store.loadPins(conversationId)
            try? await store.loadIssues(conversationId: conversationId)
            try? await store.loadEvents(from: Date().addingTimeInterval(-30 * 86400), to: Date().addingTimeInterval(90 * 86400), conversationId: conversationId)
        }
        .sheet(item: $sheet) { s in sheetView(s) }
        .sheet(item: Binding(get: { askSide }, set: { askSide = $0 })) { m in
            NewSideSheet(conversationId: conversationId, message: m) { id in sidePanel = id }
        }
        // iPad / pantalla ancha: panel a la derecha; iPhone: hoja casi completa sobre el chat.
        .modifier(SidePanelPresenter(sideId: $sidePanel,
                                     anchorColor: activeAnchor.flatMap { id in store.conversations[conversationId]?.messages.first { $0.id == id } }
                                        .map { PersonColor.text($0.authorId) } ?? Theme.orange,
                                     onRevealAnchor: { reveal = $0 }))
        // Push de un sidechat: abre el origen con el sidechat desplegado.
        .onChange(of: store.sideToOpen[conversationId], initial: true) { _, v in
            if let v { sidePanel = v; store.sideToOpen[conversationId] = nil }
        }
        .sheet(isPresented: $addingToSide) { AddMembersSheet(conversationId: conversationId) }
        .onChange(of: sidePanel) { _, v in if v == nil { store.openConversationId = conversationId } }
        .confirmationDialog(L("safety.blockConfirm"), isPresented: Binding(get: { blockUserId != nil }, set: { if !$0 { blockUserId = nil } }), titleVisibility: .visible) {
            Button(L("safety.block"), role: .destructive) {
                if let id = blockUserId { act(toast: L("safety.blocked")) { try await store.setUserBlocked(id, blocked: true) } }
            }
            Button(L("common.cancel"), role: .cancel) {}
        } message: { Text(L("safety.blockHint")) }
        .confirmationDialog(L("menu.deleteConfirm"), isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }), titleVisibility: .visible) {
            Button(L("menu.delete"), role: .destructive) {
                if let m = confirmDelete { act { try await store.deleteMessage(m.id) } }
            }
            Button(L("common.cancel"), role: .cancel) {}
        }
    }

    @ViewBuilder private func sheetView(_ s: ChatSheet) -> some View {
        switch s {
        case .derive(let m): DeriveSheet(conversationId: conversationId, message: m)
        case .returnResult: ReturnResultSheet(conversationId: conversationId)
        case .newIssue(let m): NewIssueSheet(conversationId: conversationId, origin: m)
        case .newEvent(let m): EventEditorSheet(conversationId: conversationId, origin: m, event: nil)
        case .forward(let m): ForwardSheet(source: m)
        case .reminder(let m): ReminderSheet(conversationId: conversationId, message: m)
        case .report(let m): ReportContentSheet(userId: m.authorId, messageId: m.id)
        case .pins: PinsSheet(conversationId: conversationId)
        case .issuesHere: ConversationIssuesSheet(conversationId: conversationId)
        }
    }

    private func act(toast: String? = nil, _ f: @escaping () async throws -> Void) {
        Task {
            do { try await f(); if let toast { store.show(toast) } } catch { store.show(L10n.errorText(error)) }
        }
    }

    @ViewBuilder
    private func content(_ d: BootstrapDTO, _ c: ConversationDTO) -> some View {
        let state = store.conversations[conversationId]
        VStack(spacing: 0) {
            if store.connection != .online {
                ConnectionBanner(connection: store.connection).padding(.horizontal, 16).padding(.vertical, 6)
                    .background(Theme.surface)
            }
            if !embedded { LineageBar(conv: c, onReturn: { sheet = .returnResult }) }
            let pinCount = store.pins[conversationId]?.count ?? 0
            if pinCount > 0 {
                Button { sheet = .pins } label: {
                    Label(L("pins.count", ["n": pinCount]), systemImage: "pin.fill")
                        .font(.footnote.weight(.semibold))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 16).padding(.vertical, 8)
                        .background(Theme.orange.opacity(0.10))
                }
                .foregroundStyle(Theme.accentText)
                .accessibilityIdentifier("chat.pinsBar")
            }
            OpenIssuesBar(conversationId: conversationId)
            if let state, state.loaded {
                messages(d, c, state)
            } else if let err = state?.error {
                ContentUnavailableView {
                    Label(err, systemImage: "exclamationmark.bubble")
                } actions: {
                    Button(L("common.retry")) { Task { try? await store.openConversation(conversationId, force: true) } }
                }
                .frame(maxHeight: .infinity)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity).accessibilityLabel(L("common.loading"))
            }
            typingLine
            if c.kind == .direct && c.memberIds.contains(where: { store.blockedUserIds.contains($0) }) {
                Text(L("safety.directBlocked")).font(.footnote).foregroundStyle(Theme.textSecondary).padding(14)
            } else if c.canPost { composer(d, c) } else {
                Text(L("chat.readOnly"))
                    .font(.footnote).foregroundStyle(Theme.textSecondary)
                    .frame(maxWidth: .infinity).padding(14)
                    .background(Theme.surface)
                    .accessibilityIdentifier("chat.readOnly")
            }
        }
        .toolbar {
            // Dentro del panel del sidechat la cabecera es la del panel (no se mezcla con la del chat de origen).
            if !embedded {
            ToolbarItem(placement: .principal) {
                NavigationLink(value: Route.details(conversationId)) {
                    VStack(spacing: 1) {
                        HStack(spacing: 4) {
                            if c.avatarUrl != nil { ConvIcon(d: d, c: c, size: 20) }
                            if c.kind == .internal { Image(systemName: "lock.fill").font(.caption2) }
                            Text(Naming.title(d, c)).font(.headline).lineLimit(1)
                            if c.isMuted { Image(systemName: "bell.slash.fill").font(.caption2).foregroundStyle(Theme.textSecondary) }
                        }
                        .foregroundStyle(Theme.textPrimary)
                        // Grupos de un espacio: la ruta «Empresa · Espacio»; chats: las empresas.
                        let sub = Naming.route(d, c) ?? Naming.subtitle(d, c)
                        if !sub.isEmpty { Text(sub).font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(1).truncationMode(.tail) }
                    }
                    // Sin tope, un subtítulo largo (chat grupal con varias empresas) se recorta por ambos lados.
                    .frame(maxWidth: 250)
                }
                .accessibilityLabel([Naming.title(d, c), Naming.route(d, c) ?? Naming.subtitle(d, c)].filter { !$0.isEmpty }.joined(separator: ", "))
                .accessibilityHint(L("chat.details"))
                .accessibilityIdentifier("chat.header")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    ConversationMenuItems(conv: c, onRemindCustom: { sheet = .reminder(nil) },
                                          onMeeting: c.canPost ? { sheet = .newEvent(nil) } : nil)
                    Divider()
                    if c.canPost || c.openIssues > 0 {
                        Button { sheet = .issuesHere } label: { Label("\(L("issue.here")) · \(c.openIssues)", systemImage: "checklist") }
                    }
                    if (store.pins[conversationId]?.count ?? 0) > 0 { Button { sheet = .pins } label: { Label(L("pins.title"), systemImage: "pin") } }
                    NavigationLink(value: Route.details(conversationId)) { Label(L("chat.details"), systemImage: "info.circle") }
                } label: { Image(systemName: "ellipsis.circle") }
                .accessibilityLabel(L("menu.open"))
                .accessibilityIdentifier("chat.menu")
            }
            }
        }
    }

    private func buildItems(_ state: ConversationState, pending: [PendingMessage]) -> [ChatItem] {
        var items: [ChatItem] = []
        var lastDay: DateComponents?
        var prev: MessageDTO?
        var prevDate: Date?
        let cal = Calendar.current
        for m in state.messages where !store.blockedUserIds.contains(m.authorId) {
            let date = ISODate.parse(m.createdAt) ?? Date()
            let day = cal.dateComponents([.year, .month, .day], from: date)
            if day != lastDay {
                items.append(.day("\(day.year ?? 0)-\(day.month ?? 0)-\(day.day ?? 0)", date))
                lastDay = day
                prev = nil
            }
            if m.isSystem {
                items.append(.system(m))
                prev = nil
            } else {
                items.append(.message(m, showAuthor: ChatGrouping.startsRun(previous: prev, current: m)))
                prev = m
            }
            prevDate = date
        }
        items += pending.map(ChatItem.pending)
        return items
    }

    @ViewBuilder
    private func messages(_ d: BootstrapDTO, _ c: ConversationDTO, _ state: ConversationState) -> some View {
        let items = buildItems(state, pending: store.pendingFor(conversationId))
        let byId = Dictionary(state.messages.filter { !store.blockedUserIds.contains($0.authorId) }.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 4) {
                    if state.hasMore {
                        ProgressView()
                            .padding(8)
                            .accessibilityLabel(L("chat.loadingOlder"))
                            .onAppear {
                                let anchor = state.messages.first?.id
                                Task {
                                    await store.loadOlder(conversationId)
                                    if let anchor { proxy.scrollTo(anchor, anchor: .top) }
                                }
                            }
                    } else if c.historyFromSeq > 0 {
                        Text(L("chat.lateJoin")).font(.footnote).foregroundStyle(Theme.textSecondary)
                            .multilineTextAlignment(.center).padding(12)
                    }
                    if embedded && Naming.isSide(c) && !state.messages.contains(where: { !$0.isSystem }) {
                        SideEmptyState()
                    } else if state.messages.isEmpty && items.isEmpty {
                        Text(L("conv.noMessages")).font(.subheadline).foregroundStyle(Theme.textSecondary).padding(.top, 40)
                    }
                    ForEach(items) { item in
                        row(d, c, item, byId: byId).id(item.id)
                    }
                    Color.clear.frame(height: 4).id("bottom")
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .defaultScrollAnchor(.bottom)
            // Teléfono con el sidechat a medias: espacio abajo para que el ancla pueda subir sobre la hoja.
            .contentMargins(.bottom, sidePanel != nil && sizeClass == .compact ? 420 : 0, for: .scrollContent)
            // ?m=<seq>: cargar hacia atrás hasta el mensaje, centrarlo y resaltarlo.
            .task(id: store.jumpTo[conversationId]) {
                guard let seq = store.jumpTo[conversationId] else { return }
                store.jumpTo[conversationId] = nil
                if let id = await store.ensureMessage(conversationId, seq: seq) {
                    try? await Task.sleep(nanoseconds: 250_000_000)
                    withAnimation { proxy.scrollTo(id, anchor: .center) }
                    highlighted = id
                    try? await Task.sleep(nanoseconds: 1_800_000_000)
                    withAnimation { highlighted = nil }
                }
            }
            .onChange(of: reveal) { _, id in
                guard let id else { return }
                reveal = nil
                // En teléfono queda arriba, visible sobre la hoja a medias.
                Task {
                    try? await Task.sleep(nanoseconds: 350_000_000)
                    withAnimation(.easeInOut(duration: 0.35)) { proxy.scrollTo(id, anchor: UnitPoint(x: 0.5, y: sizeClass == .compact ? 0.12 : 0.4)) }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: items.last?.id) { _, _ in
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
                markReadIfVisible()
            }
            .onChange(of: composerFocused) { _, focused in
                if focused { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { proxy.scrollTo("bottom", anchor: .bottom) } }
            }
            .onAppear { markReadIfVisible() }
            .onChange(of: scenePhase) { _, p in if p == .active { markReadIfVisible() } }
        }
    }

    /// Quien preguntó en este sidechat (autor del primer mensaje de una persona).
    private func sideAsker(_ c: ConversationDTO) -> MessageDTO? {
        guard Naming.isSide(c) else { return nil }
        return store.conversations[conversationId]?.messages.first { !$0.isSystem && $0.deletedAt == nil }
    }

    private func composerPlaceholder(_ d: BootstrapDTO, _ c: ConversationDTO) -> String {
        if let q = sideAsker(c), q.authorId != d.me.id, let name = Naming.person(d, q.authorId)?.name {
            return L("side.placeholder", ["name": name.split(separator: " ").first.map(String.init) ?? name])
        }
        if Naming.isSide(c) { return L("side.placeholderMany") }
        return L("chat.placeholder", ["name": Naming.title(d, c)])
    }

    /// Respuestas rápidas: en un sidechat donde me preguntaron y aún no he respondido.
    private func showQuickReplies(_ d: BootstrapDTO, _ c: ConversationDTO) -> Bool {
        guard editing == nil, draft.isEmpty, let q = sideAsker(c), q.authorId != d.me.id else { return false }
        let last = store.conversations[conversationId]?.messages.last { !$0.isSystem && $0.deletedAt == nil }
        return last?.authorId != d.me.id && store.pendingFor(conversationId).isEmpty
    }

    /// Mensaje ancla del sidechat abierto.
    private var activeAnchor: String? { sidePanel.flatMap { store.meta($0)?.parentMessageId } }

    private func canAskSide(_ c: ConversationDTO, _ m: MessageDTO) -> Bool {
        m.kind == "text" && m.deletedAt == nil && !Naming.isSide(c) && !embedded
    }

    private func markReadIfVisible() {
        guard scenePhase == .active, store.openConversationId == conversationId else { return }
        store.markRead(conversationId)
    }

    @ViewBuilder
    private func row(_ d: BootstrapDTO, _ c: ConversationDTO, _ item: ChatItem, byId: [String: MessageDTO]) -> some View {
        switch item {
        case .day(_, let date):
            Text(L10n.dayLabel(date))
                .font(.caption.weight(.semibold)).foregroundStyle(Theme.textSecondary)
                .padding(.horizontal, 10).padding(.vertical, 4)
                .background(Capsule().fill(Theme.surface))
                .padding(.vertical, 8)
                .accessibilityAddTraits(.isHeader)
        case .system(let m):
            SystemRow(message: m)
        case .message(let m, let showAuthor):
            let mine = m.authorId == d.me.id
            let quoted = m.replyTo.flatMap { byId[$0] }
            let author = Naming.person(d, m.authorId)
            let bubble = MessageBubble(
                text: m.deletedAt != nil ? L("chat.deleted") : m.body,
                leading: mine || !ChatGrouping.showsAvatars(c.kind) ? .none
                    : showAuthor ? .person(name: author?.name ?? "?", photo: author?.avatarUrl, id: m.authorId, agent: author?.kind == "agent") : .spacer,
                authorColor: PersonColor.text(m.authorId),
                time: L10n.clock(m.createdAt) + (m.editedAt != nil && m.deletedAt == nil ? " " + L("msg.edited") : ""),
                mine: mine,
                author: mine || !showAuthor ? nil : Naming.authorLine(d, m.authorId),
                status: nil, italic: m.deletedAt != nil,
                quote: m.replyTo == nil ? nil : (quoted.map { q in (Naming.person(d, q.authorId)?.name ?? "", q.deletedAt != nil ? L("chat.deleted") : excerpt(q.body)) } ?? ("", L("reply.quoteMissing"))),
                forwardedLabel: m.forwarded.map { forwardedLabel(d, $0, mine: mine, authorName: author?.name) },
                merged: m.mergedKind == "side" ? L("side.fromSidechat")
                    : m.mergedFrom.map { id in store.meta(id).map { L("lin.resultOf", ["name": Naming.title(d, $0)]) } ?? L("lin.resultHidden") },
                pinned: store.pins[conversationId]?.contains(m.id) == true,
                linkify: m.deletedAt == nil && m.kind == "text",
                linkPreview: m.deletedAt == nil ? m.linkPreview : nil,
                attachments: m.deletedAt == nil ? m.attachments : [],
                messageId: m.id, conversationId: conversationId
            )
            Group {
                if m.deletedAt == nil {
                    // Pulsación larga como en iPhone: vista previa de la burbuja + menú (sin reacciones: el API no las tiene).
                    bubble.contextMenu { messageMenu(d, c, m) } preview: {
                        bubble.frame(width: 340).padding(.vertical, 10).padding(.horizontal, 6).background(Theme.background)
                    }
                } else { bubble }
            }
            .padding(.top, showAuthor ? 6 : 0)
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.orange.opacity(highlighted == m.id ? 0.18 : 0)))
            // Ancla del sidechat abierto: halo suave y posición para el conector.
            .background {
                if activeAnchor == m.id {
                    RoundedRectangle(cornerRadius: 20).fill(PersonColor.text(m.authorId).opacity(0.10))
                        .shadow(color: PersonColor.text(m.authorId).opacity(0.45), radius: 10)
                        .padding(-4)
                }
            }
            .anchorPreference(key: SideAnchorKey.self, value: .bounds) { activeAnchor == m.id ? ["anchor": $0] : [:] }
            // Deslizar la burbuja a la derecha = «Preguntar en un sidechat» (solo en chats que lo permiten).
            .offset(x: dragging?.id == m.id ? min(90, max(0, dragging!.dx)) : 0)
            .overlay(alignment: .leading) {
                if dragging?.id == m.id, (dragging?.dx ?? 0) > 20 {
                    Image(systemName: "bubble.left.and.text.bubble.right.fill").foregroundStyle(Theme.orange)
                        .opacity(min(1, Double((dragging?.dx ?? 0) / 70)))
                        .offset(x: -6)
                }
            }
            .simultaneousGesture(canAskSide(c, m) ? DragGesture(minimumDistance: 24)
                .onChanged { v in
                    guard abs(v.translation.width) > abs(v.translation.height) * 2 else { return }
                    dragging = (m.id, v.translation.width)
                }
                .onEnded { v in
                    if dragging?.id == m.id, v.translation.width > 70 { askSide = m; Haptics.tap() }
                    withAnimation(.spring(response: 0.3)) { dragging = nil }
                } : nil)
            .accessibilityIdentifier("msg.\(m.id)")
            let sides = store.sides(of: m.id)
            if !sides.isEmpty {
                SideChip(sides: sides) { sidePanel = $0 }
                    .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
                    .padding(.horizontal, mine ? 4 : 40)
            }
            if let f = m.forwarded, f.messageId != nil, let fromId = f.fromConversationId, store.meta(fromId) != nil {
                Button {
                    if let seq = f.messageSeq { store.jumpTo[fromId] = seq }
                    store.navigate(to: .conversation(fromId))
                } label: {
                    Label(L("preply.open"), systemImage: "arrow.up.forward").font(.caption2.weight(.semibold))
                }
                .buttonStyle(.borderless)
                .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
                .padding(.horizontal, mine ? 4 : 40)
                .accessibilityIdentifier("msg.privateOrigin.\(m.id)")
            }
        case .pending(let p):
            MessageBubble(text: p.body, time: "", mine: true, author: nil, status: p.status == .failed ? .failed : .sending, italic: false,
                          forwardedLabel: p.forwarded.map { forwardedLabel(d, $0) }, attachments: p.attachments ?? [])
                .padding(.top, 4)
                .onTapGesture { if p.status == .failed { store.retry(p.clientMessageId) } }
                .contextMenu {
                    if p.status == .failed {
                        Button(L("chat.retry")) { store.retry(p.clientMessageId) }
                        Button(L("chat.discard"), role: .destructive) { store.discard(p.clientMessageId) }
                    }
                }
                .accessibilityAction(named: Text(L("chat.retry"))) { store.retry(p.clientMessageId) }
                .accessibilityAction(named: Text(L("chat.discard"))) { store.discard(p.clientMessageId) }
                .accessibilityIdentifier("pending.\(p.clientMessageId)")
        }
    }

    private func forwardedLabel(_ d: BootstrapDTO, _ f: ForwardedInfo, mine: Bool = true, authorName: String? = nil) -> String {
        if let mid = f.messageId {
            // Respuesta en privado: el servidor manda el extracto del original.
            if let ex = f.excerpt, !ex.isEmpty {
                return mine ? L("preply.you", ["excerpt": excerpt(ex, 80)]) : L("preply.other", ["name": authorName ?? "", "excerpt": excerpt(ex, 80)])
            }
            if let fromId = f.fromConversationId, let orig = store.conversations[fromId]?.messages.first(where: { $0.id == mid }), orig.deletedAt == nil {
                return mine ? L("preply.you", ["excerpt": excerpt(orig.body, 80)]) : L("preply.other", ["name": authorName ?? "", "excerpt": excerpt(orig.body, 80)])
            }
            if let from = f.fromConversationId.flatMap({ store.meta($0) }) {
                return L("privateReply.labelConv", ["name": Naming.title(d, from)])
            }
            return L("privateReply.labelHidden")
        }
        var label: String
        if let from = f.fromConversationId.flatMap({ store.meta($0) }) {
            label = L("fwd.fromConv", ["name": Naming.title(d, from)])
        } else if let a = f.author, !a.isEmpty {
            label = L("fwd.fromBy", ["source": L("src.\(f.source.rawValue)"), "author": a])
        } else {
            label = L("fwd.from", ["source": L("src.\(f.source.rawValue)")])
        }
        if let s = f.sentAt, !s.isEmpty { label += " · " + (s.contains("T") ? L10n.dateTime(ISODate.parse(s) ?? Date()) : s) }
        return label
    }

    /// Menú de un mensaje (mismas acciones y orden que messageMenu de la web).
    @ViewBuilder
    private func messageMenu(_ d: BootstrapDTO, _ c: ConversationDTO, _ m: MessageDTO) -> some View {
        let mine = m.authorId == d.me.id
        let isPinned = store.pins[conversationId]?.contains(m.id) == true
        // Asuntos y reuniones también en directos y multi (SPEC-v4 E); derivar sigue siendo de espacios.
        let canWork = c.canPost
        let myWsRole = d.workspaces.first { $0.id == c.workspaceId }?.myRole
        if c.canPost {
            Button { replyTo = m; editing = nil; composerFocused = true } label: { Label(L("menu.reply"), systemImage: "arrowshape.turn.up.left") }
        }
        if !mine && c.kind != .direct {
            Button {
                act { try await store.startPrivateReply(to: m) }
            } label: { Label(L("preply.action"), systemImage: "lock.bubble") }
        }
        if canAskSide(c, m) {
            Button { askSide = m } label: { Label(L("side.ask"), systemImage: "bubble.left.and.text.bubble.right") }
        }
        Button { UIPasteboard.general.string = m.body; store.show(L("toast.copied")) } label: { Label(L("menu.copyText"), systemImage: "doc.on.doc") }
        Button { UIPasteboard.general.string = "\(conversationLink(conversationId))?m=\(m.seq)"; store.show(L("toast.linkCopied")) } label: {
            Label(L("menu.copyLink"), systemImage: "link")
        }
        Divider()
        if c.canPost {
            Button { act(toast: isPinned ? L("toast.unpinned") : L("toast.pinned")) { try await store.setMessagePinned(m, !isPinned) } } label: {
                Label(isPinned ? L("menu.unpin") : L("menu.pin"), systemImage: isPinned ? "pin.slash" : "pin")
            }
        }
        RemindMenu(conversationId: conversationId, message: m, onCustom: { sheet = .reminder(m) })
        Button { act(toast: L("toast.markedUnread")) { try await store.markUnread(conversationId, seq: m.seq) } } label: {
            Label(L("menu.markUnread"), systemImage: "circle.fill")
        }
        if canWork {
            Divider()
            if c.workspaceId != nil && c.kind != .direct && myWsRole != "guest" { Button { sheet = .derive(m) } label: { Label(L("menu.derive"), systemImage: "arrow.triangle.branch") } }
            Button { sheet = .newIssue(m) } label: { Label(L("menu.issue"), systemImage: "checklist") }
            Button { sheet = .newEvent(m) } label: { Label(L("menu.meeting"), systemImage: "calendar.badge.plus") }
        }
        Button { sheet = .forward(m) } label: { Label(L("menu.forwardChat"), systemImage: "arrowshape.turn.up.right") }
            .accessibilityIdentifier("menu.forwardChat")
        Menu {
            Button { sheet = .forward(m) } label: { Label(L("fwd.tiecoms"), systemImage: "bubble.left.and.bubble.right") }
            Divider()
            let author = Naming.person(d, m.authorId)?.name ?? ""
            let link = "\(conversationLink(conversationId))?m=\(m.seq)"
            let plain = "\(author): \(m.body)\n\n— \(Naming.title(d, c)) · TieComs\n\(link)"
            Button(L("fwd.whatsapp")) {
                if let u = URL(string: "https://wa.me/?text=\(plain.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")") { openURL(u) }
            }
            Button(L("fwd.slack")) {
                UIPasteboard.general.string = ">\(m.body.replacingOccurrences(of: "\n", with: "\n>"))\n— *\(author)* · \(Naming.title(d, c)) · <\(link)|TieComs>"
                store.show(L("toast.slackCopied"))
            }
            Button(L("fwd.teams")) { UIPasteboard.general.string = plain; store.show(L("toast.teamsCopied")) }
            Button(L("fwd.email")) {
                let subject = "\(Naming.title(d, c)) · TieComs".addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
                if let u = URL(string: "mailto:?subject=\(subject)&body=\(plain.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")") { openURL(u) }
            }
        } label: { Label(L("menu.forward"), systemImage: "arrowshape.turn.up.right") }
        if !mine {
            Divider()
            Button { sheet = .report(m) } label: { Label(L("safety.reportMessage"), systemImage: "flag") }
                .accessibilityIdentifier("safety.reportMessage")
            Button(role: .destructive) { blockUserId = m.authorId } label: { Label(L("safety.block"), systemImage: "person.slash") }
                .accessibilityIdentifier("safety.block")
        }
        if mine {
            Divider()
            Button { editing = m; replyTo = nil; draft = m.body; composerFocused = true } label: { Label(L("menu.edit"), systemImage: "pencil") }
            Button(role: .destructive) { confirmDelete = m } label: { Label(L("menu.delete"), systemImage: "trash") }
        }
    }

    @ViewBuilder private var typingLine: some View {
        let names = store.typingNames(conversationId)
        if !names.isEmpty {
            Text(names.count == 1 ? L("chat.typingOne", ["names": names[0]]) : L("chat.typingMany", ["names": names.joined(separator: ", ")]))
                .font(.caption).italic().foregroundStyle(Theme.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16).padding(.vertical, 4)
                .accessibilityIdentifier("chat.typing")
                .transition(.opacity)
        }
    }

    @ViewBuilder
    private func composer(_ d: BootstrapDTO, _ c: ConversationDTO) -> some View {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        VStack(spacing: 0) {
            if let pr = store.privateReplies[conversationId] {
                ContextBar(icon: "lock.bubble", title: L("preply.bar", ["name": pr.author ?? ""]),
                           detail: "«\(excerpt(pr.excerpt, 100))»", cancelLabel: L("preply.cancel")) { store.privateReplies[conversationId] = nil }
                    .accessibilityIdentifier("composer.privateReplyBar")
            }
            if let r = replyTo {
                ContextBar(icon: "arrowshape.turn.up.left", title: L("reply.to", ["name": Naming.person(d, r.authorId)?.name ?? ""]),
                           detail: excerpt(r.body, 100), cancelLabel: L("reply.cancel")) { replyTo = nil }
                    .accessibilityIdentifier("composer.replyBar")
            }
            if let e = editing {
                ContextBar(icon: "pencil", title: L("menu.edit"), detail: excerpt(e.body, 100), cancelLabel: L("common.cancel")) {
                    editing = nil; draft = ""
                }
                .accessibilityIdentifier("composer.editBar")
            }
            if showQuickReplies(d, c) {
                SideQuickReplies(onSend: { store.send(conversationId, body: $0) }, onAskOther: { addingToSide = true })
            }
            StagedAttachments(staged: $staged, progress: uploadProgress)
            HStack(alignment: .bottom, spacing: 8) {
                if recorder.isActive {
                    VoiceRecordingBar(recorder: recorder, onSend: sendVoice, onDiscard: { store.show(L("voice.cancelled")) })
                } else {
                if editing == nil { AttachButton(staged: $staged) { store.show($0) } }
                TextField(composerPlaceholder(d, c), text: $draft, axis: .vertical)
                    .lineLimit(1...6)
                    .focused($composerFocused)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: 20).fill(Theme.background))
                    .overlay(RoundedRectangle(cornerRadius: 20).stroke(Theme.textSecondary.opacity(0.25)))
                    .onChange(of: draft) { _, v in if !v.isEmpty && editing == nil { store.userIsTyping(conversationId) } }
                    .accessibilityLabel(L("chat.composerLabel"))
                    .accessibilityIdentifier("composer.field")
                }
                // Compositor vacío: micrófono (mantener pulsado para grabar). Con texto o adjuntos: enviar.
                if editing == nil && trimmed.isEmpty && staged.isEmpty && !uploading && recorder.state != .locked {
                    VoiceRecordButton(recorder: recorder, onSend: sendVoice)
                } else if !recorder.isActive {
                Button(action: submit) {
                    Image(systemName: editing != nil ? "checkmark" : "arrow.up")
                        .font(.system(size: 17, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 40, height: 40)
                        .background(Circle().fill(trimmed.isEmpty && staged.isEmpty ? Theme.textSecondary.opacity(0.35) : Theme.bubbleMine))
                }
                .disabled((trimmed.isEmpty && staged.isEmpty) || uploading)
                .accessibilityLabel(editing != nil ? L("edit.save") : L("chat.send"))
                .accessibilityIdentifier("composer.send")
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
        }
        .background(Theme.surface.ignoresSafeArea(edges: .bottom))
    }

    /// Nota de voz: se sube (x-voice-note) y se envía con body '' y su attachmentId.
    private func sendVoice(_ data: Data, _ durationMs: Int, _ waveform: [Double]) {
        let reply = replyTo?.id
        uploading = true
        Task {
            defer { uploading = false }
            do {
                let a = try await store.api.uploadVoiceNote(conversationId, data: data, durationMs: durationMs, waveform: waveform)
                store.send(conversationId, body: "", replyTo: reply, attachments: [a])
                replyTo = nil
            } catch { store.show(L10n.errorText(error)) }
        }
    }

    private func submit() {
        let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty || !staged.isEmpty, !uploading else { return }
        if let e = editing {
            editing = nil
            draft = ""
            if body != e.body { act { try await store.editMessage(e.id, body: body) } }
            return
        }
        if !staged.isEmpty {
            // Adjuntos: se suben (con progreso) y luego se envía el mensaje con sus ids.
            let files = staged, text = draft, reply = replyTo?.id
            uploading = true
            Task {
                defer { uploading = false; uploadProgress = [:] }
                var done: [AttachmentDTO] = []
                for f in files {
                    uploadProgress[f.id] = 0
                    do {
                        let a = try await store.api.uploadAttachment(conversationId, f) { p in Task { @MainActor in uploadProgress[f.id] = p } }
                        done.append(a)
                    } catch {
                        store.show(L10n.errorText(error))
                        return
                    }
                }
                store.send(conversationId, body: text, replyTo: reply, attachments: done)
                staged = []
                draft = ""
                replyTo = nil
            }
            return
        }
        if let pr = store.privateReplies[conversationId] {
            store.sendPrivateReply(pr, body: draft)
        } else {
            store.send(conversationId, body: draft, replyTo: replyTo?.id)
        }
        replyTo = nil
        draft = ""
    }

}

/// Barra sobre el compositor (respondiendo a / editando).
struct ContextBar: View {
    var icon: String
    var title: String
    var detail: String
    var cancelLabel: String
    var onCancel: () -> Void
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon).foregroundStyle(Theme.accentText)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.caption.weight(.semibold)).foregroundStyle(Theme.textPrimary)
                Text(detail).font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(1)
            }
            Spacer()
            Button(action: onCancel) { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.textSecondary) }
                .accessibilityLabel(cancelLabel)
                .frame(minWidth: 44, minHeight: 44)
        }
        .padding(.horizontal, 14)
        .background(Theme.orange.opacity(0.08))
    }
}

/// Mensaje de sistema: algunos enlazan a un asunto, una reunión o la conversación derivada.
struct SystemRow: View {
    @Environment(AppStore.self) private var store
    let message: MessageDTO
    var body: some View {
        let p = message.systemPayload
        let child = (p?["k"] as? String) == "derived.from" ? (p?["childId"] as? String).flatMap { store.meta($0) } : nil
        let issueId = p?["issueId"] as? String
        let eventId = p?["eventId"] as? String
        VStack(spacing: 6) {
            Text(L10n.systemText(message.body))
                .font(.footnote).foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
            if let child, let d = store.data {
                NavigationLink(value: Route.conversation(child.id)) { Text("⑂ \(Naming.title(d, child))").font(.footnote.weight(.semibold)) }
            }
            if let issueId {
                NavigationLink(value: Route.issue(issueId)) { Text(L("lin.open")).font(.footnote.weight(.semibold)) }
            }
            if let eventId { EventCard(eventId: eventId) }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("msg.system")
    }
}

/// Tarjeta de reunión dentro del chat.
struct EventCard: View {
    @Environment(AppStore.self) private var store
    let eventId: String
    var body: some View {
        NavigationLink(value: Route.event(eventId)) {
            if let ev = store.events[eventId] {
                let mine = ev.invitees.first { $0.userId == store.me?.id }
                HStack(spacing: 10) {
                    Image(systemName: "calendar").font(.title3).foregroundStyle(Theme.accentText)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(ev.title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.textPrimary).strikethrough(ev.isCancelled)
                        Text(ev.isCancelled ? L("cal.cancelled") : L10n.eventWhen(ev)).font(.caption).foregroundStyle(Theme.textSecondary)
                        if let mine, !ev.isCancelled { Text(L("cal.rsvp.\(mine.rsvp.rawValue)")).font(.caption2.weight(.semibold)).foregroundStyle(Theme.accentText) }
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.textSecondary)
                }
                .padding(12)
                .frame(maxWidth: 320)
                .background(RoundedRectangle(cornerRadius: 14).fill(Theme.surface))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.orange.opacity(0.35)))
            } else {
                Text(L("lin.open")).font(.footnote.weight(.semibold))
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("eventCard.\(eventId)")
    }
}

struct MessageBubble: View {
    enum Status { case sending, failed }
    /// Columna del avatar a la izquierda de las burbujas ajenas (grupos, chats grupales, laterales).
    enum Leading { case none, spacer, person(name: String, photo: String?, id: String, agent: Bool) }
    var text: String
    var leading: Leading = .none
    var authorColor: Color? = nil
    var time: String
    var mine: Bool
    var author: (name: String, org: String?)?
    var status: Status?
    var italic: Bool
    var quote: (author: String, text: String)? = nil
    var forwardedLabel: String? = nil
    var merged: String? = nil
    var pinned = false
    /// Enlaces del texto tocables (solo mensajes de texto no eliminados).
    var linkify = false
    var linkPreview: LinkPreviewDTO? = nil
    var attachments: [AttachmentDTO] = []
    var messageId: String? = nil
    var conversationId: String? = nil
    @Environment(\.openURL) private var openURL

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if mine { Spacer(minLength: 48) }
            switch leading {
            case .none: EmptyView()
            case .spacer: Color.clear.frame(width: 28, height: 1)
            case .person(let name, let photo, let id, let agent):
                Avatar(name: name, org: nil, isAgent: agent, size: 28, photo: photo, fill: PersonColor.fill(id))
                    .padding(.top, author != nil ? 16 : 0)
            }
            VStack(alignment: mine ? .trailing : .leading, spacing: 3) {
                if let author {
                    HStack(spacing: 4) {
                        Text(author.name).font(.caption.weight(.semibold)).foregroundStyle(authorColor ?? Theme.textPrimary)
                        if let org = author.org { Text("· \(org)").font(.caption).foregroundStyle(Theme.textSecondary) }
                    }
                    .lineLimit(1)
                    .padding(.horizontal, 4)
                }
                VStack(alignment: .leading, spacing: 6) {
                    if let forwardedLabel {
                        Label(forwardedLabel, systemImage: "arrowshape.turn.up.right")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(mine ? Color.white.opacity(0.9) : Theme.textSecondary)
                    }
                    if let quote {
                        VStack(alignment: .leading, spacing: 1) {
                            if !quote.author.isEmpty { Text(quote.author).font(.caption.weight(.semibold)) }
                            Text(quote.text).font(.caption).lineLimit(2)
                        }
                        .foregroundStyle(mine ? Color.white.opacity(0.92) : Theme.textSecondary)
                        .padding(.leading, 8)
                        .overlay(alignment: .leading) { Rectangle().fill(mine ? Color.white.opacity(0.7) : Theme.orange).frame(width: 3) }
                    }
                    if let merged {
                        Label(merged, systemImage: "arrow.uturn.backward").font(.caption.weight(.semibold))
                            .foregroundStyle(mine ? Color.white : Theme.accentText)
                    }
                    if !attachments.isEmpty { AttachmentsBlock(attachments: attachments, mine: mine, messageId: messageId, conversationId: conversationId) }
                    if !text.isEmpty || attachments.isEmpty {
                    Group {
                        if linkify { Text(Linkify.attributed(text)) } else { Text(text) }
                    }
                    .font(.body)
                    .italic(italic)
                    .foregroundStyle(mine ? Color.white : Theme.textPrimary)
                    .tint(mine ? Color.white : Theme.accentText)
                    .textSelection(.enabled)
                    // Con fotos la burbuja se ciñe a ellas; el texto conserva su margen.
                    .padding(.horizontal, attachments.isEmpty ? 0 : 9).padding(.bottom, attachments.isEmpty ? 0 : 4)
                    }
                    if let linkPreview { LinkPreviewCard(preview: linkPreview, mine: mine) }
                }
                .padding(.horizontal, attachments.isEmpty ? 13 : 4).padding(.vertical, attachments.isEmpty ? 8 : 4)
                .background(
                    RoundedRectangle(cornerRadius: 18)
                        .fill(mine ? Theme.bubbleMine : Theme.bubbleOther)
                        .opacity(status == .sending ? 0.7 : 1)
                )
                .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color.red, lineWidth: status == .failed ? 1.5 : 0))
                HStack(spacing: 4) {
                    if pinned { Image(systemName: "pin.fill").foregroundStyle(Theme.accentText) }
                    switch status {
                    case .sending: Image(systemName: "clock"); Text(L("chat.sending"))
                    case .failed: Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.red); Text(L("chat.notSentTap")).foregroundStyle(.red)
                    case nil: Text(time)
                    }
                }
                .font(.caption2)
                .foregroundStyle(Theme.textSecondary)
                .padding(.horizontal, 4)
            }
            if !mine { Spacer(minLength: 48) }
        }
        // Con adjuntos (fotos, archivos, voz) sus controles siguen accesibles.
        .accessibilityElement(children: attachments.isEmpty ? .ignore : .contain)
        .accessibilityLabel(a11yLabel)
        .accessibilityHint(status == .failed ? L("chat.retry") : "")
        .accessibilityActions {
            // Con VoiceOver la burbuja es un solo elemento: los enlaces se abren como acciones.
            if linkify {
                ForEach(Array(Linkify.links(in: text).prefix(3).enumerated()), id: \.offset) { _, l in
                    Button(L("link.open", ["host": l.url.host ?? l.url.absoluteString])) { openURL(l.url) }
                }
            }
        }
    }

    private var a11yLabel: String {
        var parts: [String] = []
        if mine { parts.append(L("a11y.you")) } else if let author { parts.append([author.name, author.org].compactMap { $0 }.joined(separator: ", ")) }
        if let forwardedLabel { parts.append(forwardedLabel) }
        if let quote { parts.append(L("reply.to", ["name": quote.author]) + ": " + quote.text) }
        if let merged { parts.append(merged) }
        parts.append(text)
        if let p = linkPreview { parts.append([p.host, p.title].compactMap { $0 }.joined(separator: ": ")) }
        if pinned { parts.append(L("toast.pinned")) }
        switch status {
        case .sending: parts.append(L("chat.sending"))
        case .failed: parts.append(L("chat.notSent"))
        case nil: if !time.isEmpty { parts.append(time) }
        }
        return parts.joined(separator: ". ")
    }
}

/// Barra de linaje: de dónde viene, en qué derivó y devolver el resultado.
struct LineageBar: View {
    @Environment(AppStore.self) private var store
    let conv: ConversationDTO
    var onReturn: () -> Void
    var body: some View {
        if let d = store.data {
            let parent = conv.parentId.flatMap { store.meta($0) }
            // Las laterales no van en el linaje: tienen su chip bajo el mensaje ancla.
            let kids = d.conversations.filter { $0.parentId == conv.id && !Naming.isSide($0) }
            if (conv.parentId != nil && !Naming.isSide(conv)) || !kids.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        Text(L("lin.label")).font(.caption2.weight(.bold)).textCase(.uppercase).foregroundStyle(Theme.textSecondary)
                        if conv.parentId != nil {
                            if let parent {
                                NavigationLink(value: Route.conversation(parent.id)) { chip("↖ \(L("lin.from")) «\(Naming.title(d, parent))»") }
                            } else { chip("↖ \(L("lin.fromHidden"))").opacity(0.7) }
                        }
                        if let k = conv.deriveKind { chip(L("lin.kind.\(k)"), tint: true) }
                        if !kids.isEmpty { Text(L("lin.kids")).font(.caption).foregroundStyle(Theme.textSecondary) }
                        ForEach(kids) { k in
                            NavigationLink(value: Route.conversation(k.id)) { chip("⑂ \(Naming.title(d, k))\(k.returnedAt != nil ? " ✓" : "")") }
                        }
                        if conv.returnedAt != nil { Text("✓ \(L("lin.returned"))").font(.caption.weight(.semibold)).foregroundStyle(.green) }
                        if parent != nil, conv.returnedAt == nil, conv.canPost {
                            Button(L("lin.return"), action: onReturn)
                                .font(.caption.weight(.semibold))
                                .buttonStyle(.borderedProminent).tint(Theme.bubbleMine)
                                .accessibilityIdentifier("lineage.return")
                        }
                        NavigationLink(value: Route.trazo) { Text(L("lin.trazo")).font(.caption) }
                    }
                    .padding(.horizontal, 12).padding(.vertical, 6)
                }
                .background(Theme.surface)
                .accessibilityIdentifier("lineage")
            }
        }
    }

    private func chip(_ text: String, tint: Bool = false) -> some View {
        Text(text).font(.caption.weight(.medium)).lineLimit(1)
            .padding(.horizontal, 10).padding(.vertical, 4)
            .background(Capsule().fill(tint ? Theme.orange.opacity(0.15) : Theme.bubbleOther))
            .foregroundStyle(Theme.textPrimary)
    }
}
