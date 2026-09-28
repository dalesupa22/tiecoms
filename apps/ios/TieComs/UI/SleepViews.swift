import SwiftUI

/// «Todas las noches» dentro de «No molestar»: desde y hasta (22:00–07:00 por defecto) en la hora de este dispositivo.
struct SleepSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var on = true
    @State private var start = SleepRules.date("22:00")
    @State private var end = SleepRules.date("07:00")
    @State private var busy = false

    var body: some View {
        let tz = TimeZone.current.identifier
        let from = SleepRules.hhmm(start), to = SleepRules.hhmm(end)
        NavigationStack {
            Form {
                Section {
                    Text(L("sleep.explain")).font(.footnote).foregroundStyle(Theme.textSecondary)
                    Toggle(isOn: $on) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(L("sleep.switch"))
                            Text(on ? L("sleep.summary", ["from": SleepRules.hourLabel(from), "to": SleepRules.hourLabel(to)]) : L("sleep.off"))
                                .font(.footnote).foregroundStyle(Theme.textSecondary)
                        }
                    }
                    .tint(Theme.primaryFill)
                    .accessibilityIdentifier("sleep.switch")
                    if on {
                        DatePicker(L("sleep.from"), selection: $start, displayedComponents: .hourAndMinute)
                            .accessibilityIdentifier("sleep.from")
                        DatePicker(L("sleep.to"), selection: $end, displayedComponents: .hourAndMinute)
                            .accessibilityIdentifier("sleep.to")
                    }
                } footer: {
                    Text(L("sleep.tz", ["tz": tz]))
                }
            }
            .navigationTitle("🌙 " + L("sleep.title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("sched.save")) { save(from: from, to: to, tz: tz) }
                        .disabled(busy || (on && from == to))
                        .accessibilityIdentifier("sleep.save")
                }
            }
        }
        .onAppear {
            let cur = store.data?.me.sleep ?? SleepDTO()
            on = cur.on
            start = SleepRules.date(cur.start)
            end = SleepRules.date(cur.end)
        }
    }

    private func save(from: String, to: String, tz: String) {
        busy = true
        let cur = store.data?.me.sleep
        Task {
            do {
                // La zona del dispositivo solo se manda si cambió (y así sigue siendo automática).
                let tzChanged = cur?.tz != tz
                try await store.setSleep(on: on, start: from, end: to, tz: tzChanged ? tz : nil, tzAuto: tzChanged ? true : nil)
                store.show(on ? L("sleep.saved", ["from": SleepRules.hourLabel(from), "to": SleepRules.hourLabel(to)]) : L("sleep.savedOff"))
                dismiss()
            } catch { store.show(L10n.errorText(error)) }
            busy = false
        }
    }
}

/// Fila de Tú › «Todas las noches» (bajo «No molestar»).
struct SleepRow: View {
    @Environment(AppStore.self) private var store
    var body: some View {
        let s = store.data?.me.sleep
        Button { store.showSleepSettings = true } label: {
            HStack(spacing: 12) {
                Text("🌙").frame(width: 28).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(L("sleep.title")).foregroundStyle(Theme.textPrimary)
                    Text(SleepRules.summary(s)).font(.footnote)
                        .foregroundStyle(store.sleepActive ? Theme.accentText : Theme.textSecondary)
                        .accessibilityIdentifier("settings.sleep.state")
                }
                Spacer()
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.textSecondary).accessibilityHidden(true)
            }
        }
        .accessibilityIdentifier("settings.sleep")
    }
}

/// Aviso sobre el compositor si a quien escribo le toca descansar: le llega sin sonar. En un directo ofrece
/// «🕒 Enviar a las 7:00», que programa el mensaje para cuando despierte.
struct SleepNoticeBar: View {
    @Environment(AppStore.self) private var store
    let conversation: ConversationDTO
    let typing: Bool
    var onSchedule: (Date) -> Void

    var body: some View {
        let _ = store.clockTick
        if let d = store.data {
            let members = conversation.memberIds.compactMap { Naming.person(d, $0) }
            if let n = SleepRules.notice(me: d.me.id, members: members, typing: typing) {
                HStack(spacing: 8) {
                    Text("🌙").accessibilityHidden(true)
                    Text(n.text).font(.footnote).foregroundStyle(Theme.textPrimary).fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("sleep.notice.text")
                    Spacer(minLength: 4)
                    if let wake = n.wake {
                        Button("🕒 " + L("sleep.scheduleWake", ["time": Schedule.time(wake)])) { onSchedule(wake) }
                            .font(.footnote.weight(.semibold))
                            .buttonStyle(.bordered).tint(Theme.accentText)
                            .frame(minHeight: 44)
                            .accessibilityIdentifier("sleep.scheduleWake")
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 6)
                .background(Color.indigo.opacity(0.10))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("sleep.notice")
            }
        }
    }
}
