import SwiftUI

// Dentro del chat (docs/GRUPOS.md, «Dentro del chat»): barra de accesos Fijados · Asuntos · Hilos · Agenda,
// hilos como en Slack (derivadas que se abren al lado) y sidechats como hilos privados.

/// Hilos de una conversación: las derivadas (con los del chat o solo mi equipo) y mis sidechats privados.
enum ChatThreads {
    static func isPrivate(_ c: ConversationDTO) -> Bool { Naming.isSide(c) }

    /// Los que cuelgan de la conversación (o de un mensaje): abiertos primero y luego por actividad.
    static func of(_ d: BootstrapDTO, _ conversationId: String, messageId: String? = nil) -> [ConversationDTO] {
        d.conversations.filter { $0.parentId == conversationId && (messageId == nil || $0.parentMessageId == messageId) }
            .sorted { a, b in
                if (a.returnedAt != nil) != (b.returnedAt != nil) { return a.returnedAt == nil }
                return (a.lastMessageAt ?? "") > (b.lastMessageAt ?? "")
            }
    }

    /// El título sin el prefijo que ya dice el ícono («Hilo · », «Sidechat · », «Derivada · »…), como la web.
    static func title(_ d: BootstrapDTO, _ c: ConversationDTO) -> String {
        let t = Naming.title(d, c)
        let s = t.replacingOccurrences(of: #"^(Sidechat|Consulta|Hilo|Thread|Interno|Internal|Derivada|Branch|Diagnóstico|Diagnosis|Decisión|Decision)\s*·\s*"#,
                                       with: "", options: [.regularExpression, .caseInsensitive])
        return s.isEmpty ? t : s
    }

    /// Respuestas del hilo (sin el primer mensaje).
    static func replies(_ c: ConversationDTO) -> Int { max(0, c.lastMessageSeq - 1) }

    static func repliesText(_ n: Int) -> String { n == 1 ? L("bar.replyOne") : L("bar.repliesN", ["n": n]) }
}

/// Agenda del chat: reuniones, fechas límite de sus asuntos abiertos y mis recordatorios en él, por fecha.
struct ChatAgendaItem: Identifiable, Equatable {
    enum Kind: Equatable { case event, due, reminder }
    var kind: Kind
    var refId: String
    var at: Date
    var id: String { "\(kind)-\(refId)" }

    static func build(conversationId: String, events: [CalendarEventDTO], issues: [IssueDTO], reminders: [ReminderDTO], now: Date = Date()) -> [ChatAgendaItem] {
        var out: [ChatAgendaItem] = []
        for e in events where e.conversationId == conversationId && !e.isCancelled && e.end >= now {
            out.append(.init(kind: .event, refId: e.id, at: e.start))
        }
        for i in issues where i.conversationId == conversationId && !i.status.closed {
            // La fecha límite cuenta hasta el final del día.
            if let day = IssueDates.date(i.dueDate) { out.append(.init(kind: .due, refId: i.id, at: day.addingTimeInterval(11 * 3600 + 59 * 60))) }
        }
        for r in reminders where r.conversationId == conversationId && r.doneAt == nil {
            if let at = ISODate.parse(r.remindAt) { out.append(.init(kind: .reminder, refId: r.id, at: at)) }
        }
        return out.sorted { $0.at == $1.at ? $0.id < $1.id : $0.at < $1.at }
    }
}

// MARK: - Barra de accesos

/// Una fila fija bajo la cabecera del chat con 4 botones siempre visibles y su cuenta (gris si es 0).
struct ChatBar: View {
    @Environment(AppStore.self) private var store
    let conv: ConversationDTO
    var onPins: () -> Void
    var onIssues: () -> Void
    var onThreads: () -> Void
    var onAgenda: () -> Void

    var body: some View {
        if let d = store.data {
            let issues = store.issues.values.filter { $0.conversationId == conv.id && !$0.status.closed }
            let today = IssueDates.today()
            let overdue = issues.contains { ($0.dueDate ?? "9999") < today }
            let threads = ChatThreads.of(d, conv.id)
            let open = threads.filter { $0.returnedAt == nil }
            let agenda = ChatAgendaItem.build(conversationId: conv.id, events: Array(store.events.values), issues: Array(issues), reminders: store.reminders)
            let meetingToday = agenda.contains { $0.kind == .event && Calendar.current.isDateInToday($0.at) }
            HStack(spacing: 6) {
                button("pins", "pin.fill", L("bar.pins"), store.pins[conv.id]?.count ?? 0, alert: false, action: onPins)
                button("issues", "diamond.fill", L("bar.issues"), issues.count, alert: overdue, action: onIssues)
                button("threads", "bubble.left.and.bubble.right.fill", L("bar.threads"), open.count, alert: threads.contains { $0.unread > 0 }, action: onThreads)
                button("agenda", "calendar", L("bar.agenda"), agenda.count, alert: meetingToday, action: onAgenda)
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(Theme.surface)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(L("bar.label"))
            .accessibilityIdentifier("chat.bar")
        }
    }

    private func button(_ key: String, _ icon: String, _ label: String, _ n: Int, alert: Bool, action: @escaping () -> Void) -> some View {
        let tint: Color = alert ? Theme.orange : n > 0 ? Theme.accentText : Theme.textSecondary.opacity(0.7)
        return Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 11, weight: .semibold))
                Text("\(n)").font(.caption.weight(.bold)).monospacedDigit()
                Text(label).font(.caption2.weight(.medium)).lineLimit(1).minimumScaleFactor(0.75)
            }
            .foregroundStyle(tint)
            .frame(maxWidth: .infinity, minHeight: 30)
            .background(Capsule().fill(alert ? Theme.orange.opacity(0.16) : n > 0 ? Theme.orange.opacity(0.08) : Theme.textSecondary.opacity(0.06)))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(label): \(n)")
        .accessibilityIdentifier("chat.bar.\(key)")
    }
}

// MARK: - Hilos

/// «Hilos de este chat»: 💬 con los del chat o 🔒 privado, personas, respuestas, actividad y Abierto / ✓ Resuelto.
struct ChatThreadsSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let conversationId: String
    var onOpen: (String) -> Void

    var body: some View {
        NavigationStack {
            List {
                if let d = store.data {
                    let list = ChatThreads.of(d, conversationId)
                    if list.isEmpty { Text(L("bar.noThreads")).font(.footnote).foregroundStyle(Theme.textSecondary) }
                    ForEach(list) { c in
                        Button { dismiss(); onOpen(c.id) } label: { ThreadRow(d: d, c: c) }
                            .accessibilityIdentifier("thread.row.\(c.id)")
                    }
                }
            }
            .navigationTitle(L("bar.threadsTitle"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L("common.close")) { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
}

struct ThreadRow: View {
    let d: BootstrapDTO
    let c: ConversationDTO
    var body: some View {
        let priv = ChatThreads.isPrivate(c)
        let n = ChatThreads.replies(c)
        HStack(spacing: 10) {
            Image(systemName: priv ? "lock.fill" : "bubble.left.and.bubble.right.fill")
                .font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.accentText)
                .frame(width: 30, height: 30)
                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.orange.opacity(0.12)))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(ChatThreads.title(d, c)).font(.subheadline.weight(c.unread > 0 ? .bold : .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                Text([priv ? L("bar.private") : L("bar.public"), L("bar.peopleN", ["n": c.memberIds.count]),
                      n > 0 ? ChatThreads.repliesText(n) : nil, c.lastMessageAt.map { L10n.timeLabel($0) }].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(1)
            }
            Spacer(minLength: 4)
            if c.unread > 0 { UnreadPill(count: c.unread) }
            Text(c.returnedAt != nil ? "✓ \(L("bar.solved"))" : L("bar.open"))
                .font(.caption2.weight(.bold))
                .foregroundStyle(c.returnedAt != nil ? Color.green : Theme.accentText)
                .padding(.horizontal, 7).padding(.vertical, 2)
                .background(Capsule().fill((c.returnedAt != nil ? Color.green : Theme.orange).opacity(0.14)))
                .fixedSize()
        }
        .accessibilityElement(children: .combine)
    }
}

/// Bajo el mensaje, como en Slack: «💬 3 respuestas · Laura: ya va» (o «💬 ✓ título» si se resolvió). Abre el hilo al lado.
/// Los sidechats privados usan su propio chip (SideChip).
struct ThreadChip: View {
    @Environment(AppStore.self) private var store
    let threads: [ConversationDTO]
    var onOpen: (String) -> Void

    var body: some View {
        if let d = store.data {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(threads) { c in
                    Button { onOpen(c.id) } label: { chip(d, c) }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("thread.chip.\(c.id)")
                }
            }
        }
    }

    private func chip(_ d: BootstrapDTO, _ c: ConversationDTO) -> some View {
        let n = ChatThreads.replies(c)
        let solved = c.returnedAt != nil
        let label = solved ? "✓ \(ChatThreads.title(d, c))" : n > 0 ? ChatThreads.repliesText(n) : ChatThreads.title(d, c)
        let last = c.lastHumanPreview
        let who = last.map { $0.authorId == d.me.id ? L("common.youShort") : (Naming.person(d, $0.authorId)?.name.split(separator: " ").first.map(String.init) ?? "") }
        return HStack(spacing: 8) {
            ThreadCurve().stroke(Theme.textSecondary.opacity(0.4), style: StrokeStyle(lineWidth: 1.5, lineCap: .round)).frame(width: 12, height: 16)
                .offset(y: -8).accessibilityHidden(true)
            StackedAvatars(d: d, c: c, size: 20)
                .frame(width: 20 + CGFloat(max(0, min(3, Naming.others(d, c).count) - 1)) * 11, alignment: .leading)
            VStack(alignment: .leading, spacing: 1) {
                Text("💬 " + label).font(.caption.weight(.bold)).foregroundStyle(solved ? Color.green : Theme.accentText).lineLimit(1)
                if !solved, let last, !last.body.isEmpty {
                    Text((who.map { $0.isEmpty ? "" : "\($0): " } ?? "") + last.body).font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(1)
                }
            }
            if HomeOrder.pending(c) > 0 { Circle().fill(Theme.orange).frame(width: 8, height: 8).accessibilityLabel(L("home.tab.unread")) }
            Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(Theme.textSecondary)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 14).fill(solved ? Color.green.opacity(0.08) : Theme.surface))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(solved ? Color.green.opacity(0.3) : Theme.textSecondary.opacity(0.2)))
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Agenda

/// «Agenda de este chat»: reuniones, fechas límite de sus asuntos y mis recordatorios (solo yo los veo), con «＋ Evento» y «＋ Asunto».
struct ChatAgendaSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let conversationId: String
    var onNewEvent: (() -> Void)?
    var onNewIssue: (() -> Void)?

    var body: some View {
        NavigationStack {
            List {
                let issues = store.issues.values.filter { $0.conversationId == conversationId && !$0.status.closed }
                let items = ChatAgendaItem.build(conversationId: conversationId, events: Array(store.events.values), issues: Array(issues), reminders: store.reminders)
                if items.isEmpty { Text(L("bar.noAgenda")).font(.footnote).foregroundStyle(Theme.textSecondary) }
                ForEach(items) { item in row(item) }
            }
            .navigationTitle(L("bar.agendaTitle"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("common.close")) { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        if let onNewEvent { Button { onNewEvent() } label: { Label(L("bar.newEvent"), systemImage: "calendar.badge.plus") } }
                        if let onNewIssue { Button { onNewIssue() } label: { Label(L("bar.newIssue"), systemImage: "diamond") } }
                    } label: { Image(systemName: "plus") }
                    .disabled(onNewEvent == nil && onNewIssue == nil)
                    .accessibilityLabel(L("bar.plus"))
                    .accessibilityIdentifier("agenda.add")
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    @ViewBuilder private func row(_ item: ChatAgendaItem) -> some View {
        switch item.kind {
        case .event:
            if let e = store.events[item.refId] {
                Button { dismiss(); store.push(.event(e.id)) } label: { EventRow(event: e, showConv: false) }
            }
        case .due:
            if let i = store.issues[item.refId] {
                let overdue = (i.dueDate ?? "9999") < IssueDates.today()
                Button { dismiss(); store.push(.issue(i.id)) } label: {
                    HStack(spacing: 10) {
                        Text("◆").foregroundStyle(Theme.accentText).accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(i.title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.textPrimary).lineLimit(2)
                            Text(L("bar.dueOn", ["date": item.at.formatted(Date.FormatStyle().weekday(.abbreviated).day().month(.abbreviated).locale(L10n.locale))]))
                                .font(.caption).foregroundStyle(Theme.textSecondary)
                        }
                        Spacer(minLength: 4)
                        if overdue {
                            Text(L("bar.overdue")).font(.caption2.weight(.bold)).foregroundStyle(.red)
                                .padding(.horizontal, 7).padding(.vertical, 2).background(Capsule().fill(Color.red.opacity(0.12)))
                        }
                    }
                }
                .accessibilityIdentifier("agenda.due.\(i.id)")
            }
        case .reminder:
            if let r = store.reminders.first(where: { $0.id == item.refId }) {
                HStack(spacing: 10) {
                    Image(systemName: "alarm").foregroundStyle(Theme.accentText).accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(r.note.flatMap { $0.isEmpty ? nil : $0 } ?? L("bar.reminder")).font(.subheadline.weight(.semibold)).lineLimit(2)
                        Text("\(L("bar.onlyYou")) · \(L10n.dateTime(item.at))").font(.caption).foregroundStyle(Theme.textSecondary)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}
