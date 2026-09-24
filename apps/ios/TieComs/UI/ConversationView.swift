import SwiftUI

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

struct ConversationView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    let conversationId: String
    @State private var draft = ""
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
        .onAppear { store.openConversationId = conversationId }
        .onDisappear { if store.openConversationId == conversationId { store.openConversationId = nil } }
        .task(id: conversationId) { try? await store.openConversation(conversationId) }
    }

    @ViewBuilder
    private func content(_ d: BootstrapDTO, _ c: ConversationDTO) -> some View {
        let state = store.conversations[conversationId]
        VStack(spacing: 0) {
            if store.connection != .online {
                ConnectionBanner(connection: store.connection).padding(.horizontal, 16).padding(.vertical, 6)
                    .background(Theme.surface)
            }
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
            if c.canPost { composer(d, c) } else {
                Text(L("chat.readOnly"))
                    .font(.footnote).foregroundStyle(Theme.textSecondary)
                    .frame(maxWidth: .infinity).padding(14)
                    .background(Theme.surface)
                    .accessibilityIdentifier("chat.readOnly")
            }
        }
        .toolbar {
            ToolbarItem(placement: .principal) {
                NavigationLink(value: Route.details(conversationId)) {
                    VStack(spacing: 1) {
                        HStack(spacing: 4) {
                            if c.kind == .internal { Image(systemName: "lock.fill").font(.caption2) }
                            Text(Naming.title(d, c)).font(.headline).lineLimit(1)
                        }
                        .foregroundStyle(Theme.textPrimary)
                        let sub = Naming.subtitle(d, c)
                        if !sub.isEmpty { Text(sub).font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(1) }
                    }
                }
                .accessibilityLabel([Naming.title(d, c), Naming.subtitle(d, c)].filter { !$0.isEmpty }.joined(separator: ", "))
                .accessibilityHint(L("chat.details"))
                .accessibilityIdentifier("chat.header")
            }
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(value: Route.details(conversationId)) { Image(systemName: "info.circle") }
                    .accessibilityLabel(L("chat.details"))
            }
        }
    }

    private func buildItems(_ state: ConversationState, pending: [PendingMessage]) -> [ChatItem] {
        var items: [ChatItem] = []
        var lastDay: DateComponents?
        var prevAuthor: String?
        var prevDate: Date?
        let cal = Calendar.current
        for m in state.messages {
            let date = ISODate.parse(m.createdAt) ?? Date()
            let day = cal.dateComponents([.year, .month, .day], from: date)
            if day != lastDay {
                items.append(.day("\(day.year ?? 0)-\(day.month ?? 0)-\(day.day ?? 0)", date))
                lastDay = day
                prevAuthor = nil
            }
            if m.isSystem {
                items.append(.system(m))
                prevAuthor = nil
            } else {
                let grouped = prevAuthor == m.authorId && prevDate.map { date.timeIntervalSince($0) < 300 } == true
                items.append(.message(m, showAuthor: !grouped))
                prevAuthor = m.authorId
            }
            prevDate = date
        }
        items += pending.map(ChatItem.pending)
        return items
    }

    @ViewBuilder
    private func messages(_ d: BootstrapDTO, _ c: ConversationDTO, _ state: ConversationState) -> some View {
        let items = buildItems(state, pending: store.pendingFor(conversationId))
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
                    if state.messages.isEmpty && items.isEmpty {
                        Text(L("conv.noMessages")).font(.subheadline).foregroundStyle(Theme.textSecondary).padding(.top, 40)
                    }
                    ForEach(items) { item in
                        row(d, item).id(item.id)
                    }
                    Color.clear.frame(height: 4).id("bottom")
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .defaultScrollAnchor(.bottom)
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

    private func markReadIfVisible() {
        guard scenePhase == .active, store.openConversationId == conversationId else { return }
        store.markRead(conversationId)
    }

    @ViewBuilder
    private func row(_ d: BootstrapDTO, _ item: ChatItem) -> some View {
        switch item {
        case .day(_, let date):
            Text(L10n.dayLabel(date))
                .font(.caption.weight(.semibold)).foregroundStyle(Theme.textSecondary)
                .padding(.horizontal, 10).padding(.vertical, 4)
                .background(Capsule().fill(Theme.surface))
                .padding(.vertical, 8)
                .accessibilityAddTraits(.isHeader)
        case .system(let m):
            Text(L10n.systemText(m.body))
                .font(.footnote).foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
                .accessibilityIdentifier("msg.system")
        case .message(let m, let showAuthor):
            let mine = m.authorId == d.me.id
            MessageBubble(text: m.deletedAt != nil ? L("chat.deleted") : m.body, time: L10n.clock(m.createdAt), mine: mine,
                          author: mine || !showAuthor ? nil : Naming.authorLine(d, m.authorId),
                          status: nil, italic: m.deletedAt != nil)
                .padding(.top, showAuthor ? 6 : 0)
                .accessibilityIdentifier("msg.\(m.id)")
        case .pending(let p):
            MessageBubble(text: p.body, time: "", mine: true, author: nil, status: p.status == .failed ? .failed : .sending, italic: false)
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
        HStack(alignment: .bottom, spacing: 8) {
            TextField(L("chat.placeholder", ["name": Naming.title(d, c)]), text: $draft, axis: .vertical)
                .lineLimit(1...6)
                .focused($composerFocused)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: 20).fill(Theme.background))
                .overlay(RoundedRectangle(cornerRadius: 20).stroke(Theme.textSecondary.opacity(0.25)))
                .onChange(of: draft) { _, v in if !v.isEmpty { store.userIsTyping(conversationId) } }
                .accessibilityLabel(L("chat.composerLabel"))
                .accessibilityIdentifier("composer.field")
            Button {
                store.send(conversationId, body: draft)
                draft = ""
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
                    .background(Circle().fill(trimmed.isEmpty ? Theme.textSecondary.opacity(0.35) : Theme.bubbleMine))
            }
            .disabled(trimmed.isEmpty)
            .accessibilityLabel(L("chat.send"))
            .accessibilityIdentifier("composer.send")
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Theme.surface.ignoresSafeArea(edges: .bottom))
    }
}

struct MessageBubble: View {
    enum Status { case sending, failed }
    var text: String
    var time: String
    var mine: Bool
    var author: (name: String, org: String?)?
    var status: Status?
    var italic: Bool

    var body: some View {
        HStack {
            if mine { Spacer(minLength: 48) }
            VStack(alignment: mine ? .trailing : .leading, spacing: 3) {
                if let author {
                    HStack(spacing: 4) {
                        Text(author.name).font(.caption.weight(.semibold)).foregroundStyle(Theme.textPrimary)
                        if let org = author.org { Text("· \(org)").font(.caption).foregroundStyle(Theme.textSecondary) }
                    }
                    .lineLimit(1)
                    .padding(.horizontal, 4)
                }
                Text(text)
                    .font(.body)
                    .italic(italic)
                    .foregroundStyle(mine ? Color.white : Theme.textPrimary)
                    .textSelection(.enabled)
                    .padding(.horizontal, 13).padding(.vertical, 8)
                    .background(
                        RoundedRectangle(cornerRadius: 18)
                            .fill(mine ? Theme.bubbleMine : Theme.bubbleOther)
                            .opacity(status == .sending ? 0.7 : 1)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 18).stroke(Color.red, lineWidth: status == .failed ? 1.5 : 0)
                    )
                HStack(spacing: 4) {
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
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(a11yLabel)
        .accessibilityHint(status == .failed ? L("chat.retry") : "")
    }

    private var a11yLabel: String {
        var parts: [String] = []
        if mine { parts.append(L("a11y.you")) } else if let author { parts.append([author.name, author.org].compactMap { $0 }.joined(separator: ", ")) }
        parts.append(text)
        switch status {
        case .sending: parts.append(L("chat.sending"))
        case .failed: parts.append(L("chat.notSent"))
        case nil: if !time.isEmpty { parts.append(time) }
        }
        return parts.joined(separator: ". ")
    }
}
