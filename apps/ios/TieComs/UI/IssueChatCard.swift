import SwiftUI

// Tarjeta de tarea en el chat (docs/TEMAS.md, «Tarjeta de tarea en el chat»): reemplaza la línea de sistema
// «Creó la tarea…» por una tarjeta completa, como un evento, desde la que se completa y se comenta.
// Paridad con IssueChatCard de apps/web/src/screens/Issues.tsx.

/// Comentarios que muestra una tarjeta y el `commentCount` con que se pidieron.
struct TaskCardComments: Equatable, Sendable {
    var count: Int
    var items: [IssueEventDTO]
}

/// Reglas puras de la tarjeta (sin red), compartidas con las pruebas.
enum TaskCard {
    /// El mensaje de sistema `issue.created` con `issueId` y sin `parentIssueId` (las tareas derivadas siguen como línea).
    static func issueId(_ m: MessageDTO) -> String? {
        guard let p = m.systemPayload, p["k"] as? String == "issue.created", let id = p["issueId"] as? String, !id.isEmpty else { return nil }
        if let parent = p["parentIssueId"] as? String, !parent.isEmpty { return nil }
        return id
    }

    /// Con una banderita elegida: los mensajes de ese tema y las tarjetas de las tareas de ese tema. Sin filtro, todo.
    static func matches(_ m: MessageDTO, filter: String?, issues: [String: IssueDTO]) -> Bool {
        guard let filter else { return true }
        if m.isSystem { return ChatCards.kind(m)?.issueId.flatMap { issues[$0]?.topicId } == filter }
        return m.topicId == filter
    }

    /// Los 2 últimos comentarios del historial.
    static func lastComments(_ events: [IssueEventDTO], limit: Int = 2) -> [IssueEventDTO] {
        Array(events.filter { $0.kind == "comment" }.suffix(limit))
    }

    static func commentBody(_ e: IssueEventDTO) -> String {
        if case .object(let o) = e.payload, case .string(let s)? = o["body"] { return s }
        return ""
    }

    enum Edge { case normal, overdue, done }
    static func edge(_ i: IssueDTO, now: Date = Date()) -> Edge {
        if i.status == .done { return .done }
        return IssueSort.flags(i, now: now).overdue ? .overdue : .normal
    }
}

struct IssueChatCard: View {
    @Environment(AppStore.self) private var store
    let issueId: String
    let creatorId: String
    let canPost: Bool
    /// Qué aviso la dibuja (tanda 1.7): creada, completada, vencida o comentarios.
    var kind: ChatCardKind? = nil
    /// «Comenta esta tarea…»: el compositor del chat pasa a comentar esta tarea.
    var onComment: ((IssueDTO) -> Void)? = nil
    @State private var missing = false

    var body: some View {
        Group {
            if let i = store.issues[issueId], let d = store.data {
                card(d, i)
            } else if !missing {
                // Del alto aproximado de la tarjeta: el chat no salta cuando llega la tarea.
                RoundedRectangle(cornerRadius: 14).fill(Theme.surface).frame(height: 140).overlay(ProgressView())
            }
        }
        .frame(maxWidth: 520, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
        // Detalle solo si hace falta: la tarea no está en memoria o tiene comentarios nuevos que mostrar.
        .task(id: store.issues[issueId]?.commentCount ?? -1) { await loadComments() }
    }

    private var comments: [IssueEventDTO] { store.taskCardComments[issueId]?.items ?? [] }

    private func loadComments(force: Bool = false) async {
        let count = store.issues[issueId]?.commentCount
        if count == 0 { if store.taskCardComments[issueId] != nil { store.taskCardComments[issueId] = nil }; return }
        if !force, let count, store.taskCardComments[issueId]?.count == count { return }
        do {
            let r = try await store.issueDetail(issueId)
            let next = TaskCardComments(count: r.issue.commentCount, items: TaskCard.lastComments(r.events))
            if store.taskCardComments[issueId] != next { store.taskCardComments[issueId] = next }
        } catch is CancellationError {
        } catch { if store.issues[issueId] == nil { missing = true } }
    }

    @ViewBuilder private func card(_ d: BootstrapDTO, _ i: IssueDTO) -> some View {
        let owner = i.ownerId.flatMap { Naming.person(d, $0) }
        // En los avisos nuevos (hecha, vencida, comentarios) el autor del mensaje no es quien creó la tarea.
        let creatorRef = kind.map { if case .issueCreated = $0 { return creatorId }; return i.createdBy } ?? creatorId
        let creator = Naming.person(d, creatorRef)?.name.split(separator: " ").first.map(String.init) ?? ""
        let f = IssueSort.flags(i)
        let edge: TaskCard.Edge = {
            if case .issueDone = kind { return .done }
            if case .issueOverdue = kind, !i.status.closed { return .overdue }
            return TaskCard.edge(i)
        }()
        let closed = i.status.closed
        let edgeColor: Color = switch edge { case .done: Theme.doneGreen; case .overdue: .red; case .normal: Theme.orange }
        let header: String = {
            switch kind {
            case .issueDone(_, let by): return "✅ " + L("card.doneBy", ["name": by.isEmpty ? creator : by])
            case .issueOverdue(_, let due): return "😢 " + L("card.overdue", ["date": due.map(IssueSort.shortDate) ?? IssueSort.dueLabel(i)])
            default: return "☑ " + L("task.card", ["name": creator]).uppercased(with: L10n.locale)
            }
        }()
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(header)
                    .font(.caption2.weight(.bold)).kerning(0.4)
                    .foregroundStyle(edge == .done && kind?.isDone == true ? Theme.doneGreen : edge == .overdue && kind?.isOverdue == true ? .red : Theme.textSecondary)
                    .lineLimit(2)
                    .accessibilityIdentifier("taskCard.header")
                Spacer(minLength: 4)
                IssueTopicTag(issue: i, canEdit: canPost)
            }
            HStack(alignment: .top, spacing: 6) {
                IssueCheck(issue: i, small: true).frame(width: 30, height: 30)
                Button { store.push(.issue(i.id)) } label: {
                    Text(i.title).font(.body.weight(.bold)).multilineTextAlignment(.leading)
                        .foregroundStyle(closed ? Theme.textSecondary : Theme.textPrimary)
                        .strikethrough(i.status == .done)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)
                .padding(.top, 4)
                .accessibilityIdentifier("taskCard.title.\(i.id)")
            }
            HStack(spacing: 10) {
                HStack(spacing: 5) {
                    if let owner {
                        Avatar(name: owner.name, org: nil, isAgent: owner.kind == "agent", size: 20, photo: owner.avatarUrl, fill: PersonColor.fill(owner.id))
                    }
                    Text(owner?.name ?? L("issue.noOwner")).font(.caption.weight(.semibold)).lineLimit(1)
                }
                Text("📅 " + (f.overdue ? L("issue.overdue") : f.dueToday ? L("issue.today") : IssueSort.dueLabel(i)))
                    .font(.caption.weight(f.overdue ? .semibold : .regular))
                    .foregroundStyle(f.overdue ? .red : Theme.textSecondary)
                    .lineLimit(1)
                StatusPill(status: i.status)
                if i.commentCount > 0 { Text("💬 \(i.commentCount)").font(.caption).foregroundStyle(Theme.textSecondary) }
            }
            .foregroundStyle(Theme.textPrimary)
            if case .issueOverdue = kind, !closed, canPost { OverdueActions(issue: i) }
            if case .issueComments(_, let info) = kind {
                CommentsStrip(info: info, onReply: canPost && !closed && onComment != nil ? { onComment?(i) } : nil)
            }
            if !comments.isEmpty, kind?.isComments != true {
                Divider()
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(comments) { e in
                        let who = e.actorId == d.me.id ? L("common.youShort") : (Naming.person(d, e.actorId)?.name.split(separator: " ").first.map(String.init) ?? "")
                        (Text(who).bold() + Text(" " + TaskCard.commentBody(e))).font(.footnote).foregroundStyle(Theme.textPrimary)
                    }
                    if i.commentCount > comments.count {
                        Button(L("task.cardAll", ["n": i.commentCount])) { store.push(.issue(i.id)) }
                            .font(.footnote.weight(.semibold)).buttonStyle(.borderless)
                    }
                }
            }
            // Comentar ahí mismo; no aparece si la tarea está cerrada.
            if canPost && !closed && onComment != nil && kind?.isComments != true {
                // Un campo de texto dentro de la LazyVStack del chat la dejaba reubicándose sin fin al abrir el teclado
                // (SwiftUI o UIKit): tocar aquí pasa el compositor del chat a «comentar esta tarea» (onComment).
                Button { onComment?(i) } label: {
                    HStack(spacing: 6) {
                        Text(L("task.cardComment")).font(.footnote).foregroundStyle(Theme.textSecondary.opacity(0.8))
                        Spacer(minLength: 4)
                        Text(L("issue.comment")).font(.footnote.weight(.semibold)).foregroundStyle(Theme.accentText)
                    }
                    .padding(.horizontal, 10).frame(height: 34)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Theme.background))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.textSecondary.opacity(0.25)))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("taskCard.comment.\(i.id)")
            }
        }
        .padding(.leading, 14).padding(.trailing, 12).padding(.vertical, 12)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.surface))
        .overlay(alignment: .leading) {
            UnevenRoundedRectangle(topLeadingRadius: 14, bottomLeadingRadius: 14).fill(edgeColor).frame(width: 4)
        }
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.textSecondary.opacity(0.15)))
        .opacity(i.status == .done ? 0.85 : 1)
        .contextMenu { IssueStatusMenu(issue: i) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("msg.taskCard.\(i.id)")
    }
}

/// Etiqueta del tema de una tarea con ✕ para quitarlo (PATCH /issues/:id {topicId: null}) y «Deshacer».
struct IssueTopicTag: View {
    @Environment(AppStore.self) private var store
    let issue: IssueDTO
    var canEdit: Bool

    var body: some View {
        if let tid = issue.topicId, let cid = issue.conversationId, let t = store.topics[cid]?.first(where: { $0.id == tid }) {
            HStack(spacing: 2) {
                TopicTag(topic: t)
                if canEdit {
                    Button { untag(tid) } label: {
                        Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.textSecondary)
                            .frame(width: 24, height: 24).contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(L("topic.none"))
                    .accessibilityIdentifier("taskCard.untag.\(issue.id)")
                }
            }
        }
    }

    private func untag(_ prev: String) {
        let id = issue.id
        Task {
            do {
                _ = try await store.updateIssue(id, ["topicId": NSNull()])
                store.show(L("topic.untaggedTask")) { [store] in
                    Task { do { _ = try await store.updateIssue(id, ["topicId": prev]) } catch { store.show(L10n.errorText(error)) } }
                }
            } catch { store.show(L10n.errorText(error)) }
        }
    }
}
