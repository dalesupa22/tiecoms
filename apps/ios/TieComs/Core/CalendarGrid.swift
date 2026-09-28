import Foundation

// Calendario Día / Semana / Mes (docs/TANDA-LECTURA-REUNIONES.md §5). Reglas puras, en la zona del dispositivo.

/// Vista del calendario: Semana por defecto, recordada por dispositivo (UserDefaults `calendarView`).
enum CalendarMode: String, CaseIterable, Identifiable {
    case day, week, month
    var id: String { rawValue }
    var labelKey: String { "cal.view.\(rawValue)" }
    static let key = "calendarView"
    static func load(_ defaults: UserDefaults = .standard) -> CalendarMode { CalendarMode(rawValue: defaults.string(forKey: key) ?? "") ?? .week }
    static func save(_ m: CalendarMode, _ defaults: UserDefaults = .standard) { defaults.set(m.rawValue, forKey: key) }
}

enum CalendarGrid {
    /// Calendario gregoriano que empieza en lunes (como la web), en la zona indicada.
    static func calendar(_ tz: TimeZone = .current, locale: Locale = L10n.locale) -> Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = tz
        c.locale = locale
        c.firstWeekday = 2
        c.minimumDaysInFirstWeek = 4
        return c
    }

    static func startOfWeek(_ d: Date, _ cal: Calendar) -> Date {
        let day = cal.startOfDay(for: d)
        let wd = cal.component(.weekday, from: day)          // 1 = domingo … 7 = sábado
        let back = (wd - cal.firstWeekday + 7) % 7
        return cal.date(byAdding: .day, value: -back, to: day) ?? day
    }

    static func startOfMonth(_ d: Date, _ cal: Calendar) -> Date {
        cal.date(from: cal.dateComponents([.year, .month], from: d)) ?? cal.startOfDay(for: d)
    }

    /// Cuadrícula de 6×7 (42 días) que empieza el lunes de la semana del día 1. Sirve para meses de 28 a 31 días.
    static func monthGrid(_ d: Date, _ cal: Calendar) -> [Date] {
        let first = startOfWeek(startOfMonth(d, cal), cal)
        return (0..<42).compactMap { cal.date(byAdding: .day, value: $0, to: first) }
    }

    /// Días del mes (28 a 31), con cambios de horario incluidos.
    static func daysInMonth(_ d: Date, _ cal: Calendar) -> Int { cal.range(of: .day, in: .month, for: d)?.count ?? 30 }

    /// Intervalo que se pide al API y se muestra: el día, la semana (lunes a domingo) o las 6 semanas de la cuadrícula.
    static func range(_ mode: CalendarMode, _ anchor: Date, _ cal: Calendar) -> DateInterval {
        switch mode {
        case .day:
            let s = cal.startOfDay(for: anchor)
            return DateInterval(start: s, end: cal.date(byAdding: .day, value: 1, to: s) ?? s.addingTimeInterval(86400))
        case .week:
            let s = startOfWeek(anchor, cal)
            return DateInterval(start: s, end: cal.date(byAdding: .day, value: 7, to: s) ?? s.addingTimeInterval(7 * 86400))
        case .month:
            let g = monthGrid(anchor, cal)
            return DateInterval(start: g[0], end: cal.date(byAdding: .day, value: 1, to: g[41]) ?? g[41])
        }
    }

    /// ‹ y ›: un día, una semana o un mes (el 31 de enero + 1 mes = el 28/29 de febrero).
    static func shift(_ mode: CalendarMode, _ anchor: Date, by n: Int, _ cal: Calendar) -> Date {
        switch mode {
        case .day: return cal.date(byAdding: .day, value: n, to: anchor) ?? anchor
        case .week: return cal.date(byAdding: .day, value: 7 * n, to: anchor) ?? anchor
        case .month: return cal.date(byAdding: .month, value: n, to: startOfMonth(anchor, cal)) ?? anchor
        }
    }

    /// Eventos que tocan ese día (también los que empezaron antes): primero los de día completo, luego por hora de inicio.
    static func events(_ list: [CalendarEventDTO], on day: Date, _ cal: Calendar) -> [CalendarEventDTO] {
        let s = cal.startOfDay(for: day)
        let e = cal.date(byAdding: .day, value: 1, to: s) ?? s.addingTimeInterval(86400)
        return sorted(list.filter { !$0.isCancelled && $0.start < e && ($0.end > s || $0.start >= s) }, cal)
    }

    /// Orden de las listas: los de día completo antes que los de hora; luego por inicio (y por id si empatan).
    static func sorted(_ list: [CalendarEventDTO], _ cal: Calendar) -> [CalendarEventDTO] {
        list.map { ($0, isAllDay($0, cal)) }
            .sorted { a, b in
                if a.1 != b.1 { return a.1 }
                return a.0.start == b.0.start ? a.0.id < b.0.id : a.0.start < b.0.start
            }
            .map(\.0)
    }

    /// Día completo (docs/AGENDA-COLORES.md): en la hora local de quien mira empieza a las 00:00, termina a las 23:59
    /// o a las 00:00 (del día siguiente o después) y dura al menos 23 h 59 min. Igual que isAllDayEvent de la web.
    static func isAllDay(start: Date, end: Date, _ cal: Calendar) -> Bool {
        let s = cal.dateComponents([.hour, .minute], from: start), e = cal.dateComponents([.hour, .minute], from: end)
        guard s.hour == 0, s.minute == 0, end.timeIntervalSince(start) >= 86_340 else { return false }
        return (e.hour == 23 && (e.minute ?? 0) >= 59) || (e.hour == 0 && e.minute == 0)
    }

    static func isAllDay(_ ev: CalendarEventDTO, _ cal: Calendar = CalendarGrid.calendar()) -> Bool { isAllDay(start: ev.start, end: ev.end, cal) }

    /// Lo que cabe en una celda del mes: hasta `max` títulos y «+N más».
    static func cell(_ list: [CalendarEventDTO], max: Int = 2) -> (shown: [CalendarEventDTO], more: Int) {
        (Array(list.prefix(max)), Swift.max(0, list.count - max))
    }

    /// Hora de inicio para crear desde un hueco: esa hora del día (o las 10:00 si no se tocó una hora).
    static func slot(_ day: Date, hour: Int?, _ cal: Calendar) -> Date {
        cal.date(bySettingHour: hour ?? 10, minute: 0, second: 0, of: day) ?? day
    }

    /// 📹 cuando la ubicación es un enlace de Meet, Teams o Zoom.
    static func isVideoLink(_ location: String?) -> Bool {
        guard let s = location?.trimmingCharacters(in: .whitespaces), let u = URL(string: s), u.scheme?.lowercased() == "https",
              let h = u.host?.lowercased() else { return false }
        return h == "meet.google.com" || h == "teams.microsoft.com" || h == "teams.live.com" || h == "zoom.us" || h.hasSuffix(".zoom.us")
    }
}

/// Un color por grupo en la Agenda, el mismo en web, iOS y Android (docs/AGENDA-COLORES.md,
/// packages/client-core/src/group-colors.ts).
enum GroupColor {
    struct Pair: Equatable { let bg: UInt32; let fg: UInt32 }
    static let palette: [Pair] = [
        Pair(bg: 0xDCE8FB, fg: 0x1E4E9C), // azul
        Pair(bg: 0xD7F0E2, fg: 0x17603D), // verde
        Pair(bg: 0xE9DEFB, fg: 0x5B32A8), // morado
        Pair(bg: 0xD3EEF0, fg: 0x0A5F67), // turquesa
        Pair(bg: 0xFBDDEB, fg: 0x962868), // rosado
        Pair(bg: 0xFDE8CF, fg: 0x8A4B0B), // naranja
        Pair(bg: 0xE2E4F8, fg: 0x3C4196), // índigo
        Pair(bg: 0xF9DADA, fg: 0x9B2525), // rojo
        Pair(bg: 0xEEF3C9, fg: 0x5B6412), // oliva
        Pair(bg: 0xF6EDC4, fg: 0x735600), // ámbar
    ]

    /// h = 0 (uint32); por cada unidad UTF-16 del id: h = h * 31 + código (mod 2^32); índice = h % 10.
    static func index(_ conversationId: String) -> Int {
        var h: UInt32 = 0
        for code in conversationId.utf16 { h = h &* 31 &+ UInt32(code) }
        return Int(h % UInt32(palette.count))
    }

    static func pair(_ conversationId: String) -> Pair { palette[index(conversationId)] }
}

/// Grupos ocultos en la Agenda: preferencia de este dispositivo (UserDefaults `chaggu.agenda.hidden`, como la web).
enum AgendaHidden {
    static let key = "chaggu.agenda.hidden"
    static func load(_ defaults: UserDefaults = .standard) -> [String] { defaults.stringArray(forKey: key) ?? [] }
    static func save(_ ids: [String], _ defaults: UserDefaults = .standard) {
        if ids.isEmpty { defaults.removeObject(forKey: key) } else { defaults.set(ids, forKey: key) }
    }
    /// Tocar un grupo de la leyenda: lo oculta si se veía, lo muestra si estaba oculto.
    static func toggle(_ id: String, in hidden: [String]) -> [String] { hidden.contains(id) ? hidden.filter { $0 != id } : hidden + [id] }
    /// Grupos de la leyenda: los que tienen eventos en lo visible (también los ocultos), en orden de aparición.
    static func legendIds(_ list: [CalendarEventDTO]) -> [String] {
        var seen = Set<String>()
        return list.compactMap { seen.insert($0.conversationId).inserted ? $0.conversationId : nil }
    }
    /// Lo que se pinta: sin los grupos ocultos.
    static func visible(_ list: [CalendarEventDTO], hidden: [String]) -> [CalendarEventDTO] {
        let h = Set(hidden)
        return h.isEmpty ? list : list.filter { !h.contains($0.conversationId) }
    }
}
