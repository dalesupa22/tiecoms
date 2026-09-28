import SwiftUI

/// Asuntos como tareas «a prueba de tontos» (mismas reglas que la web, Issues.tsx): se completan con un toque en el
/// círculo (con «Deshacer»), se crean escribiendo y Return, y el detalle pregunta ¿quién?, ¿para cuándo? y ¿cómo va?
/// con botones de un toque. Las fechas «vencido» y «hoy» van en hora LOCAL (en Colombia, de noche, UTC ya es mañana).

/// Señales de cuello de botella y orden por urgencia.
enum IssueSort {
    static let stallDays = 2

    static func flags(_ i: IssueDTO, now: Date = Date()) -> (stalledDays: Int, overdue: Bool, dueToday: Bool) {
        guard !i.status.closed else { return (0, false, false) }
        let since = ISODate.parse(i.statusSince) ?? now
        let days = Int(now.timeIntervalSince(since) / 86400)
        let today = IssueDates.iso(now)
        let overdue = i.dueDate.map { $0 < today } ?? false
        return (days >= stallDays ? days : 0, overdue, i.dueDate == today)
    }

    /// Lo más urgente arriba: vencidos, estancados, con fecha más cercana, en curso; luego el más nuevo.
    static func order(_ a: IssueDTO, _ b: IssueDTO) -> Bool { byUrgency(a, b, now: Date()) }

    static func byUrgency(_ a: IssueDTO, _ b: IssueDTO, now: Date) -> Bool {
        let fa = flags(a, now: now), fb = flags(b, now: now)
        if fa.overdue != fb.overdue { return fa.overdue }
        if fa.stalledDays != fb.stalledDays { return fa.stalledDays > fb.stalledDays }
        let da = a.dueDate ?? "9", db = b.dueDate ?? "9"
        if da != db { return da < db }
        let pa = a.status == .in_progress, pb = b.status == .in_progress
        if pa != pb { return pa }
        return a.createdAt > b.createdAt
    }

    /// Completados: el cerrado más reciente primero.
    static func recentlyClosed(_ a: IssueDTO, _ b: IssueDTO) -> Bool { (a.closedAt ?? "") > (b.closedAt ?? "") }

    static func dueLabel(_ i: IssueDTO) -> String {
        guard let d = IssueDates.date(i.dueDate) else { return L("issue.noDue") }
        return d.formatted(Date.FormatStyle().day().month(.abbreviated).locale(L10n.locale))
    }

    /// «vie, 3 oct»: la fecha elegida en el detalle.
    static func shortDate(_ iso: String) -> String {
        guard let d = IssueDates.date(iso) else { return iso }
        return d.formatted(Date.FormatStyle().weekday(.abbreviated).day().month(.abbreviated).locale(L10n.locale))
    }
}

/// Completar, reabrir o cambiar el estado sin abrir el asunto. Optimista (store.setIssueStatus) y con «Deshacer».
@MainActor
enum IssueActions {
    /// Un toque en el círculo: lo abierto se completa y lo cerrado (hecho o descartado) se reabre.
    static func toggled(_ status: IssueStatus) -> IssueStatus { status.closed ? .open : .done }

    static func toggleDone(_ store: AppStore, _ i: IssueDTO) {
        let prev = i.status, next = toggled(i.status), id = i.id
        Haptics.tap()
        Task {
            do {
                try await store.setIssueStatus(id, next)
                store.show(next == .done ? L("issue.completed") : L("issue.reopenedToast")) {
                    Task { do { try await store.setIssueStatus(id, prev) } catch { store.show(L10n.errorText(error)) } }
                }
            } catch { store.show(L10n.errorText(error)) }
        }
    }

    static func set(_ store: AppStore, _ i: IssueDTO, _ status: IssueStatus) {
        let id = i.id
        Haptics.tap()
        Task { do { try await store.setIssueStatus(id, status) } catch { store.show(L10n.errorText(error)) } }
    }

    /// «Descartar asunto» al pie del detalle: discreto y con «Deshacer».
    static func drop(_ store: AppStore, _ i: IssueDTO) {
        let prev = i.status, id = i.id
        Haptics.tap()
        Task {
            do {
                try await store.setIssueStatus(id, .cancelled)
                store.show(L("issue.droppedToast")) {
                    Task { do { try await store.setIssueStatus(id, prev) } catch { store.show(L10n.errorText(error)) } }
                }
            } catch { store.show(L10n.errorText(error)) }
        }
    }
}

struct StatusPill: View {
    let status: IssueStatus
    var body: some View {
        let color: Color = switch status {
        case .open: .blue
        case .in_progress: Theme.accentText
        case .waiting: .purple
        case .done: .green
        case .cancelled: .gray
        }
        Text(L("issue.st.\(status.rawValue)"))
            .font(.caption2.weight(.bold))
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(Capsule().fill(color.opacity(0.15)))
            .foregroundStyle(color)
    }
}

/// Verde de «hecho» con contraste suficiente sobre blanco y sobre el fondo oscuro.
extension Theme {
    static let doneGreen = Color(light: 0x1E7B3C, dark: 0x3DBE6A)
}

/// Círculo a la izquierda: completa o reabre con un toque (verde con ✓ al estar hecho). Botón para VoiceOver con la
/// etiqueta «Completar» o «Reabrir». `compact`: sub-filas del árbol de Grupos (círculo pequeño, el área táctil crece).
struct IssueCheck: View {
    @Environment(AppStore.self) private var store
    let issue: IssueDTO
    var compact = false
    /// Tareas bajo su asunto: círculo más pequeño (el área táctil sigue en 44 pt).
    var small = false

    var body: some View {
        let done = issue.status.closed
        let size: CGFloat = compact ? 16 : small ? 20 : 24
        Button { IssueActions.toggleDone(store, issue) } label: {
            ZStack {
                Circle()
                    .strokeBorder(done ? Theme.doneGreen : issue.status == .in_progress ? Theme.accentText : Theme.textSecondary.opacity(0.7),
                                  lineWidth: compact ? 1.5 : 2)
                    .background(Circle().fill(done ? Theme.doneGreen : .clear))
                if done {
                    Image(systemName: "checkmark").font(.system(size: size * 0.5, weight: .bold)).foregroundStyle(.white)
                }
            }
            .frame(width: size, height: size)
            .frame(width: compact ? 28 : 44, height: compact ? 22 : 44)
            .contentShape(Rectangle().inset(by: compact ? -11 : 0))
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(done ? L("issue.reopen") : L("issue.complete"))
        .accessibilityValue(issue.title)
        .accessibilityIdentifier("issue.check.\(issue.id)")
    }
}

/// Menú de pulsación larga de un asunto: Completar, Marcar en curso, Marcar en espera, Marcar abierto (o Reabrir si
/// ya se cerró) y Abrir. Completar y Reabrir llevan «Deshacer» en el aviso.
struct IssueStatusMenu: View {
    @Environment(AppStore.self) private var store
    @Environment(\.issueSheetHost) private var host
    let issue: IssueDTO
    var onOpen: (() -> Void)? = nil

    var body: some View {
        if issue.status.closed {
            Button { IssueActions.toggleDone(store, issue) } label: { Label(L("issue.reopen"), systemImage: "arrow.uturn.backward.circle") }
                .accessibilityIdentifier("issue.menu.reopen")
        } else {
            Button { IssueActions.toggleDone(store, issue) } label: { Label(L("issue.complete"), systemImage: "checkmark.circle") }
                .accessibilityIdentifier("issue.menu.complete")
            // Asunto principal: dividirlo en tareas o hablarlo aparte (docs/TAREAS.md).
            if issue.parentIssueId == nil && !issue.isPersonal {
                Button { present(.tasks(parentId: issue.id, conversationId: nil)) } label: {
                    Label(L("task.add").replacingOccurrences(of: "＋ ", with: ""), systemImage: "plus.circle")
                }
                .accessibilityIdentifier("issue.menu.addTask")
                if !issue.isRestricted {
                    Button { present(.side(issueId: issue.id)) } label: { Label(L("task.sidechat"), systemImage: "bubble.left.and.bubble.right") }
                        .accessibilityIdentifier("issue.menu.sidechat")
                }
                Divider()
            }
            if issue.status != .in_progress {
                Button { IssueActions.set(store, issue, .in_progress) } label: { Label(L("issue.markInProgress"), systemImage: "play.circle") }
                    .accessibilityIdentifier("issue.menu.inProgress")
            }
            if issue.status != .waiting {
                Button { IssueActions.set(store, issue, .waiting) } label: { Label(L("issue.markWaiting"), systemImage: "pause.circle") }
                    .accessibilityIdentifier("issue.menu.waiting")
            }
            if issue.status != .open {
                Button { IssueActions.set(store, issue, .open) } label: { Label(L("issue.markOpen"), systemImage: "circle") }
                    .accessibilityIdentifier("issue.menu.open")
            }
        }
        if let onOpen {
            Divider()
            Button(action: onOpen) { Label(L("issue.open"), systemImage: "arrow.up.forward.square") }
        }
    }

    /// La hoja se pide cuando el menú contextual ya se cerró (si no, UIKit descarta la presentación).
    private func present(_ s: IssueSheet) {
        let store = store, host = host
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { store.requestIssueSheet(s, host: host) }
    }
}

/// Fila de un asunto: círculo para completar, título (tachado si está hecho), responsable, fecha solo si hay y la
/// etiqueta de estado solo si está En curso, Esperando o Descartado. Tocar el resto de la fila abre el detalle.
struct IssueRow: View {
    @Environment(AppStore.self) private var store
    let issue: IssueDTO
    var showWhere = true
    var showOwner = true
    /// Tarea sangrada bajo su asunto («↳», casilla más pequeña).
    var child = false
    var onOpen: () -> Void

    var body: some View {
        if let d = store.data {
            let owner = Naming.person(d, issue.ownerId)
            let conv = issue.conversationId.flatMap { store.meta($0) }
            let f = IssueSort.flags(issue)
            let done = issue.status.closed
            let parent = issue.parentIssueId.flatMap { store.issues[$0] }
            // Una tarea en un sidechat se marca para que se sepa dónde se habla de ella.
            let inSide = parent.map { $0.conversationId != issue.conversationId } ?? false
            let progress = issue.parentIssueId == nil ? IssueTasks.progress(store.issues, of: issue.id) : nil
            // Personal: 🔒 y «Personal · solo tú» en vez del chat y del responsable (siempre soy yo).
            let lock = issue.isPersonal ? L("issue.personal") : issue.isRestricted ? IssueTasks.label(issue.visibility, orgName: Naming.org(d, issue.visibleOrgId)?.name) : nil
            let sub = [issue.isPersonal && showWhere ? L("issue.personal") : nil,
                       showOwner && !issue.isPersonal ? (owner?.name ?? L("issue.noOwner")) : nil,
                       !child ? parent.map { "↳ \($0.title)" } : nil,
                       !child && parent == nil && issue.parentIssueId != nil ? L("task.ofHidden") : nil,
                       showWhere && !child ? conv.map { L("issue.in", ["name": Naming.title(d, $0)]) } : nil,
                       inSide ? "💬 " + L("task.inSide") : nil,
                       issue.commentCount > 0 ? "💬 \(issue.commentCount)" : nil].compactMap { $0 }
            HStack(spacing: 4) {
                if child { Text("↳").font(.subheadline).foregroundStyle(Theme.textSecondary).padding(.leading, 12).accessibilityHidden(true) }
                IssueCheck(issue: issue, small: child)
                Button(action: onOpen) {
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            (Text(lock != nil ? "🔒 " : "") + Text(issue.title))
                                .font(child ? .subheadline.weight(.semibold) : .body.weight(.semibold))
                                .strikethrough(done)
                                .foregroundStyle(done ? Theme.textSecondary : Theme.textPrimary)
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                            if !sub.isEmpty {
                                Text(sub.joined(separator: " · ")).font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(1)
                            }
                            if f.stalledDays > 0 || issue.dueDate != nil || [.in_progress, .waiting, .cancelled].contains(issue.status) {
                                HStack(spacing: 6) {
                                    if f.stalledDays > 0 {
                                        Text("⏱ " + (f.stalledDays == 1 ? L("issue.stalledOne") : L("issue.stalled", ["n": f.stalledDays])))
                                            .font(.caption2.weight(.semibold)).foregroundStyle(.orange)
                                    }
                                    if issue.dueDate != nil {
                                        Text(f.overdue ? L("issue.overdue") : f.dueToday ? L("issue.today") : IssueSort.dueLabel(issue))
                                            .font(.caption2.weight(f.overdue ? .semibold : .regular))
                                            .foregroundStyle(f.overdue ? .red : Theme.textSecondary)
                                    }
                                    if [.in_progress, .waiting, .cancelled].contains(issue.status) { StatusPill(status: issue.status) }
                                }
                            }
                        }
                        Spacer(minLength: 4)
                        if let progress {
                            // «☑ 1/3», verde cuando están todas hechas.
                            let all = progress.done == progress.total
                            Text("☑ \(progress.done)/\(progress.total)")
                                .font(.caption.weight(.bold)).monospacedDigit()
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(Capsule().fill((all ? Theme.doneGreen : Theme.textSecondary).opacity(0.15)))
                                .foregroundStyle(all ? Theme.doneGreen : Theme.textSecondary)
                                .accessibilityLabel(L("task.progress", ["done": progress.done, "n": progress.total]))
                        }
                        if showOwner && owner != nil && !issue.isPersonal {
                            Avatar(name: owner?.name ?? "—", org: Naming.org(d, owner?.orgId), size: 24, photo: owner?.avatarUrl)
                                .accessibilityHidden(true)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(RowPressStyle())
                .accessibilityElement(children: .combine)
                .accessibilityHint(lock ?? "")
                .accessibilityIdentifier("issue.row.\(issue.id)")
                .accessibilityValue(issue.isPersonal ? L("issue.personal") : "")
            }
            .padding(.vertical, 2)
            .contextMenu { IssueStatusMenu(issue: issue, onOpen: onOpen) }
        }
    }
}

/// Personas humanas de una conversación (para responsable y «¿Quién lo hace?»).
@MainActor
func issueMembers(_ store: AppStore, _ d: BootstrapDTO, _ conversationId: String?) -> [PersonDTO] {
    // Un asunto personal no tiene chat: nadie más que yo.
    guard let conversationId else { return [d.me.id].compactMap { Naming.person(d, $0) } }
    return (store.meta(conversationId)?.memberIds ?? []).compactMap { Naming.person(d, $0) }.filter { $0.kind == "human" }
}

/// Alta rápida: se escribe y Return. Responsable (Yo por defecto) y fecha aparecen solo al escribir; el campo queda
/// listo para el siguiente, como una lista de tareas. Sin conversación (pestaña Asuntos) también se elige dónde.
struct QuickAddIssue: View {
    @Environment(AppStore.self) private var store
    var conversationId: String?
    @State private var conv = ""
    @State private var title = ""
    @State private var ownerId = ""
    @State private var due: String?
    @State private var pickDate = false
    @State private var busy = false
    @FocusState private var focused: Bool

    var body: some View {
        if let d = store.data {
            let destinations = conversationId == nil ? NewIssueSheet.destinations(d) : []
            // Sin chat (pestaña Asuntos) la primera opción es «🔒 Personal · solo tú».
            let target = conversationId ?? (conv.isEmpty ? IssueTasks.personalKey : conv)
            let personal = target == IssueTasks.personalKey
            let members = issueMembers(store, d, personal ? nil : target)
            let typing = !title.isEmpty
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 4) {
                    Image(systemName: "plus.circle").font(.title3).foregroundStyle(Theme.textSecondary)
                        .frame(width: 44, height: 44).accessibilityHidden(true)
                    TextField(L("issue.quickPhIos"), text: $title)
                        .focused($focused)
                        .submitLabel(.done)
                        .onSubmit { submit(d, target, members) }
                        .frame(minHeight: 44)
                        .accessibilityLabel(L("issue.title"))
                        .accessibilityIdentifier("issue.quickField")
                    if typing {
                        Button(L("issue.add")) { submit(d, target, members) }
                            .font(.subheadline.weight(.semibold))
                            .primaryProminent()
                            .disabled(busy || title.trimmingCharacters(in: .whitespaces).count < 2)
                            .accessibilityIdentifier("issue.quickAdd")
                    }
                }
                if typing {
                    ChipFlow(spacing: 8) {
                        if conversationId == nil {
                            Menu {
                                Picker(L("issue.where"), selection: Binding(get: { target }, set: { conv = $0; ownerId = d.me.id })) {
                                    Text("🔒 " + L("issue.personal")).tag(IssueTasks.personalKey)
                                    ForEach(destinations) { c in Text(NewIssueSheet.label(d, c)).tag(c.id) }
                                }
                            } label: {
                                optLabel(personal ? "lock" : "bubble.left.and.bubble.right",
                                         personal ? L("issue.personal") : store.meta(target).map { Naming.title(d, $0) } ?? L("issue.where"))
                            }
                            .accessibilityLabel(L("issue.where"))
                            .accessibilityValue(personal ? L("issue.personal") : store.meta(target).map { Naming.title(d, $0) } ?? "")
                            .accessibilityIdentifier("issue.quickWhere")
                        }
                        if !personal {
                        Menu {
                            Picker(L("issue.owner"), selection: $ownerId) {
                                ForEach(members) { p in Text(p.id == d.me.id ? L("issue.me") : p.name).tag(p.id) }
                            }
                        } label: {
                            let o = members.first { $0.id == ownerId } ?? members.first { $0.id == d.me.id }
                            optLabel("person", o.map { $0.id == d.me.id ? L("issue.me") : $0.name } ?? L("issue.me"))
                        }
                        .accessibilityLabel(L("issue.owner"))
                        .accessibilityIdentifier("issue.quickOwner")
                        }
                        Menu {
                            ForEach(IssueDates.shortcuts(), id: \.key) { s in Button(L(s.key)) { due = s.iso; pickDate = false } }
                            Button(L("issue.dPick")) { pickDate = true }
                            if due != nil { Button(L("issue.noDue"), role: .destructive) { due = nil; pickDate = false } }
                        } label: {
                            optLabel("calendar", due.map(IssueSort.shortDate) ?? L("issue.due"))
                        }
                        .accessibilityLabel(L("issue.due"))
                        .accessibilityIdentifier("issue.quickDue")
                    }
                    .padding(.leading, 48)
                    if pickDate {
                        DatePicker(L("issue.pickDate"), selection: Binding(get: { IssueDates.date(due) ?? Date() }, set: { due = IssueDates.iso($0) }),
                                   displayedComponents: .date)
                            .padding(.leading, 48)
                    }
                }
            }
            .onAppear { if ownerId.isEmpty { ownerId = d.me.id } }
        }
    }

    private func optLabel(_ icon: String, _ text: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon).font(.caption)
            Text(text).font(.subheadline).lineLimit(1)
            Image(systemName: "chevron.up.chevron.down").font(.caption2)
        }
        .foregroundStyle(Theme.textPrimary)
        .padding(.horizontal, 10)
        .frame(minHeight: 36)
        .background(Capsule().fill(Theme.bubbleOther))
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }

    private func submit(_ d: BootstrapDTO, _ target: String, _ members: [PersonDTO]) {
        let text = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count >= 2, !busy, !target.isEmpty else { focused = true; return }
        busy = true
        let owner = members.contains { $0.id == ownerId } ? ownerId : d.me.id
        Task {
            do {
                if target == IssueTasks.personalKey { _ = try await store.createPersonalIssue(title: text, dueDate: due) }
                else { _ = try await store.createIssue(conversationId: target, title: text, ownerId: owner, dueDate: due, originMessageId: nil) }
                title = ""; due = nil; pickDate = false
                Haptics.tap()
            } catch { store.show(L10n.errorText(error)) }
            busy = false
            focused = true
        }
    }
}

/// Asuntos de una conversación: alta rápida, activos por urgencia y «Completados · N» plegable (filas de una List).
struct ConversationIssuesList: View {
    @Environment(AppStore.self) private var store
    let conversationId: String
    let canCreate: Bool
    var onOpen: (String) -> Void
    @State private var showDone = false

    var body: some View {
        // Las tareas de un asunto de este chat van debajo de él (aunque vivan en un sidechat).
        let mine = IssueTasks.listed(in: conversationId, store.issues)
        let open = mine.filter { !$0.status.closed }.sorted(by: IssueSort.order)
        let done = mine.filter { $0.status.closed }.sorted(by: IssueSort.recentlyClosed)
        if canCreate {
            Section { QuickAddIssue(conversationId: conversationId) }
        }
        Section {
            if open.isEmpty { Text(L("issue.noIssues")).foregroundStyle(Theme.textSecondary) }
            ForEach(open) { i in
                IssueRow(issue: i, showWhere: false) { onOpen(i.id) }
                if i.parentIssueId == nil {
                    ForEach(IssueTasks.children(store.issues, of: i.id)) { k in IssueRow(issue: k, showWhere: false, child: true) { onOpen(k.id) } }
                }
            }
        }
        if !done.isEmpty {
            Section {
                Button { withAnimation(.easeInOut(duration: 0.2)) { showDone.toggle() } } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right").font(.caption.weight(.bold)).rotationEffect(.degrees(showDone ? 90 : 0))
                        Text(L("issue.doneCount", ["n": done.count])).font(.subheadline.weight(.semibold))
                        Spacer()
                    }
                    .foregroundStyle(Theme.textSecondary)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(.isHeader)
                .accessibilityHint(showDone ? L("home.collapse") : L("home.expand"))
                .accessibilityIdentifier("issues.doneToggle")
                if showDone {
                    ForEach(done) { i in IssueRow(issue: i, showWhere: false) { onOpen(i.id) } }
                }
            }
        }
    }
}

/// Asuntos agrupados por empresa → espacio → conversación (se conserva para la sección «Chats»; la pestaña usa las
/// secciones de la web: por grupo o por responsable).
enum IssueTree {
    struct Conv: Identifiable { var conv: ConversationDTO?; var id: String; var issues: [IssueDTO] }
    struct Ws: Identifiable { var ws: WorkspaceDTO?; var id: String; var convs: [Conv] }
    struct Company: Identifiable {
        var org: OrganizationDTO?; var id: String; var workspaces: [Ws]
        var isChats: Bool { id == IssueTree.chatsId }
    }
    static let chatsId = "__chats"
    static let noOwner = "__none"

    /// Míos · Abiertos · Completados (y `all` para las pruebas y la integración).
    enum Filter: String, CaseIterable { case mine, open, closed, all }

    static func filter(_ list: [IssueDTO], _ f: Filter, me: String) -> [IssueDTO] {
        switch f {
        case .mine: return list.filter { !$0.status.closed && $0.ownerId == me }
        case .open: return list.filter { !$0.status.closed }
        case .closed: return list.filter { $0.status.closed }
        case .all: return list
        }
    }

    enum GroupBy: String, CaseIterable { case group, person }
    static let groupByKey = "tc.issues.groupBy"

    struct Bucket: Identifiable, Equatable { var id: String; var issues: [IssueDTO] }

    /// Por grupo: la conversación (la de más asuntos primero). Por responsable: yo primero y «Sin responsable» al final.
    static func sections(_ list: [IssueDTO], by: GroupBy, me: String, groupKey: ((IssueDTO) -> String)? = nil, title: (String) -> String) -> [Bucket] {
        var order: [String] = []
        var map: [String: [IssueDTO]] = [:]
        for i in list {
            let k = by == .person ? (i.ownerId ?? noOwner) : (groupKey?(i) ?? i.conversationId ?? IssueTasks.personalKey)
            if map[k] == nil { order.append(k) }
            map[k, default: []].append(i)
        }
        let buckets = order.map { Bucket(id: $0, issues: map[$0] ?? []) }
        return buckets.sorted { a, b in
            // «Personal · solo tú» va primero en Por grupo.
            if by == .group, (a.id == IssueTasks.personalKey) != (b.id == IssueTasks.personalKey) { return a.id == IssueTasks.personalKey }
            if by == .person {
                if (a.id == me) != (b.id == me) { return a.id == me }
                if (a.id == noOwner) != (b.id == noOwner) { return b.id == noOwner }
            } else if a.issues.count != b.issues.count {
                return a.issues.count > b.issues.count
            }
            return title(a.id).localizedCaseInsensitiveCompare(title(b.id)) == .orderedAscending
        }
    }

    static func group(_ d: BootstrapDTO, _ issues: [IssueDTO]) -> [Company] {
        let visible = Set(d.conversations.map(\.id))
        var out: [String: Company] = [:]
        var order: [String] = []
        let inScope = issues.filter { $0.conversationId.map(visible.contains) ?? false }
        // Directos, multi y laterales (sin espacio): sección «Chats» después de las empresas.
        let chatItems = inScope.filter { $0.workspaceId == nil }
        let byWs = Dictionary(grouping: inScope.filter { $0.workspaceId != nil }, by: { $0.workspaceId ?? "" })
        for (wsId, items) in byWs {
            let ws = d.workspaces.first { $0.id == wsId }
            let org = ws.flatMap { Naming.counterpartOrg(d, $0) }
            let key = org?.id ?? "none"
            if out[key] == nil { order.append(key); out[key] = Company(org: org, id: key, workspaces: []) }
            let convs = Dictionary(grouping: items, by: { $0.conversationId ?? "" }).map { (cid: String, list: [IssueDTO]) -> Conv in
                Conv(conv: d.conversations.first { $0.id == cid }, id: cid, issues: list.sorted(by: IssueSort.order))
            }.sorted { a, b in
                (a.conv.map { Naming.title(d, $0) } ?? "").localizedCaseInsensitiveCompare(b.conv.map { Naming.title(d, $0) } ?? "") == .orderedAscending
            }
            out[key]!.workspaces.append(Ws(ws: ws, id: wsId, convs: convs))
        }
        var companies = order.compactMap { out[$0] }.map { var c = $0
            c.workspaces.sort { ($0.ws?.name ?? "").localizedCaseInsensitiveCompare($1.ws?.name ?? "") == .orderedAscending }
            return c
        }.sorted { ($0.org?.name ?? "~").localizedCaseInsensitiveCompare($1.org?.name ?? "~") == .orderedAscending }
        if !chatItems.isEmpty {
            let convs = Dictionary(grouping: chatItems, by: { $0.conversationId ?? "" }).map { (cid: String, list: [IssueDTO]) -> Conv in
                Conv(conv: d.conversations.first { $0.id == cid }, id: cid, issues: list.sorted(by: IssueSort.order))
            }.sorted { a, b in
                (a.conv.map(HomeOrder.activity) ?? "") > (b.conv.map(HomeOrder.activity) ?? "")
            }
            companies.append(Company(org: nil, id: chatsId, workspaces: [Ws(ws: nil, id: chatsId, convs: convs)]))
        }
        return companies
    }
}

struct IssuesScreen: View {
    @Environment(AppStore.self) private var store
    @State private var filter = IssueTree.Filter.mine
    @AppStorage(IssueTree.groupByKey) private var groupByRaw = IssueTree.GroupBy.group.rawValue
    @State private var error: String?

    var body: some View {
        Group {
            if let d = store.data {
                let visible = Set(d.conversations.map(\.id))
                // Los restringidos pueden ser de un chat que no leo (me asignaron una tarea): el servidor ya filtró.
                // Los personales (sin chat) son míos: el servidor solo me los manda a mí.
                let scoped = store.issues.values.filter { $0.conversationId.map(visible.contains) ?? true || $0.isRestricted }
                let list = IssueTree.filter(Array(scoped), filter, me: d.me.id)
                    .sorted(by: filter == .closed ? IssueSort.recentlyClosed : IssueSort.order)
                let groupBy = IssueTree.GroupBy(rawValue: groupByRaw) ?? .group
                // Por grupo, las tareas van debajo de su asunto (en la sección del asunto); por responsable, sueltas.
                let shown = groupBy == .group ? IssueTasks.tops(list, store.issues) : list
                let sections = IssueTree.sections(shown, by: groupBy, me: d.me.id, groupKey: { IssueTasks.groupConversation($0, store.issues) }) { sectionTitle(d, $0, groupBy) }
                List {
                    // 1.6.6: sin el párrafo explicativo (issue.pageSub); los filtros quedan pegados al título.
                    Section {
                        Picker(L("nav.issues"), selection: $filter) {
                            ForEach([IssueTree.Filter.mine, .open, .closed], id: \.self) { f in
                                Text("\(label(f)) \(IssueTree.filter(Array(scoped), f, me: d.me.id).count)").tag(f)
                            }
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("issues.filter")
                        Picker(L("issue.groupBy"), selection: $groupByRaw) {
                            Text(L("issue.byGroup")).tag(IssueTree.GroupBy.group.rawValue)
                            Text(L("issue.byPerson")).tag(IssueTree.GroupBy.person.rawValue)
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("issues.groupBy")
                        if let error { Text(error).foregroundStyle(.red).font(.footnote) }
                    }
                    if filter != .closed {
                        Section { QuickAddIssue(conversationId: nil) }
                    }
                    if list.isEmpty { Text(L("issue.empty")).foregroundStyle(Theme.textSecondary) }
                    ForEach(sections) { s in
                        Section {
                            ForEach(s.issues) { i in
                                IssueRow(issue: i, showWhere: groupBy == .person, showOwner: groupBy == .group) { store.push(.issue(i.id)) }
                                if groupBy == .group && i.parentIssueId == nil {
                                    ForEach(IssueTasks.children(store.issues, of: i.id)) { k in
                                        IssueRow(issue: k, showWhere: false, child: true) { store.push(.issue(k.id)) }
                                    }
                                }
                            }
                        } header: {
                            sectionHeader(d, s, groupBy)
                        }
                    }
                }
                .listStyle(.insetGrouped)
                .listSectionSpacing(.compact)
                .contentMargins(.top, 4, for: .scrollContent)
                .scrollContentBackground(.hidden)
                .refreshable { await load() }
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(L("nav.issues"))
        .quickActions()
        .task { await load() }
    }

    private func label(_ f: IssueTree.Filter) -> String {
        switch f {
        case .mine: return L("issue.mine")
        case .open: return L("issue.allOpen")
        case .closed, .all: return L("issue.closed")
        }
    }

    private func sectionTitle(_ d: BootstrapDTO, _ k: String, _ by: IssueTree.GroupBy) -> String {
        if by == .person {
            if k == IssueTree.noOwner { return L("issue.noOwner") }
            return (Naming.person(d, k)?.name ?? L("common.participant")) + (k == d.me.id ? " \(L("common.you"))" : "")
        }
        if k == IssueTasks.personalKey { return L("issue.personal") }
        guard let c = d.conversations.first(where: { $0.id == k }) else { return L("task.sharedWithMe") }
        let ws = c.workspaceId.flatMap { id in d.workspaces.first { $0.id == id } }
        return [ws?.name, Naming.title(d, c)].compactMap { $0 }.joined(separator: " · ")
    }

    @ViewBuilder
    private func sectionHeader(_ d: BootstrapDTO, _ s: IssueTree.Bucket, _ by: IssueTree.GroupBy) -> some View {
        let text = Text("\(s.id == IssueTasks.personalKey ? "🔒 " : "")\(sectionTitle(d, s.id, by)) · \(s.issues.count)")
            .font(.subheadline.weight(.bold)).foregroundStyle(Theme.textPrimary).textCase(nil)
        if by == .group, let conv = d.conversations.first(where: { $0.id == s.id }) {
            // Tocar la cabecera abre el grupo o chat.
            Button { store.push(.conversation(s.id)) } label: {
                HStack(spacing: 6) {
                    ConvIcon(d: d, c: conv, size: 20)
                    text.lineLimit(1)
                    Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(Theme.textSecondary)
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("issues.section.\(s.id)")
        } else {
            text.accessibilityAddTraits(.isHeader).accessibilityIdentifier("issues.section.\(s.id)")
        }
    }

    private func load() async {
        do { try await store.loadIssues(); error = nil } catch { self.error = L10n.errorText(error) }
    }
}

/// Detalle del asunto a prueba de tontos: título editable, un botón grande para terminar y tres preguntas con botones
/// de un toque (¿quién?, ¿para cuándo?, ¿cómo va?). Novedades con comentarios; al pie el origen, los cambios y
/// «Descartar asunto».
struct IssueDetailView: View {
    @Environment(AppStore.self) private var store
    let issueId: String
    @State private var events: [IssueEventDTO] = []
    @State private var comment = ""
    @State private var sending = false
    @State private var error: String?
    @State private var draftTitle = ""
    @State private var pickDate = false
    @State private var showHistory = false
    @FocusState private var editingTitle: Bool

    var body: some View {
        Group {
            if let d = store.data, let i = store.issues[issueId] {
                detail(d, i)
            } else if let error {
                ContentUnavailableView(error, systemImage: "exclamationmark.triangle")
            } else {
                ProgressView()
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(navTitle)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: store.issues[issueId]?.updatedAt) { await load() }
    }

    /// El título de la pantalla es el grupo o chat del asunto.
    private var navTitle: String {
        guard let d = store.data, let i = store.issues[issueId] else { return L("nav.issues") }
        if i.isPersonal { return L("issue.personal") }
        guard let cid = i.conversationId, let c = store.meta(cid) else { return L("nav.issues") }
        return Naming.title(d, c)
    }

    private func load() async {
        do { events = try await store.issueDetail(issueId).events; error = nil } catch { self.error = L10n.errorText(error) }
    }

    private func update(_ patch: [String: Any]) {
        Haptics.tap()
        Task { do { try await store.updateIssue(issueId, patch); error = nil } catch { self.error = L10n.errorText(error) } }
    }

    private func commitTitle(_ i: IssueDTO) {
        let v = draftTitle.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        if v.count >= 2 && v != i.title { update(["title": String(v.prefix(200))]) } else { draftTitle = i.title }
    }

    @ViewBuilder
    private func detail(_ d: BootstrapDTO, _ i: IssueDTO) -> some View {
        let conv = i.conversationId.flatMap { store.meta($0) }
        let chatMembers = issueMembers(store, d, i.conversationId)
        // ¿Quién lo hace? en una tarea restringida: solo quienes la ven (y los agregados que no están en el chat).
        let extra = i.viewerIds.filter { u in !chatMembers.contains { $0.id == u } }.compactMap { Naming.person(d, $0) }
        let base: [PersonDTO] = i.visibility == .org ? chatMembers.filter { $0.orgId == i.visibleOrgId }
            : i.visibility == .private ? chatMembers.filter { i.viewerIds.contains($0.id) } : chatMembers
        let members = (base + extra).reduce(into: [PersonDTO]()) { acc, p in if !acc.contains(where: { $0.id == p.id }) { acc.append(p) } }
        let parent = i.parentIssueId.flatMap { store.issues[$0] }
        let orgIds = chatMembers.compactMap(\.orgId).reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
        let f = IssueSort.flags(i)
        let done = i.status.closed
        let requester = Naming.person(d, i.requestedBy)
        let comments = events.filter { $0.kind == "comment" }
        let changes = events.filter { $0.kind != "comment" }
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                // Título editable (✎) y quién lo pidió.
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        TextField(L("issue.title"), text: $draftTitle, axis: .vertical)
                            .font(.title2.weight(.bold))
                            .strikethrough(done)
                            .foregroundStyle(done ? Theme.textSecondary : Theme.textPrimary)
                            .focused($editingTitle)
                            .submitLabel(.done)
                            .onChange(of: draftTitle) { _, v in
                                // Return guarda (en un campo de varias líneas llega como salto de línea).
                                if v.contains("\n") { draftTitle = v.replacingOccurrences(of: "\n", with: ""); editingTitle = false }
                            }
                            .onChange(of: editingTitle) { _, on in if !on { commitTitle(i) } }
                            .accessibilityLabel(L("issue.title"))
                            .accessibilityIdentifier("issue.titleEdit")
                        Image(systemName: "pencil").font(.body).foregroundStyle(Theme.textSecondary).accessibilityHidden(true)
                    }
                    if i.parentIssueId != nil {
                        if let parent {
                            Button { store.push(.issue(parent.id)) } label: {
                                Text("↑ " + L("task.partOf", ["title": parent.title])).font(.footnote.weight(.semibold))
                                    .frame(minHeight: 44, alignment: .leading)
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(Theme.accentText)
                            .accessibilityIdentifier("task.partOf")
                        } else {
                            Text(L("task.ofHidden")).font(.footnote).foregroundStyle(Theme.textSecondary)
                        }
                    }
                    (Text(i.isPersonal ? L("issue.personalHint") : requester.map { L("issue.requestedBy", ["name": $0.name]) } ?? L("issue.manual"))
                     + Text(i.isPersonal ? "" : i.isRestricted ? " · 🔒 " + IssueTasks.label(i.visibility, orgName: Naming.org(d, i.visibleOrgId)?.name) : "").bold())
                        .font(.footnote).foregroundStyle(Theme.textSecondary)
                        .accessibilityIdentifier("issue.requested")
                }

                if done {
                    doneBanner(i)
                } else {
                    if f.overdue || f.stalledDays > 0 || f.dueToday {
                        let parts = [f.overdue ? i.dueDate.map { L("issue.overdueSince", ["date": IssueSort.shortDate($0)]) } : nil,
                                     f.dueToday ? L("issue.today") : nil,
                                     f.stalledDays > 0 ? L("issue.stalledPlain", ["n": f.stalledDays]) : nil].compactMap { $0 }
                        Label(parts.joined(separator: " · "), systemImage: "timer")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(f.overdue ? Color.red : Color.orange)
                            .padding(12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: 12).fill((f.overdue ? Color.red : Color.orange).opacity(0.1)))
                            .accessibilityIdentifier("issue.alert")
                    }
                    Button { IssueActions.toggleDone(store, i) } label: {
                        Label(L("issue.markDone"), systemImage: "checkmark")
                            .font(.headline)
                            .frame(maxWidth: .infinity, minHeight: 52)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.doneGreen)
                    .foregroundStyle(.white)
                    .accessibilityIdentifier("issue.markDone")
                }

                // Personal: siempre eres tú; sin «¿Quién lo hace?», tareas ni sidechat.
                if !i.isPersonal {
                question(L("issue.qWho")) {
                    ChipFlow(spacing: 8) {
                        ForEach(members) { p in
                            chip(on: i.ownerId == p.id, id: "issue.who.\(p.id)", action: { update(["ownerId": p.id]) }) {
                                HStack(spacing: 6) {
                                    Avatar(name: p.name, org: Naming.org(d, p.orgId), size: 22, photo: p.avatarUrl).accessibilityHidden(true)
                                    Text(p.id == d.me.id ? L("issue.me") : String(p.name.split(separator: " ").first ?? Substring(p.name)))
                                }
                            }
                        }
                        if i.ownerId != nil {
                            chip(on: false, ghost: true, id: "issue.who.none", action: { update(["ownerId": NSNull()]) }) { Text(L("issue.noOwner")) }
                        }
                    }
                }

                }

                question(L("issue.qWhen"), detail: i.dueDate.map(IssueSort.shortDate)) {
                    ChipFlow(spacing: 8) {
                        ForEach(IssueDates.shortcuts(), id: \.key) { s in
                            chip(on: i.dueDate == s.iso, id: "issue.when.\(s.key)", action: { update(["dueDate": s.iso]); pickDate = false }) { Text(L(s.key)) }
                        }
                        chip(on: pickDate, id: "issue.when.pick", action: { withAnimation { pickDate.toggle() } }) { Text("📅 " + L("issue.dPick")) }
                        if i.dueDate != nil {
                            chip(on: false, ghost: true, id: "issue.when.none", action: { update(["dueDate": NSNull()]); pickDate = false }) { Text(L("issue.noDue")) }
                        }
                    }
                    if pickDate {
                        DatePicker(L("issue.pickDate"), selection: Binding(get: { IssueDates.date(i.dueDate) ?? Date() },
                                                                           set: { update(["dueDate": IssueDates.iso($0)]); pickDate = false }),
                                   displayedComponents: .date)
                            .datePickerStyle(.graphical)
                            .tint(Theme.accentText)
                            .accessibilityIdentifier("issue.datePicker")
                    }
                }

                if !done {
                    question(L("issue.qHow")) {
                        ChipFlow(spacing: 8) {
                            ForEach([IssueStatus.open, .in_progress, .waiting], id: \.self) { st in
                                chip(on: i.status == st, id: "issue.how.\(st.rawValue)", action: { update(["status": st.rawValue]) }) { Text(L("issue.how.\(st.rawValue)")) }
                            }
                        }
                        if i.status == .waiting && orgIds.count > 1 {
                            ChipFlow(spacing: 8) {
                                Text(L("issue.waitingOn") + ":").font(.footnote).foregroundStyle(Theme.textSecondary).frame(minHeight: 44)
                                ForEach(orgIds, id: \.self) { o in
                                    chip(on: i.waitingOnOrgId == o, id: "issue.waitingOn.\(o)",
                                         action: { update(["waitingOnOrgId": i.waitingOnOrgId == o ? NSNull() : o]) }) { Text(Naming.org(d, o)?.name ?? "") }
                                }
                            }
                        }
                    }
                }

                if i.parentIssueId == nil && !i.isPersonal {
                    TasksSection(parentId: i.id) { store.push(.issue($0)) }
                }
                if i.parentIssueId != nil && i.createdBy == d.me.id {
                    VisibilityChoice(issue: i)
                }

                question(L("issue.qNews") + (comments.isEmpty ? "" : " · \(comments.count)")) {
                    ForEach(comments) { e in commentRow(d, e) }
                    commentComposer
                }

                if let error { Text(error).foregroundStyle(.red).font(.footnote) }

                footer(d, i, conv, changes: changes, done: done)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 16)
            .frame(maxWidth: 700, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .onAppear { if !editingTitle { draftTitle = i.title } }
        .onChange(of: i.title) { _, t in if !editingTitle { draftTitle = t } }
    }

    private func doneBanner(_ i: IssueDTO) -> some View {
        let dropped = i.status == .cancelled
        let when = i.closedAt.flatMap(ISODate.parse).map { " · " + L10n.dateTime($0) } ?? ""
        return HStack(spacing: 10) {
            Text((dropped ? L("issue.droppedBanner") : L("issue.doneBanner")) + when)
                .font(.headline)
                .foregroundStyle(dropped ? Theme.textSecondary : Theme.doneGreen)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button { IssueActions.toggleDone(store, i) } label: {
                Label(L("issue.reopen"), systemImage: "arrow.uturn.backward").font(.subheadline.weight(.semibold)).frame(minHeight: 36)
            }
            .buttonStyle(.bordered)
            .tint(Theme.textPrimary)
            .accessibilityIdentifier("issue.reopenBtn")
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12).fill((dropped ? Theme.textSecondary : Theme.doneGreen).opacity(0.12)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("issue.doneBanner")
    }

    private func question<C: View>(_ title: String, detail: String? = nil, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            (Text(title).font(.subheadline.weight(.bold)) + Text(detail.map { " · \($0)" } ?? "").font(.subheadline.weight(.semibold)))
                .foregroundStyle(Theme.textPrimary)
                .accessibilityAddTraits(.isHeader)
            content()
        }
    }

    /// Botón de un toque (sin menús): marcado cuando es el valor actual.
    private func chip<Content: View>(on: Bool, ghost: Bool = false, id: String, action: @escaping () -> Void, @ViewBuilder label: () -> Content) -> some View {
        Button(action: action) {
            label()
                .font(.subheadline.weight(on ? .semibold : .regular))
                .foregroundStyle(on ? Theme.onPrimary : ghost ? Theme.textSecondary : Theme.textPrimary)
                .padding(.horizontal, 14)
                .frame(minHeight: 44)
                .background(Capsule().fill(on ? Theme.primaryFill : ghost ? Color.clear : Theme.bubbleOther))
                .overlay(Capsule().stroke(ghost ? Theme.textSecondary.opacity(0.35) : .clear, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier(id)
    }

    private func commentRow(_ d: BootstrapDTO, _ e: IssueEventDTO) -> some View {
        let who = Naming.person(d, e.actorId)
        return HStack(alignment: .top, spacing: 10) {
            Avatar(name: who?.name ?? "?", org: nil, isAgent: who?.kind == "agent", size: 28, photo: who?.avatarUrl, fill: PersonColor.fill(e.actorId))
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(who?.name ?? L("common.participant")).font(.subheadline.weight(.semibold)).foregroundStyle(PersonColor.text(e.actorId))
                    Text(L10n.dateTime(ISODate.parse(e.createdAt) ?? Date())).font(.caption).foregroundStyle(Theme.textSecondary)
                }
                Text(e.payload["body"]?.stringValue ?? "").font(.body).padding(.horizontal, 10).padding(.vertical, 7)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bubbleOther))
                    .textSelection(.enabled)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("issue.comment.\(e.id)")
    }

    /// Campo + «Enviar» a la derecha (se habilita con texto).
    private var commentComposer: some View {
        let body = comment.trimmingCharacters(in: .whitespacesAndNewlines)
        return HStack(alignment: .bottom, spacing: 8) {
            TextField(L("issue.commentPh"), text: $comment, axis: .vertical)
                .lineLimit(1...5)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .frame(minHeight: 44)
                .background(RoundedRectangle(cornerRadius: 20).fill(Theme.surface))
                .overlay(RoundedRectangle(cornerRadius: 20).stroke(Theme.textSecondary.opacity(0.25)))
                .accessibilityLabel(L("issue.commentPh"))
                .accessibilityIdentifier("issue.commentField")
            Button {
                sending = true
                Task {
                    do { try await store.commentIssue(issueId, body: body); comment = ""; error = nil; await load() }
                    catch { self.error = L10n.errorText(error) }
                    sending = false
                }
            } label: {
                if sending { ProgressView().frame(minWidth: 72, minHeight: 36) } else {
                    Text(L("issue.comment")).font(.subheadline.weight(.semibold)).frame(minWidth: 72, minHeight: 36)
                }
            }
            .primaryProminent()
            .disabled(body.isEmpty || sending)
            .accessibilityIdentifier("issue.commentSend")
        }
    }

    @ViewBuilder
    private func footer(_ d: BootstrapDTO, _ i: IssueDTO, _ conv: ConversationDTO?, changes: [IssueEventDTO], done: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Divider().padding(.bottom, 4)
            if i.originMessageId != nil {
                if let conv, let seq = i.originMessageSeq, seq > conv.historyFromSeq {
                    Button {
                        store.jumpTo[conv.id] = seq
                        store.push(.conversation(conv.id))
                    } label: {
                        Label(L("issue.origin"), systemImage: "arrow.up.forward").font(.subheadline.weight(.semibold)).frame(minHeight: 44)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.accentText)
                    .accessibilityIdentifier("issue.origin")
                } else {
                    Text(L("issue.originOut")).font(.footnote).foregroundStyle(Theme.textSecondary)
                }
            }
            if !changes.isEmpty {
                Button { withAnimation(.easeInOut(duration: 0.2)) { showHistory.toggle() } } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right").font(.caption.weight(.bold)).rotationEffect(.degrees(showHistory ? 90 : 0))
                        Text(L("issue.historyCount", ["n": changes.count])).font(.subheadline.weight(.semibold))
                    }
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.textSecondary)
                .accessibilityHint(showHistory ? L("home.collapse") : L("home.expand"))
                .accessibilityIdentifier("issue.historyToggle")
                if showHistory {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(changes) { e in
                            let who = Naming.person(d, e.actorId)
                            (Text(who?.name ?? L("common.participant")).bold() + Text(" \(eventText(d, e)) · \(L10n.dateTime(ISODate.parse(e.createdAt) ?? Date()))"))
                                .font(.footnote).foregroundStyle(Theme.textSecondary)
                                .accessibilityIdentifier("issue.event.\(e.id)")
                        }
                    }
                    .padding(.leading, 18)
                }
            }
            if !done {
                Button { IssueActions.drop(store, i) } label: {
                    Text(L("issue.drop")).font(.footnote).frame(minHeight: 44)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.textSecondary)
                .accessibilityIdentifier("issue.drop")
            }
        }
    }

    private func eventText(_ d: BootstrapDTO, _ e: IssueEventDTO) -> String {
        let to = e.payload["to"]?.stringValue
        switch e.kind {
        case "created": return L("issue.ev.created")
        case "status": return L("issue.ev.status", ["to": L("issue.st.\(to ?? "open")")])
        case "owner": return "\(L("issue.ev.owner")) → \(Naming.person(d, to)?.name ?? L("common.none"))"
        case "due": return L("issue.ev.due", ["to": IssueDates.date(to).map { $0.formatted(Date.FormatStyle().day().month(.abbreviated).locale(L10n.locale)) } ?? L("issue.noDue")])
        case "title": return "\(L("issue.ev.title")) → «\(to ?? "")»"
        case "waiting": return L("issue.ev.waiting") + (to.flatMap { Naming.org(d, $0)?.name }.map { ": \($0)" } ?? "")
        case "visibility": return "\(L("task.evVis")) → " + (to == "all" ? L("task.visAll") : to == "org" ? L("task.visOrgShort") : L("task.visPrivate"))
        default: return ""
        }
    }
}
