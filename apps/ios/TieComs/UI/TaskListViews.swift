import SwiftUI

// Pantalla de Tareas del móvil rehecha en 1.7.13 (Danny: «confusa»). Mismo API y mismo modelo; solo cambia la vista:
// un filtro compacto (Mías · Abiertas · Hechas), agrupado por fecha por defecto (Vencidas, Hoy, Esta semana,
// Más adelante, Sin fecha), «Por grupo» y «Por responsable» en un menú pequeño, filas limpias con UNA línea de
// metadatos y «Añadir tarea» fijo abajo.

extension IssueTree {
    /// Franjas por fecha de vencimiento (fecha LOCAL, como IssueSort.flags).
    enum DueBucket: String, CaseIterable { case overdue, today, week, later, none }

    /// «Esta semana» llega hasta el domingo (la semana empieza el lunes, como «La otra semana» de las fechas rápidas).
    static func dueBucket(_ i: IssueDTO, now: Date = Date(), calendar: Calendar = .current) -> DueBucket {
        guard let due = i.dueDate, !due.isEmpty else { return .none }
        let today = IssueDates.iso(now, timeZone: calendar.timeZone)
        if due < today { return .overdue }
        if due == today { return .today }
        let dow = calendar.component(.weekday, from: now) - 1 // 0 = domingo
        let toSunday = dow == 0 ? 0 : 7 - dow
        let sunday = IssueDates.iso(calendar.date(byAdding: .day, value: toSunday, to: now) ?? now, timeZone: calendar.timeZone)
        return due <= sunday ? .week : .later
    }

    static func bucketId(_ b: DueBucket) -> String { "due.\(b.rawValue)" }

    /// Secciones por fecha, en orden fijo y sin franjas vacías. Dentro: la fecha más cercana primero; a igual fecha,
    /// lo más urgente (IssueSort.byUrgency).
    static func dateSections(_ list: [IssueDTO], now: Date = Date(), calendar: Calendar = .current) -> [Bucket] {
        let grouped = Dictionary(grouping: list) { dueBucket($0, now: now, calendar: calendar) }
        return DueBucket.allCases.compactMap { b in
            guard let items = grouped[b], !items.isEmpty else { return nil }
            let sorted = items.sorted { x, y in
                let dx = x.dueDate ?? "9", dy = y.dueDate ?? "9"
                if dx != dy { return dx < dy }
                return IssueSort.byUrgency(x, y, now: now)
            }
            return Bucket(id: bucketId(b), issues: sorted)
        }
    }
}

extension IssueSort {
    /// Tono del chip de fecha de una fila.
    enum DueTone: Equatable { case overdue, today, normal }

    /// «Venció hace 3 días», «Venció ayer», «Vence hoy», «Mañana» o «vie, 10 oct». nil sin fecha.
    static func dueChip(_ i: IssueDTO, now: Date = Date(), calendar: Calendar = .current) -> (text: String, tone: DueTone)? {
        guard let due = i.dueDate, let date = IssueDates.date(due) else { return nil }
        if i.status.closed { return (shortDate(due), .normal) }
        let today = IssueDates.iso(now, timeZone: calendar.timeZone)
        if due == today { return (L("tasks.chip.today"), .today) }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day ?? 0
        if due < today {
            let late = max(1, -days)
            return (late == 1 ? L("tasks.chip.yesterday") : L("tasks.chip.overdueN", ["n": late]), .overdue)
        }
        if days == 1 { return (L("tasks.chip.tomorrow"), .normal) }
        return (shortDate(due), .normal)
    }

    /// «Sin movimiento 5 d»: solo si no está vencida y lleva 5 días o más sin cambiar (antes, «⏱ Stalled for X days»
    /// salía desde el día 2 en cada fila y era ruido).
    static let quietDays = 5
    static func quietLabel(_ i: IssueDTO, now: Date = Date()) -> String? {
        let f = flags(i, now: now)
        guard !f.overdue, f.stalledDays >= quietDays else { return nil }
        return L("tasks.quiet", ["n": f.stalledDays])
    }
}

/// Fila limpia de la pantalla de Tareas: círculo, título (2 líneas máx.) y una línea de metadatos — chip de fecha,
/// el grupo en gris y, si aplica, «Sin movimiento N d» —; a la derecha el responsable. Tocar abre el detalle de siempre.
struct TaskListRow: View {
    @Environment(AppStore.self) private var store
    let issue: IssueDTO
    var showWhere = true
    var showOwner = true
    var onOpen: () -> Void

    var body: some View {
        if let d = store.data {
            let done = issue.status.closed
            let owner = Naming.person(d, issue.ownerId)
            let chip = IssueSort.dueChip(issue)
            let quiet = done ? nil : IssueSort.quietLabel(issue)
            let progress = issue.parentIssueId == nil ? IssueTasks.progress(store.issues, of: issue.id) : nil
            let place = showWhere ? whereLabel(d) : nil
            let status: String? = [.in_progress, .waiting].contains(issue.status) ? L("issue.st.\(issue.status.rawValue)") : nil
            HStack(spacing: 2) {
                IssueCheck(issue: issue)
                Button(action: onOpen) {
                    HStack(alignment: .center, spacing: 8) {
                        VStack(alignment: .leading, spacing: 3) {
                            (Text(issue.isPersonal || issue.isRestricted ? "🔒 " : "") + Text(issue.title))
                                .font(.body)
                                .strikethrough(done)
                                .foregroundStyle(done ? Theme.textSecondary : Theme.textPrimary)
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                            if chip != nil || place != nil || quiet != nil || status != nil || progress != nil {
                                metaLine(chip: chip, place: place, status: status, quiet: quiet, progress: progress)
                            }
                        }
                        Spacer(minLength: 4)
                        if showOwner && !issue.isPersonal {
                            if let owner {
                                Avatar(name: owner.name, org: Naming.org(d, owner.orgId), size: 26, photo: owner.avatarUrl)
                                    .accessibilityLabel(owner.name)
                            } else {
                                Image(systemName: "person.crop.circle.badge.questionmark")
                                    .font(.system(size: 18)).foregroundStyle(Theme.textSecondary.opacity(0.55))
                                    .accessibilityLabel(L("issue.noOwner"))
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(RowPressStyle())
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("issue.row.\(issue.id)")
                .accessibilityValue(issue.isPersonal ? L("issue.personal") : "")
            }
            .padding(.vertical, 1)
            .contextMenu { IssueStatusMenu(issue: issue, onOpen: onOpen) }
            // Deslizar: → completar (o reabrir); ← pasar para mañana.
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                Button { IssueActions.toggleDone(store, issue) } label: {
                    Label(done ? L("issue.reopen") : L("issue.complete"), systemImage: done ? "arrow.uturn.backward" : "checkmark")
                }
                .tint(done ? .gray : Theme.doneGreen)
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                if !done, let tomorrow = IssueDates.shortcuts().first(where: { $0.key == "issue.dTomorrow" })?.iso, issue.dueDate != tomorrow {
                    Button { IssueActions.setDue(store, issue, tomorrow) } label: { Label(L("task.toTomorrow"), systemImage: "calendar.badge.clock") }
                        .tint(.orange)
                }
            }
        }
    }

    /// Una sola línea: lo que no cabe se corta al final (el chip de fecha va primero porque es lo que más importa).
    private func metaLine(chip: (text: String, tone: IssueSort.DueTone)?, place: String?, status: String?, quiet: String?,
                          progress: (done: Int, total: Int)?) -> some View {
        HStack(spacing: 6) {
            if let chip {
                let color: Color = chip.tone == .overdue ? .red : chip.tone == .today ? Theme.accentText : Theme.textSecondary
                Text(chip.text)
                    .font(.caption.weight(chip.tone == .normal ? .regular : .semibold))
                    .foregroundStyle(color)
                    .padding(.horizontal, chip.tone == .normal ? 0 : 6).padding(.vertical, chip.tone == .normal ? 0 : 1)
                    .background(Capsule().fill(chip.tone == .normal ? Color.clear : color.opacity(0.12)))
                    .fixedSize()
                    .accessibilityIdentifier("issue.due.\(issue.id)")
            }
            if let progress {
                Text("☑ \(progress.done)/\(progress.total)").font(.caption).monospacedDigit()
                    .foregroundStyle(progress.done == progress.total ? Theme.doneGreen : Theme.textSecondary)
                    .fixedSize()
                    .accessibilityLabel(L("task.progress", ["done": progress.done, "n": progress.total]))
            }
            if let status { Text(status).font(.caption.weight(.medium)).foregroundStyle(Theme.accentText).fixedSize() }
            if let place { Text(place).font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(1).truncationMode(.tail) }
            if let quiet {
                HStack(spacing: 3) {
                    Circle().fill(Color.orange.opacity(0.8)).frame(width: 5, height: 5).accessibilityHidden(true)
                    Text(quiet).font(.caption2).foregroundStyle(Theme.textSecondary)
                }
                .fixedSize()
            }
        }
        .lineLimit(1)
    }

    private func whereLabel(_ d: BootstrapDTO) -> String? {
        if issue.isPersonal { return L("tasks.personal") }
        let key = IssueTasks.groupConversation(issue, store.issues)
        guard let c = d.conversations.first(where: { $0.id == key }) ?? issue.conversationId.flatMap({ id in d.conversations.first { $0.id == id } })
        else { return issue.conversationId == nil ? nil : L("task.sharedWithMe") }
        return Naming.title(d, c)
    }
}

/// Estado vacío amable según el filtro.
struct TasksEmptyState: View {
    let filter: IssueTree.Filter
    var combined = false
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: filter == .closed ? "checkmark.circle" : "sun.max")
                .font(.system(size: 40, weight: .light)).foregroundStyle(Theme.accentText.opacity(0.8))
                .accessibilityHidden(true)
            Text(L(combined ? "tasks.filter.empty" : filter == .mine ? "tasks.empty.mine" : filter == .closed ? "tasks.empty.done" : "tasks.empty.open"))
                .font(.headline).foregroundStyle(Theme.textPrimary).multilineTextAlignment(.center)
            Text(L(combined ? "tasks.filter.emptyHint" : filter == .closed ? "tasks.empty.doneHint" : "tasks.empty.hint"))
                .font(.subheadline).foregroundStyle(Theme.textSecondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 36).padding(.horizontal, 24)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("issues.empty")
    }
}

/// Un campo propio de la tarea en el detalle: texto, número, sí/no o lista. Guarda al terminar de escribir
/// (Return o al salir del campo); vacío = borrar el campo.
struct TaskFieldRow: View {
    let column: TaskColumnDTO
    let value: IssueFieldValue?
    var onSave: (IssueFieldValue?) -> Void
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 10) {
            Text(column.name).font(.subheadline).foregroundStyle(Theme.textSecondary).lineLimit(2)
                .frame(maxWidth: 140, alignment: .leading)
            Spacer(minLength: 4)
            editor
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("issue.field.\(column.name)")
        .onAppear { draft = value?.display ?? "" }
        .onChange(of: value) { _, v in if !focused { draft = v?.display ?? "" } }
    }

    @ViewBuilder private var editor: some View {
        switch column.type {
        case "checkbox":
            Toggle(column.name, isOn: Binding(get: { if case .bool(true) = value { return true }; return false },
                                              set: { onSave(.bool($0)) }))
                .labelsHidden()
        case "select":
            Menu {
                ForEach(column.options, id: \.self) { o in
                    Button { onSave(.text(o)) } label: { if value?.display == o { Label(o, systemImage: "checkmark") } else { Text(o) } }
                }
                if value != nil { Divider(); Button(role: .destructive) { onSave(nil) } label: { Text(L("task.fieldEmpty")) } }
            } label: {
                HStack(spacing: 4) {
                    Text(value?.display ?? L("task.fieldEmpty")).foregroundStyle(value == nil ? Theme.textSecondary : Theme.textPrimary)
                    Image(systemName: "chevron.up.chevron.down").font(.caption2).foregroundStyle(Theme.textSecondary)
                }
                .font(.subheadline)
            }
        default:
            TextField(L("task.fieldEmpty"), text: $draft)
                .font(.subheadline)
                .multilineTextAlignment(.trailing)
                .keyboardType(column.type == "number" ? .decimalPad : .default)
                .focused($focused)
                .submitLabel(.done)
                .onSubmit(commit)
                .onChange(of: focused) { _, on in if !on { commit() } }
        }
    }

    private func commit() {
        let t = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let next: IssueFieldValue?
        if t.isEmpty { next = nil }
        else if column.type == "number" {
            guard let n = Double(t.replacingOccurrences(of: ",", with: ".")) else { draft = value?.display ?? ""; return }
            next = .number(n)
        } else { next = .text(String(t.prefix(500))) }
        if next != value { onSave(next) }
    }
}

/// «Archivos» en el detalle de una tarea (1.7.14): lo que tiene (vista previa y abrir, con compartir en el visor) y
/// «📎 Adjuntar» (fotos, cámara, archivos). Sube en cuanto se eligen, con progreso; un error se queda a la vista.
struct TaskFilesSection: View {
    @Environment(AppStore.self) private var store
    let issue: IssueDTO
    @State private var picked: [LocalAttachment] = []
    @State private var progress: Double?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if issue.attachments.isEmpty && progress == nil {
                Text(L("taskFiles.empty")).font(.footnote).foregroundStyle(Theme.textSecondary)
            }
            if !issue.attachments.isEmpty {
                AttachmentsBlock(attachments: issue.attachments, mine: false, conversationId: issue.conversationId, shareOnly: true)
                    .accessibilityIdentifier("taskFiles.list")
            }
            if let progress {
                HStack(spacing: 8) {
                    ProgressView(value: progress).tint(Theme.orange)
                    Text("\(Int(progress * 100)) %").font(.caption).monospacedDigit().foregroundStyle(Theme.textSecondary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(L("taskFiles.uploading"))
                .accessibilityIdentifier("taskFiles.progress")
            }
            if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(.red)
                    .accessibilityIdentifier("taskFiles.error")
            }
            if issue.attachments.count < TaskAttachmentRules.maxPerTask {
                AttachButton(staged: $picked, otherStagedCount: 0, title: L("taskFiles.attach")) { error = $0 }
                    .disabled(progress != nil)
            }
        }
        .onChange(of: picked) { _, files in
            guard !files.isEmpty else { return }
            picked = []
            upload(files)
        }
    }

    private func upload(_ files: [LocalAttachment]) {
        error = nil
        progress = 0
        let id = issue.id
        Task {
            do { try await store.attachToIssue(id, files: files) { p in Task { @MainActor in progress = p } } }
            catch { self.error = L10n.errorText(error) }
            progress = nil
        }
    }
}
