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

/// Calendario Día / Semana / Mes (1.6.6): Semana por defecto y recordada; ‹ Hoy ›; en Mes, cuadrícula de 6×7 que
/// empieza en lunes con «+N más» (tocar un día abre la vista Día); se crea desde cada vista.
struct AgendaScreen: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var mode = CalendarMode.load()
    @State private var anchor = Date()
    @State private var error: String?
    @State private var creating: CreateAt?
    /// Grupos ocultos con la leyenda (preferencia del dispositivo).
    @State private var hidden = AgendaHidden.load()

    struct CreateAt: Identifiable { var start: Date; var id: Double { start.timeIntervalSince1970 } }

    private var cal: Calendar { CalendarGrid.calendar() }

    var body: some View {
        let range = CalendarGrid.range(mode, anchor, cal)
        Group {
            if let d = store.data {
                let visible = Set(d.conversations.map(\.id))
                let inRange = CalendarGrid.sorted(store.events.values.filter { visible.contains($0.conversationId) && $0.start < range.end && $0.end > range.start && !$0.isCancelled }, cal)
                let list = AgendaHidden.visible(inRange, hidden: hidden)
                VStack(spacing: 0) {
                    header
                    legend(d, AgendaHidden.legendIds(inRange))
                    switch mode {
                    case .day: dayView(list)
                    case .week: weekView(list)
                    case .month: monthView(list)
                    }
                }
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(L("nav.agenda"))
        .navigationBarTitleDisplayMode(.inline)
        .quickActions()
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { creating = .init(start: CalendarGrid.slot(mode == .day ? anchor : max(anchor, Date()), hour: nil, cal)) } label: {
                    Image(systemName: "calendar.badge.plus")
                }
                .accessibilityLabel(L("cal.newTitle"))
                .accessibilityIdentifier("cal.new")
            }
        }
        .sheet(item: $creating) { c in EventEditorSheet(conversationId: nil, origin: nil, event: nil, initialStart: c.start) }
        .onChange(of: mode) { _, m in CalendarMode.save(m) }
        .task(id: "\(mode.rawValue)-\(range.start.timeIntervalSince1970)") { await load(range) }
    }

    // MARK: Cabecera: Día / Semana / Mes y ‹ Hoy ›

    private var header: some View {
        VStack(spacing: 8) {
            Picker(L("cal.view"), selection: $mode) {
                ForEach(CalendarMode.allCases) { m in Text(L(m.labelKey)).tag(m) }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("cal.mode")
            HStack(spacing: 8) {
                Button { anchor = CalendarGrid.shift(mode, anchor, by: -1, cal) } label: { Image(systemName: "chevron.left").frame(width: 44, height: 44) }
                    .accessibilityLabel(L("cal.prev")).accessibilityIdentifier("cal.prev")
                Text(title).font(.headline).lineLimit(2).minimumScaleFactor(0.8).multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("cal.title")
                Button { anchor = CalendarGrid.shift(mode, anchor, by: 1, cal) } label: { Image(systemName: "chevron.right").frame(width: 44, height: 44) }
                    .accessibilityLabel(L("cal.next")).accessibilityIdentifier("cal.next")
                Button(L("cal.today")) { anchor = Date() }
                    .font(.subheadline.weight(.semibold)).lineLimit(1).fixedSize()
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("cal.today")
            }
            if let error { Text(error).foregroundStyle(.red).font(.footnote) }
        }
        .padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 6)
        // Con «Máximo» la cabecera crece, pero sin partir palabras.
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
    }

    // MARK: Leyenda: un color por grupo; tocar oculta o muestra

    @ViewBuilder
    private func legend(_ d: BootstrapDTO, _ ids: [String]) -> some View {
        let convs = ids.compactMap { id in d.conversations.first { $0.id == id } }
        if !convs.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(convs) { c in
                        let off = hidden.contains(c.id)
                        let dot = GroupColor.dot(c.id)
                        Button { setHidden(AgendaHidden.toggle(c.id, in: hidden)) } label: {
                            HStack(spacing: 6) {
                                Circle().fill(off ? Color.clear : dot).overlay(Circle().strokeBorder(dot, lineWidth: 1.5))
                                    .frame(width: 10, height: 10)
                                Text(Naming.title(d, c)).font(.caption.weight(.semibold)).lineLimit(1)
                                    .foregroundStyle(off ? Theme.textSecondary : Theme.textPrimary)
                                    .strikethrough(off)
                            }
                            .padding(.horizontal, 10).frame(minHeight: 32)
                            .background(Capsule().fill(off ? Color.clear : GroupColor.background(c.id).opacity(0.55)))
                            .overlay(Capsule().strokeBorder(Theme.textSecondary.opacity(off ? 0.35 : 0)))
                            .contentShape(Capsule())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(Naming.title(d, c))
                        .accessibilityValue(off ? L("cal.groupHidden") : "")
                        .accessibilityHint(off ? L("cal.showGroup") : L("cal.hideGroup"))
                        .accessibilityAddTraits(off ? [] : .isSelected)
                        .accessibilityIdentifier("cal.legend.\(c.id)")
                    }
                    if !hidden.isEmpty {
                        Button(L("cal.showAll")) { setHidden([]) }
                            .font(.caption.weight(.semibold)).buttonStyle(.bordered).controlSize(.small)
                            .accessibilityIdentifier("cal.legend.showAll")
                    }
                }
                .padding(.horizontal, 16)
            }
            .padding(.bottom, 6)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(L("cal.groups"))
            .dynamicTypeSize(...DynamicTypeSize.accessibility2)
        }
    }

    private func setHidden(_ ids: [String]) {
        hidden = ids
        AgendaHidden.save(ids)
    }

    private var title: String {
        let loc = L10n.locale
        switch mode {
        case .day: return anchor.formatted(Date.FormatStyle().weekday(.wide).day().month(.wide).locale(loc)).calTitleCase
        case .week: return L("cal.week", ["date": CalendarGrid.startOfWeek(anchor, cal).formatted(Date.FormatStyle().day().month(.wide).year().locale(loc))])
        case .month: return anchor.formatted(Date.FormatStyle().month(.wide).year().locale(loc)).calTitleCase
        }
    }

    // MARK: Día: una columna de horas

    private func dayView(_ list: [CalendarEventDTO]) -> some View {
        let day = cal.startOfDay(for: anchor)
        let all = CalendarGrid.events(list, on: day, cal)
        // Los de día completo van en una franja arriba de las horas, no en la grilla.
        let allDay = all.filter { CalendarGrid.isAllDay($0, cal) }
        let items = all.filter { !CalendarGrid.isAllDay($0, cal) }
        let earlier = items.filter { $0.start < day }
        return ScrollViewReader { proxy in
            List {
                if !allDay.isEmpty {
                    Section(L("cal.allDay")) { ForEach(allDay) { e in eventLink(e) } }
                        .accessibilityIdentifier("cal.allDayBand")
                }
                if !earlier.isEmpty {
                    Section(L("cal.continues")) { ForEach(earlier) { e in eventLink(e) } }
                }
                Section {
                    ForEach(0..<24, id: \.self) { h in
                        let inHour = items.filter { $0.start >= day && cal.component(.hour, from: $0.start) == h }
                        HStack(alignment: .top, spacing: 10) {
                            Text(AgendaTime.time(CalendarGrid.slot(day, hour: h, cal)))
                                .font(.caption.monospacedDigit()).foregroundStyle(Theme.textSecondary)
                                .frame(minWidth: 56, alignment: .trailing)
                            VStack(alignment: .leading, spacing: 4) {
                                ForEach(inHour) { e in eventLink(e) }
                                // El hueco: tocarlo crea una reunión a esa hora.
                                Button { creating = .init(start: CalendarGrid.slot(day, hour: h, cal)) } label: {
                                    Color.clear.frame(maxWidth: .infinity, minHeight: inHour.isEmpty ? 30 : 8).contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(L("cal.newAt", ["time": AgendaTime.time(CalendarGrid.slot(day, hour: h, cal))]))
                                .accessibilityIdentifier("cal.slot.\(h)")
                            }
                        }
                        .id(h)
                        .listRowInsets(EdgeInsets(top: 4, leading: 8, bottom: 4, trailing: 12))
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .refreshable { await load(CalendarGrid.range(mode, anchor, cal)) }
            .onAppear { proxy.scrollTo(items.first.map { cal.component(.hour, from: max($0.start, day)) } ?? 8, anchor: .top) }
            .onChange(of: anchor) { _, _ in proxy.scrollTo(8, anchor: .top) }
        }
    }

    // MARK: Semana: los 7 días, con «+» en cada uno

    private func weekView(_ list: [CalendarEventDTO]) -> some View {
        let start = CalendarGrid.startOfWeek(anchor, cal)
        let days = (0..<7).compactMap { cal.date(byAdding: .day, value: $0, to: start) }
        return List {
            if list.isEmpty { Text(L("cal.empty")).foregroundStyle(Theme.textSecondary) }
            ForEach(days, id: \.self) { day in
                let items = CalendarGrid.events(list, on: day, cal)
                Section {
                    ForEach(items) { e in eventLink(e) }
                } header: {
                    HStack {
                        Text(AgendaTime.day(day)).font(.subheadline.weight(cal.isDateInToday(day) ? .bold : .semibold))
                            .foregroundStyle(cal.isDateInToday(day) ? Theme.accentText : Theme.textSecondary)
                        Spacer()
                        Button { creating = .init(start: CalendarGrid.slot(day, hour: nil, cal)) } label: { Image(systemName: "plus.circle") }
                            .accessibilityLabel(L("cal.newOn", ["date": AgendaTime.day(day)]))
                            .accessibilityIdentifier("cal.weekAdd.\(cal.component(.weekday, from: day))")
                    }
                    .textCase(nil)
                }
            }
        }
        .listStyle(.insetGrouped)
        .listSectionSpacing(.compact)
        .scrollContentBackground(.hidden)
        .refreshable { await load(CalendarGrid.range(mode, anchor, cal)) }
    }

    // MARK: Mes: 6×7 desde el lunes, títulos o puntos y «+N más»

    private func monthView(_ list: [CalendarEventDTO]) -> some View {
        let grid = CalendarGrid.monthGrid(anchor, cal)
        let month = cal.component(.month, from: anchor)
        let cols = Array(repeating: GridItem(.flexible(), spacing: 2), count: 7)
        // Con texto de accesibilidad solo caben puntos; con texto normal, hasta 2 títulos.
        let big = typeSize.isAccessibilitySize
        let symbols = Self.weekdaySymbols(cal)
        return ScrollView {
            LazyVGrid(columns: cols, spacing: 2) {
                ForEach(symbols, id: \.self) { s in
                    Text(s).font(.caption2.weight(.bold)).foregroundStyle(Theme.textSecondary).lineLimit(1).minimumScaleFactor(0.6)
                        .frame(maxWidth: .infinity).accessibilityHidden(true)
                }
                ForEach(grid, id: \.self) { day in
                    let items = CalendarGrid.events(list, on: day, cal)
                    let c = CalendarGrid.cell(items, max: big ? 0 : 2)
                    let inMonth = cal.component(.month, from: day) == month
                    let today = cal.isDateInToday(day)
                    Button {
                        anchor = day
                        mode = .day
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(cal.component(.day, from: day))")
                                .font(.caption.weight(today ? .heavy : .semibold)).monospacedDigit()
                                .lineLimit(1).minimumScaleFactor(0.7)
                                .foregroundStyle(today ? Theme.onPrimary : inMonth ? Theme.textPrimary : Theme.textSecondary.opacity(0.6))
                                .padding(.horizontal, 5).padding(.vertical, 1)
                                .background(Capsule().fill(today ? Theme.primaryFill : .clear))
                            ForEach(c.shown) { e in
                                Text((CalendarGrid.isVideoLink(e.location) ? "📹" : "") + e.title)
                                    .font(.caption2.weight(.medium)).lineLimit(1).truncationMode(.tail)
                                    .foregroundStyle(GroupColor.text(e.conversationId))
                                    .padding(.horizontal, 3)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(RoundedRectangle(cornerRadius: 4).fill(GroupColor.background(e.conversationId)))
                            }
                            if big && !items.isEmpty {
                                HStack(spacing: 2) { ForEach(items.prefix(3)) { e in Circle().fill(GroupColor.dot(e.conversationId)).frame(width: 6, height: 6) } }
                            }
                            if c.more > 0 && !big {
                                Text(L("cal.more", ["n": c.more])).font(.caption2.weight(.semibold)).foregroundStyle(Theme.accentText).lineLimit(1)
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(3)
                        .frame(maxWidth: .infinity, minHeight: big ? 64 : 84, alignment: .topLeading)
                        .background(RoundedRectangle(cornerRadius: 8).fill(inMonth ? Theme.surface : Theme.surface.opacity(0.4)))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel([AgendaTime.day(day), items.isEmpty ? nil : L("cal.nEvents", ["n": items.count]),
                                         items.first.map(\.title)].compactMap { $0 }.joined(separator: ", "))
                    .accessibilityHint(L("cal.openDay"))
                    .accessibilityIdentifier("cal.day.\(IssueDates.iso(day, timeZone: cal.timeZone))")
                }
            }
            .padding(.horizontal, 8)
            // Siete columnas en un teléfono: el texto de la cuadrícula tiene tope (VoiceOver lee la celda completa).
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
            .accessibilityIdentifier("cal.month")
        }
        .refreshable { await load(CalendarGrid.range(mode, anchor, cal)) }
    }

    /// L M X J V S D (o M T W T F S S), empezando en lunes.
    static func weekdaySymbols(_ cal: Calendar) -> [String] {
        let f = DateFormatter(); f.locale = cal.locale; f.calendar = cal
        let s = f.veryShortStandaloneWeekdaySymbols ?? ["D", "L", "M", "X", "J", "V", "S"]
        let lang = cal.locale?.language.languageCode?.identifier ?? "es"
        // En español, miércoles es «X» para no repetir la «M» del martes.
        let fixed = lang == "es" ? ["D", "L", "M", "X", "J", "V", "S"] : s
        return Array(fixed[1...]) + [fixed[0]]
    }

    private func eventLink(_ e: CalendarEventDTO) -> some View {
        NavigationLink(value: Route.event(e.id)) { EventRow(event: e) }
    }

    private func load(_ r: DateInterval) async {
        do { try await store.loadEvents(from: r.start, to: r.end); error = nil } catch { self.error = L10n.errorText(error) }
    }
}

struct EventRow: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dynamicTypeSize) private var typeSize
    let event: CalendarEventDTO
    var showConv = true
    var body: some View {
        let d = store.data
        let conv = store.meta(event.conversationId)
        let mine = event.invitees.first { $0.userId == d?.me.id }
        // Un color por grupo (docs/AGENDA-COLORES.md); «Todo el día» en vez de la hora.
        let time = Text(CalendarGrid.isAllDay(event) ? L("cal.allDay") : AgendaTime.time(event.start))
            .font(.caption.weight(.bold)).monospacedDigit()
            .lineLimit(1)
            .padding(.horizontal, 8).padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 8).fill(GroupColor.background(event.conversationId)))
            .foregroundStyle(GroupColor.text(event.conversationId))
            .fixedSize()
        let info = VStack(alignment: .leading, spacing: 2) {
            Text((CalendarGrid.isVideoLink(event.location) ? "📹 " : "") + event.title).font(.body.weight(.semibold)).strikethrough(event.isCancelled)
                .lineLimit(typeSize.isAccessibilitySize ? 3 : 2)
            Text([showConv ? conv.flatMap { c in d.map { Naming.title($0, c) } } : nil, AgendaTime.day(event.start), event.isCancelled ? L("cal.cancelled") : nil].compactMap { $0 }.joined(separator: " · "))
                .font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
            if typeSize.isAccessibilitySize, let mine { Text(L("cal.rsvp.\(mine.rsvp.rawValue)")).font(.caption2).foregroundStyle(Theme.textSecondary) }
        }
        Group {
            // Con texto grande: la hora arriba y el título debajo, a todo el ancho (sin cortar palabras).
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 6) { time; info }
            } else {
                HStack(spacing: 10) {
                    time
                    info
                    Spacer()
                    if let mine { Text(L("cal.rsvp.\(mine.rsvp.rawValue)")).font(.caption2).foregroundStyle(Theme.textSecondary) }
                }
            }
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
    /// Desde el calendario: la hora del hueco o del día tocado.
    var initialStart: Date? = nil

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
        let groups = d?.conversations.filter { $0.canPost } ?? []
        let humans = d.map { dd in (dd.conversations.first { $0.id == conv }?.memberIds ?? []).compactMap { Naming.person(dd, $0) }.filter { $0.kind == "human" } } ?? []
        let chosen = invitees ?? Set(humans.map(\.id))
        SheetForm(title: event == nil ? L("cal.newTitle") : L("cal.editTitle"), action: event == nil ? L("cal.create") : L("cal.save"),
                  busy: busy, disabled: title.trimmingCharacters(in: .whitespaces).count < 2 || conv.isEmpty, error: error, onSubmit: { submit(chosen) }) {
            Section {
                TextField(L("cal.title"), text: $title).accessibilityIdentifier("event.titleField")
                if event == nil, let d {
                    Picker(L("cal.conversation"), selection: $conv) {
                        ForEach(groups) { g in Text([Naming.title(d, g), d.workspaces.first { $0.id == g.workspaceId }?.name].compactMap { $0 }.joined(separator: " · ")).tag(g.id) }
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
        let groups = store.data?.conversations.filter { $0.canPost } ?? []
        conv = event?.conversationId ?? conversationId ?? groups.first?.id ?? ""
        if let ev = event {
            title = ev.title; tz = ev.timezone; date = ev.start; start = ev.start; endTime = ev.end
            location = ev.location ?? ""; notes = ev.description ?? ""; invitees = Set(ev.invitees.map(\.userId))
        } else {
            title = origin.map { excerpt($0.body, 80) } ?? ""
            let tomorrow10 = Calendar.current.date(bySettingHour: 10, minute: 0, second: 0, of: Date().addingTimeInterval(86400))!
            let s0 = initialStart ?? tomorrow10
            date = s0; start = s0; endTime = s0.addingTimeInterval(3600)
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

extension GroupColor {
    /// Fondo del chip del evento: el claro de la paleta; en modo oscuro, el color de texto (con texto blanco).
    static func background(_ conversationId: String) -> Color { let p = pair(conversationId); return Color(light: p.bg, dark: p.fg) }
    /// Texto sobre ese fondo.
    static func text(_ conversationId: String) -> Color { let p = pair(conversationId); return Color(light: p.fg, dark: 0xFFFFFF) }
    /// Punto de la leyenda y marcas sueltas: el color de texto (aclarado en modo oscuro para que se vea sobre el fondo).
    static func dot(_ conversationId: String) -> Color { let p = pair(conversationId); return Color(light: p.fg, dark: PersonColor.lighten(p.fg, 0.35)) }
}

private extension String {
    /// «lunes, 28 de septiembre» → «Lunes, 28 de septiembre».
    var calTitleCase: String { prefix(1).uppercased() + dropFirst() }
}
