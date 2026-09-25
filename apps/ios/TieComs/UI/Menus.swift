import SwiftUI
import UIKit

/// Enlace público de una conversación (solo abre para quien tiene acceso).
func conversationLink(_ id: String) -> String { "https://app.tiecoms.com/c/\(id)" }

/// Menú de conversación (clic derecho de la web = pulsación larga / botón ⋯).
struct ConversationMenuItems: View {
    @Environment(AppStore.self) private var store
    let conv: ConversationDTO
    var onRemindCustom: (() -> Void)?
    var onMeeting: (() -> Void)?

    var body: some View {
        let pinned = conv.pinnedAt != nil
        Button { run { try await store.setConversationPrefs(conv.id, pinned: !pinned) } } label: {
            Label(pinned ? L("menu.unpinTop") : L("menu.pinTop"), systemImage: pinned ? "pin.slash" : "pin")
        }
        if conv.unread > 0 {
            Button { run { try await store.markConversationRead(conv.id) } } label: { Label(L("menu.markRead"), systemImage: "checkmark.circle") }
        } else {
            Button { run(toast: L("toast.markedUnread")) { try await store.markUnread(conv.id, seq: conv.lastMessageSeq) } } label: {
                Label(L("menu.markUnreadConv"), systemImage: "circle.fill")
            }
            .disabled(conv.lastMessageSeq <= conv.historyFromSeq)
        }
        MuteMenu(conv: conv)
        RemindMenu(conversationId: conv.id, message: nil, onCustom: onRemindCustom)
        if let onMeeting {
            Button(action: onMeeting) { Label(L("menu.meeting"), systemImage: "calendar.badge.plus") }
        }
        Divider()
        Button {
            UIPasteboard.general.string = conversationLink(conv.id)
            store.show(L("toast.linkCopied"))
        } label: { Label(L("menu.copyLink"), systemImage: "link") }
    }

    private func run(toast: String? = nil, _ f: @escaping () async throws -> Void) {
        Task {
            do { try await f(); if let toast { store.show(toast) } } catch { store.show(L10n.errorText(error)) }
        }
    }
}

struct MuteMenu: View {
    @Environment(AppStore.self) private var store
    let conv: ConversationDTO
    var body: some View {
        if conv.isMuted {
            Button {
                Task {
                    do { try await store.setConversationPrefs(conv.id, mutedUntil: .some(nil)); store.show(L("toast.unmuted")) }
                    catch { store.show(L10n.errorText(error)) }
                }
            } label: { Label(L("menu.unmute"), systemImage: "bell") }
        } else {
            Menu {
                ForEach(MuteOption.allCases, id: \.self) { o in
                    Button(L(o.labelKey)) {
                        Task {
                            do { try await store.setConversationPrefs(conv.id, mutedUntil: .some(AppStore.muteUntil(o))); store.show(L("toast.muted")) }
                            catch { store.show(L10n.errorText(error)) }
                        }
                    }
                }
            } label: { Label(L("menu.mute"), systemImage: "bell.slash") }
        }
    }
}

struct RemindMenu: View {
    @Environment(AppStore.self) private var store
    let conversationId: String
    let message: MessageDTO?
    var onCustom: (() -> Void)?
    var body: some View {
        Menu {
            ForEach(QuickTimes.list()) { q in
                Button("\(L(q.labelKey)) · \(L10n.dateTime(q.date))") { remind(q.date) }
            }
            if let onCustom {
                Divider()
                Button(L("when.custom"), action: onCustom)
            }
        } label: { Label(L("menu.remind"), systemImage: "alarm") }
    }

    private func remind(_ date: Date) {
        Task {
            do {
                try await store.createReminder(conversationId: conversationId, messageId: message?.id,
                                               note: message.map { String($0.body.prefix(120)) }, at: date)
                store.show(L("toast.reminderSet", ["when": L10n.dateTime(date)]))
            } catch { store.show(L10n.errorText(error)) }
        }
    }
}

/// Recordatorio con fecha y hora a elección.
struct ReminderSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let conversationId: String
    let message: MessageDTO?
    @State private var when = Date().addingTimeInterval(3600)
    @State private var note = ""
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                if let d = store.data, let c = store.meta(conversationId) {
                    Text(L("rem.about", ["name": Naming.title(d, c)])).font(.footnote).foregroundStyle(Theme.textSecondary)
                }
                DatePicker(L("rem.when"), selection: $when, in: Date()...)
                TextField(L("rem.note"), text: $note, axis: .vertical).lineLimit(1...4)
            }
            .navigationTitle(L("rem.custom"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("rem.save")) {
                        busy = true
                        Task {
                            do {
                                try await store.createReminder(conversationId: conversationId, messageId: message?.id, note: note.isEmpty ? nil : note, at: when)
                                store.show(L("toast.reminderSet", ["when": L10n.dateTime(when)]))
                                dismiss()
                            } catch { store.show(L10n.errorText(error)) }
                            busy = false
                        }
                    }.disabled(busy)
                }
            }
            .onAppear { if let m = message { note = String(m.body.prefix(120)) } }
        }
        .presentationDetents([.medium, .large])
    }
}
