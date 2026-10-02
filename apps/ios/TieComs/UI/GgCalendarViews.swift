import SwiftUI

struct GgCalendarSlots: Decodable, Sendable {
    struct Slot: Decodable, Identifiable, Equatable, Sendable {
        let startsAt: String
        let endsAt: String
        var id: String { startsAt + "|" + endsAt }
    }
    let status: String
    let provider: String?
    let checkedAt: String?
    let timezone: String?
    let slots: [Slot]
}

/// Provider availability is checked on demand. Creating a meeting always requires a second explicit action.
struct GgCalendarSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let source: String
    let messageIds: [String]
    let suggestedTitle: String
    @State private var title = ""
    @State private var description = ""
    @State private var attendeeEmails = ""
    @State private var from = Date().addingTimeInterval(3600)
    @State private var to = Date().addingTimeInterval(7 * 86400)
    @State private var duration = 30
    @State private var result: GgCalendarSlots?
    @State private var selected: GgCalendarSlots.Slot?
    @State private var busy = false
    @State private var error: String?
    @State private var connecting = false
    @State private var confirm = false
    @State private var idempotencyKey = UUID().uuidString.lowercased()
    @State private var created: MeetingDTO?
    private var timezone: String { TimeZone.current.identifier }
    var body: some View {
        NavigationStack {
            Form {
                if let created {
                    Section {
                        Label(L("meet.createdNotShared"), systemImage: "checkmark.circle.fill")
                        Text(created.title)
                        Text(L10n.dateTime(ISODate.parse(created.startsAt) ?? Date()))
                        if let raw = created.joinUrl, let link = URL(string: raw), link.scheme == "https" { Link(L("meet.open", ["app": created.provider.appName]), destination: link) }
                        if let error = created.error { Text(error).font(.caption).foregroundStyle(.red) }
                    }
                } else {
                    Section {
                        TextField(L("meet.titleField"), text: $title)
                        TextField(L("gg.calendar.description"), text: $description, axis: .vertical).lineLimit(1...3)
                        TextField(L("gg.calendar.attendees"), text: $attendeeEmails).textInputAutocapitalization(.never).keyboardType(.emailAddress)
                        DatePicker(L("gg.calendar.from"), selection: $from)
                        DatePicker(L("gg.calendar.to"), selection: $to)
                        Picker(L("gg.calendar.duration"), selection: $duration) { ForEach([15, 30, 45, 60, 90, 120, 180, 240], id: \.self) { Text("\($0) min").tag($0) } }
                        Text(L("gg.calendar.workHours")).font(.caption).foregroundStyle(Theme.textSecondary)
                        Text(timezone).font(.caption).foregroundStyle(Theme.textSecondary)
                        Button(L("gg.calendar.check")) { checkSlots() }.disabled(busy || to <= from)
                    }
                    if let result {
                        Section {
                            if result.status == "ready" {
                                if let provider = result.provider { Text(provider == "google" ? "Google Calendar" : "Microsoft Calendar").font(.caption.weight(.semibold)) }
                                if let at = result.checkedAt { Text(L("gg.calendar.checked", ["date": L10n.dateTime(ISODate.parse(at) ?? Date())])).font(.caption) }
                                ForEach(result.slots) { slot in
                                    Button { selected = slot; idempotencyKey = UUID().uuidString.lowercased() } label: {
                                        Label(L10n.dateTime(ISODate.parse(slot.startsAt) ?? Date()), systemImage: selected == slot ? "checkmark.circle.fill" : "circle")
                                    }
                                }
                                if result.slots.isEmpty { Text(L("gg.calendar.noSlots")) }
                                if selected != nil { Button(L("gg.calendar.confirm")) { confirm = true }.disabled(busy || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
                            } else {
                                Text(L("gg.calendar.\(result.status)"))
                                Button(L("gg.calendar.connect")) { connecting = true }
                            }
                        }
                    }
                    if busy { ProgressView() }
                    if let error { Text(error).foregroundStyle(.red).font(.caption) }
                }
            }
            .navigationTitle(L("gg.calendar.title"))
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L("common.close")) { dismiss() } } }
            .onAppear { if title.isEmpty { title = String(suggestedTitle.prefix(200)) } }
            .onChange(of: from) { _, _ in result = nil; selected = nil }
            .onChange(of: to) { _, _ in result = nil; selected = nil }
            .onChange(of: duration) { _, _ in result = nil; selected = nil }
            .onChange(of: title) { _, _ in idempotencyKey = UUID().uuidString.lowercased() }
            .onChange(of: description) { _, _ in idempotencyKey = UUID().uuidString.lowercased() }
            .onChange(of: attendeeEmails) { _, _ in idempotencyKey = UUID().uuidString.lowercased() }
            .sheet(isPresented: $connecting) { NavigationStack { Form { MeetingsSettingsSection() }.navigationTitle(L("gg.calendar.connect")).toolbar { ToolbarItem(placement: .confirmationAction) { Button(L("common.close")) { connecting = false; result = nil } } } } }
            .confirmationDialog(L("gg.calendar.confirm"), isPresented: $confirm, titleVisibility: .visible) {
                Button(L("gg.calendar.create")) { createMeeting() }
                Button(L("common.cancel"), role: .cancel) {}
            } message: {
                Text([title, selected.map { L10n.dateTime(ISODate.parse($0.startsAt) ?? Date()) } ?? "", timezone, result?.provider ?? ""].joined(separator: "\n"))
            }
        }.accessibilityIdentifier("gg.calendar")
    }
    private func checkSlots() {
        guard !busy else { return }
        busy = true; error = nil; selected = nil
        let stamp = store.sessionStamp
        Task {
            defer { busy = false }
            do {
                let slots: GgCalendarSlots = try await store.api.request("/gg/calendar/slots", method: "POST", json: ["source": source, "messageIds": messageIds, "from": ISODate.string(from), "to": ISODate.string(to), "durationMin": duration, "timezone": timezone, "startHour": 9, "endHour": 18])
                try store.requireSession(stamp); result = slots
            } catch { if stamp == store.sessionStamp { self.error = L10n.errorText(error) } }
        }
    }
    private func createMeeting() {
        guard !busy, let selected, let provider = result?.provider, ["google", "microsoft"].contains(provider) else { return }
        busy = true; error = nil
        let stamp = store.sessionStamp
        let emails = attendeeEmails.split(whereSeparator: { $0 == "," || $0 == ";" || $0 == "\n" }).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        guard emails.count <= 20 else { busy = false; error = L("gg.calendar.tooMany"); return }
        let payload: [String: Any] = ["description": description, "attendeeEmails": emails,"source": source, "messageIds": messageIds, "provider": provider, "idempotencyKey": idempotencyKey, "title": title, "startsAt": selected.startsAt, "endsAt": selected.endsAt, "timezone": result?.timezone ?? timezone, "shareToChat": false]
        Task {
            defer { busy = false }
            do {
                let meeting: MeetingDTO = try await store.api.request("/gg/calendar/confirm", method: "POST", json: payload)
                try store.requireSession(stamp); created = meeting
                _ = try? await store.loadEvents(from: from, to: to, conversationId: nil)
            } catch { if stamp == store.sessionStamp { self.error = L10n.errorText(error) } }
        }
    }
}
