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

    /// Eventos que tocan ese día (también los que empezaron antes), por hora de inicio.
    static func events(_ list: [CalendarEventDTO], on day: Date, _ cal: Calendar) -> [CalendarEventDTO] {
        let s = cal.startOfDay(for: day)
        let e = cal.date(byAdding: .day, value: 1, to: s) ?? s.addingTimeInterval(86400)
        return list.filter { !$0.isCancelled && $0.start < e && ($0.end > s || $0.start >= s) }
            .sorted { $0.startsAt == $1.startsAt ? $0.id < $1.id : $0.start < $1.start }
    }

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
