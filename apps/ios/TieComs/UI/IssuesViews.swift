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

    /// Responsable(s): optimista con vuelta atrás y aviso si el API lo rechaza. Vacío = «Sin responsable».
    /// A quién se le puede asignar: la gente del chat (en una restringida, solo quien la ve) y quienes ya la tienen.
    static func candidates(_ store: AppStore, _ d: BootstrapDTO, _ i: IssueDTO) -> [PersonDTO] {
        let chat = issueMembers(store, d, i.conversationId)
        let base: [PersonDTO] = i.visibility == .org ? chat.filter { $0.orgId == i.visibleOrgId }
            : i.visibility == .private ? chat.filter { i.viewerIds.contains($0.id) } : chat
        let extra = (i.viewerIds + i.assignedIds).filter { u in !base.contains { $0.id == u } }.compactMap { Naming.person(d, $0) }
        var seen = Set<String>()
        return (base + extra).filter { seen.insert($0.id).inserted && $0.kind == "human" }
            .sorted { a, b in a.id == d.me.id ? true : b.id == d.me.id ? false : a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending }
    }

    static func setAssignees(_ store: AppStore, _ i: IssueDTO, _ ids: [String]) {
        Haptics.tap()
        let sorted = ids.sorted()
        let patch: [String: Any] = sorted.isEmpty ? ["assigneeIds": [String](), "ownerId": NSNull()] : ["assigneeIds": sorted]
        store.editIssue(i.id, patch) { x in
            x.assigneeIds = sorted
            if sorted.isEmpty { x.ownerId = nil } else if !(x.ownerId.map(sorted.contains) ?? false) { x.ownerId = sorted.first }
        }
    }

    /// Fecha de vencimiento (yyyy-MM-dd) o nil para quitarla.
    static func setDue(_ store: AppStore, _ i: IssueDTO, _ iso: String?) {
        Haptics.tap()
        store.editIssue(i.id, ["dueDate": iso ?? NSNull()]) { $0.dueDate = iso }
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
            // 1.7.13: cambiar responsable y fecha sin abrir la tarea.
            Divider()
            if !issue.isPersonal, let d = store.data {
                Menu {
                    let current = Set(issue.assignedIds)
                    ForEach(IssueActions.candidates(store, d, issue)) { p in
                        Button { IssueActions.setAssignees(store, issue, [p.id]) } label: {
                            Label(p.id == d.me.id ? "\(p.name) \(L("common.you"))" : p.name, systemImage: current == [p.id] ? "checkmark" : "person")
                        }
                    }
                    if !current.isEmpty {
                        Divider()
                        Button(role: .destructive) { IssueActions.setAssignees(store, issue, []) } label: { Label(L("issue.noOwner"), systemImage: "person.slash") }
                    }
                } label: { Label(L("task.changeOwner"), systemImage: "person.crop.circle") }
                .accessibilityIdentifier("issue.menu.owner")
            }
            Menu {
                ForEach(IssueDates.shortcuts(), id: \.key) { sc in
                    Button { IssueActions.setDue(store, issue, sc.iso) } label: {
                        Label("\(L(sc.key)) · \(IssueSort.shortDate(sc.iso))", systemImage: issue.dueDate == sc.iso ? "checkmark" : "calendar")
                    }
                }
                if issue.dueDate != nil {
                    Divider()
                    Button(role: .destructive) { IssueActions.setDue(store, issue, nil) } label: { Label(L("task.removeDue"), systemImage: "calendar.badge.minus") }
                }
            } label: { Label(L("task.changeDue"), systemImage: "calendar") }
            .accessibilityIdentifier("issue.menu.due")
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
    @State private var assigneeIds: Set<String> = []
    @State private var due: String?
    @State private var pickDate = false
    @State private var busy = false
    /// 1.7.14: archivos elegidos antes de guardar; se suben cuando la tarea ya existe.
    @State private var files: [LocalAttachment] = []
    @State private var uploadProgress: Double?
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
                                Picker(L("issue.where"), selection: Binding(get: { target }, set: { conv = $0; ownerId = d.me.id; assigneeIds = [d.me.id] })) {
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
                            ForEach(members) { person in
                                Button { if assigneeIds.contains(person.id) { assigneeIds.remove(person.id) } else { assigneeIds.insert(person.id) } } label: { Label(person.name, systemImage: assigneeIds.contains(person.id) ? "checkmark.circle.fill" : "circle") }
                            }
                        } label: {
                            optLabel("person.2", assigneeIds.isEmpty ? L("issue.noOwner") : "\(assigneeIds.count) " + L("issue.owner"))
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
                        AttachButton(staged: $files, title: files.isEmpty ? L("taskFiles.attach") : L("taskFiles.attachN", ["n": files.count])) { store.show($0) }
                    }
                    .padding(.leading, 48)
                    if !files.isEmpty {
                        StagedAttachments(staged: $files, progress: [:]).padding(.leading, 48)
                    }
                    if pickDate {
                        DatePicker(L("issue.pickDate"), selection: Binding(get: { IssueDates.date(due) ?? Date() }, set: { due = IssueDates.iso($0) }),
                                   displayedComponents: .date)
                            .padding(.leading, 48)
                    }
                }
                if let p = uploadProgress {
                    ProgressView(value: p).tint(Theme.orange).padding(.leading, 48).accessibilityLabel(L("taskFiles.uploading"))
                        .accessibilityIdentifier("issue.quickUploading")
                }
            }
            .onAppear { if ownerId.isEmpty { ownerId = d.me.id; assigneeIds = [d.me.id] } }
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
        Task {
            do {
                let created = target == IssueTasks.personalKey
                    ? try await store.createPersonalIssue(title: text, dueDate: due)
                    : try await store.createIssue(conversationId: target, title: text, ownerId: assigneeIds.sorted().first, dueDate: due, originMessageId: nil, assigneeIds: assigneeIds.sorted())
                let pending = files
                title = ""; due = nil; pickDate = false; files = []
                if !pending.isEmpty {
                    uploadProgress = 0
                    do { try await store.attachToIssue(created.id, files: pending) { p in Task { @MainActor in uploadProgress = p } } }
                    catch { store.show(L("taskFiles.failedAfterCreate", ["error": L10n.errorText(error)])) }
                    uploadProgress = nil
                }
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
        case .mine: return list.filter { !$0.status.closed && $0.assignedIds.contains(me) }
        case .open: return list.filter { !$0.status.closed }
        case .closed: return list.filter { $0.status.closed }
        case .all: return list
        }
    }

    /// `date` (1.7.13, por defecto en la pestaña): Vencidas · Hoy · Esta semana · Más adelante · Sin fecha.
    enum GroupBy: String, CaseIterable { case date, group, person }
    static let groupByKey = "tc.issues.groupBy"

    struct Bucket: Identifiable, Equatable { var id: String; var issues: [IssueDTO] }

    /// Por grupo: la conversación (la de más asuntos primero). Por responsable: yo primero y «Sin responsable» al final.
    static func sections(_ list: [IssueDTO], by: GroupBy, me: String, groupKey: ((IssueDTO) -> String)? = nil, title: (String) -> String) -> [Bucket] {
        var order: [String] = []
        var map: [String: [IssueDTO]] = [:]
        for i in list {
            let keys = by == .person ? (i.assignedIds.isEmpty ? [noOwner] : i.assignedIds) : [groupKey?(i) ?? i.conversationId ?? IssueTasks.personalKey]
            for k in keys {
                if map[k] == nil { order.append(k) }
                map[k, default: []].append(i)
            }
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
    /// Pestaña «Todo» (1.7.3, variante 2 del mockup): arriba los atajos pequeños a Correo, WhatsApp, Archivos y Trazo;
    /// debajo, Tareas.
    var hub = false
    @State private var filter = IssueTree.Filter.mine
    @State private var preferenceScope: String?
    @State private var restoringPreferences = false
    @State private var groupByRaw = IssueTree.GroupBy.date.rawValue
    @State private var error: String?

    var body: some View {
        Group {
            if let d = store.data {
                let visible = Set(d.conversations.map(\.id))
                // Los restringidos pueden ser de un chat que no leo (me asignaron una tarea): el servidor ya filtró.
                // Los personales (sin chat) son míos: el servidor solo me los manda a mí.
                let scoped = store.issues.values.filter { store.canCacheIssue($0) && ($0.conversationId.map(visible.contains) ?? true || $0.isRestricted) }
                let list = IssueTree.filter(Array(scoped), filter, me: d.me.id)
                    .sorted(by: filter == .closed ? IssueSort.recentlyClosed : IssueSort.order)
                let groupBy = IssueTree.GroupBy(rawValue: groupByRaw) ?? .date
                // Por grupo, las tareas van debajo de su asunto (en la sección del asunto); por fecha y por responsable, sueltas.
                let shown = groupBy == .group ? IssueTasks.tops(list, store.issues) : list
                let sections: [IssueTree.Bucket] = switch groupBy {
                case .date: filter == .closed ? (list.isEmpty ? [] : [IssueTree.Bucket(id: "done.recent", issues: list)]) : IssueTree.dateSections(list)
                case .group, .person: IssueTree.sections(shown, by: groupBy, me: d.me.id, groupKey: { IssueTasks.groupConversation($0, store.issues) }) { sectionTitle(d, $0, groupBy) }
                }
                List {
                    if hub {
                        Section {
                            HubShortcuts()
                                .listRowInsets(EdgeInsets(top: 2, leading: 0, bottom: 2, trailing: 0))
                                .listRowBackground(Color.clear)
                        }
                    }
                    // 1.7.13: un solo control compacto (Mías · Abiertas · Hechas) y, a su lado, el orden en un menú pequeño.
                    Section {
                        HStack(spacing: 8) {
                            Picker(L("nav.issues"), selection: $filter) {
                                ForEach([IssueTree.Filter.mine, .open, .closed], id: \.self) { f in
                                    Text("\(label(f)) \(IssueTree.filter(Array(scoped), f, me: d.me.id).count)").tag(f)
                                }
                            }
                            .pickerStyle(.segmented)
                            .controlSize(.small)
                            .accessibilityIdentifier("issues.filter")
                            sortMenu(groupBy)
                        }
                        .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                        .listRowBackground(Color.clear)
                        if let error { Text(error).foregroundStyle(.red).font(.footnote) }
                    } header: {
                        if hub {
                            Text(L("nav.issues")).font(.title3.weight(.bold)).foregroundStyle(Theme.textPrimary).textCase(nil)
                                .accessibilityAddTraits(.isHeader)
                        }
                    }
                    if list.isEmpty {
                        Section { TasksEmptyState(filter: filter).listRowBackground(Color.clear) }
                    }
                    ForEach(sections) { s in
                        Section {
                            ForEach(s.issues) { i in
                                TaskListRow(issue: i, showWhere: groupBy != .group, showOwner: groupBy != .person) { store.push(.issue(i.id)) }
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
                .scrollDismissesKeyboard(.interactively)
                .refreshable { await load() }
                // «Añadir tarea» fijo abajo (no ocupa la primera pantalla); en Hechas no hace falta.
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if filter != .closed {
                        QuickAddIssue(conversationId: nil)
                            .padding(.horizontal, 8).padding(.vertical, 2)
                            .background(.bar)
                            .overlay(alignment: .top) { Divider() }
                    }
                }
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(L(hub ? "tab.hub" : "nav.issues"))
        .quickActions()
        .task(id: store.sessionStamp) {
            restoringPreferences = true
            preferenceScope = store.me.map { ScopedPreference.key(server: store.api.baseURL.absoluteString, account: $0.id, purpose: "issues") }
            if let key = preferenceScope {
                // «.groupBy2» (1.7.13): la preferencia vieja era «Por grupo» por defecto; ahora se arranca por fecha.
                groupByRaw = UserDefaults.standard.string(forKey: key + ".groupBy2") ?? IssueTree.GroupBy.date.rawValue
                filter = IssueTree.Filter(rawValue: UserDefaults.standard.string(forKey: key + ".filter") ?? "") ?? .mine
            }
            restoringPreferences = false
            await load()
        }
        .onChange(of: groupByRaw) { _, _ in savePreferences() }
        .onChange(of: filter) { _, _ in savePreferences() }
    }

    /// Ícono de orden: Por fecha (por defecto) · Por grupo · Por responsable.
    private func sortMenu(_ groupBy: IssueTree.GroupBy) -> some View {
        Menu {
            Picker(L("tasks.sort"), selection: $groupByRaw) {
                Label(L("tasks.byDate"), systemImage: "calendar").tag(IssueTree.GroupBy.date.rawValue)
                Label(L("issue.byGroup"), systemImage: "bubble.left.and.bubble.right").tag(IssueTree.GroupBy.group.rawValue)
                Label(L("issue.byPerson"), systemImage: "person.2").tag(IssueTree.GroupBy.person.rawValue)
            }
        } label: {
            Image(systemName: "arrow.up.arrow.down")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(groupBy == .date ? Theme.textSecondary : Theme.accentText)
                .frame(width: 34, height: 30)
                .background(Circle().fill(Theme.bubbleOther))
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .accessibilityLabel(L("tasks.sort"))
        .accessibilityValue(groupBy == .date ? L("tasks.byDate") : groupBy == .group ? L("issue.byGroup") : L("issue.byPerson"))
        .accessibilityIdentifier("issues.groupBy")
    }

    private func savePreferences() {
        guard !restoringPreferences, let key = preferenceScope else { return }
        UserDefaults.standard.set(groupByRaw, forKey: key + ".groupBy2")
        UserDefaults.standard.set(filter.rawValue, forKey: key + ".filter")
    }

    private func label(_ f: IssueTree.Filter) -> String {
        switch f {
        case .mine: return L("tasks.f.mine")
        case .open: return L("tasks.f.open")
        case .closed, .all: return L("tasks.f.done")
        }
    }

    private func sectionTitle(_ d: BootstrapDTO, _ k: String, _ by: IssueTree.GroupBy) -> String {
        if by == .date {
            if k == "done.recent" { return L("tasks.done.recent") }
            return L("tasks.due.\(k.replacingOccurrences(of: "due.", with: ""))")
        }
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
        if by == .date {
            // «Vencidas» en rojo; el resto, discreto. El número, pequeño y en gris.
            let overdue = s.id == IssueTree.bucketId(.overdue)
            HStack(spacing: 6) {
                Text(sectionTitle(d, s.id, by)).font(.subheadline.weight(.bold)).foregroundStyle(overdue ? Color.red : Theme.textPrimary)
                Text("\(s.issues.count)").font(.caption.weight(.semibold)).monospacedDigit().foregroundStyle(overdue ? Color.red.opacity(0.8) : Theme.textSecondary)
            }
            .textCase(nil)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("issues.section.\(s.id)")
        } else {
            groupedHeader(d, s, by)
        }
    }

    @ViewBuilder
    private func groupedHeader(_ d: BootstrapDTO, _ s: IssueTree.Bucket, _ by: IssueTree.GroupBy) -> some View {
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
    /// Columnas propias del grupo (migración 097); vacío si no tiene o el servidor es anterior.
    @State private var columns: [TaskColumnDTO] = []
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
        .task(id: store.issues[issueId]?.conversationId) {
            if let cid = store.issues[issueId]?.conversationId { columns = await store.taskColumns(cid) } else { columns = [] }
        }
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

    /// Optimista (store.editIssue): se ve al instante y vuelve atrás con aviso si el API lo rechaza.
    private func update(_ patch: [String: Any], apply: @escaping (inout IssueDTO) -> Void) {
        Haptics.tap()
        store.editIssue(issueId, patch, apply: apply)
    }

    private func commitTitle(_ i: IssueDTO) {
        let v = String(draftTitle.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
        if v.count >= 2 && v != i.title { update(["title": v]) { $0.title = v } } else { draftTitle = i.title }
    }

    @ViewBuilder
    private func detail(_ d: BootstrapDTO, _ i: IssueDTO) -> some View {
        let conv = i.conversationId.flatMap { store.meta($0) }
        let chatMembers = issueMembers(store, d, i.conversationId)
        // ¿Quién lo hace? en una tarea restringida: solo quienes la ven (y los agregados que no están en el chat).
        let extra = i.viewerIds.filter { u in !chatMembers.contains { $0.id == u } }.compactMap { Naming.person(d, $0) }
        let base: [PersonDTO] = i.visibility == .org ? chatMembers.filter { $0.orgId == i.visibleOrgId }
            : i.visibility == .private ? chatMembers.filter { i.viewerIds.contains($0.id) } : chatMembers
        let members = (base + extra + IssueActions.candidates(store, d, i)).reduce(into: [PersonDTO]()) { acc, p in if !acc.contains(where: { $0.id == p.id }) { acc.append(p) } }
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
                            chip(on: i.assignedIds.contains(p.id), id: "issue.who.\(p.id)", action: {
                                var ids = Set(i.assignedIds); if ids.contains(p.id) { ids.remove(p.id) } else { ids.insert(p.id) }
                                IssueActions.setAssignees(store, i, Array(ids))
                            }) {
                                HStack(spacing: 6) {
                                    Avatar(name: p.name, org: Naming.org(d, p.orgId), size: 22, photo: p.avatarUrl).accessibilityHidden(true)
                                    Text(p.id == d.me.id ? L("issue.me") : String(p.name.split(separator: " ").first ?? Substring(p.name)))
                                }
                            }
                        }
                        if i.ownerId != nil {
                            chip(on: false, ghost: true, id: "issue.who.none", action: { IssueActions.setAssignees(store, i, []) }) { Text(L("issue.noOwner")) }
                        }
                    }
                }

                }

                question(L("issue.qWhen"), detail: i.dueDate.map(IssueSort.shortDate)) {
                    ChipFlow(spacing: 8) {
                        ForEach(IssueDates.shortcuts(), id: \.key) { s in
                            chip(on: i.dueDate == s.iso, id: "issue.when.\(s.key)", action: { IssueActions.setDue(store, i, s.iso); pickDate = false }) { Text(L(s.key)) }
                        }
                        chip(on: pickDate, id: "issue.when.pick", action: { withAnimation { pickDate.toggle() } }) { Text("📅 " + L("issue.dPick")) }
                        if i.dueDate != nil {
                            chip(on: false, ghost: true, id: "issue.when.none", action: { IssueActions.setDue(store, i, nil); pickDate = false }) { Text(L("issue.noDue")) }
                        }
                    }
                    if pickDate {
                        DatePicker(L("issue.pickDate"), selection: Binding(get: { IssueDates.date(i.dueDate) ?? Date() },
                                                                           set: { IssueActions.setDue(store, i, IssueDates.iso($0)); pickDate = false }),
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
                                chip(on: i.status == st, id: "issue.how.\(st.rawValue)", action: { IssueActions.set(store, i, st) }) { Text(L("issue.how.\(st.rawValue)")) }
                            }
                        }
                        if i.status == .waiting && orgIds.count > 1 {
                            ChipFlow(spacing: 8) {
                                Text(L("issue.waitingOn") + ":").font(.footnote).foregroundStyle(Theme.textSecondary).frame(minHeight: 44)
                                ForEach(orgIds, id: \.self) { o in
                                    chip(on: i.waitingOnOrgId == o, id: "issue.waitingOn.\(o)",
                                         action: { let v = i.waitingOnOrgId == o ? nil : o; update(["waitingOnOrgId": v ?? NSNull()]) { $0.waitingOnOrgId = v } }) { Text(Naming.org(d, o)?.name ?? "") }
                                }
                            }
                        }
                    }
                }

                // Campos propios (columnas del grupo y los que llegaron por integraciones), editables aquí.
                let extraKeys = i.fields.keys.filter { k in !columns.contains { $0.name == k } }.sorted()
                if !columns.isEmpty || !extraKeys.isEmpty {
                    question(L("task.fields")) {
                        VStack(spacing: 0) {
                            ForEach(columns) { col in
                                TaskFieldRow(column: col, value: i.fields[col.name]) { v in setField(col.name, v) }
                                Divider()
                            }
                            ForEach(extraKeys, id: \.self) { k in
                                let v = i.fields[k]
                                let type = switch v { case .bool: "checkbox"; case .number: "number"; default: "text" }
                                TaskFieldRow(column: TaskColumnDTO(name: k, type: type), value: v) { nv in setField(k, nv) }
                                Divider()
                            }
                        }
                        .accessibilityIdentifier("issue.fields")
                    }
                }

                question(L("taskFiles.title") + (i.attachments.isEmpty ? "" : " · \(i.attachments.count)")) {
                    TaskFilesSection(issue: i)
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

    /// Un campo: valor nuevo o nil para borrarlo (PATCH /issues/:id {fields: {nombre: valor|null}}, se mezcla en el API).
    private func setField(_ name: String, _ v: IssueFieldValue?) {
        update(["fields": [name: v?.json ?? NSNull()]]) { x in if let v { x.fields[name] = v } else { x.fields.removeValue(forKey: name) } }
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

/// Atajos de la pestaña «Todo»: una fila pequeña y deslizable (ícono de color + nombre + no leídos si hay) que abre las
/// mismas pantallas que Tú › Archivos / WhatsApp / Correo / Trazo. Discreta: Tareas sigue siendo lo principal.
struct HubShortcuts: View {
    @Environment(AppStore.self) private var store
    /// Chats de WhatsApp con mensajes sin leer (la misma cuenta que el organizador de la pantalla de WhatsApp).
    @State private var waUnread = 0
    /// Correos sin leer (0 si el correo no está activo o la consulta falla: la pastilla va sin número).
    @State private var mailUnread = 0

    static let mailColor = Color(red: 0.23, green: 0.45, blue: 0.85)
    static let waColor = Color(red: 0.15, green: 0.64, blue: 0.35)
    static let filesColor = Color(red: 0.70, green: 0.48, blue: 0.07)
    static let traceColor = Color(red: 0.49, green: 0.29, blue: 0.76)

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                if store.mailEnabled {
                    pill(L("mail.title"), "envelope", Self.mailColor, mailUnread, id: "mail") { store.push(.mailBox(conversationId: nil)) }
                }
                pill(L("settings.whatsapp"), "message", Self.waColor, waUnread, id: "whatsapp") { store.push(.whatsapp) }
                pill(L("nav.files"), "folder", Self.filesColor, 0, id: "files") { store.push(.files) }
                pill(L("nav.trazo"), "arrow.triangle.branch", Self.traceColor, 0, id: "trazo") { store.push(.trazo) }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 2)
        }
        .scrollClipDisabled()
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L("hub.shortcuts"))
        .accessibilityIdentifier("hub.shortcuts")
        .task(id: store.waRevision) {
            waUnread = 0
            guard let r = try? await store.waChats(accountId: nil, category: nil, onlyGroups: false, showHidden: false, query: "") else { return }
            waUnread = r.categories.values.reduce(0) { $0 + $1.unread }
        }
        // Cada vez que se abre «Todo» (las pestañas se conservan montadas: se mira la pestaña elegida).
        .task(id: "\(store.mailEnabled)|\(store.tab == .issues)") {
            guard store.mailEnabled, store.tab == .issues else { if !store.mailEnabled { mailUnread = 0 }; return }
            mailUnread = (try? await store.mailUnread()) ?? 0
        }
    }

    private func pill(_ title: String, _ symbol: String, _ color: Color, _ n: Int, id: String, _ action: @escaping () -> Void) -> some View {
        Button {
            Haptics.tap()
            action()
        } label: {
            HStack(spacing: 5) {
                Image(systemName: symbol).font(.system(size: 12, weight: .semibold)).foregroundStyle(color)
                Text(title).font(.caption.weight(.semibold)).foregroundStyle(Theme.textSecondary)
                if n > 0 {
                    Text(n > 99 ? "99+" : "\(n)").font(.caption2.weight(.bold)).monospacedDigit().foregroundStyle(Theme.accentText)
                }
            }
            .lineLimit(1)
            .padding(.leading, 8).padding(.trailing, 10).padding(.vertical, 6)
            .background(Capsule().fill(Theme.surface))
            .overlay(Capsule().stroke(Theme.textSecondary.opacity(0.18), lineWidth: 0.5))
            .frame(minHeight: 44)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityValue(n > 0 ? L("a11y.unread", ["n": n]) : "")
        .accessibilityIdentifier("hub.\(id)")
    }
}
