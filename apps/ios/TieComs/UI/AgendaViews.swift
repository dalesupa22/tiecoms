import SwiftUI

enum AgendaTime {
    static let commonTimeZones = ["America/Bogota", "America/Mexico_City", "America/Lima", "America/Santiago", "America/Argentina/Buenos_Aires",
                                  "America/Sao_Paulo", "America/New_York", "America/Los_Angeles", "Europe/Madrid", "UTC"]
    static var zones: [String] { Array(NSOrderedSet(array: [TimeZone.current.identifier] + commonTimeZones)) as? [String] ?? commonTimeZones }

    static func startOfWeek(_ d: Date, calendar: Calendar = .current) -> Date {
        var cal = calendar
        cal.firstWeekday = 2 // lunes, como la web
        return cal.dateInterval(of: .weekOfYear, for: d)?.start ?? cal.startOfDay(for: d)
    }

    static func time(_ d: Date, tz: TimeZone? = nil) -> String {
        var f = Date.FormatStyle(date: .omitted, time: .shortened).locale(L10n.locale)
        if let tz { f.timeZone = tz }
        return d.formatted(f)
    }

    static func day(_ d: Date) -> String { d.formatted(Date.FormatStyle().weekday(.abbreviated).day().month(.abbreviated).locale(L10n.locale)) }

    static func isURL(_ s: String?) -> Bool { s.map { $0.lowercased().hasPrefix("http://") || $0.lowercased().hasPrefix("https://") } ?? false }

    /// «Fecha + hora» en la zona tz → instante (equivalente a zonedToUtc de la web).
    static func combine(date: Date, time: Date, tz: TimeZone) -> Date {
        var local = Calendar.current
        let d = local.dateComponents([.year, .month, .day], from: date)
        let t = local.dateComponents([.hour, .minute], from: time)
        local.timeZone = tz
        return local.date(from: DateComponents(timeZone: tz, year: d.year, month: d.month, day: d.day, hour: t.hour, minute: t.minute)) ?? date
    }
}

struct AgendaScreen: View {
    @Environment(AppStore.self) private var store
    @State private var week = AgendaTime.startOfWeek(Date())
    @State private var creating = false
    @State private var error: String?

    var body: some View {
        let end = Calendar.current.date(byAdding: .day, value: 7, to: week)!
        Group {
            if let d = store.data {
                let visible = Set(d.conversations.map(\.id))
                let list = store.events.values.filter { visible.contains($0.conversationId) && $0.start < end && $0.end > week }.sorted { $0.startsAt < $1.startsAt }
                let days = (0..<7).map { Calendar.current.date(byAdding: .day, value: $0, to: week)! }
                List {
                    Section {
                        HStack {
                            Button { shift(-1) } label: { Image(systemName: "chevron.left") }.accessibilityLabel(L("cal.prev"))
                            Spacer()
                            Text(L("cal.week", ["date": week.formatted(Date.FormatStyle().day().month(.wide).year().locale(L10n.locale))]))
                                .font(.subheadline.weight(.semibold))
                            Spacer()
                            Button { shift(1) } label: { Image(systemName: "chevron.right") }.accessibilityLabel(L("cal.next"))
                        }
                        .buttonStyle(.borderless)
                        Button(L("cal.today")) { week = AgendaTime.startOfWeek(Date()) }.font(.footnote)
                        if let error { Text(error).foregroundStyle(.red).font(.footnote) }
                    }
                    if list.isEmpty { Text(L("cal.empty")).foregroundStyle(Theme.textSecondary) }
                    ForEach(days, id: \.self) { day in
                        let items = list.filter { Calendar.current.isDate($0.start, inSameDayAs: day) }
                        if !items.isEmpty {
                            Section(AgendaTime.day(day)) {
                                ForEach(items) { e in NavigationLink(value: Route.event(e.id)) { EventRow(event: e) } }
                            }
                        }
                    }
                }
                .listStyle(.insetGrouped)
                .scrollContentBackground(.hidden)
                .refreshable { await load(end) }
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(L("nav.agenda"))
        .toolbar { ToolbarItem(placement: .primaryAction) { Button(L("cal.new")) { creating = true }.accessibilityIdentifier("agenda.new") } }
        .sheet(isPresented: $creating) { EventEditorSheet(conversationId: nil, origin: nil, event: nil) }
        .task(id: week) { await load(end) }
    }

    private func shift(_ n: Int) { week = Calendar.current.date(byAdding: .day, value: 7 * n, to: week)! }

    private func load(_ end: Date) async {
        do { try await store.loadEvents(from: week, to: end); error = nil } catch { self.error = L10n.errorText(error) }
    }
}

struct EventRow: View {
    @Environment(AppStore.self) private var store
    let event: CalendarEventDTO
    var showConv = true
    var body: some View {
        let d = store.data
        let conv = store.meta(event.conversationId)
        let mine = event.invitees.first { $0.userId == d?.me.id }
        HStack(spacing: 10) {
            Text(AgendaTime.time(event.start))
                .font(.caption.weight(.bold)).monospacedDigit()
                .padding(.horizontal, 8).padding(.vertical, 6)
                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.orange.opacity(0.15)))
                .foregroundStyle(Theme.accentText)
            VStack(alignment: .leading, spacing: 2) {
                Text(event.title).font(.body.weight(.semibold)).strikethrough(event.isCancelled).lineLimit(1)
                Text([showConv ? conv.flatMap { c in d.map { Naming.title($0, c) } } : nil, AgendaTime.day(event.start), event.isCancelled ? L("cal.cancelled") : nil].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(1)
            }
            Spacer()
            if let mine { Text(L("cal.rsvp.\(mine.rsvp.rawValue)")).font(.caption2).foregroundStyle(Theme.textSecondary) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("event.row.\(event.id)")
    }
}

struct EventDetailView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.openURL) private var openURL
    let eventId: String
    @State private var editing = false
    @State private var confirmCancel = false
    @State private var error: String?

    var body: some View {
        Group {
            if let d = store.data, let ev = store.events[eventId] { detail(d, ev) }
            else if let error { ContentUnavailableView(error, systemImage: "calendar.badge.exclamationmark") }
            else { ProgressView() }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(store.events[eventId]?.title ?? L("nav.agenda"))
        .navigationBarTitleDisplayMode(.inline)
        .task { if store.events[eventId] == nil { do { _ = try await store.loadEvent(eventId) } catch { self.error = L10n.errorText(error) } } }
        .sheet(isPresented: $editing) { if let ev = store.events[eventId] { EventEditorSheet(conversationId: ev.conversationId, origin: nil, event: ev) } }
    }

    @ViewBuilder
    private func detail(_ d: BootstrapDTO, _ ev: CalendarEventDTO) -> some View {
        let conv = store.meta(ev.conversationId)
        let mine = ev.invitees.first { $0.userId == d.me.id }
        let canEdit = ev.organizerId == d.me.id || conv?.canManage == true
        let tz = TimeZone(identifier: ev.timezone)
        Form {
            Section {
                if ev.isCancelled { Label(L("cal.cancelled"), systemImage: "xmark.octagon").foregroundStyle(.red) }
                Text(L10n.eventWhen(ev)).font(.headline)
                if let tz, tz.identifier != TimeZone.current.identifier {
                    Text("\(L("cal.eventTz")): \(AgendaTime.time(ev.start, tz: tz))–\(AgendaTime.time(ev.end, tz: tz)) (\(ev.timezone.replacingOccurrences(of: "_", with: " ")))")
                        .font(.footnote).foregroundStyle(Theme.textSecondary)
                }
                Text([conv.map { Naming.title(d, $0) }, L("cal.organizer", ["name": Naming.person(d, ev.organizerId)?.name ?? ""])].compactMap { $0 }.joined(separator: " · "))
                    .font(.footnote).foregroundStyle(Theme.textSecondary)
                if let loc = ev.location, !loc.isEmpty {
                    if AgendaTime.isURL(loc), let u = URL(string: loc.trimmingCharacters(in: .whitespaces)) {
                        Button { openURL(u) } label: { Label(L("cal.join"), systemImage: "video") }
                    } else { Label(loc, systemImage: "mappin.and.ellipse") }
                }
                if let desc = ev.description, !desc.isEmpty { Text(desc) }
            }
            if let mine, !ev.isCancelled {
                Section {
                    Picker("", selection: Binding(get: { mine.rsvp }, set: { r in
                        Task { do { try await store.rsvp(ev.id, r) } catch { self.error = L10n.errorText(error) } }
                    })) {
                        ForEach([Rsvp.yes, .maybe, .no], id: \.self) { Text(L("cal.rsvp.\($0.rawValue)")).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("event.rsvp")
                }
            }
            Section("\(L("cal.invitees")) · \(ev.invitees.count)") {
                ForEach(ev.invitees, id: \.userId) { i in
                    let p = Naming.person(d, i.userId)
                    HStack {
                        Avatar(name: p?.name ?? "?", org: Naming.org(d, p?.orgId), size: 28, photo: p?.avatarUrl)
                        Text(p?.name ?? L("common.participant"))
                        Spacer()
                        Text(L("cal.rsvp.\(i.rsvp.rawValue)")).font(.caption).foregroundStyle(Theme.textSecondary)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            Section(L("cal.addTo")) {
                Button(L("cal.addGoogle")) { if let u = googleLink(ev) { openURL(u) } }
                Button(L("cal.addOutlook")) { if let u = outlookLink(ev) { openURL(u) } }
            }
            Section {
                if let conv { NavigationLink(value: Route.conversation(conv.id)) { Text(L("cal.openChat")) } }
                if canEdit && !ev.isCancelled {
                    Button(L("cal.edit")) { editing = true }
                    Button(L("cal.cancel"), role: .destructive) { confirmCancel = true }
                }
                if let error { Text(error).foregroundStyle(.red).font(.footnote) }
            }
        }
        .scrollContentBackground(.hidden)
        .confirmationDialog(L("cal.cancelConfirm"), isPresented: $confirmCancel, titleVisibility: .visible) {
            Button(L("cal.cancel"), role: .destructive) { Task { do { try await store.cancelEvent(ev.id) } catch { self.error = L10n.errorText(error) } } }
        }
    }

    private func stamp(_ d: Date) -> String {
        let f = DateFormatter(); f.timeZone = TimeZone(identifier: "UTC"); f.dateFormat = "yyyyMMdd'T'HHmmss'Z'"; return f.string(from: d)
    }
    private func details(_ ev: CalendarEventDTO) -> String { [ev.description, conversationLink(ev.conversationId)].compactMap { $0 }.joined(separator: "\n\n") }
    private func q(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "" }
    private func googleLink(_ ev: CalendarEventDTO) -> URL? {
        URL(string: "https://calendar.google.com/calendar/render?action=TEMPLATE&text=\(q(ev.title))&dates=\(stamp(ev.start))/\(stamp(ev.end))&details=\(q(details(ev)))&location=\(q(ev.location ?? ""))&ctz=\(q(ev.timezone))")
    }
    private func outlookLink(_ ev: CalendarEventDTO) -> URL? {
        URL(string: "https://outlook.office.com/calendar/0/deeplink/compose?path=/calendar/action/compose&rru=addevent&subject=\(q(ev.title))&startdt=\(q(ev.startsAt))&enddt=\(q(ev.endsAt))&body=\(q(details(ev)))&location=\(q(ev.location ?? ""))")
    }
}

/// Crear o editar una reunión (EventDialog de la web).
struct EventEditorSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let conversationId: String?
    let origin: MessageDTO?
    let event: CalendarEventDTO?

    @State private var conv = ""
    @State private var title = ""
    @State private var tz = TimeZone.current.identifier
    @State private var date = Date()
    @State private var start = Date()
    @State private var endTime = Date()
    @State private var location = ""
    @State private var notes = ""
    @State private var invitees: Set<String>?
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        let d = store.data
        let groups = d?.conversations.filter { $0.canPost && $0.workspaceId != nil && $0.kind != .direct } ?? []
        let humans = d.map { dd in (dd.conversations.first { $0.id == conv }?.memberIds ?? []).compactMap { Naming.person(dd, $0) }.filter { $0.kind == "human" } } ?? []
        let chosen = invitees ?? Set(humans.map(\.id))
        SheetForm(title: event == nil ? L("cal.newTitle") : L("cal.editTitle"), action: event == nil ? L("cal.create") : L("cal.save"),
                  busy: busy, disabled: title.trimmingCharacters(in: .whitespaces).count < 2 || conv.isEmpty, error: error, onSubmit: { submit(chosen) }) {
            Section {
                TextField(L("cal.title"), text: $title).accessibilityIdentifier("event.titleField")
                if event == nil, let d {
                    Picker(L("cal.conversation"), selection: $conv) {
                        ForEach(groups) { g in Text("\(Naming.title(d, g)) · \(d.workspaces.first { $0.id == g.workspaceId }?.name ?? "")").tag(g.id) }
                    }
                    .onChange(of: conv) { _, _ in invitees = nil }
                }
            }
            Section {
                DatePicker(L("cal.date"), selection: $date, displayedComponents: .date)
                DatePicker(L("cal.start"), selection: $start, displayedComponents: .hourAndMinute)
                DatePicker(L("cal.end"), selection: $endTime, displayedComponents: .hourAndMinute)
                Picker(L("cal.tz"), selection: $tz) { ForEach(AgendaTime.zones, id: \.self) { Text($0.replacingOccurrences(of: "_", with: " ")).tag($0) } }
                TextField(L("cal.locationPh"), text: $location)
            }
            Section("\(L("cal.invitees")) · \(chosen.count)") {
                ForEach(humans) { p in
                    Toggle(p.name, isOn: Binding(get: { chosen.contains(p.id) }, set: { on in
                        var s = chosen; if on { s.insert(p.id) } else { s.remove(p.id) }; invitees = s
                    }))
                    .disabled(p.id == d?.me.id)
                }
            }
            Section { TextField(L("cal.description"), text: $notes, axis: .vertical).lineLimit(2...6) }
        }
        .onAppear(perform: prefill)
    }

    private func prefill() {
        guard conv.isEmpty else { return }
        let groups = store.data?.conversations.filter { $0.canPost && $0.workspaceId != nil && $0.kind != .direct } ?? []
        conv = event?.conversationId ?? conversationId ?? groups.first?.id ?? ""
        if let ev = event {
            title = ev.title; tz = ev.timezone; date = ev.start; start = ev.start; endTime = ev.end
            location = ev.location ?? ""; notes = ev.description ?? ""; invitees = Set(ev.invitees.map(\.userId))
        } else {
            title = origin.map { excerpt($0.body, 80) } ?? ""
            let tomorrow10 = Calendar.current.date(bySettingHour: 10, minute: 0, second: 0, of: Date().addingTimeInterval(86400))!
            date = tomorrow10; start = tomorrow10; endTime = tomorrow10.addingTimeInterval(3600)
        }
    }

    private func submit(_ chosen: Set<String>) {
        let zone = TimeZone(identifier: tz) ?? .current
        let s = AgendaTime.combine(date: date, time: start, tz: zone)
        var e = AgendaTime.combine(date: date, time: endTime, tz: zone)
        if e <= s { e = e.addingTimeInterval(86400) }
        var payload: [String: Any] = ["title": title, "description": notes.isEmpty ? NSNull() : notes, "location": location.isEmpty ? NSNull() : location,
                                      "startsAt": ISODate.string(s), "endsAt": ISODate.string(e), "timezone": tz, "inviteeIds": Array(chosen)]
        busy = true; error = nil
        Task {
            do {
                let ev: CalendarEventDTO
                if let event { ev = try await store.updateEvent(event.id, payload) }
                else {
                    payload["originMessageId"] = origin?.id ?? NSNull()
                    ev = try await store.createEvent(conversationId: conv, payload)
                }
                store.show("\(ev.title) · \(L10n.eventWhen(ev))")
                dismiss()
            } catch { self.error = L10n.errorText(error) }
            busy = false
        }
    }
}
