import SwiftUI

// Tanda 1.7 (docs/TANDA-1.7.md): los avisos de tareas y eventos en el chat se dibujan como su tarjeta.
// §2 «Es hoy» (event.today), §3 tarea completada (issue.done, con confeti), §4 tarea vencida (issue.overdue, carita
// triste y botones), §5 comentarios agrupados (issue.comments / event.comments, se actualizan con message.updated).

/// Qué tarjeta dibuja un mensaje de sistema.
enum ChatCardKind: Equatable {
    struct Comments: Equatable { var count: Int; var lastById: String?; var lastByName: String; var lastExcerpt: String }
    case eventCreated(String)
    case eventToday(String)
    case eventComments(String, Comments)
    case issueCreated(String)
    case issueDone(String, byName: String)
    case issueOverdue(String, dueDate: String?)
    case issueComments(String, Comments)

    var issueId: String? {
        switch self {
        case .issueCreated(let id), .issueDone(let id, _), .issueOverdue(let id, _), .issueComments(let id, _): return id
        default: return nil
        }
    }
    var isDone: Bool { if case .issueDone = self { return true }; return false }
    var isOverdue: Bool { if case .issueOverdue = self { return true }; return false }
    var isComments: Bool {
        switch self { case .issueComments, .eventComments: return true; default: return false }
    }
    var eventId: String? {
        switch self {
        case .eventCreated(let id), .eventToday(let id), .eventComments(let id, _): return id
        default: return nil
        }
    }
}

enum ChatCards {
    static func kind(_ m: MessageDTO) -> ChatCardKind? {
        guard let p = m.systemPayload, let k = p["k"] as? String else { return nil }
        func str(_ key: String) -> String? { (p[key] as? String).flatMap { $0.isEmpty ? nil : $0 } }
        func comments() -> ChatCardKind.Comments {
            let n = (p["count"] as? NSNumber)?.intValue ?? Int(str("count") ?? "") ?? 1
            return .init(count: max(1, n), lastById: str("lastById"), lastByName: str("lastByName") ?? "", lastExcerpt: str("lastExcerpt") ?? "")
        }
        switch k {
        case "event.created": return str("eventId").map { .eventCreated($0) }
        case "event.today": return str("eventId").map { .eventToday($0) }
        case "event.comments": return str("eventId").map { .eventComments($0, comments()) }
        case "issue.created":
            // Las derivadas siguen como línea.
            guard let id = str("issueId"), str("parentIssueId") == nil else { return nil }
            return .issueCreated(id)
        case "issue.done": return str("issueId").map { .issueDone($0, byName: str("byName") ?? "") }
        case "issue.overdue": return str("issueId").map { .issueOverdue($0, dueDate: str("dueDate")) }
        case "issue.comments": return str("issueId").map { .issueComments($0, comments()) }
        default: return nil
        }
    }

    /// El título que trae el aviso (p. ej. el de la tarea en `issue.comments`).
    static func title(_ m: MessageDTO) -> String { (m.systemPayload?["title"] as? String) ?? "" }

    /// Mensajes que celebran (confeti) o lamentan (carita triste) al llegar en vivo con el chat a la vista.
    enum Burst: Equatable { case confetti, sad }
    static func burst(_ m: MessageDTO) -> Burst? {
        switch kind(m) {
        case .issueDone: return .confetti
        case .issueOverdue: return .sad
        default: return nil
        }
    }

    /// «Hoy», «Mañana», «Próximo lunes» (fechas yyyy-MM-dd en la hora local).
    static func quickDue(_ which: QuickDue, now: Date = Date(), calendar: Calendar = .current) -> String {
        let today = calendar.startOfDay(for: now)
        switch which {
        case .today: return IssueDates.iso(today)
        case .tomorrow: return IssueDates.iso(calendar.date(byAdding: .day, value: 1, to: today) ?? today)
        case .nextMonday:
            var d = calendar.date(byAdding: .day, value: 1, to: today) ?? today
            while calendar.component(.weekday, from: d) != 2 { d = calendar.date(byAdding: .day, value: 1, to: d) ?? d }
            return IssueDates.iso(d)
        }
    }
    enum QuickDue: CaseIterable { case today, tomorrow, nextMonday }
}

/// Una vez por mensaje y por dispositivo (confeti y carita triste), con tope.
enum BurstLedger {
    private static let key = "tc.bursts"
    static func shouldPlay(_ messageId: String) -> Bool {
        var seen = UserDefaults.standard.stringArray(forKey: key) ?? []
        guard !seen.contains(messageId) else { return false }
        seen.append(messageId)
        UserDefaults.standard.set(Array(seen.suffix(300)), forKey: key)
        return true
    }
}

// MARK: - Animaciones

/// Confeti de ~1,2 s (sin «reducir movimiento»).
struct ConfettiBurst: View {
    @State private var start = Date()
    private let pieces: [(x: CGFloat, dx: CGFloat, color: Color, spin: Double, delay: Double, size: CGFloat)] = (0..<70).map { _ in
        (CGFloat.random(in: 0...1), CGFloat.random(in: -0.25...0.25),
         [Color(hex: 0xFF5A36), Color(hex: 0x2FB36B), Color(hex: 0xF5C542), Color(hex: 0x3B82F6), Color(hex: 0xC084FC)].randomElement()!,
         Double.random(in: -6...6), Double.random(in: 0...0.25), CGFloat.random(in: 6...11))
    }
    var body: some View {
        TimelineView(.animation) { ctx in
            let t = ctx.date.timeIntervalSince(start)
            Canvas { g, size in
                for p in pieces {
                    let tt = max(0, t - p.delay)
                    guard tt < 1.2 else { continue }
                    let x = (p.x + p.dx * tt) * size.width
                    let y = -20 + (size.height * 0.9) * CGFloat(tt / 1.2) + CGFloat(200 * tt * tt)
                    var r = g
                    r.translateBy(x: x, y: y)
                    r.rotate(by: .radians(p.spin * tt))
                    r.opacity = 1 - tt / 1.2
                    r.fill(Path(CGRect(x: -p.size / 2, y: -p.size / 4, width: p.size, height: p.size / 2)), with: .color(p.color))
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// Carita triste que aparece y se va (~1,4 s).
struct SadBurst: View {
    @State private var on = false
    var body: some View {
        Text("😢").font(.system(size: 96))
            .scaleEffect(on ? 1 : 0.4)
            .opacity(on ? 0 : 1)
            .offset(y: on ? -30 : 0)
            .onAppear { withAnimation(.easeOut(duration: 1.4)) { on = true } }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

// MARK: - Piezas de las tarjetas

/// Franja «💬 Comentario añadido» / «💬 N comentarios nuevos», con el último extracto y «Responder».
struct CommentsStrip: View {
    let info: ChatCardKind.Comments
    var onReply: (() -> Void)?
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("💬 " + (info.count > 1 ? L("card.commentsNew", ["n": info.count]) : L("card.commentAdded")))
                .font(.caption.weight(.bold)).foregroundStyle(Theme.accentText)
            if !info.lastExcerpt.isEmpty {
                (Text(info.lastByName.split(separator: " ").first.map(String.init) ?? info.lastByName).bold() + Text(": " + info.lastExcerpt))
                    .font(.footnote).foregroundStyle(Theme.textPrimary).lineLimit(3)
            }
            if let onReply {
                Button(L("card.reply"), action: onReply)
                    .font(.footnote.weight(.semibold)).buttonStyle(.borderless)
                    .accessibilityIdentifier("card.reply")
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.orange.opacity(0.08)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("card.commentsStrip")
    }
}

/// Botones de la tarea vencida: Nueva fecha (Hoy, Mañana, Próximo lunes, Elegir fecha), Marcar hecha y Reasignar.
struct OverdueActions: View {
    @Environment(AppStore.self) private var store
    let issue: IssueDTO
    @State private var picking = false
    @State private var reassigning = false
    @State private var date = Date()

    var body: some View {
        HStack(spacing: 6) {
            Menu {
                Button(L("due.today")) { setDue(ChatCards.quickDue(.today)) }
                Button(L("due.tomorrow")) { setDue(ChatCards.quickDue(.tomorrow)) }
                Button(L("due.nextMonday")) { setDue(ChatCards.quickDue(.nextMonday)) }
                Button(L("due.pick")) { picking = true }
            } label: { pill("📅 " + L("card.newDate")) }
            .accessibilityIdentifier("card.newDate.\(issue.id)")
            Button { run { try await store.setIssueStatus(issue.id, .done) } } label: { pill("✓ " + L("card.markDone")) }
                .buttonStyle(.plain)
                .accessibilityIdentifier("card.markDone.\(issue.id)")
            Button { reassigning = true } label: { pill("👤 " + L("card.reassign")) }
                .buttonStyle(.plain)
                .accessibilityIdentifier("card.reassign.\(issue.id)")
        }
        .sheet(isPresented: $picking) {
            NavigationStack {
                DatePicker(L("due.pick"), selection: $date, in: Date()..., displayedComponents: .date)
                    .datePickerStyle(.graphical).padding()
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { picking = false } }
                        ToolbarItem(placement: .confirmationAction) { Button(L("common.save")) { picking = false; setDue(IssueDates.iso(date)) } }
                    }
            }
            .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $reassigning) { ReassignSheet(issue: issue) }
    }

    private func pill(_ t: String) -> some View {
        Text(t).font(.caption.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.8)
            .foregroundStyle(Theme.textPrimary)
            .padding(.horizontal, 10).frame(minHeight: 30)
            .background(Capsule().fill(Theme.textSecondary.opacity(0.1)))
    }

    private func setDue(_ iso: String) { run { _ = try await store.updateIssue(issue.id, ["dueDate": iso]) } }

    private func run(_ f: @escaping () async throws -> Void) {
        Haptics.tap()
        Task { do { try await f() } catch { store.show(L10n.errorText(error)) } }
    }
}

/// Reasignar permite varios responsables de la audiencia autorizada; confirma un único PATCH real.
struct ReassignSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let issue: IssueDTO
    @State private var selected: Set<String> = []
    @State private var saving = false
    var body: some View {
        NavigationStack {
            if let d = store.data {
                let ids = issue.isPersonal ? [d.me.id] : (issue.conversationId.flatMap { store.meta($0)?.memberIds } ?? issue.assignedIds)
                List(ids.compactMap { Naming.person(d, $0) }.filter { $0.kind != "agent" }) { p in
                    Toggle(isOn: Binding(get: { selected.contains(p.id) }, set: { on in if on { selected.insert(p.id) } else { selected.remove(p.id) } })) {
                        HStack(spacing: 12) {
                            Avatar(person: p, org: Naming.org(d, p.orgId), size: 34)
                            Text(p.name).foregroundStyle(Theme.textPrimary)
                        }
                    }.accessibilityIdentifier("reassign.\(p.id)")
                }
                .navigationTitle(L("card.reassign"))
                .navigationBarTitleDisplayMode(.inline)
                .onAppear { selected = Set(issue.assignedIds) }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(L("common.save")) {
                            saving = true
                            let ids = selected.sorted()
                            Task {
                                defer { saving = false }
                                do { _ = try await store.updateIssue(issue.id, ["ownerId": ids.first ?? NSNull(), "assigneeIds": ids]); dismiss() }
                                catch { store.show(L10n.errorText(error)) }
                            }
                        }.disabled(saving || (issue.isPersonal && selected.isEmpty))
                    }
                }
            }
        }
    }
}


/// Confeti o carita triste: solo en vivo, con el chat a la vista, una vez por mensaje y sin «reducir movimiento».
struct BurstLayer: ViewModifier {
    @Environment(AppStore.self) private var store
    let conversationId: String
    @State private var burst: AppStore.LiveBurst?
    func body(content: Content) -> some View {
        content
            .onChange(of: store.liveBurst) { _, b in
                guard let b, b.conversationId == conversationId, !UIAccessibility.isReduceMotionEnabled, BurstLedger.shouldPlay(b.messageId) else { return }
                burst = b
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { if burst?.messageId == b.messageId { burst = nil } }
            }
            .overlay {
                if let b = burst {
                    Group { if b.kind == .confetti { ConfettiBurst() } else { SadBurst() } }
                        .accessibilityIdentifier(b.kind == .confetti ? "burst.confetti" : "burst.sad")
                }
            }
    }
}
