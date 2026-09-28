import SwiftUI

/// Programar envío (docs/PROGRAMADOS.md): 🕒 junto a enviar, mantener presionado ➤, la franja sobre el compositor,
/// la lista (Enviar ahora, Cambiar hora, Editar, Cancelar envío con Deshacer) y la pantalla «Programados».

/// Opciones del menú «Programar envío»: una por opción de un toque y «Elegir fecha y hora…».
struct ScheduleMenuItems: View {
    var title: String? = L("sched.menuTitle")
    var onPick: (Date) -> Void
    var onCustom: () -> Void

    var body: some View {
        Section(title ?? "") {
            ForEach(Schedule.options(), id: \.key) { o in
                Button { onPick(o.at) } label: {
                    Label("\(L(o.key)) · \(Schedule.whenLabel(o.at))", systemImage: "clock")
                }
                .accessibilityIdentifier("sched.opt.\(o.key)")
            }
        }
        Divider()
        Button(action: onCustom) { Label(L("sched.pick"), systemImage: "calendar") }
            .accessibilityIdentifier("sched.opt.pick")
    }
}

/// «¿Cuándo lo envío?»: día y hora; debe ser en el futuro.
struct PickWhenSheet: View {
    @Environment(\.dismiss) private var dismiss
    var initial: Date? = nil
    var onPick: (Date) -> Void
    @State private var when = Date()

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker(L("sched.date"), selection: $when, in: Date()..., displayedComponents: .date)
                        .datePickerStyle(.graphical)
                        .tint(Theme.accentText)
                    DatePicker(L("sched.time"), selection: $when, displayedComponents: .hourAndMinute)
                        .accessibilityIdentifier("sched.pickTime")
                } footer: {
                    Text(Schedule.isValidPick(when) ? L("sched.willSend", ["when": Schedule.whenLabel(when)]) : L("sched.future"))
                        .foregroundStyle(Schedule.isValidPick(when) ? Theme.textSecondary : .red)
                        .accessibilityIdentifier("sched.pickHint")
                }
            }
            .navigationTitle(L("sched.pickTitle"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("🕒 " + L("sched.confirm")) { onPick(when); dismiss() }
                        .disabled(!Schedule.isValidPick(when))
                        .accessibilityIdentifier("sched.pickConfirm")
                }
            }
        }
        .onAppear {
            let cal = Calendar.current
            let tomorrow8 = cal.date(bySettingHour: 8, minute: 0, second: 0, of: cal.date(byAdding: .day, value: 1, to: Date()) ?? Date()) ?? Date()
            when = initial.flatMap { $0 > Date() ? $0 : nil } ?? tomorrow8
        }
        .presentationDetents([.large])
    }
}

/// 🕒 junto a enviar (solo con texto): abre el menú de programar.
struct ScheduleButton: View {
    var onPick: (Date) -> Void
    var onCustom: () -> Void
    var body: some View {
        Menu { ScheduleMenuItems(onPick: onPick, onCustom: onCustom) } label: {
            Image(systemName: "clock").font(.title3.weight(.semibold)).foregroundStyle(Theme.accentText)
                .frame(width: 36, height: 40).contentShape(Rectangle())
        }
        .accessibilityLabel(L("sched.menuTitle"))
        .accessibilityIdentifier("composer.schedule")
    }
}

/// Un programado: cuándo sale (o «No se pudo enviar»), el texto y sus acciones.
struct ScheduledRow: View {
    @Environment(AppStore.self) private var store
    let s: ScheduledMessageDTO
    var showWhere: Bool
    @State private var editing = false
    @State private var body_ = ""
    @State private var picking = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(s.failed ? "⚠ " + L("sched.failed") : "🕒 " + Schedule.whenLabel(s.sendAt))
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(s.failed ? Color.red : Theme.textPrimary)
                if showWhere, let d = store.data, let c = store.meta(s.conversationId) {
                    Text("·").foregroundStyle(Theme.textSecondary)
                    Button(Naming.title(d, c)) { store.push(.conversation(c.id)) }
                        .font(.subheadline).buttonStyle(.borderless).lineLimit(1)
                }
            }
            if editing {
                TextField(L("sched.edit"), text: $body_, axis: .vertical)
                    .lineLimit(2...8)
                    .padding(10)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Theme.background))
                    .accessibilityIdentifier("sched.editField")
                HStack {
                    Spacer()
                    Button(L("common.cancel")) { editing = false; body_ = s.body }.buttonStyle(.borderless)
                    Button(L("sched.save")) {
                        let text = body_.trimmingCharacters(in: .whitespacesAndNewlines)
                        run { try await store.updateScheduled(s.id, body: text) } then: { editing = false }
                    }
                    .buttonStyle(.borderedProminent).tint(Theme.primaryFill)
                    .disabled(body_.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("sched.saveEdit")
                }
            } else {
                Text(s.body).font(.body).foregroundStyle(Theme.textPrimary).lineLimit(8)
            }
            if s.failed, let e = s.error { Text(e).font(.footnote).foregroundStyle(.red) }
            if !editing {
                ChipFlow(spacing: 8) {
                    Button { run(ok: L("sched.sentNow")) { try await store.sendScheduledNow(s.id) } } label: {
                        Label(L("sched.sendNow"), systemImage: "arrow.up.circle.fill").frame(minHeight: 36)
                    }
                    .buttonStyle(.borderedProminent).tint(Theme.primaryFill)
                    .accessibilityIdentifier("sched.sendNow.\(s.id)")
                    Menu {
                        ScheduleMenuItems(title: s.failed ? L("sched.retryLater") : L("sched.change"), onPick: move, onCustom: { picking = true })
                    } label: {
                        Label(s.failed ? L("sched.retryLater") : L("sched.change"), systemImage: "clock").frame(minHeight: 36)
                    }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("sched.change.\(s.id)")
                    Button { body_ = s.body; editing = true } label: { Label(L("sched.edit"), systemImage: "pencil").frame(minHeight: 36) }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("sched.edit.\(s.id)")
                    Button(L("sched.cancel"), role: .destructive) { cancel() }
                        .buttonStyle(.borderless)
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("sched.cancel.\(s.id)")
                }
                .font(.subheadline)
                .tint(Theme.accentText)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("sched.row.\(s.id)")
        .sheet(isPresented: $picking) { PickWhenSheet(initial: s.date, onPick: move) }
    }

    private func move(_ when: Date) {
        run(ok: L("sched.moved", ["when": Schedule.whenLabel(when)])) { try await store.updateScheduled(s.id, sendAt: when) }
    }

    /// Cancelar con «Deshacer»: se vuelve a programar el mismo texto (a la misma hora, o en 2 min si ya pasó).
    private func cancel() {
        let x = s
        Task {
            do {
                try await store.cancelScheduled(x.id)
                store.show(L("sched.cancelled")) {
                    let at = max(x.date ?? Date(), Date().addingTimeInterval(120))
                    Task { do { try await store.scheduleMessage(x.conversationId, body: x.body, sendAt: at, mentions: x.mentions, replyTo: x.replyTo) } catch { store.show(L10n.errorText(error)) } }
                }
            } catch { store.show(L10n.errorText(error)) }
        }
    }

    private func run(ok: String? = nil, _ f: @escaping () async throws -> Void, then: (() -> Void)? = nil) {
        Task {
            do { try await f(); then?(); if let ok { store.show(ok) } } catch { store.show(L10n.errorText(error)) }
        }
    }
}

/// Lista de programados (de un chat o de todos).
struct ScheduledListView: View {
    @Environment(AppStore.self) private var store
    var conversationId: String?
    var body: some View {
        let list = store.scheduled.filter { conversationId == nil || $0.conversationId == conversationId }
        List {
            if conversationId == nil {
                Text(L("sched.pageSub")).font(.footnote).foregroundStyle(Theme.textSecondary)
            }
            if list.isEmpty {
                Text(L("sched.empty")).foregroundStyle(Theme.textSecondary).accessibilityIdentifier("sched.empty")
            }
            ForEach(list) { s in ScheduledRow(s: s, showWhere: conversationId == nil) }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Theme.background.ignoresSafeArea())
        .refreshable { await store.loadScheduled() }
    }
}

/// Programados de este chat (desde la franja).
struct ScheduledSheet: View {
    @Environment(\.dismiss) private var dismiss
    let conversationId: String
    var body: some View {
        NavigationStack {
            ScheduledListView(conversationId: conversationId)
                .navigationTitle(L("sched.titleHere"))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L("common.close")) { dismiss() } } }
        }
        .sheetToasts()
    }
}

/// Tú › Programados.
struct ScheduledScreen: View {
    @Environment(AppStore.self) private var store
    var body: some View {
        ScheduledListView(conversationId: nil)
            .navigationTitle(L("nav.scheduled") + (store.scheduled.isEmpty ? "" : " · \(store.scheduled.count)"))
            .task { await store.loadScheduled() }
    }
}

/// Franja sobre el compositor: «🕒 2 mensajes programados · el próximo sale …» con «Ver» (naranja si alguno falló).
struct ScheduledStrip: View {
    @Environment(AppStore.self) private var store
    let conversationId: String
    var onOpen: () -> Void
    var body: some View {
        let list = store.scheduled(in: conversationId)
        if !list.isEmpty {
            let failed = list.contains(where: \.failed)
            Button(action: onOpen) {
                HStack(spacing: 8) {
                    Text(Schedule.stripText(list)).font(.footnote.weight(.semibold)).lineLimit(2).multilineTextAlignment(.leading)
                        .foregroundStyle(failed ? Color.white : Theme.textPrimary)
                    Spacer(minLength: 4)
                    Text(L("sched.see")).font(.footnote.weight(.bold)).foregroundStyle(failed ? Color.white : Theme.accentText)
                }
                .padding(.horizontal, 14).padding(.vertical, 8)
                .frame(minHeight: 44)
                .background(failed ? Theme.orange : Theme.orange.opacity(0.10))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("sched.strip")
        }
    }
}
