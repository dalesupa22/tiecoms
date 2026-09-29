import SwiftUI

// Tarjeta del evento en el chat (como EventChatCard de apps/web/src/screens/Calendar.tsx): reemplaza la línea
// «Agendó…» del aviso `event.created` por fecha, título, Unirse, quiénes van y la respuesta ahí mismo.
// Sin campos de texto: con el teclado abierto y una tarjeta alta en pantalla el chat no debe reubicarse sin fin.

/// Color de un grupo en la Agenda, el mismo en web, iOS y Android (packages/client-core/src/group-colors.ts,
/// docs/AGENDA-COLORES.md): hash = h*31 + código UTF-16 de cada carácter del id, en uint32; índice = hash % 10.
enum GroupColor {
    static let palette: [(bg: UInt32, fg: UInt32)] = [
        (0xDCE8FB, 0x1E4E9C), (0xD7F0E2, 0x17603D), (0xE9DEFB, 0x5B32A8), (0xD3EEF0, 0x0A5F67), (0xFBDDEB, 0x962868),
        (0xFDE8CF, 0x8A4B0B), (0xE2E4F8, 0x3C4196), (0xF9DADA, 0x9B2525), (0xEEF3C9, 0x5B6412), (0xF6EDC4, 0x735600),
    ]
    static func index(_ conversationId: String) -> Int {
        var h: UInt32 = 0
        for u in conversationId.utf16 { h = h &* 31 &+ UInt32(u) }
        return Int(h % UInt32(palette.count))
    }
    static func bg(_ conversationId: String) -> Color { Color(hex: palette[index(conversationId)].bg) }
    static func fg(_ conversationId: String) -> Color { Color(hex: palette[index(conversationId)].fg) }
}

/// Reglas puras de la tarjeta del evento (sin red), compartidas con las pruebas.
enum EventCardRule {
    /// El aviso de sistema `event.created` con `eventId`.
    static func eventId(_ m: MessageDTO) -> String? {
        guard let p = m.systemPayload, p["k"] as? String == "event.created", let id = p["eventId"] as? String, !id.isEmpty else { return nil }
        return id
    }

    /// Día completo: empieza a las 00:00 y termina a las 23:59 o más tarde (o a las 00:00), en la hora local (como la web).
    static func isAllDay(_ e: CalendarEventDTO, calendar: Calendar = .current) -> Bool {
        let s = calendar.dateComponents([.hour, .minute], from: e.start), en = calendar.dateComponents([.hour, .minute], from: e.end)
        guard s.hour == 0, s.minute == 0, e.end.timeIntervalSince(e.start) >= 86_340 else { return false }
        return (en.hour == 23 && (en.minute ?? 0) >= 59) || (en.hour == 0 && en.minute == 0)
    }

    static func going(_ e: CalendarEventDTO) -> Int { e.invitees.filter { $0.rsvp == .yes }.count }

    /// Solo invitados, y ni cancelado ni pasado.
    static func canAnswer(_ e: CalendarEventDTO, me: String, now: Date = Date()) -> Bool {
        e.invitees.contains { $0.userId == me } && !e.isCancelled && e.end >= now
    }

    /// «miércoles, 30 de septiembre · 03:00 p. m. – 04:00 p. m.» (o «Todo el día»).
    static func when(_ e: CalendarEventDTO, locale: Locale = L10n.locale) -> String {
        let day = e.start.formatted(Date.FormatStyle().weekday(.wide).day().month(.wide).locale(locale))
        if isAllDay(e) { return "\(day) · \(L("cal.allDay"))" }
        let t = Date.FormatStyle().hour(.twoDigits(amPM: .abbreviated)).minute(.twoDigits).locale(locale)
        return "\(day) · \(e.start.formatted(t)) – \(e.end.formatted(t))"
    }

    static let rsvpIcon: [Rsvp: String] = [.yes: "✓", .maybe: "?", .no: "✕", .pending: "·"]
}

struct EventChatCard: View {
    @Environment(AppStore.self) private var store
    let eventId: String
    let creatorId: String
    /// Qué aviso la dibuja (tanda 1.7): creado, «Es hoy» o comentarios.
    var kind: ChatCardKind? = nil
    /// «Responder» de la franja de comentarios (comenta el evento).
    var onComment: ((CalendarEventDTO) -> Void)? = nil
    @State private var missing = false

    var body: some View {
        Group {
            if let ev = store.events[eventId], let d = store.data {
                card(d, ev)
            } else if !missing {
                // Del alto aproximado de la tarjeta: el chat no salta cuando llega el evento.
                RoundedRectangle(cornerRadius: 14).fill(Theme.surface).frame(height: 150).overlay(ProgressView())
            }
        }
        .frame(maxWidth: 520, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
        .task(id: eventId) {
            guard store.events[eventId] == nil else { return }
            do { _ = try await store.loadEvent(eventId) } catch is CancellationError {} catch { missing = true }
        }
    }

    @ViewBuilder private func card(_ d: BootstrapDTO, _ ev: CalendarEventDTO) -> some View {
        let creatorRef = kind.map { if case .eventCreated = $0 { return creatorId }; return ev.organizerId } ?? creatorId
        let creator = Naming.person(d, creatorRef)?.name.split(separator: " ").first.map(String.init) ?? ""
        let fg = GroupColor.fg(ev.conversationId), bg = GroupColor.bg(ev.conversationId)
        let mine = ev.invitees.first { $0.userId == d.me.id }
        let cancelled = ev.isCancelled
        VStack(alignment: .leading, spacing: 8) {
            let today: Bool = { if case .eventToday = kind { return true }; return false }()
            Text(today ? "📅 " + L("card.today", ["time": ev.start.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(L10n.locale))]).uppercased(with: L10n.locale)
                 : "📅 " + L("cal.card", ["name": creator]).uppercased(with: L10n.locale) + (cancelled ? " · " + L("cal.cancelled") : ""))
                .font(.caption2.weight(.bold)).kerning(0.4).foregroundStyle(today ? Theme.accentText : Theme.textSecondary).lineLimit(1)
                .accessibilityIdentifier("eventCard.header")
            HStack(alignment: .top, spacing: 10) {
                VStack(spacing: 0) {
                    Text(ev.start.formatted(Date.FormatStyle().month(.abbreviated).locale(L10n.locale)).replacingOccurrences(of: ".", with: ""))
                        .font(.caption2.weight(.semibold)).textCase(.uppercase)
                    Text(ev.start.formatted(Date.FormatStyle().day())).font(.title3.weight(.bold)).monospacedDigit()
                }
                .foregroundStyle(fg)
                .frame(width: 46, height: 46)
                .background(RoundedRectangle(cornerRadius: 10).fill(bg))
                .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Button { store.push(.event(ev.id)) } label: {
                        Text(ev.title).font(.body.weight(.bold)).multilineTextAlignment(.leading)
                            .foregroundStyle(cancelled ? Theme.textSecondary : Theme.textPrimary).strikethrough(cancelled)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("eventCard.title.\(ev.id)")
                    Text(EventCardRule.when(ev)).font(.caption).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            if let loc = ev.location?.trimmingCharacters(in: .whitespacesAndNewlines), !loc.isEmpty {
                if CalendarGrid.isVideoLink(loc), let url = URL(string: loc) {
                    Link(destination: url) {
                        Text("📹 " + L("cal.join")).font(.footnote.weight(.bold)).foregroundStyle(Theme.onPrimary)
                            .padding(.horizontal, 14).frame(minHeight: 32)
                            .background(Capsule().fill(Theme.primaryFill))
                    }
                    .accessibilityIdentifier("eventCard.join.\(ev.id)")
                } else {
                    Text("📍 " + loc).font(.footnote).foregroundStyle(Theme.textPrimary).lineLimit(2)
                }
            }
            HStack(spacing: 8) {
                // Hasta 5 invitados apilados.
                ZStack(alignment: .leading) {
                    ForEach(Array(ev.invitees.prefix(5).enumerated()), id: \.offset) { k, inv in
                        let p = Naming.person(d, inv.userId)
                        Avatar(name: p?.name ?? "?", org: nil, isAgent: p?.kind == "agent", size: 22, photo: p?.avatarUrl, fill: PersonColor.fill(inv.userId))
                            .overlay(Circle().stroke(Theme.surface, lineWidth: 1.5))
                            .offset(x: CGFloat(k) * 12)
                            .zIndex(Double(5 - k))
                    }
                }
                .frame(width: 22 + CGFloat(max(0, min(ev.invitees.count, 5) - 1)) * 12, height: 22, alignment: .leading)
                .accessibilityHidden(true)
                Text(L("cal.cardGoing", ["n": EventCardRule.going(ev), "total": ev.invitees.count])).font(.caption).foregroundStyle(Theme.textSecondary)
            }
            if case .eventComments(_, let info) = kind {
                CommentsStrip(info: info, onReply: onComment.map { f in { f(ev) } })
            }
            if let mine, EventCardRule.canAnswer(ev, me: d.me.id) {
                HStack(spacing: 6) {
                    ForEach([Rsvp.yes, .maybe, .no], id: \.self) { r in
                        let on = mine.rsvp == r
                        Button { answer(ev, r) } label: {
                            Text("\(EventCardRule.rsvpIcon[r] ?? "") \(L("cal.rsvp.\(r.rawValue)"))")
                                .font(.caption.weight(on ? .bold : .medium)).lineLimit(1).minimumScaleFactor(0.8)
                                .foregroundStyle(on ? Theme.onPrimary : Theme.textPrimary)
                                .padding(.horizontal, 10).frame(minHeight: 30)
                                .background(Capsule().fill(on ? Theme.primaryFill : Theme.textSecondary.opacity(0.1)))
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(on ? .isSelected : [])
                        .accessibilityIdentifier("eventCard.rsvp.\(r.rawValue)")
                    }
                }
            }
        }
        .padding(.leading, 14).padding(.trailing, 12).padding(.vertical, 12)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.surface))
        .overlay(alignment: .leading) { UnevenRoundedRectangle(topLeadingRadius: 14, bottomLeadingRadius: 14).fill(fg).frame(width: 4) }
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.textSecondary.opacity(0.15)))
        .opacity(cancelled ? 0.6 : 1)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("msg.eventCard.\(ev.id)")
    }

    private func answer(_ ev: CalendarEventDTO, _ r: Rsvp) {
        Haptics.tap()
        Task { do { _ = try await store.rsvp(ev.id, r) } catch { store.show(L10n.errorText(error)) } }
    }
}
